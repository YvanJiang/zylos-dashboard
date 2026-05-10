# Zylos Dashboard Phase 2a — Test & Acceptance Plan

## 1. Scope

Phase 2a 交付物：Store Module + Hook Ingest + `/api/ingest` Endpoint + State Engine + Overview 区块 ①②③。

本文档定义 Phase 2a 编码完成后的验收测试用例。每个测试用例包含前置条件、执行步骤、预期结果。通过全部标记为 **[MUST]** 的用例为 Phase 2a 验收通过的必要条件。标记为 **[SHOULD]** 的用例为推荐但不阻塞验收。

对应验收标准：AC-1（状态引擎重启恢复）、AC-2（指标源解析）、AC-3（Owner UX 置信度映射）、AC-4（Hook 健康检测）、AC-5（Hook 延迟基准 + Spool 恢复）。

---

## 2. Store Module (`src/lib/store.js`)

### T-STORE-01: Schema 初始化 [MUST]

**前置条件**: 无已有 dashboard.db 文件。

**步骤**:
1. 启动 Dashboard 服务
2. 检查 `components/dashboard/dashboard.db` 是否创建

**预期结果**:
- 数据库文件已创建
- 包含 6 张表：`runtime_events`、`metric_points`、`activity_facts`、`source_health`、`state_snapshots`、`schema_migrations`
- `state_snapshots` 表包含 AC-1 所需字段：`runtime`、`session_id`、`running_tool`（JSON）、`open_turn`（JSON）、`pending_permission`（JSON）、`possibly_stuck_since`、`last_progress_cursor`（event_seq 高水位）、`snapshot_at`
- `schema_migrations` 包含初始版本记录（version=1）
- WAL 模式已启用（`PRAGMA journal_mode` 返回 `wal`）
- `runtime_events` 表包含 `ingest_id` 列和 `event_seq`（自增序号，用于 replay cursor）
- `idx_events_ingest_id` 唯一索引存在（partial index，WHERE ingest_id IS NOT NULL）

### T-STORE-02: 幂等初始化 [MUST]

**前置条件**: dashboard.db 已存在且包含数据。

**步骤**:
1. 重启 Dashboard 服务

**预期结果**:
- 数据库文件未被重建
- 已有数据完整保留
- `schema_migrations` 不重复插入相同版本

### T-STORE-03: 数据保留清理 [SHOULD]

**前置条件**: dashboard.db 中有超过 30 天的 runtime_events 和超过 90 天的 metric_points。

**步骤**:
1. 触发数据保留清理（定时任务或手动调用）

**预期结果**:
- runtime_events 中 timestamp 超过 30 天的行被删除
- metric_points 中超过 90 天的原始行被删除，但日聚合数据保留
- activity_facts 中超过 365 天的行被删除
- source_health 不清理

### T-STORE-04: 并发安全 [MUST]

**前置条件**: Dashboard 服务正在运行。

**步骤**:
1. 同时发送 50 个 `/api/ingest` 请求（模拟密集 hook 事件）
2. 查询 runtime_events 表

**预期结果**:
- 50 条事件全部写入成功，无丢失
- 无 `SQLITE_BUSY` 错误
- 每条记录的 `ingest_id` 唯一

### T-STORE-05: 连接持久性 [MUST]

**前置条件**: Dashboard 服务已运行超过 10 分钟。

**步骤**:
1. 发送一个 `/api/ingest` 请求
2. 检查日志无 "database open" 或 "connection re-established" 记录

**预期结果**:
- 使用启动时建立的同一个 better-sqlite3 连接
- 无连接重建开销

---

## 3. Hook Ingest Pipeline

### T-INGEST-01: 正常路径 — PreToolUse [MUST]

**前置条件**: Dashboard 服务正在运行。

**步骤**:
1. 模拟 Claude Code 调用 `hook-ingest.js`，stdin 输入 PreToolUse payload：
   ```json
   {
     "hook_event_name": "PreToolUse",
     "session_id": "test-session-1",
     "tool_name": "Bash",
     "tool_use_id": "toolu_01ABC"
   }
   ```
2. 查询 runtime_events 表
3. 查询 source_health 表

**预期结果**:
- `hook-ingest.js` 进程退出码为 0
- runtime_events 中有一条记录：event_type="pre_tool_use"，category="tool"，source="hook"
- 记录包含 `ingest_id`（非空）
- source_health 中 hook_handler 的 last_success 已更新

### T-INGEST-02: 正常路径 — PostToolUse [MUST]

**前置条件**: T-INGEST-01 已执行（有对应的 PreToolUse 记录）。

**步骤**:
1. 模拟 PostToolUse payload（同 tool_use_id）：
   ```json
   {
     "hook_event_name": "PostToolUse",
     "session_id": "test-session-1",
     "tool_name": "Bash",
     "tool_use_id": "toolu_01ABC",
     "duration_ms": 1523
   }
   ```

**预期结果**:
- runtime_events 中新增一条 event_type="post_tool_use"，duration_ms=1523
- 状态引擎中 tool_use_id="toolu_01ABC" 不再标记为 running

### T-INGEST-03: 正常路径 — UserPromptSubmit [MUST]

**步骤**:
1. 模拟 UserPromptSubmit payload
2. 查询状态引擎

**预期结果**:
- runtime_events 中新增 event_type="user_prompt_submit"，category="turn"
- 状态引擎标记 open turn

### T-INGEST-04: 正常路径 — Stop [MUST]

**前置条件**: T-INGEST-03 已执行（有 open turn）。

**步骤**:
1. 模拟 Stop payload

**预期结果**:
- runtime_events 中新增 event_type="stop"，category="turn"
- 状态引擎清除 open turn

### T-INGEST-05: 正常路径 — PermissionRequest [MUST]

**步骤**:
1. 模拟 PermissionRequest payload：
   ```json
   {
     "hook_event_name": "PermissionRequest",
     "session_id": "test-session-1",
     "tool_name": "Bash",
     "tool_input": { "command": "rm -rf /tmp/test" }
   }
   ```

**预期结果**:
- runtime_events 中新增 event_type="permission_request"，category="permission"
- 状态引擎标记 pending permission
- 记录仅存 `tool_name`，不存 `tool_input` 原文（D5 存储约束）
- summary 为分类描述（如 "Permission requested: Bash"），不含 command 内容

### T-INGEST-06: 数据存储边界 — 负向契约 [MUST]

**目的**: 验证 D5/D9 存储约束：hooks 仅存 tool_name、tool_use_id、duration_ms、sanitized summary。

**步骤**:
1. 发送包含敏感数据的 payload：
   ```json
   {
     "hook_event_name": "PostToolUse",
     "tool_name": "Bash",
     "tool_use_id": "toolu_02DEF",
     "tool_input": { "command": "curl -H 'Authorization: Bearer sk-ant-api03-xxx' https://api.example.com" },
     "tool_response": "HTTP 200 OK\n{\"data\": \"secret\"}"
   }
   ```
2. 查询 runtime_events 表中该记录的所有字段（含 summary、metadata）

**预期结果**:
- `tool_input` 原文不在任何字段中出现（不存 command、file_path 等参数）
- `tool_response` / `tool_output` 不在任何字段中出现
- `sk-ant-api03-xxx`、`Bearer` 等 credential 模式不在任何字段中出现
- summary 为分类描述（如 "Bash tool completed, 1523ms"），不含原始 command 或输出
- 仅保留：tool_name="Bash"、tool_use_id="toolu_02DEF"、duration_ms、source="hook"

### T-INGEST-07: 数据存储边界 — 路径与 prompt [MUST]

**目的**: 验证完整文件路径和 prompt 内容不被持久化。

**步骤**:
1. 发送 PostToolUse（tool_name="Read"，tool_input 含完整路径 `/home/howard/zylos/core/lib/startup.js`）
2. 发送 UserPromptSubmit（payload 含 prompt 原文）
3. 查询 runtime_events 表中这两条记录的所有字段

**预期结果**:
- 无完整路径出现在任何字段中
- summary 可包含最后两段路径（如 `lib/startup.js`）作为分类描述，但不强制要求
- prompt 原文不在任何字段中出现
- UserPromptSubmit 记录仅标记 turn 开始，不存储 prompt 内容

### T-INGEST-08: 未知事件类型 — 静默忽略 [SHOULD]

**步骤**:
1. 发送 `hook_event_name` 为非 D5 最小集事件的 payload（如 "SubagentStart"）
2. 查询 runtime_events 表
3. 检查 source_health 中的诊断计数

**预期结果**:
- `hook-ingest.js` 进程退出码为 0（不崩溃）
- runtime_events 中不新增记录（不持久化非最小集事件的 raw payload）
- source_health 或诊断指标中记录 ignored event count（可选，用于运维排查）

### T-INGEST-09: 非法 JSON 输入 [MUST]

**步骤**:
1. 向 hook-ingest.js 的 stdin 传入非法 JSON（如 "not json"）

**预期结果**:
- 进程退出码为 0
- 不崩溃，不阻塞 runtime
- 错误被记录到 stderr 或 spool（不丢弃诊断信息）

### T-INGEST-10: 空 stdin [MUST]

**步骤**:
1. 向 hook-ingest.js 传入空 stdin（EOF 立即关闭）

**预期结果**:
- 进程退出码为 0
- 不崩溃，不阻塞 runtime

---

## 4. Ingest Endpoint (`/api/ingest`)

### T-API-INGEST-01: 正常写入 [MUST]

**步骤**:
1. `curl -X POST -H "Content-Type: application/json" -d '{"ingest_id":"test-001","hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"s1"}' http://127.0.0.1:3470/api/ingest`

**预期结果**:
- HTTP 200 响应
- runtime_events 中新增记录

### T-API-INGEST-02: Loopback-only 安全检查 [MUST]

**步骤**:
1. 从非 loopback 地址向 `/api/ingest` 发送 POST（或模拟 remoteAddress 非 127.0.0.1/::1）

**预期结果**:
- HTTP 403 Forbidden
- 无数据写入

### T-API-INGEST-03: 不通过 base-path 暴露 [MUST]

**前置条件**: Dashboard 配置了 base-path（如通过 X-Forwarded-Prefix: /dashboard）。

**步骤**:
1. 发送 `POST /dashboard/api/ingest`（base-path 前缀）并附有效 JSON body
2. 发送 `GET /dashboard/api/ingest`（base-path 前缀）
3. 查询 runtime_events 表

**预期结果**:
- POST 返回 404 或 403（ingest 不挂载到 base-path 下）
- GET 返回 404
- 无数据被写入 runtime_events（POST 未被路由到 ingest handler）

### T-API-INGEST-04: 幂等去重 [MUST]

**步骤**:
1. 发送 `ingest_id="dedup-001"` 的 POST 请求
2. 再次发送相同 `ingest_id="dedup-001"` 的 POST 请求

**预期结果**:
- 第一次：HTTP 200，写入 1 条记录
- 第二次：HTTP 200（不报错），runtime_events 中仍只有 1 条 `ingest_id="dedup-001"` 的记录

### T-API-INGEST-05: CORS 拒绝 [MUST]

**步骤**:
1. 发送带 `Origin: http://evil.com` 的 OPTIONS preflight 请求到 `/api/ingest`

**预期结果**:
- 无 `Access-Control-Allow-Origin` 响应头
- 浏览器环境无法跨域请求该端点

### T-API-INGEST-06: 可选 Local Token [SHOULD]

**前置条件**: 配置了 `DASHBOARD_INGEST_TOKEN=secret123`。

**步骤**:
1. 不带 token 发送 POST
2. 带错误 token 发送 POST
3. 带正确 token 发送 POST

**预期结果**:
1. HTTP 403
2. HTTP 403
3. HTTP 200

---

## 5. Spool 容灾

### T-SPOOL-01: Dashboard 离线时 spool 写入 [MUST]

**前置条件**: Dashboard 服务已停止。

**步骤**:
1. 运行 hook-ingest.js，stdin 传入有效 PreToolUse payload
2. 检查 `components/dashboard/spool/hook-events.jsonl` 文件

**预期结果**:
- hook-ingest.js 退出码为 0
- spool 文件新增一行，包含 `ingest_id`、`received_at`、`runtime`、`hook_event_name`、`data`

### T-SPOOL-02: Dashboard 恢复后 spool drain [MUST]

**前置条件**: T-SPOOL-01 已执行（spool 中有事件）。

**步骤**:
1. 启动 Dashboard 服务
2. 等待 spool drain（启动时自动或首次定期检查）
3. 查询 runtime_events 表

**预期结果**:
- spool 文件已被 rename（处理中）后清除（或为空）
- runtime_events 中包含 spool 中的事件
- source_health 中 hook_handler 状态为 `healthy`

### T-SPOOL-03: Spool drain 去重 [MUST]

**前置条件**: 有一条 `ingest_id="dup-001"` 的事件已通过 POST 写入 runtime_events。spool 文件中也有一行 `ingest_id="dup-001"`（模拟 POST 成功但 hook 进程未观察到 200 的竞态）。

**步骤**:
1. 触发 spool drain

**预期结果**:
- runtime_events 中仅有 1 条 `ingest_id="dup-001"` 的记录（INSERT OR IGNORE）
- 无报错

### T-SPOOL-04: Spool 大小上限 [SHOULD]

**步骤**:
1. 持续写入 spool 直到超过配置上限（默认 10MB）
2. 再写入一条

**预期结果**:
- spool 文件大小不超过上限
- 最早的行被丢弃（或新写入被拒绝——具体策略待实现确认）
- hook-ingest.js 退出码仍为 0

### T-SPOOL-05: Spool drain 的原子性 [MUST]

**步骤**:
1. spool 中有 N 条事件
2. 启动 Dashboard 触发 drain
3. drain 过程中 hook-ingest.js 继续写入新事件

**预期结果**:
- drain 先 rename spool 文件再处理，新事件写入新 spool 文件
- 不丢失 drain 期间到达的事件

---

## 6. State Engine

### T-STATE-01: OFFLINE — AM agent-status.json [MUST]

**前置条件**: AM agent-status.json status 为 offline。

**步骤**:
1. 调用 `GET /api/state`

**预期结果**:
- `state: "OFFLINE"`，`confidence: "HIGH"`
- reason 引用 AM agent-status

### T-STATE-02: OFFLINE — PM2 进程不在线 [MUST]

**前置条件**: AM 不可用。PM2 runtime 进程 status 为 stopped/errored。

**步骤**:
1. 调用 `GET /api/state`

**预期结果**:
- `state: "OFFLINE"`，`confidence: "HIGH"`
- reason 引用 PM2 status

### T-STATE-03: IDLE — 正常空闲 [MUST]

**前置条件**: PM2 online，最近事件为 Stop（120s+ 前），无 running tool，无 pending permission。

**步骤**:
1. 注入 Stop 事件（timestamp = now - 150s）
2. 调用 `GET /api/state`

**预期结果**:
- `state: "IDLE"`，`confidence: "HIGH"`

### T-STATE-04: IDLE — Turn 间隙 [MUST]

**前置条件**: PM2 online，最近事件为 Stop（< 120s 前）。

**步骤**:
1. 注入 Stop 事件（timestamp = now - 30s）
2. 调用 `GET /api/state`

**预期结果**:
- `state: "IDLE"`，`confidence: "MEDIUM"`

### T-STATE-05: BUSY — 运行中工具 [MUST]

**前置条件**: PM2 online。

**步骤**:
1. 注入 PreToolUse 事件（tool_name="Bash"，tool_use_id="t1"，timestamp = now - 5s）
2. 调用 `GET /api/state`

**预期结果**:
- `state: "BUSY"`，`confidence: "HIGH"`
- reason 包含 "Bash" 和 running duration

### T-STATE-06: BUSY → IDLE 转换 [MUST]

**前置条件**: T-STATE-05 状态（BUSY with running tool）。

**步骤**:
1. 注入 PostToolUse 事件（同 tool_use_id="t1"）
2. 注入 Stop 事件
3. 等待 > 120s 或调用 `GET /api/state`

**预期结果**:
- 状态从 BUSY 变为 IDLE

### T-STATE-07: BUSY — Open turn 无工具 [MUST]

**前置条件**: PM2 online。

**步骤**:
1. 注入 UserPromptSubmit 事件（timestamp = now - 10s）
2. 调用 `GET /api/state`

**预期结果**:
- `state: "BUSY"`，`confidence: "MEDIUM"`
- reason 包含 "Processing prompt" 或类似描述

### T-STATE-08: WAITING_HUMAN — Claude [MUST]

**步骤**:
1. 注入 PermissionRequest 事件（runtime="claude"，tool_name="Bash"，timestamp = now - 30s）
2. 调用 `GET /api/state`

**预期结果**:
- `state: "WAITING_HUMAN"`，`confidence: "HIGH"`
- reason 包含 "Bash"

### T-STATE-09: WAITING_HUMAN — Codex (MEDIUM confidence) [MUST]

**步骤**:
1. 注入 PermissionRequest 事件（runtime="codex"，tool_name="Bash"，timestamp = now - 30s）
2. 调用 `GET /api/state`

**预期结果**:
- `state: "WAITING_HUMAN"`，`confidence: "MEDIUM"`（Codex 无 tool_use_id 匹配）

### T-STATE-10: WAITING_HUMAN — 超时降级 [MUST]

**步骤**:
1. 注入 PermissionRequest 事件（timestamp = now - 650s，超过 600s）
2. 调用 `GET /api/state`

**预期结果**:
- `state: "UNKNOWN"`
- reason 包含 "permission request stale" 或类似描述

### T-STATE-11: WAITING_HUMAN → BUSY 转换 [MUST]

**前置条件**: WAITING_HUMAN 状态。

**步骤**:
1. 注入 PostToolUse 事件（同 session_id，在 PermissionRequest 之后）
2. 调用 `GET /api/state`

**预期结果**:
- pending permission 已清除
- 状态不再是 WAITING_HUMAN

### T-STATE-12: POSSIBLY_STUCK — 场景 A 工具卡住 [MUST]

**前置条件**: PM2 online，collector liveness fresh。

**步骤**:
1. 注入 PreToolUse（tool_name="Bash"，timestamp = now - 300s）
2. 不注入 PostToolUse
3. 调用 `GET /api/state`

**预期结果**:
- `state: "POSSIBLY_STUCK"`，`confidence: "MEDIUM"`
- reason 包含 "Bash" 和 running duration，指出超过正常时长

### T-STATE-13: POSSIBLY_STUCK — 场景 B 模型卡住 [MUST]

**前置条件**: PM2 online，collector liveness fresh。

**步骤**:
1. 注入 UserPromptSubmit（timestamp = now - 150s）
2. 不注入 PreToolUse 或 Stop
3. 调用 `GET /api/state`

**预期结果**:
- `state: "POSSIBLY_STUCK"`，`confidence: "MEDIUM"`
- reason 包含 "no response events"

### T-STATE-14: STUCK — 确认卡住 [MUST]

**前置条件**: PM2 online，collector liveness 全部 fresh（< 30s），PM2 CPU = 0。

**步骤**:
1. 注入 PreToolUse（tool_name="Bash"，timestamp = T0）——引擎进入 BUSY
2. 使用测试时钟推进（或注入事件时戳），使 T0 距 "当前时间" 超过 Bash P95×2 阈值——引擎应进入 POSSIBLY_STUCK
3. 调用 `GET /api/state`，确认 `state: "POSSIBLY_STUCK"`
4. 继续推进时间，使 POSSIBLY_STUCK 持续超过 600s，期间无任何新 runtime progress event
5. 确保 collector liveness 信号持续 fresh（PM2 Reader + System Sampler 采样 < 30s）
6. 调用 `GET /api/state`

**预期结果**:
- 步骤 3：`state: "POSSIBLY_STUCK"`
- 步骤 6：`state: "STUCK"`，`confidence: "HIGH"`（600s + CPU=0 + collector liveness fresh）
- reason 包含持续时间和原因
- 引擎通过自身事件序列推导出 STUCK，不依赖外部直接设置内部状态

### T-STATE-15: STUCK — Collector liveness 不 fresh 时降级 [MUST]

**前置条件**: 与 T-STATE-14 步骤 1-4 相同（已进入 POSSIBLY_STUCK 超过 300s），但 PM2 Reader 采样时间 > 30s。

**步骤**:
1. 调用 `GET /api/state`

**预期结果**:
- `state: "UNKNOWN"`（不是 STUCK）
- reason 包含 "collector liveness unavailable"

### T-STATE-16: UNKNOWN — PM2 不可用 [MUST]

**前置条件**: PM2 jlist 调用失败。AM 不可用。

**步骤**:
1. 调用 `GET /api/state`

**预期结果**:
- `state: "UNKNOWN"`
- reason 包含 "PM2 data unavailable"

### T-STATE-17: UNKNOWN — 全部源 stale [MUST]

**前置条件**: PM2 online，但 collector liveness 全部 stale 且 lastProgressAge > 300s。

**步骤**:
1. 调用 `GET /api/state`

**预期结果**:
- `state: "UNKNOWN"`
- reason 包含 "collector liveness unhealthy"

### T-STATE-18: 两信号架构验证 [MUST]

**目的**: 验证 runtime progress 缺失 + collector liveness 缺失 不判 STUCK。

**步骤**:
1. 模拟：PM2 online，无 runtime progress event（5 分钟），collector liveness 全部 stale
2. 调用 `GET /api/state`

**预期结果**:
- `state: "UNKNOWN"`（不是 POSSIBLY_STUCK 或 STUCK）

### T-STATE-19: 多并发工具 [MUST]

**步骤**:
1. 注入 PreToolUse（tool_use_id="t1"，tool_name="Bash"）
2. 注入 PreToolUse（tool_use_id="t2"，tool_name="Agent"）
3. 注入 PostToolUse（tool_use_id="t1"）
4. 调用 `GET /api/state`

**预期结果**:
- `state: "BUSY"`（t2 仍在运行）
- 状态引擎正确追踪多个 tool_use_id
- reason 引用仍在运行的 tool（Agent）

### T-STATE-20: 状态输出格式完整性 [MUST]

**步骤**:
1. 在任意状态下调用 `GET /api/state`

**预期结果**:
- 响应包含 §4.4 定义的所有字段：`state`、`confidence`、`evidence`、`missing_evidence`、`reason`、`suggested_action`、`updated_at`、`source`、`owner_tier`
- `source` 对象按 §4.2 两信号架构分层，区分 `runtime_progress` 和 `collector_liveness` 两个域：
  ```json
  {
    "source": {
      "runtime_progress": {
        "hook_events": { "fresh": true, "age_s": 12 },
        "otel_events": { "fresh": true, "age_s": 8 }
      },
      "collector_liveness": {
        "pm2_reader": { "fresh": true, "age_s": 5 },
        "system_sampler": { "fresh": true, "age_s": 10 },
        "hook_handler": { "fresh": true, "age_s": 12 },
        "otel_reader": { "fresh": true, "age_s": 8 }
      },
      "platform": {
        "statusline": { "fresh": false, "age_s": 120 },
        "c4": { "fresh": true, "age_s": 3 },
        "scheduler": { "fresh": true, "age_s": 15 }
      }
    }
  }
  ```
- 该分层结构保证 STUCK 判定的语义有效性可从 API 响应中验证：STUCK 要求 `collector_liveness` 全部 fresh 且 `runtime_progress` 缺失

---

## 7. State Engine 重启恢复 (AC-1)

### T-AC1-01: Open tool 恢复 [MUST]

**步骤**:
1. 注入 PreToolUse（tool_use_id="t1"，tool_name="Read"）
2. 等待 state snapshot 写入（30s 或状态变更触发）
3. 重启 Dashboard 服务
4. 调用 `GET /api/state`

**预期结果**:
- 状态为 BUSY，reason 引用 tool_use_id="t1"
- running tool 信息从 snapshot + event replay 恢复

### T-AC1-02: Open turn 恢复 [MUST]

**步骤**:
1. 注入 UserPromptSubmit
2. 等待 snapshot
3. 重启 Dashboard
4. 调用 `GET /api/state`

**预期结果**:
- 状态为 BUSY（MEDIUM，open turn）

### T-AC1-03: Pending permission 恢复 [MUST]

**步骤**:
1. 注入 PermissionRequest
2. 等待 snapshot
3. 重启 Dashboard
4. 调用 `GET /api/state`

**预期结果**:
- 状态为 WAITING_HUMAN

### T-AC1-04: Missing close event 降级 [MUST]

**步骤**:
1. 注入 PreToolUse（tool_use_id="t1"，timestamp = now - 400s）
2. 不注入 PostToolUse
3. 重启 Dashboard
4. 等待 replay 完成
5. 调用 `GET /api/state`

**预期结果**:
- 因 evidence_age > 300s，降级为 UNKNOWN
- reason 包含 "evidence stale" 或 "hook may have been lost"

### T-AC1-05: 无 snapshot 时从 SessionStart 回放 [MUST]

**前置条件**: 删除 state_snapshots 表中所有记录（模拟首次部署或清空）。runtime_events 中有最近 1 小时的事件。

**步骤**:
1. 重启 Dashboard
2. 调用 `GET /api/state`

**预期结果**:
- 从最近 SessionStart 事件（或 max(now-2h, oldest boundary)）开始回放
- 状态正确恢复

### T-AC1-06: Replay 期间新事件处理 [MUST]

**步骤**:
1. runtime_events 中有 500 条历史事件（模拟需要较长 replay 时间）
2. 重启 Dashboard
3. 在 replay 过程中发送新的 `/api/ingest` 请求

**预期结果**:
- 新事件正常入库到 runtime_events
- 新事件不影响正在进行的 replay
- replay 完成后，新事件被正确处理，状态一致

### T-AC1-07: State key 为 runtime + session_id [MUST]

**步骤**:
1. 注入 Claude runtime 的 PreToolUse 事件（session_id="claude-s1"）
2. 注入 Codex runtime 的 UserPromptSubmit 事件（session_id="codex-s1"）
3. 调用 `GET /api/state`

**预期结果**:
- 当前 runtime 的状态正确反映
- 不同 runtime/session 的事件不交叉污染

---

## 8. Metric Resolver (AC-2)

### T-AC2-01: StatusLine 独占字段优先 [MUST]

**前置条件**: StatusLine 和 OTel 同时提供 context_pct 数据。

**步骤**:
1. 写入 metric_points：`{metric_name: "context_pct", source: "statusline", value: 72.5}`
2. 写入 metric_points：`{metric_name: "context_pct", source: "otel", value: 70.0}`
3. 调用 `GET /api/metrics/context_pct`

**预期结果**:
- 返回 value=72.5，selected_source="statusline"
- alternatives 中包含 otel 的值

### T-AC2-02: OTel 优先字段 — tool_duration [MUST]

**前置条件**: OTel span 和 Hook PostToolUse 同时提供 tool_duration 数据。

**步骤**:
1. 写入 metric_points：`{metric_name: "tool_duration", source: "otel_span", value: 1523, confidence: "actual"}`
2. 写入 metric_points：`{metric_name: "tool_duration", source: "hook", value: 1520, confidence: "actual"}`
3. 调用 `GET /api/metrics/tool_duration`

**预期结果**:
- 返回 value=1523，selected_source="otel_span"（D5：OTel 优先，hook 作为实时补充）
- alternatives 中包含 hook 的值

### T-AC2-02b: OTel 优先字段 — session_cost [MUST]

**前置条件**: OTel 和 StatusLine 同时提供 session_cost 数据。

**步骤**:
1. 写入 metric_points：`{metric_name: "session_cost", source: "otel", value: 2.14, confidence: "actual"}`
2. 写入 metric_points：`{metric_name: "session_cost", source: "statusline", value: 2.10, confidence: "actual"}`
3. 调用 `GET /api/metrics/session_cost`

**预期结果**:
- 返回 value=2.14，selected_source="otel"（OTel per-request 精度更高）
- alternatives 中包含 statusline 的值
- Hook 不在 session_cost 的 source chain 中（D5：hooks 不提供 cost 数据）

### T-AC2-03: Fallback 链 [MUST]

**前置条件**: OTel 不可用。

**步骤**:
1. 仅写入 metric_points：`{metric_name: "session_cost", source: "statusline", value: 2.00}`
2. 调用 `GET /api/metrics/session_cost`

**预期结果**:
- 返回 value=2.00，selected_source="statusline"
- fallback_reason 说明 OTel 不可用

### T-AC2-04: 存储层保留所有原始数据 [MUST]

**步骤**:
1. 对同一 metric_name 写入来自 3 个不同 source 的数据
2. 直接查询 metric_points 表

**预期结果**:
- 3 条记录全部保留，不因 resolver 选择而删除非 preferred source 的数据

### T-AC2-05: API 输出格式完整性 [MUST]

**步骤**:
1. 调用 `GET /api/metrics/context_pct`

**预期结果**:
- 响应包含：`value`、`selected_source`、`freshness`、`confidence`、`alternatives`（数组）、`fallback_reason`（可为 null）

### T-AC2-06: Codex estimated cost 标注 [MUST]

**步骤**:
1. 写入 Codex runtime 的 token 计数（无直接 cost）
2. 调用 `GET /api/metrics/session_cost`

**预期结果**:
- confidence 为 "estimated"
- 前端标注 "estimated"（用 token × 价格表计算）

---

## 9. Owner UX Confidence 映射 (AC-3)

### T-AC3-01: confirmed_normal 映射 [MUST]

**步骤**:
1. 状态为 IDLE + HIGH confidence
2. 调用 `GET /api/state`

**预期结果**:
- 响应包含 `owner_tier: "confirmed_normal"`
- 无额外警告文案

### T-AC3-02: in_progress_uncertain 映射 [MUST]

**步骤**:
1. 状态为 BUSY + MEDIUM confidence（open turn 无工具）

**预期结果**:
- `owner_tier: "in_progress_uncertain"`
- reason 文案为 "正在处理消息"（非 "正在稳定工作"）

### T-AC3-03: needs_attention 映射 [MUST]

**步骤**:
1. 状态为 POSSIBLY_STUCK 或 STUCK

**预期结果**:
- `owner_tier: "needs_attention"`
- 包含可验证原因 + suggested_action

### T-AC3-04: unknown_degraded 映射 [MUST]

**步骤**:
1. 状态为 UNKNOWN

**预期结果**:
- `owner_tier: "unknown_degraded"`
- reason 文案如 "遥测数据中断，无法确认状态"

### T-AC3-05: UI 不显示 HIGH/MEDIUM/LOW [MUST]

**步骤**:
1. 查看 Overview ① 区块在各状态下的前端渲染

**预期结果**:
- 前端不展示 "HIGH"、"MEDIUM"、"LOW" 字样
- 仅展示 owner_tier 对应的自然语言描述

### T-AC3-06: LOW confidence 仅在 diagnostics 显示 [SHOULD]

**步骤**:
1. 状态为 POSSIBLY_STUCK + LOW confidence（有活跃 OTel span）

**预期结果**:
- 主 UI 不显示该状态（或显示为 in_progress_uncertain）
- 仅在 detail/diagnostics panel 可见

---

## 10. Hook 健康检测 (AC-4)

### T-AC4-01: Healthy 状态 [MUST]

**前置条件**: 近 5 分钟有持续 hook 事件到达，无 pending expected event 超时。

**步骤**:
1. 查询 source_health 中 hook_handler 记录

**预期结果**:
- `status: "healthy"`
- `last_success` 在最近几秒内
- `event_count_1h` > 0

### T-AC4-02: Suspect 状态 [MUST]

**步骤**:
1. 注入 PreToolUse 事件
2. 等待超过工具 P95 阈值（如 Bash 120s）但不注入 PostToolUse
3. 无 OTel 旁证

**预期结果**:
- source_health hook_handler 或 hook_events 标记为 `suspect`

### T-AC4-03: Degraded 状态 — OTel 旁证 [MUST]

**步骤**:
1. 注入 PreToolUse 事件
2. OTel 记录了对应工具的 tool_result span（证明工具已完成）
3. 但 hook-ingest 缺 PostToolUse 事件

**预期结果**:
- source_health hook_events 标记为 `degraded`（强证据：OTel 看到了但 hook 没到）

### T-AC4-04: Expected-event pairing 逻辑 [MUST]

**步骤**:
1. 注入 PreToolUse（tool_use_id="t1"）
2. 注入 PostToolUse（tool_use_id="t1"）

**预期结果**:
- t1 的 expected closing 已配对完成
- 无超时告警

### T-AC4-05: 多个 open expectation [SHOULD]

**步骤**:
1. 注入 3 个 PreToolUse（t1、t2、t3）
2. 仅注入 PostToolUse（t1）

**预期结果**:
- t1 配对完成
- t2、t3 仍在 open expectation 列表中
- 超时后 t2、t3 触发 suspect 状态

---

## 11. Hook 延迟基准 + Spool 恢复 (AC-5)

### T-AC5-01: 正常路径延迟 — Dashboard 在线 [MUST]

**步骤**:
1. Dashboard 运行中
2. 循环执行 100 次 hook-ingest.js（有效 PreToolUse payload），记录每次耗时

**预期结果**:
- p50 < 50ms
- p95 < 50ms
- p99 < 50ms
- 100 次全部 exit(0)

### T-AC5-02: Spool 路径延迟 — Dashboard 离线 [MUST]

**步骤**:
1. Dashboard 已停止
2. 循环执行 100 次 hook-ingest.js，记录每次耗时

**预期结果**:
- p50 < 40ms
- p95 < 40ms
- p99 < 40ms
- 100 次全部 exit(0)
- spool 文件有 100 行

### T-AC5-03: 进程硬超时 [MUST]

**步骤**:
1. 模拟 `/api/ingest` 端点永不响应（挂起连接）
2. 执行 hook-ingest.js

**预期结果**:
- 200ms POST 超时后走 spool 路径
- 进程在 500ms 内退出（硬上限）
- 退出码为 0

### T-AC5-04: 始终 exit(0) [MUST]

**步骤**: 以下场景各执行一次 hook-ingest.js：
1. 正常 POST 成功
2. POST 超时，spool 写入成功
3. POST 失败（connection refused），spool 写入成功
4. POST 失败，spool 目录不存在（写入也失败）
5. 非法 JSON 输入
6. 空 stdin

**预期结果**:
- 6 种场景全部 exit(0)

### T-AC5-05: 完整 spool 恢复流程 [MUST]

**步骤**:
1. 停止 Dashboard
2. 通过 hook-ingest.js 注入 20 条事件（包括 PreToolUse/PostToolUse/UserPromptSubmit/Stop/PermissionRequest 各至少 2 条）
3. 验证 spool 有 20 行
4. 手动将 5 条事件直接写入 runtime_events（模拟 POST 成功但 hook 也 spool 了的竞态），使用其中 5 条相同的 ingest_id
5. 启动 Dashboard
6. 等待 spool drain 完成
7. 查询 runtime_events

**预期结果**:
- runtime_events 中有 20 条记录（不是 25 条——5 条重复被 INSERT OR IGNORE 跳过）
- spool 文件已清除
- 状态引擎通过 replay 恢复正确状态
- source_health 中 hook_handler 从 degraded 转为 healthy

### T-AC5-06: Agent session 无感知 [SHOULD]

**步骤**:
1. 在实际 Claude Code session 中启用 hook
2. 执行一系列常规操作（文件读写、Bash 命令）
3. 观察用户体验

**预期结果**:
- hook 执行对 agent 响应无可感知延迟
- 不出现 hook timeout 告警
- agent 操作流畅

---

## 12. REST API

### T-API-01: GET /api/state [MUST]

**步骤**:
1. 请求 `GET /api/state`

**预期结果**:
- HTTP 200
- JSON 响应符合 §4.4 格式
- 包含 `state`、`confidence`、`evidence`、`reason`、`updated_at`、`source`、`owner_tier`

### T-API-02: GET /api/health [MUST]

**步骤**:
1. 请求 `GET /api/health`

**预期结果**:
- HTTP 200
- 包含所有 source_health 记录
- 每个源包含 `signal_type`、`status`、`last_success`、`event_count_1h`

### T-API-03: GET /api/system [MUST]

**步骤**:
1. 请求 `GET /api/system`

**预期结果**:
- HTTP 200
- 包含 CPU%、内存使用率、磁盘使用率、PM2 服务列表

### T-API-04: GET /api/metrics/:name — 已知指标 [MUST]

**步骤**:
1. 请求 `GET /api/metrics/context_pct`

**预期结果**:
- HTTP 200
- 包含 AC-2 定义的完整输出格式

### T-API-05: GET /api/metrics/:name — 未知指标 [MUST]

**步骤**:
1. 请求 `GET /api/metrics/nonexistent_metric`

**预期结果**:
- HTTP 404 或 200 with `value: null` + `reason: "unsupported_metric"`

### T-API-06: 认证保护 [MUST]

**前置条件**: Dashboard 已配置 basic auth。

**步骤**:
1. 不带认证请求 `GET /api/state`
2. 带正确认证请求 `GET /api/state`

**预期结果**:
1. HTTP 401
2. HTTP 200

---

## 13. SSE 实时推送

### T-SSE-01: 连接建立 [MUST]

**步骤**:
1. 请求 `GET /api/stream`（EventSource 或 curl）

**预期结果**:
- 连接保持打开
- Content-Type 为 `text/event-stream`

### T-SSE-02: state_change 事件 [MUST]

**步骤**:
1. 建立 SSE 连接
2. 触发状态变更（注入 PreToolUse 使 IDLE → BUSY）

**预期结果**:
- SSE 收到 `event: state_change`
- data 包含新状态信息

### T-SSE-03: new_event 事件 [MUST]

**步骤**:
1. 建立 SSE 连接
2. 通过 `/api/ingest` 注入一条事件

**预期结果**:
- SSE 收到 `event: new_event`
- data 包含事件摘要

### T-SSE-04: metric_update 事件 [SHOULD]

**步骤**:
1. 建立 SSE 连接
2. 写入新的 metric_point

**预期结果**:
- SSE 收到 `event: metric_update`

### T-SSE-05: 多客户端 [SHOULD]

**步骤**:
1. 同时建立 3 个 SSE 连接
2. 触发一次状态变更

**预期结果**:
- 3 个连接都收到 state_change 事件

---

## 14. Frontend — Overview 区块

### T-UI-01: ① Live Runtime State — 状态指示灯颜色 [MUST]

**步骤**: 在不同状态下查看 Overview 页面

**预期结果**:
- OFFLINE → 灰色
- IDLE → 绿色
- BUSY → 黄色
- WAITING_HUMAN → 蓝色闪烁
- POSSIBLY_STUCK → 橙色
- STUCK → 红色

### T-UI-02: ① Ticking timer [MUST]

**步骤**:
1. 注入 PreToolUse 事件（started_at = now）
2. 观察 Overview 页面

**预期结果**:
- 显示当前工具名 + 已运行时长
- 时长每秒递增（setInterval）
- 注入 PostToolUse 后计时停止

### T-UI-03: ① 多工具并发显示 [MUST]

**步骤**:
1. 注入 2 个 PreToolUse（不同 tool_use_id）

**预期结果**:
- 显示最新一条工具 + "+1 个工具运行中"
- 可展开查看完整列表
- 每条工具各自 ticking

### T-UI-04: ② Capacity & Cost 展示 [MUST]

**步骤**:
1. 写入 context_pct、rate_limit、session_cost、cache_hit_rate 的 metric_points

**预期结果**:
- ② 区块显示各指标值
- actual/estimated 标注正确
- 无数据时显示 "—"（unavailable）

### T-UI-05: ③ Health & System 展示 [MUST]

**步骤**:
1. 查看 Overview 页面

**预期结果**:
- 显示 CPU%、内存、磁盘
- PM2 服务列表带状态
- Hook 采集状态
- OTel 采集状态

### T-UI-06: Tab 切换 [MUST]

**步骤**:
1. 在 Overview tab 和 Trends tab 之间切换

**预期结果**:
- Tab 切换流畅
- 各 tab 内容独立
- 注：Trends tab 内容为 Phase 2c，Phase 2a 只需 tab 结构就绪，内容可为占位符

### T-UI-07: owner_tier 文案展示 [MUST]

**步骤**:
1. 在各 owner_tier 状态下查看 ① 区块

**预期结果**:
- confirmed_normal → 正常状态文案，无额外警告
- in_progress_uncertain → "正在处理消息" 类文案
- needs_attention → 原因 + 建议动作
- unknown_degraded → "无法确认状态" + 原因

---

## 15. Security

### T-SEC-01: Ingest 端点不可公网访问 [MUST]

**步骤**:
1. 通过公网 URL（如 https://zylos01.jinglever.com/dashboard/api/ingest）请求

**预期结果**:
- 404 或 403（不可达）

### T-SEC-02: 认证不影响 SSE [MUST]

**步骤**:
1. 带正确认证建立 SSE 连接

**预期结果**:
- SSE 正常工作，受认证保护

### T-SEC-03: runtime_events 无敏感数据 [MUST]

**步骤**:
1. 在实际运行中注入多种工具事件
2. 用 sqlite3 直接查询 runtime_events 全表

**预期结果**:
- 无完整文件路径（最多两段）
- 无 API key / token / credential
- 无 tool_response / tool_output 原文
- 无 prompt 原文

---

## 16. 测试执行说明

### 自动化测试

以下测试应编写为 `node --test` 可执行的自动化用例：
- 所有 T-STORE-* 用例
- 所有 T-INGEST-* 用例
- 所有 T-API-INGEST-* 用例
- 所有 T-SPOOL-* 用例
- 所有 T-STATE-* 用例（通过注入事件 + 断言状态输出）
- 所有 T-AC1-* 用例
- 所有 T-AC2-* 用例
- 所有 T-AC4-* 用例
- T-AC5-01 至 T-AC5-05
- 所有 T-API-* 用例
- T-SSE-01 至 T-SSE-03

### 手动测试

以下测试需手动验证：
- T-AC3-05（UI 视觉检查）
- T-AC5-06（实际 agent session 体验）
- 所有 T-UI-* 用例（浏览器视觉验证）
- 所有 T-SEC-* 用例

### 延迟基准测试

T-AC5-01 和 T-AC5-02 需编写专用 benchmark 脚本：
- 使用 `performance.now()` 或 `process.hrtime.bigint()` 精确计时
- 输出 p50/p95/p99 统计值
- 分别在 Dashboard 在线/离线两种条件下运行
- 每次运行 ≥ 100 次采样

### 通过标准

- **所有 [MUST] 用例通过** → Phase 2a 验收通过
- **[SHOULD] 用例未通过** → 记录为已知限制，不阻塞验收，在后续迭代中修复
