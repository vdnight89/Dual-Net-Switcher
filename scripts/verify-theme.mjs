// Optional development verification for the dual-theme UI.
// Isolated demo servers + Edge; never touches the real system.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { start } from '../server.mjs';

const require = createRequire(import.meta.url);
const packagePath = process.env.DUAL_NET_PLAYWRIGHT || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { chromium } = require(packagePath);
const output = new URL('../docs/evidence/theme/', import.meta.url);
await mkdir(output, { recursive: true });
const png = (name) => new URL(name, output).pathname.replace(/^\/(\w:)/, '$1');
const themeTokens = {
  dark: { accent: '#4c8dff', topbar: 'rgb(26, 31, 40)', body: 'rgb(20, 23, 30)' },
  light: { accent: '#2160e8', topbar: 'rgb(255, 255, 255)', body: 'rgb(242, 244, 248)' },
};
const computed = (page) => page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  topbar: getComputedStyle(document.querySelector('.topbar')).backgroundColor,
  body: getComputedStyle(document.body).backgroundColor,
  toggleLabel: document.querySelector('#themeToggle').textContent.trim(),
}));
function assertTheme(actual, expected, where) {
  const want = themeTokens[expected];
  assert.equal(actual.theme, expected, `${where}: data-theme`);
  assert.equal(actual.accent, want.accent, `${where}: --accent variable`);
  assert.equal(actual.topbar, want.topbar, `${where}: topbar surface`);
  assert.equal(actual.body, want.body, `${where}: body background`);
  assert.equal(actual.toggleLabel, expected === 'dark' ? '浅色' : '深色', `${where}: toggle label offers the other theme`);
}
const overflowProbe = (page) => page.evaluate(() => ({
  root: document.documentElement.scrollWidth,
  width: innerWidth,
  offenders: [...document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width && r.right > innerWidth + 1 && !e.closest('.table-scroll') && !e.closest('dialog');
  }).map((e) => ({ tag: e.tagName, class: e.className, right: e.getBoundingClientRect().right })),
}));

const directoryA = await mkdtemp(join(tmpdir(), 'dualnet-theme-a-'));
const directoryB = await mkdtemp(join(tmpdir(), 'dualnet-theme-b-'));
const appA = await start({ demo: true, dataDir: directoryA, port: 0, openBrowser: false });
const appB = await start({ demo: true, dataDir: directoryB, port: 0, openBrowser: false });
const browserServer = await chromium.launchServer({ channel: 'msedge', headless: true });
const browser = await chromium.connect(browserServer.wsEndpoint());
const checks = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(appA.url);
  await page.waitForFunction(() => document.querySelectorAll('#ruleRows tr').length === 5);
  await page.waitForFunction(() => [...document.querySelectorAll('.network-emblem, .brand-icon img, .device-glyph img')].every((img) => img.complete && img.naturalWidth > 0));

  // 1. Fresh profile defaults to the dark theme and uses its tokens.
  assertTheme(await computed(page), 'dark', 'fresh load');
  await page.screenshot({ path: png('dark-desktop.png'), animations: 'disabled' });
  const stateBefore = { revision: appA.manager.state().revision, policyApplied: appA.manager.state().policyApplied, config: JSON.stringify(appA.manager.config) };
  checks.push('default-dark');

  // 2. The toggle switches the theme immediately, including inside dialogs.
  await page.click('#themeToggle');
  assertTheme(await computed(page), 'light', 'after toggle');
  await page.click('#addRule');
  await page.waitForSelector('#ruleDialog[open]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#ruleDialog')).backgroundColor), 'rgb(255, 255, 255)', 'rule dialog follows the light theme');
  await page.screenshot({ path: png('light-rule-dialog.png'), animations: 'disabled' });
  await page.click('#ruleDialog .close-dialog');
  await page.waitForFunction(() => !document.querySelector('#ruleDialog').open);
  await page.screenshot({ path: png('light-desktop.png'), animations: 'disabled' });
  const stateAfter = { revision: appA.manager.state().revision, policyApplied: appA.manager.state().policyApplied, config: JSON.stringify(appA.manager.config) };
  assert.deepEqual(stateAfter, stateBefore, 'switching themes must not touch configuration or applied state');
  checks.push('instant-toggle-dialog');

  // 3. A reload keeps the choice (cookie).
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#ruleRows tr').length === 5);
  assertTheme(await computed(page), 'light', 'after reload');
  checks.push('reload-remembers');

  // 4. A second server on another port reads the same host-only preference.
  await page.goto(appB.url);
  await page.waitForFunction(() => document.querySelectorAll('#ruleRows tr').length === 5);
  assertTheme(await computed(page), 'light', 'second port');
  checks.push('cross-port-memory');

  // 5. Long exit names must not overflow the cards.
  await page.click('[data-tab=settings]');
  await page.fill('#externalLabel', '公司主出口名称很长很长二十四字节');
  await page.fill('#internalLabel', '专用内网出口名称也很长二十四字节整');
  await page.screenshot({ path: png('light-settings.png'), animations: 'disabled' });
  await page.click('#settingsForm button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#settingsDirty').textContent.includes('同步'));
  await page.click('[data-tab=rules]');
  await page.waitForFunction(() => document.querySelector('#ports').textContent.includes('公司主出口名称很长很长二十四字节'));
  await page.screenshot({ path: png('light-long-names.png'), animations: 'disabled' });
  checks.push('long-names');

  // 6. Empty search result, preview dialog and logs in the light theme.
  await page.fill('#search', '不存在的关键词');
  await page.waitForSelector('#emptyRules:not([hidden])');
  await page.screenshot({ path: png('light-empty-rules.png'), animations: 'disabled' });
  await page.fill('#search', '');
  await page.click('#previewButton');
  await page.waitForSelector('#previewDialog[open]');
  await page.screenshot({ path: png('light-preview.png'), animations: 'disabled' });
  await page.click('#previewDialog .close-dialog');
  await page.waitForFunction(() => !document.querySelector('#previewDialog').open);
  await page.click('[data-tab=logs]');
  await page.screenshot({ path: png('light-logs.png'), animations: 'disabled' });
  checks.push('light-surfaces');

  // 7. Compact PC size: both themes, no page-level horizontal overflow.
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.click('[data-tab=rules]');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((next) => { document.querySelector('#themeToggle').click(); return document.documentElement.dataset.theme; }, theme);
    const probe = await overflowProbe(page);
    assert.ok(probe.root <= probe.width, `${theme} 1100px overflow: ${JSON.stringify(probe)}`);
    await page.screenshot({ path: png(`compact-${theme}.png`), fullPage: true, animations: 'disabled' });
  }
  checks.push('compact-both-themes');

  // 8. A blocked storage area must not prevent startup; cookie preference still applies.
  const context2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await context2.newPage();
  page2.setDefaultTimeout(15_000);
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(e.message));
  await page2.addInitScript(() => {
    document.cookie = 'dualnetTheme=light; Path=/; SameSite=Strict';
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
  });
  await page2.goto(appA.url);
  await page2.waitForFunction(() => document.querySelectorAll('#ruleRows tr').length === 5);
  assertTheme(await computed(page2), 'light', 'blocked storage');
  await page2.click('#themeToggle');
  assertTheme(await computed(page2), 'dark', 'blocked storage toggle');
  assert.deepEqual(errors2, [], 'blocked storage must not raise page errors');
  await context2.close();
  checks.push('blocked-storage-startup');

  // 9. The closed view is a themed full-screen state (DOM-only; no real exit is requested).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.querySelector('#themeToggle').click(); });
  await page.evaluate(() => { document.querySelector('#closedView').hidden = false; });
  await page.screenshot({ path: png('dark-closed.png'), animations: 'disabled' });
  await page.evaluate(() => { document.querySelector('#closedView').hidden = true; });
  checks.push('closed-view');

  // 10. No page errors anywhere in the main pass.
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  await context.close();
  checks.push('no-page-errors');
  console.log(`Theme verification passed: ${checks.join(', ')}`);
  await writeFile(new URL('results.json', output), JSON.stringify({ status: 'passed', checks }, null, 2));
} catch (error) {
  console.error('Theme verification failure:', error);
  await writeFile(new URL('results.json', output), JSON.stringify({ status: 'failed', error: String(error) }, null, 2)).catch(() => {});
  throw error;
} finally {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(browserServer.process().pid), '/T', '/F'], { windowsHide: true });
  else await browserServer.kill();
  appA.server.closeAllConnections();
  appB.server.closeAllConnections();
  await appA.close();
  await appB.close();
  await rm(directoryA, { recursive: true, force: true });
  await rm(directoryB, { recursive: true, force: true });
}
process.exit(0);
