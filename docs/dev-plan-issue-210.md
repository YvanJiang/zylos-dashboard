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
- **Authorization**: all five are admin-gated — extend `needsAdminApiAccess()` (browser session or admin-scope consumer API session). They are local config endpoints; the fleet proxy write whitelist does NOT include them, so they cannot be invoked cross-machine — assert this in tests.
- **Persistence**: reuse the atomic write pattern from `src/index.js:868` (tmp file + rename, mode 0600), read-modify-write the current on-disk config to avoid clobbering unrelated keys.
- **Hot-apply**: `FleetPoller.addAgent(cfg)` / `removeAgent(name)` — per-agent streams/tokens/records are already keyed maps; add = push to `this.agents` + open stream + immediate poll; remove = abort stream, clear maps. Rename self flows through the self-record builder; both trigger an immediate fleet rebroadcast so all walls update. **No service restart.**
- **Frontend**: "+" (person/plus icon) button in `.header-actions` before the bell. Hidden in standalone `REMOTE_AGENT` mode (it configures the local consumer). Modal sections: ① self row with inline rename; ② remote agents list with remove (confirm dialog); ③ add form (name / base URL / key `type=password`) with **Test connection** showing reachable + key scope before save. Hue hint on rename (tile color is name-keyed). i18n en/zh; `app.js?v=42`.

## Development Checklist

- [ ] `needsAdminApiAccess`: add the five routes (and keep proxied-write set unchanged).
- [ ] Config persistence helper (atomic, read-modify-write) shared by add/remove/rename.
- [ ] `FleetPoller.addAgent` / `removeAgent` + self-rename propagation + rebroadcast.
- [ ] HTTP handlers with validation + masked GET + test-connection probe (reuses `_ensureToken`-style exchange with explicit key, bounded timeout).
- [ ] Header button + manage modal + i18n + cache bust.
- [ ] Remote view behavior: button hidden in standalone; in-page remote keeps it (global header, local semantics).

## Test Checklist

- [ ] API: validation failures (dup/bad name, bad URL, empty key), masked key in GET (full key never in any response), admin-gate (read bearer 403; browser session OK), proxy cannot reach these routes (`/fleet/<name>/api/fleet/agents` POST → `read_only_proxy`).
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
