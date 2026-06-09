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
- [ ] **1.2 Extend remote agent polling**: when polling `/api/state` from remote agents, extract and forward: `runtime_info.model`, `runtime_info.effort`, `new_session_threshold`, system metrics (if returned), upgrade status. Currently only `state`, `context_pct`, `cost`, `activity`, `health_reason` are mapped.
- [ ] **1.3 Add fleet SSE channel**: extend existing SSE in `sse.js` to support a `fleet` event type. When fleet data updates (on poll cycle completion), broadcast `event: fleet` with the full fleet payload. The existing SSE connection already serves single-agent state updates; fleet events piggyback on the same connection.
- [ ] **1.4 Three-tier cost resolution**: `session_cost` already resolved by metric-resolver. Add `daily_cost` and `weekly_cost` to the self-record. For remote agents, these must come from their `/api/state` response — check if already exposed. If not, only `session_cost` will be available for remote agents (acceptable limitation, document it).

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
- [ ] **2.4 Self-first sort**: in `buildFleetView()`, sort self-agent to index 0 (already done in backend `/api/fleet`, verify frontend doesn't re-sort alphabetically).
- [ ] **2.5 SSE integration**: replace the `setInterval(fetchFleet, 3000)` polling loop with an SSE listener for `event: fleet`. On receiving a fleet event, update tiles. Keep a fallback: if no SSE fleet event received in 10s, do one manual fetch (resilience).
- [ ] **2.6 Mascot animation alignment**: ensure mascot animation states match single-agent detail view. Currently both use the same image set (`busy.png`, etc.) — verify CSS animations are consistent.

### Phase 3: Cleanup

- [ ] **3.1 Remove dead code**: `pulse-wall.js` (after rename), pulse-rate CSS variables, sparkline rendering functions, last-seen `ageLabel()` function (if only used by pulse wall).
- [ ] **3.2 Cache-bust**: bump `?v=N` query string on renamed JS file in `index.html`.
- [ ] **3.3 Update i18n**: remove `pulse_wall` keys, add `agent_fleet` keys with EN/ZH translations.

## Test Checklist

- [ ] Unit test: `buildSelfRecord()` returns all new fields (model, effort, threshold, 3-tier cost, system metrics, has_upgrade, has_subagent)
- [ ] Unit test: fleet SSE event is emitted on poll cycle completion
- [ ] Unit test: self-agent is always first in fleet array
- [ ] Unit test: `ageLabel()` removal doesn't break other code (grep for usage)
- [ ] Frontend: `npm run check` passes (syntax check)
- [ ] `npm test` passes
- [ ] `npm run smoke` passes
- [ ] Manual: browser — fleet view shows all 11 requirements from issue
- [ ] Manual: browser — single-agent detail view still works (no regression)

## Assumptions

- [ ] Remote agents' `/api/state` already returns `runtime_info` (model, effort) and `new_session_threshold` — verified in code (index.js:392-396). **Guaranteed.**
- [ ] Remote agents' `/api/state` does NOT currently return system metrics (CPU/mem/disk) or daily/weekly cost — those come from `/api/system` and `/api/metrics`. For remote agents, system metrics will only be available if we add them to `/api/state`. **Needs implementation in 1.2 or accept as limitation for remote agents.**
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
