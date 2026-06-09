import assert from 'node:assert/strict';
import test from 'node:test';
import { agentColor } from '../src/lib/agent-color.js';
import { FleetPoller, buildSelfRecord } from '../src/lib/fleet-poller.js';
import { buildFleetPayload } from '../src/lib/fleet-payload.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function makeConfig(agents, fleet = {}) {
  return {
    fleet: {
      agents,
      timeout_ms: 50,
      stale_ms: 1000,
      jitter_ms: 0,
      ...fleet
    }
  };
}

test('fleet poller exchanges token and derives safe agent records', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_secret', expires_at: new Date(120000).toISOString() });
    }
    assert.equal(options.headers.Authorization, 'Bearer zylos_st_secret');
    return jsonResponse({
      state: 'BUSY',
      running_tools: [{ tool_name: 'Bash', tool_detail: 'npm test' }],
      runtime_info: { model: 'GPT-5', effort: 'high', zylos_update: '1.2.3' },
      new_session_threshold: 75,
      system_metrics: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 },
      session_cost: 1.23,
      daily_cost: 4.56,
      weekly_cost: 7.89,
      active_subagents: [{ last_activity: 'Worker running' }],
      metrics: {
        context_pct: { value: 42 },
        session_cost: { value: 1.23 }
      }
    });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test/dashboard', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const fleet = poller.getFleet();
  assert.equal(fleet.count, 1);
  assert.equal(fleet.agents[0].name, 'Remote');
  assert.equal(fleet.agents[0].color, agentColor('Remote').color);
  assert.equal(fleet.agents[0].hue, agentColor('Remote').hue);
  assert.equal(fleet.agents[0].state, 'BUSY');
  assert.equal(fleet.agents[0].activity, 'npm test');
  assert.equal(fleet.agents[0].context_pct, 42);
  assert.equal(fleet.agents[0].cost, 1.23);
  assert.equal(fleet.agents[0].session_cost, 1.23);
  assert.equal(fleet.agents[0].daily_cost, 4.56);
  assert.equal(fleet.agents[0].weekly_cost, 7.89);
  assert.equal(fleet.agents[0].model, 'GPT-5');
  assert.equal(fleet.agents[0].effort, 'high');
  assert.equal(fleet.agents[0].new_session_threshold, 75);
  assert.equal(fleet.agents[0].cpu_pct, 12);
  assert.equal(fleet.agents[0].mem_pct, 34);
  assert.equal(fleet.agents[0].disk_pct, 56);
  assert.equal(fleet.agents[0].has_upgrade, true);
  assert.equal(fleet.agents[0].has_subagent, true);
  assert.equal(fleet.agents[0].health_reason, 'ok');
  assert.equal(JSON.stringify(fleet).includes('zylos_ak_secret'), false);
  assert.equal(JSON.stringify(fleet).includes('zylos_st_secret'), false);
  assert.equal(calls[0].authorization, 'Bearer zylos_ak_secret');
  assert.equal(fleet.agents[0].self, false, 'external records must not be flagged self');
});

test('fleet poller refreshes token after expiry and on state 401', async () => {
  let now = 0;
  let tokenCount = 0;
  let stateCount = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCount += 1;
      return jsonResponse({ token: `zylos_st_${tokenCount}`, expires_at: new Date(now + 120000).toISOString() });
    }
    stateCount += 1;
    if (stateCount === 3) return jsonResponse({ error: 'expired' }, 401);
    return jsonResponse({ state: 'IDLE' });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  assert.equal(tokenCount, 1);
  now = 70000;
  await poller.pollOnce();
  assert.equal(tokenCount, 2, 'token should refresh inside skew window');
  await poller.pollOnce();
  assert.equal(tokenCount, 3, 'state 401 should force token refresh');
  assert.equal(poller.getFleet().agents[0].health_reason, 'idle');
});

test('fleet poller falls back to ttl when expires_at is invalid', async () => {
  let now = 0;
  let tokenCount = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCount += 1;
      return jsonResponse({ token: `zylos_st_${tokenCount}`, expires_at: 'not-a-date', ttl_seconds: 3600 });
    }
    return jsonResponse({ state: 'IDLE' });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  now = 3000;
  await poller.pollOnce();
  assert.equal(tokenCount, 1, 'invalid expires_at should not force every poll to exchange a token');
});

test('fleet poller maps token 404 and invalid key 401 without blocking other agents', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('old.example.test')) return jsonResponse({ error: 'not_found' }, 404);
    if (url.includes('bad.example.test')) return jsonResponse({ error: 'invalid_api_key' }, 401);
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    return jsonResponse({ state: 'IDLE' });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Old', base_url: 'https://old.example.test', read_api_key: 'zylos_ak_old' },
    { name: 'Bad', base_url: 'https://bad.example.test', read_api_key: 'zylos_ak_bad' },
    { name: 'Good', base_url: 'https://good.example.test', read_api_key: 'zylos_ak_good' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const byName = Object.fromEntries(poller.getFleet().agents.map(a => [a.name, a]));
  assert.equal(byName.Old.health_reason, 'version_unsupported');
  assert.equal(byName.Old.hue, agentColor('Old').hue);
  assert.equal(byName.Bad.health_reason, 'auth_failed');
  assert.equal(byName.Bad.hue, agentColor('Bad').hue);
  assert.equal(byName.Good.health_reason, 'idle');
  assert.equal(byName.Good.hue, agentColor('Good').hue);
});

test('fleet poller marks stale successful records offline', async () => {
  let now = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    return jsonResponse({ state: 'IDLE' });
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { stale_ms: 1000 }), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].health_reason, 'idle');
  now = 1500;
  assert.equal(poller.getFleet().agents[0].health_reason, 'offline');
  assert.equal(poller.getFleet().agents[0].state, 'OFFLINE');
});

test('buildSelfRecord produces a secret-free self record from local state', () => {
  const name = 'zylos01';
  const record = buildSelfRecord({
    name,
    color: agentColor(name),
    state: {
      state: 'BUSY',
      running_tools: [{ tool_name: 'Bash', tool_detail: 'npm test' }],
      active_subagents: [{ last_activity: 'Subagent active' }]
    },
    runtimeInfo: { model: 'Opus 4.6', effort: 'high', codex_update: '0.137.0' },
    contextPct: 42,
    newSessionThreshold: 75,
    sessionCost: 1.23,
    dailyCost: 4.56,
    weeklyCost: 7.89,
    systemMetrics: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 },
    nowMs: 0
  });

  assert.equal(record.self, true);
  assert.equal(record.name, name);
  assert.equal(record.color, agentColor(name).color);
  assert.equal(record.hue, agentColor(name).hue);
  assert.equal(record.state, 'BUSY');
  assert.equal(record.activity, 'npm test');
  assert.equal(record.context_pct, 42);
  assert.equal(record.cost, 1.23);
  assert.equal(record.session_cost, 1.23);
  assert.equal(record.daily_cost, 4.56);
  assert.equal(record.weekly_cost, 7.89);
  assert.equal(record.model, 'Opus 4.6');
  assert.equal(record.effort, 'high');
  assert.equal(record.new_session_threshold, 75);
  assert.equal(record.cpu_pct, 12);
  assert.equal(record.mem_pct, 34);
  assert.equal(record.disk_pct, 56);
  assert.equal(record.has_upgrade, true);
  assert.equal(record.has_subagent, true);
  assert.equal(record.base_url, null);
  assert.equal(record.pulse_rate, 1);
  assert.equal(record.health_reason, 'ok');
  assert.equal(record.last_seen, new Date(0).toISOString());
  assert.equal(JSON.stringify(record).includes('zylos_ak_'), false);
  assert.equal(JSON.stringify(record).includes('zylos_st_'), false);
});

test('buildSelfRecord maps idle and offline/unknown states', () => {
  const idle = buildSelfRecord({ name: 'a', color: agentColor('a'), state: { state: 'IDLE' }, nowMs: 0 });
  assert.equal(idle.health_reason, 'idle');
  assert.equal(idle.pulse_rate, 1);

  const offline = buildSelfRecord({ name: 'a', color: agentColor('a'), state: { state: 'OFFLINE' }, nowMs: 0 });
  assert.equal(offline.health_reason, 'offline');
  assert.equal(offline.pulse_rate, 0);

  const unknown = buildSelfRecord({ name: 'a', color: agentColor('a'), state: { state: 'UNKNOWN' }, nowMs: 0 });
  assert.equal(unknown.health_reason, 'offline');
  assert.equal(unknown.pulse_rate, 0);
});

test('self record injected into fleet is first, flagged, and order-independent', () => {
  // Simulate the /api/fleet handler composition: self prepended to poller output.
  const self = buildSelfRecord({ name: 'local', color: agentColor('local'), state: { state: 'IDLE' }, nowMs: 0 });
  const external = [
    { name: 'remote1', self: false },
    { name: 'remote2', self: false }
  ];
  const agents = [self, ...external];
  assert.equal(agents[0].self, true);
  assert.equal(agents[0].name, 'local');
  assert.equal(agents.filter((a) => a.self === true).length, 1);
  assert.ok(agents.slice(1).every((a) => a.self === false));
});

test('buildFleetPayload includes self first and rejects leaked secrets', () => {
  const self = buildSelfRecord({ name: 'local', color: agentColor('local'), state: { state: 'IDLE' }, nowMs: 0 });
  const payload = buildFleetPayload({
    selfRecord: self,
    remoteFleet: { agents: [{ name: 'remote', self: false }], count: 1, updated_at: '2026-06-09T00:00:00.000Z' }
  });
  assert.equal(payload.count, 2);
  assert.equal(payload.agents[0].name, 'local');
  assert.equal(payload.agents[0].self, true);
  assert.equal(payload.agents[1].name, 'remote');
  assert.equal(payload.agents[1].self, false);

  assert.throws(() => buildFleetPayload({
    selfRecord: self,
    remoteFleet: { agents: [{ name: 'bad', read_api_key: 'zylos_ak_secret' }] }
  }), /fleet_secret_leak_guard/);
});

test('fleet poller onPoll receives safe remote fleet after poll cycle completion', async () => {
  let onPollFleet = null;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    }
    return jsonResponse({ state: 'IDLE' });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), {
    fetch: fetchImpl,
    now: () => 0,
    onPoll: (fleet) => { onPollFleet = fleet; }
  });

  await poller.pollOnce();
  assert.equal(onPollFleet.count, 1);
  assert.equal(onPollFleet.agents[0].name, 'Remote');
  assert.equal(JSON.stringify(onPollFleet).includes('zylos_ak_secret'), false);
  assert.equal(JSON.stringify(onPollFleet).includes('zylos_st_ok'), false);
});
