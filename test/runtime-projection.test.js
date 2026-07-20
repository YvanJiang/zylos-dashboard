import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeProjectionPublisher } from '../src/lib/runtime-projection.js';
import { completeSnapshot } from './helpers/runtime-snapshot-fixture.js';

test('RuntimeProjectionPublisher derives a complete read-only v1 projection from an accepted full Core snapshot', () => {
  const publisher = new RuntimeProjectionPublisher({ dashboardInstanceId: 'dashboard-A' });
  const result = publisher.publish(completeSnapshot({ instance: 'core-A', version: 8 }), { status: 'initial', apply: true });

  assert.deepEqual(result, { status: 'published', apply: true });
  assert.deepEqual(publisher.get(), {
    contract: 'zylos.dashboard-runtime-projection',
    contract_version: '1.0',
    projection_id: 'projection-dashboard-A-1',
    dashboard_instance_id: 'dashboard-A',
    projection_sequence: 1,
    generated_at: '2026-07-20T00:00:00Z',
    source_core_service_instance_id: 'core-A',
    source_snapshot_version: 8,
    service: {
      health: 'healthy',
      maintenance: false,
      reconciling: false,
      last_update_at: '2026-07-20T00:00:00Z',
    },
    runtimes: [{
      runtime_id: 'runtime-conversation-A',
      conversation_id: 'conversation-A',
      display_label: 'Conversation conversation-A',
      provider: 'claude',
      executor_health: 'healthy',
      active_turn_state: 'recovering',
      queue_length: 2,
      wait_reason: 'interaction_delivery_unknown',
      side_effect_status: 'unknown',
      last_changed_at: '2026-07-20T00:00:00Z',
    }],
    capabilities: {
      supported_fields: ['service', 'runtimes', 'queue_length', 'wait_reason', 'side_effect_status'],
      supported_states: ['received', 'queued', 'starting', 'running', 'waiting_user', 'redirecting', 'recovering', 'completed', 'stopped', 'cancelled', 'interrupted', 'failed', 'timed_out'],
      control: false,
      core_direct_access: false,
    },
    complete: true,
    error: null,
  });
});

test('RuntimeProjectionPublisher continuously sequences accepted replacements and does not emit for duplicate, obsolete, or conflict source updates', () => {
  const publisher = new RuntimeProjectionPublisher({ dashboardInstanceId: 'dashboard-A' });
  publisher.publish(completeSnapshot({ version: 1 }), { status: 'initial', apply: true });
  publisher.publish(completeSnapshot({ version: 2 }), { status: 'replace', apply: true });
  assert.equal(publisher.get().projection_sequence, 2);

  for (const status of ['duplicate', 'obsolete', 'conflict']) {
    assert.deepEqual(
      publisher.publish(completeSnapshot({ version: 2 }), { status, apply: false }),
      { status: `source_${status}`, apply: false },
    );
    assert.equal(publisher.get().projection_sequence, 2);
  }
});

test('RuntimeProjectionPublisher retains Dashboard sequencing across a Core instance change', () => {
  const publisher = new RuntimeProjectionPublisher({ dashboardInstanceId: 'dashboard-A' });
  publisher.publish(completeSnapshot({ instance: 'core-A', version: 9 }), { status: 'initial', apply: true });
  publisher.publish(completeSnapshot({ instance: 'core-B', version: 1 }), { status: 'replace_instance', apply: true });

  assert.equal(publisher.get().dashboard_instance_id, 'dashboard-A');
  assert.equal(publisher.get().projection_sequence, 2);
  assert.equal(publisher.get().source_core_service_instance_id, 'core-B');
  assert.equal(publisher.get().source_snapshot_version, 1);
});

test('RuntimeProjectionPublisher makes degraded Core snapshots explicit without making missing state look idle', () => {
  const publisher = new RuntimeProjectionPublisher({ dashboardInstanceId: 'dashboard-A' });
  const degraded = completeSnapshot({ version: 3 });
  degraded.executors = { complete: false, items: [], error: { code: 'unavailable' } };
  degraded.error = { code: 'observability_degraded' };

  publisher.publish(degraded, { status: 'initial_degraded', apply: false, requires_full: true });
  const projection = publisher.get();
  assert.equal(projection.complete, false);
  assert.deepEqual(projection.error, {
    code: 'observability_degraded',
    category: 'storage',
    retryable: true,
    side_effect_status: 'unknown',
    user_message: 'Runtime observability is incomplete; unavailable state is not idle.',
    detail_ref: 'diagnostic:projection-dashboard-A-1',
    occurred_at: '2026-07-20T00:00:00Z',
  });
  assert.equal(projection.runtimes.length, 0);
});

test('RuntimeProjectionPublisher has a new instance and restarts sequence at one on Dashboard restart', () => {
  const first = new RuntimeProjectionPublisher({ dashboardInstanceId: 'dashboard-A' });
  first.publish(completeSnapshot({ version: 9 }), { status: 'initial', apply: true });
  const restarted = new RuntimeProjectionPublisher({ dashboardInstanceId: 'dashboard-B' });
  restarted.publish(completeSnapshot({ version: 1 }), { status: 'initial', apply: true });

  assert.equal(restarted.get().dashboard_instance_id, 'dashboard-B');
  assert.equal(restarted.get().projection_sequence, 1);
});

test('RuntimeProjectionPublisher exposes no provider-native identity, PID, lease, capability, secret, or Core access detail', () => {
  const publisher = new RuntimeProjectionPublisher({ dashboardInstanceId: 'dashboard-A' });
  const snapshot = completeSnapshot();
  snapshot.executors.items[0].lease.owner = 'secret-owner';
  snapshot.executors.items[0].runtime_identity.pid = 9999;
  snapshot.executors.items[0].provider_native_id = 'native-session';
  publisher.publish(snapshot, { status: 'initial', apply: true });

  const text = JSON.stringify(publisher.get());
  assert.doesNotMatch(text, /native-session|secret-owner|9999|runtime_identity|provider_native_id|lease|workspace_root|"control":true|"core_direct_access":true/i);
  assert.equal(publisher.get().capabilities.control, false);
  assert.equal(publisher.get().capabilities.core_direct_access, false);
});
