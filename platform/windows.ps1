$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$script:stateDir = Join-Path $inputData.dataDir 'windows-state'
$script:stateFile = Join-Path $stateDir 'ownership.json'
$script:journalFile = Join-Path $stateDir 'journal.json'
$script:owner = 'DualNetSwitcher'

function Encode($value) { ConvertTo-Json -InputObject $value -Depth 30 -Compress }
function Equal($a, $b) { (Encode $a) -ceq (Encode $b) }
function Save-Atomic($file, $value) {
  $temp = "$file.tmp"
  $bytes = [Text.Encoding]::UTF8.GetBytes((Encode $value))
  $stream = [IO.File]::Open($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  if (Test-Path -LiteralPath $file) { [IO.File]::Replace($temp, $file, "$file.bak", $true); Remove-Item -LiteralPath "$file.bak" -ErrorAction SilentlyContinue } else { [IO.File]::Move($temp, $file) }
}
function Load-Json($file, $fallback) { if (Test-Path -LiteralPath $file) { return (Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json) }; return $fallback }
function Is-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Initialize-StateDirectory {
  if(!(Test-Path -LiteralPath $stateDir)){New-Item -ItemType Directory -Path $stateDir -Force | Out-Null}
  $admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner($admins)
  foreach($sid in @($admins,$system)){
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  $readRule=New-Object Security.AccessControl.FileSystemAccessRule($user,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($readRule)
  Set-Acl -LiteralPath $stateDir -AclObject $acl
}
function Get-Routes($store) {
  try { return @(Get-NetRoute -AddressFamily IPv4 -PolicyStore $store -ErrorAction Stop) }
  catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { return @() }; throw }
}
function Get-Owned { Load-Json $stateFile ([pscustomobject]@{ entries = @(); startup = $null }) }
function Resource-Key($r) {
  switch ($r.kind) {
    'route' { return "route|$($r.prefix)|$($r.interfaceId)|$($r.gateway)|$($r.store)" }
    'metric' { return "metric|$($r.interfaceId)" }
    'nrpt' { return "nrpt|$($r.host)" }
    'startup' { return "startup|$($r.name)" }
  }
  throw 'Unknown resource kind'
}
function Nic-Index($id) {
  $nic = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceGuid.ToString().Trim('{}') -ieq $id.ToString().Trim('{}') })
  if ($nic.Count -ne 1) { throw "网卡已消失或标识无效：$id" }
  return [int]$nic[0].ifIndex
}
function Account-Sid($name) {
  if(!$name){return ''}
  if($name -match '^S-1-'){return (New-Object Security.Principal.SecurityIdentifier($name)).Value}
  $account=New-Object Security.Principal.NTAccount($name)
  return $account.Translate([Security.Principal.SecurityIdentifier]).Value
}
function Read-Resource($r) {
  switch ($r.kind) {
    'route' {
      $index = Nic-Index $r.interfaceId
      $items = @(Get-Routes $r.store | Where-Object { $_.DestinationPrefix -eq $r.prefix -and $_.InterfaceIndex -eq $index -and $_.NextHop -eq $r.gateway })
      if (!$items.Count) { return $null }
      if ($items.Count -gt 1) { throw '重复路由键，无法安全修改' }
      return [pscustomobject][ordered]@{ kind='route'; prefix=$r.prefix; interfaceId=$r.interfaceId; gateway=$r.gateway; metric=[int]$items[0].RouteMetric; store=$r.store }
    }
    'metric' {
      $index = Nic-Index $r.interfaceId
      $item = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $index
      return [pscustomobject][ordered]@{ kind='metric'; interfaceId=$r.interfaceId; metric=[int]$item.InterfaceMetric; automatic=($item.AutomaticMetric.ToString() -eq 'Enabled') }
    }
    'nrpt' {
      $items = @(Get-DnsClientNrptRule | Where-Object { @($_.Namespace) -contains $r.host })
      if (!$items.Count) { return $null }
      if ($items.Count -gt 1) { throw "域名存在多条 NRPT，无法安全修改：$($r.host)" }
      # Get-DnsClientNrptRule hands back System.Net.IPAddress objects, while plan
      # data carries plain strings; normalize to strings so Same() compares equal.
      $servers = @($items[0].NameServers | ForEach-Object { if ($_.IPAddressToString) { [string]$_.IPAddressToString } else { [string]$_ } } | Sort-Object)
      return [pscustomobject][ordered]@{ kind='nrpt'; host=$r.host; servers=$servers; comment=[string]$items[0].Comment; name=[string]$items[0].Name }
    }
    'startup' {
      $task=Get-ScheduledTask -TaskName $r.name -TaskPath '\' -ErrorAction SilentlyContinue
      if(!$task){return $null}
      $actions=@($task.Actions);$triggers=@($task.Triggers)
      $logon=@($triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'})
      $periodic=@($triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger'})
      $interval=0
      if($periodic.Count -eq 1 -and $periodic[0].Repetition.Interval){$interval=[int][Xml.XmlConvert]::ToTimeSpan($periodic[0].Repetition.Interval).TotalMinutes}
      return [pscustomobject][ordered]@{kind='startup';name=$r.name;execute=[string]$actions[0].Execute;arguments=[string]$actions[0].Arguments;directory=[string]$actions[0].WorkingDirectory;user=(Account-Sid ([string]$task.Principal.UserId));runLevel=[string]$task.Principal.RunLevel;logonType=[string]$task.Principal.LogonType;triggerUser=$(if($logon.Count){Account-Sid ([string]$logon[0].UserId)}else{''});triggerTypes=@($triggers | ForEach-Object {$_.CimClass.CimClassName} | Sort-Object);intervalMinutes=$interval;actionCount=$actions.Count;triggerCount=$triggers.Count;description=[string]$task.Description;xml=[string](Export-ScheduledTask -TaskName $r.name -TaskPath '\')}
    }
  }
}
function Write-Resource($keyResource, $target) {
  $current = Read-Resource $keyResource
  switch ($keyResource.kind) {
    'route' {
      $index = Nic-Index $keyResource.interfaceId
      if ($target -and $target.store -eq 'PersistentStore') {
        # This Windows build rejects New-NetRoute/Set-NetRoute with -PolicyStore
        # PersistentStore (CIM: Invalid parameter). route.exe -p writes the
        # persistent entry and materializes the active copy in one step; adding
        # over an existing route overwrites it, so it serves create and update.
        $parts = [string[]]($target.prefix -split '/')
        $len = [int]$parts[1]
        $maskInt = (-1 -shl (32 - $len)) -band 0xFFFFFFFF
        $mask = '{0}.{1}.{2}.{3}' -f (($maskInt -shr 24) -band 255), (($maskInt -shr 16) -band 255), (($maskInt -shr 8) -band 255), ($maskInt -band 255)
        $stdoutFile = Join-Path $env:TEMP 'dualnet-route-stdout.txt'
        $stderrFile = Join-Path $env:TEMP 'dualnet-route-stderr.txt'
        $proc = Start-Process -FilePath 'route.exe' -ArgumentList @('-p', 'add', $parts[0], 'mask', $mask, [string]$target.gateway, 'metric', [string]$target.metric, 'if', [string]$index) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $routeOutput = [string](Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue) + [string](Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue)
        if ($proc.ExitCode -ne 0 -or $routeOutput -match '失败|错误|fail|error') { throw "route.exe 持久路由写入失败（exit $($proc.ExitCode)）：$($target.prefix)" }
        break
      }
      if ($null -ne $current -and $null -ne $target) {
        Set-NetRoute -DestinationPrefix $current.prefix -InterfaceIndex $index -NextHop $current.gateway -PolicyStore $current.store -RouteMetric $target.metric -Confirm:$false | Out-Null
        break
      }
      if ($null -ne $current) { Remove-NetRoute -DestinationPrefix $current.prefix -InterfaceIndex $index -NextHop $current.gateway -PolicyStore $current.store -Confirm:$false | Out-Null }
      if ($null -ne $target) { New-NetRoute -DestinationPrefix $target.prefix -InterfaceIndex $index -NextHop $target.gateway -RouteMetric $target.metric -PolicyStore $target.store | Out-Null }
    }
    'metric' {
      if ($null -eq $target) { throw '不能删除接口跃点设置' }
      $index = Nic-Index $target.interfaceId
      if ($target.automatic) { Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $index -AutomaticMetric Enabled | Out-Null }
      else { Set-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $index -AutomaticMetric Disabled -InterfaceMetric $target.metric | Out-Null }
    }
    'nrpt' {
      if ($current -and $target) {
        Set-DnsClientNrptRule -Name $current.name -NameServers @($target.servers) -Comment $target.comment | Out-Null
        break
      }
      if ($current) { Remove-DnsClientNrptRule -Name $current.name -Force | Out-Null }
      if ($target) { Add-DnsClientNrptRule -Namespace @($target.host) -NameServers @($target.servers) -Comment $target.comment | Out-Null }
    }
    'startup' {
      if($current -and !$target){Unregister-ScheduledTask -TaskName $current.name -TaskPath '\' -Confirm:$false}
      if($target){
        if($target.xml){Register-ScheduledTask -TaskName $target.name -TaskPath '\' -Xml $target.xml -Force | Out-Null}
        else {
          $action=New-ScheduledTaskAction -Execute $target.execute -Argument $target.arguments -WorkingDirectory $target.directory
          $logon=New-ScheduledTaskTrigger -AtLogOn -User $target.triggerUser
          $periodic=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $target.intervalMinutes)
          $principal=New-ScheduledTaskPrincipal -UserId $target.user -LogonType Interactive -RunLevel Highest
          $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
          Register-ScheduledTask -TaskName $target.name -TaskPath '\' -Action $action -Trigger @($logon,$periodic) -Principal $principal -Settings $settings -Description $target.description -Force | Out-Null
        }
      }
    }
  }
}
# NRPT Names are assigned by Windows; compare the semantic content while retaining Name for removal.
function Same($a, $b) {
  if ($null -eq $a -or $null -eq $b) { return ($null -eq $a -and $null -eq $b) }
  if ($a.kind -eq 'nrpt' -and $b.kind -eq 'nrpt') { return ($a.host -eq $b.host -and (Equal @($a.servers) @($b.servers)) -and $a.comment -eq $b.comment) }
  if ($a.kind -eq 'startup' -and $b.kind -eq 'startup') {
    if($a.xml -and $b.xml){return $a.xml -ceq $b.xml}
    foreach($field in @('name','execute','arguments','directory','user','runLevel','logonType','triggerUser','intervalMinutes','actionCount','triggerCount','description')){if($a.$field -cne $b.$field){return $false}}
    if(!(Equal @($a.triggerTypes) @($b.triggerTypes))){return $false}
    return $true
  }
  if ($a.kind -eq 'metric' -and $a.automatic -and $b.automatic) { return $a.interfaceId -eq $b.interfaceId }
  return Equal $a $b
}
function Recover {
  if (!(Test-Path -LiteralPath $journalFile)) { return }
  $journal = Load-Json $journalFile $null
  if ($journal.status -eq 'committed') { Save-Atomic $stateFile $journal.nextOwned; Remove-Item -LiteralPath $journalFile; return }
  $errors = @()
  # Reverse ALL planned changes: a crash can occur between mutation and recording completion.
  $changes = @($journal.changes)
  [array]::Reverse($changes)
  # PersistentStore operations can mutate ActiveStore implicitly. Compensate them first,
  # then restore the ActiveStore snapshot, including routes borrowed before the transaction.
  $changes = @($changes | Sort-Object @{Expression={if($_.resource.kind -ne 'route'){0}elseif($_.resource.store -eq 'PersistentStore'){1}else{2}}})
  foreach ($change in $changes) {
    try {
      $actual = Read-Resource $change.resource
      if (Same $actual $change.before) { continue }
      $knownSideEffect=$false
      if($null -eq $actual -and $change.resource.kind -eq 'route' -and $change.resource.store -eq 'ActiveStore'){
        $related=@($journal.changes | Where-Object {$_.resource.kind -eq 'route' -and $_.resource.store -eq 'PersistentStore' -and $_.resource.prefix -eq $change.resource.prefix -and $_.resource.interfaceId -eq $change.resource.interfaceId -and $_.resource.gateway -eq $change.resource.gateway})
        if($related.Count -eq 1 -and (Same (Read-Resource $related[0].resource) $related[0].before)){$knownSideEffect=$true}
      }
      if (!(Same $actual $change.after) -and !$knownSideEffect) { throw "资源被外部修改：$($change.key)" }
      Write-Resource $change.resource $change.before
      if (!(Same (Read-Resource $change.resource) $change.before)) { throw "恢复校验失败：$($change.key)" }
    } catch { $errors += $_.Exception.Message }
  }
  if ($errors.Count) { $journal.status='needsAttention'; Save-Atomic $journalFile $journal; throw ('恢复未完成：' + ($errors -join '; ')) }
  if(@($journal.changes | Where-Object {$_.resource.kind -eq 'nrpt'}).Count){Clear-DnsClientCache}
  Save-Atomic $stateFile $journal.previousOwned
  Remove-Item -LiteralPath $journalFile
}
function Get-Inspection {
  # Read each CIM table once, then join by interface index in memory. Querying
  # separately for every hidden adapter makes an otherwise small snapshot costly.
  $allAdapters=@(Get-NetAdapter -IncludeHidden)
  $allIps=@(Get-NetIPAddress -AddressFamily IPv4)
  $allInterfaces=@(Get-NetIPInterface -AddressFamily IPv4)
  $allDns=@(Get-DnsClientServerAddress -AddressFamily IPv4)
  $allProfiles=@(Get-NetConnectionProfile -ErrorAction SilentlyContinue)
  $activeRoutes=@(Get-Routes 'ActiveStore')
  $persistentRoutes=@(Get-Routes 'PersistentStore')
  $ipsByIndex=@{};$interfacesByIndex=@{};$dnsByIndex=@{};$gatewaysByIndex=@{};$profileByIndex=@{}
  foreach($item in $allIps){$key=[string]$item.InterfaceIndex;$ipsByIndex[$key]=@($ipsByIndex[$key])+@($item)}
  foreach($item in $allInterfaces){$key=[string]$item.InterfaceIndex;if(!$interfacesByIndex.ContainsKey($key)){$interfacesByIndex[$key]=$item}}
  foreach($item in $allDns){$dnsByIndex[[string]$item.InterfaceIndex]=$item}
  foreach($item in $allProfiles){$key=[string]$item.InterfaceIndex;if(!$profileByIndex.ContainsKey($key)){$profileByIndex[$key]=$item}}
  # SSID rows use the locale-stable "SSID" label (BSSID rows never match the anchor);
  # netsh writes OEM-encoded bytes, so non-ASCII SSIDs may decode poorly and are
  # only used as a display preference over the profile name.
  $wifiSsids=@()
  try { foreach($line in @(netsh wlan show interfaces 2>$null)) { if ($line -match '^\s*SSID\s+:\s*(.+?)\s*$') { $value=$Matches[1].Trim(); if ($value) { $wifiSsids += $value } } } } catch { $wifiSsids=@() }
  foreach($item in @($activeRoutes | Where-Object {$_.DestinationPrefix -eq '0.0.0.0/0'} | Sort-Object RouteMetric)){
    $key=[string]$item.InterfaceIndex;if(!$gatewaysByIndex.ContainsKey($key)){$gatewaysByIndex[$key]=$item}
  }
  $adapters = @()
  foreach ($nic in @($allAdapters | Where-Object {$_.HardwareInterface -or $_.Status -eq 'Up'})) {
    $index=[int]$nic.ifIndex
    $key=[string]$index
    $ips=@($ipsByIndex[$key] | Where-Object {$null -ne $_})
    $ipif=$interfacesByIndex[$key]
    $gate=$gatewaysByIndex[$key]
    $dns=$dnsByIndex[$key]
    $kind='virtual'
    if ($nic.HardwareInterface) { $kind='ethernet'; if ([int]$nic.NdisPhysicalMedium -in @(1,9) -or [int]$nic.PhysicalMediaType -in @(1,9) -or $nic.InterfaceDescription -match 'Wireless|Wi-Fi|802.11') { $kind='wifi' } }
    $profile=$profileByIndex[$key]
    $networkName = if ($kind -eq 'wifi' -and $wifiSsids.Count -eq 1) { $wifiSsids[0] } elseif ($profile) { [string]$profile.Name } else { $null }
    $adapters += [pscustomobject]@{ id=$nic.InterfaceGuid.ToString().Trim('{}'); index=$index; name=$nic.Name; description=$nic.InterfaceDescription; kind=$kind; up=($nic.Status -eq 'Up'); networkName=$networkName; addresses=@($ips | ForEach-Object { $_.IPAddress }); prefixes=@($ips | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" }); gateway=$(if($gate){$gate.NextHop}else{$null}); dns=@($dns.ServerAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }); metric=$(if($ipif){[int]$ipif.InterfaceMetric}else{0}); automaticMetric=($ipif.AutomaticMetric -eq 'Enabled') }
  }
  $routes=@()
  foreach($store in @('ActiveStore','PersistentStore')) { $items=$activeRoutes;if($store -eq 'PersistentStore'){$items=$persistentRoutes};$routes += @($items | ForEach-Object { [pscustomobject]@{prefix=$_.DestinationPrefix;interfaceIndex=[int]$_.InterfaceIndex;gateway=$_.NextHop;metric=[int]$_.RouteMetric;store=$store} }) }
  $nrpt=@(Get-DnsClientNrptRule | ForEach-Object { [pscustomobject]@{name=$_.Name;namespace=@($_.Namespace);servers=@($_.NameServers);comment=$_.Comment} })
  $owned=Get-Owned
  $view=[pscustomobject]@{ admin=(Is-Admin); adapters=$adapters; routes=$routes; nrpt=$nrpt; owned=[pscustomobject]@{routes=@($owned.entries | Where-Object {$_.after.kind -eq 'route'} | ForEach-Object {$_.after});nrpt=@($owned.entries | Where-Object {$_.after.kind -eq 'nrpt'} | ForEach-Object {$_.after});metrics=@($owned.entries | Where-Object {$_.after.kind -eq 'metric'} | ForEach-Object {$_.after})}; recoveryRequired=(Test-Path -LiteralPath $journalFile) }
  $fingerprintData=Encode ([ordered]@{adapters=@($adapters | Sort-Object id);routes=@($routes | Sort-Object prefix,interfaceIndex,gateway,store);nrpt=@($nrpt | Sort-Object name)})
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $fingerprint=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($fingerprintData)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  $view | Add-Member -NotePropertyName fingerprint -NotePropertyValue $fingerprint
  return $view
}
function Desired-Resources($plan) {
  $resources=@()
  foreach($r in @($plan.routes)) {
    $index=Nic-Index $r.interfaceId
    if($index -ne [int]$r.interfaceIndex) { throw 'STALE_PLAN：接口索引变化' }
    $stores=@('ActiveStore'); if($r.persistent){$stores=@('PersistentStore','ActiveStore')}
    foreach($store in $stores){$resources += [pscustomobject][ordered]@{kind='route';prefix=[string]$r.prefix;interfaceId=[string]$r.interfaceId;gateway=[string]$r.gateway;metric=[int]$r.metric;store=$store}}
  }
  foreach($r in @($plan.metrics)) {
    if((Nic-Index $r.interfaceId) -ne [int]$r.interfaceIndex){throw 'STALE_PLAN：接口索引变化'}
    $resources += [pscustomobject][ordered]@{kind='metric';interfaceId=[string]$r.interfaceId;metric=[int]$r.metric;automatic=$false}
  }
  foreach($r in @($plan.nrpt)) {
    $hostName=([string]$r.host).ToLowerInvariant().TrimEnd('.')
    # Enterprise NRPT policies must not silently override the user's requested mapping.
    $policies=@(Get-DnsClientNrptPolicy -Effective -ErrorAction Stop | Where-Object { @($_.Namespace) | Where-Object { $_ -eq '.' -or $_ -eq $hostName -or ($_.StartsWith('.') -and $hostName.EndsWith($_)) } })
    $local=@(Get-DnsClientNrptRule | Where-Object { @($_.Namespace) -contains $hostName -and $_.Comment -eq $script:owner })
    $targetServers=@($r.servers | Sort-Object -Unique)
    foreach($policy in $policies){
      $policyServers=@($policy.NameServers | ForEach-Object {([string]$_) -split '[,;\s]+'} | Where-Object {$_} | Sort-Object -Unique)
      if(Equal $policyServers $targetServers){continue}
      # Allow editing our own exact local rule, but never waive an overlapping
      # effective corporate policy merely because a local rule also exists.
      $ownCurrent=$false
      if($local.Count -eq 1 -and @($policy.Namespace).Count -eq 1 -and @($policy.Namespace)[0] -eq $hostName){
        $localServers=@($local[0].NameServers | ForEach-Object {([string]$_) -split '[,;\s]+'} | Where-Object {$_} | Sort-Object -Unique)
        $ownCurrent=Equal $policyServers $localServers
      }
      if(!$ownCurrent){throw "NRPT_CONFLICT：有效系统 DNS 策略与目标服务器冲突：$hostName"}
    }
    $resources += [pscustomobject][ordered]@{kind='nrpt';host=$hostName;servers=@($r.servers | Sort-Object -Unique);comment=$script:owner;name=''}
  }
  $seen=@{}
  foreach($r in $resources){$key=Resource-Key $r;if($seen.ContainsKey($key)){if(!(Same $seen[$key] $r)){throw "计划资源冲突：$key"}}else{$seen[$key]=$r}}
  return @($seen.Values | Sort-Object @{Expression={if($_.kind -eq 'route' -and $_.store -eq 'PersistentStore'){0}elseif($_.kind -eq 'route'){1}elseif($_.kind -eq 'metric'){2}else{3}}}, @{Expression={Resource-Key $_}})
}
function Invoke-Transaction($desired) {
  $previous=Get-Owned
  $old=@{}; foreach($e in @($previous.entries)){$old[$e.key]=$e}
  $wanted=@{}; foreach($r in @($desired)){$wanted[(Resource-Key $r)]=$r}
  $changes=@();$next=@()
  foreach($r in @($desired)) {
    $key=Resource-Key $r;$actual=Read-Resource $r;$entry=$old[$key]
    if($entry -and !(Same $actual $entry.after) -and !($null -eq $actual -and $r.kind -eq 'route')){throw "OWNERSHIP_DRIFT：工具资源已被修改：$key"}
    if(!$entry -and $actual -and $r.kind -ne 'metric' -and !(Same $actual $r)){throw "RESOURCE_CONFLICT：拒绝覆盖已有资源：$key"}
    if($entry){$baseline=$entry.before}else{$baseline=$actual}
    # Preserve a borrowed ActiveStore snapshot when a newly-owned persistent row may
    # replace or later remove it as a Windows side effect. Its baseline stays non-null.
    $guard=$false
    if($r.kind -eq 'route' -and $r.store -eq 'ActiveStore'){
      $persistentKey="route|$($r.prefix)|$($r.interfaceId)|$($r.gateway)|PersistentStore"
      $guard=(@($next | Where-Object {$_.key -eq $persistentKey}).Count -gt 0)
    }
    if(!(Same $actual $r) -or ($guard -and !$entry)){$changes += [pscustomobject]@{key=$key;resource=$r;before=$actual;after=$r}}
    if($entry -or $guard -or !(Same $actual $r)){$next += [pscustomobject]@{key=$key;before=$baseline;after=$r}}
  }
  # Delete persistent routes before their active counterparts because Windows may remove both.
  foreach($entry in @($previous.entries | Sort-Object @{Expression={if($_.after.store -eq 'PersistentStore'){0}else{1}}})) {
    if($wanted.ContainsKey($entry.key)){continue}
    $actual=Read-Resource $entry.after
    if(!(Same $actual $entry.after) -and !($null -eq $actual -and $entry.after.kind -eq 'route')){throw "OWNERSHIP_DRIFT：待清理资源已被修改：$($entry.key)"}
    $changes += [pscustomobject]@{key=$entry.key;resource=$entry.after;before=$actual;after=$entry.before}
  }
  # A PersistentStore -> ActiveStore transition must remove the persistent row
  # before (re)materializing the retained active row. Otherwise Windows may erase
  # the desired active row as a side effect after we have already verified it.
  $persistentRemovals=@($changes | Where-Object {$_.resource.kind -eq 'route' -and $_.resource.store -eq 'PersistentStore' -and !$wanted.ContainsKey($_.key)})
  foreach($removal in $persistentRemovals){
    $r=$removal.resource
    $activeKey="route|$($r.prefix)|$($r.interfaceId)|$($r.gateway)|ActiveStore"
    if($wanted.ContainsKey($activeKey)){
      $retained=$wanted[$activeKey]
      $beforeActive=Read-Resource $retained
      $changes=@($changes | Where-Object {$_.key -ne $activeKey})
      $changes += [pscustomobject]@{key=$activeKey;resource=$retained;before=$beforeActive;after=$retained}
    }
  }
  if(!$changes.Count){return [pscustomobject]@{status='unchanged';changed=0;recoveryRequired=$false}}
  $nextOwned=[pscustomobject]@{entries=$next;startup=$previous.startup}
  $journal=[pscustomobject]@{schema=1;status='prepared';changes=$changes;previousOwned=$previous;nextOwned=$nextOwned}
  Save-Atomic $journalFile $journal
  try {
    foreach($change in $changes) {
      $actual=Read-Resource $change.resource
      if(Same $actual $change.after){continue}
      # PersistentStore creation/removal may already have adjusted the matching ActiveStore row.
      if(!(Same $actual $change.before)) {
        $isActiveSideEffect=$false
        if($change.resource.kind -eq 'route' -and $change.resource.store -eq 'ActiveStore' -and $null -eq $actual){
          $related=@($changes | Where-Object {$_.resource.kind -eq 'route' -and $_.resource.store -eq 'PersistentStore' -and $_.resource.prefix -eq $change.resource.prefix -and $_.resource.interfaceId -eq $change.resource.interfaceId -and $_.resource.gateway -eq $change.resource.gateway})
          if($related.Count -eq 1 -and (Same (Read-Resource $related[0].resource) $related[0].after)){$isActiveSideEffect=$true}
        }
        if(!$isActiveSideEffect){throw "资源在应用中变化：$($change.key)"}
      }
      Write-Resource $change.resource $change.after
      $observedAfterWrite = Read-Resource $change.resource
      if(!(Same $observedAfterWrite $change.after)){throw "写入校验失败：$($change.key)；期望=$(Encode $change.after)；实际=$(Encode $observedAfterWrite)"}
    }
    # Capture generated NRPT rule IDs before committing ownership.
    foreach($entry in $next){$observed=Read-Resource $entry.after;if(!(Same $observed $entry.after)){throw "最终校验失败：$($entry.key)"};$entry.after=$observed}
    if(@($changes | Where-Object {$_.resource.kind -eq 'nrpt'}).Count){Clear-DnsClientCache}
    $journal.nextOwned=$nextOwned;$journal.status='committed';Save-Atomic $journalFile $journal
    Save-Atomic $stateFile $nextOwned
    Remove-Item -LiteralPath $journalFile
    return [pscustomobject]@{status='applied';changed=$changes.Count;recoveryRequired=$false}
  } catch {
    $original=$_.Exception.Message
    try{Recover}catch{throw "$original；$($_.Exception.Message)"}
    throw "应用失败，已回滚：$original"
  }
}

function Set-Startup($enabled, $intervalMinutes=10) {
  if($intervalMinutes -lt 1 -or $intervalMinutes -gt 1440){throw '同步间隔须为 1 至 1440 分钟'}
  if(![IO.Path]::IsPathRooted($inputData.nodePath) -or ![IO.File]::Exists($inputData.nodePath) -or [IO.Path]::GetFileName($inputData.nodePath) -ine 'node.exe'){throw '自启需要已验证的 Node.js 可执行文件绝对路径'}
  $owned=Get-Owned
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($inputData.rootDir.ToLowerInvariant())))).Replace('-','').Substring(0,12)}finally{$sha.Dispose()}
  $name="DualNetSwitcher-$hash"
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $powerShellPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $maintenancePath=Join-Path $inputData.rootDir 'scripts\maintenance.ps1'
  $maintenanceArguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$maintenancePath+'" -NodePath "'+$inputData.nodePath+'"'
  $desired=[pscustomobject][ordered]@{kind='startup';name=$name;execute=$powerShellPath;arguments=$maintenanceArguments;directory=[string]$inputData.rootDir;user=$sid;runLevel='Highest';logonType='Interactive';triggerUser=$sid;triggerTypes=@('MSFT_TaskLogonTrigger','MSFT_TaskTimeTrigger');intervalMinutes=[int]$intervalMinutes;actionCount=1;triggerCount=2;description="DualNetSwitcher owned startup: $hash";xml=''}
  $actual=Read-Resource $desired
  if($actual -and !$owned.startup){throw 'STARTUP_CONFLICT：同名登录任务没有本工具所有权记录，拒绝覆盖'}
  if($owned.startup -and !(Same $actual $owned.startup)){throw 'OWNERSHIP_DRIFT：登录任务定义已被修改，拒绝覆盖或删除'}
  if($enabled){$after=$desired}else{$after=$null}
  if(Same $actual $after){return [pscustomobject]@{status='unchanged';enabled=$enabled;taskName=$name}}
  $next=[pscustomobject]@{entries=@($owned.entries);startup=$after}
  $journal=[pscustomobject]@{schema=1;status='prepared';changes=@([pscustomobject]@{key=(Resource-Key $desired);resource=$desired;before=$actual;after=$after});previousOwned=$owned;nextOwned=$next}
  Save-Atomic $journalFile $journal
  try{
    Write-Resource $desired $after
    $observed=Read-Resource $desired
    if(!(Same $observed $after)){throw '自启任务写入校验失败'}
    $next.startup=$observed
    $journal.nextOwned=$next;$journal.status='committed';Save-Atomic $journalFile $journal
    Save-Atomic $stateFile $next
    Remove-Item -LiteralPath $journalFile
    return [pscustomobject]@{status='applied';enabled=$enabled;taskName=$name}
  }catch{$failure=$_.Exception.Message;try{Recover}catch{throw "$failure；$($_.Exception.Message)"};throw "自启设置失败，已回滚：$failure"}
}

$mutex=$null;$locked=$false
try {
  if($inputData.action -eq 'inspect'){$result=Get-Inspection}
  else {
    if(!(Is-Admin)){throw 'ADMIN_REQUIRED：请以管理员身份启动工具'}
    $mutex=New-Object Threading.Mutex($false,'Global\DualNetSwitcherWindowsTransaction')
    try{$locked=$mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{$locked=$true}
    if(!$locked){throw 'BUSY：另一个系统操作正在运行'}
    Initialize-StateDirectory
    Recover
    switch($inputData.action){
      'apply' {
        if($inputData.plan.expectedFingerprint -and (Get-Inspection).fingerprint -ne $inputData.plan.expectedFingerprint){throw 'STALE_PLAN：系统网络状态已变化，请重新预览'}
        $result=Invoke-Transaction (Desired-Resources $inputData.plan)
      }
      'reset' {$result=Invoke-Transaction @()}
      'startup' {$interval=10;if($inputData.plan.intervalMinutes){$interval=[int]$inputData.plan.intervalMinutes};$result=Set-Startup ([bool]$inputData.plan.enabled) $interval}
      default {throw '未知执行器操作'}
    }
  }
  [Console]::Out.Write((Encode @{ok=$true;result=$result}))
} catch {
  $message=$_.Exception.Message;$code='WINDOWS_ERROR'
  if($message -match '^([A-Z_]+)：'){$code=$matches[1]}
  [Console]::Out.Write((Encode @{ok=$false;error=@{code=$code;message=$message}}))
  exit 1
} finally {if($locked){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}}
