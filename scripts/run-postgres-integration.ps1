[CmdletBinding()]
param(
  [switch]$KeepContainer,
  [string]$TestNamePattern
)

$ErrorActionPreference = 'Stop'
$image = 'postgres:16-alpine'
$labelKey = 'cybanext.migration-integration'
$labelValue = [guid]::NewGuid().ToString('N')
$containerName = "cybanext-pg-test-$labelValue"
$containerId = $null
$testExitCode = 1
$nodeTestExitCode = $null
$diagnosticLog = $null
$phase = 'Docker startup'
$savedEnvironment = @{}
foreach ($name in @('CYBANEXT_TEST_DATABASE_URL', 'CYBANEXT_RUN_POSTGRES_INTEGRATION', 'CYBANEXT_TEST_HARNESS_TOKEN', 'CYBANEXT_TEST_HARNESS_ID', 'CYBANEXT_TEST_CONTAINER_ID', 'PGPASSWORD', 'NODE_PATH')) {
  $exists = Test-Path "Env:$name"
  $savedEnvironment[$name] = [pscustomobject]@{ Exists = $exists; Value = if ($exists) { [Environment]::GetEnvironmentVariable($name, 'Process') } else { $null } }
}

function New-RandomSecret([int]$Length = 32) {
  $bytes = [byte[]]::new($Length)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) }
  finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).Replace('+','A').Replace('/','B').Replace('=','')
}

function Protect-DiagnosticText([object]$Value) {
  $text = [string]$Value
  $text = $text -replace '(?i)postgres(?:ql)?://[^\s''"<>]+', '[redacted database URL]'
  $text = $text -replace '(?i)(password\s*[=:]\s*)[^\s,;]+', '$1[redacted]'
  foreach ($secret in @($dbUser, $dbPassword, $dbName, $harnessToken)) {
    if (-not [string]::IsNullOrEmpty($secret)) {
      $text = $text.Replace($secret, '[redacted]')
    }
  }
  return $text
}

try {
  $phase = 'Docker startup'
  $serverVersion = docker info --format '{{.ServerVersion}}'
  $dockerInfoExitCode = $LASTEXITCODE
  if ($dockerInfoExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($serverVersion)) { throw 'Docker Engine is not responsive.' }
  Write-Host "Docker Engine $serverVersion"

  $dbUser = "u$(New-RandomSecret 18)"
  $dbPassword = New-RandomSecret 36
  $dbName = "d$(New-RandomSecret 18)"
  $harnessToken = New-RandomSecret 36
  $env:CYBANEXT_RUN_POSTGRES_INTEGRATION = '1'
  $env:CYBANEXT_TEST_HARNESS_TOKEN = $harnessToken
  $env:CYBANEXT_TEST_HARNESS_ID = $labelValue

  $containerId = docker run --detach --name $containerName --label "$labelKey=$labelValue" --publish '127.0.0.1::5432' --env "POSTGRES_USER=$dbUser" --env "POSTGRES_PASSWORD=$dbPassword" --env "POSTGRES_DB=$dbName" $image
  $dockerRunExitCode = $LASTEXITCODE
  if ($dockerRunExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) { throw 'Could not start the disposable PostgreSQL container.' }
  $env:CYBANEXT_TEST_CONTAINER_ID = $containerId.Trim()

  $phase = 'PostgreSQL readiness'
  $published = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $published = docker port $containerId 5432/tcp
    $dockerPortExitCode = $LASTEXITCODE
    if ($dockerPortExitCode -eq 0 -and $published -match '^127\.0\.0\.1:(\d+)$') { break }
    Start-Sleep -Seconds 1
  }
  if ($published -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Docker did not publish PostgreSQL on a loopback-only port.' }
  $port = $Matches[1]
  $env:CYBANEXT_TEST_DATABASE_URL = "postgresql://${dbUser}:$dbPassword@127.0.0.1:${port}/$dbName"

  $ready = $false
  $pgVersion = $null
  $startupDeadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $startupDeadline) {
    # The official image's init process uses a temporary socket-only server.
    # Probe TCP so that temporary server cannot satisfy readiness.
    docker exec $containerId pg_isready --timeout 3 --host 127.0.0.1 --port 5432 --username $dbUser --dbname $dbName *> $null
    $readinessExitCode = $LASTEXITCODE
    if ($readinessExitCode -eq 0) {
      $databaseVersion = docker exec --env "PGPASSWORD=$dbPassword" --env 'PGCONNECT_TIMEOUT=3' $containerId psql --host 127.0.0.1 --port 5432 --username $dbUser --dbname $dbName --tuples-only --no-align --command "SELECT current_database() || '|' || current_setting('server_version')" 2>$null
      $sqlExitCode = $LASTEXITCODE
      if ($sqlExitCode -eq 0 -and $databaseVersion -match "^$([regex]::Escape($dbName))\|16\.") {
        $pgVersion = ($databaseVersion -split '\|', 2)[1]
        $ready = $true
        break
      }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'Disposable PostgreSQL did not accept a successful TCP SQL/version query within 90 seconds.' }
  Write-Host "PostgreSQL $pgVersion on 127.0.0.1:$port"

  $phase = 'Database authorization marking'
  $markerCommand = "DO `$cybanext_marker`$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), '$harnessToken'); END `$cybanext_marker`$;"
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $markerOutput = @(docker exec --env "PGPASSWORD=$dbPassword" --env 'PGCONNECT_TIMEOUT=3' $containerId psql --host 127.0.0.1 --port 5432 --username $dbUser --dbname $dbName --command $markerCommand 2>&1)
    $markerExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  $markerDiagnostic = Protect-DiagnosticText ($markerOutput -join [Environment]::NewLine)
  if (-not [string]::IsNullOrWhiteSpace($markerDiagnostic)) {
    Write-Host $markerDiagnostic
  }
  if ($markerExitCode -ne 0) {
    $failureCategory = if ($markerDiagnostic -match '(?i)database .+ does not exist') {
      'database missing'
    } elseif ($markerDiagnostic -match '(?i)(could not connect|connection (refused|failed|timed out)|no route to host|server closed the connection)') {
      'connection failure'
    } elseif ($markerDiagnostic -match '(?i)(permission denied|must be owner|not authorized)') {
      'authorization failure'
    } else {
      'unclassified Docker/psql failure'
    }
    Write-Host "Database authorization marking exited with code $markerExitCode ($failureCategory)." -ForegroundColor Red
    throw 'Could not mark the disposable PostgreSQL database for integration-test isolation.'
  }
  $postMarkerDiagnosticCommand = "SELECT json_build_object('current_database', current_database(), 'current_user', current_user, 'pg_database_datname', d.datname, 'database_oid', d.oid, 'database_comment', shobj_description(d.oid, 'pg_database'), 'server_start_time', pg_postmaster_start_time())::text FROM pg_catalog.pg_database AS d WHERE d.datname = current_database()"
  try {
    $ErrorActionPreference = 'Continue'
    $postMarkerDiagnosticOutput = @(docker exec --env "PGPASSWORD=$dbPassword" --env 'PGCONNECT_TIMEOUT=3' $containerId psql --host 127.0.0.1 --port 5432 --username $dbUser --dbname $dbName --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command $postMarkerDiagnosticCommand 2>&1)
    $postMarkerDiagnosticExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($postMarkerDiagnosticExitCode -ne 0) {
    throw "Post-marker database diagnostic failed (psql exit code $postMarkerDiagnosticExitCode)."
  }
  if ($postMarkerDiagnosticOutput.Count -ne 1 -or
      [string]::IsNullOrWhiteSpace([string]$postMarkerDiagnosticOutput[0]) -or
      ([string]$postMarkerDiagnosticOutput[0] -match '[\r\n]')) {
    throw 'Post-marker database diagnostic did not return exactly one JSON result.'
  }
  try {
    $postMarkerDiagnostic = ([string]$postMarkerDiagnosticOutput[0]).Trim() | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'Post-marker database diagnostic returned invalid JSON.'
  }
  if ($postMarkerDiagnostic -isnot [System.Management.Automation.PSCustomObject]) {
    throw 'Post-marker database diagnostic did not return a JSON object.'
  }
  foreach ($property in @('current_database', 'current_user', 'pg_database_datname', 'database_oid', 'database_comment', 'server_start_time')) {
    if ($null -eq $postMarkerDiagnostic.PSObject.Properties[$property]) {
      throw 'Post-marker database diagnostic returned incomplete fields.'
    }
  }
  $safePostMarkerDiagnostic = [ordered]@{
    current_database = if ($postMarkerDiagnostic.current_database -eq $dbName) { '[expected database]' } else { '[unexpected database]' }
    current_user = if ($postMarkerDiagnostic.current_user -eq $dbUser) { '[expected user]' } else { '[unexpected user]' }
    pg_database_datname = if ($postMarkerDiagnostic.pg_database_datname -eq $postMarkerDiagnostic.current_database) { '[matches current database]' } else { '[does not match current database]' }
    database_oid = $postMarkerDiagnostic.database_oid
    database_comment = if ($null -eq $postMarkerDiagnostic.database_comment) { $null } else { '[redacted non-NULL comment]' }
    server_start_time = $postMarkerDiagnostic.server_start_time
  }
  Write-Host "Post-marker database diagnostic: $(ConvertTo-Json -InputObject $safePostMarkerDiagnostic -Compress)"

  $markerCheckCommand = "SELECT json_build_object('databaseMatchesExpected', current_database() = '$dbName', 'userMatchesExpected', current_user = '$dbUser', 'serverAddress', host(inet_server_addr()), 'serverPort', inet_server_port(), 'commentIsNull', shobj_description(oid, 'pg_database') IS NULL, 'commentLength', length(shobj_description(oid, 'pg_database')), 'expectedTokenLength', length('$harnessToken'), 'commentMatchesExpected', COALESCE(shobj_description(oid, 'pg_database') = '$harnessToken', FALSE)) FROM pg_catalog.pg_database WHERE datname = current_database()"
  try {
    $ErrorActionPreference = 'Continue'
    $markerCheckOutput = @(docker exec --env "PGPASSWORD=$dbPassword" --env 'PGCONNECT_TIMEOUT=3' $containerId psql --host 127.0.0.1 --port 5432 --username $dbUser --dbname $dbName --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet --command $markerCheckCommand 2>&1)
    $markerCheckExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($markerCheckExitCode -ne 0) {
    throw "Could not verify the disposable database marker (psql exit code $markerCheckExitCode)."
  }
  if ($markerCheckOutput.Count -ne 1 -or
      [string]::IsNullOrWhiteSpace([string]$markerCheckOutput[0]) -or
      ([string]$markerCheckOutput[0] -match '[\r\n]')) {
    throw 'Disposable database marker verification did not return exactly one JSON result.'
  }
  $markerCheckResult = ([string]$markerCheckOutput[0]).Trim()
  $jsonObjectFrames = [System.Collections.Generic.List[object]]::new()
  $jsonDepth = 0
  $inJsonString = $false
  $escapedJsonCharacter = $false
  $jsonStringStart = -1
  for ($index = 0; $index -lt $markerCheckResult.Length; $index++) {
    $character = $markerCheckResult[$index]
    if ($inJsonString) {
      if ($escapedJsonCharacter) {
        $escapedJsonCharacter = $false
      } elseif ($character -eq '\') {
        $escapedJsonCharacter = $true
      } elseif ($character -eq '"') {
        $inJsonString = $false
        if ($jsonObjectFrames.Count -gt 0 -and
            $jsonDepth -eq $jsonObjectFrames[$jsonObjectFrames.Count - 1].Depth) {
          $nextCharacter = $index + 1
          while ($nextCharacter -lt $markerCheckResult.Length -and [char]::IsWhiteSpace($markerCheckResult[$nextCharacter])) {
            $nextCharacter++
          }
          if ($nextCharacter -lt $markerCheckResult.Length -and $markerCheckResult[$nextCharacter] -eq ':') {
            $rawPropertyName = $markerCheckResult.Substring($jsonStringStart + 1, $index - $jsonStringStart - 1)
            $propertyNameBuilder = [System.Text.StringBuilder]::new()
            for ($nameIndex = 0; $nameIndex -lt $rawPropertyName.Length; $nameIndex++) {
              if ($rawPropertyName[$nameIndex] -ne '\') {
                [void]$propertyNameBuilder.Append($rawPropertyName[$nameIndex])
                continue
              }
              $nameIndex++
              if ($nameIndex -ge $rawPropertyName.Length) { break }
              switch ($rawPropertyName[$nameIndex]) {
                '"' { [void]$propertyNameBuilder.Append('"') }
                '\' { [void]$propertyNameBuilder.Append('\') }
                '/' { [void]$propertyNameBuilder.Append('/') }
                'b' { [void]$propertyNameBuilder.Append([char]8) }
                'f' { [void]$propertyNameBuilder.Append([char]12) }
                'n' { [void]$propertyNameBuilder.Append([char]10) }
                'r' { [void]$propertyNameBuilder.Append([char]13) }
                't' { [void]$propertyNameBuilder.Append([char]9) }
                'u' {
                  if ($nameIndex + 4 -lt $rawPropertyName.Length) {
                    $nameIndex++
                    $hexStart = $nameIndex
                    $nameIndex += 3
                    [void]$propertyNameBuilder.Append([char][Convert]::ToInt32($rawPropertyName.Substring($hexStart, 4), 16))
                  }
                }
                default { [void]$propertyNameBuilder.Append($rawPropertyName[$nameIndex]) }
              }
            }
            $propertyName = $propertyNameBuilder.ToString()
            if (-not $jsonObjectFrames[$jsonObjectFrames.Count - 1].Names.Add($propertyName)) {
              throw 'Disposable database marker verification returned duplicate diagnostic properties.'
            }
          }
        }
      }
    } elseif ($character -eq '"') {
      $inJsonString = $true
      $escapedJsonCharacter = $false
      $jsonStringStart = $index
    } elseif ($character -eq '{') {
      $jsonDepth++
      $jsonObjectFrames.Add([pscustomobject]@{
        Depth = $jsonDepth
        Names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
      })
    } elseif ($character -eq '[') {
      $jsonDepth++
    } elseif ($character -eq '}') {
      $jsonDepth--
      if ($jsonObjectFrames.Count -gt 0) {
        $jsonObjectFrames.RemoveAt($jsonObjectFrames.Count - 1)
      }
    } elseif ($character -eq ']') {
      $jsonDepth--
    }
  }
  try {
    $markerCheck = $markerCheckResult | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'Disposable database marker verification returned no valid diagnostic result.'
  }
  $requiredDiagnosticProperties = @(
    'databaseMatchesExpected', 'userMatchesExpected', 'serverAddress', 'serverPort',
    'commentIsNull', 'commentLength', 'expectedTokenLength', 'commentMatchesExpected'
  )
  if ($markerCheck -isnot [System.Management.Automation.PSCustomObject]) {
    throw 'Disposable database marker verification did not return a JSON object.'
  }
  $expectedDiagnosticPropertySet = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]$requiredDiagnosticProperties,
    [System.StringComparer]::Ordinal
  )
  $actualDiagnosticProperties = @($markerCheck.PSObject.Properties.Name)
  $hasUnexpectedDiagnosticProperty = $false
  foreach ($property in $actualDiagnosticProperties) {
    if (-not $expectedDiagnosticPropertySet.Contains($property)) {
      $hasUnexpectedDiagnosticProperty = $true
      break
    }
  }
  if ($actualDiagnosticProperties.Count -ne $requiredDiagnosticProperties.Count -or $hasUnexpectedDiagnosticProperty) {
    throw 'Disposable database marker verification returned unexpected diagnostic properties.'
  }
  foreach ($property in $requiredDiagnosticProperties) {
    if ($null -eq $markerCheck.PSObject.Properties[$property]) {
      throw 'Disposable database marker verification returned an incomplete diagnostic result.'
    }
  }
  $parsedServerAddress = $null
  $serverAddressPresent = -not [string]::IsNullOrWhiteSpace([string]$markerCheck.serverAddress)
  $serverAddressIsValid = $serverAddressPresent -and
    [System.Net.IPAddress]::TryParse([string]$markerCheck.serverAddress, [ref]$parsedServerAddress)
  $validationStatus = [ordered]@{
    databaseMatchesExpectedIsBoolean = $markerCheck.databaseMatchesExpected -is [bool]
    userMatchesExpectedIsBoolean = $markerCheck.userMatchesExpected -is [bool]
    serverAddressPresent = $serverAddressPresent
    serverAddressIsValidIp = $serverAddressIsValid
    serverPortIsInteger = $markerCheck.serverPort -is [int] -or $markerCheck.serverPort -is [long]
    serverPortIsExpected = $markerCheck.serverPort -eq 5432
    commentIsNullIsBoolean = $markerCheck.commentIsNull -is [bool]
    commentLengthIsNullWhenCommentIsNull = -not $markerCheck.commentIsNull -or $null -eq $markerCheck.commentLength
    commentLengthIsIntegerWhenCommentIsNotNull = $markerCheck.commentIsNull -or
      $markerCheck.commentLength -is [int] -or $markerCheck.commentLength -is [long]
    commentLengthMatchesExpected = $markerCheck.commentIsNull -or
      $markerCheck.commentLength -eq $markerCheck.expectedTokenLength
    expectedTokenLengthIsInteger = $markerCheck.expectedTokenLength -is [int] -or $markerCheck.expectedTokenLength -is [long]
    expectedTokenLengthIsExpected = $markerCheck.expectedTokenLength -eq $harnessToken.Length
    commentMatchesExpectedIsBoolean = $markerCheck.commentMatchesExpected -is [bool]
  }
  $fieldTypes = [ordered]@{
    databaseMatchesExpected = if ($null -eq $markerCheck.databaseMatchesExpected) { 'null' } else { $markerCheck.databaseMatchesExpected.GetType().FullName }
    userMatchesExpected = if ($null -eq $markerCheck.userMatchesExpected) { 'null' } else { $markerCheck.userMatchesExpected.GetType().FullName }
    serverAddress = if ($null -eq $markerCheck.serverAddress) { 'null' } else { $markerCheck.serverAddress.GetType().FullName }
    serverPort = if ($null -eq $markerCheck.serverPort) { 'null' } else { $markerCheck.serverPort.GetType().FullName }
    commentIsNull = if ($null -eq $markerCheck.commentIsNull) { 'null' } else { $markerCheck.commentIsNull.GetType().FullName }
    commentLength = if ($null -eq $markerCheck.commentLength) { 'null' } else { $markerCheck.commentLength.GetType().FullName }
    expectedTokenLength = if ($null -eq $markerCheck.expectedTokenLength) { 'null' } else { $markerCheck.expectedTokenLength.GetType().FullName }
    commentMatchesExpected = if ($null -eq $markerCheck.commentMatchesExpected) { 'null' } else { $markerCheck.commentMatchesExpected.GetType().FullName }
  }
  $safeFieldValues = [ordered]@{
    databaseMatchesExpected = $markerCheck.databaseMatchesExpected
    userMatchesExpected = $markerCheck.userMatchesExpected
    serverAddressPresent = $serverAddressPresent
    serverAddressIsValidIp = $serverAddressIsValid
    serverPort = $markerCheck.serverPort
    commentIsNull = $markerCheck.commentIsNull
    commentLength = $markerCheck.commentLength
    expectedTokenLength = $markerCheck.expectedTokenLength
    commentMatchesExpected = $markerCheck.commentMatchesExpected
  }
  $hasMalformedDiagnosticFields = $markerCheck.databaseMatchesExpected -isnot [bool] -or
      $markerCheck.userMatchesExpected -isnot [bool] -or
      $markerCheck.commentIsNull -isnot [bool] -or
      $markerCheck.commentMatchesExpected -isnot [bool] -or
      -not $serverAddressIsValid -or
      ($markerCheck.serverPort -isnot [int] -and $markerCheck.serverPort -isnot [long]) -or
      $markerCheck.serverPort -ne 5432 -or
      ($markerCheck.expectedTokenLength -isnot [int] -and $markerCheck.expectedTokenLength -isnot [long]) -or
      $markerCheck.expectedTokenLength -ne $harnessToken.Length -or
      ($markerCheck.commentIsNull -and $null -ne $markerCheck.commentLength) -or
      (-not $markerCheck.commentIsNull -and
        (($markerCheck.commentLength -isnot [int] -and $markerCheck.commentLength -isnot [long]) -or
          $markerCheck.commentLength -ne $markerCheck.expectedTokenLength))
  if ($hasMalformedDiagnosticFields) {
    Write-Host "Marker diagnostic validation status: $(ConvertTo-Json -InputObject $validationStatus -Compress)"
    Write-Host "Marker diagnostic field types: $(ConvertTo-Json -InputObject $fieldTypes -Compress)"
    Write-Host "Marker diagnostic safe values: $(ConvertTo-Json -InputObject $safeFieldValues -Compress)"
    throw 'Disposable database marker verification returned malformed or unexpected diagnostic fields.'
  }

  Write-Host "Marker verification: databaseMatch=$($markerCheck.databaseMatchesExpected), userMatch=$($markerCheck.userMatchesExpected), serverAddress=$($markerCheck.serverAddress), serverPort=$($markerCheck.serverPort), commentIsNull=$($markerCheck.commentIsNull), commentLength=$($markerCheck.commentLength), expectedTokenLength=$($markerCheck.expectedTokenLength), commentMatchesExpected=$($markerCheck.commentMatchesExpected)"
  $markerCheckFailures = @()
  if (-not $markerCheck.databaseMatchesExpected) { $markerCheckFailures += 'database name mismatch' }
  if (-not $markerCheck.userMatchesExpected) { $markerCheckFailures += 'database user mismatch' }
  if ($markerCheck.commentIsNull) { $markerCheckFailures += 'database comment is NULL' }
  if (-not $markerCheck.commentMatchesExpected) { $markerCheckFailures += 'database comment does not match the harness token' }
  if ($markerCheckFailures.Count -gt 0) {
    throw "Disposable database marker verification failed: $($markerCheckFailures -join '; ')."
  }

  $phase = 'PostgreSQL package resolution'
  $npmPackageRoot = npm.cmd exec --yes --package=pg -- node -e "const p=process.env.PATH.split(';').find(x=>x.toLowerCase().includes('_npx')&&x.toLowerCase().endsWith('\\node_modules\\.bin')); if(p) process.stdout.write(p.slice(0,-5))"
  $npmExitCode = $LASTEXITCODE
  if ($npmExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($npmPackageRoot)) { throw 'Could not resolve the temporary pg package directory from npm exec.' }
  $env:NODE_PATH = $npmPackageRoot.Trim()
  node -e "require.resolve('pg')"
  $packageResolutionExitCode = $LASTEXITCODE
  if ($packageResolutionExitCode -ne 0) { throw 'The integration test process cannot resolve pg from npm exec.' }

  $phase = 'Integration test execution'
  $diagnosticLog = [System.IO.Path]::GetTempFileName()
  $nodeArguments = @('--test', 'test/migration-runner.postgres.integration.test.js')
  if ([string]::IsNullOrWhiteSpace($TestNamePattern)) {
    & node @nodeArguments 2>&1 | ForEach-Object { Protect-DiagnosticText $_ } | Tee-Object -FilePath $diagnosticLog
  } else {
    $nodeArguments = @('--test', '--test-name-pattern', $TestNamePattern, 'test/migration-runner.postgres.integration.test.js')
    & node @nodeArguments 2>&1 | ForEach-Object { Protect-DiagnosticText $_ } | Tee-Object -FilePath $diagnosticLog
  }
  $nodeTestExitCode = $LASTEXITCODE
  $testExitCode = $nodeTestExitCode
  if ($nodeTestExitCode -ne 0) { throw "PostgreSQL integration tests failed with exit code $nodeTestExitCode." }
} catch {
  $failure = $_
  Write-Host "Harness failed during phase: $phase" -ForegroundColor Red
  Write-Host "Original exception: $(Protect-DiagnosticText ($failure.Exception.ToString()))" -ForegroundColor Red
  if ($failure.ErrorDetails -and $failure.ErrorDetails.Message) {
    Write-Host "Error details: $(Protect-DiagnosticText $failure.ErrorDetails.Message)" -ForegroundColor Red
  }
  if ($failure.ScriptStackTrace) {
    Write-Host "PowerShell stack: $(Protect-DiagnosticText $failure.ScriptStackTrace)" -ForegroundColor Red
  }
  if ($null -ne $nodeTestExitCode) {
    Write-Host "Saved Node test exit code: $nodeTestExitCode"
  }
  if ($diagnosticLog -and (Test-Path -LiteralPath $diagnosticLog)) {
    Write-Host "Captured TAP output (diagnostic log): $diagnosticLog"
    Get-Content -LiteralPath $diagnosticLog | ForEach-Object {
      Write-Host (Protect-DiagnosticText $_)
    }
  } else {
    Write-Host 'No TAP diagnostic log was created because the Node test process was not started.'
  }
  if ($containerId) {
    Write-Host "Failure diagnostics for container $containerId (created by this run):"
    $stateJson = docker inspect --format '{{json .State}}' $containerId 2>$null
    $stateInspectExitCode = $LASTEXITCODE
    $state = $null
    if ($stateInspectExitCode -eq 0 -and $stateJson) {
      try { $state = $stateJson | ConvertFrom-Json } catch { $state = $null }
    }
    if ($state) {
      Write-Host (Protect-DiagnosticText "Container state: status=$($state.Status), exitCode=$($state.ExitCode), error=$($state.Error), oomKilled=$($state.OOMKilled), finishedAt=$($state.FinishedAt)")
    } else {
      Write-Host 'Container state inspection failed.'
    }
    Write-Host 'Recent PostgreSQL container logs:'
    $savedErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $logOutput = docker logs --timestamps --tail 80 $containerId 2>&1
      $logsExitCode = $LASTEXITCODE
      foreach ($line in $logOutput) { Write-Host (Protect-DiagnosticText $line) }
      if ($logsExitCode -ne 0) { Write-Host "docker logs exited with code $logsExitCode." }
    } catch {
      Write-Host "Could not display container logs: $($_.Exception.Message)"
    } finally {
      $ErrorActionPreference = $savedErrorActionPreference
    }
  }
  $testExitCode = 1
} finally {
  $phase = 'Cleanup'
  foreach ($name in $savedEnvironment.Keys) {
    $saved = $savedEnvironment[$name]
    if ($saved.Exists) { [Environment]::SetEnvironmentVariable($name, $saved.Value, 'Process') }
    else { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  }
  if ($containerId -and -not $KeepContainer) {
    $inspectionJson = docker inspect --format '{{json .}}' $containerId 2>$null
    $cleanupInspectExitCode = $LASTEXITCODE
    $inspection = $null
    if ($cleanupInspectExitCode -eq 0 -and $inspectionJson) {
      try { $inspection = $inspectionJson | ConvertFrom-Json } catch { $inspection = $null }
    }
    $verifiedId = $inspection.Id -eq $containerId
    $verifiedLabel = $inspection.Config.Labels.$labelKey -eq $labelValue
    if ($inspection -and $verifiedId -and $verifiedLabel) {
      docker rm --force $containerId
      if ($LASTEXITCODE -ne 0) { Write-Warning "Cleanup failed for disposable container $containerId. Remove it with: docker rm --force $containerId" }
      else { Write-Host 'Disposable PostgreSQL container removed.' }
    } else {
      Write-Warning "Container label verification failed; leaving container untouched: $containerId"
    }
  } elseif ($containerId -and $KeepContainer) {
    Write-Host "Container retained by -KeepContainer: $containerId"
  }
  if ($diagnosticLog -and (Test-Path -LiteralPath $diagnosticLog)) {
    if ($testExitCode -eq 0) {
      Remove-Item -LiteralPath $diagnosticLog -ErrorAction SilentlyContinue
    } else {
      Write-Host "Diagnostic log retained for inspection: $diagnosticLog"
    }
  }
}

exit $testExitCode
