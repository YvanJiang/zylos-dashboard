import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAgentState, StateEngine } from '../src/lib/state-engine.js';
import { Sanitizer } from '../src/lib/sanitizer.js';

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

test('subagent tools are separated from main session tools via agent_id', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent' }
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000150).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Bash', agent_id: 'agent-1' }
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 1, 'main feed should only have Agent launcher');
  assert.equal(state.running_tools[0].tool_name, 'Agent');
  assert.equal(state.subagent_tools.length, 1, 'subagent feed should have subagent tools');
  assert.equal(state.subagent_tools[0].tool_name, 'Bash');
  assert.equal(state.active_subagents[0].running_tools.length, 1, 'subagent should have its own running_tools');
  assert.equal(state.active_subagents[0].running_tools[0].tool_name, 'Bash');
});

test('background subagent: main and subagent tools separated by agent_id', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000150).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-bg', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-main', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000250).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-bg', tool_name: 'Read', agent_id: 'agent-bg' }
  });

  const state = engine.getState();
  assert.equal(state.active_subagents.length, 1, 'subagent should be active');
  assert.equal(state.running_tools.length, 1, 'main session tool in main feed');
  assert.equal(state.running_tools[0].tool_name, 'Bash');
  assert.equal(state.subagent_tools.length, 1, 'subagent tool in subagent feed');
  assert.equal(state.subagent_tools[0].tool_name, 'Read');
  assert.equal(state.active_subagents[0].running_tools.length, 1, 'subagent has its own running_tools');
});

test('subagent lifecycle tracked via SubagentStart/Stop', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  let state = engine.getState();
  assert.equal(state.active_subagents.length, 1);
  assert.equal(state.active_subagents[0].agent_id, 'agent-1');

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-2', agent_type: 'general-purpose' }
  });

  state = engine.getState();
  assert.equal(state.active_subagents.length, 2);

  engine.onEvent({
    event_type: 'subagent_stop',
    timestamp: new Date(1002000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1' }
  });

  state = engine.getState();
  assert.equal(state.active_subagents.length, 1);
  assert.equal(state.active_subagents[0].agent_id, 'agent-2');
});

test('subagent tools do not appear in main running_tools after stop', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000050).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent' }
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000060).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Bash', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Bash', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'subagent_stop',
    timestamp: new Date(1000300).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'post_tool_use',
    timestamp: new Date(1000350).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent' }
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 0, 'no tools should be running after completion');
  assert.equal(state.subagent_tools.length, 0, 'no subagent tools after stop');
  assert.equal(state.active_subagents.length, 0, 'no active subagents after stop');
});

test('parent Stop preserves background subagent running tools', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-bg', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-main', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000250).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-bg', tool_name: 'Read', agent_id: 'agent-bg' }
  });

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1000500).toISOString(),
    session_id: 'main-sess'
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 0, 'main tool cleared by Stop');
  assert.equal(state.subagent_tools.length, 1, 'subagent tool survives parent Stop');
  assert.equal(state.subagent_tools[0].tool_name, 'Read');
  assert.equal(state.active_subagents.length, 1, 'subagent still active');
});

test('SubagentStop cleans up orphan running tools for that agent_id', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-orphan', tool_name: 'Bash', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'subagent_stop',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1' }
  });

  const state = engine.getState();
  assert.equal(state.active_subagents.length, 0, 'subagent removed');
  assert.equal(state.subagent_tools.length, 0, 'orphan tool cleaned up by SubagentStop');
  assert.equal(state.running_tools.length, 0, 'no main tools either');
});

test('Stop without session_id preserves subagent tools', () => {
  const { engine } = makeEngine();

  engine.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-main', tool_name: 'Bash' }
  });

  engine.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000150).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Read', agent_id: 'agent-1' }
  });

  engine.onEvent({
    event_type: 'stop',
    timestamp: new Date(1000200).toISOString(),
    session_id: null
  });

  const state = engine.getState();
  assert.equal(state.running_tools.length, 0, 'main tool cleared');
  assert.equal(state.subagent_tools.length, 1, 'subagent tool survives null-session Stop');
});

test('snapshot restore preserves mainSessionId and activeSubagents', () => {
  let snapshotData = null;
  const store = {
    ...makeMockStore(),
    saveSnapshot(data) { snapshotData = data; },
    latestSnapshot() { return snapshotData; }
  };
  const config = { zylosDir: '/tmp/zylos-test', runtime: 'claude' };
  let clock = 1000000;
  const engine1 = new StateEngine(store, {}, config, { now: () => clock });
  engine1._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };

  engine1.onEvent({
    event_type: 'user_prompt_submit',
    timestamp: new Date(1000000).toISOString(),
    session_id: 'main-sess'
  });
  engine1.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000050).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-agent', tool_name: 'Agent' }
  });
  engine1.onEvent({
    event_type: 'subagent_start',
    timestamp: new Date(1000100).toISOString(),
    session_id: 'main-sess',
    metadata: { agent_id: 'agent-1', agent_type: 'general-purpose' }
  });
  engine1.onEvent({
    event_type: 'pre_tool_use',
    timestamp: new Date(1000200).toISOString(),
    session_id: 'main-sess',
    metadata: { tool_use_id: 'tool-sub', tool_name: 'Read', agent_id: 'agent-1' }
  });

  engine1._saveSnapshot();
  assert.ok(snapshotData, 'snapshot should be saved');

  const engine2 = new StateEngine(store, {}, config, { now: () => clock });
  engine2._state.amHeartbeat = { state: 'idle', health: 'ok', lastCheck: clock / 1000, lastActivity: clock / 1000 };
  engine2.initialize();

  const state = engine2.getState();
  assert.equal(state.running_tools.length, 1, 'Agent launcher should be in main running_tools');
  assert.equal(state.running_tools[0].tool_name, 'Agent');
  assert.equal(state.subagent_tools.length, 1, 'subagent tool should be in subagent_tools');
  assert.equal(state.active_subagents.length, 1);
  assert.equal(state.active_subagents[0].agent_id, 'agent-1');
  assert.equal(state.active_subagents[0].running_tools.length, 1, 'subagent running_tools preserved after restore');
});

test('SubagentStop assistant_summary is redacted', () => {
  const sanitizer = new Sanitizer('/tmp/zylos-test');
  const result = sanitizer.sanitizeHookPayload('SubagentStop', {
    session_id: 'sess-1',
    agent_id: 'agent-1',
    agent_type: 'general-purpose',
    hook_event_name: 'SubagentStop',
    last_assistant_message: 'Used key sk-1234567890abcdefghijklmnop and sent to user@example.com'
  });

  assert.ok(result.metadata.assistant_summary, 'should have assistant_summary');
  assert.ok(!result.metadata.assistant_summary.includes('sk-1234567890'), 'API key should be redacted');
  assert.ok(!result.metadata.assistant_summary.includes('user@example.com'), 'email should be redacted');
  assert.ok(result.metadata.assistant_summary.includes('[REDACTED]'), 'should contain redaction marker');
});
