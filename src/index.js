#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthGate } from './lib/auth.js';
import { browserBaseFromRequest } from './lib/browser-base.js';
import { ensureDataDirs, loadConfig, publicDir } from './lib/config.js';
import { sendHtml, sendJson, sendText, serveStatic } from './lib/http.js';

const startedAt = new Date();
const config = loadConfig();
ensureDataDirs(config);
const auth = new AuthGate(config);

function handleApi(req, res, pathname) {
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'zylos-dashboard',
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      phase: 'phase2a-pending'
    });
    return true;
  }

  return false;
}

export function createServer() {
  const rootDir = publicDir();

  function renderIndex(req, res) {
    const browserBase = browserBaseFromRequest(req);
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    sendHtml(res, 200, html);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (await auth.handle(req, res, url)) {
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed');
      return;
    }

    if (pathname.startsWith('/api/')) {
      const handled = handleApi(req, res, pathname);
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
  console.log(JSON.stringify({
    ok: true,
    port: config.port,
    host: config.host,
    phase: 'phase2a-pending'
  }, null, 2));
} else if (isMain) {
  const server = createServer();
  server.on('error', (err) => {
    console.error(`zylos-dashboard failed to start: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`zylos-dashboard listening on http://${config.host}:${config.port}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}
