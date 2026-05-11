import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAgentState, StateEngine } from '../src/lib/state-engine.js';

function makeMockStore() {
  return {
    latestSnapshot() { return null; },
    eventsSince() { return []; },
    saveSnapshot() {},
    upsertSourceHealth() {},
    getCollectorLiveness() { return []; },
    getSourceHealth() { return []; },
    db: { prepare() { return { get() { return { seq: 0 }; } }; } }
  };
}

function makeEngine(opts = {}) {
  let clock = opts.startTime || 1000000;
  const now = () => clock;
  const advance = (ms) => { clock += ms; };
  const store = makeMockStore();
  const config = { zylosDir: '/tmp/zylos-test', runtime: 'claude' };
  const engine = new StateEngine(store, {}, config, { now });
  engine._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };
  return { engine, now, advance };
}

test('stop event clears running tools for that session', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Read' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-2', tool_name: 'Read' }
  });

  assert.equal(engine.getRunningTools().length, 2);

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'sess-1'
  });

  assert.equal(engine.getRunningTools().length, 0, 'running tools should be cleared after stop');
});

test('stop event only clears tools from the stopped session', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Read' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-2',
    metadata: { tool_use_id: 'tool-2', tool_name: 'Bash' }
  });

  assert.equal(engine.getRunningTools().length, 2);

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1001000).toISOString(),
    session_id: 'sess-1'
  });

  const remaining = engine.getRunningTools();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].tool_name, 'Bash');
});

test('stop event without session_id clears all tools', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Read' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-2',
    metadata: { tool_use_id: 'tool-2', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1001000).toISOString(),
    session_id: null
  });

  assert.equal(engine.getRunningTools().length, 0);
});

test('periodic stale tool cleanup removes old tools', () => {
  const { engine, advance } = makeEngine({ startTime: 1000000 });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Read' }
  });

  assert.equal(engine.getRunningTools().length, 1);

  advance(400_000);
  engine._cleanupStaleTools();

  assert.equal(engine.getRunningTools().length, 0, 'stale tool should be cleaned up after 5min');
});

test('periodic stale tool cleanup keeps fresh tools', () => {
  const { engine, advance } = makeEngine({ startTime: 1000000 });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'sess-1',
    metadata: { tool_use_id: 'tool-1', tool_name: 'Bash' }
  });

  advance(60_000);
  engine._cleanupStaleTools();

  assert.equal(engine.getRunningTools().length, 1, 'fresh tool should not be cleaned up');
});
