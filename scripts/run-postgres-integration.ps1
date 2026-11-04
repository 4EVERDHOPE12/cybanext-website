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
$savedEnvironment = @{}
foreach ($name in @('CYBANEXT_TEST_DATABASE_URL', 'CYBANEXT_RUN_POSTGRES_INTEGRATION', 'PGPASSWORD', 'NODE_PATH')) {
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

try {
  $serverVersion = docker info --format '{{.ServerVersion}}'
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($serverVersion)) { throw 'Docker Engine is not responsive.' }
  Write-Host "Docker Engine $serverVersion"

  $dbUser = "u$(New-RandomSecret 18)"
  $dbPassword = New-RandomSecret 36
  $dbName = "d$(New-RandomSecret 18)"
  $env:CYBANEXT_RUN_POSTGRES_INTEGRATION = '1'

  $containerId = docker run --detach --name $containerName --label "$labelKey=$labelValue" --publish '127.0.0.1::5432' --env "POSTGRES_USER=$dbUser" --env "POSTGRES_PASSWORD=$dbPassword" --env "POSTGRES_DB=$dbName" $image
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) { throw 'Could not start the disposable PostgreSQL container.' }

  $published = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $published = docker port $containerId 5432/tcp
    if ($LASTEXITCODE -eq 0 -and $published -match '^127\.0\.0\.1:(\d+)$') { break }
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

  $npmPackageRoot = npm.cmd exec --yes --package=pg -- node -e "const p=process.env.PATH.split(';').find(x=>x.toLowerCase().includes('_npx')&&x.toLowerCase().endsWith('\\node_modules\\.bin')); if(p) process.stdout.write(p.slice(0,-5))"
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmPackageRoot)) { throw 'Could not resolve the temporary pg package directory from npm exec.' }
  $env:NODE_PATH = $npmPackageRoot.Trim()
  node -e "require.resolve('pg')"
  if ($LASTEXITCODE -ne 0) { throw 'The integration test process cannot resolve pg from npm exec.' }
  if ([string]::IsNullOrWhiteSpace($TestNamePattern)) {
    node --test test/migration-runner.postgres.integration.test.js
  } else {
    node --test --test-name-pattern $TestNamePattern test/migration-runner.postgres.integration.test.js
  }
  $testExitCode = $LASTEXITCODE
  if ($testExitCode -ne 0) { throw "PostgreSQL integration tests failed with exit code $testExitCode." }
} catch {
  Write-Host "Harness failed: $($_.Exception.Message)" -ForegroundColor Red
  if ($containerId) {
    Write-Host "Failure diagnostics for container $containerId (created by this run):"
    $stateJson = docker inspect --format '{{json .State}}' $containerId 2>$null
    $state = $null
    if ($LASTEXITCODE -eq 0 -and $stateJson) {
      try { $state = $stateJson | ConvertFrom-Json } catch { $state = $null }
    }
    if ($state) {
      Write-Host "Container state: status=$($state.Status), exitCode=$($state.ExitCode), error=$($state.Error), oomKilled=$($state.OOMKilled), finishedAt=$($state.FinishedAt)"
    } else {
      Write-Host 'Container state inspection failed.'
    }
    Write-Host 'Recent PostgreSQL container logs:'
    $savedErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $logOutput = docker logs --tail 80 $containerId 2>&1
      $logsExitCode = $LASTEXITCODE
      foreach ($line in $logOutput) { Write-Host "$line" }
      if ($logsExitCode -ne 0) { Write-Host "docker logs exited with code $logsExitCode." }
    } catch {
      Write-Host "Could not display container logs: $($_.Exception.Message)"
    } finally {
      $ErrorActionPreference = $savedErrorActionPreference
    }
  }
  $testExitCode = 1
} finally {
  foreach ($name in $savedEnvironment.Keys) {
    $saved = $savedEnvironment[$name]
    if ($saved.Exists) { [Environment]::SetEnvironmentVariable($name, $saved.Value, 'Process') }
    else { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  }
  if ($containerId -and -not $KeepContainer) {
    $inspectionJson = docker inspect --format '{{json .}}' $containerId 2>$null
    $inspection = $null
    if ($LASTEXITCODE -eq 0 -and $inspectionJson) {
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
}

exit $testExitCode
