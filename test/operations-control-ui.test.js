import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOperationsControlInput,
  controlResultPresentation,
  submitOperationsControl,
} from '../public/js/operations-controls.js';

test('UI builds only the canonical target/CAS payload and never carries authority', () => {
  const input = buildOperationsControlInput({
    action: 'stop_active_turn',
    target: { aggregate_type: 'turn', conversation_id: 'conversation-A', turn_id: 'turn-A' },
    expectedVersion: 9,
    reason: 'Stop the selected active Core turn.',
  });
  assert.deepEqual(input, {
    action: 'stop_active_turn',
    target: { aggregate_type: 'turn', conversation_id: 'conversation-A', turn_id: 'turn-A' },
    expected_version: { aggregate_type: 'turn', aggregate_id: 'turn-A', version: 9 },
    reason: 'Stop the selected active Core turn.',
  });
  assert.doesNotMatch(JSON.stringify(input), /role|capabilit|scope|policy|secret|password|token/i);
});

test('UI accurately presents every terminal, asynchronous, and unknown outcome with audit/version detail', () => {
  const statuses = ['accepted', 'completed', 'noop', 'conflict', 'forbidden', 'failed', 'not_found'];
  for (const status of statuses) {
    const view = controlResultPresentation({ status, control_result_version: 3, audit_id: 'audit-A', previous_target_version: 4, target_version: 5, error: status === 'accepted' || status === 'completed' || status === 'noop' ? null : { user_message: `${status} detail` } });
    assert.equal(view.status, status);
    assert.match(view.detail, /result v3/);
    assert.match(view.detail, /audit-A/);
    assert.equal(view.terminal, status !== 'accepted');
  }
  assert.equal(controlResultPresentation({ status: 'future-status' }).status, 'unknown');
  assert.equal(controlResultPresentation(null).status, 'unknown');
});

test('UI follows accepted results to terminal completion without adding authority to requests', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const accepted = { status: 'accepted', control_id: 'control-A', control_result_version: 1, audit_id: 'audit-A', previous_target_version: 3, target_version: 3, error: null };
    const completed = { ...accepted, status: 'completed', control_result_version: 2, target_version: 4 };
    return new Response(JSON.stringify({ result: init.method === 'POST' ? accepted : completed }), { status: init.method === 'POST' ? 202 : 200, headers: { 'content-type': 'application/json' } });
  };
  const updates = [];
  const final = await submitOperationsControl({
    fetchImpl,
    basePath: '',
    input: buildOperationsControlInput({ action: 'inspect', target: { aggregate_type: 'conversation', conversation_id: 'conversation-A' }, expectedVersion: null, reason: 'Inspect.' }),
    onUpdate: (view) => updates.push(view.status),
    pollDelay: async () => {},
  });
  assert.equal(final.status, 'completed');
  assert.deepEqual(updates, ['accepted', 'completed']);
  assert.equal(calls[0].url, '/api/runtime-controls');
  assert.equal(calls[1].url, '/api/runtime-controls/control-A');
  assert.doesNotMatch(calls[0].init.body, /role|capabilit|scope|policy/i);
});
