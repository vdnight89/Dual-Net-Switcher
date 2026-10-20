import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('退出管理结束独立服务进程并释放监听，不要求浏览器窗口关闭', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dualnet-exit-'));
  const source = `import {start} from ${JSON.stringify(new URL('../server.mjs', import.meta.url).href)}; const app=await start({demo:true,dataDir:process.env.DUAL_NET_TEST_DATA,openBrowser:false,port:0}); console.log('SESSION:'+JSON.stringify({url:app.url}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, DUAL_NET_TEST_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(dataDir, { recursive: true, force: true }); });
  const session = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('独立演练服务启动超时')), 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/SESSION:(\{[^\n]+\})/);
      if (match) { clearTimeout(timeout); resolve(JSON.parse(match[1])); }
    });
    child.once('error', reject);
  });
  const url = new URL(session.url), token = url.hash.slice(1);
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('退出管理后服务进程仍然存活')), 5000);
    child.once('close', code => { clearTimeout(timeout); resolve(code); });
  });
  const response = await fetch(url.origin + '/api/exit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': token }, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).exiting, true);
  assert.equal(await exited, 0);
  await assert.rejects(fetch(url.origin + '/api/state', { signal: AbortSignal.timeout(1000) }));
});
