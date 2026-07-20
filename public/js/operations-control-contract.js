function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const OPERATIONS_CONTROL_STATUSES = deepFreeze([
  'accepted', 'completed', 'noop', 'conflict', 'forbidden', 'not_found', 'failed',
]);

export const OPERATIONS_ACTION_DEFINITIONS = deepFreeze({
  inspect: { capability: 'runtime.inspect', mutable: false, targets: { service: ['service_instance_id'], conversation: ['conversation_id'], turn: ['turn_id'], executor: ['executor_instance_id'], queue: ['conversation_id'], recovery: ['recovery_id'] }, result: ['snapshot'] },
  stop_active_turn: { capability: 'turn.stop', mutable: true, targets: { turn: ['conversation_id', 'turn_id'] }, result: ['winner', 'active_turn_id', 'active_turn_version', 'priority_turn_created', 'priority_turn_cancelled'] },
  clear_unstarted_queue: { capability: 'queue.clear', mutable: true, targets: { queue: ['conversation_id', 'through_queue_sequence'] }, result: ['cleared_turn_ids', 'through_queue_sequence'] },
  reconcile: { capability: 'service.reconcile', mutable: true, targets: { service: ['service_instance_id'] }, result: ['intent_id', 'state'] },
  evict_idle_executor: { capability: 'executor.evict', mutable: true, targets: { executor: ['conversation_id', 'executor_instance_id'] }, result: ['evicted', 'executor_instance_id'] },
  confirm_recovery: { capability: 'recovery.decide', mutable: true, targets: { recovery: ['recovery_id', 'conversation_id', 'turn_id'] }, result: ['decision', 'recovery_turn_id'] },
  reject_recovery: { capability: 'recovery.decide', mutable: true, targets: { recovery: ['recovery_id', 'conversation_id', 'turn_id'] }, result: ['decision', 'recovery_turn_id'] },
});

export const OPERATIONS_TARGET_IDENTITIES = deepFreeze({
  service: 'service_instance_id',
  conversation: 'conversation_id',
  turn: 'turn_id',
  executor: 'executor_instance_id',
  queue: 'conversation_id',
  recovery: 'recovery_id',
});

const PUBLIC_SECRET_VALUE_PATTERNS = deepFreeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+\S+/i,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/,
  /\bzylos_(?:ak|st)_[A-Za-z0-9_-]+\b/,
  /\b(?:sk|rk)_[A-Za-z0-9_-]{16,}\b/,
]);

export function containsPublicSecretValue(value) {
  return typeof value === 'string'
    && PUBLIC_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}
