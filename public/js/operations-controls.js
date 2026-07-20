import {
  OPERATIONS_ACTION_DEFINITIONS,
  OPERATIONS_CONTROL_STATUSES,
  OPERATIONS_TARGET_IDENTITIES,
} from './operations-control-contract.js';

const KNOWN_STATUSES = new Set(OPERATIONS_CONTROL_STATUSES);

function targetIdentity(target) {
  return target[OPERATIONS_TARGET_IDENTITIES[target.aggregate_type]];
}

function exactTarget(action, target) {
  const definition = OPERATIONS_ACTION_DEFINITIONS[action];
  const fields = definition?.targets?.[target?.aggregate_type];
  if (!fields) throw new TypeError('The action target is not supported by the Core v1 contract.');
  const expected = ['aggregate_type', ...fields];
  if (Object.keys(target).length !== expected.length || !expected.every((field) => Object.hasOwn(target, field))) {
    throw new TypeError('The action target does not match the Core v1 shape.');
  }
  return definition;
}

export function buildOperationsControlInput({ action, target, expectedVersion, reason }) {
  const definition = exactTarget(action, target);
  const identity = targetIdentity(target);
  const expected_version = expectedVersion === null
    ? null
    : { aggregate_type: target.aggregate_type, aggregate_id: identity, version: expectedVersion };
  if (definition.mutable && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
    throw new TypeError('A positive current aggregate version is required for mutations.');
  }
  if (!definition.mutable && expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
    throw new TypeError('The inspect aggregate version must be null or positive.');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError('A redacted operations reason is required.');
  }
  return { action, target: structuredClone(target), expected_version, reason: reason.trim() };
}

export function controlResultPresentation(result) {
  const status = KNOWN_STATUSES.has(result?.status) ? result.status : 'unknown';
  const detail = [];
  if (Number.isSafeInteger(result?.control_result_version)) detail.push(`result v${result.control_result_version}`);
  if (Number.isSafeInteger(result?.previous_target_version)) detail.push(`target ${result.previous_target_version}→${result.target_version}`);
  if (result?.audit_id) detail.push(`audit ${result.audit_id}`);
  if (result?.error?.user_message) detail.push(result.error.user_message);
  return {
    status,
    terminal: status !== 'accepted',
    tone: ['completed', 'noop'].includes(status) ? 'success' : status === 'accepted' ? 'pending' : 'error',
    detail: detail.join(' · ') || 'No trusted Core result is available.',
    result: result ? structuredClone(result) : null,
  };
}

export async function submitOperationsControl({
  fetchImpl = globalThis.fetch,
  basePath = '',
  input,
  onUpdate = () => {},
  pollDelay = () => new Promise((resolve) => setTimeout(resolve, 750)),
  maxPolls = 40,
} = {}) {
  const endpoint = `${basePath}/api/runtime-controls`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  let view = controlResultPresentation(body?.result);
  if (!response.ok && !body?.result) {
    view = controlResultPresentation({ status: 'unknown', error: { user_message: body?.message || body?.error || `HTTP ${response.status}` } });
  }
  onUpdate(view);
  if (view.terminal || !view.result?.control_id) return view;

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    await pollDelay();
    const poll = await fetchImpl(`${endpoint}/${encodeURIComponent(view.result.control_id)}`, { cache: 'no-store' });
    let pollBody;
    try { pollBody = await poll.json(); } catch { pollBody = null; }
    view = controlResultPresentation(pollBody?.result);
    if (!poll.ok && !pollBody?.result) {
      view = controlResultPresentation({ status: 'unknown', error: { user_message: pollBody?.message || pollBody?.error || `HTTP ${poll.status}` } });
    }
    onUpdate(view);
    if (view.terminal) return view;
  }
  const timeoutView = controlResultPresentation({ status: 'unknown', error: { user_message: 'Timed out waiting for Core control completion.' } });
  onUpdate(timeoutView);
  return timeoutView;
}
