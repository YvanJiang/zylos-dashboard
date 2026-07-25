import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { OperationsAuthorizationAdapter } from '../../src/lib/operations-auth-adapter.js';
import {
  OperationsControlResultStore,
  validateOperationsControlResult,
} from '../../src/lib/operations-control-client.js';
import {
  createLunaProjectionEventFilter,
  RuntimeProjectionPublisher,
} from '../../src/lib/runtime-projection.js';
import {
  RuntimeSnapshotConsumer,
  validateRuntimeSnapshot,
} from '../../src/lib/runtime-snapshot.js';

const ASSERTIONS = Object.freeze([
  'required_null_optional',
  'major_rejection',
  'minor_additive_compatibility',
  'unknown_safety_terminal_enum_rejection',
  'public_error_shape',
  'version_conflict',
  'jcs_bytes_from_raw_payload',
  'idempotency_key_from_raw_payload',
  'payload_hash_from_raw_payload',
]);
const FLOWS = Object.freeze([
  'events',
  'observability_control',
  'dashboard_luna_projection',
]);
const EXPECTED_CORE_FIXTURE_SHA256 =
  'c11dbb169e0c124bbfb05cded4d3a3d49d473d8deaea1c5a777e25f026f867ba';
const CORE_FIXTURE_FILES = Object.freeze([
  'control-v1.json',
  'dashboard-runtime-projection-v1.json',
  'delivery-mapping-v1.json',
  'delivery-native-thread-v1.1.json',
  'idempotency-v1.json',
  'inbound-envelope-v1.json',
  'inbound-result-v1.json',
  'interaction-handoff-v1.json',
  'normalized-event-v1.json',
  'observability-v1.json',
]);
const TRANSIENT_FIELDS = new Set([
  'idempotency_key', 'trace_id', 'received_at', 'headers', 'http_headers', 'rpc_headers',
  'signature', 'credential', 'credentials', 'authorization', 'cookie', 'detail_ref', 'source_ref',
]);
const DELIVERY_TRANSIENT_FIELDS = new Set([
  'delivery_attempt_id', 'delivery_attempt_no', 'outbox_lease_epoch', 'not_before',
  'claimed_at', 'claim_expires_at', 'dispatch_started_at', 'dispatched_at',
]);

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function coreContractsDirectory() {
  const configured = process.env.ZYLOS_CORE_PUBLIC_CONTRACTS_DIR;
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new Error('ZYLOS_CORE_PUBLIC_CONTRACTS_DIR is required');
  }
  const directory = path.resolve(configured);
  const entrypoint = path.join(directory, 'index.js');
  const fixturesDirectory = path.join(directory, 'fixtures');
  if (!fs.statSync(entrypoint, { throwIfNoEntry: false })?.isFile()
    || !fs.statSync(fixturesDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Core public contracts were not found at ${directory}`);
  }
  return directory;
}

function fixtureFilenames(directory) {
  const filenames = fs.readdirSync(path.join(directory, 'fixtures'))
    .filter((filename) => filename.endsWith('.json'))
    .sort();
  assert.deepEqual(
    filenames,
    CORE_FIXTURE_FILES,
    'Core public fixture set changed without Dashboard compatibility review',
  );
  return filenames;
}

function parseFixtureBytes(raw, filename) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Core public fixture ${filename} is malformed JSON`, { cause: error });
  }
  assert.ok(isPlainRecord(parsed), `${filename} must contain one JSON object`);
  assert.match(parsed.fixture_version, /^1\.[0-9]+$/u, `${filename} fixture version is unsupported`);
  return parsed;
}

function readFixture(fixtures, filename) {
  assert.ok(CORE_FIXTURE_FILES.includes(filename), `Unreviewed Core fixture ${filename}`);
  const fixture = fixtures.get(filename);
  assert.ok(fixture, `Core public fixture ${filename} was not loaded`);
  return structuredClone(fixture);
}

function loadFixtureSet(directory) {
  const hash = crypto.createHash('sha256');
  const fixtures = new Map();
  for (const filename of fixtureFilenames(directory)) {
    const raw = fs.readFileSync(path.join(directory, 'fixtures', filename));
    fixtures.set(filename, parseFixtureBytes(raw, filename));
    hash.update(filename, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(raw);
    hash.update(Buffer.from([0]));
  }
  const sha256 = hash.digest('hex');
  assert.equal(sha256, EXPECTED_CORE_FIXTURE_SHA256, 'Core public fixture bytes drifted');
  return Object.freeze({ fixtures, sha256 });
}

function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'JCS input contains invalid Unicode');
      index += 1;
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff, 'JCS input contains invalid Unicode');
    }
  }
}

function canonicalizeJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), 'JCS numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  assert.ok(value !== null && typeof value === 'object', 'JCS input contains an unsupported type');
  assert.ok(!ancestors.has(value), 'JCS input must not contain cycles');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assert.ok(Object.hasOwn(value, index), 'JCS arrays must not be sparse');
    }
    result = `[${value.map((entry) => canonicalizeJson(entry, ancestors)).join(',')}]`;
  } else {
    assert.ok(isPlainRecord(value), 'JCS objects must be plain JSON objects');
    const entries = Object.keys(value).sort().map((key) => {
      assertWellFormedUnicode(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert.ok(descriptor?.enumerable && !descriptor.get && !descriptor.set);
      return `${JSON.stringify(key)}:${canonicalizeJson(descriptor.value, ancestors)}`;
    });
    result = `{${entries.join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

function keyInput(scope, fields) {
  assert.ok(isPlainRecord(fields), `${scope} key_fields must be an object`);
  if (scope === 'inbound') {
    return ['zylos-idempotency-v1', scope, fields.region, fields.tenant_id, fields.channel,
      fields.bot_id, fields.inbound_event_id];
  }
  if (scope === 'scheduler') {
    return ['zylos-idempotency-v1', scope, fields.region, fields.tenant_id, fields.bot_id,
      fields.schedule_id, fields.occurrence_id];
  }
  if (scope === 'interaction') {
    return ['zylos-idempotency-v1', scope, fields.interaction_id, fields.source_event_or_action_id];
  }
  if (scope === 'control') {
    return ['zylos-idempotency-v1', scope, fields.caller_namespace, fields.control_id];
  }
  if (scope === 'delivery') {
    assert.ok(isPlainRecord(fields.target), 'delivery target must be an object');
    return ['zylos-idempotency-v1', scope, fields.channel, [
      fields.target.region,
      fields.target.tenant_id,
      fields.target.bot_id,
      fields.target.chat_type,
      fields.target.chat_id,
      fields.target.native_thread_or_topic_id,
    ], fields.delivery_id];
  }
  throw new TypeError(`unsupported idempotency scope: ${String(scope)}`);
}

function isTransient(scope, fieldName) {
  const normalized = fieldName.toLowerCase();
  return TRANSIENT_FIELDS.has(normalized)
    || (scope === 'delivery' && DELIVERY_TRANSIENT_FIELDS.has(normalized));
}

function projectValue(value, scope) {
  if (Array.isArray(value)) return value.map((entry) => projectValue(entry, scope));
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([fieldName]) => !isTransient(scope, fieldName))
      .map(([fieldName, fieldValue]) => [fieldName, projectValue(fieldValue, scope)]));
  }
  assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
  return value;
}

function projectRawPayload(vector) {
  assert.ok(isPlainRecord(vector.payload), `${vector.scope} payload must be an object`);
  assert.deepEqual(vector.decimal_paths, [], 'Dashboard has not reviewed decimal-path vectors');
  assert.ok(Array.isArray(vector.known_payload_fields) && vector.known_payload_fields.length > 0);
  assert.ok(Array.isArray(vector.optional_extension_fields));
  const knownFields = new Set(vector.known_payload_fields);
  const extensionFields = new Set(vector.optional_extension_fields);
  assert.equal(knownFields.size, vector.known_payload_fields.length);
  assert.equal(extensionFields.size, vector.optional_extension_fields.length);
  for (const fieldName of knownFields) assert.ok(Object.hasOwn(vector.payload, fieldName));
  for (const fieldName of extensionFields) {
    assert.ok(!knownFields.has(fieldName));
    assert.ok(Object.hasOwn(vector.payload, fieldName));
  }
  for (const fieldName of Object.keys(vector.payload)) {
    assert.ok(
      knownFields.has(fieldName) || extensionFields.has(fieldName) || isTransient(vector.scope, fieldName),
      `${vector.scope} payload field ${fieldName} is unclassified`,
    );
  }
  const knownPayload = Object.fromEntries(
    Object.entries(vector.payload).filter(([fieldName]) => knownFields.has(fieldName)),
  );
  return projectValue(knownPayload, vector.scope);
}

function proveRawComputations(fixture, assertionCounts) {
  assert.equal(fixture.fixture_version, '1.0');
  assert.ok(Array.isArray(fixture.vectors) && fixture.vectors.length > 0);
  const computations = {
    jcs_bytes_from_raw_payload: 0,
    idempotency_key_from_raw_payload: 0,
    payload_hash_from_raw_payload: 0,
  };
  for (const vector of fixture.vectors) {
    if (vector.scope === 'legacy-c4') {
      assert.equal(vector.idempotency_key, `legacy-c4:${vector.key_fields.legacy_record_id}`);
      computations.idempotency_key_from_raw_payload += 1;
    } else {
      const derivedInput = keyInput(vector.scope, vector.key_fields);
      const derivedInputJcs = canonicalizeJson(derivedInput);
      computations.jcs_bytes_from_raw_payload += 1;
      const digest = crypto.createHash('sha256')
        .update(Buffer.from(derivedInputJcs, 'utf8'))
        .digest('hex');
      assert.equal(`zid:v1:${vector.scope}:${digest}`, vector.idempotency_key);
      computations.idempotency_key_from_raw_payload += 1;
    }

    const projection = projectRawPayload(vector);
    const projectionJcs = canonicalizeJson(projection);
    computations.jcs_bytes_from_raw_payload += 1;
    const payloadHash = crypto.createHash('sha256')
      .update(Buffer.from(projectionJcs, 'utf8'))
      .digest('hex');
    assert.equal(payloadHash, vector.payload_hash);
    computations.payload_hash_from_raw_payload += 1;
  }
  for (const assertion of Object.keys(computations)) {
    assert.ok(computations[assertion] > 0);
    assertionCounts[assertion] = computations[assertion];
  }
  return computations;
}

function record(counts, name, check) {
  check();
  counts[name] = (counts[name] || 0) + 1;
}

function createAdapter(source) {
  const capability = source.actor.capabilities[0];
  return new OperationsAuthorizationAdapter({
    callerNamespace: source.caller_namespace,
    policy: {
      policy_id: capability.policy_id,
      policy_version: capability.policy_version,
      state: 'active',
      grants: [{
        grant_id: capability.grant_id,
        subject: { type: source.actor.type, subject_id: source.actor.actor_id },
        capability: capability.capability,
        scope: capability.scope,
        state: 'active',
        expires_at: capability.expires_at,
        policy_version: capability.policy_version,
      }],
    },
    now: () => source.created_at,
    generateId: (kind) => kind === 'trace' ? source.trace_id : source.control_id,
  });
}

function buildControlRequest(source) {
  return createAdapter(source).createRequest({
    source: source.auth_context.source,
    type: source.actor.type,
    subject_id: source.actor.actor_id,
    roles: source.actor.roles,
    authenticated_at: source.auth_context.authenticated_at,
  }, {
    control_id: source.control_id,
    action: source.action,
    target: source.target,
    expected_version: source.expected_version,
    reason: source.reason,
  });
}

function proveAssertions(observability, control, assertionCounts) {
  record(assertionCounts, 'required_null_optional', () => {
    assert.equal(validateRuntimeSnapshot(observability.cases.complete).error, null);
    const missingRequired = structuredClone(observability.cases.complete);
    delete missingRequired.error;
    assert.throws(() => validateRuntimeSnapshot(missingRequired), { code: 'invalid_snapshot' });
    const inspect = buildControlRequest(control.requests.inspect);
    assert.equal(inspect.expected_version, null);
  });
  record(assertionCounts, 'major_rejection', () => {
    const snapshot = structuredClone(observability.cases.complete);
    snapshot.contract_version = '2.0';
    assert.throws(() => validateRuntimeSnapshot(snapshot), { code: 'unsupported_contract_version' });
    const result = structuredClone(control.results.stop_completed);
    result.contract_version = '2.0';
    assert.throws(() => validateOperationsControlResult(result, { action: 'stop_active_turn' }));
  });
  record(assertionCounts, 'minor_additive_compatibility', () => {
    const snapshot = structuredClone(observability.cases.complete);
    snapshot.contract_version = '1.9';
    snapshot.future_optional = { display_hint: 'compact' };
    assert.equal(validateRuntimeSnapshot(snapshot).future_optional.display_hint, 'compact');
    const result = structuredClone(control.results.forbidden_policy);
    result.contract_version = '1.9';
    result.future_optional = { retry_hint: 'manual' };
    assert.equal(validateOperationsControlResult(result).future_optional.retry_hint, 'manual');
  });
  record(assertionCounts, 'unknown_safety_terminal_enum_rejection', () => {
    const unknownStatus = structuredClone(control.results.stop_completed);
    unknownStatus.status = 'future_terminal';
    assert.throws(() => validateOperationsControlResult(unknownStatus, { action: 'stop_active_turn' }));
    const unknownSideEffect = structuredClone(control.results.forbidden_policy);
    unknownSideEffect.error.side_effect_status = 'future_unknown';
    assert.throws(() => validateOperationsControlResult(unknownSideEffect));
  });
  record(assertionCounts, 'public_error_shape', () => {
    assert.equal(validateOperationsControlResult(control.results.forbidden_policy).status, 'forbidden');
    const malformed = structuredClone(control.results.forbidden_policy);
    malformed.error.retryable = 'yes';
    assert.throws(() => validateOperationsControlResult(malformed));
  });
  record(assertionCounts, 'version_conflict', () => {
    const snapshots = new RuntimeSnapshotConsumer();
    assert.equal(snapshots.apply(observability.cases.complete).status, 'initial');
    const conflictingSnapshot = structuredClone(observability.cases.complete);
    conflictingSnapshot.service.health = 'degraded';
    assert.deepEqual(snapshots.apply(conflictingSnapshot), { status: 'conflict', apply: false });

    const results = new OperationsControlResultStore();
    results.apply(control.results.reconcile_accepted, { action: 'reconcile' });
    results.apply(control.results.reconcile_completed, { action: 'reconcile' });
    const conflictingResult = structuredClone(control.results.reconcile_completed);
    conflictingResult.target_version += 1;
    assert.throws(
      () => results.apply(conflictingResult, { action: 'reconcile' }),
      { code: 'version_conflict' },
    );
  });
}

function proveEventsFlow(normalizedEvents, observability, flowCounts) {
  const deliveryUnknown = normalizedEvents.kind_cases.find(
    ({ kind }) => kind === 'interaction_answer_delivery_unknown',
  );
  assert.ok(deliveryUnknown);
  const eventDerivedSnapshot = structuredClone(observability.cases.complete);
  eventDerivedSnapshot.snapshot_id = 'snapshot-derived-from-normalized-event';
  eventDerivedSnapshot.snapshot_version += 1;
  const [eventDerivedTurn] = eventDerivedSnapshot.turns.items;
  eventDerivedTurn.turn_version = deliveryUnknown.turn_version;
  eventDerivedTurn.state = deliveryUnknown.phase;
  eventDerivedTurn.phase = deliveryUnknown.phase;
  eventDerivedTurn.side_effect_status = deliveryUnknown.error.side_effect_status;
  eventDerivedTurn.error = structuredClone(deliveryUnknown.error);
  const consumer = new RuntimeSnapshotConsumer();
  record(flowCounts, 'events', () => {
    assert.equal(consumer.apply(eventDerivedSnapshot).apply, true);
  });
  record(flowCounts, 'events', () => {
    const publicView = consumer.getPublic().snapshot;
    const [projectedTurn] = publicView.turns.items;
    assert.equal(projectedTurn.turn_version, deliveryUnknown.turn_version);
    assert.equal(projectedTurn.phase, deliveryUnknown.phase);
    assert.equal(projectedTurn.state, deliveryUnknown.phase);
  });
  record(flowCounts, 'events', () => {
    const [projectedTurn] = consumer.getPublic().snapshot.turns.items;
    assert.equal(projectedTurn.error.code, deliveryUnknown.error.code);
    assert.equal(projectedTurn.side_effect_status, deliveryUnknown.error.side_effect_status);
  });
  record(flowCounts, 'events', () => {
    const publicView = consumer.getPublic().snapshot;
    assert.equal(publicView.executors.items[0].provider_native_id, undefined);
    assert.equal(publicView.executors.items[0].runtime_identity, undefined);
  });
  record(flowCounts, 'events', () => {
    const unsafe = structuredClone(eventDerivedSnapshot);
    unsafe.turns.items[0].provider_payload = { event: deliveryUnknown };
    assert.throws(() => new RuntimeSnapshotConsumer().apply(unsafe), { code: 'unsafe_snapshot' });
  });
}

function proveObservabilityControlFlow(observability, control, flowCounts) {
  const consumer = new RuntimeSnapshotConsumer();
  record(flowCounts, 'observability_control', () => {
    assert.equal(consumer.apply(observability.cases.complete).status, 'initial');
  });
  record(flowCounts, 'observability_control', () => {
    assert.equal(consumer.apply(observability.cases.degraded).status, 'replace');
    assert.equal(consumer.get().snapshot.outbox.complete, false);
  });
  record(flowCounts, 'observability_control', () => {
    assert.equal(consumer.apply(observability.cases.replacement_instance).status, 'replace_instance');
  });
  for (const source of Object.values(control.requests)) {
    record(flowCounts, 'observability_control', () => {
      const built = buildControlRequest(source);
      assert.equal(built.idempotency_key, source.idempotency_key, source.action);
      assert.deepEqual(built.target, source.target, source.action);
      assert.deepEqual(built.expected_version, source.expected_version, source.action);
    });
  }
  for (const [name, result] of Object.entries(control.results)) {
    record(flowCounts, 'observability_control', () => {
      const action = name.startsWith('stop_') ? 'stop_active_turn'
        : name.startsWith('reconcile_') ? 'reconcile' : undefined;
      assert.equal(validateOperationsControlResult(result, { action }).status, result.status);
    });
  }
}

function proveDashboardLunaProjectionFlow(observability, projections, flowCounts) {
  const consumer = new RuntimeSnapshotConsumer();
  const update = consumer.apply(observability.cases.complete);
  const publisher = new RuntimeProjectionPublisher({ dashboardInstanceId: 'dashboard-evidence' });
  record(flowCounts, 'dashboard_luna_projection', () => {
    assert.equal(publisher.publish(consumer.get().snapshot, update).apply, true);
    assert.equal(publisher.get().runtimes[0].active_turn_state, 'recovering');
    assert.equal(publisher.get().runtimes[0].side_effect_status, 'unknown');
    assert.equal(publisher.get().capabilities.control, false);
    assert.equal(publisher.get().capabilities.core_direct_access, false);
  });
  const filter = createLunaProjectionEventFilter();
  record(flowCounts, 'dashboard_luna_projection', () => {
    assert.equal(filter.accepts('runtime_projection', projections.cases.initial_full), true);
  });
  record(flowCounts, 'dashboard_luna_projection', () => {
    assert.equal(filter.accepts('runtime_projection', projections.cases.next), true);
  });
  record(flowCounts, 'dashboard_luna_projection', () => {
    assert.equal(filter.accepts('runtime_projection', projections.cases.gap), false);
    assert.equal(filter.isReady(), false);
  });
  record(flowCounts, 'dashboard_luna_projection', () => {
    assert.equal(filter.accepts('runtime_projection', projections.cases.replacement_instance), true);
    assert.equal(filter.isReady(), true);
  });
}

export function createCompatibilityEvidence() {
  const directory = coreContractsDirectory();
  const fixtureSet = loadFixtureSet(directory);
  const observability = readFixture(fixtureSet.fixtures, 'observability-v1.json');
  const control = readFixture(fixtureSet.fixtures, 'control-v1.json');
  const projections = readFixture(fixtureSet.fixtures, 'dashboard-runtime-projection-v1.json');
  const normalizedEvents = readFixture(fixtureSet.fixtures, 'normalized-event-v1.json');
  const idempotency = readFixture(fixtureSet.fixtures, 'idempotency-v1.json');
  const assertionCounts = {};
  const flowCounts = {};

  proveAssertions(observability, control, assertionCounts);
  const computations = proveRawComputations(idempotency, assertionCounts);
  proveEventsFlow(normalizedEvents, observability, flowCounts);
  proveObservabilityControlFlow(observability, control, flowCounts);
  proveDashboardLunaProjectionFlow(observability, projections, flowCounts);

  assert.deepEqual(Object.keys(assertionCounts), ASSERTIONS);
  assert.deepEqual(Object.keys(flowCounts), FLOWS);
  for (const count of Object.values(assertionCounts)) assert.ok(Number.isSafeInteger(count) && count > 0);
  for (const count of Object.values(flowCounts)) assert.ok(Number.isSafeInteger(count) && count > 0);
  return {
    schema_version: 1,
    repository: 'zylos-dashboard',
    core_fixture_sha256: fixtureSet.sha256,
    assertions: [...ASSERTIONS],
    flows: [...FLOWS],
    assertion_counts: assertionCounts,
    flow_counts: flowCounts,
    computations,
  };
}
