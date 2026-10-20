import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

test('local API rejects missing token, hostile origin, rebinding host and non JSON body', async t => {
  let writes = 0;
  const manager = { state: () => ({ config: { rules: [] } }), save: async () => { writes++; return {}; } };
  const server = createApp({ manager, token: 'test-secret' });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['dual-net-mark.svg', 'local-computer.svg', 'rizhao-port.svg', 'wired-gateway.webp']) {
    const asset = await fetch(base + '/assets/' + name);
    assert.equal(asset.status, 200, name);
    assert.match(asset.headers.get('content-type'), /^image\//);
    assert.ok((await asset.arrayBuffer()).byteLength > 100);
  }
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { 'X-Session-Token': 'test-secret' } })).status, 200);
  const hostileHostStatus = await new Promise((done, reject) => {
    http.get(base + '/api/state', { headers: { Host: 'attacker.test', 'X-Session-Token': 'test-secret' } }, res => { res.resume(); done(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json', 'X-Session-Token': 'test-secret' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'X-Session-Token': 'test-secret' }, body: '{}' })).status, 400);
  assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Session-Token': 'test-secret' }, body: '{}' })).status, 200);
  assert.equal(writes, 1);
  assert.equal((await fetch(base + '/data/config.json', { headers: { 'X-Session-Token': 'test-secret' } })).status, 404);
});
