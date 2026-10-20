import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, buildPlan, host, cidr, normalizeTarget } from '../lib/model.mjs';
import { DemoPlatform, demoConfig } from '../lib/demo.mjs';

test('CIDR normalizes host bits and rejects default / malformed prefixes', () => {
  assert.equal(cidr('10.20.7.80/16'), '10.20.0.0/16');
  for (const value of ['0.0.0.0/0', '300.1.2.3/24', '10.1.1.1/33', '10.1.1.1/1e1']) assert.throws(() => cidr(value));
});
test('X and star shorthand normalize to contiguous CIDR, invalid holes and overbroad masks are rejected', () => {
  for (const target of ['172.18.28.X', '172.18.28.x', '172.18.28.*']) assert.equal(cidr(target), '172.18.28.0/24');
  assert.equal(cidr('172.18.X.X'), '172.18.0.0/16');
  assert.equal(cidr('10.X.X.X'), '10.0.0.0/8');
  for (const target of ['X.X.X.X', '172.X.28.X', '300.18.28.X', '172.18.X', '172.18.28.X/24', '172.18.28.XX', '0172.18.28.X']) assert.throws(() => cidr(target));
  const config = structuredClone(demoConfig); config.rules[0].target = '172.18.28.X';
  assert.equal(normalizeConfig(config).rules[0].target, '172.18.28.0/24');
});
test('paste-friendly URL and Markdown extraction uses IP or domain, ignoring port/path/query', () => {
  const url = 'http://129.0.8.134:7001/console/console.portal?_nfpb=true&_pageLabel=CoreServerServerTablePage';
  for (const value of [url, `[${url}](${url})`, ` <${url}> `, '129.0.8.134:7001/console']) {
    assert.equal(normalizeTarget(value).type, 'SingleIP'); assert.equal(normalizeTarget(value).target, '129.0.8.134');
  }
  assert.equal(normalizeTarget('https://Portal.Example.com:8080/login?a=1').target, 'portal.example.com');
  assert.equal(normalizeTarget('[OA](https://OA.Example.com:8080/login)').type, 'Domain');
  assert.equal(normalizeTarget('172.18.28.X').target, '172.18.28.0/24');
  for (const value of ['999.1.2.3', '172.X.28.X', '172.18.28.X/24', 'ftp://corp.example', 'http://u:p@corp.example', 'http://[::1]:8000/a', '*.corp.example']) assert.throws(() => normalizeTarget(value));
  const config = structuredClone(demoConfig); config.rules[1].type = 'Auto'; config.rules[1].target = url;
  const rule = normalizeConfig(config).rules[1];
  assert.equal(rule.type, 'SingleIP'); assert.equal(rule.target, '129.0.8.134');
});
test('Domain URL extracts exact host, IDNA normalizes, untrusted schemes and wildcard are rejected', () => {
  assert.equal(host('http://Portal.Corp.internal:8080/path?q=1'), 'portal.corp.internal');
  assert.equal(host('[portal](https://oa.example.com:443/a)'), 'oa.example.com');
  assert.equal(host('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
  for (const value of ['*.example.com', 'https://u:p@a.example', 'file://foo/a', '10.2.1.1', 'abc..foo']) assert.throws(() => host(value));
});
test('config rejects duplicate IDs, invalid flags and contradictory /32 routes', () => {
  assert.throws(() => normalizeConfig({ settings: {}, rules: [{ id: 'x', type: 'SingleIP', target: '1.2.3.4', network: 'internal', enabled: 'false' }] }));
  const config = structuredClone(demoConfig);
  config.rules.push({ ...config.rules[0] });
  assert.throws(() => normalizeConfig(config), /ID/);
  config.rules = [{ id: 'a', type: 'SingleIP', target: '10.2.3.4', network: 'internal', enabled: true }, { id: 'b', type: 'CIDR', target: '10.2.3.4/32', network: 'external', enabled: true }];
  assert.throws(() => normalizeConfig(config), /两个出口/);
});
test('plan contains exact DNS policies, DNS paths, active domain and persistent static routes', async () => {
  const config = normalizeConfig(demoConfig), snapshot = await new DemoPlatform().inspect();
  const answers = { 'demo-2': { addresses: ['10.20.1.55'] }, 'demo-3': { addresses: ['10.20.2.80'] } };
  const plan = buildPlan(config, snapshot, answers);
  assert.ok(plan.routes.find(r => r.prefix === '10.20.1.55/32' && !r.persistent));
  assert.ok(plan.routes.find(r => r.prefix === '10.20.0.2/32' && r.interfaceIndex === 7));
  assert.ok(plan.routes.find(r => r.prefix === '10.0.0.0/8' && r.persistent));
  assert.ok(!plan.routes.find(r => r.prefix === '172.18.0.0/16'));
  assert.equal(plan.nrpt[0].host, 'oa.company-a.com');
  assert.equal(plan.routes.filter(r => r.prefix === '0.0.0.0/0').length, 1);
});
test('shared IP requiring opposite exits blocks whole plan; same exit deduplicates', async () => {
  const config = normalizeConfig(demoConfig), snapshot = await new DemoPlatform().inspect();
  const answers = { 'demo-2': { addresses: ['10.20.1.55'] }, 'demo-3': { addresses: ['10.20.1.55'] } };
  assert.equal(buildPlan(config, snapshot, answers).routes.filter(r => r.prefix === '10.20.1.55/32').length, 1);
  config.rules[2].network = 'external';
  assert.throws(() => buildPlan(config, snapshot, answers), /不同出口/);
});
test('overlapping CIDRs preserve longest prefix semantics with visible warning', async () => {
  const config = normalizeConfig(demoConfig), snapshot = await new DemoPlatform().inspect();
  config.rules = [config.rules[0], { id: 'specific', type: 'CIDR', target: '10.20.1.0/24', network: 'external', enabled: true }];
  assert.ok(buildPlan(config, snapshot, {}).warnings.some(w => w.includes('更具体')));
  snapshot.adapters[1].up = false;
  assert.throws(() => buildPlan(config, snapshot, {}), /已连接/);
});
test('borrows DHCP default, preserves owned persistent default, rejects a competing better exit', async () => {
  const config = normalizeConfig(demoConfig), snapshot = await new DemoPlatform().inspect();
  config.rules = [];
  snapshot.routes = [{ prefix: '0.0.0.0/0', interfaceIndex: 12, gateway: '192.168.1.1', metric: 0, store: 'ActiveStore' }];
  let plan = buildPlan(config, snapshot, {});
  assert.equal(plan.routes[0].metric, 0); assert.equal(plan.routes[0].persistent, false);
  snapshot.owned.routes = [{ prefix: '0.0.0.0/0', interfaceId: 'demo-ethernet', gateway: '192.168.1.1', metric: 0, store: 'PersistentStore' }];
  assert.equal(buildPlan(config, snapshot, {}).routes[0].persistent, true);
  snapshot.adapters.push({ id: 'vpn', index: 100, metric: 1, name: 'VPN' });
  snapshot.routes.push({ prefix: '0.0.0.0/0', interfaceIndex: 100, gateway: '172.20.1.1', metric: 1, store: 'ActiveStore' });
  assert.throws(() => buildPlan(config, snapshot, {}), /其他默认出口/);
});
