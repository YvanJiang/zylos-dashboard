import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeSnapshotConsumer } from '../src/lib/runtime-snapshot.js';
import { completeSnapshot } from './helpers/runtime-snapshot-fixture.js';

test('RuntimeSnapshotConsumer applies a complete v1 snapshot as a whole replace', () => {
  const consumer = new RuntimeSnapshotConsumer();
  const snapshot = completeSnapshot();
  const result = consumer.apply(snapshot);
  assert.deepEqual(result, { status: 'initial', apply: true });
  assert.deepEqual(consumer.get().snapshot, snapshot);
  assert.equal(consumer.get().snapshot.executors.items[0].queue_length, 2);
  const publicView = consumer.getPublic();
  assert.equal(publicView.snapshot.executors.items[0].runtime_identity, undefined);
  assert.equal(publicView.snapshot.executors.items[0].provider_native_id, undefined);
});

test('RuntimeSnapshotConsumer applies monotonically newer snapshots, ignores duplicates and obsolete snapshots, and rejects conflicts', () => {
  const consumer = new RuntimeSnapshotConsumer();
  consumer.apply(completeSnapshot({ version: 2 }));
  assert.deepEqual(consumer.apply(completeSnapshot({ version: 2 })), { status: 'duplicate', apply: false });
  assert.deepEqual(consumer.apply(completeSnapshot({ version: 1 })), { status: 'obsolete', apply: false });
  const conflict = completeSnapshot({ version: 2 });
  conflict.service.health = 'degraded';
  assert.deepEqual(consumer.apply(conflict), { status: 'conflict', apply: false });
  assert.equal(consumer.get().snapshot.service.health, 'healthy');
});

test('RuntimeSnapshotConsumer replaces its snapshot when a complete Core service instance restarts', () => {
  const consumer = new RuntimeSnapshotConsumer();
  consumer.apply(completeSnapshot({ instance: 'core-A', version: 9 }));
  const replacement = completeSnapshot({ instance: 'core-B', version: 1 });
  replacement.executors.items = [];
  assert.deepEqual(consumer.apply(replacement), { status: 'replace_instance', apply: true });
  assert.equal(consumer.get().snapshot.core_service_instance_id, 'core-B');
  assert.deepEqual(consumer.get().snapshot.executors.items, []);
});

test('RuntimeSnapshotConsumer exposes degraded collections but never accepts an initial partial snapshot or a partial replacement instance', () => {
  const consumer = new RuntimeSnapshotConsumer();
  const degraded = completeSnapshot();
  degraded.outbox = { complete: false, items: [], retry_count: 0, dead_letter_count: 0, error: { code: 'unavailable' } };
  degraded.error = { code: 'observability_degraded' };
  assert.deepEqual(consumer.apply(degraded), { status: 'initial_degraded', apply: false, requires_full: true });
  consumer.apply(completeSnapshot({ instance: 'core-A', version: 1 }));
  degraded.snapshot_version = 2;
  assert.deepEqual(consumer.apply(degraded), { status: 'replace', apply: true });
  assert.equal(consumer.get().snapshot.outbox.complete, false);
  const replacement = structuredClone(degraded);
  replacement.core_service_instance_id = 'core-B';
  replacement.service.service_instance_id = 'core-B';
  replacement.snapshot_version = 1;
  assert.deepEqual(consumer.apply(replacement), { status: 'replace_instance_degraded', apply: false, requires_full: true });
});

test('RuntimeSnapshotConsumer rejects unsupported contract majors and secret/private payloads before retaining them', () => {
  const consumer = new RuntimeSnapshotConsumer();
  const unsupported = completeSnapshot();
  unsupported.contract_version = '2.0';
  assert.throws(() => consumer.apply(unsupported), { code: 'unsupported_contract_version' });
  const secret = completeSnapshot();
  secret.turns.items[0].provider_payload = { token: 'zylos_ak_not_allowed' };
  assert.throws(() => consumer.apply(secret), { code: 'unsafe_snapshot' });
  assert.equal(consumer.get().snapshot, null);
});
