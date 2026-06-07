# Dev Plan: Distinguish Codex Installed Version from Running Session Version (#151)

## Summary

Codex runtime currently shows the installed CLI version everywhere, but a Codex session may still be running an older version after an upgrade until the session restarts. This issue adds running-version tracking from rollout JSONL `session_meta.payload.cli_version`, enabling the same installed-vs-running distinction that Claude runtime already has.

## Scope

**In scope (from issue decisions):**
- CodexRolloutCollector reads `session_meta.payload.cli_version` and stores it in runtime info
- `buildRuntimeInfo()` exposes `codex_running` alongside existing `codex_installed`
- Info bar shows running version when available, with restart indicator when installed > running
- Actions modal shows running version for Codex (mirroring Claude's pattern)
- `pending_restart` extended to cover Codex installed > running
- Tests for all four states: installed-only, installed > running, installed == running, missing cli_version

**Out of scope:**
- Claude runtime behavior (unchanged)
- Database schema changes (running version is ephemeral in-memory state, same as Claude's cc_version)
- Codex rollout format changes (we consume existing `session_meta` events)

## Development Checklist

- [ ] **1. CodexRolloutCollector: handle `session_meta` events**
  - In `_ingestEvent()`: add handler for `event.type === 'session_meta'` that extracts `payload.cli_version`
  - Call `_updateRuntimeInfo()` with a new `cliVersion` field
  - In `_getTranscriptMetadata()`: also scan for `session_meta` events and cache `cli_version`
  - In `_updateRuntimeInfo()`: store `cli_version` in `_runtimeInfo` object, include in change detection

- [ ] **2. buildRuntimeInfo(): expose codex_running and codex_restart**
  - Extract `codexRuntimeInfo.cli_version` as `codex_running`
  - Set `info.codex_running = codexRunning`
  - Update `info.codex_version` to prefer running version over installed (matching Claude's `cc_version = ccRunning`)
  - Extend `needsRestart` / `pending_restart` for Codex: when `codexInstalledVersion && codexRunning && isNewerVersion(codexInstalledVersion, codexRunning)`
  - Add `info.codex_restart = codexInstalledVersion` when installed > running (matching `cc_restart` pattern)

- [ ] **3. Actions modal meta: update cc_version for Codex**
  - In `/api/actions/meta` handler: when Codex runtime, set `meta.cc_version` to running version (fallback to installed)
  - This ensures the actions modal shows the version currently in use

- [ ] **4. Info bar UI: show restart indicator for Codex**
  - In `renderInfoBar()`: when Codex runtime, check `ri.codex_restart` and show restart indicator (↑ with `info.restart_available` tooltip), taking priority over `ri.codex_update`
  - Pattern: `if (ri.codex_restart) ... else if (ri.codex_update) ...` (matching Claude's cc_restart > cc_update precedence)
  - Display running version when available: `ri.codex_running || ri.codex_version || ri.codex_installed`

- [ ] **5. Frontend behavior test: verify restart indicator rendering**
  - Add assertion in `frontend-behavior.test.js` that info bar checks `codex_restart` before `codex_update`

- [ ] **6. Test fixture: add session_meta event**
  - Add `{"type":"session_meta","timestamp":"...","payload":{"id":"...","originator":"codex-tui","cli_version":"0.130.0","source":"cli"}}` to `test/fixtures/codex/rollout.jsonl`

- [ ] **7. Codex runtime tests: session_meta handling**
  - Test that collector extracts cli_version from session_meta and exposes it in getRuntimeInfo()
  - Test installed-only (no session_meta) → codex_running is null, codex_version = installed
  - Test installed newer than running → codex_restart set, pending_restart true
  - Test installed == running → no codex_restart
  - Test missing session_meta cli_version → fallback to installed

- [ ] **8. Runtime-info tests: version update with running version**
  - Verify applyVersionUpdateFields still works correctly when codex_running is present

## Test Checklist

- [ ] `session_meta.payload.cli_version` parsed and stored by CodexRolloutCollector
- [ ] `getRuntimeInfo()` includes `cli_version` after processing session_meta
- [ ] `buildRuntimeInfo()` returns `codex_running`, `codex_installed`, `codex_version`, `codex_restart` correctly
- [ ] `pending_restart` is true when Codex installed > running
- [ ] Info bar shows running version and restart indicator (code pattern check)
- [ ] Actions modal shows running version for Codex runtime
- [ ] Existing Claude runtime tests unchanged
- [ ] All existing tests pass (`npm test`)
- [ ] Smoke test passes (`npm run smoke`)

## Assumptions

- [ ] **Codex rollout JSONL emits `session_meta` as the first event with `payload.cli_version`** — Confirmed in issue description with real example data. If `session_meta` is absent (older Codex versions), fall back to installed version gracefully.
- [ ] **`cli_version` in session_meta is a semver-compatible string** — Same format as `codex --version` output after normalization. `isNewerVersion()` from version-utils.js handles comparison.
- [ ] **Running version is ephemeral in-memory state** — Same pattern as Claude's `cc_version` from statusline. No database storage needed. Resets when collector restarts or new session starts.
- [ ] **One active Codex session at a time** — Latest `session_meta.cli_version` always represents the current running version. No multi-session tracking needed.

## Acceptance Checklist

- [ ] `npm test` — all tests pass (existing + new)
- [ ] `npm run smoke` — server starts and responds
- [ ] Info bar shows Codex running version (not installed) when session_meta is available
- [ ] Info bar shows restart indicator when installed > running
- [ ] Info bar shows update indicator when latest > installed (existing behavior preserved)
- [ ] Actions modal shows running version for Codex
- [ ] Claude runtime behavior completely unchanged
- [ ] No regressions in existing dashboard features
