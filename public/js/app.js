const BASE_PATH = document.documentElement.dataset.basePath || '';
const ASSET_ROOT = `${BASE_PATH}/_assets`;
const SUPPORTED_LOCALES = ['en', 'zh'];
const THEMES = ['light'];
const METRICS = ['context_pct', 'rate_limit', 'session_cost', 'cache_hit_rate'];

const state = {
  locale: 'en',
  translations: {},
  dashboardState: null,
  metrics: new Map(),
  health: null,
  system: null,
  sourceUpdatedAt: null,
  metricsUpdatedAt: null,
  healthUpdatedAt: null,
  timer: null,
  pollTimer: null,
  eventSource: null
};

const $ = (selector) => document.querySelector(selector);

function apiPath(path) {
  return `${BASE_PATH}${path}`;
}

function resolveLocale(explicit) {
  if (SUPPORTED_LOCALES.includes(explicit)) return explicit;
  const stored = localStorage.getItem('zylos-dashboard-locale');
  if (SUPPORTED_LOCALES.includes(stored)) return stored;
  return navigator.language?.startsWith('zh') ? 'zh' : 'en';
}

async function initI18n(locale) {
  state.locale = resolveLocale(locale);
  localStorage.setItem('zylos-dashboard-locale', state.locale);
  const response = await fetch(`${ASSET_ROOT}/i18n/${state.locale}.json`, { cache: 'no-store' });
  state.translations = await response.json();
  document.documentElement.lang = state.locale;
}

function t(key, params = {}) {
  let text = state.translations[key] || key;
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, value ?? '');
  }
  return text;
}

function renderI18n() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
}

function initTheme(theme) {
  const stored = localStorage.getItem('zylos-dashboard-theme');
  const selected = THEMES.includes(theme) ? theme : (THEMES.includes(stored) ? stored : 'light');
  document.documentElement.dataset.theme = selected;
  localStorage.setItem('zylos-dashboard-theme', selected);
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  const pct = numeric <= 1 ? numeric * 100 : numeric;
  return `${Math.round(pct)}%`;
}

function barPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const pct = numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, pct));
}

function formatCurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return new Intl.NumberFormat(state.locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: numeric < 1 ? 4 : 2
  }).format(numeric);
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return new Intl.NumberFormat(state.locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 0
  }).format(numeric / 1024 / 1024);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function ageSeconds(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
}

function formatAge(timestamp) {
  const age = ageSeconds(timestamp);
  if (age === null) return '--';
  if (age < 2) return t('time.just_now');
  return t('time.seconds', { count: age });
}

function normalizeStateName(value) {
  return String(value || 'UNKNOWN').toUpperCase();
}

function stateClass(value) {
  return `state-${normalizeStateName(value).toLowerCase().replaceAll('_', '-')}`;
}

function latestTool(tools = []) {
  return [...tools].sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0] || null;
}

function stateTitle(payload) {
  const name = normalizeStateName(payload?.state);
  const tool = latestTool(payload?.running_tools || []);
  const reason = payload?.reason || t('value.unknown');
  if (name === 'BUSY') return t('state.busy', { tool: tool?.tool_name || 'tool' });
  if (name === 'IDLE') return t('state.idle');
  if (name === 'OFFLINE') return t('state.offline');
  if (name === 'WAITING_HUMAN') return t('state.waiting');
  if (name === 'POSSIBLY_STUCK') return t('state.possibly_stuck', { reason });
  if (name === 'STUCK') return t('state.stuck', { reason });
  return t('state.unknown', { reason });
}

function confidenceLabel(value) {
  if (!value) return '--';
  const key = `confidence.${String(value).toLowerCase()}`;
  const translated = t(key);
  return translated === key ? String(value) : translated;
}

function metricSourceLabel(metric) {
  if (!metric) return t('confidence.unavailable');
  const confidence = metric.confidence || metric.selected_source?.confidence;
  const source = metric.selected_source?.source || metric.selected_source || metric.source || metric.freshness?.source;
  const confidenceText = confidence ? confidenceLabel(confidence) : t('confidence.unavailable');
  return source ? `${confidenceText} · ${source}` : confidenceText;
}

function metricValue(metric) {
  if (!metric) return null;
  if (metric.value && typeof metric.value === 'object') return metric.value;
  return metric.value ?? metric.current ?? metric.percent ?? null;
}

function renderState() {
  const payload = state.dashboardState;
  const dot = $('#state-dot');
  const title = $('#state-title');
  const reason = $('#state-reason');
  const confidence = $('#state-confidence');
  const action = $('#state-action');
  const updated = $('#state-updated');
  const toolCount = $('#tool-count');
  const toolList = $('#tool-list');
  const details = $('#tool-details');

  dot.className = `state-dot ${stateClass(payload?.state)}`;
  title.textContent = payload ? stateTitle(payload) : t('state.unknown', { reason: t('value.unavailable') });
  reason.textContent = payload?.reason || payload?.evidence?.join(', ') || t('value.unavailable');
  confidence.textContent = confidenceLabel(payload?.confidence);
  action.textContent = payload?.suggested_action || t('value.none');
  updated.textContent = formatAge(payload?.updated_at || state.sourceUpdatedAt);

  const tools = payload?.running_tools || [];
  toolCount.textContent = String(tools.length);
  details.open = tools.length > 1;
  toolList.replaceChildren(...tools.map((tool) => {
    const item = document.createElement('div');
    item.className = 'tool-item';
    const elapsed = tool.duration_s ?? ageSeconds(tool.started_at) ?? 0;
    item.innerHTML = `<span class="mono">${escapeHtml(tool.tool_name || 'tool')}</span><strong>${formatDuration(elapsed)}</strong>`;
    return item;
  }));
}

function renderMetrics() {
  const context = state.metrics.get('context_pct');
  const rate = state.metrics.get('rate_limit');
  const cost = state.metrics.get('session_cost') || state.metrics.get('daily_cost');
  const cache = state.metrics.get('cache_hit_rate');
  const contextValue = metricValue(context);
  const rateValue = metricValue(rate);
  const rate5h = typeof rateValue === 'object' ? (rateValue['5h'] ?? rateValue.five_hour ?? rateValue.short ?? rateValue.value) : rateValue;
  const rate7d = typeof rateValue === 'object' ? (rateValue['7d'] ?? rateValue.seven_day ?? rateValue.long ?? rateValue.value) : null;

  $('#metric-context-value').textContent = formatPercent(contextValue);
  $('#metric-context-bar').style.width = `${barPercent(contextValue)}%`;
  $('#metric-context-source').textContent = metricSourceLabel(context);
  $('#metric-rate-5h-value').textContent = formatPercent(rate5h);
  $('#metric-rate-5h-bar').style.width = `${barPercent(rate5h)}%`;
  $('#metric-rate-7d-value').textContent = rate7d == null ? '--' : formatPercent(rate7d);
  $('#metric-rate-7d-bar').style.width = `${barPercent(rate7d)}%`;
  $('#metric-cost-value').textContent = formatCurrency(metricValue(cost));
  $('#metric-cost-source').textContent = metricSourceLabel(cost);
  $('#metric-cache-value').textContent = formatPercent(metricValue(cache));
  $('#metric-cache-source').textContent = metricSourceLabel(cache);
  $('#metrics-updated').textContent = formatAge(state.metricsUpdatedAt);
}

function renderHealth() {
  const systemResponse = state.system || {};
  const system = systemResponse.system || systemResponse;
  const health = state.health || {};
  const pm2 = systemResponse.pm2 || system.pm2 || system.pm2_services || system.services || [];
  const services = Array.isArray(pm2) ? pm2 : (pm2.services || []);
  const running = services.filter((svc) => ['online', 'running', 'ok'].includes(String(svc.status || svc.pm2_env?.status).toLowerCase())).length;
  const total = services.length || Number(pm2.total) || 0;
  const cpu = system.cpu?.percent ?? system.cpu_pct ?? system.cpu;
  const memory = system.memory?.used_bytes ?? system.mem_used_bytes ?? system.memory?.used ?? system.memory;
  const disk = system.disk?.used_pct ?? system.disk_pct ?? system.disk?.percent ?? system.disk;

  $('#system-cpu').textContent = formatPercent(cpu);
  $('#system-memory').textContent = typeof memory === 'number' && memory > 100 ? formatBytes(memory) : formatPercent(memory);
  $('#system-disk').textContent = formatPercent(disk);
  $('#system-pm2').textContent = total ? t('label.running', { count: running, total }) : '--';
  $('#health-updated').textContent = formatAge(state.healthUpdatedAt);

  const sources = flattenSources(state.dashboardState?.source || health.source || health.sources || {});
  const sourceList = $('#source-list');
  sourceList.replaceChildren(...sources.slice(0, 8).map((source) => {
    const item = document.createElement('div');
    item.className = 'source-item';
    const status = source.status || (source.fresh ? 'healthy' : 'stale');
    const age = Number.isFinite(Number(source.age_s)) ? `${Math.round(source.age_s)}s` : '--';
    item.innerHTML = `<strong>${escapeHtml(source.name)}</strong><span>${escapeHtml(status)} · ${age}</span>`;
    return item;
  }));
}

function flattenSources(sourceTree) {
  const out = [];
  for (const [domain, sources] of Object.entries(sourceTree || {})) {
    for (const [name, value] of Object.entries(sources || {})) {
      out.push({ name: `${domain}.${name}`, ...(value || {}) });
    }
  }
  return out;
}

function renderConnection(mode) {
  const pill = $('#connection-status');
  pill.dataset.state = mode;
  pill.textContent = t(`status.${mode}`);
}

function renderAll() {
  renderI18n();
  renderState();
  renderMetrics();
  renderHealth();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function fetchJson(path) {
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}

async function refreshState() {
  state.dashboardState = await fetchJson('/api/state');
  state.sourceUpdatedAt = state.dashboardState.updated_at || new Date().toISOString();
  renderState();
  renderHealth();
}

async function refreshMetrics() {
  const results = await Promise.allSettled(METRICS.map(async (name) => [name, await fetchJson(`/api/metrics/${name}`)]));
  let changed = false;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      state.metrics.set(result.value[0], result.value[1]);
      changed = true;
    }
  }
  if (changed) {
    state.metricsUpdatedAt = new Date().toISOString();
    renderMetrics();
  }
}

async function refreshHealth() {
  const [health, system] = await Promise.allSettled([
    fetchJson('/api/health'),
    fetchJson('/api/system')
  ]);
  if (health.status === 'fulfilled') state.health = health.value;
  if (system.status === 'fulfilled') state.system = system.value;
  state.healthUpdatedAt = new Date().toISOString();
  renderHealth();
}

async function refreshAll() {
  const results = await Promise.allSettled([
    refreshState(),
    refreshMetrics(),
    refreshHealth()
  ]);
  const ok = results.some((result) => result.status === 'fulfilled');
  renderConnection(ok ? 'polling' : 'degraded');
}

function applySsePayload(eventName, payload) {
  if (eventName === 'state_change') {
    state.dashboardState = payload;
    state.sourceUpdatedAt = payload.updated_at || new Date().toISOString();
    renderState();
    renderHealth();
  } else if (eventName === 'metric_update') {
    const name = payload.metric_name || payload.name;
    if (name) {
      state.metrics.set(name, payload);
      state.metricsUpdatedAt = new Date().toISOString();
      renderMetrics();
    }
  } else if (eventName === 'system_update') {
    state.system = payload;
    state.healthUpdatedAt = new Date().toISOString();
    renderHealth();
  } else if (eventName === 'health_update') {
    state.health = payload;
    state.healthUpdatedAt = new Date().toISOString();
    renderHealth();
  }
}

function connectSse() {
  if (!window.EventSource) return;
  const events = ['state_change', 'metric_update', 'system_update', 'health_update'];
  state.eventSource = new EventSource(apiPath('/api/stream'));
  state.eventSource.onopen = () => renderConnection('live');
  state.eventSource.onerror = () => renderConnection('degraded');
  for (const eventName of events) {
    state.eventSource.addEventListener(eventName, (event) => {
      try {
        applySsePayload(eventName, JSON.parse(event.data));
        renderConnection('live');
      } catch {
        renderConnection('degraded');
      }
    });
  }
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        const active = panel.id === `tab-${button.dataset.tab}`;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
    });
  });
}

function initLocaleToggle() {
  $('#locale-toggle').addEventListener('click', async () => {
    await initI18n(state.locale === 'zh' ? 'en' : 'zh');
    renderAll();
  });
}

function startTimers() {
  state.timer = setInterval(() => {
    renderState();
    renderMetrics();
    renderHealth();
  }, 1000);
  state.pollTimer = setInterval(refreshAll, 30_000);
}

window.addEventListener('beforeunload', () => {
  clearInterval(state.timer);
  clearInterval(state.pollTimer);
  state.eventSource?.close();
});

initTheme();
await initI18n();
initTabs();
initLocaleToggle();
renderAll();
connectSse();
await refreshAll();
startTimers();
