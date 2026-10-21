import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WindowsPlatform } from '../lib/windows.mjs';

const route = { prefix: '10.0.0.0/8', interfaceIndex: 15, interfaceId: 'test-guid', gateway: '192.168.1.1', metric: 5, persistent: false };

test('固定 action 和 JSON 参数，不拼接命令文本', async () => {
  const calls = [];
  const p = new WindowsPlatform({ dataDir: './test-state', runner: async (script, input) => { calls.push({ script, input }); return { status: 'applied' }; } });
  await p.apply({ routes: [route], nrpt: [], metrics: [] });
  await p.reset();
  await p.setStartup(true, 15);
  assert.match(calls[0].script, /platform[\\/]windows\.ps1$/);
  assert.deepEqual(calls.map(c => c.input.action), ['apply', 'reset', 'startup']);
  assert.deepEqual(calls[2].input.plan, { enabled: true, intervalMinutes: 15 });
  assert.deepEqual(calls[0].input.plan.routes[0], route);
  await assert.rejects(p.apply({ routes: [{ ...route, gateway: '1.2.3.4; Remove-Item' }], nrpt: [], metrics: [] }), /格式无效/);
  await assert.rejects(p.setStartup(true, 0), /间隔/);
  assert.equal(calls.length, 3);
});

test('默认路由 RouteMetric 0 合法，负数与超大值仍拒绝', async () => {
  const calls = [];
  const p = new WindowsPlatform({ dataDir: './test-state', runner: async (script, input) => { calls.push({ script, input }); return { status: 'applied' }; } });
  const defaultRoute = { prefix: '0.0.0.0/0', interfaceIndex: 15, interfaceId: 'test-guid', gateway: '192.168.1.1', metric: 0, persistent: false };
  await p.apply({ routes: [defaultRoute, route], nrpt: [], metrics: [] });
  assert.equal(calls[0].input.plan.routes[0].metric, 0);
  await assert.rejects(p.apply({ routes: [{ ...defaultRoute, metric: -1 }], nrpt: [], metrics: [] }), /格式无效/);
  await assert.rejects(p.apply({ routes: [{ ...defaultRoute, metric: 10000 }], nrpt: [], metrics: [] }), /格式无效/);
});

test('DNS 查询使用指定服务器、源地址和 TTL，失败明确可达性限制', async () => {
  const seen = {};
  const resolver = { setServers(value) { seen.servers = value; }, setLocalAddress(value) { seen.source = value; }, async resolve4(host, options) { seen.host = host; seen.options = options; return [{ address: '10.1.1.1', ttl: 30 }, { address: '10.1.1.1', ttl: 30 }]; } };
  const p = new WindowsPlatform({ dataDir: './test-state', resolverFactory: () => resolver });
  assert.deepEqual(await p.resolve({ host: 'oa.corp.test', servers: ['10.0.0.53'], sourceAddress: '10.0.0.2' }), [{ address: '10.1.1.1', ttl: 30 }]);
  assert.deepEqual(seen, { servers: ['10.0.0.53'], source: '10.0.0.2', host: 'oa.corp.test', options: { ttl: true } });
  resolver.resolve4 = async () => { throw new Error('ETIMEOUT'); };
  await assert.rejects(p.resolve({ host: 'oa.corp.test', servers: ['10.0.0.53'] }), e => e.code === 'DNS_UNREACHABLE' && /可达/.test(e.message));
});

test('隐藏维护包装仅同步调用固定入口，Windows 5.1 语法有效', { skip: process.platform !== 'win32' }, async () => {
  const file = fileURLToPath(new URL('../scripts/maintenance.ps1', import.meta.url));
  const source = await readFile(file, 'utf8');
  assert.match(source, /& \$NodePath \$entry --sync-once --no-browser/);
  assert.match(source, /exit \$LASTEXITCODE/);
  assert.doesNotMatch(source, /Start-Process|Invoke-Expression/);
  const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile($env:DUALNET_MAINTENANCE,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|Out-String|Write-Error;exit 1}'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DUALNET_MAINTENANCE: file } });
  assert.equal(parsed.status, 0, parsed.stderr);
});

// Execute the production PowerShell transaction/recovery functions against an in-memory
// resource provider. No Windows network command is reachable from this harness.
async function transactionHarness(body) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dualnet-transaction-'));
  try {
    const source = await readFile(new URL('../platform/windows.ps1', import.meta.url), 'utf8');
    const functions = source.slice(source.indexOf('function Encode'), source.indexOf('\n$mutex=$null'));
    const prelude = `$ErrorActionPreference='Stop'
$script:stateDir=$PSScriptRoot
$script:stateFile=Join-Path $PSScriptRoot 'ownership.json'
$script:journalFile=Join-Path $PSScriptRoot 'journal.json'
$script:owner='DualNetSwitcher'
$script:inputData=[pscustomobject]@{rootDir=$PSScriptRoot;nodePath=(Get-Command node.exe).Source}
`;
    const mocks = `
$script:productionRead=(Get-Item function:Read-Resource).ScriptBlock
$script:system=@{}
$script:writes=0
$script:failAt=0
$script:persistentSideEffects=$false
$script:cacheFlushes=0
function Clear-DnsClientCache{$script:cacheFlushes++}
function Read-Resource($r) { $k=Resource-Key $r; if($script:system.ContainsKey($k)){return ((Encode $script:system[$k]) | ConvertFrom-Json)};return $null }
function Write-Resource($r,$target) {
  $script:writes++
  if($script:failAt -eq $script:writes){throw 'injected write failure'}
  $k=Resource-Key $r
  if($null -eq $target){$script:system.Remove($k)}else{$script:system[$k]=((Encode $target)|ConvertFrom-Json)}
  if($script:persistentSideEffects -and $r.kind -eq 'route' -and $r.store -eq 'PersistentStore'){
    $active=(Encode $r)|ConvertFrom-Json;$active.store='ActiveStore';$activeKey=Resource-Key $active
    if($target){$active=(Encode $target)|ConvertFrom-Json;$active.store='ActiveStore';$script:system[$activeKey]=$active}else{$script:system.Remove($activeKey)}
  }
}
function New-TestRoute($prefix) { [pscustomobject][ordered]@{kind='route';prefix=$prefix;interfaceId='guid';gateway='192.168.1.1';metric=5;store='ActiveStore'} }
function Check($condition,$message){if(!$condition){throw $message}}
`;
    const file = path.join(directory, 'harness.ps1');
    await writeFile(file, '\uFEFF' + prelude + functions + mocks + body + "\n[Console]::Out.Write('PASSED')", 'utf8');
    const output = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
    assert.match(output.stdout, /PASSED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('PowerShell：借用已有路由，重复应用幂等，重置仅移除拥有资源', { skip: process.platform !== 'win32' }, async () => {
  await transactionHarness(`
$borrowed=New-TestRoute '10.0.0.0/8';$created=New-TestRoute '172.16.0.0/12'
$script:system[(Resource-Key $borrowed)]=$borrowed
$result=Invoke-Transaction @($borrowed,$created)
Check ($result.status -eq 'applied') 'apply status'
$owned=Get-Owned
Check (@($owned.entries).Count -eq 1) 'borrowed resource acquired ownership'
$count=$script:writes
$result=Invoke-Transaction @($borrowed,$created)
Check ($result.status -eq 'unchanged' -and $script:writes -eq $count) 'not idempotent'
$script:system.Remove((Resource-Key $created))
Invoke-Transaction @($borrowed,$created)|Out-Null
Check (Same (Read-Resource $created) $created) 'lost route not repaired after network reconnect'
$result=Invoke-Transaction @()
Check ($script:system.Count -eq 1 -and $script:system.ContainsKey((Resource-Key $borrowed))) 'reset removed borrowed route'
Check (@((Get-Owned).entries).Count -eq 0) 'ownership not cleared'
`);
});

test('PowerShell：失败补偿、崩溃日志恢复以及漂移保护', { skip: process.platform !== 'win32' }, async () => {
  await transactionHarness(`
$a=New-TestRoute '10.0.0.0/8';$b=New-TestRoute '172.16.0.0/12'
$script:failAt=2;$failed=$false
try{Invoke-Transaction @($a,$b)|Out-Null}catch{$failed=$true}
Check $failed 'write failure hidden'
Check ($script:system.Count -eq 0) 'rollback left resources'
Check (!(Test-Path $journalFile)) 'rollback journal not cleared'
$script:failAt=0
# Simulate death immediately after a system write, before a completion marker.
$before=Get-Owned;$script:system[(Resource-Key $a)]=$a
$change=[pscustomobject]@{key=(Resource-Key $a);resource=$a;before=$null;after=$a}
Save-Atomic $journalFile ([pscustomobject]@{status='prepared';changes=@($change);previousOwned=$before;nextOwned=$before})
Recover
Check ($script:system.Count -eq 0) 'crash recovery failed'
Invoke-Transaction @($a)|Out-Null
$drift=New-TestRoute '10.0.0.0/8';$drift.metric=88;$script:system[(Resource-Key $drift)]=$drift
$failed=$false
try{Invoke-Transaction @()|Out-Null}catch{$failed=$_.Exception.Message -like '*OWNERSHIP_DRIFT*'}
Check $failed 'drift not rejected'
Check ($script:system[(Resource-Key $drift)].metric -eq 88) 'user change overwritten'
`);
});

test('PowerShell：提交窗口恢复和自动跃点原值恢复', { skip: process.platform !== 'win32' }, async () => {
  await transactionHarness(`
$original=[pscustomobject][ordered]@{kind='metric';interfaceId='guid';metric=25;automatic=$true}
$desired=[pscustomobject][ordered]@{kind='metric';interfaceId='guid';metric=5;automatic=$false}
$script:system[(Resource-Key $original)]=$original
Invoke-Transaction @($desired)|Out-Null
Invoke-Transaction @()|Out-Null
Check (Same (Read-Resource $original) $original) 'original automatic metric lost'
$committed=[pscustomobject]@{entries=@();startup=$null}
Save-Atomic $journalFile ([pscustomobject]@{status='committed';nextOwned=$committed})
Recover
Check (!(Test-Path $journalFile)) 'committed journal not cleared'
Check (@((Get-Owned).entries).Count -eq 0) 'committed ownership not recovered'
`);
});

test('PowerShell：持久路由的活动项副作用可回滚且不遗失原有活动路由', { skip: process.platform !== 'win32' }, async () => {
  await transactionHarness(`
$script:persistentSideEffects=$true
$active=New-TestRoute '10.0.0.0/8'
$persistent=(Encode $active)|ConvertFrom-Json;$persistent.store='PersistentStore'
$script:system[(Resource-Key $active)]=$active
$b=New-TestRoute '172.16.0.0/12';$script:failAt=2
$failed=$false
try{Invoke-Transaction @($persistent,$active,$b)|Out-Null}catch{$failed=$true}
Check $failed 'failure not propagated'
Check ($script:system.Count -eq 1) 'persistent side effect leaked or borrowed route lost'
Check (Same (Read-Resource $active) $active) 'borrowed active route was removed during rollback'
$script:failAt=0
Invoke-Transaction @($persistent,$active)|Out-Null
Invoke-Transaction @()|Out-Null
Check ($script:system.Count -eq 1 -and (Same (Read-Resource $active) $active)) 'reset lost borrowed active route'
`);
});

test('PowerShell：登录任务拥有、重复设置、定义漂移和关闭保护', { skip: process.platform !== 'win32' }, async () => {
  await transactionHarness(`
$result=Set-Startup $true
Check ($result.enabled -and $result.taskName -like 'DualNetSwitcher-*') 'startup not registered'
$task=(Get-Owned).startup
Check ($task.execute -like '*System32*wscript.exe' -and $task.arguments -like '*//B*//nologo*maintenance-hidden.vbs*' -and $task.runLevel -eq 'Highest') 'startup definition incorrect'
$vbsPath=Join-Path $inputData.rootDir ('scripts' + [char]92 + 'maintenance-hidden.vbs')
$vbsText=[IO.File]::ReadAllText($vbsPath)
Check ($vbsText -like '*WScript.Shell*' -and $vbsText -like '*maintenance.ps1*' -and $vbsText -like '*node.exe*' -and $vbsText -like '*", 0, True*') 'hidden launcher vbs incorrect'
Check ($task.triggerCount -eq 2 -and $task.intervalMinutes -eq 10) 'periodic/logon triggers missing'
$count=$script:writes
Set-Startup $true|Out-Null
Check ($count -eq $script:writes) 'startup not idempotent'
Set-Startup $true 15|Out-Null
$task=(Get-Owned).startup
Check ($task.intervalMinutes -eq 15 -and $script:writes -eq ($count+1)) 'periodic interval did not update'
# Construct CIM task objects only (no registration) to verify real Windows enum/SID/
# repetition serialization against the production task snapshot reader.
$action=New-ScheduledTaskAction -Execute $task.execute -Argument $task.arguments -WorkingDirectory $task.directory
$logon=New-ScheduledTaskTrigger -AtLogOn -User $task.user
$periodic=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 15)
$principal=New-ScheduledTaskPrincipal -UserId $task.user -LogonType Interactive -RunLevel Highest
$script:taskObject=[pscustomobject]@{Actions=@($action);Triggers=@($periodic,$logon);Principal=$principal;Description=$task.description}
function Get-ScheduledTask{return $script:taskObject}
function Export-ScheduledTask{return '<Task />'}
$realSnapshot=& $script:productionRead $task
Check (Same $realSnapshot $task) ('real CIM task snapshot normalization mismatch: '+(Encode $realSnapshot)+' expected: '+(Encode $task))
Invoke-Transaction @()|Out-Null
Check ($null -ne (Get-Owned).startup) 'reset removed startup ownership'
$modified=(Encode $task)|ConvertFrom-Json;$modified.arguments='other program';$script:system[(Resource-Key $task)]=$modified
$failed=$false
try{Set-Startup $false|Out-Null}catch{$failed=$_.Exception.Message -like '*OWNERSHIP_DRIFT*'}
Check $failed 'modified task deleted'
$script:system[(Resource-Key $task)]=$task
Set-Startup $false|Out-Null
Check ($null -eq (Get-Owned).startup -and $script:system.Count -eq 0) 'startup not removed'
$script:system[(Resource-Key $task)]=$task
$failed=$false
try{Set-Startup $true|Out-Null}catch{$failed=$_.Exception.Message -like '*STARTUP_CONFLICT*'}
Check $failed 'unowned same-name task overwritten'
`);
});

test('PowerShell：NRPT 精确拥有、变更缓存失效及企业有效策略冲突', { skip: process.platform !== 'win32' }, async () => {
  await transactionHarness(`
$nrpt=[pscustomobject][ordered]@{kind='nrpt';host='oa.corp.test';servers=@('10.0.0.53');comment='DualNetSwitcher';name=''}
Invoke-Transaction @($nrpt)|Out-Null
Check ($script:cacheFlushes -eq 1) 'DNS cache not invalidated'
$updated=(Encode $nrpt)|ConvertFrom-Json;$updated.servers=@('10.0.0.54')
Invoke-Transaction @($updated)|Out-Null
Invoke-Transaction @()|Out-Null
Check ($script:cacheFlushes -eq 3 -and $script:system.Count -eq 0) 'NRPT reset or cache failed'
function Get-DnsClientNrptRule{[pscustomobject]@{Namespace=@('oa.corp.test');NameServers=@('10.0.0.53');Comment='DualNetSwitcher'}}
function Get-DnsClientNrptPolicy{[pscustomobject]@{Namespace=@('oa.corp.test');NameServers=@('10.99.0.53')}}
$plan=[pscustomobject]@{routes=@();metrics=@();nrpt=@([pscustomobject]@{host='oa.corp.test';servers=@('10.0.0.53')})}
$failed=$false
try{Desired-Resources $plan|Out-Null}catch{$failed=$_.Exception.Message -like '*NRPT_CONFLICT*'}
Check $failed 'effective enterprise DNS override ignored due to local rule'
`);
});

test('PowerShell：持久降为活动路由会重新物化活动项，失败可恢复原双存储', { skip: process.platform !== 'win32' }, async () => {
  await transactionHarness(`
$script:persistentSideEffects=$true
$active=New-TestRoute '10.0.0.0/8'
$persistent=(Encode $active)|ConvertFrom-Json;$persistent.store='PersistentStore'
Invoke-Transaction @($persistent,$active)|Out-Null
Check ($script:system.Count -eq 2) 'initial persistent setup failed'
Invoke-Transaction @($active)|Out-Null
Check ($script:system.Count -eq 1 -and (Same (Read-Resource $active) $active)) 'retained active route lost during downgrade'
Check (@((Get-Owned).entries).Count -eq 1) 'persistent ownership retained after downgrade'
Invoke-Transaction @($persistent,$active)|Out-Null
# Fail when materializing the retained active row, after persistent deletion also erased it.
$script:failAt=$script:writes+2
$failed=$false
try{Invoke-Transaction @($active)|Out-Null}catch{$failed=$true}
Check $failed 'downgrade fault hidden'
Check ($script:system.Count -eq 2) 'failed downgrade did not restore both stores'
Check ((Same (Read-Resource $active) $active) -and (Same (Read-Resource $persistent) $persistent)) 'failed downgrade changed original route'
$script:failAt=0
Invoke-Transaction @($active)|Out-Null
Invoke-Transaction @()|Out-Null
Check ($script:system.Count -eq 0) 'reset after downgrade leaked routes'
`);
});
