param([ValidateSet('Open','Stop')][string]$Action = 'Open')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'server.mjs'
$found = $false
foreach ($relative in @('data\session.json', 'data\demo\session.json')) {
    $file = Join-Path $root $relative
    if (!(Test-Path -LiteralPath $file)) { continue }
    $session = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    $processInfo = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$session.pid) -ErrorAction SilentlyContinue
    # Verify both executable and script path before trusting a potentially reused PID.
    if (!$processInfo -or $processInfo.Name -ne 'node.exe' -or !$processInfo.CommandLine) { continue }
    $expected = [regex]::Escape($entry)
    $relativeEntry = $processInfo.CommandLine -match '(?i)(?:^|\s)server\.mjs(?:\s|$)'
    if ($processInfo.CommandLine -notmatch $expected -and !$relativeEntry) { continue }
    try {
        $uri = [Uri]$session.url
        if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -ne 'http') { continue }
        $headers = @{ 'X-Session-Token' = $uri.Fragment.TrimStart('#') }
        $identity = Invoke-RestMethod -Uri ($uri.GetLeftPart([UriPartial]::Authority) + '/api/identity') -Headers $headers -TimeoutSec 5
        if ([int]$identity.pid -ne [int]$session.pid -or [IO.Path]::GetFullPath($identity.rootDir).TrimEnd('\') -ine [IO.Path]::GetFullPath($root).TrimEnd('\')) { continue }
    } catch { continue }
    if ($relativeEntry) {
        # Relative-path launches need independent ownership evidence from a live local endpoint.
        try {
            $uri = [Uri]$session.url
            if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -ne 'http') { continue }
            $connection = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $uri.Port -ErrorAction Stop | Where-Object OwningProcess -eq ([int]$session.pid))
            if (!$connection.Count) { continue }
        } catch { continue }
    }
    if ($Action -eq 'Open') {
        $uri = [Uri]$session.url
        if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -ne 'http') { throw 'Invalid local session URL.' }
        Start-Process -FilePath $session.url -WindowStyle Normal
        $found = $true
        break
    } else {
        try { Stop-Process -Id ([int]$session.pid) -ErrorAction Stop; $found = $true }
        catch { Write-Host 'Run this stop entry as administrator when the background process is elevated.'; exit 1 }
    }
}
if (!$found) { Write-Host 'No running session found. Start the tool first.'; exit 1 }
