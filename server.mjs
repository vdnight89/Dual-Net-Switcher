import http from 'node:http';
import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Manager, atomicJson } from './lib/manager.mjs';
import { DemoPlatform, demoConfig } from './lib/demo.mjs';
import { normalizeTarget } from './lib/model.mjs';

const rootDir = dirname(fileURLToPath(import.meta.url));
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
assets['/theme-init.js'] = ['theme-init.js', 'text/javascript; charset=utf-8'];
assets['/assets/rizhao-port.svg'] = ['assets/rizhao-port.svg', 'image/svg+xml'];
assets['/assets/wired-gateway.webp'] = ['assets/wired-gateway.webp', 'image/webp'];
assets['/assets/dual-net-mark.svg'] = ['assets/dual-net-mark.svg', 'image/svg+xml'];
assets['/assets/local-computer.svg'] = ['assets/local-computer.svg', 'image/svg+xml'];
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function body(req) {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('请求须使用 JSON 格式'), { code: 'BAD_REQUEST' });
  let size = 0; const chunks = [];
  for await (const part of req) {
    size += part.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('配置不能超过 1 MB'), { code: 'BAD_REQUEST' });
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON 格式不正确'), { code: 'BAD_REQUEST' }); }
}
export function createApp({ manager, token, elevate, exit }) {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== expectedHost) return json(res, 403, { error: '不允许的访问来源', code: 'FORBIDDEN' });
    if (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) return json(res, 403, { error: '不允许跨站请求', code: 'FORBIDDEN' });
    let url;
    try { url = new URL(req.url, `http://${expectedHost}`); } catch { return json(res, 400, { error: '无效地址' }); }
    try {
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, mime] = assets[url.pathname];
        res.setHeader('Content-Type', mime);
        return res.end(await readFile(join(rootDir, 'public', file)));
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const supplied = Buffer.from(req.headers['x-session-token'] ?? ''); const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 401, { error: '会话已过期，请通过启动入口重新打开工具', code: 'UNAUTHORIZED' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, manager.state());
      if (req.method === 'GET' && url.pathname === '/api/identity') return json(res, 200, { rootDir, pid: process.pid });
      if (req.method === 'GET' && url.pathname === '/api/export') {
        res.setHeader('Content-Disposition', 'attachment; filename="dual-net-rules.json"');
        return json(res, 200, manager.state().config);
      }
      if (!['POST', 'PUT'].includes(req.method)) return json(res, 404, { error: '接口不存在' });
      const input = await body(req);
      let result;
      switch (`${req.method} ${url.pathname}`) {
        case 'POST /api/normalize': result = normalizeTarget(input.target); break;
        case 'PUT /api/config': case 'POST /api/import': result = await manager.save(input.config, input.revision); break;
        case 'POST /api/preview': result = await manager.preview(); break;
        case 'POST /api/apply': result = await manager.apply(input.planId); break;
        case 'POST /api/reset': result = await manager.reset(); break;
        case 'POST /api/refresh': result = await manager.refresh(); break;
        case 'POST /api/startup': result = await manager.setStartup(input.enabled); break;
        case 'POST /api/elevate':
          if (!elevate || manager.state().demo) throw new Error('当前模式不需要提权');
          result = elevate(); break;
        case 'POST /api/exit':
          if (!exit) throw new Error('当前会话不支持退出');
          result = { exiting: true }; setTimeout(exit, 300); break;
        default: return json(res, 404, { error: '接口不存在' });
      }
      return json(res, 200, result);
    } catch (e) {
      const status = ['UNAUTHORIZED', 'ADMIN_REQUIRED'].includes(e.code) ? 403 : ['STALE_CONFIG', 'STALE_PLAN'].includes(e.code) ? 409 : 400;
      return json(res, status, { error: e.message, code: e.code ?? 'OPERATION_FAILED' });
    }
  });
}

export async function acquireLock(dataDir) {
  const path = join(dataDir, 'server.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
      return async () => { try { await unlink(path); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let old;
      try { old = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('实例锁损坏，请确认工具未运行后移除 data/server.lock'); }
      let alive = true;
      try { process.kill(old.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('此配置目录的工具已在运行，请使用已打开的页面；关闭原进程后可重新启动。');
      await unlink(path);
    }
  }
  throw new Error('无法取得实例锁');
}
export async function start(options = {}) {
  const demo = options.demo ?? process.argv.includes('--demo');
  const dataDir = options.dataDir ?? resolve(rootDir, demo ? 'data/demo' : 'data');
  await mkdir(dataDir, { recursive: true });
  const release = await acquireLock(dataDir);
  try {
    const platform = demo ? new DemoPlatform() : new (await import('./lib/windows.mjs')).WindowsPlatform({ dataDir, rootDir });
    const manager = await new Manager({ dataDir, platform, demo }).open();
    if (demo && !manager.config.rules.length) await manager.save(demoConfig, manager.revision);
    const token = randomBytes(32).toString('hex');
    const elevate = () => {
      if (process.platform !== 'win32') throw new Error('仅支持 Windows 提权');
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(rootDir, 'scripts/launch-admin.ps1'), '-RestartPid', String(process.pid)], { windowsHide: true, stdio: 'ignore', detached: true });
      child.on('error', e => manager.log('error', `提权失败：${e.message}`));
      child.unref();
      return { restarting: true };
    };
    let closing = false;
    const server = createApp({ manager, token, elevate, exit: () => {
      if (closing) return; closing = true;
      // Wait for the serialized operation already in flight before dropping the
      // single-writer lock, so scheduled maintenance cannot race a final apply.
      clearInterval(timer);
      server.close(); server.closeIdleConnections();
      manager.tail.finally(async () => { await release(); process.exit(0); });
    } });
    const port = options.port ?? Number(process.env.DUAL_NET_PORT || 0);
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
    const url = `http://127.0.0.1:${server.address().port}/#${token}`;
    await atomicJson(join(dataDir, 'session.json'), { pid: process.pid, url, demo });
    console.log(`双网卡管家已启动${demo ? '（演练模式）' : ''}。可在页面退出管理；已启用的计划任务会按需维护。`);
    console.log(`管理页面：${url}`);
    // Network changes are detected within 20 seconds, DNS refresh respects configured interval and TTL.
    const timer = setInterval(() => manager.tick().catch(e => manager.log('error', e.message)), 20_000);
    timer.unref();
    const close = async () => { clearInterval(timer); await new Promise(done => server.close(done)); await release(); };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => close().then(() => process.exit(0)));
    if (!process.argv.includes('--no-browser') && options.openBrowser !== false && process.platform === 'win32') {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:DUAL_NET_OPEN_URL -WindowStyle Normal'], { windowsHide: true, env: { ...process.env, DUAL_NET_OPEN_URL: url }, stdio: 'ignore' });
      child.on('error', e => manager.log('warning', `浏览器未能自动打开：${e.message}`));
    }
    return { server, manager, url, close };
  } catch (e) { await release(); throw e; }
}
export async function runMaintenance({ dataDir = join(rootDir, 'data'), platform } = {}) {
  await mkdir(dataDir, { recursive: true });
  let release;
  try { release = await acquireLock(dataDir); }
  catch (e) { if (e.message.includes('已在运行')) return { skipped: true }; throw e; }
  try {
    let runtime;
    try { runtime = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { skipped: true }; throw e; }
    if (!runtime.appliedConfig?.settings.auto_sync || runtime.maintenanceSuspended) return { skipped: true };
    const windows = platform ?? new (await import('./lib/windows.mjs')).WindowsPlatform({ dataDir, rootDir });
    const manager = await new Manager({ dataDir, platform: windows }).open();
    manager.logs = []; // A one-shot outcome must not inherit errors from an older report.
    await manager.tick();
    const error = manager.logs.find(l => l.level === 'error');
    const report = { time: new Date().toISOString(), result: manager.lastResult, logs: manager.logs };
    await atomicJson(join(dataDir, 'maintenance-last.json'), report);
    if (error) throw new Error(error.message);
    return report;
  } finally { await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (process.argv.includes('--sync-once') ? runMaintenance() : start()).catch(e => { console.error(e.message); process.exitCode = 1; });
}
