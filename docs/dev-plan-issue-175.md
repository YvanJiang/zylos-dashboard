# Dev Plan: Fleet Poller SSE Subscription + Self/Remote Path Unification (#175)

## Summary

Replace the fleet poller's 3-second HTTP polling with SSE subscriptions for real-time remote agent updates, and unify the self/remote fleet record construction to eliminate the dual code path that caused the snake/camelCase cost bug (#174).

## Scope

**In scope:**
- New `fleet_state` SSE event on the server — emits `buildApiStatePayload()` data whenever state/metric/system/cost changes
- Fleet poller subscribes to each remote agent's `/api/stream` via SSE, listening for `fleet_state` events
- Auth via `Authorization: Bearer <session_token>` header on Node `fetch()` stream (no query param tokens)
- Shared pure mapper `stateToFleetRecord()` used by both self and remote paths
- Graceful degradation: SSE reconnection with exponential backoff, fall back to HTTP poll if SSE unavailable
- Existing fleet poller API contract preserved (`getFleet()`, `start()`, `stop()`, `pollOnce()`)

**Out of scope:**
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

Two separate code paths with different field mapping. The self path had the #174 bug.

### Target architecture

```
Server (new):
  On state/metric/system/cost change → sse.broadcast('fleet_state', buildApiStatePayload())

Self agent:
  buildApiStatePayload() → stateToFleetRecord() → fleet record

Remote agents:
  SSE client → /api/stream → on 'fleet_state' → stateToFleetRecord() → fleet record
  (fallback: HTTP GET /api/state → stateToFleetRecord() → fleet record)
```

One shared `stateToFleetRecord(agentConfig, statePayload, opts)` pure function for both paths. Self passes `{ self: true, base_url: null }`, remote passes `{ self: false, base_url: agent.base_url }`.

### Server: `fleet_state` event

Add a new SSE event `fleet_state` that emits `buildApiStatePayload()` whenever any of these change:
- State engine state change (currently broadcasts `state_change`)
- Metric update (currently broadcasts `metric_update`)
- System metrics update
- Cost data change

This is a superset of `state_change` — it includes all fields the fleet poller needs: state, runtime_info, system_metrics, context_pct, cost tiers, new_session_threshold.

### SSE client design

- Node `fetch()` with `Authorization: Bearer <token>` header on the readable stream — no query param tokens (avoids URL/log exposure).
- Lightweight SSE parser: read chunked text, parse `event:` / `data:` / `id:` / comment lines. Handle multi-line data, CRLF, and SSE comments. No npm dependency.
- Each remote agent gets one persistent SSE connection to `/api/stream`.
- On `fleet_state` event: parse JSON data, call `stateToFleetRecord()`, update record, trigger `onPoll` callback.
- On `auth_expired` event (sent by `SseHub` when token expires): refresh token via `_ensureToken(force: true)` and reconnect.
- On connection drop: reconnect with exponential backoff (1s, 2s, 4s, max 30s). On reconnect, do one immediate HTTP GET `/api/state` to catch up, then resume SSE.
- `stop()` must abort all active fetch streams (via `AbortController`), not just clear timers.
- Keep HTTP `pollOnce()` as a public method for on-demand refresh and initial bootstrap.

### Fallback mode

When SSE connection cannot be established or drops:
- Resume 3s HTTP polling timer for that agent (same as current behavior)
- On SSE recovery: stop the poll timer for that agent, resume SSE-only mode
- Each agent tracks its own mode independently (SSE vs polling)

### Self record unification

- Extract `stateToFleetRecord(agentConfig, statePayload, opts)` as a pure function from `_setSuccess()` logic.
- `buildSelfFleetRecord()` calls `buildApiStatePayload()` → `stateToFleetRecord({ name, color }, payload, { self: true })`.
- `_setSuccess()` calls `stateToFleetRecord({ name, base_url, color }, state, { self: false })` and stores in `records`.
- Remove `buildSelfRecord()` function and its camelCase parameter interface.

## Development Checklist

### Server changes
- [ ] Add `fleet_state` SSE event emission in index.js: broadcast `buildApiStatePayload()` on state change, metric update, system update, cost change
- [ ] Throttle/debounce `fleet_state` emissions to avoid flooding (e.g. at most once per second)

### Shared mapper
- [ ] Extract `stateToFleetRecord(agentConfig, statePayload, opts)` pure function from `_setSuccess()` logic
- [ ] Both self and remote paths use this single mapper
- [ ] Remove `buildSelfRecord()` function and camelCase parameter interface
- [ ] Update `buildSelfFleetRecord()` to use `buildApiStatePayload()` → `stateToFleetRecord()`

### SSE client
- [ ] Add SSE line parser (parse `event:`, `data:`, `id:`, comments, multi-line data, CRLF)
- [ ] SSE connection uses `Authorization: Bearer <token>` header via Node `fetch()` — no token in URL
- [ ] Verify `/api/stream` accepts Bearer auth (existing `AuthGate.getApiAuth()` supports this)
- [ ] Refactor `FleetPoller` to manage persistent SSE connections per agent
- [ ] On `fleet_state` event: parse JSON, call `stateToFleetRecord()`, update record, trigger `onPoll`
- [ ] On `auth_expired` event: refresh token, reconnect
- [ ] Reconnection with exponential backoff (1s → 2s → 4s → max 30s)
- [ ] On reconnect: immediate HTTP GET `/api/state` to catch up, then resume SSE
- [ ] `stop()` aborts all active fetch streams via `AbortController`
- [ ] Fallback: resume 3s HTTP poll timer per-agent if SSE fails; stop poll timer on SSE recovery

### Backward compatibility
- [ ] Keep `pollOnce()` public method for on-demand refresh and initial bootstrap
- [ ] HTTP poll still works against older dashboard versions that don't emit `fleet_state`
- [ ] Existing `getFleet()`, `start()`, `stop()` API contract preserved

## Test Checklist

- [ ] Unit test: SSE line parser — `event:`, `data:`, `id:`, multi-line data, comments, CRLF
- [ ] Unit test: SSE reconnection logic — mock stream close → verify backoff timing → verify catch-up poll
- [ ] Unit test: SSE `auth_expired` event triggers token refresh and reconnect
- [ ] Unit test: `stop()` aborts active SSE fetch streams
- [ ] Unit test: `stateToFleetRecord()` produces identical records from self and remote inputs
- [ ] Unit test: self record via unified path has valid cost/context/system fields (no nulls for available data)
- [ ] Unit test: fallback polling resumes when SSE drops, stops when SSE recovers
- [ ] Unit test: `fleet_state` SSE event data matches `buildApiStatePayload()` shape
- [ ] Unit test: `/api/stream` accepts Bearer auth header (no token in URL)
- [ ] Integration test: `/api/fleet` self record has valid cost/context/system fields (extends #174 test)
- [ ] Regression: existing fleet poller tests still pass (token exchange, stale marking, secret filtering)
- [ ] Regression: existing `/api/state` and `/api/fleet` tests still pass

## Assumptions

- [x] `/api/stream` SSE endpoint is available on fleet agents running the same version. Older versions may not emit `fleet_state` — HTTP fallback handles this.
- [x] `/api/stream` accepts `Authorization: Bearer <session_token>` header — verified: `AuthGate.getApiAuth()` reads Authorization header, `auth.handle()` lets API bearer through, `/api/stream` stores `req._apiToken` for session validation.
- [x] SSE `state_change` event data does NOT match `/api/state` shape — verified. Solution: new `fleet_state` event emitting `buildApiStatePayload()`.
- [x] Network between fleet agents is reliable enough for persistent connections. Fallback polling handles unreliable networks.

## Acceptance Checklist

- [ ] Remote agent fleet tile updates in real-time (< 1s latency) without page refresh
- [ ] Self agent fleet tile shows cost, context, system metrics identical to single-agent view
- [ ] SSE connection recovers after network interruption (simulate by restarting remote dashboard)
- [ ] Falls back to HTTP polling if SSE connection cannot be established
- [ ] No session tokens appear in URLs or logs
- [ ] All tests pass (`npm test`)
- [ ] No regressions in existing fleet behavior
