import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

import { OperationsAuthorizationAdapter } from '../src/lib/operations-auth-adapter.js';
import { OperationsControlResultStore } from '../src/lib/operations-control-client.js';
import { createOperationsControlApi } from '../src/lib/operations-control-api.js';
import { readJsonBody, sendJson } from '../src/lib/http.js';

const subject = {
  source: 'dashboard_session', type: 'user', subject_id: 'operator-A',
  roles: ['observer'], authenticated_at: '2026-07-20T10:00:00Z',
};
const otherSubject = { ...subject, subject_id: 'operator-B' };
const scope = { scope_type: 'conversation', region: 'cn', tenant_id: 'tenant-A', bot_id: 'bot-A', conversation_id: 'conversation-A', service_instance_id: null, recovery_id: null };
const policy = { policy_id: 'runtime-operations', policy_version: 7, state: 'active', grants: [{ grant_id: 'inspect-A', subject: { type: 'user', subject_id: 'operator-A' }, required_role: 'observer', capability: 'runtime.inspect', scope, state: 'active', expires_at: null, policy_version: 7 }] };

function controlResult(status, version) {
  const ok = ['accepted', 'completed', 'noop'].includes(status);
  return {
    contract: 'zylos.control-result', contract_version: '1.0', trace_id: 'trace-A', caller_namespace: 'dashboard.prod', control_id: 'inspect-A', control_result_version: version, status,
    target: { aggregate_type: 'conversation', conversation_id: 'conversation-A' },
    previous_target_version: ok ? 4 : null, target_version: ok ? 4 : null,
    audit_id: 'audit-A', result: ok ? { snapshot: { aggregate_type: 'conversation', conversation_id: 'conversation-A', conversation_version: 4 } } : null,
    error: ok ? null : { code: status, category: 'authorization', retryable: false, side_effect_status: 'none', user_message: status, occurred_at: '2026-07-20T10:00:01Z' },
    accepted_at: ok ? '2026-07-20T10:00:01Z' : null,
    completed_at: status === 'accepted' ? null : '2026-07-20T10:00:02Z',
  };
}

async function withServer(client, run) {
  const adapter = new OperationsAuthorizationAdapter({ callerNamespace: 'dashboard.prod', policy, now: () => '2026-07-20T10:00:00Z', generateId: (kind) => kind === 'control' ? 'inspect-A' : 'trace-A' });
  const api = createOperationsControlApi({
    authorizationAdapter: adapter,
    client,
    resultStore: new OperationsControlResultStore(),
    getVerifiedSubject: (req) => req.headers['x-test-subject'] === 'other'
      ? otherSubject
      : req.headers['x-test-subject'] ? subject : null,
    readJsonBody,
    sendJson,
  });
  const server = http.createServer(async (req, res) => {
    const handled = await api.handle(req, res, new URL(req.url, 'http://localhost'));
    if (!handled) sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await run(origin); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('API rejects unverified and self-authorized requests, then exposes accepted and completed audit results', async () => {
  let submissions = 0;
  const client = {
    async submit() { submissions += 1; return controlResult('accepted', 1); },
    async getResult() { return controlResult('completed', 2); },
  };
  await withServer(client, async (origin) => {
    const input = { action: 'inspect', target: { aggregate_type: 'conversation', conversation_id: 'conversation-A' }, expected_version: null, reason: 'Inspect the selected Core conversation.' };
    const unauthenticated = await fetch(`${origin}/api/runtime-controls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(unauthenticated.status, 401);

    const forged = await fetch(`${origin}/api/runtime-controls`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-subject': 'yes' }, body: JSON.stringify({ ...input, capabilities: ['runtime.inspect'] }) });
    assert.equal(forged.status, 400);
    assert.equal((await forged.json()).error, 'client_authority_forbidden');
    assert.equal(submissions, 0);

    const accepted = await fetch(`${origin}/api/runtime-controls`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-subject': 'yes' }, body: JSON.stringify(input) });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).result.status, 'accepted');

    const completed = await fetch(`${origin}/api/runtime-controls/inspect-A`, { headers: { 'x-test-subject': 'yes' } });
    assert.equal(completed.status, 200);
    const body = await completed.json();
    assert.equal(body.result.status, 'completed');
    assert.equal(body.result.control_result_version, 2);
    assert.equal(body.result.audit_id, 'audit-A');
  });
});

test('API polls only controls owned by a currently authorized verified subject', async () => {
  let polls = 0;
  const client = {
    async submit() { return controlResult('accepted', 1); },
    async getResult() { polls += 1; return controlResult('completed', 2); },
  };
  await withServer(client, async (origin) => {
    const input = { action: 'inspect', target: { aggregate_type: 'conversation', conversation_id: 'conversation-A' }, expected_version: null, reason: 'Inspect the selected Core conversation.' };
    const accepted = await fetch(`${origin}/api/runtime-controls`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-subject': 'yes' }, body: JSON.stringify(input) });
    assert.equal(accepted.status, 202);

    const unknown = await fetch(`${origin}/api/runtime-controls/not-submitted-here`, { headers: { 'x-test-subject': 'yes' } });
    assert.equal(unknown.status, 404);
    assert.equal(polls, 0);

    const differentSubject = await fetch(`${origin}/api/runtime-controls/inspect-A`, { headers: { 'x-test-subject': 'other' } });
    assert.equal(differentSubject.status, 403);
    assert.equal(polls, 0);

    const owner = await fetch(`${origin}/api/runtime-controls/inspect-A`, { headers: { 'x-test-subject': 'yes' } });
    assert.equal(owner.status, 200);
    assert.equal(polls, 1);
  });
});
