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

const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isValidRfc3339Timestamp(value) {
  const match = typeof value === 'string' ? RFC3339_PATTERN.exec(value) : null;
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  return month >= 1 && month <= 12
    && day >= 1 && day <= (days[month - 1] ?? 0)
    && Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 60
    && zoneHour <= 23
    && zoneMinute <= 59;
}
