export const MASCOT_BY_MOOD = {
  busy: 'busy.png',
  thinking: 'thinking.png',
  idle: 'idle.png',
  stuck: 'stuck.png',
  offline: 'offline.png'
};

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pctValue(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
}

function money(value) {
  if (value == null || value === '') return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function compactText(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function labelText(value, fallback = '--') {
  const text = String(value || '').trim();
  return text || fallback;
}

export function stateMood(agent) {
  const state = String(agent?.state || 'UNKNOWN').toUpperCase();
  const reason = String(agent?.health_reason || '').toLowerCase();
  const activity = String(agent?.activity || '').toLowerCase();
  if (state === 'OFFLINE' || reason === 'offline' || reason === 'unreachable' || reason === 'version_unsupported' || reason === 'auth_failed') return 'offline';
  if (state === 'STUCK' || state === 'POSSIBLY_STUCK' || reason.includes('stuck')) return 'stuck';
  if (state === 'IDLE') return 'idle';
  if (state === 'BUSY' && (activity.includes('thinking') || activity.includes('思考'))) return 'thinking';
  if (state === 'THINKING') return 'thinking';
  if (state === 'BUSY') return 'busy';
  return 'idle';
}

function isOffline(agent) {
  return stateMood(agent) === 'offline' || Number(agent?.pulse_rate) === 0;
}

function stateLabel(agent, labels) {
  const mood = stateMood(agent);
  const reason = String(agent?.health_reason || '').toLowerCase();
  if (reason === 'version_unsupported') return labels.versionUnsupported;
  if (reason === 'unreachable') return labels.unreachable;
  if (reason === 'auth_failed') return labels.authFailed;
  if (mood === 'busy') return labels.busy;
  if (mood === 'thinking') return labels.thinking;
  if (mood === 'stuck') return labels.stuck;
  if (mood === 'offline') return labels.offline;
  return labels.idle;
}

function colorForAgent(agent) {
  return agent?.color || '#64748b';
}

function mascotSrc(mood, root) {
  const cleanRoot = String(root || './img/mascot').replace(/\/+$/, '');
  return `${cleanRoot}/${MASCOT_BY_MOOD[mood]}`;
}

function sortAgents(agents) {
  const list = Array.isArray(agents) ? [...agents] : [];
  const self = list.filter((agent) => agent?.self === true);
  const others = list
    .filter((agent) => agent?.self !== true)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return [...self, ...others];
}

function miniRing(name, value, labels) {
  const pct = pctValue(value);
  const ringPct = pct == null ? 0 : pct;
  const valueLabel = pct == null ? '--' : `${ringPct.toFixed(0)}%`;
  return `<span class="fleet-mini-ring" style="--ring-pct:${ringPct};" aria-label="${escapeHtml(name)} ${escapeHtml(valueLabel)}">
    <span>${escapeHtml(valueLabel)}</span>
    <small>${escapeHtml(name)}</small>
  </span>`;
}

export function defaultAgentFleetLabels() {
  return {
    title: 'Agent Fleet',
    subtitle: 'Operational fleet status',
    busy: 'Working',
    thinking: 'Thinking',
    idle: 'Idle',
    stuck: 'Possible Stuck',
    offline: 'Offline',
    unreachable: 'Unreachable',
    versionUnsupported: 'Version unsupported',
    authFailed: 'Auth failed',
    noActivity: 'Standing by',
    context: 'Context',
    threshold: 'threshold',
    model: 'Model',
    upgrade: 'Upgrade available',
    sessionCost: 'Session',
    dailyCost: 'Today',
    weeklyCost: '7 days',
    cpu: 'CPU',
    memory: 'Memory',
    disk: 'Disk',
    subagent: 'Subagent',
    empty: 'No fleet agents configured'
  };
}

export function buildAgentFleetView(fleet, options = {}) {
  const labels = { ...defaultAgentFleetLabels(), ...(options.labels || {}) };
  const basePath = options.basePath || '';
  const tiles = sortAgents(fleet?.agents).map((agent) => {
    const mood = stateMood(agent);
    const offline = isOffline(agent);
    const color = colorForAgent(agent);
    const isSelf = agent.self === true;
    const contextPct = pctValue(agent.context_pct);
    const threshold = pctValue(agent.new_session_threshold);
    const activity = compactText(agent.activity, labels.noActivity);
    return {
      name: String(agent.name || ''),
      mood,
      offline,
      isSelf,
      color,
      hue: Number.isFinite(Number(agent.hue)) ? Number(agent.hue) : 0,
      stateLabel: stateLabel(agent, labels),
      activity,
      contextPct,
      threshold,
      overThreshold: contextPct != null && threshold != null && contextPct >= threshold,
      model: labelText(agent.model),
      effort: labelText(agent.effort),
      sessionCostLabel: money(agent.session_cost ?? agent.cost),
      dailyCostLabel: money(agent.daily_cost),
      weeklyCostLabel: money(agent.weekly_cost),
      cpuPct: agent.cpu_pct,
      memPct: agent.mem_pct,
      diskPct: agent.disk_pct,
      hasUpgrade: agent.has_upgrade === true,
      hasSubagent: agent.has_subagent === true,
      reason: agent.health_reason || '',
      href: isSelf ? `${basePath}/` : `${basePath}/fleet/${encodeURIComponent(String(agent.name || ''))}/`,
      mascotSrc: mascotSrc(mood, options.mascotRoot)
    };
  });

  const counts = tiles.reduce((acc, tile) => {
    acc[tile.mood] = (acc[tile.mood] || 0) + 1;
    return acc;
  }, { busy: 0, thinking: 0, idle: 0, stuck: 0, offline: 0 });

  return {
    labels,
    tiles,
    counts,
    updatedAt: fleet?.updated_at || null
  };
}

function renderTile(tile, labels) {
  const ringPct = tile.contextPct == null ? 0 : tile.contextPct;
  const threshold = tile.threshold == null ? 70 : tile.threshold;
  const reason = tile.reason ? `<span class="agent-fleet-reason">${escapeHtml(tile.stateLabel)}</span>` : '';
  const upgrade = tile.hasUpgrade ? `<span class="agent-upgrade-badge" title="${escapeHtml(labels.upgrade)}" aria-label="${escapeHtml(labels.upgrade)}"></span>` : '';
  const subagentLabel = tile.hasSubagent ? labels.subagent : '';
  return `<a class="agent-tile agent-tile-${escapeHtml(tile.mood)}${tile.offline ? ' is-offline' : ''}${tile.isSelf ? ' is-self' : ''}${tile.overThreshold ? ' is-over-threshold' : ''}" href="${escapeHtml(tile.href)}" data-agent="${escapeHtml(tile.name)}" data-state="${escapeHtml(tile.mood)}"${tile.isSelf ? ' data-self="true"' : ''} style="--agent-accent:${escapeHtml(tile.color)};--agent-hue:${tile.hue}deg;--context-pct:${ringPct};--threshold-pct:${threshold};">
    <div class="agent-tile-head">
      <span class="agent-name">${escapeHtml(tile.name)}</span>
      <span class="agent-state">${escapeHtml(tile.stateLabel)}</span>
      ${upgrade}
    </div>
    <div class="agent-runtime-line">
      <span>${escapeHtml(labels.model)}</span>
      <strong>${escapeHtml(tile.model)} / ${escapeHtml(tile.effort)}</strong>
    </div>
    <div class="agent-mascot-wrap">
      <span class="context-ring" aria-label="${escapeHtml(labels.context)} ${ringPct.toFixed(0)}%" style="--context-pct:${ringPct};--threshold-pct:${threshold};"></span>
      <span class="context-threshold" title="${escapeHtml(labels.threshold)} ${threshold.toFixed(0)}%"></span>
      <img class="agent-mascot" src="${escapeHtml(tile.mascotSrc)}" alt="" loading="lazy">
    </div>
    <div class="fleet-cost-rows">
      <span><small>${escapeHtml(labels.sessionCost)}</small><strong>${escapeHtml(tile.sessionCostLabel)}</strong></span>
      <span><small>${escapeHtml(labels.dailyCost)}</small><strong>${escapeHtml(tile.dailyCostLabel)}</strong></span>
      <span><small>${escapeHtml(labels.weeklyCost)}</small><strong>${escapeHtml(tile.weeklyCostLabel)}</strong></span>
    </div>
    <div class="fleet-system-rings">
      ${miniRing(labels.cpu, tile.cpuPct, labels)}
      ${miniRing(labels.memory, tile.memPct, labels)}
      ${miniRing(labels.disk, tile.diskPct, labels)}
    </div>
    <div class="agent-activity">
      <span class="subagent-light${tile.hasSubagent ? ' is-on' : ''}" aria-label="${escapeHtml(subagentLabel)}"></span>
      <span>${escapeHtml(tile.activity)}</span>
    </div>
    ${reason}
  </a>`;
}

function renderAgentFleetViewHtml(view) {
  const { labels } = view;
  if (view.tiles.length === 0) {
    return `<section class="agent-fleet"><p class="empty-state">${escapeHtml(labels.empty)}</p></section>`;
  }
  const summary = `${view.counts.busy} ${labels.busy} / ${view.counts.idle} ${labels.idle} / ${view.counts.stuck} ${labels.stuck}`;
  return `<section class="agent-fleet" data-fleet-count="${view.tiles.length}">
    <div class="agent-fleet-summary">
      <strong>${escapeHtml(summary)}</strong>
    </div>
    <div class="agent-grid">
      ${view.tiles.map((tile) => renderTile(tile, labels)).join('')}
    </div>
  </section>`;
}

export function renderAgentFleetHtml(fleet, options = {}) {
  return renderAgentFleetViewHtml(buildAgentFleetView(fleet, options));
}

export function renderAgentFleet(container, fleet, options = {}) {
  if (!container) return null;
  const view = buildAgentFleetView(fleet, options);
  container.innerHTML = renderAgentFleetViewHtml(view);
  return view;
}
