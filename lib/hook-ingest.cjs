#!/usr/bin/env node
// Standalone hook ingest script — invoked by Claude Code hooks.
// No imports from src/. Only Node built-ins. Must exit within 500ms.
'use strict';

setTimeout(() => process.exit(0), 500);

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest'
]);

const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 3470;
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(require('node:os').homedir(), 'zylos');
const SPOOL_DIR = path.join(ZYLOS_DIR, 'components', 'dashboard', 'spool');
const SPOOL_PATH = path.join(SPOOL_DIR, 'hook-events.jsonl');
const SPOOL_MAX_BYTES = Number(process.env.DASHBOARD_SPOOL_MAX_BYTES) || 10 * 1024 * 1024;

async function main() {
  const stdin = await readStdin();
  if (!stdin) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(stdin);
  } catch {
    process.exit(0);
  }

  const hook_event_name = payload.hook_event_name || payload.event;
  if (!hook_event_name || !ALLOWED_EVENTS.has(hook_event_name)) {
    process.exit(0);
  }

  const ingest_id = randomUUID();
  const received_at = new Date().toISOString();
  const runtime = process.env.ZYLOS_RUNTIME || 'claude';

  const body = JSON.stringify({
    ingest_id,
    hook_event_name,
    received_at,
    runtime,
    ...payload
  });

  const ok = await postToServer(body);
  if (!ok) {
    spool({ ingest_id, received_at, hook_event_name, runtime, data: payload });
  }

  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let timer = setTimeout(() => resolve(chunks.join('')), 200);

    process.stdin.on('data', (chunk) => {
      clearTimeout(timer);
      chunks.push(chunk.toString());
      timer = setTimeout(() => resolve(chunks.join('')), 50);
    });

    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(chunks.join(''));
    });

    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

async function postToServer(body) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 200);

    const resp = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal
    });

    clearTimeout(timeout);
    return resp.status === 200;
  } catch {
    return false;
  }
}

function spool(record) {
  try {
    if (!fs.existsSync(SPOOL_DIR)) {
      fs.mkdirSync(SPOOL_DIR, { recursive: true });
    }

    try {
      const stat = fs.statSync(SPOOL_PATH);
      if (stat.size > SPOOL_MAX_BYTES) return;
    } catch {
      // file doesn't exist yet — OK to write
    }

    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(SPOOL_PATH, line);
  } catch (err) {
    process.stderr.write(`[hook-ingest] spool error: ${err.message}\n`);
  }
}

try {
  main();
} catch {
  process.exit(0);
}
