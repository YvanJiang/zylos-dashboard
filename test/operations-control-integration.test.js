import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('deployed Dashboard auth binds a verified subject and never derives operations authority from admin login', async () => {
  let submitted;
  const core = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    submitted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      contract: 'zylos.control-result', contract_version: '1.0', trace_id: submitted.trace_id,
      caller_namespace: submitted.caller_namespace, control_id: submitted.control_id,
      control_result_version: 1, status: 'completed', target: submitted.target,
      previous_target_version: 4, target_version: 4, audit_id: 'audit-A',
      result: { snapshot: { aggregate_type: 'conversation', conversation_id: 'conversation-A', conversation_version: 4 } },
      error: null, accepted_at: '2026-07-20T10:00:01Z', completed_at: '2026-07-20T10:00:01Z',
    }));
  });

  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-control-'));
  const configDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), `${JSON.stringify({
    auth: { enabled: true, password: 'secret' },
    operationsControl: {
      enabled: true,
      endpoint: `${core.origin}/v1/operations-controls`,
      callerNamespace: 'dashboard.prod',
      authSubjects: {
        dashboard_session: { type: 'user', subject_id: 'operator-A', roles: ['observer'] },
      },
      authorizationPolicy: {
        policy_id: 'runtime-operations', policy_version: 7, state: 'active',
        grants: [{
          grant_id: 'inspect-A', subject: { type: 'user', subject_id: 'operator-A' }, required_role: 'observer', capability: 'runtime.inspect',
          scope: { scope_type: 'conversation', region: 'cn', tenant_id: 'tenant-A', bot_id: 'bot-A', conversation_id: 'conversation-A', service_instance_id: null, recovery_id: null },
          state: 'active', expires_at: null, policy_version: 7,
        }],
      },
    },
  }, null, 2)}\n`);

  const previousDir = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = zylosDir;
  const { createServer } = await import(`../src/index.js?operations=${Date.now()}-${Math.random()}`);
  if (previousDir == null) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previousDir;
  const dashboard = createServer();
  await new Promise(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${dashboard.address().port}`;
  try {
    const login = await fetch(`${origin}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=secret', redirect: 'manual' });
    const cookie = login.headers.get('set-cookie');
    const input = { action: 'inspect', target: { aggregate_type: 'conversation', conversation_id: 'conversation-A' }, expected_version: null, reason: 'Inspect the Core conversation.' };

    const forged = await fetch(`${origin}/api/runtime-controls`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...input, role: 'tenant-admin' }) });
    assert.equal(forged.status, 400);
    assert.equal(submitted, undefined);

    const response = await fetch(`${origin}/api/runtime-controls`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.status, 'completed');
    assert.equal(submitted.actor.actor_id, 'operator-A');
    assert.deepEqual(submitted.actor.capabilities.map(item => item.capability), ['runtime.inspect']);
  } finally {
    dashboard.closeAllConnections();
    core.server.closeAllConnections();
    await new Promise(resolve => dashboard.close(resolve));
    await new Promise(resolve => core.server.close(resolve));
  }
});
