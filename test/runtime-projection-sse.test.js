import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { SseHub } from '../src/lib/sse.js';

class FakeResponse extends EventEmitter {
  constructor({ slow = false } = {}) {
    super();
    this.slow = slow;
    this.writes = [];
    this.ended = false;
  }

  writeHead() {}
  write(chunk) {
    this.writes.push(chunk);
    return !this.slow;
  }
  end() { this.ended = true; }
}

const projection = Object.freeze({
  contract: 'zylos.dashboard-runtime-projection',
  contract_version: '1.0',
  dashboard_instance_id: 'dashboard-A',
  projection_sequence: 1,
  complete: true,
});

test('SseHub sends every connected client its complete runtime projection before later events', () => {
  const hub = new SseHub();
  const first = new FakeResponse();
  const second = new FakeResponse();
  hub.addClient(first, null, [{ eventType: 'runtime_projection', data: projection }]);
  hub.addClient(second, null, [{ eventType: 'runtime_projection', data: projection }]);
  hub.broadcast('fleet_state', { state: 'idle' });

  for (const client of [first, second]) {
    const events = client.writes.filter((line) => line.includes('event:'));
    assert.match(events[0], /^event: runtime_projection/);
    assert.match(events[0], /"projection_sequence":1/);
    assert.match(events[1], /^id: 1\nevent: fleet_state/);
  }
});

test('SseHub drops slow and disconnected clients without blocking other projection consumers', () => {
  const hub = new SseHub();
  const slow = new FakeResponse({ slow: true });
  const healthy = new FakeResponse();
  hub.addClient(slow, null, [{ eventType: 'runtime_projection', data: projection }]);
  hub.addClient(healthy, null, [{ eventType: 'runtime_projection', data: projection }]);
  healthy.emit('close');
  hub.broadcast('runtime_projection', { ...projection, projection_sequence: 2 });

  assert.equal(slow.ended, true);
  assert.equal(healthy.writes.filter((line) => line.includes('"projection_sequence":2')).length, 0);
  assert.equal(hub.clients.size, 0);
});
