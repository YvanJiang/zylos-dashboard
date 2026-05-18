# Dev Plan: Codex Runtime Graceful Degradation (#103)

## Summary

When running on Codex runtime, the dashboard should automatically hide Claude-specific panels and skip Claude-only data collectors, while keeping runtime-agnostic features (PM2, system health, communication, scheduler) fully functional. A confirm dialog warns users when switching from Claude to Codex.

## Scope

**In scope** (from issue consensus):
- Runtime detection from zylos config (single source of truth)
- Unified `config.runtime` set at startup — all downstream code (collectors, state engine, actions, buildRuntimeInfo) uses the same source
- Skip Claude-only collectors on non-Claude runtimes
- Frontend: hide Runtime State card, Capacity & Cost card, Trends tab, Work Timeline on Codex
- Frontend: skip Claude-only fetches (metrics, timeline, summary) on Codex refreshAll
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
- [x] **B1**: Compute `activeRuntime` from `loadZylosConfig().runtime || process.env.ZYLOS_RUNTIME || 'claude'` at startup. Set `config.runtime = activeRuntime` so all downstream code (PM2Collector, SystemCollector, StateEngine, actions.js) reads the same value via `config.runtime`
- [x] **B2**: Skip `StatuslineCollector` and `ConversationCollector` construction when runtime !== 'claude'. All direct references null-safe (optional chaining in `buildRuntimeInfo`, conditional wiring for state engine, conditional startup collect)
- [x] **B3**: `buildRuntimeInfo()` uses `activeRuntime` directly instead of env var. Handles null `statuslineCollector` with optional chaining

### Frontend (`public/js/app.js`)
- [x] **F1**: Null guard in `refreshState()` — early return if response is not an object
- [x] **F2**: Null guard in `applySse()` — early return at top if data is null/non-object
- [x] **F3**: Null guard in `refreshTimeline()` — early return if response is not an object
- [x] **F4**: `applyRuntimeVisibility()` function — reads `runtime_info.runtime`, hides/shows panels. Cached to avoid redundant DOM updates
- [x] **F5**: Degraded-mode banner (`#codex-degraded-banner`) injected after info bar, visible only on Codex
- [x] **F6**: Enhanced confirm dialog — `confirm.switch_runtime_codex` key for Claude->Codex (warns about feature reduction)
- [x] **F7**: `refreshAll()` skips `refreshMetrics()`, `refreshTimeline()`, `refreshSummary()` on non-Claude runtime
- [x] **F8**: `isClaudeRuntime()` helper for frontend runtime checks

### i18n
- [x] **I1**: `en.json`: `banner.codex_degraded`, `confirm.switch_runtime_codex`
- [x] **I2**: `zh.json`: same keys with Chinese translations

### CSS
- [x] **C1**: `.codex-banner` style (grid-column span, subtle bg, centered text)

### SKILL.md
- [x] **S1**: Updated description with runtime support note

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
- [ ] No startup errors in console when running on Codex (collectors skipped cleanly)
- [ ] `npm run check` passes (if available)

## Acceptance Checklist

- [ ] Claude runtime: all panels visible, Trends tab works, no banner
- [ ] Codex runtime: Claude-only panels hidden, banner visible, PM2/system healthy
- [ ] Runtime switch confirm dialog warns about feature reduction (Claude->Codex only)
- [ ] No JS console errors on either runtime
- [ ] SKILL.md updated with runtime support note
- [ ] Browser screenshots verified for both runtimes
