export function completeSnapshot({ instance = 'core-A', version = 1 } = {}) {
  return {
    contract: 'zylos.observability-snapshot',
    contract_version: '1.0',
    snapshot_id: `snapshot-${instance}-${version}`,
    core_service_instance_id: instance,
    generated_at: '2026-07-20T00:00:00Z',
    snapshot_version: version,
    service: { complete: true, service_version: 1, health: 'healthy', maintenance: false, draining: false, reconciling: false, host_id: 'host-A', service_instance_id: instance, started_at: '2026-07-20T00:00:00Z', last_reconciliation_at: null, error: null },
    executors: { complete: true, items: [{ conversation_id: 'conversation-A', executor_instance_id: 'executor-A', provider: 'claude', provider_native_id: 'provider-session-A', health: 'healthy', active_turn_id: 'turn-A', queue_length: 2, wait_reason: 'interaction_delivery_unknown', lease: { owner: 'lease-A', expires_at: '2026-07-20T00:01:00Z', epoch: 2 }, runtime_identity: { diagnostic_only: true, pid: 4242, pgid: 4242, process_start_time: '2026-07-20T00:00:00Z' } }], error: null },
    turns: { complete: true, items: [{ turn_id: 'turn-A', conversation_id: 'conversation-A', state: 'recovering', phase: 'recovering', retry_count: 1, queue_position: 2, recovery_of_turn_id: null, side_effect_status: 'unknown', error: { code: 'delivery_unknown' } }], error: null },
    interactions: { complete: true, items: [{ interaction_id: 'interaction-A', kind: 'tool_approval', state: 'delivery_unknown', handoff_state: 'delivery_unknown', handoff_deadline_at: '2026-07-20T00:05:00Z', authorized_subject_summary: { actor_count: 1, capability_count: 1 } }], error: null },
    workspace_leases: { complete: true, items: [{ workspace_root: '/workspace/A', mode: 'write', holder_conversation_id: 'conversation-A', holder_turn_id: 'turn-A', expires_at: '2026-07-20T00:01:00Z', epoch: 2, waiter_count: 3 }], error: null },
    outbox: { complete: true, items: [{ channel: 'lark', status: 'dead_letter', count: 1, oldest_age_seconds: 42 }], retry_count: 2, dead_letter_count: 1, error: null },
    audit_summary: { complete: true, items: [{ category: 'recovery', count: 1, last_committed_at: '2026-07-20T00:00:00Z' }], error: null },
    error: null
  };
}
