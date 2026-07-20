import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { OperationsAuthorizationAdapter } from '../src/lib/operations-auth-adapter.js';
import { validateOperationsControlResult } from '../src/lib/operations-control-client.js';

const fixturePath = path.resolve('../zylos-core-integration/contracts/public/fixtures/control-v1.json');

test('Dashboard consumer matches the authoritative Core Global24 public control fixture', { skip: !fs.existsSync(fixturePath) }, () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  for (const source of Object.values(fixture.requests)) {
    const capability = source.actor.capabilities[0];
    const adapter = new OperationsAuthorizationAdapter({
      callerNamespace: source.caller_namespace,
      policy: {
        policy_id: capability.policy_id,
        policy_version: capability.policy_version,
        state: 'active',
        grants: [{
          grant_id: capability.grant_id,
          subject: { type: source.actor.type, subject_id: source.actor.actor_id },
          capability: capability.capability,
          scope: capability.scope,
          state: 'active',
          expires_at: capability.expires_at,
          policy_version: capability.policy_version,
        }],
      },
      now: () => source.created_at,
      generateId: (kind) => kind === 'trace' ? source.trace_id : source.control_id,
    });
    const built = adapter.createRequest({
      source: source.auth_context.source,
      type: source.actor.type,
      subject_id: source.actor.actor_id,
      roles: source.actor.roles,
      authenticated_at: source.auth_context.authenticated_at,
    }, {
      control_id: source.control_id,
      action: source.action,
      target: source.target,
      expected_version: source.expected_version,
      reason: source.reason,
    });
    assert.equal(built.idempotency_key, source.idempotency_key, source.action);
    assert.deepEqual(built.target, source.target, source.action);
    assert.deepEqual(built.expected_version, source.expected_version, source.action);
  }

  assert.equal(validateOperationsControlResult(fixture.results.stop_completed, { action: 'stop_active_turn' }).status, 'completed');
  assert.equal(validateOperationsControlResult(fixture.results.reconcile_accepted, { action: 'reconcile' }).status, 'accepted');
  assert.equal(validateOperationsControlResult(fixture.results.reconcile_completed, { action: 'reconcile' }).control_result_version, 2);
  assert.equal(validateOperationsControlResult(fixture.results.forbidden_policy).status, 'forbidden');
});

test('operations authority and results are not broadcast into Global38 or Luna SSE projections', () => {
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  const projection = fs.readFileSync(path.resolve('src/lib/runtime-projection.js'), 'utf8');
  assert.doesNotMatch(index, /sse\.broadcast\(['"]runtime_(?:control|operations)/);
  assert.doesNotMatch(projection, /actor|auth_context|grant_id|authorization_policy|operationsControl/);
});
