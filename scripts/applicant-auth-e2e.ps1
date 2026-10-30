$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3000'
$emailPattern = '^[^\s@]+@[^\s@]+\.[^\s@]+$'
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.CookieContainer = [System.Net.CookieContainer]::new()
$client = [System.Net.Http.HttpClient]::new($handler)

function ConvertFrom-SecureInput([Security.SecureString]$SecureValue) {
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Protect-DiagnosticText([string]$Text) {
    if ($null -eq $Text) { return '' }
    $safe = $Text
    $safe = [regex]::Replace($safe, '(?i)postgres(?:ql)?://[^\s"''<>]+', '[REDACTED DATABASE URL]')
    $safe = [regex]::Replace($safe, '(?i)(authorization\s*[:=]\s*bearer\s+)[^\s"''<>]+', '$1[REDACTED]')
    $safe = [regex]::Replace($safe, '(?im)(set-cookie\s*:\s*)[^\r\n]+', '$1[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)(cookie\s*[=:]\s*)[^\s,"''<>]+', '$1[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)(cybanext_applicant_session\s*=\s*)[^;\s"''<>]+', '$1[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)(["'']?token["'']?\s*[:=]\s*["'']?|[?#]token=)[^&\s,"''<>}]+', '$1[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[REDACTED EMAIL]')
    $safe = [regex]::Replace($safe, '(?i)(password|secret|api[_-]?key)\s*[=:]\s*[^\s,"''<>]+', '$1=[REDACTED]')
    return $safe
}

function Invoke-JsonOnce([string]$Method, [string]$Path, $Body, [int[]]$ExpectedStatus = @(200)) {
    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::new($Method),
        "$base$Path"
    )
    $request.Headers.ExpectContinue = $false
    $response = $null
    try {
        if ($null -ne $Body) {
            $json = $Body | ConvertTo-Json -Compress
            $request.Content = [System.Net.Http.StringContent]::new(
                $json,
                [System.Text.Encoding]::UTF8,
                'application/json'
            )
            $json = $null
        }

        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $contentType = $response.Content.Headers.ContentType.MediaType
        $isJson = $contentType -match '(?i)(^application/json$|\+json$)'

        if ($ExpectedStatus -notcontains $status) {
            $bodyForReport = Protect-DiagnosticText $content
            if ($bodyForReport.Length -gt 2000) {
                $bodyForReport = $bodyForReport.Substring(0, 2000) + ' [TRUNCATED]'
            }
            Write-Host "HTTP status: $status"
            Write-Host "Content-Type: $(if ($contentType) { $contentType } else { '[missing]' })"
            Write-Host "Response format: $(if ($isJson) { 'JSON' } else { 'non-JSON' })"
            Write-Host "Response body (redacted): $bodyForReport"
            throw "Unexpected HTTP response from $Path. Stop; do not retry this POST."
        }

        if (-not $isJson) {
            $bodyForReport = Protect-DiagnosticText $content
            if ($bodyForReport.Length -gt 2000) {
                $bodyForReport = $bodyForReport.Substring(0, 2000) + ' [TRUNCATED]'
            }
            Write-Host "HTTP status: $status"
            Write-Host "Content-Type: $(if ($contentType) { $contentType } else { '[missing]' })"
            Write-Host 'Response format: non-JSON'
            Write-Host "Response body (redacted): $bodyForReport"
            throw "Expected JSON from $Path. Stop; do not retry this POST."
        }

        try {
            $parsed = $content | ConvertFrom-Json
        }
        catch {
            $bodyForReport = Protect-DiagnosticText $content
            if ($bodyForReport.Length -gt 2000) {
                $bodyForReport = $bodyForReport.Substring(0, 2000) + ' [TRUNCATED]'
            }
            Write-Host "HTTP status: $status"
            Write-Host "Content-Type: $contentType"
            Write-Host 'Response format: declared JSON, but parsing failed'
            Write-Host "Response body (redacted): $bodyForReport"
            throw "Invalid JSON response from $Path. Stop; do not retry this POST."
        }

        return [pscustomobject]@{ Status = $status; IsJson = $true; Body = $parsed }
    }
    catch {
        if ($null -eq $response) {
            $message = Protect-DiagnosticText $_.Exception.Message
            Write-Host "HTTP status: unavailable (request did not yield a response)"
            Write-Host 'Content-Type: unavailable'
            Write-Host 'Response format: unavailable'
            Write-Host "Transport error (redacted): $message"
        }
        throw
    }
    finally {
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $content = $null
        $json = $null
    }
}

$emailSecure = $null
$email = $null
$magicLinkSecure = $null
$magicLink = $null
$token = $null
$requestBody = $null

try {
    $emailSecure = Read-Host 'Enter the controlled test inbox privately' -AsSecureString
    $email = ConvertFrom-SecureInput $emailSecure
    $emailSecure.Dispose()
    $emailSecure = $null
    if ($email -notmatch $emailPattern) {
        throw 'Inbox address did not pass the endpoint email format check. Nothing was sent.'
    }

    # One registration POST only. Any unexpected or ambiguous outcome stops the script.
    $requestBody = @{ fullName = 'SYNTHETIC E2E TEST 2026-10-30'; email = $email; phone = '' }
    $registration = Invoke-JsonOnce 'POST' '/api/create-digital-forensics-registration' $requestBody
    $requestBody.Clear(); $requestBody = $null
    if ($registration.Status -ne 200 -or
        $registration.Body.course -ne 'digital_forensics' -or
        $registration.Body.status -ne 'pending' -or
        -not $registration.Body.registrationId) {
        throw 'Registration response was unexpected or ambiguous. Stop; do not retry.'
    }
    $registration = $null
    Write-Host 'Synthetic registration created.'

    # One email request only. The API response is generic and does not confirm delivery.
    $requestBody = @{ email = $email }
    $loginRequest = Invoke-JsonOnce 'POST' '/api/request-applicant-login' $requestBody
    $requestBody.Clear(); $requestBody = $null
    $email = $null
    if ($loginRequest.Status -ne 200 -or
        $loginRequest.Body.message -ne "If that email has an account, we've sent a login link") {
        throw 'Login request response was unexpected. Stop; do not retry email delivery.'
    }
    $loginRequest = $null

    Write-Host 'One login request was made. Retrieve the email, then enter its link below.'
    $magicLinkSecure = Read-Host 'Paste the magic link privately' -AsSecureString
    $magicLink = ConvertFrom-SecureInput $magicLinkSecure
    $magicLinkSecure.Dispose(); $magicLinkSecure = $null
    $linkUri = $null
    if (-not [Uri]::TryCreate($magicLink, [UriKind]::Absolute, [ref]$linkUri)) {
        throw 'Link format was not recognized. Stop; do not request another email automatically.'
    }
    $linkMatch = [regex]::Match($linkUri.Fragment, '^#token=([^&]+)$')
    if (-not $linkMatch.Success) {
        throw 'Link format was not recognized. Stop; do not request another email automatically.'
    }
    $token = [Uri]::UnescapeDataString($linkMatch.Groups[1].Value)
    $magicLink = $null; $linkUri = $null; $linkMatch = $null

    # Verification response sets the cookie into HttpClient's private CookieContainer.
    $requestBody = @{ token = $token }
    $verification = Invoke-JsonOnce 'POST' '/api/verify-applicant-login' $requestBody
    $requestBody.Clear(); $requestBody = $null; $token = $null
    if ($verification.Status -ne 200 -or $verification.Body.authenticated -ne $true) {
        throw 'Token verification failed. Stop; do not request another email automatically.'
    }
    $verification = $null
    Write-Host 'Magic link verified; session cookie retained privately.'

    $session = Invoke-JsonOnce 'GET' '/api/applicant-session' $null
    if ($session.Status -ne 200 -or $session.Body.authenticated -ne $true) {
        throw 'Dashboard session check did not authenticate.'
    }
    $session = $null
    Write-Host 'Dashboard session check authenticated.'

    $logout = Invoke-JsonOnce 'POST' '/api/logout-applicant' $null
    if ($logout.Status -ne 200 -or $logout.Body.loggedOut -ne $true) {
        throw 'Logout response was unexpected.'
    }
    $logout = $null

    $afterLogout = Invoke-JsonOnce 'GET' '/api/applicant-session' $null @(401)
    if ($afterLogout.Status -ne 401 -or $afterLogout.Body.authenticated -ne $false) {
        throw 'Session was not rejected after logout.'
    }
    $afterLogout = $null
    Write-Host 'Logout confirmed; the session is rejected afterward.'
}
finally {
    if ($emailSecure) { $emailSecure.Dispose() }
    if ($magicLinkSecure) { $magicLinkSecure.Dispose() }
    $client.Dispose()
    $handler.Dispose()
    $email = $null
    $token = $null
    $magicLink = $null
    $requestBody = $null
}
