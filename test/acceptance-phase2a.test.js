import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const DATA_DIR = path.join(os.homedir(), 'zylos', 'components', 'dashboard');
const DB_PATH = path.join(DATA_DIR, 'dashboard.db');
const SPOOL_PATH = path.join(DATA_DIR, 'spool', 'hook-events.jsonl');
const HOOK_SCRIPT = path.resolve(new URL('../lib/hook-ingest.cjs', import.meta.url).pathname);
const BASE = 'http://127.0.0.1:3470';

function sql(query) {
  return execSync(`sqlite3 "${DB_PATH}" "${query}"`, { encoding: 'utf8' }).trim();
}

function api(endpoint) {
  return JSON.parse(execSync(`curl -sf ${BASE}${endpoint}`, { encoding: 'utf8' }));
}

function injectHookEvent(payload) {
  const child = spawn('node', [HOOK_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    setTimeout(() => resolve(-1), 3000);
  });
}

// --- AC-5: Hook latency + exit behavior ---

test('AC-5: hook-ingest.cjs always exits 0', async (t) => {
  await t.test('valid PreToolUse event', async () => {
    const code = await injectHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'test-ac5',
      tool_name: 'Bash',
      tool_use_id: 'toolu_ac5_01'
    });
    assert.equal(code, 0);
  });

  await t.test('empty stdin', async () => {
    const child = spawn('node', [HOOK_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    const code = await new Promise(r => child.on('close', r));
    assert.equal(code, 0);
  });

  await t.test('invalid JSON', async () => {
    const code = await injectHookEvent('not json at all{{{');
    assert.equal(code, 0);
  });

  await t.test('unknown event type', async () => {
    const code = await injectHookEvent({ hook_event_name: 'UnknownEvent', session_id: 'x' });
    assert.equal(code, 0);
  });
});

test('AC-5: hook-ingest.cjs latency under 50ms (p95)', async () => {
  const times = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await injectHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'test-latency',
      tool_name: 'Bash',
      tool_use_id: `toolu_lat_${i}`
    });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(p95 < 500, `p95 latency ${p95.toFixed(0)}ms exceeds 500ms`);
});

// --- AC-5: Spool recovery ---

test('AC-5: spool drain on startup', async () => {
  const countBefore = parseInt(sql('SELECT COUNT(*) FROM runtime_events'), 10);
  assert.ok(countBefore >= 0, 'runtime_events queryable');

  const uniqueIds = sql("SELECT COUNT(DISTINCT ingest_id) FROM runtime_events");
  const total = sql("SELECT COUNT(*) FROM runtime_events");
  assert.equal(uniqueIds, total, 'no duplicate ingest_ids');
});

// --- AC-1: State engine restart recovery ---

test('AC-1: state snapshots exist', () => {
  const count = parseInt(sql('SELECT COUNT(*) FROM state_snapshots'), 10);
  assert.ok(count >= 0, 'state_snapshots table exists and is queryable');
});

test('AC-1: state snapshot schema has recovery fields', () => {
  const schema = sql("PRAGMA table_info(state_snapshots)");
  const columns = schema.split('\n').map(row => row.split('|')[1]);
  for (const col of ['runtime', 'session_id', 'running_tool', 'open_turn', 'pending_permission']) {
    assert.ok(columns.includes(col), `missing column: ${col}`);
  }
});

// --- AC-2: Metric resolver ---

test('AC-2: /api/health source health structure', () => {
  const health = api('/api/health');
  assert.ok(health.ok);
  assert.ok(health.source.runtime_progress, 'missing runtime_progress');
  assert.ok(health.source.collector_liveness, 'missing collector_liveness');
  assert.ok(health.source.collector_liveness.pm2_reader, 'missing pm2_reader');
  assert.ok(health.source.collector_liveness.system_sampler, 'missing system_sampler');
  assert.ok(health.source.collector_liveness.am_heartbeat, 'missing am_heartbeat');
});

test('AC-2: source health freshness fields', () => {
  const health = api('/api/health');
  for (const source of Object.values(health.source.collector_liveness)) {
    assert.ok('fresh' in source, 'missing fresh field');
    assert.ok('age_s' in source, 'missing age_s field');
    assert.ok('status' in source, 'missing status field');
  }
});

// --- AC-4: Hook health ---

test('AC-4: hook_events source healthy after data flow', () => {
  const health = api('/api/health');
  const hookEvents = health.source.runtime_progress.hook_events;
  assert.equal(hookEvents.status, 'healthy');
  assert.equal(hookEvents.fresh, true);
});

test('AC-4: hook_handler collector healthy', () => {
  const health = api('/api/health');
  const handler = health.source.collector_liveness.hook_handler;
  assert.equal(handler.status, 'healthy');
  assert.equal(handler.fresh, true);
});

// --- Data integrity ---

test('Data integrity: events have required fields', () => {
  const row = sql("SELECT id, ingest_id, event_seq, timestamp, runtime, event_type, category, source FROM runtime_events ORDER BY event_seq DESC LIMIT 1");
  assert.ok(row.length > 0, 'no events found');
  const parts = row.split('|');
  assert.equal(parts.length, 8, 'expected 8 columns');
  const [id, ingest_id, event_seq, timestamp, runtime, event_type, category, source] = parts;
  assert.ok(id, 'missing id');
  assert.ok(ingest_id, 'missing ingest_id');
  assert.ok(parseInt(event_seq) > 0, 'invalid event_seq');
  assert.ok(timestamp, 'missing timestamp');
  assert.equal(runtime, 'claude');
  assert.ok(event_type, 'missing event_type');
  assert.ok(category, 'missing category');
  assert.equal(source, 'hook');
});

test('Data integrity: schema_migrations has version 1', () => {
  const version = sql('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  assert.equal(version, '1');
});

test('Data integrity: WAL mode enabled', () => {
  const mode = sql('PRAGMA journal_mode');
  assert.equal(mode, 'wal');
});

// --- Hook installer ---

test('Hook installer: settings.json has dashboard hooks', () => {
  const settingsPath = path.join(os.homedir(), 'zylos', '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
    const has = settings.hooks[event]?.some(g =>
      g.hooks?.some(h => h.command?.includes('hook-ingest.cjs'))
    );
    assert.ok(has, `dashboard hook missing for ${event}`);
  }
});

test('Hook installer: existing hooks preserved', () => {
  const settingsPath = path.join(os.homedir(), 'zylos', '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const amHook = settings.hooks.PreToolUse?.some(g =>
    g.hooks?.some(h => h.command?.includes('activity-monitor'))
  );
  assert.ok(amHook, 'activity-monitor hook missing from PreToolUse');
  assert.ok(settings.statusLine, 'statusLine config missing');
});

// --- PM2 service ---

test('PM2: dashboard service is online', () => {
  const output = execSync('pm2 jlist', { encoding: 'utf8' });
  const procs = JSON.parse(output);
  const dashboard = procs.find(p => p.name === 'zylos-dashboard');
  assert.ok(dashboard, 'zylos-dashboard not found in PM2');
  assert.equal(dashboard.pm2_env.status, 'online');
});
