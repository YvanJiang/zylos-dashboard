# Zylos Dashboard — 总方案

## Executive Summary

Zylos Dashboard 是一个为 zylos agent 系统设计的可观测性与管理仪表盘。它将分散在多个文件、数据库和日志中的运行时数据汇聚到一个统一的 Web 界面中，让运维者（Howard）能够实时掌握 agent 的运行状态、资源消耗、任务执行和通信活动。

核心设计原则：

1. **读取已有数据，不改变现有架构**。Dashboard 作为一个纯观测层，不修改 zylos 的核心运行逻辑，仅消费已有的数据源。
2. **统一 runtime observability model，不是数据来源拼盘**。Dashboard 展示的是面向用户的统一指标，不按数据获取途径（遥测 / hook / 状态文件）拆分版面。底层来源只是指标 metadata。
3. **多 runtime 并集覆盖**。同时支持 Claude runtime 和 Codex runtime。指标集取两个 runtime 的并集：某 runtime 不支持的指标标记为 unsupported，不假补数据。

## 1. 问题定义

### 1.1 当前痛点

目前 zylos 运行时已积累了丰富的运行数据，但这些数据分散在多处，缺乏统一的可视化入口：

| 数据类型 | 当前位置 | 查看方式 |
|---------|---------|---------|
| Agent 状态（忙/闲/思考） | `activity-monitor/agent-status.json` | 手动 `cat` 文件 |
| Statusline（成本/context/rate limit） | `activity-monitor/statusline.json` | 手动查 JSON |
| Session 成本 | `activity-monitor/cost-log.jsonl` (576 条记录) | 手动查 JSONL |
| 工具调用事件 | `activity-monitor/tool-events.jsonl` (2651 条) | 手动查 JSONL |
| 工具会话状态 | `activity-monitor/session-tool-state.json` | 手动查 JSON |
| API 活动 | `activity-monitor/api-activity.json` | 手动查 JSON |
| Context 使用率 | `activity-monitor/context-monitor-state.json` | 手动查 JSON |
| 进程状态 | `activity-monitor/proc-state.json` | 手动查 JSON |
| 配额使用 | `activity-monitor/usage.json` | 手动查 JSON |
| Hook 计时 | `activity-monitor/hook-timing.log` (~98KB) | 手动查日志 |
| 活动日志 | `activity-monitor/activity.log` (~75KB, 每日截断 500 行) | 手动查日志 |
| 通信记录 | `comm-bridge/c4.db` (18138 条对话, 308 checkpoints) | SQL 查询 |
| 计划任务 | `scheduler/scheduler.db` (12 active, 293 history) | CLI 命令 |
| PM2 服务状态 | PM2 运行时 | `pm2 status` 命令 |
| PM2 日志 | `~/.pm2/logs/` (12 服务 × 2 = 24 文件) | 手动查日志 |
| 系统日志 | `~/zylos/logs/` (health/upgrade/doctor 等) | 手动查日志 |
| Session 会话记录 | `~/.claude/projects/.../` (175 个 .jsonl) | 无可视化工具 |
| 内存使用 | `memory/` 目录 | 手动浏览 |

### 1.2 新机遇：Claude Code 原生 OTel

Claude Code 原生支持 OpenTelemetry 遥测输出，体系非常完善：

**环境变量体系：**

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_ENABLE_TELEMETRY=1` | 主开关（必需） |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` | 启用 span tracing（beta） |
| `OTEL_METRICS_EXPORTER` | `otlp` / `prometheus` / `console` / `none` |
| `OTEL_LOGS_EXPORTER` | `otlp` / `console` / `none` |
| `OTEL_TRACES_EXPORTER` | `otlp` / `console` / `none` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | e.g. `http://localhost:4317` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` / `http/json` / `http/protobuf` |
| `OTEL_METRIC_EXPORT_INTERVAL` | 默认 60000ms |
| `OTEL_LOGS_EXPORT_INTERVAL` | 默认 5000ms |

**内容细粒度控制（opt-in）：**

| 变量 | 内容 |
|------|------|
| `OTEL_LOG_USER_PROMPTS=1` | Prompt 文本内容 |
| `OTEL_LOG_TOOL_DETAILS=1` | 工具输入参数（文件路径、bash 命令、MCP/skill 名称） |
| `OTEL_LOG_TOOL_CONTENT=1` | 完整工具 I/O（60KB 截断），需启用 tracing |
| `OTEL_LOG_RAW_API_BODIES` | 完整 API 请求/响应 JSON |

**8 个 Metrics：**
- `claude_code.session.count` — session 启动计数
- `claude_code.lines_of_code.count` — 代码变更行数（added/removed）
- `claude_code.pull_request.count` — PR 创建数
- `claude_code.commit.count` — commit 数
- `claude_code.cost.usage` — 成本（按 model、query_source、speed、effort）
- `claude_code.token.usage` — token 消耗（input/output/cacheRead/cacheCreation）
- `claude_code.code_edit_tool.decision` — 代码编辑工具决策
- `claude_code.active_time.total` — 活跃时间

**13+ 个 Log Events：**
- `claude_code.user_prompt` — prompt 提交
- `claude_code.tool_result` — 工具完成（含 tool_name、success、duration_ms）
- `claude_code.api_request` — API 调用（含 model、cost_usd、duration_ms、token 计数）
- `claude_code.api_error` — API 失败
- `claude_code.tool_decision` — 工具 accept/reject
- `claude_code.compaction` — context 压缩（含 pre/post tokens）
- `claude_code.hook_execution_start/complete` — Hook 生命周期
- `claude_code.mcp_server_connection` — MCP 连接状态
- 等

**Traces span 层级（beta）：**
```
claude_code.interaction（一轮对话）
├── claude_code.llm_request（API 调用：model, tokens, ttft_ms, cache stats）
├── claude_code.tool（工具执行）
│   ├── claude_code.tool.blocked_on_user（等待用户确认）
│   ├── claude_code.tool.execution（实际执行：duration_ms, success, error）
│   └── （Task 子 agent 的 spans 嵌套在此）
├── claude_code.hook（Hook 执行）
└── claude_code.subagent（子 agent）
```

**W3C Trace Context 传播**：Claude Code 自动传播 `TRACEPARENT` 到 Bash 子进程和 Agent SDK 子 agent，实现端到端分布式追踪。

**多实例标识**：通过 `OTEL_RESOURCE_ATTRIBUTES="agent.name=zylos01"` 和 `OTEL_SERVICE_NAME` 区分不同 zylos 实例。

已有参考项目 `claude-code-telemetry`（GitHub lainra/claude-code-telemetry）演示了 Claude Code OTel → OTel Collector → Langfuse 的完整链路。该项目架构简单（Docker Compose 跑 Langfuse + Postgres + Bridge），但功能单一（仅成本/token 追踪），我们的 Dashboard 需要整合更丰富的数据源。

## 2. 设计目标

### 2.1 核心目标

1. **状态总览**：一屏看到 agent 当前状态、健康度、活跃工具
2. **成本追踪**：session 级和日级别的 token/成本统计，趋势图
3. **任务监控**：计划任务执行状态、成功率、下次执行时间
4. **通信概览**：各渠道消息量、响应时间分布
5. **服务健康**：PM2 服务运行状态、重启次数、内存/CPU
6. **OTel 集成**：接入 Claude Code 原生遥测，实现请求级追踪

### 2.2 设计约束

- **只读原则**：Dashboard 不执行写操作（不修改配置、不重启服务、不发消息）
- **零侵入**：不修改现有 activity-monitor、scheduler、comm-bridge 的代码
- **zylos 组件规范**：遵循 `zylos add` 组件安装标准，可被其他 zylos 实例复用
- **轻量依赖**：优先使用 Node.js 生态（与 zylos 技术栈一致），避免引入 Python/Java/Docker 重依赖

## 3. 架构方案

### 3.1 总体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Web UI)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ 状态总览  │ │ 成本分析  │ │ 任务监控  │ │ OTel 追踪 │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│       └────────────┼───────────┼──────────────┘         │
│                    ▼                                     │
│            Dashboard API Server                          │
│            (Node.js, Caddy route)                        │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP / SSE
┌──────────────────────┼──────────────────────────────────┐
│              Data Access Layer                           │
│  ┌──────────────┬───────────────┬──────────────────┐    │
│  │ File Reader  │ SQLite Reader │ PM2 API Client   │    │
│  │ (JSONL/JSON) │ (c4.db,       │ (pm2 bus)        │    │
│  │              │  scheduler.db)│                   │    │
│  └──────┬───────┴───────┬───────┴────────┬─────────┘    │
│         │               │                │              │
│  activity-monitor/  comm-bridge/     pm2 runtime        │
│  *.jsonl, *.json    c4.db            process list       │
│                     scheduler/                          │
│                     scheduler.db                        │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              OTel Pipeline (可选增强)                     │
│  Claude Code ──OTel──▶ Collector ──▶ Dashboard DB       │
│  (CLAUDE_CODE_ENABLE_TELEMETRY=1)                        │
└─────────────────────────────────────────────────────────┘
```

### 3.2 技术选型

| 层 | 选型 | 理由 |
|---|------|------|
| **后端** | Node.js + Express/Fastify | 与 zylos 技术栈一致，可复用已有模块 |
| **前端** | 纯静态 HTML + Vanilla JS + Chart.js | 零构建、即开即用，Caddy 直接托管。比 React/Vue 更轻量，适合运维仪表盘 |
| **数据读取** | better-sqlite3 (只读模式) + fs.watch + polling 兜底 | SQLite URI readonly + fileMustExist + PRAGMA query_only 三层保护；fs.watch 做变化提示，5-10s polling 兜底（activity-monitor 用 temp+rename 写入，inotify 会丢 inode） |
| **实时推送** | SSE (Server-Sent Events) + polling fallback | 只读 dashboard 无需双向通信；SSE 只推薄事件通知（type+id），客户端按需调 REST 拉数据；EventSource 自带重连；降级到 5-10s polling |
| **OTel Collector** | @opentelemetry/sdk-node | 轻量 Node.js OTel Collector，接收 Claude Code 导出 |
| **数据存储** | SQLite (dashboard 自有) | 存储 OTel traces/metrics，不污染已有数据库 |
| **部署** | PM2 + Caddy route | 遵循 zylos 标准部署方式 |

### 3.3 数据源详解

#### A. 已有数据（零改动直接读取）

| 数据源 | 文件 | 更新频率 | 读取方式 |
|--------|------|---------|---------|
| Agent 状态 | `agent-status.json` | ~1s | fs.watch + JSON parse |
| Statusline | `statusline.json` | 每个 turn | fs.watch（最丰富的单文件数据源：session_id, model, cost, context%, rate limits, effort） |
| Claude 状态 | `claude-status.json` | 实时 | fs.watch |
| Session 成本 | `cost-log.jsonl` | session 结束时 | 启动全量 + tail 增量 |
| 工具事件 | `tool-events.jsonl` | 实时 | tail -f 流式读取 |
| 工具会话状态 | `session-tool-state.json` | 每个工具事件 | fs.watch |
| API 活动 | `api-activity.json` | 每个工具事件 | fs.watch |
| Context 状态 | `context-monitor-state.json` | 定期 | fs.watch |
| 进程采样 | `proc-state.json` | ~10s | fs.watch |
| 配额 | `usage.json` | 定期检查 | fs.watch |
| Hook 状态 | `hook-state.json` | 事件触发 | fs.watch |
| Hook 计时 | `hook-timing.log` | 每个 hook | tail -f |
| 活动日志 | `activity.log` | ~1s | tail -f（每日截断至 500 行） |
| 通信记录 | `c4.db` | 消息到达时 | SQLite readonly |
| 任务调度 | `scheduler.db` | 任务执行时 | SQLite readonly |

#### B. 新增数据（OTel Pipeline）

启用 `CLAUDE_CODE_ENABLE_TELEMETRY=1` 后，Claude Code 通过 OTLP/gRPC 或 OTLP/HTTP 导出遥测数据。Dashboard 内嵌一个轻量 OTel Collector 接收端，将数据写入自有 SQLite 库。

环境变量配置：
```bash
# 在 .env 中添加
CLAUDE_CODE_ENABLE_TELEMETRY=1
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1          # 启用 traces
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=otlp
OTEL_LOG_TOOL_DETAILS=1                        # 记录工具参数
OTEL_RESOURCE_ATTRIBUTES="agent.name=zylos01"  # 多实例标识
```

OTel 数据模型（详见上方 1.2 节完整列表）：
- **Metrics (8)**：session/token/cost/LOC/PR/commit/tool decision/active time
- **Events (13+)**：prompt/tool_result/api_request/api_error/compaction/hook 等
- **Traces**：interaction → llm_request / tool / hook / subagent 完整瀑布图

**关键架构洞察**：Dashboard 需要统一两个数据平面：
1. **OTel 平面**（新增）：Claude Code 原生遥测 — 请求级粒度
2. **Activity-Monitor 平面**（已有）：自定义 Hook 监控 — agent 状态机、watchdog、context 管理

两者互补而非替代：OTel 提供 LLM 请求维度的深度数据，activity-monitor 提供 agent 生命周期维度的运维数据。

## 4. 功能模块

### 4.1 Phase 1 — MVP（已有数据可视化）

> 目标：2 周内可用，零侵入

**4.1.1 实时状态面板**
- Agent 状态指示灯（idle / busy / thinking / error）
- 当前活跃工具名称和运行时长
- Context 使用率仪表盘（百分比 + 颜色警告）
- 配额使用率（session/weekly）
- 运行时间（uptime）

**4.1.2 成本分析**
- 每日/每周/每月成本趋势图（已有 576 条 session 成本记录）
- 单 session 成本分布直方图
- 日均/周均成本统计
- Context 使用率 vs 成本的相关性

**4.1.3 工具调用分析**
- 工具使用频率排行（已有 2651 条事件）
- 工具执行耗时分布
- 工具成功/失败率
- 时间线视图：工具调用序列

**4.1.4 通信概览**
- 各渠道（Telegram/Lark/HXA/Web Console）消息量统计
- 每日消息量趋势
- 响应时间分布（in → out 时间差）
- 最近消息列表（脱敏）

**4.1.5 任务调度监控**
- 当前活跃任务列表
- 任务执行历史（成功/失败/跳过）
- 下次执行时间
- 任务执行时长趋势

**4.1.6 PM2 服务健康**
- 各服务运行状态（online/stopped/errored）
- 重启次数
- 内存/CPU 使用
- 日志最后 N 行预览

### 4.2 Phase 2 — OTel 增强

> 目标：启用 Claude Code 原生遥测后的深度可观测性

**4.2.1 请求追踪**
- 完整的 interaction → llm_request → tool 追踪瀑布图
- 每次 API 请求的 token 消耗（input/output/cache hit）
- 工具调用链可视化

**4.2.2 性能分析**
- LLM 请求延迟 P50/P95/P99
- 工具执行延迟分布
- Cache hit rate 追踪
- 子 agent 资源消耗

**4.2.3 异常检测**
- 工具执行超时告警
- 异常高 token 消耗检测
- 连续失败模式识别

### 4.3 Phase 3 — 多实例 + 比较

> 目标：支持多个 zylos 实例的集中监控

- 多 agent 状态对比（zylos01 / zylos0t / zylos100 等）
- 跨实例成本汇总
- 实例间性能对比

## 5. 组件结构

```
~/zylos/.claude/skills/dashboard/
├── SKILL.md                # 组件元信息 + PM2 service 声明
├── scripts/
│   ├── server.js           # API server 主入口
│   ├── data-sources/
│   │   ├── activity-monitor.js   # 读取 activity-monitor 数据文件
│   │   ├── communication.js      # 读取 c4.db (readonly)
│   │   ├── scheduler.js          # 读取 scheduler.db (readonly)
│   │   └── pm2.js                # PM2 API 集成
│   ├── otel/
│   │   ├── collector.js          # OTel OTLP 接收端
│   │   └── storage.js            # OTel 数据 → SQLite
│   └── sse.js                    # SSE 实时推送（薄事件通知）
├── public/
│   ├── index.html                # 主页面
│   ├── css/
│   │   └── dashboard.css
│   └── js/
│       ├── app.js                # 主应用逻辑
│       ├── charts.js             # Chart.js 图表封装
│       └── events.js             # SSE/EventSource 客户端 + polling fallback
└── references/                   # 设计文档、决策记录

~/zylos/components/dashboard/
├── config.json             # 运行配置
├── dashboard.db            # OTel 数据存储 (Phase 2)
└── logs/
    ├── out.log
    └── error.log
```

## 6. 部署方案

### 6.1 Caddy 路由

```
# 添加到 Caddyfile
handle_path /dashboard/* {
    reverse_proxy localhost:{DASHBOARD_PORT}
}
```

访问地址：`https://zylos01.jinglever.com/dashboard/`

### 6.2 PM2 服务

在 SKILL.md frontmatter 中声明：
```yaml
service:
  name: zylos-dashboard
  entry: scripts/server.js
```

## 7. 安全考虑

### 7.1 数据只读保护

- **SQLite 三层只读**：URI `?mode=ro` + `fileMustExist: true`（防空库创建）+ `PRAGMA query_only = ON`（二次保险）
- **查询即开即关**：不持长事务/长游标，避免 WAL checkpoint 被拖住导致写入延迟
- **无外部网络依赖**：Dashboard 仅读取本地文件和数据库

### 7.2 访问控制

- **认证方式**：管理界面登录后发 HttpOnly + SameSite=Strict cookie；REST API 和 SSE 走同源 cookie；CLI/脚本访问支持 `Authorization: Bearer <token>`
- **URL token 默认关闭**：`?token=` 有泄露面（浏览器历史、access log、Referer header），仅 localhost + 显式配置开启时可用
- **绑定 localhost**：Dashboard server 只监听 127.0.0.1，外部访问通过 Caddy 反向代理

### 7.3 敏感信息保护

- **字段白名单**：Summary API 只返回状态、计数、时间戳、成本等聚合数据。不返回 prompt 原文、.env 值、完整消息正文
- **详情页限制**：工具事件列表返回 tool_name、duration、success，不返回工具输入参数
- **OTel 数据本地存储**：不发送到任何外部 SaaS

### 7.4 API 降级语义

每个数据源独立 try/catch，返回 per-source status：

```json
{
  "sources": {
    "activityMonitor": { "status": "ok", "updatedAt": "..." },
    "c4": { "status": "degraded", "error": "readonly open failed" },
    "scheduler": { "status": "ok" },
    "pm2": { "status": "ok" }
  }
}
```

单个源 degraded 不影响其他源展示。前端显示绿/黄/红 badge。

## 8. 与 COCO Dashboard 的关系

Zylos Dashboard 和 COCO Dashboard 是完全不同的产品：

| | Zylos Dashboard | COCO Dashboard |
|---|---|---|
| **目标用户** | Agent 运维者（开发团队） | COCO 平台客户（企业管理者） |
| **监控对象** | 单个 zylos agent 实例的运行时 | 企业的 AI 员工管理 |
| **数据来源** | 本地文件/DB/OTel | COCO 平台 API |
| **部署方式** | 每个 zylos 实例自带 | COCO 平台 SaaS |

但技术上有借鉴意义：zylos-dashboard 对 agent 运行时的可观测性探索，可以反哺 COCO Dashboard 的 AI Ops 模块设计。

## 9. Review 共识（Jinglever review, 2026-05-01）

架构讨论已收敛，以下为 zylos01 + Jinglever 达成的共识：

| 决策项 | 结论 |
|--------|------|
| MVP 边界 | 只读、可降级、可观测自身资源 |
| OTel | 不进 MVP，独立 spike 验证 |
| SQLite | URI readonly + fileMustExist + PRAGMA query_only，查询即开即关 |
| 文件监控 | fs.watch 做提示 + 5-10s polling 兜底（activity-monitor 用 temp+rename，inotify 不可靠） |
| Caddy | 走 http_routes marker block，不手改 Caddyfile |
| 实时刷新 | SSE 薄事件通知 + REST 拉数据，polling fallback |
| 前端 | Vanilla JS + Chart.js，不提前固化框架 |
| 认证 | Cookie（HttpOnly+SameSite）为主，Authorization header 为辅，URL token 默认关闭 |
| 降级 | per-source status，单源 degraded 不影响全局 |
| 时间窗口 | 默认 24h，list endpoint 硬性 limit，Chart.js 按 5min bucket downsample |
| 路径 | config.json 支持 override，默认按 zylos 标准路径推导 |
| PM2 | `pm2 jlist` 10s 轮询 + 5s timeout + 失败降级 |

**验证清单（9 条）**：

P0:
1. SQLite readonly smoke test（不存在不创建、INSERT 失败、SELECT 正常）
2. SQLite 并发压测（WAL 下写入循环 + dashboard 高频查询，观察 writer latency 和 WAL 文件增长）
3. JSON watcher 稳定性（原地写、temp+rename、半截 JSON、1000 次快速更新）
4. Caddy 路由验证（validate + reload + healthz + 现有路由不受影响）
5. Dashboard 资源基线（空闲、单客户端、5 客户端、持续更新 10 分钟，记录 RSS/CPU/事件延迟）

P1:
6. OTel 隔离测试（独立 HOME/测试进程/localhost collector，对比 on/off 延迟和资源）
7. OTel payload 敏感信息检查（traces/logs 是否含 prompt、文件路径、token、工具参数）
8. JSONL rotation 测试（copytruncate、rename-create、truncate 下 tail offset 恢复）
9. Caddy SSE 缓冲验证（是否需要 `flush_interval -1`）

## 10. Multi-Runtime 设计（v1.3 新增）

zylos-core 有两个重要 runtime：Claude Code 和 Codex CLI。Dashboard 的指标模型向上抽象为 zylos runtime 通用能力集，Claude/Codex 是两个 runtime implementation。

### 10.1 Runtime Capability Matrix

每个 runtime 对各数据采集途径的支持情况：

| 采集途径 | Claude Code | Codex CLI (v0.124.0+) | 备注 |
|---------|------------|----------------------|------|
| **Hook 事件** | | | |
| UserPromptSubmit | ✅ | ✅ | 两端共有 |
| PreToolUse | ✅ | ✅ | 两端共有 |
| PostToolUse | ✅ | ✅ | 两端共有 |
| Stop | ✅ | ✅ | 两端共有 |
| PostToolUseFailure | ✅ | ❌ | Claude 独有 |
| Notification | ✅ | ❌ | Claude 独有 |
| PermissionRequest | ❌ | ✅ | Codex 独有 |
| SessionStart | ❌ | ✅ | Codex 独有；Claude 可通过其他方式检测 |
| **OTel 遥测** | | | |
| Metrics (8 项) | ✅ | ❌ | Claude 原生 OTel |
| Log Events (13+ 项) | ✅ | ❌ | Claude 原生 OTel |
| Traces (span hierarchy) | ✅ (beta) | ❌ | Claude 原生 OTel |
| W3C TRACEPARENT 传播 | ✅ | ❌ | 子进程/子 agent 分布式追踪 |
| **StatusLine** | ✅ | ❌ | Claude 独有（context%/cost/rate limits/tokens） |
| **状态文件** | ✅ | ✅ | agent-status.json、proc-state.json 等（由 activity-monitor hook 生成） |
| **PM2** | ✅ | ✅ | runtime 无关，进程级监控 |
| **C4 / Scheduler** | ✅ | ✅ | runtime 无关，应用级数据 |

Codex hook 配置路径：`~/.codex/hooks.json` 或 `config.toml`，需开启 feature flag `codex_hooks=true`。

### 10.2 Unified Metrics Catalog

Dashboard 面向用户呈现统一指标。每个指标定义语义、单位、展示位置和 resolver chain，不暴露底层数据来源差异。

| 指标 | 语义 | 单位 | 展示位置 | Claude 支持 | Codex 支持 | Resolver chain（优先级递减） |
|------|------|------|---------|-------------|------------|--------------------------|
| **agent_state** | Agent 当前状态 | enum: idle/busy/thinking/error/stopped | 状态总览 | ✅ supported | ✅ supported | hook lifecycle → activity-monitor status file → PM2 process state |
| **current_tool** | 当前执行的工具 | string (tool name) | 状态总览 | ✅ supported | ✅ supported | hook PreToolUse/PostToolUse → status file active_tool_name |
| **tool_calls** | 工具调用事件流 | event stream | 工具分析 | ✅ supported | ✅ supported | telemetry span → hook Pre/Post → tool-events.jsonl fallback |
| **tool_failures** | 工具执行失败 | event stream | 工具分析 | ✅ supported | ✅ degraded | telemetry error span → Claude PostToolUseFailure → PostToolUse result inference → status fallback |
| **tool_duration** | 工具执行耗时 | ms | 工具分析 | ✅ supported | ✅ supported | telemetry tool span → Pre/Post 时间差计算 |
| **context_usage** | Context window 使用率 | % (0-100) | 状态总览 | ✅ supported | ❌ unsupported | telemetry → statusLine → context-monitor-state.json |
| **token_usage** | Token 消耗 | count (input/output/cache) | 成本分析 | ✅ supported | ❌ unsupported | telemetry metric → statusLine → cost-log.jsonl |
| **session_cost** | Session 成本 | USD | 成本分析 | ✅ supported | ❌ unsupported | telemetry metric → statusLine → cost-log.jsonl |
| **llm_latency** | LLM 请求延迟 | ms (P50/P95/P99) | 性能分析 | ✅ supported | ❌ unsupported | telemetry llm_request span |
| **session_lifecycle** | Session 启动/结束 | event | 状态总览 | ✅ supported | ✅ supported | Codex SessionStart hook / Claude 推断 → status file |
| **permission_requests** | 权限审批请求 | event stream | 安全/审计 | ❌ unsupported | ✅ supported | Codex PermissionRequest hook |
| **health** | 健康/心跳状态 | enum: healthy/degraded/error | 状态总览 | ✅ supported | ✅ supported | agent-status.json health + watchdog_phase |
| **pm2_services** | PM2 服务状态 | structured | 服务健康 | ✅ supported | ✅ supported | pm2 jlist（runtime 无关） |
| **messages** | 通信消息量 | count + event | 通信概览 | ✅ supported | ✅ supported | c4.db（runtime 无关） |
| **scheduled_tasks** | 计划任务状态 | structured | 任务监控 | ✅ supported | ✅ supported | scheduler.db（runtime 无关） |
| **cache_hit_rate** | Prompt cache 命中率 | % | 性能分析 | ✅ supported | ❌ unsupported | telemetry token metric (cacheRead/input) |

### 10.3 Source Resolver Rules

#### 10.3.1 两层状态模型

每个指标对每个 runtime 有两层状态：

- **capability**（静态）：该 runtime 理论上是否支持此指标。文档定义后不随运行时变化。
  - `supported` — 正式支持
  - `supported/beta` — 支持但 API 不稳定
  - `unsupported` — 不支持
  - `planned` — 计划中，尚未实现

- **availability**（动态）：当前实例该指标数据是否可用。由 resolver 实时判断。
  - `ok` — 数据正常
  - `degraded` — 使用了 fallback 来源，或数据部分缺失
  - `stale` — 数据存在但超过 freshness 阈值
  - `missing` — capability=supported 但数据未到达（如 collector 未开启）
  - `error` — 数据源报错

前端处理规则：
- `capability=unsupported` → 默认隐藏或灰态，不进入 resolver
- `capability=supported` + `availability=ok` → 正常展示
- `capability=supported` + `availability=degraded` → 黄灯 + 显示 fallback 来源
- `capability=supported` + `availability=stale` → 黄灯 + 显示最后更新时间
- `capability=supported` + `availability=missing` → 灰态 + "数据未收集"提示
- `capability=supported` + `availability=error` → 红灯 + 错误信息

#### 10.3.2 来源优先级

全局优先级：**telemetry > hook > 状态文件**

同一指标多个来源同时存在时，resolver 选最可信且最新的来源。高优来源不可用时自动 fallback 到低优来源。

#### 10.3.3 Freshness 规则

Freshness 按指标类型分别定义，不使用全局硬编码阈值：

| 指标类型 | 默认 freshness 规则 | 可 override |
|---------|-------------------|------------|
| **event-stream 类**（tool_calls, tool_failures） | hook/telemetry 超过 N 秒无事件不一定 degraded，除非另一个来源显示 agent 处于 active/busy 状态 | 每指标可自定义 N |
| **state 类**（agent_state, health） | 超过 2× expected heartbeat interval 未更新 → stale | heartbeat interval 可配置 |
| **cost/token 类**（session_cost, token_usage） | 交互结束后一段时间仍未更新 → degraded | 延迟窗口可配置 |
| **PM2/health 类**（pm2_services） | 轮询失败一次 → stale，连续失败 → degraded/error | 连续失败阈值可配置 |

#### 10.3.4 Resolver 输出格式

每个指标经��� resolver 后输出统一结构。动态层字段统一使用 `availability`（与 §10.3.1 定义一致），不使用 `status`：

```json
{
  "value": 42,
  "availability": "ok",
  "capability": "supported",
  "source": "hook",
  "preferredSource": "telemetry",
  "fallbackReason": null,
  "confidence": "high",
  "updatedAt": "2026-05-01T16:00:00Z"
}
```

降级示例：

```json
{
  "value": 85.2,
  "availability": "degraded",
  "capability": "supported",
  "source": "status_file",
  "preferredSource": "hook",
  "fallbackReason": "hook_stale",
  "confidence": "medium",
  "updatedAt": "2026-05-01T15:59:30Z"
}
```

不支持示例（`capability=unsupported` 是静态声明，不进入 resolver 流程，因此无动态 availability）：

```json
{
  "value": null,
  "availability": null,
  "capability": "unsupported",
  "source": null,
  "preferredSource": null,
  "fallbackReason": null,
  "confidence": null,
  "updatedAt": null
}
```

### 10.4 Runtime Adapter Contract

每个数据来源实现一个标准 adapter，输出统一 shape 供 resolver 消费。

#### Adapter 接口

```
interface MetricAdapter {
  // 返回此 adapter 能提供的指标列表及其 capability
  capabilities(runtime: "claude" | "codex"): Map<MetricName, Capability>

  // 获取指标当前值
  resolve(metric: MetricName, runtime: "claude" | "codex"): MetricResult

  // 获取指标历史（用于趋势图）
  history(metric: MetricName, runtime: "claude" | "codex", timeRange: TimeRange): MetricResult[]

  // 健康检查
  health(): AdapterHealth
}
```

#### Adapter 实现计划

| Adapter | 数据来源 | Phase | 覆盖指标 |
|---------|---------|-------|---------|
| **FileAdapter** | activity-monitor JSON/JSONL 文件 | Phase 1 | agent_state, current_tool, tool_calls, tool_duration, health, context_usage (Claude only) |
| **SQLiteAdapter** | c4.db, scheduler.db | Phase 1 | messages, scheduled_tasks |
| **PM2Adapter** | pm2 jlist | Phase 1 | pm2_services |
| **HookAdapter** | Hook 事件流（Claude + Codex 共用 Pre/Post/Stop/UserPromptSubmit；各自独有事件分别适配） | Phase 2 | tool_calls, tool_failures, agent_state, session_lifecycle, permission_requests (Codex) |
| **TelemetryAdapter** | OTel OTLP 接收端 | Phase 2 | token_usage, session_cost, llm_latency, cache_hit_rate, tool_calls (高精度) |
| **StatusLineAdapter** | statusline.json (Claude only) | Phase 1 | context_usage, token_usage, session_cost, cache_hit_rate |

#### Resolver 组装

Resolver 按指标��找所有 adapter 的 capability，按优先级排序，收集每个 adapter 的 resolve 结果，然后按以下 ranking 规则选出最终结果：

**Ranking 规则（优先级递减）：**

1. **最高优先级 adapter 且 availability=ok** → 直接选中（最优路径）
2. **任意 adapter availability=ok** → 选优先级最高的 ok 结果（跳过高优但 stale/degraded/missing 的来源）
3. **degraded 结果** → 仅在以下条件之一满足时选中：
   - 没有任何 adapter 返回 ok
   - 该指标声明 `degradedAcceptable: true`（即 degraded 数据仍有展示价值）
   - 选中时标记 fallbackReason
4. **stale 结果** → 不应压过更新鲜的低优来源。仅在没有任何 ok 或 degraded 结果时选中
5. **全部 missing/error** → 返回最高优先级 adapter 的 error/missing 状态

简言之：**freshness 优先于 source priority**。一个 fresh 的低优来源��过一个 stale 的高优来源。

```
resolve("tool_calls", "claude"):
  1. TelemetryAdapter  → missing (collector not running)
  2. HookAdapter       → ok, value=[...]
  3. FileAdapter       → ok, value=[...] (from JSONL)
  ranking: HookAdapter ok (优先级高于 FileAdapter ok)
  → 返回 HookAdapter 结果, availability="ok", source="hook",
    preferredSource="telemetry", fallbackReason="telemetry_missing"

resolve("context_usage", "claude"):
  1. TelemetryAdapter  → stale (last update 5min ago)
  2. StatusLineAdapter → ok, value=72.3 (updated 2s ago)
  ranking: StatusLineAdapter ok 优先于 TelemetryAdapter stale
  → 返回 StatusLineAdapter 结果, availability="ok", source="statusline",
    preferredSource="telemetry", fallbackReason="telemetry_stale"

resolve("tool_failures", "codex"):
  1. TelemetryAdapter  → capability=unsupported (Codex 无 OTel)，跳过
  2. HookAdapter       → degraded (从 PostToolUse result 推断，无专用事件)
  3. FileAdapter       → ok, value=[...]
  ranking: FileAdapter ok 优先于 HookAdapter degraded
  → 返��� FileAdapter 结果, availability="ok", source="status_file",
    preferredSource="hook", fallbackReason="hook_degraded"

resolve("permission_requests", "claude"):
  1. capabilities check → capability=unsupported for claude
  → 返回 unsupported, 不进入 resolve 流程
```

## 11. 开放问题

1. **OTel 数据量管理**：Claude Code OTel 输出可能非常详细，需要确定保留策略（保留多少天？采样率？）— Phase 2 spike 时验证
2. **多实例数据汇聚**：Phase 3 的多实例监控需要数据传输机制（push vs pull？通过 HXA？）
3. **Codex OTel 路线图**：Codex 目前不支持 OTel 遥测。如果未来 Codex 支持，TelemetryAdapter 应能无缝接入（adapter contract 已预留）
4. **Codex statusLine 替代方案**：Codex 无 statusLine。context usage / token cost 等指标在 Codex runtime 下目前标记为 unsupported，未来可能通过 Codex 自有 API 或状态文件获取

## 12. 里程碑

| Phase | 范围 | 预计工期 | 依赖 |
|-------|------|---------|------|
| Phase 1 MVP | 已有数据可视化（状态/成本/工具/通信/任务/PM2） | 1-2 周 | 无 |
| Phase 2 OTel | Claude Code 原生遥测集成 | 1-2 周 | 验证 OTel 环境变量安全性 |
| Phase 3 Multi | 多实例集中监控 | TBD | Phase 2 完成 + 多实例部署 |

---

*文档版本: v1.3*
*创建日期: 2026-05-01*
*最后更新: 2026-05-01（v1.3: 多 runtime 设计 — Howard 三条方向 + zylos01/Jinglever 共识。新增 Runtime Capability Matrix、Unified Metrics Catalog、Source Resolver Rules、Runtime Adapter Contract 四章。核心原则：统一 observability model，Claude/Codex 并集覆盖，capability/availability 两层状态，来源优先级 telemetry > hook > 状态文件）*
*作者: zylos01*
