# Zylos Dashboard — 总方案

## Executive Summary

Zylos Dashboard 是一个为 zylos agent 系统设计的可观测性与管理仪表盘。它将分散在多个文件、数据库和日志中的运行时数据汇聚到一个统一的 Web 界面中，让运维者（Howard）能够实时掌握 agent 的运行状态、资源消耗、任务执行和通信活动。

核心设计原则：**读取已有数据，不改变现有架构**。Dashboard 作为一个纯观测层，不修改 zylos 的核心运行逻辑，仅消费已有的数据源。

## 1. 问题定义

### 1.1 当前痛点

目前 zylos 运行时已积累了丰富的运行数据，但这些数据分散在多处，缺乏统一的可视化入口：

| 数据类型 | 当前位置 | 查看方式 |
|---------|---------|---------|
| Agent 状态（忙/闲/思考） | `activity-monitor/agent-status.json` | 手动 `cat` 文件 |
| Session 成本 | `activity-monitor/cost-log.jsonl` (576 条记录) | 手动查 JSONL |
| 工具调用事件 | `activity-monitor/tool-events.jsonl` (2651 条) | 手动查 JSONL |
| API 活动 | `activity-monitor/api-activity.json` | 手动查 JSON |
| Context 使用率 | `activity-monitor/context-monitor-state.json` | 手动查 JSON |
| 配额使用 | `activity-monitor/usage.json` | 手动查 JSON |
| 通信记录 | `comm-bridge/c4.db` (18138 条对话) | SQL 查询 |
| 计划任务 | `scheduler/scheduler.db` (12 active, 293 history) | CLI 命令 |
| PM2 服务状态 | PM2 运行时 | `pm2 status` 命令 |
| 内存使用 | `memory/` 目录 | 手动浏览 |

### 1.2 新机遇：Claude Code 原生 OTel

Claude Code 原生支持 OpenTelemetry 遥测输出（通过 `CLAUDE_CODE_ENABLE_TELEMETRY=1`），可以导出：

- **Metrics**：token 计数、成本、工具决策计数器
- **Log Events**：每个 prompt、API 请求、工具结果的结构化日志
- **Traces (beta)**：完整的分布式追踪，span 层级：
  ```
  claude_code.interaction（一轮对话）
  ├── claude_code.llm_request（API 调用）
  ├── claude_code.tool（工具执行）
  │   └── claude_code.hook（Hook 执行）
  └── claude_code.subagent（子 agent）
  ```

这意味着我们可以获得远比 activity-monitor Hook 更细粒度的运行时数据，包括 LLM 请求级别的延迟、token 消耗和工具调用链。

已有参考项目 `claude-code-telemetry`（GitHub lainra/claude-code-telemetry）演示了 Claude Code OTel → OTel Collector → Langfuse 的完整链路。

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
                       │ HTTP / WebSocket
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
| **数据读取** | better-sqlite3 (只读模式) + fs.watch | SQLite 只读连接保证安全；文件系统 watch 实现近实时更新 |
| **实时推送** | WebSocket (ws 库) | 向浏览器推送 agent 状态变化 |
| **OTel Collector** | @opentelemetry/sdk-node | 轻量 Node.js OTel Collector，接收 Claude Code 导出 |
| **数据存储** | SQLite (dashboard 自有) | 存储 OTel traces/metrics，不污染已有数据库 |
| **部署** | PM2 + Caddy route | 遵循 zylos 标准部署方式 |

### 3.3 数据源详解

#### A. 已有数据（零改动直接读取）

| 数据源 | 文件 | 更新频率 | 读取方式 |
|--------|------|---------|---------|
| Agent 状态 | `agent-status.json` | 实时 (~3s) | fs.watch + JSON parse |
| Claude 状态 | `claude-status.json` | 实时 | fs.watch |
| Session 成本 | `cost-log.jsonl` | session 结束时 | 启动全量 + tail 增量 |
| 工具事件 | `tool-events.jsonl` | 实时 | tail -f 流式读取 |
| API 活动 | `api-activity.json` | 实时 | fs.watch |
| Context 状态 | `context-monitor-state.json` | 定期 | fs.watch |
| 配额 | `usage.json` | 定期检查 | fs.watch |
| Hook 状态 | `hook-state.json` | 事件触发 | fs.watch |
| 通信记录 | `c4.db` | 消息到达时 | SQLite readonly |
| 任务调度 | `scheduler.db` | 任务执行时 | SQLite readonly |

#### B. 新增数据（OTel Pipeline）

启用 `CLAUDE_CODE_ENABLE_TELEMETRY=1` 后，Claude Code 通过 OTLP/gRPC 或 OTLP/HTTP 导出遥测数据。Dashboard 内嵌一个轻量 OTel Collector 接收端，将数据写入自有 SQLite 库。

环境变量配置：
```bash
# 在 .env 中添加
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  # Dashboard OTel 接收端口
```

OTel 数据模型：
- **Traces**: session → interaction → llm_request / tool / hook（带耗时、token 数、错误）
- **Metrics**: `claude_code.tokens.input`, `claude_code.tokens.output`, `claude_code.cost_usd`, `claude_code.tool.duration`

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
│   └── websocket.js              # WebSocket 实时推送
├── public/
│   ├── index.html                # 主页面
│   ├── css/
│   │   └── dashboard.css
│   └── js/
│       ├── app.js                # 主应用逻辑
│       ├── charts.js             # Chart.js 图表封装
│       └── websocket.js          # WS 客户端
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

- **只读数据库连接**：SQLite 使用 `?mode=ro` 参数，物理上无法写入
- **无外部网络依赖**：Dashboard 仅读取本地文件和数据库
- **Caddy 认证**：可选启用 HTTP Basic Auth 或集成现有认证
- **敏感信息脱敏**：通信消息内容在 API 层截断/脱敏
- **OTel 数据本地存储**：不发送到任何外部 SaaS

## 8. 与 COCO Dashboard 的关系

Zylos Dashboard 和 COCO Dashboard 是完全不同的产品：

| | Zylos Dashboard | COCO Dashboard |
|---|---|---|
| **目标用户** | Agent 运维者（开发团队） | COCO 平台客户（企业管理者） |
| **监控对象** | 单个 zylos agent 实例的运行时 | 企业的 AI 员工管理 |
| **数据来源** | 本地文件/DB/OTel | COCO 平台 API |
| **部署方式** | 每个 zylos 实例自带 | COCO 平台 SaaS |

但技术上有借鉴意义：zylos-dashboard 对 agent 运行时的可观测性探索，可以反哺 COCO Dashboard 的 AI Ops 模块设计。

## 9. 开放问题

1. **OTel 数据量管理**：Claude Code OTel 输出可能非常详细，需要确定保留策略（保留多少天？采样率？）
2. **多实例数据汇聚**：Phase 3 的多实例监控需要数据传输机制（push vs pull？通过 HXA？）
3. **Dashboard 自身的资源消耗**：需确保 Dashboard 不会成为额外的性能负担
4. **前端框架选择**：MVP 用纯 HTML/JS 快速启动，后续是否迁移到 React/Vue？
5. **验证方法**：启用 OTel 环境变量是否会影响 Claude Code/zylos 的正常运行？需要安全验证

## 10. 里程碑

| Phase | 范围 | 预计工期 | 依赖 |
|-------|------|---------|------|
| Phase 1 MVP | 已有数据可视化（状态/成本/工具/通信/任务/PM2） | 1-2 周 | 无 |
| Phase 2 OTel | Claude Code 原生遥测集成 | 1-2 周 | 验证 OTel 环境变量安全性 |
| Phase 3 Multi | 多实例集中监控 | TBD | Phase 2 完成 + 多实例部署 |

---

*文档版本: v1.0*
*创建日期: 2026-05-01*
*作者: zylos01*
