import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/lib/store.js';

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
  const dbPath = path.join(dir, 'test.db');
  const store = new Store(dbPath);
  return { store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

test('Store saveSnapshot/latestSnapshot round-trip includes last_progress_at', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const now = new Date().toISOString();
    store.saveSnapshot({
      runtime: 'claude',
      session_id: 'test-session',
      running_tool: JSON.stringify({ tools: {} }),
      open_turn: null,
      pending_permission: null,
      possibly_stuck_since: null,
      last_progress_cursor: 42,
      last_message: null,
      last_prompt: null,
      last_progress_at: now
    });

    const snapshot = store.latestSnapshot('claude', 'test-session');
    assert.ok(snapshot, 'snapshot should exist');
    assert.equal(snapshot.last_progress_at, now);
    assert.equal(snapshot.last_progress_cursor, 42);
  } finally {
    cleanup();
  }
});

test('Store saveSnapshot works with null last_progress_at', () => {
  const { store, cleanup } = makeTempStore();
  try {
    store.saveSnapshot({
      runtime: 'claude',
      session_id: null,
      running_tool: null,
      open_turn: null,
      pending_permission: null,
      possibly_stuck_since: null,
      last_progress_cursor: 0,
      last_message: null,
      last_prompt: null,
      last_progress_at: null
    });

    const snapshot = store.latestSnapshot('claude', null);
    assert.ok(snapshot, 'snapshot should exist');
    assert.equal(snapshot.last_progress_at, null);
  } finally {
    cleanup();
  }
});

test('Store applies shorter retention to high-volume PM2 and system metrics by source', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const points = [
      { metric_name: 'pm2_cpu', source: 'pm2', timestamp: daysAgo(10) },
      { metric_name: 'pm2_cpu', source: 'pm2', timestamp: daysAgo(2) },
      { metric_name: 'cpu_pct', source: 'system', timestamp: daysAgo(20) },
      { metric_name: 'cpu_pct', source: 'system', timestamp: daysAgo(10) },
      { metric_name: 'api_request_tokens', source: 'jsonl_usage', timestamp: daysAgo(20) },
      { metric_name: 'api_request_tokens', source: 'jsonl_usage', timestamp: daysAgo(100) }
    ];

    for (const point of points) {
      store.insertMetric({
        timestamp: point.timestamp,
        runtime: 'codex',
        metric_name: point.metric_name,
        metric_value: 1,
        source: point.source,
        confidence: 'actual'
      });
    }

    store.deleteMetricsOlderThanBySource('pm2', 7);
    store.deleteMetricsOlderThanBySource('system', 14);

    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM metric_points WHERE source = 'pm2'").get().c, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM metric_points WHERE source = 'system'").get().c, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM metric_points WHERE source = 'jsonl_usage'").get().c, 2);

    store.deleteMetricsOlderThan(90);

    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM metric_points WHERE source = 'jsonl_usage'").get().c, 1);
  } finally {
    cleanup();
  }
});
