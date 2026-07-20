import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OperationsAuthError,
  OperationsAuthorizationAdapter,
} from '../src/lib/operations-auth-adapter.js';

const NOW = '2026-07-20T10:00:00Z';

function conversationScope(conversationId = 'conversation-A') {
  return {
    scope_type: 'conversation',
    region: 'cn',
    tenant_id: 'tenant-A',
    bot_id: 'bot-A',
    conversation_id: conversationId,
    service_instance_id: null,
    recovery_id: null,
  };
}

function policy(overrides = {}) {
  return {
    policy_id: 'runtime-operations',
    policy_version: 7,
    state: 'active',
    grants: [{
      grant_id: 'grant-stop-A',
      subject: { type: 'user', subject_id: 'operator-A' },
      required_role: 'conversation-operator',
      capability: 'turn.stop',
      scope: conversationScope(),
      state: 'active',
      expires_at: '2026-07-20T11:00:00Z',
      policy_version: 7,
    }],
    ...overrides,
  };
}

function verifiedSubject(overrides = {}) {
  return {
    source: 'dashboard_session',
    type: 'user',
    subject_id: 'operator-A',
    roles: ['conversation-operator', 'tenant-admin'],
    authenticated_at: '2026-07-20T09:55:00Z',
    ...overrides,
  };
}

function stopInput(overrides = {}) {
  return {
    control_id: 'control-stop-A',
    action: 'stop_active_turn',
    target: { aggregate_type: 'turn', conversation_id: 'conversation-A', turn_id: 'turn-A' },
    expected_version: { aggregate_type: 'turn', aggregate_id: 'turn-A', version: 4 },
    reason: 'Stop the active turn selected from the Core snapshot.',
    ...overrides,
  };
}

test('deployment auth rejects client authority fields and emits only the current minimum policy grant', () => {
  const adapter = new OperationsAuthorizationAdapter({
    callerNamespace: 'dashboard.prod',
    policy: policy(),
    now: () => NOW,
    generateId: (kind) => `${kind}-A`,
  });

  for (const field of ['actor', 'auth_context', 'role', 'capability', 'scope', 'policy_version']) {
    assert.throws(
      () => adapter.createRequest(verifiedSubject(), stopInput({ [field]: 'forged' })),
      (error) => error instanceof OperationsAuthError && error.code === 'client_authority_forbidden',
      `${field} must not be accepted from the browser`,
    );
  }

  const request = adapter.createRequest(verifiedSubject(), stopInput());
  assert.equal(request.contract, 'zylos.control-request');
  assert.equal(request.contract_version, '1.0');
  assert.equal(request.caller_namespace, 'dashboard.prod');
  assert.deepEqual(request.actor, {
    type: 'user',
    actor_id: 'operator-A',
    authenticated: true,
    roles: ['conversation-operator', 'tenant-admin'],
    capabilities: [{
      capability: 'turn.stop',
      scope: conversationScope(),
      policy_id: 'runtime-operations',
      policy_version: 7,
      grant_id: 'grant-stop-A',
      expires_at: '2026-07-20T11:00:00Z',
    }],
  });
  assert.deepEqual(request.auth_context, {
    source: 'dashboard_session',
    auth_subject_id: 'operator-A',
    tenant_id: 'tenant-A',
    bot_id: 'bot-A',
    authorization_policy_id: 'runtime-operations',
    authorization_policy_version: 7,
    authenticated_at: '2026-07-20T09:55:00Z',
  });
  assert.match(request.idempotency_key, /^zid:v1:control:[0-9a-f]{64}$/);
});

test('maps all actions to exact capabilities and prefers the narrowest covering scope', () => {
  const actionCases = [
    ['inspect', 'runtime.inspect', { aggregate_type: 'conversation', conversation_id: 'conversation-A' }, null],
    ['stop_active_turn', 'turn.stop', { aggregate_type: 'turn', conversation_id: 'conversation-A', turn_id: 'turn-A' }, { aggregate_type: 'turn', aggregate_id: 'turn-A', version: 3 }],
    ['clear_unstarted_queue', 'queue.clear', { aggregate_type: 'queue', conversation_id: 'conversation-A', through_queue_sequence: 8 }, { aggregate_type: 'queue', aggregate_id: 'conversation-A', version: 3 }],
    ['reconcile', 'service.reconcile', { aggregate_type: 'service', service_instance_id: 'service-A' }, { aggregate_type: 'service', aggregate_id: 'service-A', version: 3 }],
    ['evict_idle_executor', 'executor.evict', { aggregate_type: 'executor', conversation_id: 'conversation-A', executor_instance_id: 'executor-A' }, { aggregate_type: 'executor', aggregate_id: 'executor-A', version: 3 }],
    ['confirm_recovery', 'recovery.decide', { aggregate_type: 'recovery', recovery_id: 'recovery-A', conversation_id: 'conversation-A', turn_id: 'turn-A' }, { aggregate_type: 'recovery', aggregate_id: 'recovery-A', version: 3 }],
    ['reject_recovery', 'recovery.decide', { aggregate_type: 'recovery', recovery_id: 'recovery-A', conversation_id: 'conversation-A', turn_id: 'turn-A' }, { aggregate_type: 'recovery', aggregate_id: 'recovery-A', version: 3 }],
  ];
  const grants = actionCases.flatMap(([action, capability], index) => {
    const narrowScope = action === 'reconcile'
      ? { ...conversationScope(), scope_type: 'service', bot_id: null, conversation_id: null, service_instance_id: 'service-A' }
      : action.includes('recovery')
        ? { ...conversationScope(), scope_type: 'recovery', recovery_id: 'recovery-A' }
        : conversationScope();
    return [
      { grant_id: `tenant-${index}`, subject: { type: 'user', subject_id: 'operator-A' }, required_role: 'conversation-operator', capability, scope: { ...conversationScope(), scope_type: 'tenant', bot_id: null, conversation_id: null }, state: 'active', expires_at: null, policy_version: 7 },
      { grant_id: `narrow-${index}`, subject: { type: 'user', subject_id: 'operator-A' }, required_role: 'conversation-operator', capability, scope: narrowScope, state: 'active', expires_at: null, policy_version: 7 },
    ];
  });
  const adapter = new OperationsAuthorizationAdapter({ callerNamespace: 'dashboard.prod', policy: policy({ grants }), now: () => NOW, generateId: (kind) => `${kind}-matrix` });

  for (const [action, capability, target, expected_version] of actionCases) {
    const built = adapter.createRequest(verifiedSubject(), { action, target, expected_version, reason: `Execute ${action}.` });
    assert.equal(built.actor.capabilities[0].capability, capability);
    assert.match(built.actor.capabilities[0].grant_id, /^narrow-/);
  }
});

test('defaults deny stale, revoked, expired, out-of-scope, implicit tenant-admin, and unaudited break-glass grants', () => {
  const baseGrant = policy().grants[0];
  const attempts = [
    { ...baseGrant, policy_version: 6 },
    { ...baseGrant, state: 'revoked' },
    { ...baseGrant, expires_at: NOW },
    { ...baseGrant, scope: conversationScope('conversation-B') },
    { ...baseGrant, break_glass: true },
  ];
  for (const grant of attempts) {
    const adapter = new OperationsAuthorizationAdapter({ callerNamespace: 'dashboard.prod', policy: policy({ grants: [grant] }), now: () => NOW });
    assert.throws(
      () => adapter.createRequest(verifiedSubject(), stopInput()),
      (error) => error instanceof OperationsAuthError && error.code === 'forbidden',
    );
  }

  const implicit = new OperationsAuthorizationAdapter({ callerNamespace: 'dashboard.prod', policy: policy({ grants: [] }), now: () => NOW });
  assert.throws(
    () => implicit.createRequest(verifiedSubject({ roles: ['tenant-admin'] }), stopInput()),
    (error) => error instanceof OperationsAuthError && error.code === 'forbidden',
  );

  const auditedBreakGlass = {
    ...baseGrant,
    break_glass: true,
    break_glass_reason: 'Emergency recovery.',
    approved_by: 'security-A',
    security_audit_id: 'security-audit-A',
  };
  const allowed = new OperationsAuthorizationAdapter({ callerNamespace: 'dashboard.prod', policy: policy({ grants: [auditedBreakGlass] }), now: () => NOW });
  assert.equal(allowed.createRequest(verifiedSubject(), stopInput()).actor.capabilities[0].grant_id, 'grant-stop-A');
});

test('submits only exact Core targets, mutation CAS, redacted reasons, and known browser fields', () => {
  const adapter = new OperationsAuthorizationAdapter({ callerNamespace: 'dashboard.prod', policy: policy(), now: () => NOW });
  const invalid = [
    stopInput({ target: { ...stopInput().target, pid: 42 } }),
    stopInput({ expected_version: null }),
    stopInput({ expected_version: { aggregate_type: 'turn', aggregate_id: 'turn-B', version: 4 } }),
    stopInput({ reason: 'use zylos_st_do_not_leak' }),
    stopInput({ display_text: 'the first item in the list' }),
  ];
  for (const input of invalid) {
    assert.throws(
      () => adapter.createRequest(verifiedSubject(), input),
      (error) => error instanceof OperationsAuthError && error.code === 'invalid_control_request',
    );
  }

  for (const reason of [
    'Bearer leaked-token',
    'sk-ant-12345678',
    'xoxb-12345678',
    '-----BEGIN PRIVATE KEY-----',
  ]) {
    assert.throws(
      () => adapter.createRequest(verifiedSubject(), stopInput({ reason })),
      (error) => error instanceof OperationsAuthError && error.code === 'invalid_control_request',
      `secret-shaped reason must be rejected: ${reason}`,
    );
  }
});

test('conversation grants never cover Core targets without the scoped conversation id', () => {
  const inspectGrant = {
    ...policy().grants[0],
    grant_id: 'grant-inspect-A',
    capability: 'runtime.inspect',
  };
  const adapter = new OperationsAuthorizationAdapter({
    callerNamespace: 'dashboard.prod',
    policy: policy({ grants: [inspectGrant] }),
    now: () => NOW,
  });

  for (const target of [
    { aggregate_type: 'turn', turn_id: 'turn-A' },
    { aggregate_type: 'executor', executor_instance_id: 'executor-A' },
  ]) {
    assert.throws(
      () => adapter.createRequest(verifiedSubject(), {
        action: 'inspect', target, expected_version: null, reason: 'Inspect the exact Core aggregate.',
      }),
      (error) => error instanceof OperationsAuthError && error.code === 'forbidden',
    );
  }
});

test('rejects malformed deployment policy scopes before any control can be submitted', () => {
  const malformed = { ...policy().grants[0], scope: { ...conversationScope(), service_instance_id: 'pid-42' } };
  assert.throws(
    () => new OperationsAuthorizationAdapter({ callerNamespace: 'dashboard.prod', policy: policy({ grants: [malformed] }) }),
    (error) => error instanceof OperationsAuthError && error.code === 'invalid_policy',
  );
});
