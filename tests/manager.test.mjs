import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager } from '../lib/manager.mjs';
import { DemoPlatform, demoConfig } from '../lib/demo.mjs';
import { runMaintenance, acquireLock } from '../server.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dual-net-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const platform = new DemoPlatform();
  const manager = await new Manager({ dataDir, platform, demo: true }).open();
  await manager.save(demoConfig, manager.revision);
  return { manager, platform, dataDir };
}
test('saving and previewing never applies; save survives reopening; stale editor rejected', async t => {
  const { manager, platform, dataDir } = await fixture(t);
  const old = manager.revision;
  const config = structuredClone(manager.config); config.rules[0].remark = '已修改';
  await manager.save(config, old);
  await assert.rejects(manager.save(demoConfig, old), /其他窗口/);
  await manager.preview();
  assert.deepEqual(platform.owned.routes, []);
  const reopened = await new Manager({ dataDir, platform, demo: true }).open();
  assert.equal(reopened.config.rules[0].remark, '已修改');
});
test('auto sync uses applied snapshot, never a newly saved draft', async t => {
  const { manager, platform } = await fixture(t);
  const initial = structuredClone(manager.config); initial.settings.auto_sync = true;
  await manager.save(initial, manager.revision);
  await manager.apply((await manager.preview()).id);
  const draft = structuredClone(manager.config);
  draft.rules.push({ id: 'draft', type: 'SingleIP', target: '10.99.1.2', network: 'internal', enabled: true });
  await manager.save(draft, manager.revision);
  manager.nextSyncAt = null;
  await manager.tick();
  assert.ok(!platform.owned.routes.some(r => r.prefix === '10.99.1.2/32'));
  assert.notEqual(manager.state().appliedRevision, manager.revision);
});
test('DNS transient failure keeps last-good only for matching host/role/NIC/DNS identity', async t => {
  const { manager, platform } = await fixture(t);
  await manager.apply((await manager.preview()).id);
  platform.resolve = async () => { throw new Error('timeout'); };
  const plan = await manager.preview();
  assert.equal(plan.resolutions['demo-2'].stale, true);
  assert.ok(plan.routes.some(r => r.prefix === '10.20.1.55/32'));
  const changed = structuredClone(manager.config); changed.rules[1].target = 'different.company-a.com';
  await manager.save(changed, manager.revision);
  await assert.rejects(manager.preview(), /解析失败/);
});
test('expired preview, config edits and topology changes prevent writes', async t => {
  const { manager, platform } = await fixture(t);
  const plan = await manager.preview(); plan.createdAt = 0;
  await assert.rejects(manager.apply(plan.id), /过期/);
  const next = await manager.preview();
  const inspect = platform.inspect.bind(platform);
  platform.inspect = async () => { const state = await inspect(); state.adapters[0].gateway = '192.168.1.254'; return state; };
  await assert.rejects(manager.apply(next.id), /改变/);
  assert.equal(platform.owned.routes.length, 0);
});
test('reset idempotently clears managed resources but preserves saved rules', async t => {
  const { manager, platform, dataDir } = await fixture(t);
  await manager.apply((await manager.preview()).id);
  assert.ok(platform.owned.routes.length > 0);
  await manager.reset(); await manager.reset();
  assert.equal(platform.owned.routes.length, 0);
  assert.equal(manager.config.rules.length, 5);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')).appliedConfig, null);
});
test('corrupt config fails closed rather than overwriting user data', async t => {
  const { dataDir, platform } = await fixture(t);
  await writeFile(join(dataDir, 'config.json'), '{bad');
  await assert.rejects(new Manager({ dataDir, platform }).open(), /无法读取/);
  assert.equal(await readFile(join(dataDir, 'config.json'), 'utf8'), '{bad');
});
test('interrupted reset persists suspension before OS writes; scheduled maintenance cannot reapply old policy', async t => {
  const { manager, platform, dataDir } = await fixture(t);
  const config = structuredClone(manager.config); config.settings.auto_sync = true;
  await manager.save(config, manager.revision);
  await manager.apply((await manager.preview()).id);
  platform.reset = async () => { platform.owned.routes = []; throw new Error('simulated interruption after reset'); };
  await assert.rejects(manager.reset(), /interruption/);
  const saved = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8'));
  assert.equal(saved.maintenanceSuspended, true);
  const result = await runMaintenance({ dataDir, platform });
  assert.equal(result.skipped, true);
  assert.equal(platform.owned.routes.length, 0);
});
test('one-shot maintenance exits without an HTTP listener and skips when management process owns the lock', async t => {
  const { manager, platform, dataDir } = await fixture(t);
  const config = structuredClone(manager.config); config.settings.auto_sync = true;
  await manager.save(config, manager.revision);
  await manager.apply((await manager.preview()).id);
  const release = await acquireLock(dataDir);
  try { assert.equal((await runMaintenance({ dataDir, platform })).skipped, true); }
  finally { await release(); }
  const runtimePath = join(dataDir, 'runtime.json');
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8')); runtime.appliedAt = '2020-01-01T00:00:00Z';
  await writeFile(runtimePath, JSON.stringify(runtime));
  const result = await runMaintenance({ dataDir, platform });
  assert.equal(result.result.status, 'applied');
  const report = JSON.parse(await readFile(join(dataDir, 'maintenance-last.json'), 'utf8'));
  assert.equal(report.result.status, 'applied');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(dataDir, 'server.lock')), false);
});
