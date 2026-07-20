import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { derivePrimaryRuntimeState, renderRuntimeObservability } from '../public/js/runtime-observability.js';
import { completeSnapshot } from './helpers/runtime-snapshot-fixture.js';

test('runtime observability view exposes canonical execution, queue, interaction, workspace, outbox and recovery details without PID or native IDs', () => {
  const html = renderRuntimeObservability({ snapshot: completeSnapshot(), update: { status: 'initial', apply: true } });
  assert.match(html, /recovering/);
  assert.match(html, /Queue position: 2/);
  assert.match(html, /interaction_delivery_unknown/);
  assert.match(html, /Retries: 1/);
  assert.match(html, /Side effect: unknown/);
  assert.match(html, /delivery_unknown/);
  assert.match(html, /dead_letter/);
  assert.match(html, /\/workspace\/A/);
  assert.doesNotMatch(html, /4242|pid|pgid|provider_native_id/i);
});

test('runtime observability view marks partial collections unavailable and unknown state unknown, never idle', () => {
  const snapshot = completeSnapshot();
  snapshot.executors.items[0].health = 'future-state';
  snapshot.outbox = { complete: false, items: [], retry_count: 0, dead_letter_count: 0, error: { code: 'unavailable' } };
  snapshot.error = { code: 'observability_degraded' };
  const html = renderRuntimeObservability({ snapshot, update: { status: 'replace', apply: true } });
  assert.match(html, /Unknown \(future-state\)/);
  assert.match(html, /Outbox.*Unavailable/);
  assert.doesNotMatch(html, /idle/i);
});

test('runtime observability does not infer service health from a partial service section', () => {
  const snapshot = completeSnapshot();
  snapshot.service.complete = false;
  snapshot.service.error = { code: 'service_unavailable' };
  snapshot.error = { code: 'observability_degraded' };
  const html = renderRuntimeObservability({ snapshot, update: { status: 'replace', apply: true } });
  assert.match(html, /Core service unavailable/);
  assert.doesNotMatch(html, /Core service: healthy/);
});

test('primary runtime state is Core-authoritative and never derives idle or running from missing or partial snapshots', () => {
  assert.deepEqual(derivePrimaryRuntimeState(null), { state: 'UNKNOWN', reason: 'Core runtime snapshot unavailable or partial.', available: false });
  const partial = completeSnapshot();
  partial.outbox.complete = false;
  partial.outbox.error = { code: 'unavailable' };
  partial.error = { code: 'observability_degraded' };
  assert.equal(derivePrimaryRuntimeState({ snapshot: partial }).state, 'UNKNOWN');
  const running = completeSnapshot();
  running.turns.items[0].state = 'running';
  assert.equal(derivePrimaryRuntimeState({ snapshot: running }).state, 'BUSY');
  const idle = completeSnapshot();
  idle.turns.items = [];
  idle.executors.items[0].active_turn_id = null;
  idle.executors.items[0].queue_length = 0;
  assert.equal(derivePrimaryRuntimeState({ snapshot: idle }).state, 'IDLE');
});

test('Dashboard has no legacy terminal-multiplexer control path that can define runtime state or stop work', () => {
  const actions = fs.readFileSync(path.resolve('src/lib/actions.js'), 'utf8');
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.doesNotMatch(actions, new RegExp(['tm', 'ux'].join(''), 'i'));
  assert.doesNotMatch(actions, /restart-session/);
  assert.doesNotMatch(app, /restart-session/);
});

test('Dashboard wires the public Core snapshot view into state refresh and SSE without a Core direct connection', () => {
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(index, /runtimeSnapshotConsumer\.getPublic\(\)/);
  assert.match(index, /sse\.broadcast\('runtime_snapshot', payload\)/);
  assert.doesNotMatch(index, /zylos-core|core\.db|runtime\.db/);
  assert.match(app, /state\.runtimeSnapshot = data\.runtime_snapshot \|\| null;/);
  assert.match(app, /renderRuntimeObservabilityPanel\(\);/);
  assert.match(app, /'runtime_snapshot'/);
  assert.match(app, /derivePrimaryRuntimeState\(state\.runtimeSnapshot\)/);
  assert.match(app, /state\.runtimeSnapshot = data;\s*renderState\(\);\s*renderRuntimeObservabilityPanel\(\);/);
  assert.match(app, /const localDetails = primary\.available/);
});

test('Dashboard publishes the versioned Luna runtime projection through the existing snapshot and SSE seams', () => {
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  assert.match(index, /RuntimeProjectionPublisher/);
  assert.match(index, /runtimeProjectionPublisher\.publish\(snapshot, update\)/);
  assert.match(index, /sse\.broadcast\('runtime_projection', projection\)/);
  assert.match(index, /eventType: 'runtime_projection'/);
  assert.match(index, /if \(!projection \|\| !projection\.complete\)/);
  assert.match(index, /runtime_projection_unavailable/);
  assert.doesNotMatch(index, /zylos-core|core\.db|runtime\.db/);
});
