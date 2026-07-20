import { randomUUID } from 'node:crypto';

const CONTRACT = 'zylos.dashboard-runtime-projection';
const CONTRACT_VERSION = '1.0';
const SUPPORTED_FIELDS = Object.freeze([
  'service', 'runtimes', 'queue_length', 'wait_reason', 'side_effect_status',
]);
const SUPPORTED_STATES = Object.freeze([
  'received', 'queued', 'starting', 'running', 'waiting_user', 'redirecting',
  'recovering', 'completed', 'stopped', 'cancelled', 'interrupted', 'failed', 'timed_out',
]);

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function activeTurn(snapshot, executor) {
  return snapshot.turns.items.find((turn) => turn.turn_id === executor.active_turn_id) || null;
}

function degradationError(generatedAt, projectionId) {
  return {
    code: 'observability_degraded',
    category: 'storage',
    retryable: true,
    side_effect_status: 'unknown',
    user_message: 'Runtime observability is incomplete; unavailable state is not idle.',
    detail_ref: `diagnostic:${projectionId}`,
    occurred_at: generatedAt,
  };
}

function buildProjection(snapshot, dashboardInstanceId, projectionSequence) {
  const complete = snapshot.error === null;
  const projectionId = `projection-${dashboardInstanceId}-${projectionSequence}`;
  return {
    contract: CONTRACT,
    contract_version: CONTRACT_VERSION,
    projection_id: projectionId,
    dashboard_instance_id: dashboardInstanceId,
    projection_sequence: projectionSequence,
    generated_at: snapshot.generated_at,
    source_core_service_instance_id: snapshot.core_service_instance_id,
    source_snapshot_version: snapshot.snapshot_version,
    service: {
      health: snapshot.service.health,
      maintenance: snapshot.service.maintenance,
      reconciling: snapshot.service.reconciling,
      last_update_at: snapshot.service.last_reconciliation_at || snapshot.generated_at,
    },
    // Projection is intentionally constructed from an allowlist. It must not
    // forward Core process diagnostics, leases, native provider identity, or
    // any source collection that might be partial and misread as idle.
    runtimes: snapshot.executors.items.map((executor) => {
      const turn = activeTurn(snapshot, executor);
      return {
        runtime_id: `runtime-${executor.conversation_id}`,
        conversation_id: executor.conversation_id,
        display_label: `Conversation ${executor.conversation_id}`,
        provider: executor.provider,
        executor_health: executor.health,
        active_turn_state: turn?.state ?? null,
        queue_length: executor.queue_length,
        wait_reason: executor.wait_reason,
        side_effect_status: turn?.side_effect_status ?? null,
        last_changed_at: snapshot.generated_at,
      };
    }),
    capabilities: {
      supported_fields: [...SUPPORTED_FIELDS],
      supported_states: [...SUPPORTED_STATES],
      control: false,
      core_direct_access: false,
    },
    complete,
    error: complete ? null : degradationError(snapshot.generated_at, projectionId),
  };
}

export class RuntimeProjectionPublisher {
  #dashboardInstanceId;
  #projectionSequence = 0;
  #projection = null;

  constructor({ dashboardInstanceId = randomUUID() } = {}) {
    this.#dashboardInstanceId = dashboardInstanceId;
  }

  publish(snapshot, sourceUpdate) {
    if (!sourceUpdate?.apply && sourceUpdate?.status !== 'initial_degraded') {
      return { status: `source_${sourceUpdate?.status || 'unavailable'}`, apply: false };
    }
    this.#projectionSequence += 1;
    this.#projection = buildProjection(snapshot, this.#dashboardInstanceId, this.#projectionSequence);
    return { status: 'published', apply: true };
  }

  get() {
    return clone(this.#projection);
  }
}
