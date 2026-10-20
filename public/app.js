'use strict';

const $ = (id) => document.getElementById(id);
// Shared, dependency-free line icons follow the same stroke and sizing rules.
function uiIcon(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ui-icon');
  for (const d of paths) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
function setTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  const button = $('themeToggle');
  const paths = dark
    ? ['M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17m10-10 1.4-1.4', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8']
    : ['M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z'];
  button.replaceChildren(uiIcon(paths), document.createTextNode(dark ? '浅色' : '深色'));
  button.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  button.title = dark ? '切换到浅色主题' : '切换到深色主题';
  if (persist) {
    try { localStorage.setItem('dualnetTheme', theme); } catch { /* Optional preference store. */ }
    try { document.cookie = `dualnetTheme=${theme}; Path=/; Max-Age=31536000; SameSite=Strict`; } catch { /* In-memory switching still works. */ }
  }
}
setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
$('themeToggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
const navPaths = [
  ['M4 7h16m-4-4 4 4-4 4', 'M20 17H4m4-4-4 4 4 4'],
  ['M4 6h16M4 12h16M4 18h16', 'M8 3v6m8 0v6m-6 0v6'],
  ['M6 3h12v18H6z', 'M9 8h6m-6 4h6m-6 4h4'],
];
document.querySelectorAll('.nav-icon').forEach((node, i) => node.replaceChildren(uiIcon(navPaths[i])));
$('refreshButton').prepend(uiIcon(['M20 7v5h-5', 'M19 12a7 7 0 1 0-2 5', 'M20 12a7 7 0 0 0-12-5']));
document.querySelector('.search span').replaceChildren(uiIcon(['M21 21l-5-5', 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14']));
$('importButton').prepend(uiIcon(['M12 3v12m-4-4 4 4 4-4', 'M5 16v4h14v-4']));
$('exportButton').prepend(uiIcon(['M12 15V3m-4 4 4-4 4 4', 'M5 16v4h14v-4']));
const ruleScroller = document.querySelector('.table-scroll');
const scrollRulesButton = document.createElement('button');
scrollRulesButton.type = 'button'; scrollRulesButton.id = 'scrollRules'; scrollRulesButton.className = 'quiet scroll-rules';
document.querySelector('.table-footer').insertBefore(scrollRulesButton, document.querySelector('.table-footer').lastElementChild);
function updateRuleScroll() {
  const remaining = ruleScroller.scrollHeight - ruleScroller.clientHeight - ruleScroller.scrollTop;
  scrollRulesButton.hidden = ruleScroller.scrollHeight <= ruleScroller.clientHeight + 2;
  scrollRulesButton.textContent = remaining > 2 ? '向下查看其余规则 ↓' : '已到底部 · 返回顶部 ↑';
}
scrollRulesButton.addEventListener('click', () => {
  const atBottom = ruleScroller.scrollHeight - ruleScroller.clientHeight - ruleScroller.scrollTop <= 2;
  ruleScroller.scrollTo({ top: atBottom ? 0 : ruleScroller.scrollTop + ruleScroller.clientHeight - 45, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
});
ruleScroller.addEventListener('scroll', updateRuleScroll, { passive: true });
const ruleSizeObserver = new ResizeObserver(updateRuleScroll);
ruleSizeObserver.observe(ruleScroller); ruleSizeObserver.observe($('ruleRows'));
let token = location.hash.slice(1);
try {
  if (token) sessionStorage.setItem('sessionToken', token);
  else token = sessionStorage.getItem('sessionToken') || '';
} catch { /* Session remains usable in memory when storage is unavailable. */ }
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

let state = null;
let busy = false;
let settingsDirty = false;
let editingRuleId = null;
let activePlan = null;
let confirmHandler = null;
let toastTimer;
let lastFocus;
let sessionEnded = false;
const types = { CIDR: '网段', SingleIP: '单个 IP', Domain: '域名' };
const clone = (value) => JSON.parse(JSON.stringify(value));
const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
function message(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.message === 'string') return value.message;
  if (value && typeof value.detail === 'string') return value.detail;
  return JSON.stringify(value) || '';
}
function time(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}
function toast(text, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3800);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: { 'X-Session-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务返回了无法识别的结果，请检查本地服务。'); }
  if (!response.ok) {
    const error = new Error(data.error || '操作未完成');
    error.code = data.code;
    throw error;
  }
  return data;
}
async function action(task, errorTarget) {
  if (busy) return;
  busy = true;
  $('loadingBar').hidden = false;
  const controls = [...document.querySelectorAll('button,input,select')].map((node) => [node, node.disabled]);
  for (const [node] of controls) node.disabled = true;
  try { await task(); }
  catch (error) {
    const text = error.code === 'STALE_PLAN' ? '网络或配置已变化，请重新预览后再应用。' : error.message;
    if (errorTarget) $(errorTarget).textContent = text;
    toast(text, true);
  } finally {
    busy = false;
    $('loadingBar').hidden = true;
    for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled;
    // Controls created while rendering must also remain blocked until this task finishes.
    document.querySelectorAll('[data-busy-control]').forEach((node) => { node.disabled = false; });
    updateAvailability();
  }
}
function updateAvailability() {
  const unavailable = !state || busy;
  for (const id of ['previewButton', 'resetButton', 'addRule', 'importButton', 'exportButton', 'refreshButton']) $(id).disabled = unavailable;
  const readOnly = state && !state.demo && !state.system?.admin;
  $('resetButton').disabled = unavailable || readOnly;
  $('startup').disabled = unavailable || readOnly;
  $('settingsForm').querySelector('button[type=submit]').disabled = unavailable;
  $('exitButton').disabled = busy || sessionEnded;
  $('confirmApply').disabled = unavailable || !activePlan || Boolean(activePlan.blocked) || Boolean(state?.system?.recoveryRequired);
}
function applyState(next) {
  state = next;
  if (!state.config) throw new Error('服务状态缺少配置。');
  render();
}
function adapterList() { return asArray(state?.system?.adapters); }
function fillNicSelect(select, selectedId, selectedName) {
  select.replaceChildren();
  const placeholder = element('option', '请选择网卡');
  placeholder.value = '';
  select.append(placeholder);
  for (const adapter of adapterList()) {
    const option = element('option', `${adapter.name}${adapter.up ? '' : ' · 未连接'}`);
    option.value = adapter.id;
    select.append(option);
  }
  if (selectedId && !adapterList().some((adapter) => adapter.id === selectedId)) {
    const option = element('option', `${selectedName || selectedId} · 当前不可用`);
    option.value = selectedId;
    select.append(option);
  }
  select.value = selectedId || '';
}
function nicFor(role) {
  return adapterList().find((adapter) => adapter.id === state.config.settings[`${role}_nic_id`]);
}
function networkName(role) { return state.config.settings[`${role}_label`] || (role === 'external' ? '主出口' : '专用出口'); }
function settingsForNic(settings, role, id) {
  const adapter = adapterList().find((item) => item.id === id);
  settings[`${role}_nic_id`] = id;
  settings[`${role}_nic_name`] = adapter?.name || '';
  // A manual gateway or DNS from another interface must not silently follow the new one.
  settings[`${role}_gateway`] = '';
  settings[`${role}_dns`] = [];
}
async function saveConfig(config, success = '配置已保存，预览并应用后生效') {
  const next = await api('/api/config', 'PUT', { config, revision: state.revision });
  applyState(next);
  activePlan = null;
  toast(success);
}
function portIcon(kind, role) {
  if (role) {
    const img = document.createElement('img');
    img.src = role === 'internal' ? '/assets/rizhao-port.svg' : '/assets/wired-gateway.webp';
    img.alt = role === 'internal' ? '日照港专网徽标' : '有线出口徽标';
    img.className = 'network-emblem';
    img.width = 40; img.height = 40;
    img.addEventListener('error', () => img.replaceWith(portIcon(kind)), { once: true });
    return img;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const wireless = /wireless|wifi|wlan|无线/i.test(kind || '');
  const paths = wireless ? ['M3 9a14 14 0 0 1 18 0', 'M6 12a9 9 0 0 1 12 0', 'M9 15a4 4 0 0 1 6 0', 'M12 18h.01'] : ['M5 4h14v11H5z', 'M9 4v4m6-4v4', 'M12 15v5m-5 0h10'];
  for (const d of paths) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
function renderPorts() {
  $('ports').replaceChildren();
  for (const role of ['external', 'internal']) {
    const adapter = nicFor(role);
    const settings = state.config.settings;
    const card = element('article', null, 'port ' + role);
    const roleBlock = element('div', null, 'port-role');
    const label = element('span', null, 'port-label');
    const nameButton = element('button', null, 'network-name-button'); nameButton.type = 'button';
    nameButton.title = `${networkName(role)} · 点击修改名称`; nameButton.setAttribute('aria-label', `修改出口名称：${networkName(role)}`);
    nameButton.append(element('span', networkName(role), 'network-name-text'), element('span', '✎', 'name-edit-symbol'));
    nameButton.addEventListener('click', () => { document.querySelector('[data-tab=settings]').click(); $(`${role}Label`).focus(); $(`${role}Label`).select(); });
    label.append(portIcon(adapter?.kind, role), nameButton);
    roleBlock.append(label, element('span', role === 'external' ? '默认公网流量' : '匹配规则的流量', 'port-purpose'));
    const control = element('div', null, 'nic-control');
    const select = document.createElement('select');
    select.setAttribute('aria-label', `选择${networkName(role)}网卡`);
    select.dataset.busyControl = 'true'; select.disabled = busy;
    fillNicSelect(select, settings[role + '_nic_id'], settings[role + '_nic_name']);
    select.addEventListener('change', () => {
      const selectedId = select.value;
      void action(async () => {
        const config = clone(state.config); settingsForNic(config.settings, role, selectedId);
        try { await saveConfig(config); } catch (error) { renderPorts(); throw error; }
      });
    });
    const status = element('span', state.demo ? '演练网卡' : adapter?.up ? '已连接 · 接口 ' + adapter.index : adapter ? '未连接' : '尚未选择网卡', 'connection-status' + (adapter?.up && !state.demo ? ' up' : ''));
    control.append(select, status);
    const addresses = element('div', null, 'port-addresses');
    for (const [name, value] of [['IPv4', asArray(adapter?.addresses).join(', ') || '暂无地址'], ['网关', settings[role + '_gateway'] || adapter?.gateway || '未发现网关']]) {
      const line = element('div', null, 'address-line'); const text = element('strong', value); text.title = value;
      line.append(element('span', name), text); addresses.append(line);
    }
    card.append(roleBlock, control, addresses); $('ports').append(card);
  }
}

function renderRules() {
  const query = $('search').value.trim().toLowerCase();
  const type = $('typeFilter').value;
  const rules = asArray(state.config.rules);
  const shown = rules.filter((rule) => (!type || rule.type === type) && `${rule.target} ${rule.remark || ''}`.toLowerCase().includes(query));
  $('ruleCount').textContent = rules.length;
  $('enabledCount').textContent = rules.filter((rule) => rule.enabled).length.toString().padStart(2, '0');
  $('ruleRows').replaceChildren();
  for (const rule of shown) {
    const row = element('tr', null, rule.enabled ? '' : 'rule-disabled');
    const target = element('td', rule.target, 'target');
    target.title = rule.target;
    const resolution = state.resolutions?.[rule.id];
    if (rule.type === 'Domain' && resolution) {
      const detail = resolution.error ? `${resolution.stale ? '保留上次结果 · ' : ''}${message(resolution.error)}` : asArray(resolution.addresses).join(' · ');
      const text = element('small', detail, `resolution${resolution.stale || resolution.error ? ' stale' : ''}`);
      text.title = `最近检查：${time(resolution.checkedAt)}`;
      target.append(text);
    }
    const typeCell = element('td'); typeCell.append(element('span', types[rule.type] || rule.type, 'type-pill'));
    const exit = element('td'); const badge = element('span', networkName(rule.network), `route-pill ${rule.network}`); badge.title = networkName(rule.network); exit.append(badge);
    const remark = element('td', rule.remark || '—', 'remark'); remark.title = rule.remark || '';
    const enabledCell = element('td');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.className = 'switch'; enabled.checked = Boolean(rule.enabled);
    enabled.setAttribute('aria-label', `启用规则 ${rule.target}`); enabled.dataset.busyControl = 'true'; enabled.disabled = busy;
    enabled.addEventListener('change', () => {
      const checked = enabled.checked;
      void action(async () => {
        const config = clone(state.config);
        config.rules.find((item) => item.id === rule.id).enabled = checked;
        try { await saveConfig(config); } catch (error) { renderRules(); throw error; }
      });
    });
    enabledCell.append(enabled);
    const operations = element('td'); const buttons = element('div', null, 'row-actions');
    const edit = element('button', '编辑', 'quiet'); edit.dataset.busyControl = 'true'; edit.disabled = busy;
    edit.addEventListener('click', () => openRule(rule));
    const remove = element('button', '删除', 'quiet danger-text'); remove.dataset.busyControl = 'true'; remove.disabled = busy;
    remove.addEventListener('click', () => confirm('删除这条规则？', `将从配置中移除 ${rule.target}。已应用的路由在下次应用时才会更新。`, '删除规则', async () => {
      const config = clone(state.config);
      config.rules = config.rules.filter((item) => item.id !== rule.id);
      await saveConfig(config, '规则已删除，应用后更新系统');
    }));
    buttons.append(edit, remove); operations.append(buttons);
    row.append(target, typeCell, exit, remark, enabledCell, operations); $('ruleRows').append(row);
  }
  $('emptyRules').hidden = shown.length > 0;
  $('emptyRules').querySelector('h3').textContent = rules.length ? '没有找到匹配的规则' : '从第一条分流规则开始';
  $('emptyRules').querySelector('p').textContent = rules.length ? '试试其他关键词，或切换规则类型。' : '添加公司业务的域名、IP 或网段，指定它的出口。';
  $('filterCount').textContent = `显示 ${shown.length} 条，共 ${rules.length} 条 · ${rules.filter((rule) => rule.enabled).length} 条启用`;
}
function buildSettings() {
  if (settingsDirty) return;
  const settings = state.config.settings;
  $('networkSettings').replaceChildren();
  for (const role of ['external', 'internal']) {
    const card = element('div', null, `port settings-port ${role}`);
    const heading = element('h2', null, 'settings-network-title'); heading.append(portIcon(null, role), element('span', networkName(role))); card.append(heading);
    const nameField = element('label', null, 'field'); nameField.append(element('span', '出口名称'));
    const nameInput = document.createElement('input'); nameInput.id = `${role}Label`; nameInput.value = networkName(role); nameInput.maxLength = 24; nameInput.placeholder = role === 'external' ? '例如：公司 B 外网' : '例如：日照港专网'; nameInput.dataset.busyControl = 'true'; nameInput.disabled = busy;
    nameField.append(nameInput, element('small', role === 'external' ? '此出口负责默认公网流量；改名立即生效，不需要重新应用路由。' : '此出口负责匹配规则的流量；改名立即生效，不需要重新应用路由。')); card.append(nameField);
    const nicField = element('label', null, 'field'); nicField.append(element('span', '网卡'));
    const nic = document.createElement('select'); nic.id = `${role}Nic`; nic.dataset.busyControl = 'true'; nic.disabled = busy;
    fillNicSelect(nic, settings[`${role}_nic_id`], settings[`${role}_nic_name`]); nicField.append(nic); card.append(nicField);
    for (const [suffix, title, value, placeholder] of [
      ['Gateway', '手动网关（选填）', settings[`${role}_gateway`] || '', nicFor(role)?.gateway || '自动使用网卡网关'],
      ['Dns', '此网络的专属 DNS（选填）', asArray(settings[`${role}_dns`]).join(', '), asArray(nicFor(role)?.dns).join(', ') || '自动使用网卡 DNS'],
    ]) {
      const label = element('label', null, 'field'); label.append(element('span', title));
      const input = document.createElement('input'); input.id = `${role}${suffix}`; input.value = value; input.placeholder = placeholder; input.autocomplete = 'off'; input.dataset.busyControl = 'true'; input.disabled = busy;
      label.append(input);
      if (suffix === 'Dns') {
        const guide = element('small'); guide.id = `${role}DnsGuide`;
        guide.textContent = `留空自动读取网卡 DNS（当前：${asArray(nicFor(role)?.dns).join('、') || '未发现'}）。填写后仅用于此出口的域名规则；多个地址用逗号或空格隔开。`;
        label.append(guide);
      }
      card.append(label);
    }
    nic.addEventListener('change', () => {
      const selected = adapterList().find(a => a.id === nic.value);
      $(`${role}Gateway`).value = ''; $(`${role}Dns`).value = '';
      $(`${role}Gateway`).placeholder = selected?.gateway || '自动使用网卡网关';
      $(`${role}Dns`).placeholder = asArray(selected?.dns).join(', ') || '自动使用网卡 DNS';
      $(`${role}DnsGuide`).textContent = `留空使用当前网卡 DNS：${asArray(selected?.dns).join('、') || '未发现，请手动填写'}；只影响走此出口的域名规则。`;
    });
    $('networkSettings').append(card);
  }
  $('autoSync').checked = Boolean(settings.auto_sync);
  $('syncInterval').value = settings.auto_sync_interval_mins || 10;
  $('startup').checked = Boolean(state.startup);
  $('settingsDirty').textContent = '设置已同步';
}
function renderLogs() {
  const logs = asArray(state.logs);
  $('logList').replaceChildren();
  for (const entry of [...logs].reverse()) {
    const row = element('li');
    const label = { info: '记录', success: '完成', warning: '提示', error: '失败' }[entry.level] || '记录';
    row.append(element('time', time(entry.time), 'log-time'), element('span', label, `log-level ${entry.level || ''}`), element('span', entry.message || '', 'log-message'));
    $('logList').append(row);
  }
  $('emptyLogs').hidden = logs.length > 0;
  $('lastResult').textContent = state.lastResult ? `最近结果：${state.lastResult.status === 'reset' ? '已恢复工具管理的设置' : '规则已应用'} · ${time(state.lastResult.at)}` : '所有操作仅在本机执行';
}
function render() {
  const recovery = state.system?.recoveryRequired;
  const admin = state.system?.admin;
  $('modeBadge').textContent = state.demo ? '演练模式 · 不改系统' : admin ? '管理员模式' : '只读模式';
  $('modeBadge').classList.toggle('demo', Boolean(state.demo));
  const notices = [];
  if (!state.demo && !admin) notices.push('当前未获得管理员权限。可维护与预览配置；应用和恢复需从管理员入口启动。');
  if (recovery) notices.push('存在未完成的事务恢复。请先检查操作记录并恢复系统设置，再应用新配置。');
  if (state.maintenanceSuspended && !recovery) notices.push('上次应用或恢复未完成，自动维护已暂停。请重新预览应用或恢复系统设置。');
  $('notice').textContent = notices.join(' '); $('notice').hidden = !notices.length;
  $('elevateButton').hidden = Boolean(state.demo || admin);
  const applied = state.policyApplied ?? (state.applied && state.appliedRevision === state.revision);
  $('saveState').textContent = applied ? '当前配置已应用' : '配置已保存 · 有待应用的更改';
  $('saveIndicator').classList.toggle('pending', !applied);
  $('syncState').textContent = state.config.settings.auto_sync ? `自动同步已启用${state.nextSyncAt ? ` · 下次 ${time(state.nextSyncAt)}` : ''} · 仅维护已应用配置` : '自动同步未启用 · 修改配置后，预览并应用才会生效';
  renderPorts(); renderRules(); buildSettings(); renderLogs(); updateAvailability();
  for (const option of $('ruleNetwork').options) option.textContent = networkName(option.value);
}
function showDialog(dialog) {
  lastFocus = document.activeElement;
  dialog.showModal();
  const focus = dialog.querySelector('input:not([type=checkbox]),select,button');
  requestAnimationFrame(() => focus?.focus());
}
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => { if (!busy) dialog.close(); }));
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { lastFocus?.focus(); });
});
function updateRuleHint() {
  const type = $('ruleType').value;
  $('ruleTarget').placeholder = { Auto: '直接粘贴浏览器网址，或输入 IP / 网段', Domain: '例如 https://oa.company.com:8080/login', SingleIP: '例如 129.0.8.134，或粘贴它的网址', CIDR: '例如 172.18.28.X 或 172.18.28.0/24' }[type];
  $('targetHint').textContent = { Auto: '不用先选类型，网址会自动提取 IP 或域名；端口、路径和参数会忽略。', Domain: '支持完整网址和复制的链接，自动提取域名；不支持 *.域名。', SingleIP: '支持单个 IP，以及包含 IP 的完整网址。', CIDR: 'X / * 表示整段，例如 172.18.28.X → 172.18.28.0/24；只能连续放在末尾。' }[type];
  scheduleRulePreview();
}
let rulePreviewTimer, rulePreviewVersion = 0;
function scheduleRulePreview() {
  clearTimeout(rulePreviewTimer);
  const version = ++rulePreviewVersion, value = $('ruleTarget').value.trim();
  const box = $('targetPreview');
  if (!value) { box.hidden = true; return; }
  box.hidden = false; box.className = 'target-preview'; box.textContent = '正在识别地址…';
  rulePreviewTimer = setTimeout(async () => {
    try {
      const normalized = await api('/api/normalize', 'POST', { target: value });
      if (version !== rulePreviewVersion) return;
      box.replaceChildren(element('strong', `${types[normalized.type]} · ${normalized.target}`), element('span', normalized.explanation));
      const role = $('ruleNetwork').value, nic = nicFor(role);
      const custom = state.config.settings[`${role}_dns`] || [];
      const dns = custom.length ? custom : nic?.dns || [];
      box.append(element('span', normalized.type === 'Domain' ? `${networkName(role)} DNS：${dns.length ? dns.join('、') : '尚未配置，请到网络设置填写'}${custom.length ? '（自定义）' : '（网卡自动提供）'}` : 'IP / 网段直接分流，无需 DNS 解析。'));
    } catch (error) {
      if (version !== rulePreviewVersion) return;
      box.className = 'target-preview invalid'; box.textContent = error.message;
    }
  }, 180);
}
function openRule(rule) {
  editingRuleId = rule?.id || null;
  $('ruleTitle').textContent = rule ? '编辑分流规则' : '添加分流规则';
  $('ruleType').value = rule?.type || 'Auto'; $('ruleTarget').value = rule?.target || '';
  $('ruleNetwork').value = rule?.network || 'internal'; $('ruleRemark').value = rule?.remark || '';
  $('ruleEnabled').checked = rule ? Boolean(rule.enabled) : true;
  $('ruleError').textContent = ''; updateRuleHint(); showDialog($('ruleDialog'));
  requestAnimationFrame(() => $('ruleTarget').focus());
}
function confirm(title, description, button, handler) {
  confirmHandler = handler;
  $('confirmTitle').textContent = title; $('confirmDescription').textContent = description;
  $('confirmAction').textContent = button; $('confirmError').textContent = ''; showDialog($('confirmDialog'));
}
function resourceText(resource) {
  if (typeof resource === 'string') return resource;
  if (!resource) return '—';
  const spec = resource.after || resource.before || resource;
  const key = spec.key && typeof spec.key === 'object' ? spec.key : spec;
  const nic = adapterList().find(a => a.index === key.interfaceIndex || a.id === key.interfaceId);
  if (spec.host) return `${spec.host} → DNS ${asArray(spec.servers).join(', ')}`;
  if (key.interfaceIndex && !key.prefix) return `${nic?.name || '所选网卡'} · 接口跃点 ${spec.metric}`;
  const prefix = key.prefix || key.destination || key.destinationPrefix || spec.target || spec.namespace;
  if (prefix) return `${prefix}${key.nextHop || key.gateway ? ` → ${key.gateway === '0.0.0.0' ? '直连' : key.nextHop || key.gateway}` : ''}${nic ? ` · ${nic.name}` : ''}${spec.persistent != null ? ` · ${spec.persistent ? '重启保留' : '活动路由'}` : ''}`;
  return '系统网络设置';
}
function renderPreview(plan) {
  $('confirmApply').textContent = state.demo || state.system?.admin ? '确认应用' : '提权后重新预览';
  const content = $('previewContent'); content.replaceChildren();
  if (state.demo) content.append(element('p', '演练预览：以下变更不会写入真实系统。', 'preview-warning'));
  const changes = plan.changes || {};
  const stats = element('div', null, 'preview-stats');
  for (const [key, title] of [['add', '新增'], ['remove', '撤销'], ['keep', '保持']]) stats.append(element('span', `${title} ${asArray(changes[key]).length} 项`));
  content.append(stats);
  for (const warning of asArray(plan.warnings)) content.append(element('p', message(warning), 'preview-warning'));
  if (plan.blocked) content.append(element('p', `暂不能应用：${message(plan.blocked)}`, 'form-error'));
  for (const [key, title] of [['add', '将新增'], ['remove', '将撤销'], ['keep', '保持不变']]) {
    const items = asArray(changes[key]); if (!items.length) continue;
    const section = element('section', null, 'preview-section'); section.append(element('h3', title));
    const list = element('ul', null, 'preview-list'); items.forEach((item) => list.append(element('li', resourceText(item), key)));
    section.append(list); content.append(section);
  }
  for (const [key, title] of [['routes', '路由目标'], ['nrpt', '系统域名解析'], ['metrics', '接口跃点']]) {
    const items = asArray(plan[key]); if (!items.length) continue;
    const section = element('section', null, 'preview-section'); section.append(element('h3', `${title} · ${items.length}`));
    const list = element('ul', null, 'preview-list'); items.forEach((item) => list.append(element('li', resourceText(item)))); section.append(list); content.append(section);
  }
  const resolutions = Object.entries(plan.resolutions || {});
  if (resolutions.length) {
    const section = element('section', null, 'preview-section'); section.append(element('h3', '域名解析结果'));
    const list = element('ul', null, 'preview-list');
    for (const [id, resolution] of resolutions) {
      const target = state.config.rules.find((rule) => rule.id === id)?.target || resolution.host || id;
      const answer = resolution.error ? message(resolution.error) : asArray(resolution.addresses).join(', ') || '待建立 DNS 路径后解析';
      list.append(element('li', `${target} → ${answer}${resolution.stale ? ' · 上次成功结果' : ''}`));
    }
    section.append(list); content.append(section);
  }
  if (![...content.children].some((node) => node.classList.contains('preview-section')) && !plan.blocked) content.append(element('p', '没有需要修改的资源，系统将核验当前状态。', 'muted'));
}

document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((tab) => { const selected = tab === button; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); });
  $('currentSection').textContent = { rules: '分流规则', settings: '网络设置', logs: '操作记录' }[button.dataset.tab];
  for (const tab of ['rules', 'settings', 'logs']) $(`${tab}Panel`).hidden = tab !== button.dataset.tab;
}));
$('search').addEventListener('input', () => { if (state) renderRules(); });
$('typeFilter').addEventListener('change', () => { if (state) renderRules(); });
$('addRule').addEventListener('click', () => openRule());
$('exitButton').addEventListener('click', () => {
  const closeManagement = async () => {
    await api('/api/exit', 'POST', {});
    sessionEnded = true;
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    $('closedView').hidden = false;
    $('closedView').setAttribute('tabindex', '-1'); $('closedView').focus();
    setTimeout(() => window.close(), 350);
  };
  if (settingsDirty) confirm('退出并放弃未保存设置？', '尚未保存的网络设置将被放弃。已应用的分流继续生效；启用后台维护后，由计划任务定期更新。', '退出管理', closeManagement);
  else void action(closeManagement);
});
$('elevateButton').addEventListener('click', () => { void action(async () => {
  await api('/api/elevate', 'POST', {});
  toast('请在 Windows 提示中允许提权。允许后会打开新页面；取消后可继续编辑。');
}); });
$('ruleType').addEventListener('change', updateRuleHint);
$('ruleTarget').addEventListener('input', () => {
  $('ruleError').textContent = ''; scheduleRulePreview();
});
$('ruleNetwork').addEventListener('change', scheduleRulePreview);
const autoOption = element('option', '自动识别（推荐）'); autoOption.value = 'Auto'; $('ruleType').prepend(autoOption);
const targetPreview = element('div', null, 'target-preview'); targetPreview.id = 'targetPreview'; targetPreview.hidden = true; targetPreview.setAttribute('role', 'status'); $('targetHint').after(targetPreview);
const samples = element('div', null, 'input-samples'); samples.append(element('span', '试填一个：'));
for (const [label, value] of [['IP 网址', 'http://129.0.8.134:7001/console/console.portal?_nfpb=true&_pageLabel=CoreServerServerTablePage'], ['域名网址', 'https://oa.company.com:8080/login'], ['整段 IP', '172.18.28.X'], ['单个 IP', '10.20.1.55']]) {
  const button = element('button', label, 'quiet'); button.type = 'button';
  button.addEventListener('click', () => { $('ruleTarget').value = value; $('ruleType').value = 'Auto'; updateRuleHint(); $('ruleTarget').focus(); }); samples.append(button);
}
targetPreview.after(samples);
$('ruleForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const rule = { id: editingRuleId || crypto.randomUUID(), type: $('ruleType').value, target: $('ruleTarget').value.trim(), network: $('ruleNetwork').value, remark: $('ruleRemark').value.trim(), enabled: $('ruleEnabled').checked };
  $('ruleError').textContent = '';
  if (!rule.target) { $('ruleError').textContent = '请输入目标地址。'; $('ruleTarget').focus(); return; }
  void action(async () => {
    const config = clone(state.config); const index = config.rules.findIndex((item) => item.id === rule.id);
    if (index < 0) config.rules.push(rule); else config.rules[index] = rule;
    await saveConfig(config); $('ruleDialog').close();
  }, 'ruleError');
});
$('confirmAction').addEventListener('click', () => { void action(async () => { await confirmHandler(); $('confirmDialog').close(); }, 'confirmError'); });
$('refreshButton').addEventListener('click', () => { void action(async () => { applyState(await api('/api/refresh', 'POST', {})); toast('网卡状态已刷新'); }); });
$('previewButton').addEventListener('click', () => { void action(async () => {
  if (settingsDirty) { toast('网络设置有未保存的更改，请先保存设置。', true); return; }
  activePlan = await api('/api/preview', 'POST', {}); renderPreview(activePlan); $('previewError').textContent = ''; showDialog($('previewDialog'));
}); });
$('confirmApply').addEventListener('click', () => { void action(async () => {
  if (!activePlan || activePlan.blocked) return;
  if (!state.demo && !state.system?.admin) {
    await api('/api/elevate', 'POST', {});
    toast('请允许 Windows 提权；新窗口打开后，重新预览并确认应用。');
    return;
  }
  applyState(await api('/api/apply', 'POST', { planId: activePlan.id })); activePlan = null; $('previewDialog').close();
  toast(state.demo ? '演练应用完成，真实系统未改变' : '规则应用完成，请查看操作记录');
}, 'previewError'); });
$('resetButton').addEventListener('click', () => confirm('恢复工具修改的系统设置？', '仅撤销本工具拥有且未被其他程序修改的路由、DNS 分流和接口跃点，并保留你的规则配置。已有系统与用户路由不会被清空。', '确认恢复', async () => {
  applyState(await api('/api/reset', 'POST', {})); activePlan = null; toast(state.demo ? '演练恢复完成，真实系统未改变' : '恢复操作完成，请查看结果记录');
}));
function markSettingsDirty(event) {
  if (event.target.id === 'startup') return;
  settingsDirty = true; $('settingsDirty').textContent = '有未保存的网络设置';
}
$('settingsForm').addEventListener('input', markSettingsDirty);
$('settingsForm').addEventListener('change', markSettingsDirty);
$('settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const config = clone(state.config); const settings = config.settings;
  for (const role of ['external', 'internal']) {
    settings[`${role}_label`] = $(`${role}Label`).value.trim();
    const id = $(`${role}Nic`).value; const adapter = adapterList().find((item) => item.id === id);
    settings[`${role}_nic_id`] = id; settings[`${role}_nic_name`] = adapter?.name || '';
    settings[`${role}_gateway`] = $(`${role}Gateway`).value.trim();
    settings[`${role}_dns`] = $(`${role}Dns`).value.split(/[\s,，;；]+/).filter(Boolean);
  }
  settings.auto_sync = $('autoSync').checked; settings.auto_sync_interval_mins = Number($('syncInterval').value);
  void action(async () => {
    const next = await api('/api/config', 'PUT', { config, revision: state.revision });
    settingsDirty = false; activePlan = null; applyState(next); toast('名称已同步；网络参数修改需预览并应用后生效');
  });
});
$('startup').addEventListener('change', () => {
  const enabled = $('startup').checked;
  void action(async () => {
    try { applyState(await api('/api/startup', 'POST', { enabled })); toast(enabled ? '后台自动维护已开启，无需管理界面常驻' : '后台自动维护已关闭'); }
    catch (error) { $('startup').checked = Boolean(state.startup); throw error; }
  });
});
$('exportButton').addEventListener('click', () => { void action(async () => {
  const config = await api('/api/export'); const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'dual-net-config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('配置已导出');
}); });
$('importButton').addEventListener('click', () => { $('importFile').value = ''; $('importFile').click(); });
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0]; if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('配置文件过大，请选择 2 MB 以内的 JSON 文件。', true); return; }
  let config;
  try { config = JSON.parse(await file.text()); } catch { toast('无法读取配置，请选择有效的 JSON 文件。', true); return; }
  confirm('导入并替换当前配置？', `将使用 ${file.name} 替换规则与网络设置。导入只保存配置，不修改系统路由。`, '确认导入', async () => {
    const next = await api('/api/import', 'POST', { config, revision: state.revision }); settingsDirty = false; activePlan = null; applyState(next); toast('配置已导入，预览并应用后生效');
  });
});
updateAvailability();
void action(async () => { applyState(await api('/api/state')); });
setInterval(() => {
  if (busy || sessionEnded || document.querySelector('dialog[open]') || document.hidden) return;
  // Preserve all unsaved settings fields; periodic inspection never applies configuration.
  void action(async () => { applyState(await api('/api/state')); });
}, 15000);
