const CONTRACT = 'zylos.observability-snapshot';
const SUPPORTED_MAJOR = 1;
const REQUIRED_SECTIONS = Object.freeze([
  'service', 'executors', 'turns', 'interactions', 'workspace_leases', 'outbox', 'audit_summary'
]);
const SECRET_FIELD = /(?:^|_)(?:secret|token|password|credential|authorization|cookie|signature|api_key|private_key|access_key)(?:_|$)/i;
const PRIVATE_FIELD = /^(?:raw_provider|raw_channel|provider_payload|channel_payload|provider_private|channel_private)(?:_|$)/i;
const SECRET_VALUE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bzylos_(?:ak|st)_[A-Za-z0-9_-]+\b/,
  /\b(?:sk|rk)_[A-Za-z0-9_-]{16,}\b/
];

export class RuntimeSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeSnapshotError';
    this.code = code;
  }
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
  return structuredClone(value);
}

function assertSafe(value, path = 'snapshot', ancestors = new Set()) {
  if (typeof value === 'string') {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) {
      throw new RuntimeSnapshotError('unsafe_snapshot', `${path} contains secret-shaped content.`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value)) throw new RuntimeSnapshotError('invalid_snapshot', `${path} contains a cycle.`);
  ancestors.add(value);
  for (const [field, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(field) || PRIVATE_FIELD.test(field)) {
      throw new RuntimeSnapshotError('unsafe_snapshot', `${path}.${field} is not a public observability field.`);
    }
    assertSafe(child, `${path}.${field}`, ancestors);
  }
  ancestors.delete(value);
}

function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeSnapshotError('invalid_snapshot', `${path} must be an object.`);
  }
}

function assertCompleteness(section, path) {
  assertRecord(section, path);
  if (typeof section.complete !== 'boolean') {
    throw new RuntimeSnapshotError('invalid_snapshot', `${path}.complete must be boolean.`);
  }
  if (section.complete !== (section.error === null)) {
    throw new RuntimeSnapshotError('invalid_snapshot', `${path} must pair complete with error.`);
  }
}

function assertCollection(section, path) {
  assertCompleteness(section, path);
  if (!Array.isArray(section.items)) {
    throw new RuntimeSnapshotError('invalid_snapshot', `${path}.items must be an array.`);
  }
}

export function validateRuntimeSnapshot(value) {
  assertRecord(value, 'snapshot');
  assertSafe(value);
  if (value.contract !== CONTRACT) {
    throw new RuntimeSnapshotError('unsupported_contract', 'Unsupported runtime snapshot contract.');
  }
  const version = /^([0-9]+)\.([0-9]+)$/.exec(String(value.contract_version || ''));
  if (!version || Number(version[1]) !== SUPPORTED_MAJOR) {
    throw new RuntimeSnapshotError('unsupported_contract_version', 'Unsupported runtime snapshot contract version.');
  }
  for (const field of ['snapshot_id', 'core_service_instance_id', 'generated_at']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new RuntimeSnapshotError('invalid_snapshot', `snapshot.${field} must be a non-empty string.`);
    }
  }
  if (!Number.isInteger(value.snapshot_version) || value.snapshot_version < 1) {
    throw new RuntimeSnapshotError('invalid_snapshot', 'snapshot.snapshot_version must be a positive integer.');
  }
  assertCompleteness(value.service, 'snapshot.service');
  if (value.service.service_instance_id !== value.core_service_instance_id) {
    throw new RuntimeSnapshotError('invalid_snapshot', 'snapshot.service.service_instance_id must match Core instance.');
  }
  for (const section of ['executors', 'turns', 'interactions', 'workspace_leases', 'audit_summary']) {
    assertCollection(value[section], `snapshot.${section}`);
  }
  assertCollection(value.outbox, 'snapshot.outbox');
  if (!Number.isInteger(value.outbox.retry_count) || !Number.isInteger(value.outbox.dead_letter_count)) {
    throw new RuntimeSnapshotError('invalid_snapshot', 'snapshot.outbox counters must be integers.');
  }
  const degraded = REQUIRED_SECTIONS.some((name) => !value[name].complete);
  if (degraded !== (value.error !== null)) {
    throw new RuntimeSnapshotError('invalid_snapshot', 'snapshot error must reflect collection completeness.');
  }
  return clone(value);
}

export class RuntimeSnapshotConsumer {
  #snapshot = null;
  #update = { status: 'unavailable', apply: false, requires_full: true };

  apply(value) {
    const next = validateRuntimeSnapshot(value);
    const current = this.#snapshot;
    const nextDegraded = next.error !== null;
    let result;
    if (!current) {
      result = nextDegraded
        ? { status: 'initial_degraded', apply: false, requires_full: true }
        : { status: 'initial', apply: true };
    } else if (current.core_service_instance_id !== next.core_service_instance_id) {
      result = nextDegraded
        ? { status: 'replace_instance_degraded', apply: false, requires_full: true }
        : { status: 'replace_instance', apply: true };
    } else if (next.snapshot_version > current.snapshot_version) {
      result = { status: 'replace', apply: true };
    } else if (next.snapshot_version < current.snapshot_version) {
      result = { status: 'obsolete', apply: false };
    } else if (jsonEqual(current, next)) {
      result = { status: 'duplicate', apply: false };
    } else {
      result = { status: 'conflict', apply: false };
    }
    if (result.apply) this.#snapshot = next;
    this.#update = result;
    return clone(result);
  }

  get() {
    return Object.freeze({ snapshot: this.#snapshot ? clone(this.#snapshot) : null, update: clone(this.#update) });
  }

  // Browser/SSE consumers never receive process or provider-native identities.
  // They are not health, lease, stop, or user-state authority.
  getPublic() {
    const view = this.get();
    if (!view.snapshot) return view;
    for (const executor of view.snapshot.executors.items) {
      delete executor.provider_native_id;
      delete executor.runtime_identity;
    }
    return view;
  }
}
