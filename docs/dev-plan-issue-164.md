# Dev Plan: Pulse Wall → Agent Fleet Redesign (#164)

## Summary

Complete redesign of the Pulse Wall into "Agent Fleet" (Agent 舰队). Replace decorative elements with operational data: model+effort, upgrade badges, three-tier cost, system resource rings, context threshold from config, multi-line activity with subagent indicator. Switch frontend from 3s polling to SSE push.

## Scope

**In scope:**
- Rename: Pulse Wall → Agent Fleet (code, UI, i18n)
- Per-tile: mascot+animation, state label, model+effort, upgrade badge, context ring+threshold, 3-tier cost, CPU/mem/disk rings, multi-line activity+subagent indicator, self-first sort
- Fleet-level: SSE push (replace 3s polling)
- Remove: sparkline, last-seen, pulse animation/rate, "you" badge

**Out of scope:**
- Backend fleet-poller polling mechanism (still polls remote agents via HTTP; SSE change is frontend-facing only)
- Single-agent detail view changes
- New collector logic (reuse existing metric-resolver, system-collector, etc.)

## Development Checklist

### Phase 1: Backend — Enrich Fleet Data

- [ ] **1.1 Extend `buildSelfRecord()`** in `fleet-poller.js`: add `model`, `effort`, `new_session_threshold`, `session_cost`, `daily_cost`, `weekly_cost`, `cpu_pct`, `mem_pct`, `disk_pct`, `has_upgrade`, `has_subagent`, `activity` (full text, not truncated). Source from `metricResolver`, `buildRuntimeInfo()`, `systemCollector`, and `stateEngine`.
- [ ] **1.2 Extend `/api/state` response**: add `system_metrics: { cpu_pct, mem_pct, disk_pct }`, `session_cost`, `daily_cost`, `weekly_cost` to the `/api/state` response. This is needed so remote agents can expose full data to the fleet poller via a single endpoint. Source system metrics from `systemCollector.getLatestSystemData()`, costs from `metricResolver`. Old dashboard versions that don't return these fields will show `null` in the fleet view (graceful degradation).
- [ ] **1.3 Extend remote agent polling**: when polling `/api/state` from remote agents, extract and forward all new fields: `runtime_info.model`, `runtime_info.effort`, `new_session_threshold`, `system_metrics`, `session_cost`, `daily_cost`, `weekly_cost`, upgrade status. Currently only `state`, `context_pct`, `cost`, `activity`, `health_reason` are mapped.
- [ ] **1.4 Shared `buildFleetPayload()`**: extract the self-record composition + secret guard from the `/api/fleet` HTTP handler (`index.js:401-419`) into a shared function. Both the HTTP handler and the SSE broadcast must use this function to ensure self-agent is always included and secrets are always guarded. Without this, the SSE broadcast from `FleetPoller.pollOnce()` would emit only remote agents, dropping self.
- [ ] **1.5 Add fleet SSE channel**: extend existing SSE in `sse.js` to support a `fleet` event type. On poll cycle completion, call `buildFleetPayload()` and broadcast `event: fleet` with the full payload. The existing SSE connection already serves single-agent state updates; fleet events piggyback on the same connection.
- [ ] **1.6 Three-tier cost resolution**: `session_cost` already resolved by metric-resolver. Add `daily_cost` and `weekly_cost` to both the self-record (via metric-resolver) and the `/api/state` response (for remote agents).

### Phase 2: Frontend — Agent Fleet UI

- [ ] **2.1 Rename**: Replace all "Pulse Wall" / "pulse-wall" / "心跳墙" references with "Agent Fleet" / "agent-fleet" / "Agent 舰队" in: `pulse-wall.js` (rename file to `agent-fleet.js`), `app.js`, `index.html`, `i18n.js`, `style.css`.
- [ ] **2.2 Rewrite tile template** in the renamed `agent-fleet.js`:
  - Mascot image + state animation (reuse existing mood logic, keep `busy/thinking/idle/stuck/offline` mapping)
  - State label text
  - Model + effort line (e.g., "Opus 4.6 / high")
  - Upgrade badge (dot/icon if `has_upgrade` is true)
  - Context ring with threshold marker (ring color changes when > threshold; threshold read from `new_session_threshold`)
  - Three cost lines: session / daily / 7-day
  - CPU / memory / disk mini rings (reuse gauge-utils.js ring rendering)
  - Multi-line current activity (CSS `overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3`)
  - Subagent indicator light (small dot, green when `has_subagent`)
- [ ] **2.3 Remove deprecated elements**: sparkline SVG, last-seen label, pulse-rate CSS animation (`--pulse-rate`, `@keyframes pulse`), "you" badge.
- [ ] **2.4 Self-first sort**: `buildPulseWallView()` currently sorts tiles alphabetically (`pulse-wall.js:151-154`), which overrides the backend's self-first insertion. Remove the alphabetical sort, replace with: self-agent pinned to index 0, remaining agents sorted alphabetically. Update the existing frontend test (`test/frontend-behavior.test.js:165-183`) to assert self stays at index 0 after rendering.
- [ ] **2.5 SSE integration**: replace the `setInterval(fetchFleet, 3000)` polling loop with an SSE listener for `event: fleet`. On receiving a fleet event, update tiles. Keep a fallback: if no SSE fleet event received in 10s, do one manual fetch (resilience).
- [ ] **2.6 Mascot animation alignment**: ensure mascot animation states match single-agent detail view. Currently both use the same image set (`busy.png`, etc.) — verify CSS animations are consistent.

### Phase 3: Cleanup

- [ ] **3.1 Remove dead code**: `pulse-wall.js` (after rename), pulse-rate CSS variables, sparkline rendering functions, last-seen `ageLabel()` function (if only used by pulse wall).
- [ ] **3.2 Cache-bust**: bump `?v=N` query string on renamed JS file in `index.html`.
- [ ] **3.3 Update i18n**: remove `pulse_wall` keys, add `agent_fleet` keys with EN/ZH translations.

## Test Checklist

- [ ] Unit test: `buildSelfRecord()` returns all new fields (model, effort, threshold, 3-tier cost, system metrics, has_upgrade, has_subagent)
- [ ] Unit test: `buildFleetPayload()` includes self-record at index 0, applies secret guard
- [ ] Unit test: fleet SSE event is emitted on poll cycle completion with full payload (including self)
- [ ] Unit test: self-agent is always first in fleet array (frontend sort preserves self at index 0)
- [ ] Unit test: renamed `agent-fleet.js` tile rendering includes all required fields (model/effort, upgrade badge, context+threshold, 3 costs, CPU/mem/disk, activity+subagent) and excludes deprecated elements (no sparkline, no last-seen, no `--pulse-rate`, no "you" badge)
- [ ] Unit test: `ageLabel()` removal doesn't break other code (grep for usage)
- [ ] Frontend: update `npm run check` script to include `public/js/*.js` (currently only checks `src/`, `hooks/`, `src/lib/*.cjs`)
- [ ] `npm test` passes
- [ ] `npm run smoke` passes
- [ ] Manual: browser — fleet view shows all 11 requirements from issue
- [ ] Manual: browser — single-agent detail view still works (no regression)

## Assumptions

- [ ] Remote agents' `/api/state` already returns `runtime_info` (model, effort) and `new_session_threshold` — verified in code (index.js:392-396). **Guaranteed.**
- [ ] Remote agents' `/api/state` does NOT currently return system metrics (CPU/mem/disk) or daily/weekly cost — those come from `/api/system` and `/api/metrics`. **Fixed in 1.2: extend `/api/state` to include these fields. Old dashboard versions that don't return them will show null (graceful degradation).**
- [ ] The existing SSE infrastructure (`sse.js`) supports adding new event types without breaking existing `state` events. **Guaranteed by design — SSE is event-name-namespaced.**
- [ ] `gauge-utils.js` ring rendering can be reused for CPU/mem/disk mini rings in fleet tiles. **Needs verification — current rings are sized for the detail view, may need sizing adjustments for tiles.**

## Acceptance Checklist

- [ ] All 11 requirements from issue #164 are met
- [ ] Browser screenshot: fleet view with at least 2 agents showing all metrics
- [ ] Browser screenshot: verify mascot animations match single-agent view
- [ ] No regressions in single-agent detail view
- [ ] "Pulse Wall" text appears nowhere in the UI
- [ ] SSE fleet events are received (verify in browser DevTools Network tab)
- [ ] Fallback polling works if SSE drops
- [ ] `npm test` passes
- [ ] Self-agent always appears first
