const CONTROL_STATUSES = new Set([
  'accepted', 'completed', 'noop', 'conflict', 'forbidden', 'not_found', 'failed',
]);
const SECRET_FIELD = /(?:^|_)(?:secret|token|password|credential|authorization|cookie|signature|api_key|private_key|access_key)(?:_|$)/i;
const SECRET_VALUE = /\b(?:zylos_(?:ak|st)_[A-Za-z0-9_-]+|(?:sk|rk)_[A-Za-z0-9_-]{16,})\b/;

const ACTION_SHAPES = Object.freeze({
  inspect: { target: { conversation: ['conversation_id'], service: ['service_instance_id'], turn: ['turn_id'], executor: ['executor_instance_id'], queue: ['conversation_id'], recovery: ['recovery_id'] }, result: ['snapshot'] },
  stop_active_turn: { target: { turn: ['conversation_id', 'turn_id'] }, result: ['winner', 'active_turn_id', 'active_turn_version', 'priority_turn_created', 'priority_turn_cancelled'] },
  clear_unstarted_queue: { target: { queue: ['conversation_id', 'through_queue_sequence'] }, result: ['cleared_turn_ids', 'through_queue_sequence'] },
  reconcile: { target: { service: ['service_instance_id'] }, result: ['intent_id', 'state'] },
  evict_idle_executor: { target: { executor: ['conversation_id', 'executor_instance_id'] }, result: ['evicted', 'executor_instance_id'] },
  confirm_recovery: { target: { recovery: ['recovery_id', 'conversation_id', 'turn_id'] }, result: ['decision', 'recovery_turn_id'] },
  reject_recovery: { target: { recovery: ['recovery_id', 'conversation_id', 'turn_id'] }, result: ['decision', 'recovery_turn_id'] },
});

export class OperationsControlError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'OperationsControlError';
    this.code = code;
    this.status = status;
  }
}

function assertSafe(value, path = 'control_result', ancestors = new Set()) {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) {
      throw new OperationsControlError('unsafe_control_result', `${path} contains secret-shaped content.`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value)) {
    throw new OperationsControlError('invalid_control_result', `${path} contains a cycle.`);
  }
  ancestors.add(value);
  for (const [field, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(field)) {
      throw new OperationsControlError('unsafe_control_result', `${path}.${field} is not public.`);
    }
    assertSafe(child, `${path}.${field}`, ancestors);
  }
  ancestors.delete(value);
}

function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationsControlError('invalid_control_result', `${path} must be an object.`);
  }
}

function exactFields(value, fields) {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function validateActionShape(value, action) {
  const definition = ACTION_SHAPES[action];
  if (!definition) throw new OperationsControlError('invalid_control_result', 'Unknown requested action.');
  const targetFields = definition.target[value.target.aggregate_type];
  if (!targetFields || !exactFields(value.target, ['aggregate_type', ...targetFields])) {
    throw new OperationsControlError('invalid_control_result', `Target does not match ${action}.`);
  }
  if (value.result !== null && !exactFields(value.result, definition.result)) {
    throw new OperationsControlError('invalid_control_result', `Result does not match ${action}.`);
  }
  const id = (candidate) => typeof candidate === 'string' && candidate.length > 0;
  const integer = (candidate) => Number.isSafeInteger(candidate) && candidate >= 1;
  for (const [field, candidate] of Object.entries(value.target)) {
    if (field === 'aggregate_type') continue;
    if (field === 'through_queue_sequence' ? !integer(candidate) : !id(candidate)) {
      throw new OperationsControlError('invalid_control_result', `Target ${field} is invalid.`);
    }
  }
  if (value.result === null) return;
  if (action === 'stop_active_turn' && !['stop', 'steer'].includes(value.result?.winner)) {
    throw new OperationsControlError('invalid_control_result', 'Stop winner is invalid.');
  }
  if (action === 'stop_active_turn' && (!id(value.result.active_turn_id)
    || !integer(value.result.active_turn_version)
    || typeof value.result.priority_turn_created !== 'boolean'
    || typeof value.result.priority_turn_cancelled !== 'boolean')) {
    throw new OperationsControlError('invalid_control_result', 'Stop result fields are invalid.');
  }
  if (action === 'inspect' && (!value.result.snapshot || typeof value.result.snapshot !== 'object' || Array.isArray(value.result.snapshot))) {
    throw new OperationsControlError('invalid_control_result', 'Inspect snapshot is invalid.');
  }
  if (action === 'clear_unstarted_queue' && (!Array.isArray(value.result.cleared_turn_ids)
    || value.result.cleared_turn_ids.some((turnId) => !id(turnId))
    || !integer(value.result.through_queue_sequence))) {
    throw new OperationsControlError('invalid_control_result', 'Queue clear result fields are invalid.');
  }
  if (action === 'reconcile' && !['pending', 'completed'].includes(value.result?.state)) {
    throw new OperationsControlError('invalid_control_result', 'Reconciliation state is invalid.');
  }
  if (action === 'reconcile' && !id(value.result.intent_id)) {
    throw new OperationsControlError('invalid_control_result', 'Reconciliation intent ID is invalid.');
  }
  if (action === 'evict_idle_executor' && (typeof value.result.evicted !== 'boolean' || !id(value.result.executor_instance_id))) {
    throw new OperationsControlError('invalid_control_result', 'Eviction result fields are invalid.');
  }
  if (action === 'confirm_recovery' && value.result?.decision !== 'confirmed') {
    throw new OperationsControlError('invalid_control_result', 'Recovery decision is invalid.');
  }
  if (action === 'reject_recovery' && value.result?.decision !== 'rejected') {
    throw new OperationsControlError('invalid_control_result', 'Recovery decision is invalid.');
  }
  if (['confirm_recovery', 'reject_recovery'].includes(action)
    && value.result.recovery_turn_id !== null && !id(value.result.recovery_turn_id)) {
    throw new OperationsControlError('invalid_control_result', 'Recovery turn ID is invalid.');
  }
}

export function validateOperationsControlResult(value, { action } = {}) {
  assertRecord(value, 'control_result');
  assertSafe(value);
  const required = [
    'contract', 'contract_version', 'trace_id', 'caller_namespace', 'control_id',
    'control_result_version', 'status', 'target', 'previous_target_version',
    'target_version', 'audit_id', 'result', 'error', 'accepted_at', 'completed_at',
  ];
  if (!required.every((field) => Object.hasOwn(value, field))) {
    throw new OperationsControlError('invalid_control_result', 'Control result is missing required fields.');
  }
  if (value.contract !== 'zylos.control-result' || !/^1\.[0-9]+$/.test(value.contract_version)) {
    throw new OperationsControlError('invalid_control_result', 'Unsupported control result contract.');
  }
  if (!CONTROL_STATUSES.has(value.status)) {
    throw new OperationsControlError('invalid_control_result', 'Unknown control result status.');
  }
  for (const field of ['trace_id', 'caller_namespace', 'control_id']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new OperationsControlError('invalid_control_result', `${field} must be a non-empty string.`);
    }
  }
  if (!Number.isSafeInteger(value.control_result_version) || value.control_result_version < 1) {
    throw new OperationsControlError('invalid_control_result', 'control_result_version must be positive.');
  }
  assertRecord(value.target, 'control_result.target');
  const success = ['accepted', 'completed', 'noop'].includes(value.status);
  if (success !== (value.error === null)) {
    throw new OperationsControlError('invalid_control_result', 'Control result error does not match status.');
  }
  if (success) {
    assertRecord(value.result, 'control_result.result');
    if (!Number.isSafeInteger(value.previous_target_version)
      || !Number.isSafeInteger(value.target_version)
      || value.target_version < value.previous_target_version) {
      throw new OperationsControlError('invalid_control_result', 'Successful target versions are invalid.');
    }
    if (typeof value.accepted_at !== 'string' || !Number.isFinite(Date.parse(value.accepted_at))) {
      throw new OperationsControlError('invalid_control_result', 'Successful controls require accepted_at.');
    }
  } else {
    assertRecord(value.error, 'control_result.error');
    for (const candidate of [value.previous_target_version, value.target_version]) {
      if (candidate !== null && (!Number.isSafeInteger(candidate) || candidate < 1)) {
        throw new OperationsControlError('invalid_control_result', 'Failed target versions are invalid.');
      }
    }
  }
  if (value.status === 'accepted'
    ? value.completed_at !== null
    : (typeof value.completed_at !== 'string' || !Number.isFinite(Date.parse(value.completed_at)))) {
    throw new OperationsControlError('invalid_control_result', 'completed_at does not match status.');
  }
  if ((['conflict', 'forbidden'].includes(value.status) || (action && action !== 'inspect'))
    && (typeof value.audit_id !== 'string' || value.audit_id.length === 0)) {
    throw new OperationsControlError('invalid_control_result', 'This control result requires an audit ID.');
  }
  if (value.audit_id !== null && (typeof value.audit_id !== 'string' || value.audit_id.length === 0)) {
    throw new OperationsControlError('invalid_control_result', 'audit_id is invalid.');
  }
  if (action) validateActionShape(value, action);
  return structuredClone(value);
}

function resultKey(value) {
  return `${value.caller_namespace}\u0000${value.control_id}`;
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class OperationsControlResultStore {
  #results = new Map();
  #actions = new Map();

  apply(value, { action } = {}) {
    const rawKey = `${value?.caller_namespace}\u0000${value?.control_id}`;
    const effectiveAction = action || this.#actions.get(rawKey);
    const next = validateOperationsControlResult(value, { action: effectiveAction });
    const key = resultKey(next);
    const current = this.#results.get(key);
    if (!current) {
      this.#results.set(key, next);
      if (effectiveAction) this.#actions.set(key, effectiveAction);
      return { status: 'applied', apply: true, result: structuredClone(next) };
    }
    if (next.control_result_version > current.control_result_version) {
      const identityChanged = current.trace_id !== next.trace_id
        || JSON.stringify(current.target) !== JSON.stringify(next.target)
        || current.previous_target_version !== next.previous_target_version
        || current.audit_id !== next.audit_id
        || current.accepted_at !== next.accepted_at
        || (effectiveAction === 'reconcile' && current.result?.intent_id !== next.result?.intent_id);
      const targetRegressed = current.target_version !== null
        && (next.target_version === null || next.target_version < current.target_version);
      if (identityChanged || targetRegressed || current.status !== 'accepted' || next.status === 'accepted') {
        throw new OperationsControlError(
          'version_conflict',
          'Control result update violated the accepted intent or terminal fence.',
          409,
        );
      }
      this.#results.set(key, next);
      if (effectiveAction) this.#actions.set(key, effectiveAction);
      return { status: 'applied', apply: true, result: structuredClone(next) };
    }
    if (next.control_result_version < current.control_result_version) {
      return { status: 'obsolete', apply: false, result: structuredClone(current) };
    }
    if (jsonEqual(current, next)) {
      return { status: 'duplicate', apply: false, result: structuredClone(current) };
    }
    throw new OperationsControlError(
      'version_conflict',
      'The same control result version carried a different payload.',
      409,
    );
  }

  get(callerNamespace, controlId) {
    const result = this.#results.get(`${callerNamespace}\u0000${controlId}`);
    return result ? structuredClone(result) : null;
  }
}

export class OperationsControlClient {
  constructor({ endpoint, fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    let parsed;
    try { parsed = new URL(endpoint); } catch {
      throw new OperationsControlError('invalid_transport', 'A valid Core operations transport URL is required.', 503);
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || (parsed.protocol === 'http:' && !loopback)
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new OperationsControlError(
        'invalid_transport',
        'Core operations transport must be HTTPS or loopback HTTP and must not embed credentials or authority.',
        503,
      );
    }
    this.endpoint = parsed.href.replace(/\/$/, '');
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  async submit(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      throw new OperationsControlError(
        'network_failure',
        error?.name === 'AbortError' ? 'Core operations transport timed out.' : 'Core operations transport is unavailable.',
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      throw new OperationsControlError('authentication_failure', 'Core rejected the trusted transport.', response.status);
    }
    if (!response.ok) {
      throw new OperationsControlError('transport_failure', `Core operations transport returned HTTP ${response.status}.`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new OperationsControlError('invalid_control_result', 'Core returned non-JSON control data.');
    }
    return validateOperationsControlResult(body, { action: request.action });
  }

  async getResult(callerNamespace, controlId) {
    const url = `${this.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(callerNamespace)}/${encodeURIComponent(controlId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new OperationsControlError(
        'network_failure',
        error?.name === 'AbortError' ? 'Core operations result poll timed out.' : 'Core operations result is unavailable.',
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      throw new OperationsControlError('authentication_failure', 'Core rejected the trusted transport.', response.status);
    }
    if (!response.ok) {
      throw new OperationsControlError('transport_failure', `Core operations result returned HTTP ${response.status}.`);
    }
    let body;
    try { body = await response.json(); } catch {
      throw new OperationsControlError('invalid_control_result', 'Core returned non-JSON control data.');
    }
    return validateOperationsControlResult(body);
  }
}
