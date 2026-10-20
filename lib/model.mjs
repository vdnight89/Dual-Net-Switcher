import { isIPv4 } from 'node:net';
import { domainToASCII } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export function fail(message, code = 'VALIDATION') {
  throw Object.assign(new Error(message), { code });
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const exitName = (config, role) => config.settings[`${role}_label`] || (role === 'external' ? '主出口' : '专用出口');
export function routingFingerprint(config) {
  const policy = structuredClone(config);
  delete policy.settings.external_label; delete policy.settings.internal_label;
  for (const role of ['external', 'internal']) if (policy.settings[`${role}_nic_id`]) delete policy.settings[`${role}_nic_name`];
  return fingerprint(policy);
}
const ipv4 = (value, label) => {
  if (!isIPv4(value)) fail(`${label}必须是有效 IPv4 地址`);
  return value;
};
const ipNum = ip => ip.split('.').reduce((n, v) => n * 256 + Number(v), 0) >>> 0;
const numIp = n => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');
export function cidr(value) {
  value = value.trim();
  if (/[xX*]/.test(value)) {
    const octets = value.split('.');
    const first = octets.findIndex(part => /^[xX*]$/.test(part));
    if (octets.length !== 4 || first < 1 || !octets.slice(first).every(part => /^[xX*]$/.test(part)) || !octets.slice(0, first).every(part => /^\d{1,3}$/.test(part))) fail('X 或 * 只能连续放在末尾，例如 172.18.28.X、172.18.X.X');
    const address = octets.map((part, i) => i >= first ? '0' : part).join('.');
    ipv4(address, '网段地址');
    return `${address}/${first * 8}`;
  }
  const [ip, bits, ...extra] = value.split('/');
  if (extra.length || !/^\d{1,2}$/.test(bits ?? '') || Number(bits) < 1 || Number(bits) > 32) fail('网段前缀须为 /1 至 /32，默认路由由主出口统一管理');
  ipv4(ip, '网段地址');
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
  return `${numIp(ipNum(ip) & mask)}/${Number(bits)}`;
}
export function host(value) {
  let target = value.trim();
  // Also accept copied Markdown URLs such as [portal](http://portal:8080).
  const markdown = target.match(/^\[[^\]]*\]\((https?:\/\/[^\s]+)\)$/i);
  if (markdown) target = markdown[1];
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('仅支持无账号密码的 HTTP / HTTPS 网址');
      target = url.hostname;
    } else if (/[/:?#]/.test(target)) {
      const url = new URL(`http://${target}`);
      if (url.username || url.password) fail('域名不能包含账号密码');
      target = url.hostname;
    }
  } catch { fail('域名或网址格式不正确'); }
  target = domainToASCII(target.replace(/\.$/, '').toLowerCase());
  if (!target || target.length > 253 || isIPv4(target) || target.includes(':') || !target.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) fail('请输入精确域名，不支持通配符或 IPv6');
  return target;
}
export function normalizeTarget(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('请输入地址，最多 2048 字符');
  let text = value.trim();
  if (!text) fail('粘贴网址，或输入域名、IP、网段');
  const markdown = text.match(/^\[[\s\S]*?\]\(\s*(https?:\/\/\S+)\s*\)$/i);
  if (markdown) text = markdown[1];
  if ((text.startsWith('<') && text.endsWith('>')) || (text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) text = text.slice(1, -1).trim();
  if ((/^[\d.xX*]+(?:\/.*)?$/.test(text) && /[xX*]/.test(text)) || /^\d[\d.]*\//.test(text)) {
    const target = cidr(text);
    return { type: 'CIDR', target, explanation: `整个网段 ${target}，包含其中的全部 IPv4 地址` };
  }
  if (isIPv4(text)) return { type: 'SingleIP', target: text, explanation: `只分流 IP ${text}` };
  if (/^[\d.]+$/.test(text)) fail('这个 IP 地址不正确，每一段必须是 0 至 255');
  let extracted = text;
  const looksLikeUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /[/:?#]/.test(text);
  if (looksLikeUrl) {
    let url;
    try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`); }
    catch { fail('网址格式不正确，请直接从浏览器地址栏复制完整网址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('仅支持无账号密码的 HTTP / HTTPS 网址');
    extracted = url.hostname;
    if (isIPv4(extracted)) return { type: 'SingleIP', target: extracted, explanation: `已从网址提取 IP ${extracted}；端口、路径和参数不参与分流` };
  }
  const target = host(extracted);
  return { type: 'Domain', target, explanation: looksLikeUrl || markdown ? `已从网址提取域名 ${target}；使用所选出口的 DNS 解析` : `域名 ${target}，使用所选出口的 DNS 解析` };
}
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('配置必须是 JSON 对象');
  const raw = input.settings ?? {};
  const settings = {};
  for (const role of ['external', 'internal']) {
    const label = raw[`${role}_label`] ?? (role === 'external' ? '主出口' : '专用出口');
    if (typeof label !== 'string' || [...label.trim()].length > 24 || /[\x00-\x1f\x7f]/.test(label)) fail('出口名称最多 24 个字符，不能包含换行或控制字符');
    settings[`${role}_label`] = label.trim() || (role === 'external' ? '主出口' : '专用出口');
    for (const suffix of ['nic_id', 'nic_name']) {
      const value = raw[`${role}_${suffix}`] ?? '';
      if (typeof value !== 'string' || value.length > 256) fail('网卡标识格式错误');
      settings[`${role}_${suffix}`] = value;
    }
    const gateway = String(raw[`${role}_gateway`] ?? '').trim();
    settings[`${role}_gateway`] = gateway ? ipv4(gateway, '网关') : '';
    const dns = raw[`${role}_dns`] ?? '';
    const list = (Array.isArray(dns) ? dns : String(dns).split(/[,;\s]+/)).filter(Boolean);
    settings[`${role}_dns`] = [...new Set(list.map(ip => ipv4(String(ip), 'DNS')))];
  }
  const mins = raw.auto_sync_interval_mins ?? 10;
  if (!Number.isInteger(Number(mins)) || mins < 1 || mins > 1440) fail('同步间隔须为 1 至 1440 分钟');
  settings.auto_sync_interval_mins = Number(mins);
  settings.auto_sync = raw.auto_sync === true;
  if (!Array.isArray(input.rules) || input.rules.length > 1000) fail('规则列表须为数组，最多 1000 条');
  const ids = new Set();
  const rules = input.rules.map((r, i) => {
    if (!r || typeof r !== 'object') fail(`第 ${i + 1} 条规则格式错误`);
    const id = r.id ?? randomUUID();
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || ids.has(id)) fail('规则 ID 无效或重复');
    ids.add(id);
    if (!['Auto', 'CIDR', 'SingleIP', 'Domain'].includes(r.type)) fail('规则类型不正确');
    const network = String(r.network).toLowerCase();
    if (!['internal', 'external'].includes(network)) fail('规则出口必须为内网或外网');
    if (typeof r.target !== 'string' || r.target.length > 2048) fail('规则目标格式不正确');
    const { type, target } = normalizeTarget(r.target);
    if (typeof r.enabled !== 'boolean') fail('规则启用状态必须为布尔值');
    if (r.remark != null && (typeof r.remark !== 'string' || r.remark.length > 500)) fail('备注最多 500 字');
    return { id, type, target, network, remark: r.remark ?? '', enabled: r.enabled };
  });
  const seen = new Map();
  for (const r of rules.filter(r => r.enabled)) {
    const key = r.type === 'Domain' ? r.target : r.type === 'SingleIP' ? `${r.target}/32` : r.target;
    if (seen.has(key) && seen.get(key) !== r.network) fail(`目标 ${key} 同时指定了两个出口`);
    seen.set(key, r.network);
  }
  return { settings, rules };
}
export const emptyConfig = () => normalizeConfig({ settings: {}, rules: [] });
export function selectAdapters(config, snapshot) {
  const result = {};
  for (const role of ['external', 'internal']) {
    const id = config.settings[`${role}_nic_id`];
    const name = config.settings[`${role}_nic_name`];
    const adapter = snapshot.adapters.find(a => id ? a.id.toLowerCase() === id.toLowerCase() : name && a.name === name);
    if (!adapter?.up || !adapter.addresses?.length) fail(`请选择已连接的“${exitName(config, role)}”网卡`, 'ADAPTER_UNAVAILABLE');
    const gateway = config.settings[`${role}_gateway`] || adapter.gateway;
    if (!gateway) fail(`${adapter.name} 缺少网关，请在网络设置中手动填写`);
    ipv4(gateway, '网关');
    if (gateway === '0.0.0.0' || gateway === '255.255.255.255') fail('网关不能为未指定或广播地址');
    result[role] = { ...adapter, gateway, dns: config.settings[`${role}_dns`].length ? config.settings[`${role}_dns`] : adapter.dns ?? [] };
  }
  if (result.external.id === result.internal.id) fail(`“${exitName(config, 'external')}”和“${exitName(config, 'internal')}”必须选择不同网卡`);
  return result;
}
export function buildPlan(config, snapshot, resolutions) {
  const adapters = selectAdapters(config, snapshot);
  const routes = new Map();
  const warnings = ['分流范围为 IPv4。IPv6、代理以及使用独立 DNS / DoH 的应用可能绕过这些规则。'];
  const add = (prefix, role, persistent, source) => {
    const a = adapters[role];
    const old = routes.get(prefix);
    if (old && old.interfaceIndex !== a.index) fail(`${prefix} 被规则要求走不同出口（${old.source} / ${source}）`, 'ROUTE_CONFLICT');
    if (old) { old.persistent ||= persistent; return; }
    const [destination, bits] = prefix.split('/');
    const onLink = bits === '32' && (a.prefixes ?? []).some(p => {
      const [ip, length] = p.split('/');
      const mask = (0xffffffff << (32 - Number(length))) >>> 0;
      return ((ipNum(destination) & mask) >>> 0) === ((ipNum(ip) & mask) >>> 0);
    });
    routes.set(prefix, { prefix, interfaceIndex: a.index, interfaceId: a.id, gateway: onLink ? '0.0.0.0' : a.gateway, metric: 5, persistent, source });
  };
  add('0.0.0.0/0', 'external', true, '默认公网出口');
  // A DHCP default already has the same route key. Borrow it instead of trying to
  // create a duplicate or changing a resource owned by DHCP.
  const defaultRoute = routes.get('0.0.0.0/0');
  const existingDefault = (snapshot.routes ?? []).find(r => r.store === 'ActiveStore' && r.prefix === '0.0.0.0/0' && r.interfaceIndex === adapters.external.index && r.gateway === adapters.external.gateway);
  const ownedPersistentDefault = (snapshot.owned?.routes ?? []).some(r => r.prefix === '0.0.0.0/0' && r.store === 'PersistentStore' && r.interfaceId === adapters.external.id && r.gateway === adapters.external.gateway);
  if (existingDefault) { defaultRoute.metric = existingDefault.metric; defaultRoute.persistent = ownedPersistentDefault; }
  const externalCost = defaultRoute.metric + 5;
  for (const r of (snapshot.routes ?? []).filter(r => r.prefix === '0.0.0.0/0' && r.store === 'ActiveStore')) {
    if (r.interfaceIndex === adapters.external.index && r.gateway === adapters.external.gateway) continue;
    const a = snapshot.adapters.find(a => a.index === r.interfaceIndex);
    const cost = r.metric + (r.interfaceIndex === adapters.internal.index ? 5000 : r.interfaceIndex === adapters.external.index ? 5 : a?.metric ?? 0);
    if (cost <= externalCost) fail(`其他默认出口 ${a?.name ?? r.interfaceIndex} 的有效跃点 ${cost} 不高于“${exitName(config, 'external')}”的 ${externalCost}，请先处理该出口或 VPN 冲突`, 'DEFAULT_CONFLICT');
  }
  const nrpt = [];
  for (const r of config.rules.filter(r => r.enabled)) {
    if (r.type !== 'Domain') { add(r.type === 'CIDR' ? r.target : `${r.target}/32`, r.network, true, r.target); continue; }
    const answer = resolutions[r.id];
    if (!answer?.addresses?.length) fail(`${r.target} 尚未成功解析，未执行任何路由变更`, 'DNS_FAILED');
    if (answer.stale) warnings.push(`${r.target} 解析失败，保留最近成功地址：${answer.error}`);
    if (!adapters[r.network].dns.length) fail(`${r.target} 的出口没有 IPv4 DNS 服务器`);
    for (const ip of answer.addresses) add(`${ipv4(ip, 'DNS 结果')}/32`, r.network, false, r.target);
    for (const ip of adapters[r.network].dns) add(`${ipv4(ip, 'DNS 服务器')}/32`, r.network, false, 'DNS 查询路径');
    if (!nrpt.some(n => n.host === r.target)) nrpt.push({ host: r.target, servers: adapters[r.network].dns });
  }
  // Longest prefix match is the OS invariant; show overlap, do not invent ordering semantics.
  for (const r of config.rules.filter(r => r.enabled && r.type === 'CIDR')) {
    const [network, bits] = r.target.split('/');
    const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
    for (const route of routes.values()) {
      const [ip, size] = route.prefix.split('/');
      if (Number(size) > Number(bits) && ((ipNum(ip) & mask) >>> 0) === ipNum(network) && route.interfaceIndex !== adapters[r.network].index) warnings.push(`${route.prefix} 比 ${r.target} 更具体，优先走“${exitName(config, route.interfaceIndex === adapters.external.index ? 'external' : 'internal')}”`);
    }
  }
  return { routes: [...routes.values()], nrpt, metrics: [
    { interfaceIndex: adapters.external.index, interfaceId: adapters.external.id, metric: 5 },
    { interfaceIndex: adapters.internal.index, interfaceId: adapters.internal.id, metric: 5000 }
  ], warnings, adapters };
}
