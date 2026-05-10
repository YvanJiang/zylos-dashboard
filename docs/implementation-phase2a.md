# Zylos Dashboard Phase 2a — Technical Implementation Plan

## 1. Implementation Overview

Phase 2a 交付：Store Module + Hook Ingest Pipeline + `/api/ingest` Endpoint + Spool Failover + State Engine + Overview 区块 ①②③ + REST API + SSE。

### 1.1 Module Dependency Graph

```
hook-ingest.cjs (独立进程，不依赖 Dashboard)
     │ HTTP POST
     ▼
┌─────────────────────────────────────────────────┐
│ src/index.js (HTTP server)                       │
│   ├── /api/ingest  ← IngestHandler              │
│   ├── /api/state   ← StateEngine                │
│   ├── /api/stream  ← SseHub (existing)          │
│   ├── /api/*       ← existing + new routes      │
│   └── static files ← existing                   │
├─────────────────────────────────────────────────┤
│ src/lib/store.js         ← better-sqlite3 owner │
│ src/lib/state-engine.js  ← state derivation     │
│ src/lib/sanitizer.js     ← redaction pipeline   │
│ src/lib/metric-resolver.js ← per-metric chains  │
│ src/lib/ingest-handler.js  ← POST handler       │
│ src/lib/spool-drainer.js   ← startup + periodic │
│ src/lib/hook-installer.js  ← Claude + Codex     │
│ src/lib/collectors/                              │
│   ├── pm2-collector.js     ← pm2 jlist polling  │
│   ├── system-collector.js  ← CPU/mem/disk       │
│   └── otel-collector.js    ← OTel reader        │
└─────────────────────────────────────────────────┘

public/
├── css/style.css            ← layout, components, base (no color values)
├── themes/light.css         ← token overrides for light theme
├── js/app.js                ← SSE client, state rendering, ticking timer
├── js/i18n.js               ← i18n loader + t()
├── i18n/en.json             ← English
├── i18n/zh.json             ← Chinese
└── index.html               ← responsive layout, data-i18n attributes
```

### 1.2 Implementation Order

按依赖关系自底向上。每个阶段完成后可独立测试。

| Step | Module | 依赖 | Mapped Tests |
|------|--------|------|-------------|
| 1 | `store.js` | better-sqlite3 | T-STORE-01~05 |
| 2 | `sanitizer.js` | 无 | T-INGEST-05~07 |
| 3 | `ingest-handler.js` | store, sanitizer | T-API-INGEST-01~06 |
| 4 | `hook-ingest.cjs` | 无（独立进程） | T-INGEST-01~10 |
| 5 | `spool-drainer.js` | store | T-SPOOL-01~05 |
| 6 | collectors (pm2/system/otel) | store | — |
| 7 | `state-engine.js` | store, collectors | T-STATE-01~20 |
| 8 | `metric-resolver.js` | store | T-AC2-01~06 |
| 9 | REST API + SSE integration | all above | T-API-*, T-SSE-* |
| 10 | Frontend Overview ①②③ | API | T-UI-01~07 |
| 11 | `hook-installer.js` | 无 | — |
| 12 | AC tests (restart, UX, hook health, latency) | all | T-AC1~AC5 |

---

## 2. Module Specifications

### 2.1 Store Module — `src/lib/store.js`

**Owned writes**: `runtime_events`, `metric_points`, `activity_facts`, `source_health`, `state_snapshots`, `schema_migrations`

**Mapped tests**: T-STORE-01, T-STORE-02, T-STORE-03, T-STORE-04, T-STORE-05

#### Interface

```javascript
// src/lib/store.js
import Database from 'better-sqlite3';

export class Store {
  constructor(dbPath) // opens DB, runs migrations, enables WAL

  // --- Schema ---
  migrate()           // idempotent: creates tables if missing, runs pending migrations

  // --- runtime_events ---
  insertEvent(event)  // CanonicalEvent → INSERT OR IGNORE (ingest_id dedup)
  queryEvents({ since, until, types, sessionId, limit, offset })
  latestEventByType(eventType)
  eventsSince(eventSeq)  // replay from cursor (AC-1)
  deleteEventsOlderThan(days)

  // --- metric_points ---
  insertMetric(point) // { timestamp, runtime, session_id, metric_name, metric_value, dimensions, source, confidence }
  queryMetrics({ name, since, until, granularity })
  aggregateDaily(olderThanDays)  // raw → daily aggregate, delete raw
  deleteMetricsOlderThan(days)

  // --- activity_facts ---
  insertFact(fact)
  queryFacts({ since, until, types, project, limit })
  deleteFactsOlderThan(days)

  // --- source_health ---
  upsertSourceHealth(name, signalType, status, extra)
  getSourceHealth()   // returns all rows
  getCollectorLiveness()  // returns only signal_type='collector_liveness' rows

  // --- state_snapshots (AC-1) ---
  saveSnapshot(snapshot)  // { runtime, session_id, running_tool, open_turn, pending_permission, possibly_stuck_since, last_progress_cursor, snapshot_at }
  latestSnapshot(runtime, sessionId)

  // --- lifecycle ---
  close()
}
```

#### Implementation Details

- **Single connection**: `new Database(dbPath)` at construction. Never re-opened. Stored as `this.db`.
- **WAL mode**: `this.db.pragma('journal_mode = WAL')` in constructor.
- **Prepared statements**: Cache via `this.db.prepare()` for all write paths. Store as instance properties (e.g. `this._insertEvent = this.db.prepare(...)`).
- **Schema migrations**: `schema_migrations` table checked on startup. Current version = 1 (initial schema). `migrate()` runs all unapplied migrations in a transaction.
- **event_seq**: Physical `event_seq INTEGER NOT NULL` column in `runtime_events` (required by PR #22 T-STORE-01 schema contract). Application-assigned on insert: within a transaction, `SELECT COALESCE(MAX(event_seq), 0) + 1 FROM runtime_events`, then `INSERT` with that value. This guarantees monotonically increasing sequence even across restarts. `eventsSince(cursor)` queries `WHERE event_seq > ?`. Snapshot stores `last_progress_cursor` = max event_seq at snapshot time. The schema adds `CREATE INDEX idx_events_seq ON runtime_events(event_seq)` for efficient cursor-based replay.

- **Failure behavior**: All write methods catch `SQLITE_CONSTRAINT` for dedup (expected for INSERT OR IGNORE). Other errors propagate to caller. No silent swallowing.
- **Retention cleanup**: `deleteEventsOlderThan(30)`, `aggregateDaily(90)` + `deleteMetricsOlderThan(90)`, `deleteFactsOlderThan(365)` — called from a periodic timer in index.js (once per hour).

#### state_snapshots Schema

```sql
CREATE TABLE state_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime TEXT NOT NULL,
  session_id TEXT,
  running_tool TEXT,          -- JSON: { tool_use_id, tool_name, started_at } or null
  open_turn TEXT,             -- JSON: { started_at } or null
  pending_permission TEXT,    -- JSON: { tool_name, requested_at } or null
  possibly_stuck_since TEXT,  -- ISO 8601 or null
  last_progress_cursor INTEGER NOT NULL,  -- max event_seq at snapshot time
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_snapshots_latest ON state_snapshots(runtime, session_id, snapshot_at DESC);
```

---

### 2.2 Sanitizer — `src/lib/sanitizer.js`

**Owned writes**: None (pure transform)

**Mapped tests**: T-INGEST-05, T-INGEST-06, T-INGEST-07

#### Interface

```javascript
// src/lib/sanitizer.js
export class Sanitizer {
  sanitizeHookPayload(hookEventName, rawPayload)
  // Returns: { session_id, duration_ms, summary, metadata }
  // metadata contains: { tool_name, tool_use_id } (for tool events), plus any other safe fields
  // Strips: tool_input, tool_response, prompt, full paths, credentials
  // NOTE: tool_name and tool_use_id live inside metadata, NOT as top-level fields.
  //       This matches the CanonicalEvent schema and state engine's access pattern.

  sanitizePath(fullPath)
  // "/home/howard/zylos/core/lib/startup.js" → "core/lib/startup.js"

  redactCredentials(text)
  // replaces sk-*, xoxb-*, ghp_*, Bearer tokens, emails → [REDACTED]/[EMAIL]

  buildSummary(hookEventName, toolName, durationMs)
  // "Bash tool completed, 1523ms" / "Permission requested: Bash"
}
```

#### Implementation Details

- **Path sanitization**: `path.relative(config.zylosDir, fullPath)` — produces the relative path from zylos root. Preserves full directory structure while removing the absolute prefix. If the path is outside zylos dir, `path.basename()` as fallback.
- **Credential patterns**: Regex array applied to all string values in metadata before storage:
  - `/sk-[a-zA-Z0-9_-]{20,}/g` → `[REDACTED]`
  - `/xoxb-[a-zA-Z0-9-]+/g` → `[REDACTED]`
  - `/ghp_[a-zA-Z0-9]{36,}/g` → `[REDACTED]`
  - `/Bearer\s+[a-zA-Z0-9._\-]+/g` → `Bearer [REDACTED]`
  - Email regex → `[EMAIL]`
- **D5 storage constraint**: The sanitizer enforces that the output object has NO `tool_input`, `tool_response`, or `tool_output` keys. These are deleted before return, regardless of content.
- **Summary generation**: Category-based description. No command content, no file path content.
  - PreToolUse: `"${toolName} tool started"`
  - PostToolUse: `"${toolName} tool completed, ${durationMs}ms"`
  - UserPromptSubmit: `"Turn started"`
  - Stop: `"Turn ended"`
  - PermissionRequest: `"Permission requested: ${toolName}"`
- **Failure behavior**: If sanitization encounters unexpected input shape, return a safe minimal object with event name and timestamp only. Never throw.

---

### 2.3 Ingest Handler — `src/lib/ingest-handler.js`

**Owned writes**: `runtime_events` (via store), `source_health` (via store)

**Mapped tests**: T-API-INGEST-01, T-API-INGEST-02, T-API-INGEST-03, T-API-INGEST-04, T-API-INGEST-05, T-API-INGEST-06

#### Interface

```javascript
// src/lib/ingest-handler.js
export class IngestHandler {
  constructor(store, sanitizer, stateEngine, config)

  handle(req, res)
  // POST /api/ingest → parse body → validate → sanitize → store → notify state engine → 200
}
```

#### Implementation Details

- **Loopback check**: First thing in `handle()`. Check `req.socket.remoteAddress` against `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. Non-local → 403 immediately, no body parsing.
- **Optional token**: If `config.ingestToken` is set, check `Authorization: Bearer <token>` header. Missing/wrong → 403.
- **CORS**: No `Access-Control-Allow-Origin` header on `/api/ingest` responses. OPTIONS preflight → no CORS headers → browser rejects.
- **Base-path isolation**: `/api/ingest` is mounted directly on the server, NOT under the base-path prefix. The existing `browserBaseFromRequest()` logic strips `X-Forwarded-Prefix` for routing — ingest must be excluded from this. Implementation: in `index.js` request handler, check for `/api/ingest` BEFORE applying base-path stripping. If the raw URL starts with the base-path prefix + `/api/ingest` → 404 (ingest not served under base-path).
- **Body parsing**: Use `readJsonBody(req, 64 * 1024)` from existing `src/lib/http.js` utility module (add this function alongside the existing `sendJson`/`sendText`/`serveStatic`). Handles chunk collection, size limit enforcement (413 on overflow), and `JSON.parse()` (400 on failure) in one reusable call.
- **Processing flow**:
  1. Extract `ingest_id`, `hook_event_name`, remainder from body
  2. Check `hook_event_name` against allowed set (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PermissionRequest`). Unknown → 200 OK (don't break hook-ingest.cjs) + increment ignored counter in source_health
  3. `sanitizer.sanitizeHookPayload(hookEventName, body)` → canonical fields
  4. Build CanonicalEvent: `{ id: uuid(), ingest_id, timestamp, runtime, session_id, event_type, category, summary, duration_ms, metadata: sanitized.metadata, source: 'hook', confidence: 'actual' }`. Note: `tool_name` and `tool_use_id` are inside `metadata` (placed there by the sanitizer), matching the state engine's `event.metadata.tool_name` / `event.metadata.tool_use_id` access pattern.
  5. `store.insertEvent(event)` — INSERT OR IGNORE handles dedup
  6. `stateEngine.onEvent(event)` — update in-memory state
  7. Update **both** source_health domains (not one or the other):
     - `store.upsertSourceHealth('hook_handler', 'collector_liveness', 'healthy', { last_success: now })` — proves the hook ingestion pipeline is alive
     - `store.upsertSourceHealth('hook_events', 'runtime_progress', 'healthy', { last_success: now })` — proves runtime is sending events
     Both must be updated on every successful ingest. Collector liveness requires `hook_handler` fresh; runtime progress requires `hook_events` fresh. Updating only one would create a gap: a healthy event stream could leave collector liveness stale (blocking STUCK confirmation) or vice versa.
  8. Return 200 `{ ok: true }`
- **event_type mapping**:
  - `PreToolUse` → `pre_tool_use`, category: `tool`
  - `PostToolUse` → `post_tool_use`, category: `tool`
  - `UserPromptSubmit` → `user_prompt_submit`, category: `turn`
  - `Stop` → `stop`, category: `turn`
  - `PermissionRequest` → `permission_request`, category: `permission`
- **Failure behavior**: Internal error during processing → log to stderr, return 500. Caller (hook-ingest.cjs) treats non-200 as failure and spools.

---

### 2.4 Hook Ingest Script — `lib/hook-ingest.cjs`

**Location**: `components/dashboard/lib/hook-ingest.cjs` (NOT under `src/` — runs as independent process)

**Owned writes**: Spool file (`components/dashboard/spool/hook-events.jsonl`)

**Mapped tests**: T-INGEST-01~10, T-SPOOL-01

#### Interface

Standalone script. No exports. Invoked by runtime hooks:
```
echo '<json>' | node ~/zylos/components/dashboard/lib/hook-ingest.cjs
```

#### Implementation Details

- **Process hard deadline**: Line 1 of script:
  ```javascript
  setTimeout(() => process.exit(0), 500);
  ```
  Guarantees process dies within 500ms regardless of any hang.

- **Stdin reading**: Collect all stdin data synchronously-like (readline or data events with 200ms idle timeout). Parse JSON. On parse failure → exit(0).

- **Allowed events filter**: Check `hook_event_name` against `['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']`. Not in list → exit(0) silently. (D5 minimal set)

- **ingest_id generation**: `crypto.randomUUID()` (Node 19+). Stable across retries (generated once per invocation).

- **HTTP POST**: `fetch()` (Node 18+ built-in) to `http://127.0.0.1:${port}/api/ingest` (port read from `config.json`):
  - Timeout: 200ms via `AbortController` + `setTimeout`
  - Body: `{ ingest_id, hook_event_name, received_at: new Date().toISOString(), ...payload }`
  - No retry on failure
  - On success (200): exit(0)
  - On failure (non-200, timeout, connection refused): fall through to spool

- **Spool fallback**: If POST fails:
  ```javascript
  const line = JSON.stringify({ ingest_id, received_at, hook_event_name, runtime, data: payload }) + '\n';
  fs.appendFileSync(spoolPath, line);
  ```
  `appendFileSync` is atomic-enough for single-line appends on most filesystems and completes in < 1ms.

- **Spool path**: `$ZYLOS_DIR/components/dashboard/spool/hook-events.jsonl` (or `~/zylos/components/dashboard/spool/hook-events.jsonl`). Create directory on first write if missing.

- **Spool size check**: Before appending, `fs.statSync(spoolPath).size`. If > `spoolMaxBytes` from `config.json` (default 10MB), skip append (data loss accepted — spool overflow). Still exit(0).

- **Exit code**: ALWAYS 0. Wrap entire script in try/catch → exit(0).

- **Port**: Read from `config.json` (`port` field, default `3470`). The script reads `config.json` via `fs.readFileSync` — no env var dependency.

- **No dependencies**: No `require` of any dashboard module. Only Node built-ins (`node:fs`, `node:path`, `node:crypto`, global `fetch`). No `better-sqlite3`. This keeps startup time minimal (~30ms for Node process).

- **Runtime detection**: Read `process.env.ZYLOS_RUNTIME` (set by Activity Monitor) or default to `'claude'`.

#### Failure Behavior Matrix

| Scenario | Behavior | Exit code |
|----------|----------|-----------|
| Invalid JSON stdin | Log to stderr, exit | 0 |
| Empty stdin | Exit immediately | 0 |
| Unknown hook event | Exit silently | 0 |
| POST success (200) | Exit | 0 |
| POST failure (non-200) | Spool, exit | 0 |
| POST timeout (>200ms) | Abort, spool, exit | 0 |
| POST connection refused | Spool, exit | 0 |
| Spool write failure | Log to stderr, exit | 0 |
| Spool over size limit | Skip spool, exit | 0 |
| Uncaught exception | Caught by outer try/catch, exit | 0 |
| Process deadline (500ms) | Forced exit | 0 |

---

### 2.5 Spool Drainer — `src/lib/spool-drainer.js`

**Owned writes**: `runtime_events` (via store), spool file deletion

**Mapped tests**: T-SPOOL-01~05

#### Interface

```javascript
// src/lib/spool-drainer.js
export class SpoolDrainer {
  constructor(store, sanitizer, config)

  drainToDb()
  // DB-only: rename spool file → parse → sanitize → store.insertEvent() → delete processed file
  // Does NOT call stateEngine. Used at startup before StateEngine exists.
  // Returns: { processed: number, duplicates: number, errors: number }

  drainLive(stateEngine)
  // Full path: same as drainToDb() but also calls stateEngine.onEvent() for each event.
  // Used by periodic timer after StateEngine is initialized.

  startPeriodicDrain(stateEngine, intervalMs)  // default 30s
  stopPeriodicDrain()
}
```

#### Implementation Details

- **Two drain modes**: `drainToDb()` writes events to SQLite only (no state engine notification). `drainLive(stateEngine)` does the same plus notifies the state engine. This resolves the startup ordering: spool is drained to DB first, then StateEngine.initialize() replays those events from DB via `eventsSince(cursor)`. No double-apply: StateEngine reads from DB using its cursor, which covers all events regardless of how they were inserted.
- **Atomic rename**: Before processing, rename `hook-events.jsonl` to `hook-events.processing.jsonl`. This ensures new spool writes go to a fresh file. If rename fails (no file) → nothing to drain.
- **Line-by-line processing**: Read the renamed file, split by newlines, parse each line as JSON. For each:
  1. Extract `ingest_id`, `hook_event_name`, `data`
  2. Filter: only D5 allowed events (skip unknown)
  3. `sanitizer.sanitizeHookPayload(hookEventName, data)` → canonical fields
  4. Build CanonicalEvent (same as IngestHandler)
  5. `store.insertEvent(event)` — INSERT OR IGNORE deduplicates against POST-delivered events
  6. If `drainLive`: `stateEngine.onEvent(event)` — update in-memory state
- **Cleanup**: After processing, delete the `.processing` file. If errors during processing, keep the file and log errors (don't lose data).
- **Startup drain**: `drainToDb()` called once in `index.js` after store initialization but BEFORE StateEngine construction. Events land in DB. StateEngine.initialize() then replays them from DB as part of snapshot+replay (AC-1). This avoids the circular dependency: SpoolDrainer does not need StateEngine at startup.
- **Periodic drain**: `startPeriodicDrain(stateEngine, 30_000)` — uses `drainLive()` which notifies the already-initialized state engine.
- **source_health update**: After successful drain (either mode), update `hook_handler` source_health to `healthy` if it was `degraded`. Also update `hook_events` runtime_progress status.
- **Failure behavior**: Individual line parse failures are logged and skipped (don't abort the entire drain). Final status includes error count.

---

### 2.6 Collectors — `src/lib/collectors/`

**Owned writes**: `metric_points`, `source_health` (via store)

#### 2.6.1 PM2 Collector — `pm2-collector.js`

```javascript
export class PM2Collector {
  constructor(store, config)
  async collect()  // exec `pm2 jlist`, parse JSON, write to metric_points + source_health
  start(intervalMs)  // default 15s
  stop()

  getLatestPM2Data()  // returns cached latest jlist result (for state engine)
}
```

- **Collection**: `child_process.execFile('pm2', ['jlist'])`, parse stdout as JSON array.
- **Metrics written**: Per process: `pm2_status`, `pm2_memory`, `pm2_cpu`, `pm2_restarts`, `pm2_uptime`.
- **source_health**: Updates `pm2_reader` (signal_type: `collector_liveness`).
- **Cache**: Latest result stored in memory for state engine access (avoids re-exec on state derivation).
- **Failure behavior**: exec failure → update source_health to `degraded`, cache remains stale.
- **Mapped tests**: Used by T-STATE-03+ (IDLE and other states depend on PM2 data). PM2 does NOT participate in OFFLINE detection — that is AM heartbeat only (D7).

#### 2.6.2 System Collector — `system-collector.js`

```javascript
export class SystemCollector {
  constructor(store, config)
  async collect()  // os.loadavg(), os.freemem(), fs.statfsSync() → metric_points
  start(intervalMs)  // default 30s
  stop()

  getLatestSystemData()  // returns cached latest (for state engine)
}
```

- **Metrics**: `cpu_pct`, `mem_used_bytes`, `mem_total_bytes`, `disk_used_pct`, `disk_free_bytes`.
- **CPU calculation**: `Math.min(100, os.loadavg()[0] / os.cpus().length * 100)` — load-based utilization estimate normalized to 0-100 per core count. Note: this is derived from 1-minute load average, not instantaneous CPU sampling; sufficient for dashboard gauge display.
- **Disk**: Node built-in `fs.statfsSync(config.zylosDir)` — `stats.blocks * stats.bsize` for total, `stats.bavail * stats.bsize` for available. No child process or text parsing needed.
- **source_health**: Updates `system_sampler` (signal_type: `collector_liveness`).
- **Failure behavior**: Individual metric failure doesn't block others.

#### 2.6.3 OTel Collector — `otel-collector.js`

```javascript
export class OTelCollector {
  constructor(store, config)
  async collect()  // read OTel data → runtime_events + metric_points
  start(intervalMs)  // default 10s
  stop()
}
```

- **Data source**: Reads from local OTel collector endpoint or exported files (implementation depends on OTel exporter config — file vs OTLP endpoint).
- **Phase 2a scope**: Minimal — read OTel logs/metrics if available. Not critical path for Phase 2a MVP (hook data is primary). OTel collector can be a stub that updates source_health.
- **source_health**: Updates `otel_reader` (signal_type: `collector_liveness`) and `otel_events` (signal_type: `runtime_progress`).

---

### 2.7 State Engine — `src/lib/state-engine.js`

**Owned writes**: `state_snapshots` (via store), in-memory state

**Mapped tests**: T-STATE-01~20, T-AC1-01~07

#### Interface

```javascript
// src/lib/state-engine.js
export class StateEngine {
  constructor(store, collectors, config)

  // --- Event-driven updates ---
  onEvent(event)           // called by IngestHandler and SpoolDrainer on each new event
  onPM2Update(pm2Data)     // called by PM2Collector after each poll
  onSystemUpdate(sysData)  // called by SystemCollector after each poll

  // --- State derivation ---
  getState()               // returns current derived state (§4.4 format)
  getRunningTools()        // returns array of currently running tools
  getSourceHealth()        // returns two-domain source health (AC-4)

  // --- Lifecycle ---
  async initialize()       // restore from snapshot + replay (AC-1)
  startSnapshotTimer()     // periodic snapshot (30s or on state change)
  stopSnapshotTimer()

  // --- Internal (exposed for testing) ---
  _deriveState()           // pure function: signals → state (§4.3 pseudocode)
}
```

#### In-Memory State

```javascript
this._state = {
  // Tool tracking (from PreToolUse/PostToolUse)
  runningTools: new Map(),  // tool_use_id → { tool_name, started_at, session_id }

  // Turn tracking (from UserPromptSubmit/Stop)
  openTurn: null,  // { started_at, session_id } or null

  // Permission tracking (from PermissionRequest / clearing events)
  pendingPermission: null,  // { tool_name, requested_at, session_id } or null

  // Stuck detection
  possiblyStuckSince: null,  // Date or null
  lastProgressAt: null,      // Date of last runtime progress event

  // PM2 cache (from collector)
  pm2: null,  // latest PM2 data

  // AM heartbeat (D7: application-level liveness only, not semantic state)
  amHeartbeat: null,  // { status: 'online'|'offline', lastCheck } or null

  // Last snapshot cursor
  lastSnapshotCursor: 0,
};
```

#### Event Processing — `onEvent(event)`

```javascript
onEvent(event) {
  const now = new Date();

  switch (event.event_type) {
    case 'pre_tool_use':
      this._state.runningTools.set(
        event.metadata.tool_use_id,
        { tool_name: event.metadata.tool_name, started_at: event.timestamp, session_id: event.session_id }
      );
      this._state.lastProgressAt = now;
      this._clearPossiblyStuck();
      break;

    case 'post_tool_use':
      this._state.runningTools.delete(event.metadata.tool_use_id);
      this._state.lastProgressAt = now;
      this._clearPossiblyStuck();
      // If this was the tool matching pending permission, clear it
      if (this._state.pendingPermission
          && this._state.pendingPermission.tool_name === event.metadata.tool_name) {
        this._state.pendingPermission = null;
      }
      break;

    case 'user_prompt_submit':
      this._state.openTurn = { started_at: event.timestamp, session_id: event.session_id };
      this._state.lastProgressAt = now;
      this._clearPossiblyStuck();
      break;

    case 'stop':
      this._state.openTurn = null;
      this._state.lastProgressAt = now;
      this._clearPossiblyStuck();
      // Stop clears pending permission (turn ended)
      this._state.pendingPermission = null;
      // Stop does NOT clear running tools (Stop ≠ tool end)
      break;

    case 'permission_request':
      this._state.pendingPermission = {
        tool_name: event.metadata.tool_name,
        requested_at: event.timestamp,
        session_id: event.session_id
      };
      this._state.lastProgressAt = now;
      break;
  }

  // SSE: notify subscribers of state change
  this._broadcastStateChange();

  // Snapshot: if state materially changed, save snapshot
  this._maybeSnapshot();
}
```

#### State Derivation — `_deriveState()`

Implements §4.3 pseudocode from the spec. Key signals assembled from in-memory state + collector caches:

```javascript
_deriveState() {
  const signals = {
    amAvailable: this._state.amHeartbeat !== null,
    amStatus: this._state.amHeartbeat?.status ?? null,
    pm2Status: this._state.pm2?.runtimeProcess?.pm2_env?.status ?? null,
    pm2SampleAge: this._state.pm2 ? (Date.now() - this._state.pm2.collectedAt) / 1000 : Infinity,
    pm2Cpu: this._state.pm2?.runtimeProcess?.monit?.cpu ?? null,
    runningTool: this._oldestRunningTool(),
    openTurn: this._state.openTurn ? { age: (Date.now() - new Date(this._state.openTurn.started_at)) / 1000 } : null,
    pendingPermission: this._state.pendingPermission ? {
      tool_name: this._state.pendingPermission.tool_name,
      age: (Date.now() - new Date(this._state.pendingPermission.requested_at)) / 1000
    } : null,
    lastProgressAge: this._state.lastProgressAt ? (Date.now() - this._state.lastProgressAt) / 1000 : Infinity,
    lastProgressType: null, // filled from latest event
    collectorLivenessFresh: this._isCollectorLivenessFresh(),
    collectorLivenessAvailable: this._isCollectorLivenessAvailable(),
    activeOtelSpan: false, // Phase 2a: not yet implemented
    possiblyStuckSince: this._state.possiblyStuckSince,
    runtime: this._config.runtime || 'claude'
  };

  return deriveAgentState(signals);
}
```

`deriveAgentState()` is the pure function from §4.3 (spec pseudocode), extracted as a testable unit.

#### Two-Signal Distinction (Runtime Progress vs Collector Liveness)

```javascript
_isCollectorLivenessFresh() {
  const health = this.store.getCollectorLiveness();
  // All collector_liveness sources must be fresh (< 30s)
  const sources = ['pm2_reader', 'system_sampler', 'hook_handler', 'am_heartbeat'];
  return sources.every(name => {
    const h = health.find(s => s.source_name === name);
    if (!h) return false;  // source never reported → not fresh
    return h.status !== 'stale' && h.status !== 'error'
      && (Date.now() - new Date(h.last_success)) < 30_000;
  });
}
```

**AM unavailable and STUCK**: `am_heartbeat` is included in collector liveness because it provides session-level liveness evidence — if AM heartbeat is not fresh, we cannot distinguish "agent stuck" from "agent session exited." Therefore: AM unavailable (process not running, no source_health entry) → `_isCollectorLivenessFresh()` returns false → STUCK cannot be confirmed → state degrades to UNKNOWN. This is intentional: STUCK requires all observation channels healthy to be a reliable judgment. If AM is permanently absent (e.g. AM not installed), the system stays at POSSIBLY_STUCK (MEDIUM) without escalating to STUCK — which is the conservative correct behavior. Note: PM2 process status is orthogonal — it monitors service modules (AM, comm-bridge, etc.), not the agent runtime's tmux session. PM2 belongs in system health/collector_liveness, not in OFFLINE or STUCK resolution logic.

```javascript
// For reference: _isCollectorLivenessAvailable() checks if sources have ever reported
_isCollectorLivenessAvailable() {
  const health = this.store.getCollectorLiveness();
  const sources = ['pm2_reader', 'system_sampler', 'hook_handler', 'am_heartbeat'];
  return sources.some(name => health.find(s => s.source_name === name));
}
```

#### OFFLINE Detection — AM Heartbeat Only (D7)

OFFLINE detection uses AM `agent-status.json` as the **sole source**. PM2 does not participate in OFFLINE determination.

**Why PM2 cannot determine OFFLINE**: PM2 manages service modules (activity-monitor, comm-bridge, etc.) — it does **not** manage the agent runtime's tmux session. The Claude/Codex session runs inside a tmux session whose lifecycle is independent of PM2. PM2 "online" or "stopped" reflects service module status, not agent runtime status — PM2 has zero visibility into whether the agent session is alive, exited, or unresponsive. AM performs actual **heartbeat probes** against the agent session, providing application-level liveness evidence that PM2 structurally cannot.

**P1 boundary (Zylos01 × Jinglever × Howard consensus)**:
1. `agent-status.json` is used **only** as an agent session heartbeat / application liveness signal, for OFFLINE/UNRESPONSIVE detection.
2. AM's semantic state judgments (busy/idle/stuck from `proc-state.json` etc.) are **NOT** used. Dashboard derives BUSY/IDLE/STUCK/WAITING_HUMAN from its own hook/OTel/PM2/system/C4 evidence.
3. In source_health, this source is named `am_heartbeat` (signal_type: `collector_liveness`) — not "AM state", to prevent confusion with AM's legacy semantic state.
4. `am_heartbeat` is the **sole OFFLINE resolver source**. No fallback. AM heartbeat fresh + offline → OFFLINE (HIGH). AM heartbeat fresh + online → not offline. Owner text: "session 无响应" rather than "进程离线".
5. AM unavailable (process not running, file missing/stale) → UNKNOWN. Cannot determine session liveness without a heartbeat probe. PM2 process status is displayed separately in the system health panel but does **not** substitute for OFFLINE detection.

```javascript
_readAMHeartbeat() {
  // Read ~/zylos/activity-monitor/data/agent-status.json
  // Only extract: status (online/offline), last heartbeat timestamp
  // Do NOT read busy/idle/stuck or any semantic state fields
  try {
    const raw = fs.readFileSync(amStatusPath, 'utf8');
    const data = JSON.parse(raw);
    this._state.amHeartbeat = {
      status: data.status,  // 'online' | 'offline'
      lastCheck: data.lastCheck || data.updated_at
    };
  } catch {
    this._state.amHeartbeat = null;  // AM not available → UNKNOWN (no fallback)
  }
}
```

Called periodically (every 15s, aligned with PM2 collector). source_health updated as `am_heartbeat` (collector_liveness).

**deriveAgentState signals**:
```javascript
const signals = {
  amAvailable: this._state.amHeartbeat !== null,
  amStatus: this._state.amHeartbeat?.status ?? null,
  // ... rest of signals
};
// OFFLINE resolved from AM heartbeat only; AM unavailable → UNKNOWN
```

#### Restart Recovery (AC-1)

```javascript
async initialize() {
  // 1. Load latest snapshot
  const snapshot = this.store.latestSnapshot(this._config.runtime, this._currentSessionId());
  if (snapshot) {
    this._state.runningTools = new Map(Object.entries(JSON.parse(snapshot.running_tool || '{}')));
    this._state.openTurn = JSON.parse(snapshot.open_turn || 'null');
    this._state.pendingPermission = JSON.parse(snapshot.pending_permission || 'null');
    this._state.possiblyStuckSince = snapshot.possibly_stuck_since ? new Date(snapshot.possibly_stuck_since) : null;
    this._state.lastSnapshotCursor = snapshot.last_progress_cursor;
  }

  // 2. Replay events from cursor
  const events = this.store.eventsSince(this._state.lastSnapshotCursor);
  for (const event of events) {
    this.onEvent(event);  // replay through normal event processing
  }

  // 3. Validate recovered state
  // If running tool evidence is too old (> 300s), assume hook was lost → clear
  for (const [id, tool] of this._state.runningTools) {
    if ((Date.now() - new Date(tool.started_at)) > 300_000) {
      this._state.runningTools.delete(id);
    }
  }
  // If pending permission > 600s, clear
  if (this._state.pendingPermission) {
    const age = Date.now() - new Date(this._state.pendingPermission.requested_at);
    if (age > 600_000) this._state.pendingPermission = null;
  }
}
```

#### Snapshot Timer

Every 30 seconds, or on state change (IDLE↔BUSY↔STUCK transitions):

```javascript
_maybeSnapshot() {
  const currentState = this._deriveState().state;
  if (currentState !== this._lastSnapshotState || Date.now() - this._lastSnapshotTime > 30_000) {
    this._saveSnapshot();
    this._lastSnapshotState = currentState;
    this._lastSnapshotTime = Date.now();
  }
}

_saveSnapshot() {
  this.store.saveSnapshot({
    runtime: this._config.runtime || 'claude',
    session_id: this._currentSessionId(),
    running_tool: JSON.stringify(Object.fromEntries(this._state.runningTools)),
    open_turn: JSON.stringify(this._state.openTurn),
    pending_permission: JSON.stringify(this._state.pendingPermission),
    possibly_stuck_since: this._state.possiblyStuckSince?.toISOString() || null,
    last_progress_cursor: this._getMaxEventSeq()
  });
}
```

#### State Output Format (API response)

Matches §4.4 + T-STATE-20 (two-domain source structure):

```json
{
  "state": "BUSY",
  "confidence": "HIGH",
  "evidence": ["tool_running:Bash:12s"],
  "missing_evidence": [],
  "reason": "正在执行 Bash 命令 (12s)",
  "suggested_action": null,
  "updated_at": "2026-05-10T14:02:33Z",
  "source": {
    "runtime_progress": {
      "hook_events": { "fresh": true, "age_s": 3, "status": "healthy" },
      "otel_events": { "fresh": true, "age_s": 8, "status": "healthy" }
    },
    "collector_liveness": {
      "pm2_reader": { "fresh": true, "age_s": 5, "status": "healthy" },
      "system_sampler": { "fresh": true, "age_s": 12, "status": "healthy" },
      "hook_handler": { "fresh": true, "age_s": 3, "status": "healthy" },
      "otel_reader": { "fresh": true, "age_s": 8, "status": "healthy" },
      "am_heartbeat": { "fresh": true, "age_s": 6, "status": "healthy" }
    },
    "platform": {
      "statusline": { "fresh": true, "age_s": 15, "status": "healthy" },
      "c4": { "fresh": true, "age_s": 2, "status": "healthy" }
    }
  },
  "running_tools": [
    { "tool_use_id": "toolu_01ABC", "tool_name": "Bash", "started_at": "2026-05-10T14:02:21Z", "duration_s": 12 }
  ]
}
```

#### Failure Behavior

| Scenario | Behavior |
|----------|----------|
| Store read failure during initialize | Log error, start with empty state (UNKNOWN until first event) |
| Snapshot write failure | Log error, continue (state engine unaffected) |
| Event replay during initialize produces inconsistent state | Validation step clears stale entries, logs warning |
| Collector not providing data | source_health marked stale, state engine falls back to UNKNOWN per spec |

---

### 2.8 Metric Resolver — `src/lib/metric-resolver.js`

**Owned writes**: None (reads from store)

**Mapped tests**: T-AC2-01~06

#### Interface

```javascript
// src/lib/metric-resolver.js
export class MetricResolver {
  constructor(store, collectors, config)

  resolve(metricName)
  // Returns: { value, selected_source, freshness, confidence, alternatives, fallback_reason }
}
```

#### Implementation Details

Per-metric chain definitions (from AC-2):

```javascript
const METRIC_CHAINS = {
  context_pct: [
    { source: 'statusline', confidence: 'actual' },
    { source: 'rollout', confidence: 'actual' },
    { source: 'derived_token_estimate', confidence: 'estimated' }
  ],
  rate_limit: [
    { source: 'statusline', confidence: 'actual' },
    { source: 'rollout', confidence: 'actual' }
  ],
  effort_level: [
    { source: 'statusline', confidence: 'actual' }
  ],
  session_cost: [
    { source: 'otel_cost_sum', confidence: 'actual' },
    { source: 'statusline', confidence: 'actual' },
    { source: 'token_price_estimated', confidence: 'estimated' }
  ],
  daily_cost: [
    { source: 'otel_cost_sum', confidence: 'actual' },
    { source: 'statusline_delta', confidence: 'inferred' },
    { source: 'token_price_estimated', confidence: 'estimated' }
  ],
  cache_hit_rate: [
    { source: 'otel_token_usage', confidence: 'actual' },
    { source: 'statusline_current_usage', confidence: 'actual' }
  ],
  tool_duration: [
    { source: 'otel_span', confidence: 'actual' },
    { source: 'hook_postToolUse', confidence: 'actual' }
  ]
};
```

- **Resolution**: Walk the chain in order. Query store for latest metric_point with matching source. First available and fresh (< configurable staleness threshold) wins.
- **Hook explicitly excluded from cost metrics**: `session_cost` and `daily_cost` chains have NO hook source (per D5 — hooks don't provide cost data).
- **Output includes alternatives**: All sources in the chain that have data, even if not selected. Allows UI to show "(OTel, also available: StatusLine)".
- **Fallback_reason**: If selected source is not the preferred one, explain why: "OTel data stale (>120s), using StatusLine".

---

### 2.9 REST API Integration — `src/index.js` changes

**Mapped tests**: T-API-STATE-01~06, T-API-HEALTH-01

#### New Routes

| Route | Handler | Source |
|-------|---------|--------|
| `POST /api/ingest` | IngestHandler | §2.3 |
| `GET /api/state` | StateEngine.getState() | §2.7 |
| `GET /api/timeline` | store.queryEvents() | §2.1 |
| `GET /api/health` | store.getSourceHealth() + two-domain formatting | §2.7 |
| `GET /api/metrics/:name` | MetricResolver.resolve() | §2.8 |

#### Baseline Routes (from cleanup skeleton)

`/api/health` — retained from PR #24 cleanup. Phase 2a adds new routes on top of the skeleton server (auth + static serving + health).

#### Base-Path Isolation for `/api/ingest`

In the request handler, BEFORE base-path stripping:

```javascript
// /api/ingest must NOT be accessible under base-path
if (rawPathname.startsWith(basePath + '/api/ingest')) {
  sendJson(res, 404, { error: 'not found' });
  return;
}
// Ingest is only accessible at raw /api/ingest (no prefix)
if (rawPathname === '/api/ingest' && req.method === 'POST') {
  ingestHandler.handle(req, res);
  return;
}
```

#### SSE Integration

Existing `SseHub` extended with new event types:

```javascript
// On state change
sse.broadcast('state_change', stateEngine.getState());

// On new event
sse.broadcast('new_event', { event_type, summary, timestamp });

// On metric update
sse.broadcast('metric_update', { metric_name, value, source });
```

State engine calls `sse.broadcast()` after each state derivation. Collectors call it after writing new metrics.

---

### 2.10 Frontend Overview ①②③ — `public/`

**Mapped tests**: T-UI-01~07

Phase 2a delivers Overview blocks ①②③ only (Live Runtime State, Capacity & Cost, Health & System). Blocks ④⑤⑥ are Phase 2b.

#### 2.10.1 Visual Design System — Light Mode (ref: hxa-connect-web)

基于 hxa-connect-web 最新 main（PR #59, commit 13994b5）的 light mode CSS 变量。

**Color Palette (Light Mode) — 源自 hxa-connect-web `globals.css`**

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#f7faf9` | Page background |
| `--bg-secondary` | `rgba(255, 255, 255, 0.76)` | Secondary surface (frosted) |
| `--bg-card` | `rgba(255, 255, 255, 0.88)` | Card background |
| `--bg-elevated` | `#ffffff` | Elevated surfaces |
| `--bg-code` | `rgba(241, 245, 249, 0.9)` | Code block background |
| `--text` | `#101827` | Primary text |
| `--text-dim` | `#526170` | Secondary text |
| `--text-muted` | `#7a8794` | Tertiary text (non-critical, ≥16px only) |
| `--accent` | `#0d9488` | Primary accent (teal) |
| `--accent-dim` | `#ccfbf1` | Accent background tint |
| `--accent-hover` | `#0f766e` | Accent hover |
| `--purple` | `#6366f1` | Secondary accent (indigo) |
| `--green` | `#059669` | Success accent |
| `--border` | `rgba(15, 118, 110, 0.16)` | Borders (teal-tinted) |
| `--border-focus` | `rgba(14, 165, 163, 0.45)` | Focus ring |
| `--nav-bg` | `rgba(255, 255, 255, 0.82)` | Nav background (blur) |
| `--shadow-card` | `0 18px 42px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.9)` | Card shadow |
| `--shadow-card-hover` | `0 24px 52px rgba(15,23,42,0.12), 0 0 24px rgba(13,148,136,0.08)` | Card hover |

**State Colors (per D7, WCAG non-text contrast ≥ 3:1 on `--bg`)**

State dots are graphical indicators — must meet WCAG 1.4.11 non-text contrast 3:1 against page background `#f7faf9`. Colors below are for the state dot/icon; text labels use `--text` or `--text-dim`.

| State | Dot Color | Ratio vs `#f7faf9` | CSS Variable |
|-------|-----------|-------------------|-------------|
| OFFLINE | `#64748b` (slate-500) | 4.4:1 | `--state-offline` |
| IDLE | `#16a34a` (green-600) | 3.5:1 | `--state-idle` |
| BUSY | `#a16207` (yellow-700) | 4.7:1 | `--state-busy` |
| WAITING_HUMAN | `#2563eb` (blue-600, flashing) | 4.6:1 | `--state-waiting` |
| POSSIBLY_STUCK | `#ea580c` (orange-600) | 3.4:1 | `--state-possibly-stuck` |
| STUCK | `#dc2626` (red-600) | 4.0:1 | `--state-stuck` |
| UNKNOWN | `#6b7280` (gray-500) | 4.6:1 | `--state-unknown` |

**Typography**

| Element | Font | Size | Weight |
|---------|------|------|--------|
| Body | Inter, system-ui, sans-serif | 14px | 400 |
| H1 (page title) | Inter | 20px | 600 |
| H2 (block title) | Inter | 16px | 600 |
| Label | Inter | 12px | 500 |
| Metric value | Inter | 24px | 700 |
| Metric unit | Inter | 12px | 400 |
| Monospace | JetBrains Mono, monospace | 13px | 400 |

Labels (12px) use `--text-dim` (#526170, 5.1:1 vs `--bg`) to meet WCAG AA 4.5:1 for small text. `--text-muted` (#7a8794, 3.5:1) is reserved for non-critical text at ≥16px where AA large-text 3:1 applies.

Font import via `<link>` from Google Fonts (Inter 400/500/600/700, JetBrains Mono 400).

**Spacing & Layout**

| Token | Value |
|-------|-------|
| `--radius` | `12px` (cards, panels) |
| `--radius-sm` | `8px` (buttons, badges) |
| `--radius-xs` | `4px` (inputs, inline elements) |
| `--space-xs` | `4px` |
| `--space-sm` | `8px` |
| `--space-md` | `16px` |
| `--space-lg` | `24px` |
| `--space-xl` | `32px` |

**Card Style (glass-card pattern from hxa-connect-web)**

```css
.card {
  background: var(--bg-card);
  backdrop-filter: blur(16px);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  padding: var(--space-lg);
}
.card:hover {
  box-shadow: var(--shadow-card-hover);
}
```

Light mode uses semi-transparent card backgrounds (`rgba(255,255,255,0.88)`) with `backdrop-filter: blur(16px)` for frosted glass effect, matching hxa-connect-web's glass-card pattern.

#### 2.10.2 Responsive Layout (Mobile-First)

**Breakpoints**

| Name | Width | Layout |
|------|-------|--------|
| Mobile | < 640px | Single column, stacked blocks |
| Tablet | 640–1023px | 2-column grid |
| Desktop | ≥ 1024px | 3-column grid for ①②③ |

**Grid**

```css
.overview-grid {
  display: grid;
  gap: var(--space-md);
  grid-template-columns: 1fr;
}
@media (min-width: 640px) {
  .overview-grid { grid-template-columns: 1fr 1fr; }
}
@media (min-width: 1024px) {
  .overview-grid { grid-template-columns: 1fr 1fr 1fr; }
}
```

**Mobile Adaptations**

- Tab bar: horizontal scroll if tabs overflow, sticky at top
- Status indicator: full-width banner at top (always visible without scrolling)
- Tool list: collapsed by default, tap to expand
- Metric values: stack label above value (not side-by-side)
- System gauges: `grid-template-columns: repeat(auto-fit, minmax(140px, 1fr))` — single column on narrow phones, 2 columns when space allows
- Touch targets: minimum 44px height for all interactive elements
- Viewport meta: `<meta name="viewport" content="width=device-width, initial-scale=1">`

#### 2.10.3 Internationalization (i18n) — EN + ZH

**Architecture**: Lightweight client-side i18n. No framework dependency.

```
public/
├── i18n/
│   ├── en.json
│   └── zh.json
├── js/
│   └── i18n.js       # loader + t() function
```

**Loader (`i18n.js`)**

```javascript
const translations = {};
let currentLocale = 'en';

const SUPPORTED = ['en', 'zh'];

function resolveLocale(explicit) {
  if (explicit && SUPPORTED.includes(explicit)) return explicit;
  const stored = localStorage.getItem('zylos-dashboard-locale');
  if (stored && SUPPORTED.includes(stored)) return stored;
  return navigator.language.startsWith('zh') ? 'zh' : 'en';
}

export async function initI18n(locale) {
  currentLocale = resolveLocale(locale);
  localStorage.setItem('zylos-dashboard-locale', currentLocale);
  const resp = await fetch(`${BASE_PATH}/i18n/${currentLocale}.json`);
  Object.assign(translations, await resp.json());
  document.documentElement.lang = currentLocale;
}

export function t(key, params = {}) {
  let text = translations[key] || key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(`{${k}}`, v);
  }
  return text;
}

export function setLocale(locale) {
  initI18n(locale).then(() => renderAll());
}
```

**Translation File Structure** (`en.json` / `zh.json`)

```json
{
  "app.title": "Zylos Dashboard",
  "tab.overview": "Overview",
  "tab.trends": "Trends",
  "block.runtime": "Runtime State",
  "block.capacity": "Capacity & Cost",
  "block.health": "Health & System",
  "state.offline": "Offline",
  "state.idle": "Idle",
  "state.busy": "Executing {tool}",
  "state.waiting": "Waiting for user input",
  "state.possibly_stuck": "Possibly stuck — {reason}",
  "state.stuck": "Stuck — {reason}",
  "state.unknown": "Status uncertain — {reason}",
  "label.context": "Context",
  "label.rate_limit_5h": "5h Rate Limit",
  "label.rate_limit_7d": "7d Rate Limit",
  "label.cost": "Cost",
  "label.cache_hit": "Cache Hit Rate",
  "label.cpu": "CPU",
  "label.memory": "Memory",
  "label.disk": "Disk",
  "label.pm2": "PM2 Services",
  "label.running": "{count}/{total} running",
  "confidence.actual": "actual",
  "confidence.estimated": "estimated",
  "confidence.unavailable": "unavailable",
  "lang.switch": "中文"
}
```

**Language Switching**: Small button in header (e.g. "EN | 中文"). Locale resolution order: explicit arg → `localStorage('zylos-dashboard-locale')` → `navigator.language` → `'en'`. `setLocale()` validates against `SUPPORTED` list, writes to localStorage, reloads translations, and re-renders all `[data-i18n]` elements.

**HTML Integration**: All user-visible text uses `data-i18n="key"` attributes. After `initI18n()`, a `renderAll()` pass sets `textContent` for all `[data-i18n]` elements. Dynamic text (state descriptions, metric values) uses `t()` directly in JS.

#### 2.10.4 Theme Extension (Multi-Skin Support)

**Goal**: Allow switching between visual themes at runtime. Phase 2a ships with one theme (light); the architecture supports adding more without component style/layout changes.

**Mechanism**: Pure CSS custom property override via `data-theme` attribute on `<html>`.

```
public/
├── themes/
│   ├── light.css      # default — tokens from §2.10.1
│   └── dark.css       # future — overrides same tokens
```

**Theme File Structure** (each theme overrides `:root` tokens):

```css
/* themes/light.css */
:root[data-theme="light"] {
  --bg: #f7faf9;
  --text: #101827;
  --accent: #0d9488;
  /* ... all tokens from §2.10.1 */
}

/* themes/dark.css — example future skin */
:root[data-theme="dark"] {
  --bg: #0f1419;
  --text: #e2e8f0;
  --accent: #2dd4bf;
  /* ... */
}
```

**Loading Strategy**: All theme CSS files are preloaded via `<link>` in `index.html`. Switching only changes the `data-theme` attribute — no dynamic stylesheet injection needed. This keeps the mechanism simple and avoids FOUC (flash of unstyled content).

```html
<!-- index.html -->
<link rel="stylesheet" href="css/style.css">       <!-- layout, components, base -->
<link rel="stylesheet" href="themes/light.css">    <!-- token overrides for light -->
<!-- future: <link rel="stylesheet" href="themes/dark.css"> -->
```

`style.css` contains component/layout/base styles (no color values). Theme files contain only `:root[data-theme=X]` token overrides.

**Switching Logic**:

```javascript
const THEME_KEY = 'zylos-theme';
const DEFAULT_THEME = 'light';
const THEMES = ['light']; // extend when adding skins

function resolveTheme(explicit) {
  if (explicit && THEMES.includes(explicit)) return explicit;
  const stored = localStorage.getItem(THEME_KEY);
  if (stored && THEMES.includes(stored)) return stored;
  return DEFAULT_THEME;
}

function initTheme(theme) {
  const resolved = resolveTheme(theme);
  applyTheme(resolved);
}

function applyTheme(theme) {
  if (!THEMES.includes(theme)) {
    theme = DEFAULT_THEME;
    localStorage.setItem(THEME_KEY, theme);
  }
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}
```

Adding a new theme:
1. Create `themes/<name>.css` with `:root[data-theme="<name>"] { ... }` token overrides
2. Add `<link rel="stylesheet" href="themes/<name>.css">` to `index.html`
3. Add `'<name>'` to the `THEMES` array

**Conventions**:
- All color/visual tokens MUST be defined via CSS variables — never hardcode colors in component styles
- Theme files only contain variable definitions (no selectors, no layout)
- `style.css` contains layout/component/base styles — references variables but never defines color values
- Theme switch is instant (no page reload) because all components reference variables
- State colors (§2.10.1) are also themed — each theme file defines its own `--state-*` values
- Invalid/unknown theme values in localStorage are corrected to `DEFAULT_THEME` on load

**Phase 2a scope**: Ship with `themes/light.css` only. Theme switcher UI deferred to a later phase, but the infrastructure (data-theme, localStorage, THEMES whitelist, `resolveTheme()`) is built in from day one so no refactoring is needed later.

#### 2.10.5 Block Specifications

#### ① Live Runtime State

- **Status indicator**: Colored circle (CSS class per state: `state-offline`, `state-idle`, `state-busy`, `state-waiting`, `state-possibly-stuck`, `state-stuck`, `state-unknown`). Color scheme per D7 / §2.10.1.
- **Ticking timer**: For BUSY state with running tool:
  ```javascript
  let timerInterval;
  function startToolTimer(startedAt) {
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - new Date(startedAt)) / 1000);
      toolDurationEl.textContent = formatDuration(elapsed);
    }, 1000);
  }
  ```
  Stopped on PostToolUse arrival via SSE `state_change` event.
- **Concurrent tools**: Show latest tool prominently. If `running_tools.length > 1`, show "+N tools running" badge. Expandable list.
- **Natural language**: Map state to owner text (AC-3). All text through `t()`:
  - `confirmed_normal` → `t('state.idle')` / `t('state.busy', { tool })`
  - `in_progress_uncertain` → `t('state.waiting')`
  - `needs_attention` → `t('state.possibly_stuck', { reason })` / `t('state.stuck', { reason })`
  - `unknown_degraded` → `t('state.unknown', { reason })`
- **WAITING_HUMAN**: Blue flashing animation via CSS `@keyframes` on the status circle.

#### ② Capacity & Cost

- **Context %**: Progress bar, value from MetricResolver `context_pct`.
- **Rate limits**: Two bars (5h, 7d), values from MetricResolver `rate_limit`.
- **Cost**: Text display, annotated with confidence (`actual` / `estimated` / `unavailable`).
- **Cache hit rate**: Percentage text from MetricResolver `cache_hit_rate`.
- **Data refresh**: Via SSE `metric_update` events. No polling.

#### ③ Health & System

- **PM2 services**: List from `/api/system`, showing `t('label.running', { count, total })`.
- **CPU/Mem/Disk**: Gauges or text from `/api/system`.
- **C4 / OTel status**: From `/api/health`, showing age since last activity.
- **Data refresh**: Via SSE or periodic fetch (30s).

#### Multi-Tab Structure (D8)

```html
<nav class="dashboard-tabs">
  <button class="tab active" data-tab="overview" data-i18n="tab.overview">Overview</button>
  <button class="tab" data-tab="trends" data-i18n="tab.trends">Trends</button>
  <div class="tab-spacer"></div>
  <button class="lang-switch" onclick="toggleLocale()">中文</button>
</nav>
<div class="tab-content" id="tab-overview"> ... ①②③ ... </div>
<div class="tab-content hidden" id="tab-trends"> ... charts (Phase 2c) ... </div>
```

Tab switching via vanilla JS click handler. No router needed.

---

### 2.11 Hook Installer — `src/lib/hook-installer.js`

**Mapped tests**: None explicit (install prerequisite)

#### Interface

```javascript
export class HookInstaller {
  installClaudeHooks()   // read/merge ~/.claude/settings.json hooks
  installCodexHooks()    // read/merge ~/.codex/hooks.json
  uninstallClaudeHooks() // remove dashboard hooks, preserve user hooks
  uninstallCodexHooks()  // remove dashboard hooks, preserve user hooks
  detectRuntime()        // 'claude' | 'codex' | null
}
```

#### Implementation Details

- **Claude**: Read `~/.claude/settings.json`. Merge into `hooks` object — for each of the 5 event names, append the dashboard command if not already present. Preserve existing user hooks.
- **Codex**: Read `~/.codex/hooks.json` (array format). Append entries for each of the 5 events if not already present. Preserve existing entries.
- **Uninstall**: Remove only entries whose command path matches the dashboard script pattern (`components/dashboard/lib/hook-ingest.cjs`). Never touch core skill hooks, other component hooks, or user-created hooks.
- **Safety boundary**: The HookInstaller operates only on its own entries, identified by script path. It reads the full hooks file for merging, but must not modify or remove any entry that does not match the dashboard's own script path. This ensures coexistence with zylos-core's `sync-settings-hooks.js` (which preserves non-core entries), other components, and user customizations. If the dashboard is later absorbed into zylos-core, its hooks migrate naturally into the template and `sync-settings-hooks.js` management.
- **Detection**: Read `process.env.ZYLOS_RUNTIME` (canonical interface). Default to `'claude'` if unset. No PM2 fallback — PM2 manages service modules, not the agent runtime.
- **Idempotent**: Running install twice produces the same result (no duplicate entries). Running uninstall twice produces the same result (no errors on missing entries).

---

## 3. Startup Sequence

```
1. loadConfig()
2. new Store(dbPath) → migrate() → WAL enabled
3. new Sanitizer()
4. new SpoolDrainer(store, sanitizer) → drainToDb() [DB-only: spool events into runtime_events, no state engine needed]
5. new PM2Collector(store) → collect() [initial PM2 snapshot]
6. new SystemCollector(store) → collect() [initial system metrics]
7. new OTelCollector(store)
8. new StateEngine(store, collectors) → initialize() [snapshot restore + replay from DB — includes spool-drained events from step 4]
9. new MetricResolver(store, collectors)
10. new IngestHandler(store, sanitizer, stateEngine)
11. Create HTTP server, mount routes
12. Start periodic collectors (PM2: 15s, System: 30s, OTel: 10s)
13. Start state snapshot timer (30s)
14. spoolDrainer.startPeriodicDrain(stateEngine, 30_000) [live mode: subsequent drains notify state engine]
15. Start data retention cleanup timer (1h)
16. server.listen(config.port)
```

Order matters: spool `drainToDb()` BEFORE state engine construction (so spool events are in the DB for snapshot+replay — step 4 before step 8). State engine `initialize()` reads from DB and replays all events since last snapshot, including those just drained from spool. No double-apply: the state engine uses its cursor, and spool drain only writes to DB without touching state. After state engine is ready, periodic drain switches to `drainLive()` mode which notifies the state engine directly (step 14). State engine initialize BEFORE accepting HTTP requests (so first `/api/state` has valid data).

---

## 4. Dependency Changes

### 4.1 New npm dependency

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "chart.js": "4.4.9"
  }
}
```

`better-sqlite3` is the only new dependency. It requires native compilation (node-gyp). Build prerequisites: Python 3 + C++ compiler. Both are present on zylos01 (verified).

### 4.2 Frontend dependencies

Frontend remains vanilla JS + Chart.js. No build step, no bundler.

- **Fonts**: Inter + JetBrains Mono via Google Fonts CDN `<link>` (no npm package)
- **i18n**: Custom `i18n.js` (~30 lines), no framework
- **Responsive**: CSS custom properties + `@media` queries, no CSS framework

---

## 5. File System Layout

```
components/dashboard/
├── dashboard.db              # SQLite database (created on first run)
├── spool/
│   └── hook-events.jsonl     # spool file (created on first POST failure)
├── lib/
│   └── hook-ingest.cjs        # standalone hook handler (invoked by runtime)
├── config.json               # existing config
└── ...

src/
├── index.js                  # HTTP server (modified)
├── lib/
│   ├── store.js              # NEW: better-sqlite3 wrapper
│   ├── state-engine.js       # NEW: state derivation + AC-1 recovery
│   ├── sanitizer.js          # NEW: redaction pipeline
│   ├── metric-resolver.js    # NEW: per-metric source chains (AC-2)
│   ├── ingest-handler.js     # NEW: POST /api/ingest handler
│   ├── spool-drainer.js      # NEW: spool processing
│   ├── hook-installer.js     # NEW: Claude + Codex hook management
│   ├── auth.js               # UNCHANGED
│   ├── browser-base.js       # UNCHANGED
│   ├── config.js             # MODIFIED: add store config, ingest token
│   ├── http.js               # UNCHANGED
│   ├── sse.js                # MODIFIED: new event types
│   ├── result.js             # UNCHANGED
│   ├── time.js               # UNCHANGED
│   └── collectors/
│       ├── pm2-collector.js      # NEW
│       ├── system-collector.js   # NEW
│       └── otel-collector.js     # NEW
└── ...

public/
├── index.html                # REWRITTEN: responsive layout, i18n attributes, tabs, ①②③
├── js/
│   ├── app.js                # NEW: SSE state updates, ticking timer, tab switching
│   └── i18n.js               # NEW: i18n loader, t() function, locale switching
├── css/
│   └── style.css             # NEW: layout, components, base styles (no color values)
├── themes/
│   └── light.css             # NEW: token overrides for light theme (§2.10.4)
└── i18n/
    ├── en.json               # NEW: English translations
    └── zh.json               # NEW: Chinese translations
```

---

## 6. Test Strategy

### 6.1 Unit Tests

Each module has a corresponding test file under `test/`:

| Module | Test file | Coverage |
|--------|-----------|----------|
| store.js | test/store.test.js | T-STORE-01~05 |
| sanitizer.js | test/sanitizer.test.js | T-INGEST-05~07 |
| ingest-handler.js | test/ingest-handler.test.js | T-API-INGEST-01~06 |
| state-engine.js | test/state-engine.test.js | T-STATE-01~20, T-AC1-01~07 |
| metric-resolver.js | test/metric-resolver.test.js | T-AC2-01~06 |
| spool-drainer.js | test/spool-drainer.test.js | T-SPOOL-01~05 |

State engine tests use **injectable clock** (dependency injection of `Date.now`) to test time-dependent state transitions without real waits.

STUCK tests (T-STATE-14) follow the observable boundary pattern: inject PreToolUse event → advance clock past P95×2 → verify POSSIBLY_STUCK → advance 600s+ → verify STUCK. No direct internal state mutation.

### 6.2 Integration Tests

`test/integration/` — starts the server, sends real HTTP requests, verifies end-to-end flow:
- Hook-ingest.js → POST /api/ingest → DB write → state change → SSE event
- Spool write → server restart → drain → state recovery

### 6.3 Benchmark Tests (AC-5)

`test/benchmark/hook-latency.test.js`:
- Spawn `hook-ingest.cjs` 100 times with valid payload
- Measure process exit time (p50/p95/p99)
- Dashboard online: verify < 50ms
- Dashboard offline: verify < 40ms (spool path)

---

## 7. Traceability Matrix

| Test ID | Module(s) | Implementation Section |
|---------|-----------|----------------------|
| T-STORE-01~05 | store.js | §2.1 |
| T-INGEST-01~04 | hook-ingest.cjs, ingest-handler.js | §2.4, §2.3 |
| T-INGEST-05~07 | sanitizer.js, ingest-handler.js | §2.2, §2.3 |
| T-INGEST-08~10 | hook-ingest.cjs | §2.4 |
| T-API-INGEST-01~06 | ingest-handler.js | §2.3 |
| T-SPOOL-01~05 | hook-ingest.cjs, spool-drainer.js | §2.4, §2.5 |
| T-STATE-01~20 | state-engine.js, collectors | §2.7, §2.6 |
| T-AC1-01~07 | state-engine.js, store.js | §2.7 (AC-1 recovery) |
| T-AC2-01~06 | metric-resolver.js | §2.8 |
| T-AC3-01~06 | Frontend ① | §2.10 |
| T-AC4-01~05 | state-engine.js | §2.7 (hook health) |
| T-AC5-01~06 | hook-ingest.cjs, spool-drainer.js | §2.4, §2.5 |
| T-API-STATE-01~06 | index.js, state-engine.js | §2.9 |
| T-SSE-01~05 | sse.js, state-engine.js | §2.9 |
| T-UI-01~07 | public/ | §2.10 |
| T-SEC-01~03 | ingest-handler.js, sanitizer.js | §2.3, §2.2 |

---

## 8. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `better-sqlite3` native compilation fails on target machine | Cannot start store module | Pre-verify: `npm install better-sqlite3` on zylos01 before coding. Fallback: prebuilt binaries via `prebuild-install`. |
| Hook-ingest.js adds perceptible latency to agent | Agent response time degrades | AC-5 benchmark enforces < 50ms. 500ms hard deadline prevents worst case. Fallback: disable hooks, run hook-free. |
| OTel data not flowing (env vars missing, collector down) | ② Capacity data incomplete | Graceful degradation: MetricResolver falls back through chain. UI shows "unavailable" for missing metrics. |
| Spool grows unbounded during extended Dashboard outage | Disk space exhaustion | 10MB cap enforced by hook-ingest.cjs. Oldest events lost (acceptable — Dashboard was down anyway). |
| State engine snapshot corruption | Incorrect state after restart | Validation step in `initialize()` clears stale entries. Worst case: start from UNKNOWN until first event. |
