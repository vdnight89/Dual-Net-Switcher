param([ValidateSet('Arm','Restore','Status')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $root 'data\test-network-guard.json'
function Is-Administrator { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Save-State($value) {
    $directory = Split-Path -Parent $stateFile
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temp = $stateFile + '.tmp'
    [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $stateFile -Force
}
function Resolve-Index($id) {
    $nic = @(Get-NetAdapter -Physical | Where-Object {$_.InterfaceGuid.ToString() -eq $id})
    if ($nic.Count -ne 1) { throw 'Saved physical network adapter is unavailable.' }
    return [int]$nic[0].ifIndex
}
function Restore-Entries($entries) {
    foreach ($entry in @($entries)) {
        $index = Resolve-Index $entry.id
        $current = Get-NetIPInterface -InterfaceIndex $index -AddressFamily $entry.family
        if ([int]$current.InterfaceMetric -eq [int]$entry.metric -and ($current.AutomaticMetric.ToString() -eq 'Enabled') -eq [bool]$entry.automatic) { continue }
        if ($current.AutomaticMetric.ToString() -ne 'Disabled' -or [int]$current.InterfaceMetric -ne [int]$entry.guardedMetric) { throw 'Interface settings changed externally; guard will not overwrite them.' }
        if ($entry.automatic) { Set-NetIPInterface -InterfaceIndex $index -AddressFamily $entry.family -AutomaticMetric Enabled | Out-Null }
        else { Set-NetIPInterface -InterfaceIndex $index -AddressFamily $entry.family -AutomaticMetric Disabled -InterfaceMetric $entry.metric | Out-Null }
    }
}
if ($Action -eq 'Status') {
    if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 }
    else { Write-Output '{"armed":false}' }
    exit 0
}
if (!(Is-Administrator)) {
    try {
        $argsList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Action',$Action)
        $child = Start-Process powershell.exe -ArgumentList $argsList -Verb RunAs -WindowStyle Hidden -PassThru -Wait
        exit $child.ExitCode
    } catch { Write-Error 'Administrator authorization was cancelled or failed. Network guard was not applied.'; exit 1 }
}
try {
    if ($Action -eq 'Restore') {
        if (!(Test-Path -LiteralPath $stateFile)) { exit 0 }
        $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        Restore-Entries $state.entries
        $state.armed = $false; $state.phase = 'restored'; Save-State $state
        exit 0
    }
    if (Test-Path -LiteralPath $stateFile) {
        $existing = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($existing.armed -or $existing.phase -eq 'prepared') { throw 'A guard snapshot already exists. Inspect or restore it first.' }
    }
    $wired = @(Get-NetAdapter -Physical | Where-Object {$_.Status -eq 'Up' -and ($_.MediaType.ToString() -eq '802.3' -or $_.PhysicalMediaType.ToString() -match '802.3' -or $_.Name -match '^Ethernet|^以太网')})
    $wifi = @(Get-NetAdapter -Physical | Where-Object {$_.NdisPhysicalMedium -in @(1,9) -or $_.InterfaceDescription -match 'Wireless|Wi-Fi|802.11' -or $_.Name -eq 'WLAN'})
    if ($wired.Count -ne 1 -or $wifi.Count -ne 1) { throw 'Exactly one active wired and one physical Wi-Fi adapter are required.' }
    $default = @(Get-NetRoute -InterfaceIndex $wired[0].ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore)
    if (!$default.Count) { throw 'Wired default route is missing.' }
    $entries = @()
    foreach ($pair in @(@($wired[0],5),@($wifi[0],5000))) {
        foreach ($ipif in @(Get-NetIPInterface -InterfaceIndex $pair[0].ifIndex)) {
            $entries += [pscustomobject]@{id=$pair[0].InterfaceGuid.ToString();name=$pair[0].Name;family=$ipif.AddressFamily.ToString();metric=[int]$ipif.InterfaceMetric;automatic=($ipif.AutomaticMetric.ToString() -eq 'Enabled');guardedMetric=[int]$pair[1]}
        }
    }
    $state = [pscustomobject]@{armed=$false;phase='prepared';createdAt=[DateTime]::UtcNow.ToString('o');wiredId=$wired[0].InterfaceGuid.ToString();wiredGateway=$default[0].NextHop;entries=$entries}
    Save-State $state
    try {
        foreach ($entry in $entries) {
            $index = Resolve-Index $entry.id
            Set-NetIPInterface -InterfaceIndex $index -AddressFamily $entry.family -AutomaticMetric Disabled -InterfaceMetric $entry.guardedMetric | Out-Null
            $actual = Get-NetIPInterface -InterfaceIndex $index -AddressFamily $entry.family
            if ($actual.AutomaticMetric.ToString() -ne 'Disabled' -or [int]$actual.InterfaceMetric -ne $entry.guardedMetric) { throw 'Guard metric verification failed.' }
        }
        $route = @(Find-NetRoute -RemoteIPAddress '1.1.1.1')
        if (@($route | Where-Object {$_.InterfaceIndex -ne $wired[0].ifIndex}).Count) { throw 'Public IPv4 route is not using the wired adapter.' }
        $state.armed=$true; $state.phase='armed'; Save-State $state
    } catch {
        $failure=$_.Exception.Message
        try { Restore-Entries $entries; $state.phase='restored'; Save-State $state } catch { $state.phase='restore-required'; Save-State $state; throw ($failure + '; restore requires attention: ' + $_.Exception.Message) }
        throw $failure
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
