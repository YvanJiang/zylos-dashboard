# Dev Plan: Fleet Poller SSE Subscription + Self/Remote Path Unification (#175)

## Summary

Replace the fleet poller's 3-second HTTP polling with SSE subscriptions for real-time remote agent updates, and unify the self/remote fleet record construction to eliminate the dual code path that caused the snake/camelCase cost bug (#174).

## Scope

**In scope:**
- Fleet poller subscribes to each remote agent's `/api/stream` via SSE instead of polling `/api/state`
- Self agent record built using the same `_setSuccess()` path as remote agents (via `/api/state` or internal equivalent)
- Graceful degradation: SSE reconnection with exponential backoff, fall back to HTTP poll if SSE unavailable
- Auth token management for SSE connections (same token exchange as current polling)
- Existing fleet poller API contract preserved (`getFleet()`, `start()`, `stop()`, `pollOnce()`)

**Out of scope:**
- Changes to the SSE server (`SseHub`) — the existing stream format is sufficient
- Changes to the frontend — it already consumes fleet SSE events
- Changes to `/api/state` response shape — already fixed in #171/#174

## Design

### Current architecture

```
Self agent:
  buildSelfFleetRecord() → getCostTiers() + metricResolver + stateEngine → buildSelfRecord() → fleet record

Remote agents:
  FleetPoller._pollAgent() → HTTP GET /api/state every 3s → _setSuccess() → fleet record
```

Two separate code paths converge at `buildFleetPayload()`. The self path had the #174 bug.

### Target architecture

```
Self agent:
  buildApiStatePayload() → _setSuccess() → fleet record  (same parser as remote)

Remote agents:
  FleetPoller SSE client → /api/stream → on 'state_change' → _setSuccess() → fleet record
  (fallback: HTTP GET /api/state on reconnect or if SSE unavailable)
```

One `_setSuccess()` path for both. Self builds its own `/api/state` payload internally (no HTTP call needed) and feeds it through the same record builder.

### SSE client design

- Node.js has no native `EventSource`. Use a lightweight SSE parser on a `fetch()` readable stream (no npm dependency — parse `event:` / `data:` / `id:` lines manually from chunked response).
- Each remote agent gets one persistent SSE connection to `/api/stream`.
- Auth: exchange API key for session token (existing `_ensureToken()`), pass as query param `?token=<session_token>` (SSE EventSource can't set headers; the dashboard's `/api/stream` handler already validates cookie OR bearer token — need to verify query param support or add it).
- On `state_change` event: parse JSON data, call `_setSuccess(agent, data)`.
- On connection drop: reconnect with exponential backoff (1s, 2s, 4s, max 30s). On reconnect, do one immediate HTTP GET `/api/state` to catch up, then resume SSE.
- On auth error (401 event or HTTP 401): refresh token and reconnect.
- Keep HTTP `pollOnce()` as a public method for on-demand refresh and initial bootstrap.

### Self record unification

- `buildSelfFleetRecord()` calls `buildApiStatePayload()` (which already builds the full `/api/state` response) and passes it through `_setSuccess()`-equivalent logic.
- Remove `buildSelfRecord()` function — no longer needed as a separate entry point.
- The fleet record fields will be identical whether the agent is self or remote.

## Development Checklist

- [ ] Add SSE client parser to fleet-poller.js (parse `event:`, `data:`, `id:` lines from readable stream, no external dependency)
- [ ] Add `/api/stream` token auth via query param (`?token=`) if not already supported
- [ ] Refactor `FleetPoller` to manage persistent SSE connections per agent instead of poll timer
- [ ] Implement reconnection with exponential backoff (1s → 2s → 4s → max 30s)
- [ ] On reconnect: immediate HTTP GET `/api/state` to catch up, then resume SSE
- [ ] On `state_change` SSE event: call `_setSuccess(agent, data)` and trigger `onPoll` callback
- [ ] Keep `pollOnce()` for on-demand refresh (used by initial load + fallback)
- [ ] Unify self record: `buildSelfFleetRecord()` calls `buildApiStatePayload()` → passes through same `_setSuccess()` field mapping
- [ ] Remove `buildSelfRecord()` function and its camelCase parameter interface
- [ ] Update `buildFullFleetPayload()` to use the unified self record
- [ ] Ensure `stop()` closes all SSE connections cleanly

## Test Checklist

- [ ] Unit test: SSE line parser correctly handles `event:`, `data:`, `id:`, multi-line data, comments
- [ ] Unit test: SSE reconnection logic (mock stream close → verify backoff timing → verify catch-up poll)
- [ ] Unit test: SSE auth error triggers token refresh and reconnect
- [ ] Unit test: `_setSuccess()` produces identical records whether called from SSE event or HTTP poll
- [ ] Unit test: self record via unified path matches remote record structure (same fields, no nulls for available data)
- [ ] Integration test: `/api/fleet` self record has valid cost/context/system fields (extends #174 test)
- [ ] Regression: existing fleet poller tests still pass (token exchange, stale marking, secret filtering)
- [ ] Regression: existing `/api/state` and `/api/fleet` tests still pass

## Assumptions

- [ ] `/api/stream` SSE endpoint is available on all fleet agents (guaranteed — same dashboard version)
- [ ] SSE `state_change` event data does NOT match `/api/state` response shape. Verified: `state_change` is `stateEngine.getState() + runtime_info` only — missing `system_metrics`, `context_pct`, `cost tiers`, `new_session_threshold`, `agent` identity. These are added only in `buildApiStatePayload()`. **Design impact**: SSE alone is insufficient. Options: (A) add a new `fleet_state` SSE event that emits `buildApiStatePayload()` data, (B) subscribe to `state_change` + `metric_update` + `system_update` and merge, (C) hybrid: SSE for state/activity changes + lower-frequency HTTP poll (e.g. 30s) for full metrics. **Recommended: Option A** — emit `buildApiStatePayload()` as a `fleet_state` event whenever any component changes, so SSE clients get the same data as `/api/state`.
- [ ] Token auth via query param on `/api/stream` is supported or can be added (needs verification — current auth checks cookie or Bearer header)
- [ ] Network between fleet agents is reliable enough for persistent connections (reasonable — both agents are on stable servers)

## Acceptance Checklist

- [ ] Remote agent fleet tile updates in real-time (< 1s latency) without page refresh
- [ ] Self agent fleet tile shows cost, context, system metrics identical to single-agent view
- [ ] SSE connection recovers after network interruption (simulate by restarting remote dashboard)
- [ ] Falls back to HTTP polling if SSE connection cannot be established
- [ ] All tests pass (`npm test`)
- [ ] No regressions in existing fleet behavior
