param([int]$RestartPid = 0)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $root 'server.mjs'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($RestartPid -gt 0) {
        $sessionFile = Join-Path $root 'data\session.json'
        $session = Get-Content -LiteralPath $sessionFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $old = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $RestartPid)
        $uri = [Uri]$session.url
        $listener = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $uri.Port | Where-Object OwningProcess -eq $RestartPid)
        if ([int]$session.pid -ne $RestartPid -or !$old -or $old.Name -ne 'node.exe' -or $old.CommandLine -notmatch 'server\.mjs' -or $uri.Host -ne '127.0.0.1' -or !$listener.Count) { throw 'Restart ownership check failed.' }
        $headers = @{ 'X-Session-Token' = $uri.Fragment.TrimStart('#') }
        $identity = Invoke-RestMethod -Uri ($uri.GetLeftPart([UriPartial]::Authority) + '/api/identity') -Headers $headers -TimeoutSec 5
        if ([int]$identity.pid -ne $RestartPid -or [IO.Path]::GetFullPath($identity.rootDir).TrimEnd('\') -ine [IO.Path]::GetFullPath($root).TrimEnd('\')) { throw 'Project identity mismatch.' }
        Stop-Process -Id $RestartPid -ErrorAction Stop
        Wait-Process -Id $RestartPid -ErrorAction SilentlyContinue
    }
    Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"')) -WorkingDirectory $root -WindowStyle Hidden
} else {
    try {
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-RestartPid', $RestartPid)
        Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $root -Verb RunAs -WindowStyle Hidden
    } catch {
        Write-Host 'Administrator launch cancelled or failed. No network configuration was changed.'
        exit 1
    }
}
