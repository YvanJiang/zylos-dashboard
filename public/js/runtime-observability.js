const KNOWN_STATE = new Set(['healthy', 'degraded', 'offline', 'recovering', 'idle', 'queued', 'running', 'waiting_human', 'failed', 'succeeded', 'cancelled', 'unknown']);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function shownState(value) {
  if (value === null || value === undefined || value === '') return '—';
  return KNOWN_STATE.has(value) ? esc(value) : `Unknown (${esc(value)})`;
}

function shownValue(value) {
  return value === null || value === undefined || value === '' ? '—' : esc(value);
}

const TERMINAL_TURN_STATES = new Set(['succeeded', 'failed', 'cancelled']);

// The primary card must not invent a state from Dashboard-local collectors.
export function derivePrimaryRuntimeState(view) {
  const snapshot = view?.snapshot;
  if (!snapshot || snapshot.error !== null || !snapshot.service?.complete || !snapshot.executors?.complete || !snapshot.turns?.complete) {
    return { state: 'UNKNOWN', reason: 'Core runtime snapshot unavailable or partial.', available: false };
  }
  const activeTurn = snapshot.turns.items.find((turn) => !TERMINAL_TURN_STATES.has(turn?.state));
  if (activeTurn) {
    const states = {
      running: 'BUSY',
      waiting_human: 'WAITING_HUMAN',
      queued: 'QUEUED',
      recovering: 'RECOVERING'
    };
    return {
      state: states[activeTurn.state] || 'UNKNOWN',
      reason: activeTurn.state === 'unknown' ? 'Core reported an unknown turn state.' : `Core turn ${activeTurn.state}.`,
      available: true
    };
  }
  const executors = snapshot.executors.items;
  if (executors.some((executor) => executor.health !== 'healthy')) {
    return { state: 'UNKNOWN', reason: 'Core executor health is not healthy.', available: true };
  }
  if (executors.some((executor) => executor.queue_length > 0)) {
    return { state: 'QUEUED', reason: 'Core reports queued work.', available: true };
  }
  return { state: 'IDLE', reason: 'Core reports no active or queued turn.', available: true };
}

function unavailable(name, error) {
  return `<section class="runtime-observability-section runtime-observability-unavailable"><h3>${esc(name)}</h3><p>Unavailable — partial collection${error?.code ? ` (${esc(error.code)})` : ''}</p></section>`;
}

function collection(name, section, render) {
  if (!section?.complete) return unavailable(name, section?.error);
  return `<section class="runtime-observability-section"><h3>${esc(name)}</h3>${render(section.items || [])}</section>`;
}

function list(items, render, empty = 'None') {
  return items.length ? `<ul class="runtime-observability-list">${items.map(render).join('')}</ul>` : `<p class="runtime-observability-empty">${empty}</p>`;
}

export function renderRuntimeObservability(view) {
  const snapshot = view?.snapshot;
  const update = view?.update || { status: 'unavailable' };
  if (!snapshot) {
    return `<div class="runtime-observability-status is-unavailable">Core runtime snapshot unavailable (${esc(update.status)}). No runtime state is inferred.</div>`;
  }
  const updateNote = update.status === 'replace' || update.status === 'initial' || update.status === 'replace_instance'
    ? ''
    : `<div class="runtime-observability-status is-warning">Snapshot update: ${esc(update.status)}. Existing state is retained only when Core requires a full replacement.</div>`;
  const service = snapshot.service;
  const serviceView = service.complete
    ? `<div class="runtime-observability-summary"><strong>Core service: ${shownState(service.health)}</strong><span>Snapshot ${esc(snapshot.snapshot_version)} · ${esc(snapshot.generated_at)}</span><span>${service.maintenance ? 'Maintenance' : 'Serving'}${service.draining ? ' · Draining' : ''}${service.reconciling ? ' · Reconciling' : ''}</span></div>`
    : `<div class="runtime-observability-status is-unavailable">Core service unavailable — partial snapshot${service.error?.code ? ` (${esc(service.error.code)})` : ''}. No service health is inferred.</div>`;
  return `${updateNote}
    ${serviceView}
    ${collection('Executors', snapshot.executors, (items) => list(items, (item) => `<li><strong>${shownState(item.health)}</strong> · ${shownValue(item.provider)} · Queue: ${esc(item.queue_length ?? '—')} · Wait: ${shownValue(item.wait_reason)} · Lease epoch: ${esc(item.lease?.epoch ?? '—')}</li>`))}
    ${collection('Turns and recovery', snapshot.turns, (items) => list(items, (item) => `<li><strong>${shownState(item.state)}</strong> · Phase: ${shownValue(item.phase)} · Queue position: ${esc(item.queue_position ?? '—')} · Retries: ${esc(item.retry_count ?? 0)} · Side effect: ${shownValue(item.side_effect_status)}${item.recovery_of_turn_id ? ' · Recovery linked' : ''}${item.error?.code ? ` · ${esc(item.error.code)}` : ''}</li>`))}
    ${collection('Interactions', snapshot.interactions, (items) => list(items, (item) => `<li><strong>${shownValue(item.state)}</strong> · ${shownValue(item.kind)} · Handoff: ${shownValue(item.handoff_state)} · Deadline: ${esc(item.handoff_deadline_at ?? '—')}</li>`))}
    ${collection('Workspace leases', snapshot.workspace_leases, (items) => list(items, (item) => `<li><strong>${shownValue(item.mode)}</strong> · ${esc(item.workspace_root)} · Waiters: ${esc(item.waiter_count ?? 0)} · Lease epoch: ${esc(item.epoch ?? '—')}</li>`))}
    ${collection('Outbox', snapshot.outbox, (items) => `${list(items, (item) => `<li><strong>${shownValue(item.status)}</strong> · ${esc(item.channel)} · Count: ${esc(item.count)} · Oldest: ${esc(item.oldest_age_seconds)}s</li>`)}<p class="runtime-observability-counters">Retries: ${esc(snapshot.outbox.retry_count)} · Dead letters: ${esc(snapshot.outbox.dead_letter_count)}</p>`)}
    ${collection('Recovery audit', snapshot.audit_summary, (items) => list(items, (item) => `<li>${esc(item.category)} · ${esc(item.count)} · ${esc(item.last_committed_at ?? '—')}</li>`))}`;
}
