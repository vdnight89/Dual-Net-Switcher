import { start, runMaintenance } from '../server.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataDir = await mkdtemp(join(tmpdir(), 'dualnet-measure-'));
const began = performance.now();
let app;
try {
  const idleStart = performance.now();
  const skipped = await runMaintenance({ dataDir });
  const inactiveWakeMs = performance.now() - idleStart;
  app = await start({ dataDir, port: 0, openBrowser: false });
  global.gc?.();
  const report = { measuredAt: new Date().toISOString(), scope: 'Node management process only; browser and transient PowerShell excluded; real Windows read-only discovery', startupMs: Math.round(performance.now() - began), memoryBytes: process.memoryUsage(), adapters: app.manager.system.adapters.length, inactiveMaintenanceWakeMs: Math.round(inactiveWakeMs * 100) / 100, inactiveMaintenanceSkipped: skipped.skipped };
  await writeFile(new URL('../docs/evidence/performance.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { if (app) { app.server.closeAllConnections(); await app.close(); } await rm(dataDir, { recursive: true, force: true }); }
