import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OperationsControlClient,
  OperationsControlError,
  OperationsControlResultStore,
  validateOperationsControlResult,
} from '../src/lib/operations-control-client.js';

const STATUSES = ['accepted', 'completed', 'noop', 'conflict', 'forbidden', 'not_found', 'failed'];

function request() {
  return {
    contract: 'zylos.control-request',
    contract_version: '1.0',
    trace_id: 'trace-A',
    caller_namespace: 'dashboard.prod',
    control_id: 'control-A',
    action: 'reconcile',
    target: { aggregate_type: 'service', service_instance_id: 'service-A' },
    expected_version: { aggregate_type: 'service', aggregate_id: 'service-A', version: 3 },
    actor: { type: 'user', actor_id: 'operator-A', authenticated: true, roles: [], capabilities: [] },
    auth_context: { source: 'dashboard_session', auth_subject_id: 'operator-A', tenant_id: 'tenant-A', bot_id: null, authorization_policy_id: 'runtime-operations', authorization_policy_version: 7, authenticated_at: '2026-07-20T10:00:00Z' },
    reason: 'Register a reconciliation intent.',
    idempotency_key: 'zid:v1:control:a'.padEnd(79, '0'),
    created_at: '2026-07-20T10:00:00Z',
  };
}

function result(status, version = 1) {
  const success = ['accepted', 'completed', 'noop'].includes(status);
  return {
    contract: 'zylos.control-result',
    contract_version: '1.0',
    trace_id: 'trace-A',
    caller_namespace: 'dashboard.prod',
    control_id: 'control-A',
    control_result_version: version,
    status,
    target: { aggregate_type: 'service', service_instance_id: 'service-A' },
    previous_target_version: success ? 3 : null,
    target_version: success ? 4 : null,
    audit_id: 'audit-A',
    result: success ? { intent_id: 'intent-A', state: status === 'accepted' ? 'pending' : 'completed' } : null,
    error: success ? null : { code: `${status}_error`, category: status === 'forbidden' ? 'authorization' : 'conflict', retryable: false, side_effect_status: 'none', user_message: `${status} result`, occurred_at: '2026-07-20T10:00:01Z' },
    accepted_at: success ? '2026-07-20T10:00:01Z' : null,
    completed_at: status === 'accepted' ? null : '2026-07-20T10:00:01Z',
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('client preserves every Core status and result store observes asynchronous monotonic completion', async () => {
  for (const status of STATUSES) {
    let sent;
    const client = new OperationsControlClient({
      endpoint: 'https://core.test/v1/operations-controls',
      fetch: async (_url, init) => {
        sent = JSON.parse(init.body);
        return response(result(status));
      },
    });
    const received = await client.submit(request());
    assert.equal(received.status, status);
    assert.deepEqual(sent, request());
  }

  const store = new OperationsControlResultStore();
  assert.equal(store.apply(result('accepted', 1), { action: 'reconcile' }).status, 'applied');
  assert.equal(store.apply(result('accepted', 1), { action: 'reconcile' }).status, 'duplicate');
  assert.equal(store.apply(result('completed', 2), { action: 'reconcile' }).status, 'applied');
  assert.equal(store.get('dashboard.prod', 'control-A').status, 'completed');
  assert.throws(
    () => store.apply({ ...result('completed', 2), target_version: 5 }, { action: 'reconcile' }),
    (error) => error instanceof OperationsControlError && error.code === 'version_conflict',
  );
  assert.throws(
    () => store.apply(result('completed', 3), { action: 'reconcile' }),
    (error) => error instanceof OperationsControlError && error.code === 'version_conflict',
    'a terminal control result cannot advance again',
  );

  const identityStore = new OperationsControlResultStore();
  identityStore.apply(result('accepted', 1), { action: 'reconcile' });
  assert.throws(
    () => identityStore.apply({ ...result('completed', 2), trace_id: 'trace-B' }, { action: 'reconcile' }),
    (error) => error instanceof OperationsControlError && error.code === 'version_conflict',
    'asynchronous completion must preserve the accepted intent identity',
  );
});

test('client fails closed on transport, authentication, network, unknown status, and secret-bearing results', async () => {
  const cases = [
    [async () => response({ error: 'bad_gateway' }, 502), 'transport_failure'],
    [async () => response({ error: 'unauthorized' }, 401), 'authentication_failure'],
    [async () => { throw new Error('socket closed'); }, 'network_failure'],
    [async () => response({ ...result('completed'), status: 'unknown' }), 'invalid_control_result'],
    [async () => response({ ...result('completed'), secret: 'zylos_st_do_not_leak' }), 'unsafe_control_result'],
    [async () => response({ ...result('completed'), credentials: 'opaque' }), 'unsafe_control_result'],
    [async () => response({ ...result('completed'), privateKey: 'opaque' }), 'unsafe_control_result'],
    [async () => response({ ...result('completed'), raw_provider: {} }), 'unsafe_control_result'],
  ];
  for (const [fetch, code] of cases) {
    const client = new OperationsControlClient({ endpoint: 'https://core.test/control', fetch });
    await assert.rejects(
      () => client.submit(request()),
      (error) => error instanceof OperationsControlError && error.code === code,
      code,
    );
  }
});

test('validates the exact action target/result matrix and rejects cross-action display data', () => {
  const cases = [
    ['inspect', { aggregate_type: 'conversation', conversation_id: 'conversation-A' }, { snapshot: { aggregate_type: 'conversation' } }],
    ['stop_active_turn', { aggregate_type: 'turn', conversation_id: 'conversation-A', turn_id: 'turn-A' }, { winner: 'stop', active_turn_id: 'turn-A', active_turn_version: 4, priority_turn_created: false, priority_turn_cancelled: false }],
    ['clear_unstarted_queue', { aggregate_type: 'queue', conversation_id: 'conversation-A', through_queue_sequence: 8 }, { cleared_turn_ids: ['turn-B'], through_queue_sequence: 8 }],
    ['reconcile', { aggregate_type: 'service', service_instance_id: 'service-A' }, { intent_id: 'intent-A', state: 'completed' }],
    ['evict_idle_executor', { aggregate_type: 'executor', conversation_id: 'conversation-A', executor_instance_id: 'executor-A' }, { evicted: true, executor_instance_id: 'executor-A' }],
    ['confirm_recovery', { aggregate_type: 'recovery', recovery_id: 'recovery-A', conversation_id: 'conversation-A', turn_id: 'turn-A' }, { decision: 'confirmed', recovery_turn_id: 'turn-recovery-A' }],
    ['reject_recovery', { aggregate_type: 'recovery', recovery_id: 'recovery-A', conversation_id: 'conversation-A', turn_id: 'turn-A' }, { decision: 'rejected', recovery_turn_id: null }],
  ];
  for (const [action, target, actionResult] of cases) {
    const candidate = { ...result('completed'), target, result: actionResult };
    assert.equal(validateOperationsControlResult(candidate, { action }).status, 'completed');
  }
  assert.throws(
    () => validateOperationsControlResult({ ...result('completed'), result: { evicted: true, executor_instance_id: 'executor-A' } }, { action: 'reconcile' }),
    (error) => error instanceof OperationsControlError && error.code === 'invalid_control_result',
  );
  for (const malformed of [
    { ...result('completed'), completed_at: null },
    { ...result('completed'), audit_id: null },
    { ...result('completed'), result: { intent_id: 'intent-A', state: 'future' } },
    { ...result('completed'), target_version: '4' },
    { ...result('failed'), error: {} },
    { ...result('failed'), error: { ...result('failed').error, category: 'future' } },
    { ...result('failed'), error: { ...result('failed').error, retryable: 'no' } },
    { ...result('failed'), error: { ...result('failed').error, side_effect_status: 'maybe' } },
    { ...result('failed'), error: { ...result('failed').error, occurred_at: 'yesterday' } },
  ]) {
    assert.throws(
      () => validateOperationsControlResult(malformed, { action: 'reconcile' }),
      (error) => error instanceof OperationsControlError && error.code === 'invalid_control_result',
    );
  }
});

test('client polls the trusted Core resource without placing authority in query parameters', async () => {
  let observed;
  const client = new OperationsControlClient({
    endpoint: 'https://core.test/v1/operations-controls',
    fetch: async (url, init) => {
      observed = { url: String(url), init };
      return response(result('completed', 2));
    },
  });
  const received = await client.getResult('dashboard.prod', 'control-A');
  assert.equal(received.control_result_version, 2);
  assert.equal(observed.init.method, 'GET');
  assert.equal(observed.url, 'https://core.test/v1/operations-controls/dashboard.prod/control-A');
  assert.doesNotMatch(observed.url, /role|capability|scope|policy/i);
});

test('trusted transport endpoint rejects embedded credentials, query authority, and remote plaintext HTTP', () => {
  for (const endpoint of [
    'http://operator:secret@127.0.0.1/control',
    'http://127.0.0.1/control?role=admin',
    'http://core.example.test/control',
  ]) {
    assert.throws(
      () => new OperationsControlClient({ endpoint }),
      (error) => error instanceof OperationsControlError && error.code === 'invalid_transport',
    );
  }
  assert.doesNotThrow(() => new OperationsControlClient({ endpoint: 'https://core.example.test/control' }));
});
