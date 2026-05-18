# Dev Plan: Codex Runtime Graceful Degradation (#103)

## Summary

When running on Codex runtime, the dashboard should automatically hide Claude-specific panels and skip Claude-only data collectors, while keeping runtime-agnostic features (PM2, system health, communication, scheduler) fully functional. A confirm dialog warns users when switching from Claude to Codex.

## Scope

**In scope** (from issue consensus):
- Runtime detection from zylos config (single source of truth)
- Skip Claude-only collectors on non-Claude runtimes
- Frontend: hide Runtime State card, Capacity & Cost card, Trends tab, Work Timeline on Codex
- Frontend: 3 null guards (refreshState, applySse state_change, refreshTimeline)
- Frontend: "Some features require Claude runtime" banner on Codex
- Actions modal: enhanced confirm dialog for Claude->Codex switch (warn about feature reduction)
- SKILL.md: runtime support note
- i18n: new keys for banner and enhanced confirm text (EN + ZH)

**Out of scope:**
- Codex data pipeline (JSONL parsing, token extraction)
- Codex-native agent state inference
- `ZYLOS_RUNTIME` env for zylos-core lifecycle hooks (separate core PR)

## Development Checklist

### Backend (`src/index.js`)
- [ ] **B1**: Fix `buildRuntimeInfo()` (line 117) — use `loadZylosConfig(config.zylosDir).runtime || process.env.ZYLOS_RUNTIME || 'claude'` instead of just env var, for consistency with actions.js
- [ ] **B2**: Skip `StatuslineCollector` and `ConversationCollector` construction when runtime !== 'claude'. Keep PM2 and System collectors. Wire remaining collectors to state engine accordingly
- [ ] **B3**: Add `runtime` field to `/api/state` response from `buildRuntimeInfo()` (already present via `runtime_info.runtime`, verify it propagates)

### Frontend (`public/js/app.js`)
- [ ] **F1**: Add null guard in `refreshState()` (line 869-878) — check that fetchJson result is an object before accessing `.updated_at`
- [ ] **F2**: Add null guard in `applySse('state_change')` (line 943-951) — check `data` is an object before accessing `.runtime_info`, `.updated_at`
- [ ] **F3**: Add null guard in `refreshTimeline()` (line 913-919) — check `data` is an object before accessing `.events`
- [ ] **F4**: Add runtime-aware panel visibility — read `runtime_info.runtime` from state, hide/show panels:
  - `.runtime-card` (Live Runtime State): hide on Codex
  - Capacity & Cost card (section with `#capacity-title`): hide on Codex
  - `.timeline-card` (Current Work Timeline): hide on Codex
  - Trends tab button + panel: hide on Codex
- [ ] **F5**: Add degraded-mode banner below info bar — "Some features require Claude runtime" text, visible only on Codex
- [ ] **F6**: Enhance runtime switch confirm dialog — when switching Claude->Codex, show expanded text warning about dashboard feature reduction. Codex->Claude stays as-is.

### i18n
- [ ] **I1**: Add keys to `en.json`: `banner.codex_degraded`, `confirm.switch_runtime_codex`
- [ ] **I2**: Add keys to `zh.json`: same keys with Chinese translations

### SKILL.md
- [ ] **S1**: Add note: "Full features on Claude runtime. PM2/system/communication/scheduler monitoring on all runtimes."

## Test Checklist

- [ ] Start dashboard on Claude runtime — all panels visible, no banner, Trends tab accessible
- [ ] Simulate Codex runtime (set `runtime: "codex"` in `~/.zylos/config.json`) — verify:
  - Runtime State card hidden
  - Capacity & Cost card hidden
  - Work Timeline card hidden
  - Trends tab hidden
  - Degraded banner visible
  - PM2/System/Communication/Scheduler still visible and functional
  - Info bar still shows runtime info
- [ ] Actions modal: switch runtime Claude->Codex — confirm dialog shows enhanced warning text
- [ ] Actions modal: switch runtime Codex->Claude — standard confirm, no extra warning
- [ ] Null guard: `/api/state` returns null-ish response — page degrades gracefully
- [ ] SSE `state_change` with null data — no JS errors
- [ ] `/api/timeline` returns null — no JS errors
- [ ] `npm test` passes (if tests exist)
- [ ] Lint clean

## Acceptance Checklist

- [ ] Claude runtime: all panels visible, Trends tab works, no banner
- [ ] Codex runtime: Claude-only panels hidden, banner visible, PM2/system healthy
- [ ] Runtime switch confirm dialog warns about feature reduction (Claude->Codex only)
- [ ] No JS console errors on either runtime
- [ ] SKILL.md updated with runtime support note
- [ ] Browser screenshots verified for both runtimes
