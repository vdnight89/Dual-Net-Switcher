import { spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export class WindowsPlatform {
  constructor({ dataDir, rootDir = fileURLToPath(new URL('..', import.meta.url)), runner = runPowerShell, resolverFactory = () => new Resolver({ timeout: 3000, tries: 2 }) }) {
    this.dataDir = path.resolve(dataDir);
    this.rootDir = path.resolve(rootDir);
    this.runner = runner;
    this.resolverFactory = resolverFactory;
  }
  async command(action, plan) {
    return this.runner(path.join(this.rootDir, 'platform', 'windows.ps1'), { action, dataDir: this.dataDir, rootDir: this.rootDir, nodePath: process.execPath, plan });
  }
  async inspect() { return this.command('inspect'); }
  async apply(plan) { return this.command('apply', validatePlan(plan)); }
  async reset() { return this.command('reset'); }
  async setStartup(enabled, intervalMinutes = 10) {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error('自启同步间隔须为 1 至 1440 分钟');
    return this.command('startup', { enabled: Boolean(enabled), intervalMinutes });
  }
  async resolve({ host, servers, sourceAddress }) {
    if (typeof host !== 'string' || !host || /[\s/\\:]/u.test(host)) throw new Error('无效的 DNS 主机名');
    if (!Array.isArray(servers) || !servers.length || servers.some(s => isIP(s) !== 4)) throw new Error('请为所选网卡配置 IPv4 DNS 服务器');
    if (sourceAddress && isIP(sourceAddress) !== 4) throw new Error('无效的 DNS 源 IPv4 地址');
    const resolver = this.resolverFactory();
    resolver.setServers(servers);
    if (sourceAddress) resolver.setLocalAddress(sourceAddress);
    try {
      const answers = await resolver.resolve4(host, { ttl: true });
      return [...new Map(answers.map(a => [a.address, { address: a.address, ttl: a.ttl }])).values()];
    } catch (cause) {
      const error = new Error(`指定网卡 DNS 无法解析 ${host}；请先确认 DNS 经该网卡可达。${cause.message}`);
      error.code = 'DNS_UNREACHABLE';
      throw error;
    }
  }
}

function validatePlan(plan) {
  if (!plan || !['routes', 'nrpt', 'metrics'].every(k => Array.isArray(plan[k]))) throw new Error('路由计划格式无效');
  const integer = n => Number.isInteger(n) && n > 0 && n <= 65535;
  for (const route of plan.routes) {
    const parts = String(route.prefix).split('/');
    if (parts.length !== 2 || isIP(parts[0]) !== 4 || !/^\d{1,2}$/.test(parts[1]) || +parts[1] > 32 || !integer(route.interfaceIndex) || !route.interfaceId || isIP(route.gateway) !== 4 || !integer(route.metric) || typeof route.persistent !== 'boolean') throw new Error('路由资源格式无效');
  }
  for (const rule of plan.nrpt) if (typeof rule.host !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(rule.host) || !Array.isArray(rule.servers) || !rule.servers.length || rule.servers.some(s => isIP(s) !== 4)) throw new Error('域名 DNS 规则格式无效');
  for (const metric of plan.metrics) if (!integer(metric.interfaceIndex) || !metric.interfaceId || !integer(metric.metric)) throw new Error('网卡跃点格式无效');
  return plan;
}

export function runPowerShell(script, input) {
  if (process.platform !== 'win32') return Promise.reject(new Error('系统路由执行器仅支持 Windows'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); const error = new Error('Windows 操作超时；下次应用或恢复将检查未完成事务'); error.code = 'EXECUTOR_TIMEOUT'; finish(error); }, 120000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('close', code => {
      try {
        const response = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (!response.ok || code !== 0) { const error = new Error(response.error?.message || stderr || 'Windows 执行失败'); error.code = response.error?.code || 'EXECUTOR_FAILED'; finish(error); }
        else finish(null, response.result);
      } catch (error) { finish(new Error(`Windows 执行器返回无效结果：${stderr || stdout || error.message}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
