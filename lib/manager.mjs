import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeConfig, emptyConfig, selectAdapters, buildPlan, fingerprint, routingFingerprint, fail } from './model.mjs';

export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  await rename(temp, path);
}
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`无法读取 ${path}，请保留文件并检查格式：${e.message}`); }
}
const routeKey = r => `${r.prefix}|${r.interfaceIndex}|${r.gateway}|${r.metric}|${r.persistent}`;
const topology = s => fingerprint(s.adapters.map(a => ({ id: a.id, index: a.index, up: a.up, addresses: a.addresses, gateway: a.gateway, dns: a.dns })));

export class Manager {
  constructor({ dataDir, platform, demo = false }) {
    this.dataDir = dataDir; this.platform = platform; this.demo = demo;
    this.logs = []; this.resolutions = {}; this.plans = new Map();
    this.tail = Promise.resolve(); this.lastResult = null; this.nextSyncAt = null;
  }
  async open() {
    await mkdir(this.dataDir, { recursive: true });
    this.config = normalizeConfig(await loadJson(join(this.dataDir, 'config.json'), emptyConfig()));
    this.runtime = await loadJson(join(this.dataDir, 'runtime.json'), { appliedConfig: null, resolutions: {}, startup: false });
    this.resolutions = this.runtime.resolutions ?? {};
    if (this.runtime.appliedConfig) {
      const maintenance = await loadJson(join(this.dataDir, 'maintenance-last.json'), null);
      if (maintenance?.time) {
        this.logs = (maintenance.logs ?? []).slice(0, 50);
        this.lastResult = maintenance.result;
      }
    }
    this.revision = fingerprint(this.config);
    this.system = await this.platform.inspect();
    if (!this.config.settings.external_nic_id && !this.config.settings.internal_nic_id) {
      const ext = this.system.adapters.find(a => a.up && a.kind === 'ethernet');
      const int = this.system.adapters.find(a => a.up && a.kind === 'wifi');
      for (const [role, a] of [['external', ext], ['internal', int]]) if (a) {
        this.config.settings[`${role}_nic_id`] = a.id;
        this.config.settings[`${role}_nic_name`] = a.name;
      }
      this.revision = fingerprint(this.config);
    }
    this.lastTopology = this.runtime.topology ?? topology(this.system);
    this.log('info', this.demo ? '演练模式已启动，所有系统变更在内存模拟。' : '已读取当前网卡状态与已保存配置。');
    if (this.system.recoveryRequired) this.log('error', '检测到未完成事务，请先恢复系统配置。');
    if (this.runtime.maintenanceSuspended) this.log('warning', '上次应用或恢复未完成，自动维护已暂停。请重新预览应用或恢复系统设置。');
    this.scheduleNext(this.runtime.appliedAt);
    return this;
  }
  log(level, message) {
    this.logs.unshift({ time: new Date().toISOString(), level, message });
    this.logs = this.logs.slice(0, 200);
  }
  serial(work) {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
  state() {
    return { config: this.config, revision: this.revision,
      appliedRevision: this.runtime.appliedConfig ? fingerprint(this.runtime.appliedConfig) : null,
      applied: !!this.runtime.appliedConfig && !this.runtime.maintenanceSuspended, demo: this.demo, system: this.system,
      policyApplied: !!this.runtime.appliedConfig && !this.runtime.maintenanceSuspended && routingFingerprint(this.runtime.appliedConfig) === routingFingerprint(this.config),
      maintenanceSuspended: this.runtime.maintenanceSuspended === true,
      resolutions: this.resolutions, logs: this.logs, lastResult: this.lastResult,
      nextSyncAt: this.nextSyncAt, startup: this.runtime.startup === true };
  }
  async refresh() { return this.serial(async () => { this.system = await this.platform.inspect(); return this.state(); }); }
  async save(input, revision) {
    return this.serial(async () => {
      if (revision !== this.revision) fail('配置已在其他窗口更新，请刷新后重试', 'STALE_CONFIG');
      const config = normalizeConfig(input);
      await atomicJson(join(this.dataDir, 'config.json'), config);
      this.config = config; this.revision = fingerprint(config); this.plans.clear();
      this.log('info', '配置已保存，应用后生效。');
      return this.state();
    });
  }
  async resolveConfig(config, snapshot, previous = {}) {
    const adapters = selectAdapters(config, snapshot);
    const resolutions = {};
    const rules = config.rules.filter(r => r.enabled && r.type === 'Domain');
    // Limit fan-out and DNS timeouts; do not let 1000 imported domains fork 1000 processes.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(6, rules.length) }, async () => {
      while (index < rules.length) {
        const r = rules[index++]; const a = adapters[r.network];
        const identity = fingerprint({ host: r.target, role: r.network, id: a.id, dns: a.dns, gateway: a.gateway });
        try {
          if (!a.dns.length) fail('该网卡没有 IPv4 DNS 服务器');
          const records = await this.platform.resolve({ host: r.target, servers: a.dns, sourceAddress: a.addresses[0] });
          const addresses = [...new Set(records.map(rec => rec.address))];
          if (!addresses.length) fail('未返回 IPv4 A 记录');
          resolutions[r.id] = { identity, addresses, ttl: Math.max(30, Math.min(...records.map(rec => rec.ttl || 600))), checkedAt: new Date().toISOString(), stale: false };
        } catch (e) {
          const last = previous[r.id];
          if (last?.identity === identity && last.addresses?.length) resolutions[r.id] = { ...last, stale: true, error: e.message };
          else fail(`${r.target} 解析失败：${e.message}。确认所选 DNS 经该网卡可达；可先添加 DNS 所在网段并应用，再启用域名规则。`, 'DNS_FAILED');
        }
      }
    }));
    return resolutions;
  }
  async makePlan(config) {
    const snapshot = await this.platform.inspect();
    if (snapshot.recoveryRequired) fail('上次事务尚未恢复，请先点击恢复系统配置', 'RECOVERY_REQUIRED');
    const resolutions = await this.resolveConfig(config, snapshot, this.runtime.resolutions);
    const plan = buildPlan(config, snapshot, resolutions);
    const previous = this.runtime.plan?.routes ?? [];
    const currentKeys = new Set(plan.routes.map(routeKey));
    const oldKeys = new Set(previous.map(routeKey));
    const owned = snapshot.owned?.routes ?? [];
    plan.changes = { add: plan.routes.filter(r => !oldKeys.has(routeKey(r))),
      remove: previous.filter(r => !currentKeys.has(routeKey(r))), keep: plan.routes.filter(r => oldKeys.has(routeKey(r))) };
    if (!owned.length && previous.length) plan.warnings.push('路由记录可能与系统状态不同，应用时将重新核对并修复。');
    plan.resolutions = resolutions;
    if (snapshot.fingerprint) plan.expectedFingerprint = snapshot.fingerprint;
    plan.id = randomUUID(); plan.configRevision = fingerprint(config);
    plan.topology = topology(snapshot); plan.createdAt = Date.now();
    plan.config = structuredClone(config);
    this.system = snapshot;
    return plan;
  }
  async preview() {
    return this.serial(async () => {
      const plan = await this.makePlan(this.config);
      this.plans.clear(); this.plans.set(plan.id, plan);
      this.resolutions = plan.resolutions;
      return plan;
    });
  }
  async commit(plan) {
    if (!this.system.admin) fail('请关闭工具并通过“以管理员身份启动”入口重新打开，取消 UAC 后不会修改网络', 'ADMIN_REQUIRED');
    // Persist suspension before touching the OS: a crash must never let an older
    // applied snapshot silently undo the user's new apply or reset intent.
    const suspended = { ...this.runtime, maintenanceSuspended: true };
    await atomicJson(join(this.dataDir, 'runtime.json'), suspended);
    this.runtime = suspended;
    const result = await this.platform.apply(plan);
    const runtime = { ...this.runtime, appliedConfig: structuredClone(plan.config), resolutions: plan.resolutions,
      plan: { routes: plan.routes, nrpt: plan.nrpt, metrics: plan.metrics }, topology: plan.topology,
      appliedAt: new Date().toISOString(), maintenanceSuspended: false };
    // Executor owns system journal. Failure to write runtime must not hide a committed system change.
    this.runtime = runtime; this.resolutions = plan.resolutions;
    this.lastResult = { status: 'applied', at: runtime.appliedAt, detail: result };
    try { await atomicJson(join(this.dataDir, 'runtime.json'), runtime); }
    catch (e) { this.runtime.appliedConfig = null; this.log('error', `路由已应用，但同步配置保存失败：${e.message}。请恢复或重新应用。`); throw e; }
    this.system = await this.platform.inspect(); this.lastTopology = topology(this.system);
    if (this.runtime.startup) {
      try { await this.platform.setStartup(true, plan.config.settings.auto_sync_interval_mins); }
      catch (e) { this.log('warning', `路由已应用，后台任务间隔更新失败：${e.message}`); }
    }
    this.scheduleNext();
    this.log('success', `${this.demo ? '演练完成' : '规则应用成功'}：${plan.routes.length} 条路由、${plan.nrpt.length} 条域名解析策略。`);
    for (const warning of plan.warnings.filter(w => w.includes('解析失败'))) this.log('warning', warning);
    return this.state();
  }
  scheduleNext(baseTime) {
    const config = this.runtime.appliedConfig;
    if (!config?.settings.auto_sync || this.runtime.maintenanceSuspended) { this.nextSyncAt = null; return; }
    const ttl = Math.min(config.settings.auto_sync_interval_mins * 60, ...Object.values(this.runtime.resolutions ?? {}).map(r => r.stale ? 60 : r.ttl || 600));
    const base = baseTime ? new Date(baseTime).getTime() : Date.now();
    this.nextSyncAt = new Date(base + Math.max(30, ttl) * 1000).toISOString();
  }
  async apply(planId) {
    return this.serial(async () => {
      const plan = this.plans.get(planId);
      if (!plan || plan.configRevision !== this.revision || Date.now() - plan.createdAt > 5 * 60_000) fail('预览已过期，请重新预览', 'STALE_PLAN');
      this.system = await this.platform.inspect();
      if (topology(this.system) !== plan.topology) fail('网卡连接、地址或网关已改变，请重新预览', 'STALE_PLAN');
      try { const result = await this.commit(plan); this.plans.clear(); return result; }
      catch (e) { this.log('error', `应用失败：${e.message}`); this.system = await this.platform.inspect(); throw e; }
    });
  }
  async reset() {
    return this.serial(async () => {
      this.runtime = { ...this.runtime, maintenanceSuspended: true };
      await atomicJson(join(this.dataDir, 'runtime.json'), this.runtime);
      this.nextSyncAt = null;
      const result = await this.platform.reset();
      this.runtime = { startup: this.runtime.startup, appliedConfig: null, resolutions: {} };
      await atomicJson(join(this.dataDir, 'runtime.json'), this.runtime);
      this.resolutions = {}; this.nextSyncAt = null; this.plans.clear();
      this.system = await this.platform.inspect(); this.lastResult = { status: 'reset', detail: result, at: new Date().toISOString() };
      this.log('success', '已恢复工具管理的网络配置。规则库已保留。');
      return this.state();
    });
  }
  async restoreAll() {
    return this.serial(async () => {
      // Suspend maintenance on disk before any OS write so a scheduled run
      // landing mid-restore cannot re-apply the old policy.
      this.runtime = { ...this.runtime, maintenanceSuspended: true };
      await atomicJson(join(this.dataDir, 'runtime.json'), this.runtime);
      this.nextSyncAt = null;
      let startupError = null;
      try { await this.platform.setStartup(false, this.config.settings.auto_sync_interval_mins); }
      catch (e) { startupError = e; }
      const result = await this.platform.reset();
      this.runtime = { startup: false, appliedConfig: null, resolutions: {} };
      await atomicJson(join(this.dataDir, 'runtime.json'), this.runtime);
      this.resolutions = {}; this.nextSyncAt = null; this.plans.clear();
      this.system = await this.platform.inspect(); this.lastResult = { status: 'reset', detail: result, at: new Date().toISOString() };
      this.log('success', startupError ? `系统设置已还原，但后台计划任务注销失败：${startupError.message}。请在网络设置中重试关闭。` : '已还原到未使用本工具的状态：分流路由、域名解析策略与后台计划任务全部撤销。规则库已保留。');
      if (startupError) this.log('warning', `一键还原后请确认计划任务已移除，避免后台维护恢复旧策略。`);
      return this.state();
    });
  }
  async setStartup(enabled) {
    return this.serial(async () => {
      if (typeof enabled !== 'boolean') fail('自启设置须为布尔值');
      await this.platform.setStartup(enabled, this.config.settings.auto_sync_interval_mins);
      this.runtime.startup = enabled;
      await atomicJson(join(this.dataDir, 'runtime.json'), this.runtime);
      this.log('success', enabled ? '已启用登录自启。' : '已关闭登录自启。');
      return this.state();
    });
  }
  async tick() {
    return this.serial(async () => {
      const config = this.runtime.appliedConfig;
      if (!config?.settings.auto_sync || this.runtime.maintenanceSuspended) return;
      try {
        const snapshot = await this.platform.inspect(); this.system = snapshot;
        if (snapshot.recoveryRequired) fail('存在未完成事务，自动同步暂停，请先恢复');
        const changed = this.lastTopology !== topology(snapshot);
        const missingRoutes = (this.runtime.plan?.routes ?? []).some(expected => !(snapshot.routes ?? []).some(actual =>
          actual.prefix === expected.prefix && actual.interfaceIndex === expected.interfaceIndex && actual.gateway === expected.gateway && (!actual.store || actual.store === 'ActiveStore')));
        if (!changed && !missingRoutes && this.nextSyncAt && new Date(this.nextSyncAt).getTime() > Date.now()) return;
        const plan = await this.makePlan(config);
        await this.commit(plan);
      } catch (e) {
        this.nextSyncAt = new Date(Date.now() + 60_000).toISOString();
        if (this.lastAutoError !== e.message) this.log('error', `自动同步暂停：${e.message}`);
        this.lastAutoError = e.message;
      }
    });
  }
}
