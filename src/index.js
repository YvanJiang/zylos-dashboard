#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthGate } from './lib/auth.js';
import { browserBaseFromRequest } from './lib/browser-base.js';
import { ensureDataDirs, loadConfig, publicDir } from './lib/config.js';
import { sendHtml, sendJson, sendText, serveStatic } from './lib/http.js';
import { Store } from './lib/store.js';
import { Sanitizer } from './lib/sanitizer.js';
import { IngestHandler } from './lib/ingest-handler.js';
import { SpoolDrainer } from './lib/spool-drainer.js';
import { PM2Collector } from './lib/collectors/pm2-collector.js';
import { SystemCollector } from './lib/collectors/system-collector.js';
import { OTelCollector } from './lib/collectors/otel-collector.js';
import { StateEngine } from './lib/state-engine.js';
import { MetricResolver } from './lib/metric-resolver.js';
import { SseHub } from './lib/sse.js';

const startedAt = new Date();
const config = loadConfig();
ensureDataDirs(config);

const auth = new AuthGate(config);

// 1-2. Store
const dbPath = path.join(config.dataDir, 'dashboard.db');
const store = new Store(dbPath);

// 3. Sanitizer
const sanitizer = new Sanitizer(config.zylosDir);

// 4. Spool drain (DB-only, before state engine)
const spoolDrainer = new SpoolDrainer(store, sanitizer, config);
const spoolResult = spoolDrainer.drainToDb();
if (spoolResult.processed > 0) {
  process.stderr.write(`[startup] Drained ${spoolResult.processed} spool events to DB\n`);
}

// 5-6. Collectors
const pm2Collector = new PM2Collector(store, config);
const systemCollector = new SystemCollector(store, config);
const otelCollector = new OTelCollector(store, config);

const collectors = { pm2: pm2Collector, system: systemCollector, otel: otelCollector };

// SSE hub
const sse = new SseHub(15_000);

// 7. State engine
const stateEngine = new StateEngine(store, collectors, config, {
  onStateChange: (state) => sse.broadcast('state_change', state)
});

// Wire collector updates to state engine
pm2Collector._onUpdate = (data) => stateEngine.onPM2Update(data);
systemCollector._onUpdate = (data) => stateEngine.onSystemUpdate(data);

// 8. Metric resolver
const metricResolver = new MetricResolver(store, collectors, config);

// 9. Ingest handler (with state engine reference)
const ingestHandler = new IngestHandler(store, sanitizer, stateEngine, config);

async function startupSequence() {
  // Initial collector runs
  try { await pm2Collector.collect(); } catch (err) {
    process.stderr.write(`[startup] PM2 collector initial run failed: ${err.message}\n`);
  }
  try { await systemCollector.collect(); } catch (err) {
    process.stderr.write(`[startup] System collector initial run failed: ${err.message}\n`);
  }
  try { await otelCollector.collect(); } catch (err) {
    process.stderr.write(`[startup] OTel collector initial run failed: ${err.message}\n`);
  }

  // State engine initialize (snapshot restore + replay)
  await stateEngine.initialize();
}

function handleApi(req, res, pathname, url) {
  if (pathname === '/api/health') {
    const sourceHealth = stateEngine.getSourceHealth();
    sendJson(res, 200, {
      ok: true,
      service: 'zylos-dashboard',
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      phase: 'phase2a',
      source: sourceHealth
    });
    return true;
  }

  if (pathname === '/api/state') {
    sendJson(res, 200, stateEngine.getState());
    return true;
  }

  if (pathname === '/api/timeline') {
    const since = url.searchParams.get('since') || undefined;
    const until = url.searchParams.get('until') || undefined;
    const types = url.searchParams.get('types')?.split(',').filter(Boolean) || undefined;
    const sessionId = url.searchParams.get('session_id') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const events = store.queryEvents({ since, until, types, sessionId, limit, offset });
    sendJson(res, 200, { events, count: events.length });
    return true;
  }

  if (pathname === '/api/system') {
    const pm2Data = pm2Collector.getLatestPM2Data();
    const sysData = systemCollector.getLatestSystemData();
    sendJson(res, 200, {
      pm2: pm2Data ? pm2Data.processes : null,
      system: sysData || null,
      collected_at: {
        pm2: pm2Data ? new Date(pm2Data.collectedAt).toISOString() : null,
        system: sysData ? new Date(sysData.collectedAt).toISOString() : null
      }
    });
    return true;
  }

  if (pathname.startsWith('/api/metrics/')) {
    const metricName = pathname.slice('/api/metrics/'.length);
    if (!metricName) {
      sendJson(res, 400, { error: 'missing metric name' });
      return true;
    }
    const result = metricResolver.resolve(metricName);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/stream') {
    sse.addClient(res);
    return true;
  }

  return false;
}

export function createServer() {
  const rootDir = publicDir();

  function renderIndex(req, res) {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    sendHtml(res, 200, html);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    let pathname = url.pathname;

    // /api/ingest must be checked before any base-path stripping or auth
    if (pathname === '/api/ingest' && req.method === 'POST') {
      await ingestHandler.handle(req, res);
      return;
    }

    // Reject ingest under base-path prefix
    const prefix = req.headers['x-forwarded-prefix'];
    if (prefix && pathname.startsWith(prefix + '/api/ingest')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (await auth.handle(req, res, url)) {
      return;
    }

    if (pathname === '/api/stream') {
      handleApi(req, res, pathname, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed');
      return;
    }

    if (pathname.startsWith('/api/')) {
      const handled = handleApi(req, res, pathname, url);
      if (!handled && !res.headersSent) sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      renderIndex(req, res);
      return;
    }

    if (!serveStatic(req, res, rootDir)) {
      sendText(res, 404, 'not found');
    }
  });
}

const isMain = (
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  (process.env.pm_exec_path && import.meta.url === pathToFileURL(process.env.pm_exec_path).href)
);

if (isMain && process.argv.includes('--smoke')) {
  await startupSequence();
  console.log(JSON.stringify({
    ok: true,
    port: config.port,
    host: config.host,
    phase: 'phase2a',
    db: dbPath,
    spoolDrained: spoolResult.processed,
    state: stateEngine.getState().state
  }, null, 2));
  store.close();
} else if (isMain) {
  await startupSequence();

  const server = createServer();
  server.on('error', (err) => {
    console.error(`zylos-dashboard failed to start: ${err.message}`);
    process.exitCode = 1;
  });

  // Start periodic collectors
  pm2Collector.start(15_000);
  systemCollector.start(30_000);
  otelCollector.start(10_000);

  // Start snapshot timer
  stateEngine.startSnapshotTimer();

  // Start periodic spool drain (live mode with state engine)
  spoolDrainer.startPeriodicDrain(stateEngine, 30_000);

  // Retention cleanup timer (hourly)
  const retentionTimer = setInterval(() => {
    try {
      store.deleteEventsOlderThan(30);
      store.deleteMetricsOlderThan(90);
      store.deleteFactsOlderThan(365);
    } catch (err) {
      process.stderr.write(`[retention] Error: ${err.message}\n`);
    }
  }, 60 * 60 * 1000);
  retentionTimer.unref();

  server.listen(config.port, config.host, () => {
    console.log(`zylos-dashboard listening on http://${config.host}:${config.port}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      pm2Collector.stop();
      systemCollector.stop();
      otelCollector.stop();
      stateEngine.stopSnapshotTimer();
      spoolDrainer.stopPeriodicDrain();
      sse.closeAll();
      server.close(() => {
        store.close();
        process.exit(0);
      });
    });
  }
}
