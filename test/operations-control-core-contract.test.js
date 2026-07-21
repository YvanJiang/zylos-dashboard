import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompatibilityEvidence } from './helpers/public-contract-compatibility.js';

test('Dashboard independently proves the current Core public contract matrix', {
  skip: !process.env.ZYLOS_CORE_PUBLIC_CONTRACTS_DIR,
}, () => {
  const evidence = createCompatibilityEvidence();
  assert.equal(evidence.repository, 'zylos-dashboard');
  console.log(`ZYLOS_CONTRACT_COMPATIBILITY_EVIDENCE=${JSON.stringify(evidence)}`);
});

test('operations authority and results are not broadcast into Global38 or Luna SSE projections', () => {
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  const projection = fs.readFileSync(path.resolve('src/lib/runtime-projection.js'), 'utf8');
  assert.doesNotMatch(index, /sse\.broadcast\(['"]runtime_(?:control|operations)/);
  assert.doesNotMatch(projection, /actor|auth_context|grant_id|authorization_policy|operationsControl/);
});
