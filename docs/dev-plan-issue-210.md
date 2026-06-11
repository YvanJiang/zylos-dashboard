# Dev Plan: Fleet onboarding UI — add agents + rename local agent (#210)

## Summary

Header entry to manage the fleet from the UI: add/remove remote agents (today: hand-edit `config.json` + restart) and rename the local agent. Howard's placement: top header bar, near the bell.

## Scope

**In**: header "+" entry, manage modal (list / add with test-connection / remove / rename self), admin-gated local config API, atomic persist, hot-apply without service restart.
**Out**: editing an existing agent's URL/key (remove + re-add covers it for v1); pack-versioned i18n cache prefix (noted from #211 review — piggyback here only if trivial); any producer-side change.

## Design decisions

- **API surface (consumer-local, never proxied)**:
  - `GET /api/fleet/agents` → `{ self: { name }, agents: [{ name, base_url, key_masked, access }] }` — full key never echoed (mask to `zylos_ak_…last4`).
  - `POST /api/fleet/agents` `{ name, base_url, read_api_key }` — validates name (unique vs self+remotes, `[\w.-]{1,32}`), URL (http/https), key non-empty; persists; hot-attaches.
  - `POST /api/fleet/agents/test` `{ base_url, read_api_key }` → `{ reachable, scope, version? }` via token exchange + `/api/state` probe; never persisted.
  - `DELETE /api/fleet/agents/<name>` — detaches stream, drops records/tokens, persists.
  - `PUT /api/agent/name` `{ name }` — renames local agent (`config.agent.name`), same validation.
- **Authorization**: all five are admin-gated — extend `needsAdminApiAccess()` (browser session or admin-scope consumer API session).
- **Consumer-local enforcement (review finding #3)**: not-being-in-the-write-whitelist only blocks proxied writes — the proxy forwards all GET/HEAD by default, so a future producer-side `GET /api/fleet/agents` would become reachable via `/fleet/<name>/api/fleet/agents` and break the consumer-local semantics. Add an explicit **proxy denylist** for `/api/fleet/agents`, `/api/fleet/agents/test`, `/api/agent/name` (and subpaths): every method fails closed at the FleetProxy layer. Tests cover GET (not just POST) never reaching the remote.
- **Persistence**: reuse the atomic write pattern from `src/index.js:868` (tmp file + rename, mode 0600), read-modify-write the current on-disk config to avoid clobbering unrelated keys. The read→modify→write critical section is **synchronous** (no `await` inside), matching the settings writer, so the two in-process writers cannot interleave a lost update.
- **Hot-apply**: `FleetPoller.addAgent(cfg)` / `removeAgent(name)` — per-agent streams/tokens/records are already keyed maps. **No service restart.**
  - **Empty-fleet start (review finding #1)**: `start()` returns early when `agents.length === 0`, so the poller may not be running when the *first* agent is added — Howard's primary scenario. `addAgent()` must ensure the poller enters its running state (start scheduling/SSE) when it wasn't; alternatively redefine `running` as "service started" independent of initial agent count. Either way, the first-add path gets a dedicated test: initial empty fleet → add → stream/poll starts → live fleet rebroadcast.
  - **Remove resurrection guard (review finding #2)**: an in-flight `_runSse()` that fails with a non-AbortError after removal would call `_startFallbackPolling` / `_scheduleReconnect`, and `_streamState()` recreates map entries on demand — resurrecting the deleted agent. Removal bumps a per-agent generation (or the continuation re-checks membership in `this.agents` + stream identity) so late continuations no-op: no recreated stream state, no token/poll traffic, absent from payload. Test triggers a late non-abort error and a stale reconnect timer after remove.
  - Rename self flows through the self-record builder; add/remove/rename all trigger an immediate fleet rebroadcast so all walls update.
- **Frontend**: "+" (person/plus icon) button in `.header-actions` before the bell. Hidden in standalone `REMOTE_AGENT` mode (it configures the local consumer). **In-page remote view keeps the button** — deliberate deviation from the issue's "hidden when viewing a remote agent" wording (review finding #4): the global header always belongs to the local consumer, and hiding/showing a header control as the view stack changes would be more confusing than the risk it removes. The tooltip + modal title make the target explicit ("Manage this dashboard's fleet" / "管理本机 fleet"), and the modal's self row names the local agent. Howard can veto at acceptance. Modal sections: ① self row with inline rename; ② remote agents list with remove (confirm dialog); ③ add form (name / base URL / key `type=password`) with **Test connection** showing reachable + key scope before save. Hue hint on rename (tile color is name-keyed). i18n en/zh; `app.js?v=42`.

## Development Checklist

- [ ] `needsAdminApiAccess`: add the five routes (and keep proxied-write set unchanged).
- [ ] Config persistence helper (atomic, read-modify-write) shared by add/remove/rename.
- [ ] `FleetPoller.addAgent` / `removeAgent` + self-rename propagation + rebroadcast.
- [ ] HTTP handlers with validation + masked GET + test-connection probe (reuses `_ensureToken`-style exchange with explicit key, bounded timeout).
- [ ] Header button + manage modal + i18n + cache bust.
- [ ] Remote view behavior: button hidden in standalone; in-page remote keeps it (global header, local semantics).

## Test Checklist

- [ ] API: validation failures (dup/bad name, bad URL, empty key), masked key in GET (full key never in any response), admin-gate (read bearer 403; browser session OK).
- [ ] Proxy denylist: `/fleet/<name>/api/fleet/agents` GET **and** POST, `/fleet/<name>/api/fleet/agents/test`, `/fleet/<name>/api/agent/name` all fail closed at the proxy without touching the remote.
- [ ] Poller first-add: initial empty fleet → `addAgent` → running state, SSE/poll starts, payload rebroadcast live.
- [ ] Poller remove: late non-abort SSE error and stale reconnect timer after `removeAgent` cannot recreate stream state, fetch tokens, or reappear in payload.
- [ ] Persist: config on disk updated atomically, unrelated keys preserved, mode 0600.
- [ ] Poller: addAgent starts polling/stream + appears in fleet payload; removeAgent stops stream and clears records/tokens; rename reflected in self record + payload.
- [ ] Test-connection: ok+scope on valid key, auth_failed on bad key, unreachable on dead URL; nothing persisted.
- [ ] Frontend static guards: header button, modal gating, password input, REMOTE_AGENT hidden.

## Assumptions

- [ ] Dashboard is the only live writer of `config.json` `fleet`/`agent` sections at runtime (CLI hooks write only during install/upgrade) — read-modify-write + atomic rename is sufficient.
- [ ] `agent.name` rename side effects are limited to display + name-keyed hue (config override for hue still wins) — no identity coupling elsewhere.
- [ ] A removed agent's session tokens on the remote simply expire; no revocation API needed.

## Acceptance Checklist

- [ ] Add flow: test-connection against Jinglever's URL with an invalid key → auth_failed shown; with the real read key → reachable + scope `read`; save a `jinglever-test` duplicate-URL entry → tile appears on the wall live (no restart); remove it → tile gone, config clean.
- [ ] Rename flow: rename local agent (e.g. `Zylos01` → `Zylos01x`) → header/tile/name + hue update live; rename back.
- [ ] Security: GET shows masked key only; curl with read bearer → 403; POST via `/fleet/Jinglever/api/fleet/agents` → `read_only_proxy`.
- [ ] Standalone remote page: no "+" button.
- [ ] Screenshots to Howard; full `npm test` + `npm run check`; no regressions (fleet wall, remote in-page view, #208 i18n).
