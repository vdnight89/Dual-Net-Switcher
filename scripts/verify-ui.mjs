// Optional development verification. The application itself has no dependencies.
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
const output = new URL('../docs/evidence/flow/', import.meta.url);
await mkdir(output, { recursive: true });
const results = [];
for (let run = 1; run <= 3; run++) {
  const directory = await mkdtemp(join(tmpdir(), 'dualnet-ui-'));
  const app = await start({ demo: true, dataDir: directory, port: 0, openBrowser: false });
  const browserServer = await chromium.launchServer({ channel: 'msedge', headless: true });
  const browser = await chromium.connect(browserServer.wsEndpoint());
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelectorAll('#ruleRows tr').length === 5);
    await page.waitForFunction(() => document.querySelectorAll('.network-emblem').length === 4 && [...document.querySelectorAll('.network-emblem, .brand-icon img, .device-glyph img')].every(img => img.complete && img.naturalWidth > 0));
    console.log(`UI ${run}: loaded`);
    assert.equal(await page.evaluate(() => location.hash), '');
    await page.click('#addRule');
    assert.equal(await page.inputValue('#ruleType'), 'Auto');
    const pastedUrl = '[http://129.0.8.134:7001/console/console.portal?_nfpb=true&_pageLabel=CoreServerServerTablePage](http://129.0.8.134:7001/console/console.portal?_nfpb=true&_pageLabel=CoreServerServerTablePage)';
    await page.fill('#ruleTarget', pastedUrl);
    await page.waitForFunction(() => document.querySelector('#targetPreview').textContent.includes('单个 IP · 129.0.8.134'));
    if (run === 1) await page.screenshot({ path: new URL('smart-input.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
    await page.fill('#ruleTarget', '172.18.28.X');
    await page.waitForFunction(() => document.querySelector('#targetPreview').textContent.includes('172.18.28.0/24'));
    await page.fill('#ruleTarget', 'http://Portal.corp.internal:8080/path');
    await page.waitForFunction(() => document.querySelector('#targetPreview').textContent.includes('域名 · portal.corp.internal'));
    await page.fill('#ruleRemark', '验收规则');
    // A network save failure must preserve input and keep the editing surface open.
    await page.route('**/api/config', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '验收：保存失败' }) }), { times: 1 });
    await page.click('#ruleForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#ruleError').textContent.includes('保存失败'));
    assert.equal(await page.inputValue('#ruleTarget'), 'http://Portal.corp.internal:8080/path');
    await page.click('#ruleForm button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('#ruleDialog').open);
    console.log(`UI ${run}: save failure and retry passed`);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#ruleRows tr').length === 6);
    assert.ok((await page.locator('#ruleRows').innerText()).includes('portal.corp.internal'));
    await page.fill('#search', '验收规则');
    assert.equal(await page.locator('#ruleRows tr').count(), 1);
    await page.fill('#search', '');
    await page.click('#previewButton');
    await page.waitForSelector('#previewDialog[open]');
    console.log(`UI ${run}: preview opened`);
    assert.equal(app.manager.state().applied, false);
    if (run === 1) await page.screenshot({ path: new URL('preview.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
    await page.click('#confirmApply');
    await page.waitForFunction(() => !document.querySelector('#previewDialog').open);
    assert.equal(app.manager.state().applied, true);
    console.log(`UI ${run}: applied`);
    assert.ok(app.manager.platform.owned.routes.length > 0);
    await page.click('[data-tab=settings]');
    await page.fill('#externalLabel', '公司 B 外网');
    await page.fill('#internalLabel', '日照港专网');
    await page.click('#settingsForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#settingsDirty').textContent.includes('同步'));
    assert.equal(app.manager.state().policyApplied, true, 'renaming must not require reapplying system routes');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#ports').textContent.includes('日照港专网'));
    assert.ok((await page.locator('#ruleRows').innerText()).includes('公司 B 外网'));
    await page.click('#addRule');
    assert.ok((await page.locator('#ruleNetwork').innerText()).includes('日照港专网'));
    await page.locator('#ruleDialog .close-dialog').first().click();
    await page.click('[data-tab=settings]');
    await page.fill('#syncInterval', '12');
    await page.fill('#externalDns', '9.9.9.9, 1.1.1.1');
    await page.fill('#internalDns', '10.20.0.2');
    await page.click('#settingsForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#settingsDirty').textContent.includes('同步'));
    assert.equal(app.manager.config.settings.auto_sync_interval_mins, 12);
    assert.deepEqual(app.manager.config.settings.external_dns, ['9.9.9.9', '1.1.1.1']);
    assert.deepEqual(app.manager.config.settings.internal_dns, ['10.20.0.2']);
    console.log(`UI ${run}: settings saved`);
    if (run === 1) {
      await page.screenshot({ path: new URL('settings.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
      await page.click('[data-tab=logs]');
      await page.screenshot({ path: new URL('logs.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
    }
    await page.click('[data-tab=rules]');
    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportButton');
    assert.ok((await downloadPromise).suggestedFilename().endsWith('.json'));
    await page.click('#resetButton');
    await page.waitForSelector('#confirmDialog[open]');
    await page.click('#confirmAction');
    await page.waitForFunction(() => !document.querySelector('#confirmDialog').open);
    assert.equal(app.manager.state().applied, false);
    assert.equal(app.manager.platform.owned.routes.length, 0);
    assert.equal(app.manager.config.rules.length, 6);
    console.log(`UI ${run}: reset`);
    if (run === 1) {
      // A scroll affordance must expose the last rule, including in a short PC window.
      await page.waitForSelector('#scrollRules:not([hidden])');
      await page.click('#scrollRules');
      await page.waitForFunction(() => document.querySelector('#scrollRules').textContent.includes('返回顶部'));
      await page.click('#scrollRules');
      await page.waitForFunction(() => document.querySelector('.table-scroll').scrollTop < 1);
      await page.waitForFunction(() => document.querySelector('#toast').hidden);
      await page.screenshot({ path: new URL('desktop.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.locator('.row-actions button').first().click();
      await page.waitForSelector('#ruleDialog[open]');
      await page.locator('#ruleDialog .close-dialog').first().click();
      await page.screenshot({ path: new URL('compact-pc.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true, animations: 'disabled' });
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !e.closest('.table-scroll') && !e.closest('dialog'); }).map(e => ({ tag: e.tagName, class: e.className, text: e.textContent.slice(0,40), right: e.getBoundingClientRect().right })));
      const measurements = await page.evaluate(() => ({ width: innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(e => e.scrollWidth > e.clientWidth + 4).map(e => ({ tag: e.tagName, class: e.className, client: e.clientWidth, scroll: e.scrollWidth, overflow: getComputedStyle(e).overflowX, position: getComputedStyle(e).position, display: getComputedStyle(e).display })).slice(0,30) }));
      assert.ok(measurements.root <= measurements.width, JSON.stringify({overflow,measurements}));
    }
    assert.deepEqual(errors, []);
    results.push({ run, status: 'passed', checks: ['load', 'fragment-cleared', 'save-failure-preserves-input', 'URL-normalization', 'reload-persistence', 'search', 'preview-readonly', 'apply', 'settings', 'export', 'reset-preserves-config', 'no-page-errors'] });
    console.log(`UI verification ${run}/3 passed`);
  } catch (error) { console.error('UI failure:', error); throw error;
  } finally {
    // Edge in this host can hang its graceful protocol close after a download.
    // Terminate only the isolated browser process tree created by this test.
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(browserServer.process().pid), '/T', '/F'], { windowsHide: true });
    else await browserServer.kill();
    app.server.closeAllConnections();
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
}
await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2));
process.exit(0);
