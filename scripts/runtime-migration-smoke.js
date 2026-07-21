import assert from 'node:assert/strict';
// Run explicitly through smoke:runtime-migration because it depends on sibling integration worktrees.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { generateApiKey, hashApiKey, hashPassword } from '../src/lib/auth.js';
import { Store } from '../src/lib/store.js';
import { renderRuntimeObservability } from '../public/js/runtime-observability.js';

const DASHBOARD_REPO = fileURLToPath(new URL('..', import.meta.url));
const CORE_REPO = requiredRepository('ZYLOS_CORE_REPO');
const LUNA_REPO = requiredRepository('ZYLOS_LUNA_REPO');
const CORE_BASE = '6b0f04b86537c7b5b9b769bd23b8ef78002861ab';
const LUNA_BASE = '98e38b517d07152cf2d199c3a0825b914069dfa4';

function requiredRepository(name) {
  const directory = process.env[name];
  assert.ok(directory, `${name} must name the exact integration worktree`);
  const resolved = path.resolve(directory);
  assert.ok(fs.existsSync(path.join(resolved, 'package.json')), `${name} is not a repository: ${resolved}`);
  return resolved;
}

function proveBase(directory, base) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${directory} must descend from ${base}: ${result.stderr}`);
}

function readCoreFixture() {
  return JSON.parse(fs.readFileSync(
    path.join(CORE_REPO, 'contracts/public/fixtures/observability-v1.json'),
    'utf8',
  ));
}

function snapshotFrom(source, { instance, version, state } = {}) {
  const snapshot = structuredClone(source);
  if (instance) {
    snapshot.core_service_instance_id = instance;
    snapshot.service.service_instance_id = instance;
  }
  if (version) {
    snapshot.snapshot_id = `snapshot-${instance || snapshot.core_service_instance_id}-${version}`;
    snapshot.snapshot_version = version;
  }
  if (state) snapshot.turns.items[0].state = state;
  return snapshot;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForDashboard(base, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Dashboard exited ${child.exitCode} before readiness:\n${output.text}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok && (await response.json()).ok === true) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Dashboard did not become ready:\n${output.text}`);
}

async function startDashboard(zylosDir, port) {
  const output = { text: '' };
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: DASHBOARD_REPO,
    env: { ...process.env, ZYLOS_DIR: zylosDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output.text += chunk; });
  child.stderr.on('data', (chunk) => { output.text += chunk; });
  const base = `http://127.0.0.1:${port}`;
  await waitForDashboard(base, child, output);
  return { base, child, output };
}

async function stopDashboard(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  runtime.child.kill('SIGTERM');
  const stopped = await Promise.race([
    once(runtime.child, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped) {
    runtime.child.kill('SIGKILL');
    await once(runtime.child, 'exit');
  }
}

async function exchangeApiKey(base, apiKey) {
  const response = await fetch(`${base}/api/auth/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

async function postSnapshot(base, token, snapshot) {
  const response = await fetch(`${base}/api/runtime-snapshot`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(snapshot),
  });
  return { status: response.status, body: await response.json() };
}

class SseReader {
  constructor(response, controller) {
    this.reader = response.body.getReader();
    this.controller = controller;
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.events = [];
  }

  parse() {
    this.buffer = this.buffer.replaceAll('\r\n', '\n');
    let boundary;
    while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (!frame || frame.startsWith(':')) continue;
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      this.events.push({ event, data: JSON.parse(data.join('\n')) });
    }
  }

  async next(eventType) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const queued = this.events.findIndex(({ event }) => event === eventType);
      if (queued !== -1) return this.events.splice(queued, 1)[0].data;
      const result = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${eventType}`)), 5_000)),
      ]);
      if (result.done) throw new Error(`SSE ended before ${eventType}`);
      this.buffer += this.decoder.decode(result.value, { stream: true });
      this.parse();
    }
    throw new Error(`Timed out waiting for ${eventType}`);
  }

  close() {
    this.controller.abort();
  }
}

async function connectLuna(base, token) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream?consumer=luna`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  return new SseReader(response, controller);
}

async function getState(base, token) {
  const response = await fetch(`${base}/api/state`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('real Dashboard restart preserves Core authority and Luna fail-closed projection behavior', {
  timeout: 30_000,
}, async () => {
  proveBase(CORE_REPO, CORE_BASE);
  proveBase(LUNA_REPO, LUNA_BASE);
  const requireLuna = createRequire(path.join(LUNA_REPO, 'package.json'));
  const { RuntimeProjectionConsumer } = requireLuna('./src/runtime-projection-consumer');
  const fixture = readCoreFixture();
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-global46-dashboard-'));
  const dataDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port,
    host: '127.0.0.1',
    auth: { enabled: true, password: hashPassword('global46-smoke') },
  }));
  const apiKey = generateApiKey();
  const store = new Store(path.join(dataDir, 'dashboard.db'));
  store.insertApiKey({ name: 'global46-core-publisher', keyHash: hashApiKey(apiKey), scope: 'admin' });
  store.close();

  let runtime;
  let firstStream;
  let restartedStream;
  let reconnectStream;
  try {
    runtime = await startDashboard(zylosDir, port);
    const token = await exchangeApiKey(runtime.base, apiKey);
    firstStream = await connectLuna(runtime.base, token);
    const initial = snapshotFrom(fixture.cases.complete, { instance: 'core-service-A', version: 7 });
    const initialPost = await postSnapshot(runtime.base, token, initial);
    assert.equal(initialPost.status, 202);
    const firstProjection = await firstStream.next('runtime_projection');
    assert.equal(firstProjection.projection_sequence, 1);
    assert.equal(firstProjection.capabilities.control, false);
    assert.equal(firstProjection.capabilities.core_direct_access, false);
    assert.doesNotMatch(JSON.stringify(firstProjection), /provider_native_id|runtime_identity|process_start_time|workspace_root|control_request/i);

    const luna = new RuntimeProjectionConsumer();
    assert.deepEqual(luna.accept('runtime_projection', firstProjection), { status: 'initial', apply: true });
    assert.deepEqual(luna.runtimes()[0], {
      runtimeId: 'runtime-conversation-A',
      displayLabel: 'Conversation conversation-A',
      provider: 'claude',
      executorHealth: 'degraded',
      activeTurnState: 'recovering',
      queueLength: 2,
      waitReason: 'interaction_delivery_unknown',
      sideEffectStatus: 'unknown',
      lastChangedAt: '2026-07-19T06:00:00Z',
    });

    firstStream.close();
    await stopDashboard(runtime);
    runtime = await startDashboard(zylosDir, port);
    restartedStream = await connectLuna(runtime.base, token);
    const restarted = snapshotFrom(fixture.cases.complete, { instance: 'core-service-B', version: 1 });
    assert.equal((await postSnapshot(runtime.base, token, restarted)).status, 202);
    const afterRestart = await restartedStream.next('runtime_projection');
    assert.notEqual(afterRestart.dashboard_instance_id, firstProjection.dashboard_instance_id);
    assert.equal(afterRestart.projection_sequence, 1);
    assert.equal(luna.accept('runtime_projection', afterRestart).status, 'instance_restart');

    const degraded = snapshotFrom(fixture.cases.degraded, { instance: 'core-service-B', version: 2 });
    const degradedPost = await postSnapshot(runtime.base, token, degraded);
    assert.equal(degradedPost.status, 202);
    const degradedProjection = await restartedStream.next('runtime_projection');
    assert.equal(degradedProjection.complete, false);
    assert.equal(luna.accept('runtime_projection', degradedProjection).status, 'incomplete');
    assert.equal(luna.status, 'degraded');
    assert.deepEqual(luna.runtimes(), []);

    reconnectStream = await connectLuna(runtime.base, token);
    const completeThree = snapshotFrom(fixture.cases.complete, { instance: 'core-service-B', version: 3 });
    assert.equal((await postSnapshot(runtime.base, token, completeThree)).status, 202);
    const projectionThree = await restartedStream.next('runtime_projection');
    const reconnectInitial = await reconnectStream.next('runtime_projection');
    assert.equal(reconnectInitial.projection_sequence, 3);
    assert.equal(reconnectInitial.complete, true);
    assert.equal(luna.accept('runtime_projection', projectionThree).apply, true);

    const completeFour = snapshotFrom(fixture.cases.complete, { instance: 'core-service-B', version: 4 });
    assert.equal((await postSnapshot(runtime.base, token, completeFour)).status, 202);
    await restartedStream.next('runtime_projection');
    const completeFive = snapshotFrom(fixture.cases.complete, { instance: 'core-service-B', version: 5 });
    assert.equal((await postSnapshot(runtime.base, token, completeFive)).status, 202);
    const projectionFive = await restartedStream.next('runtime_projection');
    assert.equal(luna.accept('runtime_projection', projectionFive).status, 'gap');
    assert.equal(luna.status, 'awaiting_complete');
    assert.deepEqual(luna.runtimes(), []);

    const completeSix = snapshotFrom(fixture.cases.complete, { instance: 'core-service-B', version: 6 });
    assert.equal((await postSnapshot(runtime.base, token, completeSix)).status, 202);
    assert.equal(luna.accept('runtime_projection', await restartedStream.next('runtime_projection')).apply, true);

    const unknownState = snapshotFrom(fixture.cases.complete, {
      instance: 'core-service-B', version: 7, state: 'future_canonical_state',
    });
    assert.equal((await postSnapshot(runtime.base, token, unknownState)).status, 202);
    const unsupportedProjection = await restartedStream.next('runtime_projection');
    assert.equal(luna.accept('runtime_projection', unsupportedProjection).status, 'unsupported');
    assert.equal(luna.status, 'unsupported');
    assert.deepEqual(luna.runtimes(), []);

    const state = await getState(runtime.base, token);
    assert.equal(state.runtime_snapshot.snapshot.turns.items[0].state, 'future_canonical_state');
    assert.match(renderRuntimeObservability(state.runtime_snapshot), /Unknown \(future_canonical_state\)/);
    assert.doesNotMatch(JSON.stringify(state.runtime_snapshot), /provider_native_id|runtime_identity|process_start_time/i);

    const unsupportedMajor = snapshotFrom(fixture.cases.complete, { instance: 'core-service-B', version: 8 });
    unsupportedMajor.contract_version = '2.0';
    const unsupportedPost = await postSnapshot(runtime.base, token, unsupportedMajor);
    assert.deepEqual(unsupportedPost, {
      status: 422,
      body: { error: 'unsupported_contract_version' },
    });
  } finally {
    firstStream?.close();
    restartedStream?.close();
    reconnectStream?.close();
    await stopDashboard(runtime);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});
