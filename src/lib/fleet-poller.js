import { agentColor } from './agent-color.js';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_STALE_MS = 10_000;
const DEFAULT_JITTER_MS = 500;
const TOKEN_REFRESH_SKEW_MS = 60_000;

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function joinUrl(baseUrl, apiPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const path = String(apiPath || '').replace(/^\/+/, '');
  return `${base}/${path}`;
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function metricValue(state, name) {
  const source = state?.metrics?.[name] ?? state?.metric?.[name];
  if (source && typeof source === 'object') {
    return source.value ?? source.current ?? source.percent ?? null;
  }
  return source ?? null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function memPct(systemMetrics) {
  const explicit = numberOrNull(systemMetrics?.mem_pct ?? systemMetrics?.mem_used_pct);
  if (explicit != null) return explicit;
  const used = numberOrNull(systemMetrics?.mem_used_bytes);
  const total = numberOrNull(systemMetrics?.mem_total_bytes);
  return used != null && total > 0 ? (used / total) * 100 : null;
}

function hasUpgrade(runtimeInfo) {
  return Boolean(
    runtimeInfo?.zylos_update ||
    runtimeInfo?.cc_update ||
    runtimeInfo?.cc_restart ||
    runtimeInfo?.codex_update ||
    runtimeInfo?.codex_restart ||
    runtimeInfo?.pending_restart
  );
}

function hasSubagent(state) {
  return Array.isArray(state?.active_subagents) && state.active_subagents.length > 0;
}

function deriveActivity(state) {
  if (state?.running_tools?.length > 0) return state.running_tools[0].tool_detail || state.running_tools[0].tool_name || 'Running tool';
  if (state?.active_subagents?.length > 0) return state.active_subagents[0].last_activity || state.active_subagents[0].description || 'Subagent active';
  return state?.last_prompt?.summary || state?.last_message || state?.reason || null;
}

function sanitizeRecord(record) {
  return {
    name: record.name,
    color: record.color,
    hue: record.hue,
    state: record.state,
    activity: record.activity,
    context_pct: record.context_pct,
    cost: record.cost,
    session_cost: record.session_cost,
    daily_cost: record.daily_cost,
    weekly_cost: record.weekly_cost,
    model: record.model,
    effort: record.effort,
    new_session_threshold: record.new_session_threshold,
    cpu_pct: record.cpu_pct,
    mem_pct: record.mem_pct,
    disk_pct: record.disk_pct,
    has_upgrade: record.has_upgrade === true,
    has_subagent: record.has_subagent === true,
    last_seen: record.last_seen,
    pulse_rate: record.pulse_rate,
    health_reason: record.health_reason,
    updated_at: record.updated_at,
    base_url: record.base_url,
    self: record.self === true
  };
}

/**
 * Build the "self" fleet record for the local dashboard's own agent.
 *
 * This mirrors the external-agent record shape produced by `_setSuccess`, but
 * sources its live data from the local in-process state/metrics instead of an
 * HTTP poll. It carries no secrets (the local agent has none) and is flagged
 * with `self: true` so the frontend can drill into the local dashboard.
 *
 * @param {object} opts
 * @param {string} opts.name      - Local agent name (config.agent.name).
 * @param {object} opts.color     - Result of agentColor(name): { color, hue }.
 * @param {object} [opts.state]   - Local state engine getState() result.
 * @param {number|null} [opts.contextPct] - Resolved context_pct metric value.
 * @param {number|null} [opts.sessionCost]
 * @param {number|null} [opts.dailyCost]
 * @param {number|null} [opts.weeklyCost]
 * @param {number} [opts.nowMs]
 */
export function buildSelfRecord({
  name,
  color,
  state,
  runtimeInfo = null,
  contextPct = null,
  cost = null,
  newSessionThreshold = null,
  sessionCost = null,
  dailyCost = null,
  weeklyCost = null,
  systemMetrics = null,
  nowMs = Date.now()
}) {
  const liveState = state?.state || 'UNKNOWN';
  const offline = liveState === 'OFFLINE' || liveState === 'UNKNOWN';
  return sanitizeRecord({
    name,
    base_url: null,
    color: color?.color,
    hue: color?.hue,
    state: liveState,
    activity: deriveActivity(state),
    context_pct: contextPct,
    cost: sessionCost ?? cost ?? dailyCost ?? weeklyCost,
    session_cost: sessionCost ?? cost,
    daily_cost: dailyCost,
    weekly_cost: weeklyCost,
    model: runtimeInfo?.model || runtimeInfo?.model_id || null,
    effort: runtimeInfo?.effort || runtimeInfo?.service_tier || null,
    new_session_threshold: newSessionThreshold,
    cpu_pct: numberOrNull(systemMetrics?.cpu_pct),
    mem_pct: memPct(systemMetrics),
    disk_pct: numberOrNull(systemMetrics?.disk_pct ?? systemMetrics?.disk_used_pct),
    has_upgrade: hasUpgrade(runtimeInfo),
    has_subagent: hasSubagent(state),
    last_seen: nowIso(nowMs),
    pulse_rate: offline ? 0 : 1,
    health_reason: liveState === 'IDLE' ? 'idle' : (offline ? 'offline' : 'ok'),
    updated_at: nowIso(nowMs),
    self: true
  });
}

export class FleetPoller {
  constructor(config = {}, options = {}) {
    const fleet = config.fleet || {};
    this.agents = Array.isArray(fleet.agents) ? fleet.agents : [];
    this.pollIntervalMs = toNumber(fleet.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS);
    this.timeoutMs = toNumber(fleet.timeout_ms, DEFAULT_TIMEOUT_MS);
    this.staleMs = toNumber(fleet.stale_ms, DEFAULT_STALE_MS);
    this.jitterMs = toNumber(fleet.jitter_ms, DEFAULT_JITTER_MS);
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.onPoll = typeof options.onPoll === 'function' ? options.onPoll : null;
    this.records = new Map();
    this.tokens = new Map();
    this.running = false;
    this.timer = null;

    for (const agent of this.agents) {
      const color = agentColor(agent.name);
      this.records.set(agent.name, sanitizeRecord({
        name: agent.name,
        base_url: agent.base_url,
        color: color.color,
        hue: color.hue,
        state: 'UNKNOWN',
        activity: null,
        context_pct: null,
        cost: null,
        session_cost: null,
        daily_cost: null,
        weekly_cost: null,
        model: null,
        effort: null,
        new_session_threshold: null,
        cpu_pct: null,
        mem_pct: null,
        disk_pct: null,
        has_upgrade: false,
        has_subagent: false,
        last_seen: null,
        pulse_rate: null,
        health_reason: 'not_polled',
        updated_at: nowIso(this.now())
      }));
    }
  }

  start() {
    if (this.running || this.agents.length === 0) return;
    this.running = true;
    this.pollOnce().finally(() => this._scheduleNext());
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
  }

  getFleet() {
    this._markStale();
    return {
      agents: Array.from(this.records.values()).map(sanitizeRecord),
      count: this.records.size,
      updated_at: nowIso(this.now())
    };
  }

  async getSessionToken(agentName, options = {}) {
    const agent = this.agents.find(a => a.name === agentName);
    if (!agent) {
      const err = new Error('unknown_agent');
      err.status = 404;
      throw err;
    }
    return this._ensureToken(agent, { force: Boolean(options.force) });
  }

  async pollOnce() {
    await Promise.all(this.agents.map(agent => this._pollAgent(agent)));
    this._markStale();
    const fleet = this.getFleet();
    this.onPoll?.(fleet);
    return fleet;
  }

  _scheduleNext() {
    if (!this.running) return;
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    this.timer = this.setTimeout(() => {
      this.pollOnce().finally(() => this._scheduleNext());
    }, this.pollIntervalMs + jitter);
    this.timer.unref?.();
  }

  async _ensureToken(agent, { force = false } = {}) {
    const cached = this.tokens.get(agent.name);
    const now = this.now();
    if (!force && cached?.token && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }

    const resp = await fetchWithTimeout(this.fetch, joinUrl(agent.base_url, '/api/auth/token'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.read_api_key}` }
    }, this.timeoutMs);

    if (resp.status === 404) {
      const err = new Error('version_unsupported');
      err.reason = 'version_unsupported';
      err.status = 404;
      throw err;
    }
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error('auth_failed');
      err.reason = 'auth_failed';
      err.status = resp.status;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error('unreachable');
      err.reason = 'unreachable';
      err.status = resp.status;
      throw err;
    }

    const body = await resp.json();
    if (!body?.token) {
      const err = new Error('auth_failed');
      err.reason = 'auth_failed';
      throw err;
    }

    const parsedExpiresAtMs = body.expires_at ? Date.parse(body.expires_at) : NaN;
    const expiresAtMs = Number.isFinite(parsedExpiresAtMs)
      ? parsedExpiresAtMs
      : now + toNumber(body.ttl_seconds, 86400) * 1000;
    this.tokens.set(agent.name, { token: body.token, expiresAtMs });
    return body.token;
  }

  async _pollAgent(agent) {
    try {
      let token = await this._ensureToken(agent);
      let resp = await this._fetchState(agent, token);
      if (resp.status === 401) {
        this.tokens.delete(agent.name);
        token = await this._ensureToken(agent, { force: true });
        resp = await this._fetchState(agent, token);
      }
      if (resp.status === 401 || resp.status === 403) {
        this._setFailure(agent, 'auth_failed');
        return;
      }
      if (!resp.ok) {
        this._setFailure(agent, 'unreachable');
        return;
      }
      const state = await resp.json();
      this._setSuccess(agent, state);
    } catch (err) {
      this._setFailure(agent, err.reason || 'unreachable');
    }
  }

  _fetchState(agent, token) {
    return fetchWithTimeout(this.fetch, joinUrl(agent.base_url, '/api/state'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    }, this.timeoutMs);
  }

  _setSuccess(agent, state) {
    const now = this.now();
    const color = agentColor(agent.name);
    this.records.set(agent.name, sanitizeRecord({
      name: agent.name,
      base_url: agent.base_url,
      color: color.color,
      hue: color.hue,
      state: state?.state || 'UNKNOWN',
      activity: deriveActivity(state),
      context_pct: metricValue(state, 'context_pct'),
      cost: state?.session_cost ?? state?.daily_cost ?? state?.weekly_cost ?? metricValue(state, 'session_cost') ?? metricValue(state, 'daily_cost'),
      session_cost: state?.session_cost ?? metricValue(state, 'session_cost'),
      daily_cost: state?.daily_cost ?? metricValue(state, 'daily_cost'),
      weekly_cost: state?.weekly_cost ?? null,
      model: state?.runtime_info?.model || state?.runtime_info?.model_id || null,
      effort: state?.runtime_info?.effort || state?.runtime_info?.service_tier || null,
      new_session_threshold: state?.new_session_threshold ?? null,
      cpu_pct: numberOrNull(state?.system_metrics?.cpu_pct),
      mem_pct: memPct(state?.system_metrics),
      disk_pct: numberOrNull(state?.system_metrics?.disk_pct ?? state?.system_metrics?.disk_used_pct),
      has_upgrade: hasUpgrade(state?.runtime_info),
      has_subagent: hasSubagent(state),
      last_seen: nowIso(now),
      pulse_rate: 1,
      health_reason: state?.state === 'IDLE' ? 'idle' : 'ok',
      updated_at: nowIso(now)
    }));
  }

  _setFailure(agent, reason) {
    const existing = this.records.get(agent.name) || {};
    const color = agentColor(agent.name);
    this.records.set(agent.name, sanitizeRecord({
      name: agent.name,
      base_url: agent.base_url,
      color: color.color,
      hue: color.hue,
      state: reason === 'version_unsupported' ? 'UNKNOWN' : existing.state || 'UNKNOWN',
      activity: existing.activity || null,
      context_pct: existing.context_pct ?? null,
      cost: existing.cost ?? null,
      session_cost: existing.session_cost ?? null,
      daily_cost: existing.daily_cost ?? null,
      weekly_cost: existing.weekly_cost ?? null,
      model: existing.model ?? null,
      effort: existing.effort ?? null,
      new_session_threshold: existing.new_session_threshold ?? null,
      cpu_pct: existing.cpu_pct ?? null,
      mem_pct: existing.mem_pct ?? null,
      disk_pct: existing.disk_pct ?? null,
      has_upgrade: existing.has_upgrade === true,
      has_subagent: existing.has_subagent === true,
      last_seen: existing.last_seen || null,
      pulse_rate: 0,
      health_reason: reason,
      updated_at: nowIso(this.now())
    }));
  }

  _markStale() {
    const now = this.now();
    for (const [name, record] of this.records) {
      if (!record.last_seen) continue;
      if (record.health_reason === 'unreachable' || record.health_reason === 'version_unsupported' || record.health_reason === 'auth_failed') continue;
      if (now - Date.parse(record.last_seen) > this.staleMs) {
        this.records.set(name, sanitizeRecord({
          ...record,
          state: 'OFFLINE',
          pulse_rate: 0,
          health_reason: 'offline',
          updated_at: nowIso(now)
        }));
      }
    }
  }
}
