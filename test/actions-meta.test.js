import assert from 'node:assert/strict';
import test from 'node:test';

import { getActionsMeta } from '../src/lib/actions.js';

test('getActionsMeta hides model and effort controls for Codex runtime', () => {
  const meta = getActionsMeta(
    { runtime: 'codex', codex_new_session_threshold: '75' },
    { model: 'claude-opus-4-7', effort: 'high' }
  );

  assert.equal(meta.runtime, 'codex');
  assert.deepEqual(meta.models, []);
  assert.deepEqual(meta.efforts_by_model, {});
  assert.equal(meta.current_model, null);
  assert.equal(meta.current_effort, null);
  assert.equal(meta.new_session_threshold, 75);
});

test('getActionsMeta keeps Claude model and effort controls for Claude runtime', () => {
  const meta = getActionsMeta(
    { runtime: 'claude', new_session_threshold: '36', zylosDir: '/tmp/zylos-dashboard-missing' },
    { effort: 'medium' }
  );

  assert.equal(meta.runtime, 'claude');
  assert.ok(meta.models.length > 0);
  assert.ok(Object.keys(meta.efforts_by_model).length > 0);
  assert.equal(meta.current_effort, 'medium');
  assert.equal(meta.new_session_threshold, 36);
});
