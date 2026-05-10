# Zylos Dashboard Phase 2 — 产品设计方案

## 1. 业务目标

### 1.1 问题

客户无法感知自己的 Zylos 正在做什么、是否活着、是否卡住。这种不透明会引发焦虑，导致客户频繁联系客服，增加客服团队压力。

### 1.2 北极星指标

**减少 owner 因状态不可见而发起的客服咨询。**

### 1.3 产品目标

1. Owner 打开 Dashboard 后 **10 秒内** 看懂当前状态
2. Active / Idle / Waiting / Stuck / Error 五类核心状态 **明确区分**，不模糊
3. 每个异常状态都有 **可解释的原因** 和建议动作
4. 工作历史页能回答 **"它今天到底做了什么"**

### 1.4 不是什么

Dashboard 不是运维后台，不是 telemetry 技术面板。它是 **owner 的 Zylos activity cockpit**——用 owner 能理解的语言呈现 zylos 的状态和产出。

---

## 2. 产品原则

| # | 原则 | 说明 |
|---|------|------|
| P1 | **全新组件** | 不依赖 Activity Monitor 状态文件。Dashboard 自建观测数据面，直接从一手数据源采集。AM 的 agent-status.json、proc-state.json 等文件不作为产品数据源。 |
| P2 | **数据→状态映射必须可论证** | 每个展示给 owner 的状态，背后的信号→状态映射关系必须有明确证据。弱信号不能包装成强语义。不确定的映射标注出来，带给 Howard 论证。 |
| P3 | **不展示原始 payload** | 默认不展示、不持久化 prompt 原文、工具输出、敏感路径和账号信息。只展示分类、摘要、计数、耗时、状态。Debug capture 是独立的诊断模式，owner 显式开启，短 TTL。 |
| P4 | **Runtime 并集覆盖** | 同时支持 Claude Code 和 Codex CLI。指标集取并集，不支持的标 unsupported，不假补数据。每个指标标注 actual / estimated / missing。 |
| P5 | **可落地** | 每个功能都有明确的数据来源、采集方式、展示形态。不画饼。 |
| P6 | **多 session 就绪** | 所有事件和指标携带 runtime_type + session_id，为未来多 session 并行做好数据模型准备。 |

---

## 3. Owner View 信息架构

Overview 是唯一入口页，回答 owner 的四个焦虑问题：

1. **它活着吗？**
2. **它在干什么？**
3. **它卡住了吗？**
4. **它最近做了什么？**

### 3.1 Overview 页面布局

```
┌─────────────────────────────────────────────────────────────────┐
│  ① Live Runtime State                                          │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │  状态指示灯   │  │ 当前活动描述                              │ │
│  │  ACTIVE ●    │  │ "正在读取 zylos-core 仓库文件 (12s)"      │ │
│  └──────────────┘  └──────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  ② Capacity & Cost                │  ③ Health & System          │
│  ┌─────────────────────────┐      │  ┌────────────────────────┐ │
│  │ Context: 45% ████░░░░░  │      │  │ PM2: 6/6 running       │ │
│  │ Rate 5h: 72% ████████░  │      │  │ CPU: 23%  Mem: 4.2GB   │ │
│  │ Rate 7d: 31% ███░░░░░░  │      │  │ Disk: 58% (42GB free)  │ │
│  │ Today: $2.14 (actual)   │      │  │ C4: active (3s ago)  │ │
│  │ Cache: 67% hit rate     │      │  │ OTel: receiving (8s)    │ │
│  └─────────────────────────┘      │  └────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  ④ Current Work Timeline (最近 30 分钟)                         │
│  14:02 ● Read zylos-core/cli/lib/self-upgrade.js (0.3s)        │
│  14:01 ● Bash: npm test (12.4s)                                │
│  14:00 ● Edit zylos-core/cli/lib/startup.js (0.1s)             │
│  13:58 ● Reply: Telegram howard (C4)                           │
│  13:55 ● WebSearch: "PM2 env parsing" (3.2s)                   │
├─────────────────────────────────────────────────────────────────┤
│  ⑤ Work History (今日摘要)         │  ⑥ Communication            │
│  ┌─────────────────────────┐      │  ┌────────────────────────┐ │
│  │ 128 messages processed  │      │  │ TG: 12 in / 8 out      │ │
│  │ 3 scheduler tasks       │      │  │ Lark: 3 in / 2 out     │ │
│  │ 45 tool calls           │      │  │ HXA: 24 in / 18 out    │ │
│  │ 2.3h active time        │      │  │ Avg response: 14s      │ │
│  │ Top project: zylos-core │      │  │ Pending: 0             │ │
│  └─────────────────────────┘      │  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 六个区块定义

#### ① Live Runtime State

**回答**：它活着吗？在干什么？卡住了吗？

| 展示内容 | 数据来源 | 更新频率 |
|---------|---------|---------|
| Agent 状态（见 §4 Semantic State Contract） | Hook + Heartbeat + PM2 组合判定 | 实时（事件驱动） |
| 当前工具名称 + 已运行时长（实时 ticking） | PreToolUse 的 started_at 时间戳，前端 setInterval 每秒更新计时显示（如 12s → 13s → 14s），PostToolUse 到达后停止计时。**支持多条并发**：主 agent 与 subagent 可同时执行工具，每个 PreToolUse 有独立 tool_use_id，同时追踪多个 running tool。UI 默认显示最新一条，下方标注「+N 个工具运行中」，点击展开完整列表；空间有限时可滚动或轮播切换 | 实时（前端本地计时） |
| 当前活动的自然语言描述 | 后处理：工具名→动作描述映射 | 实时 |
| 最后事件时间 | 任何 Hook/OTel 事件的 timestamp | 实时 |

#### ② Capacity & Cost

**回答**：额度够吗？花了多少钱？

| 展示内容 | 数据来源 | 置信度 |
|---------|---------|--------|
| Context window 使用率 (%) | Claude: StatusLine `context_window.used_percentage`; Codex: rollout JSONL `context_window` | Claude: actual; Codex: actual |
| Rate limit 5h/7d 剩余 | Claude: StatusLine `rate_limits`; Codex: rollout JSONL `rate_limits` | Claude: actual; Codex: actual |
| 今日累计费用 (USD) | Claude: OTel `cost.usage` metric 累加 或 StatusLine `cost.total_cost_usd`; Codex: OTel `sse_event` token counts × 价格表 | Claude: actual; Codex: estimated |
| Cache hit ratio (%) | Claude: OTel `token.usage` cacheRead/(cacheRead+input); Codex: OTel `sse_event` cached/(cached+input) | actual |
| Token 消耗 (input/output) | Claude: OTel `token.usage`; Codex: OTel `sse_event` | actual |

**Codex cost 标注**：Codex OTel 提供 token 计数但不直接提供 USD cost。Dashboard 用模型价格表换算，前端标注 `estimated`。如果价格表过期或模型不在表中，标注 `missing`。

#### ③ Health & System

**回答**：系统资源正常吗？服务都在跑吗？

| 展示内容 | 数据来源 | 论证 |
|---------|---------|------|
| CPU 使用率 (%) | Node.js `os.cpus()` 采样 | 直接系统调用，可靠 |
| 内存使用率 (used/total) | Node.js `os.totalmem()` / `os.freemem()` | 直接系统调用，可靠 |
| 磁盘使用率 (%) | `df` 或 `statvfs` | 直接系统调用，可靠 |
| PM2 服务状态 | `pm2 jlist` JSON 解析 | PM2 权威数据，可靠。字段：name, status, restart_time, pm2_env.pm_uptime, monit.memory, monit.cpu |
| C4 连通性 | c4.db 最近 outbound message 时间 | 间接指标：最近成功发送消息说明 C4 通道正常。局限：如果长时间无消息，不能判定为异常 |
| OTel 采集状态 | metric_points 表最近写入时间 | 间接指标：有新数据说明 pipeline 正常 |
| Hook 采集状态 | runtime_events 表最近写入时间 | 同上 |

#### ④ Current Work Timeline

**回答**：它现在在忙什么？最近几分钟做了什么？

展示最近 30 分钟的工具调用和关键事件，按时间倒序排列。

| 事件类型 | 展示格式 | 数据来源 |
|---------|---------|---------|
| 工具调用 | `{time} ● {tool_category}: {summary} ({duration})` | PostToolUse hook |
| 消息回复 | `{time} ● Reply: {channel} {recipient}` | C4 outbound message |
| 权限请求 | `{time} ⚠ Permission: {tool_name} — {status}` | PermissionRequest hook |
| Subagent | `{time} ● Subagent: {description} ({duration})` | SubagentStart/Stop hook |
| Compact | `{time} ● Context compacted: {pre}→{post} tokens` | PostCompact hook / OTel compaction log |
| Session 事件 | `{time} ● Session {start\|end\|restart}` | SessionStart/SessionEnd hook |

**工具名→自然语言映射**（示例）：

| tool_name | 展示 |
|-----------|------|
| Read | 读取 {file_path 最后两段} |
| Edit | 编辑 {file_path 最后两段} |
| Bash | 执行命令 ({command 前 30 字符}) |
| WebSearch | 搜索 "{query 前 30 字符}" |
| Agent | 启动子代理 |

**脱敏规则**：file_path 只取最后两段（如 `cli/lib/startup.js`）；Bash command 截断 30 字符，隐藏参数中的路径和 token；不展示工具输出内容。

#### ⑤ Work History & Trends

**回答**：它今天/本周做了什么？使用趋势如何？

**今日摘要卡片**（从 activity_facts 表聚合）：

| 指标 | 计算方式 | 数据来源 |
|------|---------|---------|
| 活跃时长 | 工具调用时长（PostToolUse duration_ms 累加）+ active turn 时长（UserPromptSubmit 到 Stop 的间隔减去 idle gap）。不能用 SessionStart→SessionEnd，那包含了 idle 等待时间 | Hook events |
| 工具调用总数 | count(PostToolUse) | Hook events |

> **D6（Howard, 2026-05-10）：PR 数据暂不采集**。用户的 Git 平台不确定（GitHub/GitLab/Gitea/私有部署），做通用方案成本过高。第一版 Work History 只展示能从 Hook/OTel 直接算出的指标（tool calls、active time、top project）。PR 相关指标后续有需求再考虑。

| 消息处理数 | C4 inbound + outbound count | c4.db |
| Top 项目 | 从工具调用的 file_path 提取 repo/project，按频次排序 | Hook events + projects.md 映射 |
| Scheduler 任务 | 完成/失败/跳过 | scheduler.db |

**趋势图**（从 metric_points 表聚合）：

| 图表 | X 轴 | Y 轴 | 粒度 |
|------|------|------|------|
| 日活跃时长 | 日期 | 小时 | 日 |
| 日工具调用数 | 日期 | 次数 | 日 |
| 日 Token 消耗 | 日期 | token count (input/output/cache) | 日 |
| 日费用 | 日期 | USD | 日 |
| 消息量 | 日期 | count (per channel) | 日 |

#### ⑥ Communication

**回答**：消息处理链路是否健康？有没有需要 owner 关注的积压？

**设计原则**：不做消息级"是否回复"判定（无法配对：合并回复、SKIP、群消息本不需要回复）。只从系统状态出发，按信号强度分层。

**① Intake Health（接收健康）**

| 指标 | 计算方式 | 数据来源 | 论证 |
|------|---------|---------|------|
| 各渠道最近 inbound 时间 | 每个 channel 最后一条 inbound 的 timestamp | c4.db messages 表 | 直接查询，可靠 |
| Receive/Dispatcher 错误 | status = 'error' 或有 retry 的 inbound | c4.db messages 表 | 直接查询，可靠 |

**② Processing Health（处理健康）**

| 指标 | 计算方式 | 数据来源 | 论证 |
|------|---------|---------|------|
| Pending queue 深度 | count(status IN ('pending', 'delivered', 'running')) | c4.db messages 表 | 直接查询，可靠 |
| 最老未完成项 age | NOW - MIN(timestamp) WHERE status IN ('pending', 'running') | c4.db messages 表 | 直接查询，可靠。超过 5min 标 warning |
| Queue stuck 项 | count WHERE age > threshold (普通消息 5min, control 30s) | c4.db messages 表 | 直接查询，可靠 |

**③ Response Activity（回复活跃度）**

| 指标 | 计算方式 | 数据来源 | 论证 |
|------|---------|---------|------|
| 各渠道消息量 (in/out) | count group by channel, direction | c4.db messages 表 | 直接查询，可靠 |
| 最近 outbound 时间 | MAX(timestamp) WHERE direction='outbound' per channel | c4.db messages 表 | 直接查询，可靠 |
| Response density | outbound_count / actionable_inbound_count (15min/1h 窗口) | c4.db messages 表 | 统计比例，标注 inferred。不是配对率 |
| Conversation-window latency (趋势) | 按 endpoint/thread 把 inbound burst 合并（2min 静默切段），找窗口后第一个 outbound 的时间差 | c4.db messages 表 | inferred，只用于趋势图，不用于告警 |

**④ Attention Required（需要 owner 关注）**

| 指标 | 触发条件 | 论证 |
|------|---------|------|
| Send failed | C4 outbound status='failed' 且 retry exhausted | 强证据：系统确认发送失败 |
| Queue stuck | 最老 pending 项超过阈值 | 强证据：系统内部处理卡住 |
| Channel down | 某渠道 connector 超过 5min 无心跳 | 强证据：渠道级断连 |
| Waiting owner | WAITING_HUMAN 状态（来自 §4 状态机） | 强证据：agent 明确等待确认 |

**决策 [D1] — 已确认**：
- 取消"未回复消息数"指标，改为上述 4 类
- Conversation-window 聚合窗口：2 分钟
- Queue stuck 阈值：普通消息 5 分钟、control/heartbeat 30 秒

---

## 4. Semantic State Contract

这是本方案最核心的部分。每个展示给 owner 的状态必须有明确的证据条件和判定逻辑。

### 4.1 Agent 状态机

```
                    ┌─────────┐
         ┌─────────│ OFFLINE │◄──── PM2 not running / runtime down
         │         └─────────┘
         │              ▲
         │              │ runtime exit / PM2 stop
         ▼              │
    ┌─────────┐    ┌─────────┐    ┌─────────────────┐
    │  IDLE   │◄──►│ ACTIVE  │───►│ WAITING_HUMAN   │
    └─────────┘    └─────────┘    └─────────────────┘
         ▲              │
         │              ▼
         │         ┌─────────────┐
         │         │POSSIBLY_STUCK│
         │         └──────┬──────┘
         │                ▼
         │         ┌─────────┐
         └─────────│  STUCK  │
                   └─────────┘

    独立维度：UNKNOWN（数据源中断，无法判定）
```

### 4.2 状态定义与证据

每个状态包含完整 contract：Positive Evidence（进入条件）、Counter Evidence（反证/不应进入的情况）、Clear Condition（退出条件）、Runtime Differences（Claude vs Codex 差异）、Freshness Requirement（数据新鲜度要求）、Confidence Downgrade（降级条件）。

#### 两类信号的区分

状态判定依赖两类本质不同的信号，不可混淆：

| 信号类型 | 定义 | 来源 | 用途 |
|---------|------|------|------|
| **Runtime Progress** | 来自 Agent 的运行时事件，表示 agent 有实际活动 | Hook 事件（PreToolUse、PostToolUse、Stop 等）、OTel runtime spans/logs（interaction、llm_request、api_request） | 判断 agent 是否在工作、是否有进展 |
| **Collector Liveness** | Dashboard 自身采集管线的健康信号，表示"我们的观测能力正常" | PM2 Reader 的 `pm2 jlist` 成功执行、System Sampler 成功采样、hook-ingest.js 进程存活、OTel Reader 进程存活 | 证明"没收到 runtime event"是因为 agent 真的没动静，而非采集管线断了 |

**关键原则**：只有 Collector Liveness 证明管线正常时，Runtime Progress 的"缺失"才是有意义的证据。如果管线本身不健康，runtime event 的缺失不能作为任何判定依据——应为 UNKNOWN。

#### ACTIVE — 正在工作

| 项 | 内容 |
|---|------|
| **含义** | Agent 正在执行工具、调用 API、或生成回复 |
| **Positive Evidence（满足任一）** | (1) 有**未结束**的工具调用：收到 PreToolUse 但未收到对应的 PostToolUse/PostToolUseFailure; (2) 收到 UserPromptSubmit 后未收到 Stop（表示正在处理 prompt）; (3) OTel 中有**未关闭**的 `interaction` 或 `llm_request` span |
| **Counter Evidence（不应判 ACTIVE）** | (1) 仅收到结束型事件（Stop、PostToolUse、SessionEnd、PostCompact）— 这些表示"刚完成"而非"正在工作"; (2) 最后事件是 Stop 且无后续 UserPromptSubmit — 表示 turn 已结束; (3) PM2 进程不在线 |
| **Clear Condition** | 收到 Stop hook（turn 结束）或 PostToolUse/PostToolUseFailure（工具结束）且无新的 PreToolUse/UserPromptSubmit |
| **Runtime Differences** | Claude: 可用 SubagentStart（无 SubagentStop）作为 active 信号; Codex: 无 SubagentStart/Stop，仅依赖 PreToolUse/PostToolUse + UserPromptSubmit/Stop |
| **Freshness Requirement** | 证据事件必须在最近 300s 内。超过 300s 无新事件但工具仍"未结束"，可能是 hook 丢失，降级为 UNKNOWN |
| **Confidence Downgrade** | 仅有 UserPromptSubmit 无后续工具调用（可能在思考/生成）→ 降为 MEDIUM，因为无中间事件可验证模型仍在运行 |
| **判定逻辑** | `pm2_online AND (has_running_tool OR has_open_turn) AND evidence_age < 300s` |
| **置信度** | HIGH（有运行中工具）/ MEDIUM（仅有 open turn 无工具） |
| **已验证** | PM2 jlist 可靠获取进程状态 ✅; PreToolUse/PostToolUse 配对在无头模式下正常 ✅; UserPromptSubmit/Stop 配对验证 ✅ (spike #17) |
| **Owner 看到** | 绿色指示灯 + "正在工作" + 当前工具描述（有运行中工具时）或 "正在思考" （open turn 无工具时） |

#### IDLE — 空闲等待

| 项 | 内容 |
|---|------|
| **含义** | Agent 在线但没有活动任务，等待新消息 |
| **Positive Evidence（全部满足）** | (1) PM2 runtime 进程 status=online; (2) 最后一个事件是结束型（Stop / PostToolUse / SessionStart 无后续 UserPromptSubmit）; (3) 无 pending PermissionRequest; (4) 无未结束的 PreToolUse |
| **Counter Evidence** | (1) 有未结束的 PreToolUse → 应为 ACTIVE; (2) 有 pending PermissionRequest → 应为 WAITING_HUMAN; (3) 采集管线中断（source_health 有 stale 源）→ 考虑 UNKNOWN |
| **Clear Condition** | 收到 UserPromptSubmit 或 PreToolUse → 转为 ACTIVE |
| **Runtime Differences** | 无显著差异，两个 runtime 的 Stop hook 语义一致 |
| **Freshness Requirement** | PM2 状态需在最近 30s 内采样。Hook 事件本身可以是旧的（idle 时本来就没有新事件），但 PM2 采样必须新鲜 |
| **Confidence Downgrade** | 如果最后事件距今 < 120s 且是 Stop，降为 MEDIUM — 可能只是 turn 间隙，agent 即将开始下一个任务。超过 120s 无新事件提升为 HIGH |
| **判定逻辑** | `pm2_online AND last_event_is_terminal AND no_running_tool AND no_pending_permission AND pm2_sample_fresh` |
| **置信度** | MEDIUM（< 120s since last Stop）/ HIGH（>= 120s since last terminal event） |
| **待验证 [V1]** | 120s 阈值是否合适？需要统计正常工作时 Stop 到下一个 UserPromptSubmit 的间隔分布。建议部署后收集数据验证 |
| **Owner 看到** | 灰色指示灯 + "空闲" + 最后活动时间 |

#### WAITING_HUMAN — 等待人工介入

| 项 | 内容 |
|---|------|
| **含义** | Agent 等待 owner 操作才能继续（权限确认等） |
| **Positive Evidence** | 收到 PermissionRequest hook 事件 |
| **Counter Evidence** | (1) 收到 PermissionRequest 后紧接着收到 PostToolUse（说明权限已被处理，用户可能已经在终端确认）; (2) 收到 Stop（turn 结束，权限请求可能被跳过/拒绝） |
| **Clear Condition — Claude Code** | 收到与该权限请求匹配的 PostToolUse（匹配条件：同 session_id + tool_name 匹配 + 时序在 PermissionRequest 之后）或 PostToolUseFailure，或 PermissionDenied hook，或 Stop |
| **Clear Condition — Codex** | Codex PermissionRequest payload 没有 `tool_use_id`，无法精确匹配。清除条件：收到**任何** PostToolUse（同 session_id，时序在 PermissionRequest 之后）或 Stop。局限：如果 PostToolUse 是另一个工具的结果，可能误清除。因此 Codex 下 WAITING_HUMAN 的 confidence 始终不超过 MEDIUM |
| **Runtime Differences** | Claude: PermissionRequest payload 含 tool_name + tool_input + permission_mode，可精确描述等待什么；清除逻辑可靠（HIGH）。Codex: payload 含 tool_name + tool_input（无 tool_use_id），清除逻辑是近似的（MEDIUM） |
| **Freshness Requirement** | PermissionRequest 事件本身必须在最近 600s 内。超过 600s 未清除的 pending permission，降级为 UNKNOWN（可能是 hook 丢失了清除事件） |
| **Confidence Downgrade** | Codex: 始终 MEDIUM（无精确匹配）。Claude: 默认 HIGH；如果 PermissionRequest 超过 300s 未清除降为 MEDIUM（异常长等待） |
| **判定逻辑** | `has_uncleared_permission_request AND permission_age < 600s` |
| **置信度** | Claude: HIGH（< 300s）/ MEDIUM（300-600s）; Codex: MEDIUM |
| **已验证** | PermissionRequest hook 在 Claude Code ✅ 和 Codex ✅ 均可触发 (PR #19 验证)。Codex 缺少 tool_use_id 已确认 ✅ |
| **Owner 看到** | 黄色指示灯 + "等待确认" + 具体等待什么（如 "等待 Bash 工具权限确认"） |

#### POSSIBLY_STUCK — 可能卡住

| 项 | 内容 |
|---|------|
| **含义** | Agent 可能遇到问题，但尚不确定 |
| **Positive Evidence（满足任一场景）** | **场景 A — 工具卡住**：有未结束的工具调用，持续时间超过该工具类型 P95 阈值 × 2，且期间无新的 runtime progress event。**场景 B — 模型卡住**：收到 UserPromptSubmit 后超过 120s 无 PreToolUse 或 Stop（可能模型在生成极长回复或 API 挂起）。**场景 C — 主循环无进展**：PM2 online + turn 未结束（无 Stop），但最后的 runtime progress event（PreToolUse/UserPromptSubmit/PostToolUse）距今超过 300s |
| **Counter Evidence** | (1) 收到任何新的 runtime progress event → 有进展，不卡; (2) 场景 B 中如果 OTel 有活跃的 `llm_request` span，说明模型确实在运行（只是慢），降低 stuck 可能性; (3) 工具是已知长时间工具（如 Agent subagent、大型 npm install）且未超过该工具的硬上限 |
| **Clear Condition** | 收到任何新 runtime progress event（PostToolUse、Stop、PreToolUse 等） |
| **Runtime Differences** | Claude: 场景 B 可通过 OTel `llm_request` span 区分"模型在运行"和"API 挂起"。Codex: OTel 有 `codex.api_request` 日志和 `codex.websocket_request` 日志，可检测 websocket 超时（success=false + duration > threshold） |
| **Freshness Requirement** | **Collector Liveness 必须 fresh**：PM2 Reader 采样 < 30s、System Sampler 采样 < 30s。如果 collector liveness 不 fresh，应判 UNKNOWN 而非 POSSIBLY_STUCK。Runtime progress 的"无事件"本身就是 POSSIBLY_STUCK 的正向证据，不要求 fresh |
| **Confidence Downgrade** | 默认 MEDIUM。如果有活跃 OTel span 证明模型/API 仍在通信 → 降为 LOW（可能只是慢，不是卡）。如果 collector liveness 部分 degraded → 标注 "部分采集管线不健康，判断可能不准确" |
| **工具 P95 阈值初始值** | Bash: 120s, Read: 5s, Edit: 5s, Write: 5s, WebSearch: 30s, WebFetch: 30s, Agent: 300s。**待验证 [V2]**：需从实际 PostToolUse duration_ms 数据统计确认 |
| **判定逻辑** | `pm2_online AND collector_liveness_fresh AND (scenario_a OR scenario_b OR scenario_c) AND no_counter_evidence` |
| **置信度** | MEDIUM（默认）/ LOW（有活跃 OTel span 或已知长时间工具） |
| **Owner 看到** | 橙色指示灯 + "可能卡住" + 原因（如 "Bash 已运行 5 分钟，超过正常时长"、"收到消息后 2 分钟无响应"） |

#### STUCK — 已卡住

| 项 | 内容 |
|---|------|
| **含义** | Agent 大概率遇到了问题，需要人工关注 |
| **Positive Evidence（全部满足）** | (1) 已处于 POSSIBLY_STUCK 状态超过 300s; (2) 期间无任何新 **runtime progress event**（Hook runtime events + OTel runtime spans/logs）; (3) PM2 进程仍 online（如果已 crash 则是 OFFLINE 不是 STUCK）; (4) **Collector Liveness 全部 fresh**——PM2 Reader 采样 < 30s、System Sampler 采样 < 30s、hook-ingest.js 进程存活（PM2 check）、OTel Reader 进程存活。这证明"没有 runtime event"是因为 agent 真的没动静，而非采集管线断了 |
| **Counter Evidence** | (1) 收到任何新 runtime progress event → 立即清除 STUCK; (2) 任何 collector liveness 变 stale → 管线断了，不能确认 stuck，应降级为 UNKNOWN; (3) PM2 进程 crash → 应转为 OFFLINE |
| **Clear Condition** | 收到任何新 runtime progress event，或 PM2 进程状态变化 |
| **Runtime Differences** | 无显著差异。两个 runtime 的 STUCK 判定逻辑相同 |
| **Freshness Requirement** | **Collector Liveness**（非 runtime progress）必须全部 fresh：PM2 Reader < 30s、System Sampler < 30s、hook handler process alive、OTel reader process alive。如果无独立的 collector liveness 信号（例如 hook handler 和 OTel reader 没有 heartbeat），则不能判 STUCK，只能 UNKNOWN。Runtime progress 的"无事件"本身是正向证据，不要求 fresh——这正是 STUCK 要检测的状态 |
| **Confidence Downgrade** | 默认 MEDIUM（不使用 HIGH，因为"无 runtime event"是 absence of evidence，不是 evidence of absence。可能有 hook 丢失、OTel 发送延迟等原因）。仅当满足额外条件时提升为 HIGH：POSSIBLY_STUCK 超过 600s + PM2 进程 CPU 为 0% + 所有 collector liveness fresh |
| **判定逻辑** | `was_possibly_stuck_for >= 300s AND no_runtime_progress_event AND pm2_online AND collector_liveness_all_fresh` |
| **置信度** | MEDIUM（默认）/ HIGH（600s + CPU=0 + all collector liveness fresh） |
| **Owner 看到** | 红色指示灯 + "已卡住" + 原因 + 建议动作（如 "Bash 已运行 10 分钟无响应，建议检查终端"） |
| **决策 [D3] — 已确认** | 第一版只读，不提供操作按钮。后续版本按场景加操作（ESC 恢复 / 杀 session / 其他），先通过只读版积累 stuck 场景→action 映射数据 |

#### OFFLINE — 离线

| 项 | 内容 |
|---|------|
| **含义** | Agent 进程未运行 |
| **Positive Evidence** | PM2 runtime 进程 status ≠ online（stopped / errored / 不存在） |
| **Counter Evidence** | 无 — PM2 状态是权威来源 |
| **Clear Condition** | PM2 进程恢复为 online |
| **Runtime Differences** | Claude: PM2 进程名通常为 `claude-code` 或自定义名。Codex: PM2 进程名通常为 `codex`。Dashboard 需配置当前 runtime 的 PM2 进程名 |
| **Freshness Requirement** | PM2 jlist 采样必须在 30s 内 |
| **Confidence Downgrade** | PM2 jlist 调用失败 → UNKNOWN（非 OFFLINE） |
| **判定逻辑** | `pm2_status != 'online'` |
| **置信度** | HIGH |
| **Owner 看到** | 灰色/红色指示灯 + "离线" + PM2 状态详情（如 "进程 errored，已重启 3 次"） |

#### UNKNOWN — 无法判定

| 项 | 内容 |
|---|------|
| **含义** | 数据源中断或矛盾，无法确定 agent 状态 |
| **Positive Evidence（满足任一）** | (1) PM2 jlist 调用失败; (2) PM2 online 但 collector liveness 全部 stale（采集管线断了，无法判定 active/idle/stuck）; (3) ACTIVE 的运行中工具证据超过 300s 无更新（可能 hook 丢失）; (4) WAITING_HUMAN 的 pending permission 超过 600s 无清除; (5) 无独立 collector liveness 信号时尝试判定 STUCK（管线不可验证，应为 UNKNOWN） |
| **Counter Evidence** | 收到任何新的 runtime progress event 或 collector liveness 恢复 → 重新评估为其他状态 |
| **Clear Condition** | Collector liveness 恢复 fresh，或 PM2 jlist 恢复正常 |
| **Runtime Differences** | 无差异 |
| **Freshness Requirement** | N/A（UNKNOWN 本身就是对 freshness 不足的表达） |
| **Confidence Downgrade** | N/A |
| **判定逻辑** | `pm2_unavailable OR (pm2_online AND all_sources_stale) OR evidence_too_old` |
| **置信度** | N/A — 承认不知道比错误判定更可靠 |
| **Owner 看到** | 灰色问号 + "状态不确定" + 原因（如 "遥测数据中断 5 分钟，无法确认当前状态"） |

### 4.3 状态判定引擎伪代码

```javascript
function deriveAgentState(signals) {
  // 两类信号，不可混淆：
  // - collectorLivenessFresh: Dashboard 采集管线是否正常（PM2 reader、system sampler、hook handler、OTel reader）
  // - lastProgressAge: 最后一次 runtime progress event（Hook/OTel 运行时事件）距今多久
  const { pm2Status, pm2SampleAge, pm2Cpu,
          runningTool, openTurn, pendingPermission,
          lastProgressAge, lastProgressType,
          collectorLivenessFresh, collectorLivenessAvailable,
          activeOtelSpan, possiblyStuckSince, runtime } = signals;

  // 1. PM2 不可用 → UNKNOWN
  if (pm2Status === null || pm2SampleAge > 30) {
    return { state: 'UNKNOWN', confidence: 'N/A', reason: 'PM2 data unavailable' };
  }

  // 2. 进程不在线 → OFFLINE
  if (pm2Status !== 'online') {
    return { state: 'OFFLINE', confidence: 'HIGH', reason: `PM2 status: ${pm2Status}` };
  }

  // 3. 等待权限（已验证的 pending permission）
  if (pendingPermission && pendingPermission.age < 600) {
    const confidence = runtime === 'codex' ? 'MEDIUM'
                     : pendingPermission.age < 300 ? 'HIGH' : 'MEDIUM';
    return { state: 'WAITING_HUMAN', confidence,
             reason: `Awaiting: ${pendingPermission.tool_name}` };
  }
  if (pendingPermission && pendingPermission.age >= 600) {
    return { state: 'UNKNOWN', confidence: 'N/A',
             reason: 'Permission request stale (>10min), may have missed clear event' };
  }

  // 4. Collector liveness 不可用 → 无法判定 stuck，先检查
  //    如果管线断了且无近期 progress → UNKNOWN
  if (!collectorLivenessFresh && lastProgressAge > 300) {
    return { state: 'UNKNOWN', confidence: 'N/A',
             reason: 'Collector liveness unhealthy, unable to determine state' };
  }

  // 5. 检查 STUCK / POSSIBLY_STUCK（需要 collector liveness fresh）
  const stuckScenario = detectStuckScenario(signals);
  if (stuckScenario) {
    // STUCK 必须有 collector liveness，否则只能 UNKNOWN
    if (!collectorLivenessFresh || !collectorLivenessAvailable) {
      return { state: 'UNKNOWN', confidence: 'N/A',
               reason: `${stuckScenario.reason}, but collector liveness unavailable — cannot confirm stuck` };
    }
    if (possiblyStuckSince && Date.now() - possiblyStuckSince > 300_000) {
      const confidence = (Date.now() - possiblyStuckSince > 600_000
                          && pm2Cpu === 0 && collectorLivenessFresh) ? 'HIGH' : 'MEDIUM';
      return { state: 'STUCK', confidence, reason: stuckScenario.reason };
    }
    const confidence = activeOtelSpan ? 'LOW' : 'MEDIUM';
    return { state: 'POSSIBLY_STUCK', confidence, reason: stuckScenario.reason };
  }

  // 6. 有运行中的工具或 open turn → ACTIVE（检查证据新鲜度）
  if (runningTool) {
    if (runningTool.evidenceAge > 300) {
      // 工具 "运行中" 的证据太旧，可能 PostToolUse hook 丢失
      return { state: 'UNKNOWN', confidence: 'N/A',
               reason: 'Running tool evidence stale, hook may have been lost' };
    }
    return { state: 'ACTIVE', confidence: 'HIGH',
             reason: `Running: ${runningTool.name} (${fmt(runningTool.duration)})` };
  }
  if (openTurn) {
    return { state: 'ACTIVE', confidence: 'MEDIUM',
             reason: 'Processing prompt (no tool call yet)' };
  }

  // 7. 最后事件是结束型，无 pending 状态 → IDLE
  const isTerminalEvent = ['stop', 'turn_end', 'tool_end', 'session_start'].includes(lastProgressType);
  if (isTerminalEvent || lastProgressAge >= 120) {
    const confidence = lastProgressAge >= 120 ? 'HIGH' : 'MEDIUM';
    return { state: 'IDLE', confidence, reason: `Last activity ${fmt(lastProgressAge)} ago` };
  }

  // 8. 短暂的 turn 间隙 → IDLE (MEDIUM)
  return { state: 'IDLE', confidence: 'MEDIUM',
           reason: `Last event: ${lastProgressType}, ${fmt(lastProgressAge)} ago` };
}

function detectStuckScenario(signals) {
  const { runningTool, openTurn, lastProgressAge } = signals;
  // A: 工具卡住（无新 runtime progress event）
  if (runningTool && runningTool.duration > runningTool.p95Threshold * 2 && lastProgressAge > 60) {
    return { scenario: 'tool_stuck',
             reason: `${runningTool.name} running ${fmt(runningTool.duration)}, exceeds expected duration` };
  }
  // B: 模型卡住（prompt 后 120s 无工具/stop）
  if (openTurn && openTurn.age > 120 && !runningTool) {
    return { scenario: 'model_stuck',
             reason: `Prompt received ${fmt(openTurn.age)} ago, no response events` };
  }
  // C: 主循环无进展（turn 未结束但 300s 无 runtime progress）
  if (openTurn && lastProgressAge > 300) {
    return { scenario: 'loop_stuck',
             reason: `No progress for ${fmt(lastProgressAge)}, turn still open` };
  }
  return null;
}
```

### 4.4 状态输出格式

每个状态输出都携带完整元数据：

```json
{
  "state": "POSSIBLY_STUCK",
  "confidence": "MEDIUM",
  "evidence": ["tool_running_5m", "no_post_tool_event", "pm2_online"],
  "missing_evidence": ["otel_stream_freshness"],
  "reason": "Bash 已运行 5 分钟，超过该工具正常时长",
  "suggested_action": "请检查终端输出，或等待完成",
  "updated_at": "2026-05-10T14:02:33Z",
  "source": {
    "pm2": { "fresh": true, "age_s": 5 },
    "hook": { "fresh": false, "age_s": 312 },
    "otel": { "fresh": true, "age_s": 8 }
  }
}
```

---

## 5. 数据采集架构

### 5.1 总体架构

```
┌─────────────────────────────────────────────────────┐
│                    Runtime Layer                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Claude Code │  │  Codex CLI   │  │   PM2      │ │
│  │  Hooks      │  │  Hooks       │  │  Services  │ │
│  │  OTel       │  │  OTel        │  │            │ │
│  │  StatusLine │  │  Rollout     │  │            │ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │
└─────────┼────────────────┼────────────────┼────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────┐
│              Dashboard Ingestion Layer               │
│                                                      │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Hook Handler │  │ OTel     │  │ System Sampler│  │
│  │ (command     │  │ Reader   │  │ (CPU/Mem/Disk)│  │
│  │  hook)       │  │          │  │               │  │
│  └──────┬───────┘  └────┬─────┘  └───────┬───────┘  │
│         │               │                │          │
│  ┌──────┴───────┐  ┌────┴─────┐  ┌───────┴───────┐  │
│  │Claude Adapter│  │ Codex    │  │ Platform      │  │
│  │              │  │ Adapter  │  │ Reader        │  │
│  │ StatusLine   │  │ Rollout  │  │ PM2 / C4 /    │  │
│  │ reader       │  │ reader   │  │ Scheduler     │  │
│  └──────┬───────┘  └────┬─────┘  └───────┬───────┘  │
│         │               │                │          │
│         └───────────────┼────────────────┘          │
│                         ▼                            │
│              ┌──────────────────┐                    │
│              │  Canonical Event │                    │
│              │  Normalizer      │                    │
│              └────────┬─────────┘                    │
│                       ▼                              │
│              ┌──────────────────┐                    │
│              │   SQLite Store   │                    │
│              │  (§6 Schema)     │                    │
│              └────────┬─────────┘                    │
│                       ▼                              │
│              ┌──────────────────┐                    │
│              │ Derived State    │                    │
│              │ Engine (§4)      │                    │
│              └────────┬─────────┘                    │
└───────────────────────┼─────────────────────────────┘
                        ▼
               ┌──────────────────┐
               │  Dashboard API   │
               │  (REST + SSE)    │
               └────────┬─────────┘
                        ▼
               ┌──────────────────┐
               │  Dashboard UI    │
               │  (Browser)       │
               └──────────────────┘
```

### 5.2 采集源清单

| 采集源 | 采集方式 | 数据内容 | 适用 Runtime | 已验证 |
|--------|---------|---------|-------------|--------|
| **Hook Handler** | 注册为 settings.json 的 command hook，接收 stdin JSON | 工具调用、Turn 边界、权限请求、Subagent、Compact、Session 生命周期 | Claude ✅ Codex ✅ | 17 种 Claude 事件 ✅，8 种 Codex 事件 ✅ (PR #18/#19 验证) |
| **OTel Reader** | 读取本地 OTel collector 数据（或直接作为 exporter endpoint） | Token、Cost、Latency、Traces、API errors | Claude ✅ Codex ✅ | Claude 6 metrics + 6 logs + 5 spans ✅; Codex 33 metrics + 13 spans ✅ (spike 验证) |
| **StatusLine Reader** | Claude Code statusCommand 输出的 JSON | Context%、Rate limits、Cost、Cache、Effort level | Claude ✅ | 已验证 StatusLine 数据结构 ✅ (PR #18 文档) |
| **Rollout JSONL Reader** | 读取 Codex rollout JSONL 文件 | Token count、Rate limits、Context window | Codex ✅ | Jinglever 确认数据结构 ✅ |
| **System Sampler** | Node.js os 模块 + df 命令 | CPU、Memory、Disk | 全部 | 标准 OS API ✅ |
| **PM2 Reader** | `pm2 jlist` JSON 解析 | 服务状态、Restart count、Memory、CPU | 全部 | PM2 jlist 输出格式已验证 ✅ |
| **C4 Reader** | 直接读 c4.db (SQLite) | 消息量、响应延迟、渠道分布 | 全部 | c4.db schema 已知 ✅ |
| **Scheduler Reader** | 直接读 scheduler.db (SQLite) | 任务执行记录 | 全部 | scheduler.db schema 已知 ✅ |

### 5.3 Hook Handler 设计

**D5 原则：最小 Hook 集**

Dashboard 遵循 OTel 优先原则（D5），只注册 OTel 无法提供的最小 hook 集。OTel span 在工具结束后才完整落地，无法提供实时 tool-start 信号，因此保留 PreToolUse/PostToolUse 用于实时 current tool 显示。其他生命周期事件（SessionStart/SessionEnd/SubagentStart/SubagentStop/PostCompact/Notification 等）通过 OTel spans/logs 获取，不安装 hook。

**最小 Hook 集（5 个事件）**：
| Hook | 用途 | OTel 无法替代的原因 |
|------|------|-------------------|
| PreToolUse | 实时 current tool 显示 | OTel span 工具结束后才完整，无 tool-start streaming |
| PostToolUse | 结束 current tool、计算 duration | 配合 PreToolUse 完成工具生命周期 |
| UserPromptSubmit | Turn 开始信号 | OTel 无对应 prompt boundary event |
| Stop | Turn/response 结束信号 | OTel 无精确对应（注：Stop ≠ session end，SessionEnd 是独立事件） |
| PermissionRequest | WAITING_HUMAN 强证据 | OTel 无对应 permission waiting signal |

**数据存储约束**：Hook 只存 tool_name、tool_use_id、duration_ms、sanitized summary。**不存** tool_input / tool_output 原文。

Claude Code 和 Codex 使用不同的配置文件和 schema：

**Claude Code**（`~/.claude/settings.json` → `hooks` 字段，支持 project/local/user 三层）：

```json
{
  "hooks": {
    "PreToolUse": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "PostToolUse": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "UserPromptSubmit": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "Stop": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "PermissionRequest": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }]
  }
}
```

**Codex**（`~/.codex/hooks.json` 或 `<repo>/.codex/hooks.json`，不支持 `type` 字段——只支持 command）：

```json
[
  { "event": "PreToolUse", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "PostToolUse", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "UserPromptSubmit", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "Stop", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "PermissionRequest", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }
]
```

**安装差异**：Dashboard 的 installer 必须分两条路径：
- `installClaudeHooks()`: 读取/合并 `~/.claude/settings.json` 的 hooks 字段，保留用户已有 hook
- `installCodexHooks()`: 读取/合并 `~/.codex/hooks.json`（数组格式），保留用户已有 hook
- Runtime 检测：通过当前 PM2 进程名或 `.env` 中的 `ZYLOS_RUNTIME` 变量确定

`hook-ingest.js` 逻辑：
1. 从 stdin 读取 JSON payload
2. 脱敏（§8 规则）
3. 标准化为 canonical event 格式
4. 写入 SQLite runtime_events 表
5. 更新 source_health 表的 hook 采集源状态
6. 如果是 PreToolUse，记录 running tool 状态；PostToolUse 清除
7. 如果是 PermissionRequest，记录 pending permission

**性能约束**：hook handler 是同步阻塞的（尤其 Codex），必须快速完成。目标 < 50ms。SQLite WAL 模式 + 简单 INSERT 可以满足。

### 5.4 Runtime Adapter

每个 Runtime 有独立的 adapter，负责将 runtime-specific 数据映射到统一的 canonical schema：

**Claude Code Adapter**：
- Hook events → canonical runtime_events
- StatusLine JSON → metric_points (context%, rate_limits, cost, cache, effort)
- OTel metrics → metric_points (token.usage, cost.usage, active_time)
- OTel logs → runtime_events (api_request, compaction, errors)
- OTel traces → runtime_events (interaction spans, tool execution spans)

**Codex Adapter**：
- Hook events → canonical runtime_events
- Rollout JSONL → metric_points (token_count, rate_limits, context_window)
- OTel logs → metric_points (token counts from sse_event) + runtime_events
- OTel metrics → metric_points (turn duration, approval, thread count)
- OTel traces → runtime_events (session spans, tool execution spans)

**统一 canonical event 格式**：

```typescript
interface CanonicalEvent {
  id: string;                    // UUID
  timestamp: string;             // ISO 8601
  runtime: 'claude' | 'codex';
  session_id: string;
  event_type: string;            // 统一事件类型（见下表）
  category: 'tool' | 'turn' | 'session' | 'permission' | 'system' | 'communication';
  summary: string;               // 脱敏后的自然语言摘要
  duration_ms?: number;
  metadata: Record<string, any>; // 脱敏后的结构化字段
  source: string;                // 'hook' | 'otel_log' | 'otel_metric' | 'otel_trace' | 'statusline' | 'rollout'
  confidence: 'actual' | 'estimated' | 'inferred';
}
```

**统一事件类型映射**：

| Canonical event_type | Claude 来源 | Codex 来源 |
|---------------------|------------|------------|
| tool_start | PreToolUse hook | PreToolUse hook |
| tool_end | PostToolUse hook | PostToolUse hook |
| tool_failure | PostToolUseFailure hook | PostToolUse hook (success=false) / OTel tool_result |
| turn_end | Stop hook | Stop hook |
| turn_failure | StopFailure hook | unsupported |
| session_start | SessionStart hook | SessionStart hook |
| session_end | SessionEnd hook | unsupported |
| permission_request | PermissionRequest hook | PermissionRequest hook |
| subagent_start | SubagentStart hook | unsupported |
| subagent_end | SubagentStop hook | unsupported |
| compact | PostCompact hook / OTel compaction log | PreCompact/PostCompact hook |
| prompt_received | UserPromptSubmit hook | UserPromptSubmit hook |
| api_request | OTel api_request log | OTel codex.api_request log |
| api_error | OTel api_error log | OTel api_request (status≠200) |
| notification | Notification hook | unsupported |
| config_change | ConfigChange hook | unsupported |

---

## 6. 存储设计

### 6.1 SQLite Schema

四张核心表，服务于三层数据模型：Raw → Derived → View。

```sql
-- 标准化事件（来自 Hook / OTel / 其他采集源）
-- 脱敏后存储，不含原始 payload
CREATE TABLE runtime_events (
  id TEXT PRIMARY KEY,            -- UUID
  timestamp TEXT NOT NULL,        -- ISO 8601
  runtime TEXT NOT NULL,          -- 'claude' | 'codex'
  session_id TEXT,
  event_type TEXT NOT NULL,       -- canonical event type
  category TEXT NOT NULL,         -- 'tool' | 'turn' | 'session' | 'permission' | 'system' | 'communication'
  summary TEXT,                   -- 脱敏后的自然语言描述
  duration_ms INTEGER,
  metadata TEXT,                  -- JSON, 脱敏后的结构化字段
  source TEXT NOT NULL,           -- 'hook' | 'otel_log' | 'otel_metric' | 'otel_trace' | ...
  confidence TEXT DEFAULT 'actual', -- 'actual' | 'estimated' | 'inferred'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_time ON runtime_events(timestamp);
CREATE INDEX idx_events_type ON runtime_events(event_type);
CREATE INDEX idx_events_session ON runtime_events(session_id);

-- 时序指标（聚合后的数值，用于趋势图和仪表盘）
CREATE TABLE metric_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,        -- ISO 8601
  runtime TEXT NOT NULL,
  session_id TEXT,
  metric_name TEXT NOT NULL,      -- e.g. 'token_usage', 'cost_usd', 'context_pct', 'cpu_pct'
  metric_value REAL NOT NULL,
  dimensions TEXT,                -- JSON, e.g. {"type":"input","model":"opus-4"}
  source TEXT NOT NULL,
  confidence TEXT DEFAULT 'actual',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_metrics_time ON metric_points(timestamp);
CREATE INDEX idx_metrics_name ON metric_points(metric_name);

-- 后处理事实（owner 可理解的里程碑）
CREATE TABLE activity_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  runtime TEXT,
  session_id TEXT,
  fact_type TEXT NOT NULL,        -- 'pr_submitted' | 'pr_merged' | 'message_replied' | 'tool_failed' | 'permission_requested' | ...
  summary TEXT NOT NULL,          -- "Submitted PR #576 to zylos-core"
  project TEXT,                   -- 关联项目（从 projects.md 映射）
  metadata TEXT,                  -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_facts_time ON activity_facts(timestamp);
CREATE INDEX idx_facts_type ON activity_facts(fact_type);
CREATE INDEX idx_facts_project ON activity_facts(project);

-- 采集源健康状态
-- signal_type 区分两类信号（见 §4.2）：
--   'collector_liveness': Dashboard 自身采集管线的健康（证明观测能力正常）
--   'runtime_progress':   来自 Agent 的运行时事件（证明 agent 有活动）
--   'platform':           平台级数据源（C4、Scheduler 等，不参与 stuck 判定）
CREATE TABLE source_health (
  source_name TEXT PRIMARY KEY,   -- collector_liveness: 'pm2_reader' | 'system_sampler' | 'hook_handler' | 'otel_reader'
                                  -- runtime_progress:   'hook_events' | 'otel_events'
                                  -- platform:           'statusline' | 'rollout' | 'c4' | 'scheduler'
  signal_type TEXT NOT NULL,      -- 'collector_liveness' | 'runtime_progress' | 'platform'
  status TEXT NOT NULL,           -- 'healthy' | 'degraded' | 'stale' | 'error'
  last_success TEXT,              -- ISO 8601
  last_error TEXT,
  error_message TEXT,
  event_count_1h INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 6.2 数据保留策略

| 表 | 保留时长 | 清理方式 |
|---|---------|---------|
| runtime_events | 30 天 | 定时任务按 timestamp 删除 |
| metric_points | 90 天（原始），365 天（日聚合） | 超过 90 天的按小时→按天聚合后删除原始 |
| activity_facts | 365 天 | 定时任务按 timestamp 删除 |
| source_health | 不清理 | 只有当前状态，无历史 |

**决策 [D2] — 已确认**：30 天事件 + 90 天指标（日聚合 365 天）+ 365 天事实。预估 SQLite 文件大小约 50-200MB/年。

### 6.3 不存储的数据

以下数据 **不** 写入 Dashboard 存储：

- Prompt 原文
- 工具输入参数原文（脱敏后的摘要可以存）
- 工具输出内容
- API 请求/响应 body
- 文件完整路径（只存最后两段）
- 用户 credentials、tokens、API keys
- 邮件地址、电话号码等 PII

---

## 7. Runtime 适配

### 7.1 Adapter 接口

```typescript
interface RuntimeAdapter {
  readonly runtime: 'claude' | 'codex';

  // 该 runtime 支持哪些 canonical 指标/事件
  capabilities(): {
    events: string[];       // 支持的 canonical event_type 列表
    metrics: string[];      // 支持的 metric_name 列表
    features: string[];     // 'statusline' | 'rollout' | 'subagent' | ...
  };

  // 将 runtime-specific hook payload 转为 canonical event
  normalizeHookEvent(hookEventName: string, payload: object): CanonicalEvent | null;

  // 读取 runtime-specific 数据源（StatusLine / Rollout）
  readRuntimeData(): Promise<MetricPoint[]>;
}
```

### 7.2 能力矩阵

| 能力 | Claude Code | Codex CLI | 差异处理 |
|------|-----------|-----------|---------|
| Hook events | 17 种 | 8 种 | 缺失的事件不展示，不假补 |
| OTel metrics | 6 instruments | 33 instruments | 各自映射到 canonical metric_name |
| OTel logs | 17 event types | 9 event types | 各自映射 |
| Cost (USD) | actual (OTel/StatusLine) | estimated (token × price) | 前端标注 actual/estimated |
| Context % | StatusLine | Rollout JSONL | 不同来源，相同 metric_name |
| Rate limits | StatusLine | Rollout JSONL | 同上 |
| Subagent tracking | ✅ (SubagentStart/Stop) | ❌ | Claude 独有功能，Codex 下隐藏 |
| PostToolBatch | ✅ | ❌ | Claude 独有，Codex 从 PostToolUse 推断批次 |
| turn_id | ❌ | ✅ | Codex 独有字段，Claude 用 prompt.id 关联 |

### 7.3 前端显示

当某个指标在当前 runtime 下为 unsupported 或 missing：

```
Cost: $2.14 (actual)           ← Claude, OTel 有 cost 字段
Cost: ~$1.87 (estimated)       ← Codex, 从 token × 价格表估算
Cost: — (unavailable)          ← 价格表缺失或 OTel 未配置
```

---

## 8. 隐私与脱敏

### 8.1 默认脱敏规则

所有数据在写入 SQLite 之前经过脱敏：

| 数据类型 | 脱敏方式 |
|---------|---------|
| file_path | 只保留最后两段：`/home/howard/zylos/core/lib/startup.js` → `lib/startup.js` |
| Bash command | 截断 30 字符，移除 `-H`/`--header`/`-u`/`--user` 后的参数 |
| tool_response | 不存储。summary 字段用分类描述替代（如 "file read successful, 245 lines"） |
| prompt | 不存储 |
| API key / token | 如果在任何字段中检测到 `sk-`/`xoxb-`/`ghp_`/`Bearer` 等模式，替换为 `[REDACTED]` |
| email | 正则检测，替换为 `[EMAIL]` |
| IP address | 保留（运维需要）|
| session_id | 保留（关联需要，不含敏感信息） |

### 8.2 Debug Capture 模式

Owner 可以显式开启 debug capture，暂时存储更多数据用于诊断：

- **开启方式**：Dashboard UI 按钮 或 API 调用
- **存储位置**：独立的 `debug_captures` 表
- **TTL**：默认 1 小时，最长 24 小时
- **内容**：完整的 hook payload（含工具输入输出），但仍过滤 credentials

---

## 9. 多 Session 扩展

### 9.1 数据模型准备

所有表的 `session_id` 字段已为多 session 就绪。当前单 session 场景下，session_id 取自 SessionStart hook 的 `session_id` 字段。

### 9.2 未来扩展

当支持多 session 时：
- Overview 页面显示多个 session card，每个独立展示状态
- 聚合指标（cost、token）跨 session 汇总
- 趋势图支持按 session 筛选
- PM2 中可能有多个 runtime 进程，PM2 Reader 需要按进程名/ID 区分

---

## 10. API 设计

### 10.1 REST API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/state` | GET | 当前 agent 状态（§4 状态机输出） |
| `/api/timeline` | GET | 近期事件时间线（分页，默认最近 30 分钟） |
| `/api/metrics/:name` | GET | 指标时序数据（支持 time range、granularity 参数） |
| `/api/facts` | GET | 活动事实（分页，支持 project/type 筛选） |
| `/api/health` | GET | 采集源健康状态 |
| `/api/system` | GET | CPU/内存/磁盘/PM2 当前值 |
| `/api/communication` | GET | 消息统计（支持 time range） |

### 10.2 SSE 实时推送

| 端点 | 事件 |
|------|------|
| `/api/stream` | `state_change`（状态变更）、`new_event`（新事件）、`metric_update`（指标更新）、`alert`（告警） |

UI 的 Overview 区块通过 SSE 实时更新，无需轮询。

---

## 11. 待决策与待验证清单

### Howard 决策（全部已确认，2026-05-10）

| ID | 问题 | 决策 | 影响范围 |
|----|------|------|---------|
| D1 | Communication 区块设计 | 取消"未回复消息数"指标（无法配对）。改为 4 类：Intake Health / Processing Health / Response Activity / Attention Required。Conversation-window 聚合窗口 2min，queue stuck 阈值普通 5min / control 30s | §3.2 ⑥ |
| D2 | 数据保留时长 | 事件 30 天 / 指标 90 天（日聚合 365 天）/ 活动事实 365 天 | §6.2 |
| D3 | STUCK 状态下是否提供自助操作 | 第一版只读。后续版本加操作按钮（按场景区分：ESC 恢复 / 杀 session / 其他）。先通过只读版积累数据，搞清 stuck 场景→action 映射后再做 | §4.2 |
| D4 | Dashboard 认证方式 | 沿用 Phase 1 basic auth | §10 |
| D5 | 数据源优先级 + 状态粒度 | **OTel 优先，最小化 Hook 侵入**（OTel 通过 runtime 环境变量启用，对用户透明；Hook 写入用户 settings.json，每条都是侵入）。但保留最小 tool lifecycle hook 以支持**工具级实时状态**（Option B）。Hook 最小集：PreToolUse、PostToolUse、UserPromptSubmit、Stop、PermissionRequest。Hook 只存 tool_name/tool_use_id/duration/sanitized summary，不存 tool_input/tool_output 原文。Per-metric resolver：StatusLine 对其独占字段（context%/rate_limit/effort）是 preferred source 而非 OTel fallback。退出条件：OTel 后续支持 tool-start streaming 信号时移除 PreToolUse hook。适用 Claude + Codex 双 runtime。 | §5.2, §5.3, AC-2 |
| D6 | Work History PR 数据 | 第一版不采集 PR 数据。用户 Git 平台不确定（GitHub/GitLab/Gitea/私有部署），通用方案成本过高。Work History 只展示 Hook/OTel 可直接计算的指标：tool calls、active time、top project。PR 指标后续有需求再考虑 | §3.2 ⑤ |

### 待数据验证

| ID | 验证项 | 验证方式 | 影响 |
|----|--------|---------|------|
| V1 | IDLE 判定的 60s 阈值 | 统计实际 Hook 事件间隔分布 P99 | §4.2 IDLE 状态 |
| V2 | 各工具类型 P95 运行时长 | 从已有 PostToolUse duration_ms 数据统计 | §4.2 POSSIBLY_STUCK 阈值 |
| V3 | Codex rollout JSONL 的实时性 | 确认文件写入频率和延迟 | §5.2 Rollout Reader |
| V4 | StatusLine script 输出在 PM2 tmux 环境下的可用性 | 在 zylos01 实测 | §5.2 StatusLine Reader |

---

## 12. 实施路径

| 阶段 | 内容 | 交付物 |
|------|------|--------|
| **Phase 2a** | Hook Handler + SQLite schema + 状态判定引擎 + Overview 区块 ①②③ | 实时状态 + 健康 + 容量，能回答"活着吗？卡了吗？" |
| **Phase 2b** | Timeline + Work History + Communication | 区块 ④⑤⑥，能回答"在做什么？做了什么？" |
| **Phase 2c** | 趋势图 + OTel 深度集成 + Runtime adapter 完善 | 完整 Overview + 历史趋势 |

### Phase 2a Acceptance Criteria

以下为 Phase 2a 编码完成后的验收条件（与 Jinglever 论证确认，2026-05-10）：

**AC-1: 状态引擎重启恢复**
- Schema 包含 `event_seq`（自增序号）和 `state_snapshots` 表（每 30s 或状态变更写入：runningTool / openTurn / pendingPermission / possiblyStuckSince / lastProgressCursor）
- 重启时��最新 snapshot 恢复 → 从 cursor 往后 replay events → high-watermark catch-up → 切 live
- 无 snapshot 时从最近 SessionStart（或 max(now-2h, oldest boundary)）回放
- 测试覆盖：open tool 恢复、open turn 恢复、pending permission ��复、missing close event 降级为 UNKNOWN
- replay 期间新事件正常入库但不进内存状态，catch-up 后再处理
- State key 为 runtime + session_id，不使用全局状态

**AC-2: 指标源优先级解析（metric_resolver）— 遵循 D5 OTel 优先原则**
- 核心原则（D5）：OTel 优先，最小化 Hook 侵入。对用户 settings.json 的修改越少越好。OTel 通过 runtime 环境变量启用，对用户完全透明。
- 不使用全局 OTel > StatusLine > Hook 机械排序；按 metric_name 逐个定义 preferred source chain，依据语义准确性和数据鲜度：
  - `context_pct`: statusline.actual > rollout.actual > derived_token_estimate.estimated（StatusLine 独占字段，是 preferred source）
  - `rate_limit`: statusline.actual > rollout.actual（StatusLine 独占字段）
  - `effort_level`: statusline.actual（StatusLine 独占字段，无其他源）
  - `session_cost`: otel_cost_sum.actual > statusline.actual > token_price_estimated（OTel 优先，per-request 精度更高）
  - `daily_cost`: otel_cost_sum.actual > statusline_delta.inferred > token_price_estimated
  - `cache_hit_rate`: otel_token_usage.actual > statusline_current_usage.actual
  - `tool_duration`: otel_span.actual > hook_postToolUse.actual（OTel 优先，hook 作为实时补充）
- 存储层保留所有原始 metric_points（不丢数据）
- API 输出包含：selected_source、freshness、confidence、alternatives、fallback_reason

**AC-3: Owner UX 不暴露原始 confidence 标签**
- UI 不显示 HIGH/MEDIUM/LOW，映射为 owner 可理解的 4 层：
  - `confirmed_normal`：确定在线/空闲/正在执行明确工具
  - `in_progress_uncertain`：正在处理，但缺少中间进展信号（文案："正在处理消息"而非"正在稳定工作"）
  - `needs_attention`：强证据告警，带原因 + 建议动作（如"Bash 已运行 8 分钟，建议再等或检查终端"）
  - `unknown_degraded`：观测���足，不假装正常（如"遥测数据中断，无法确认状态"）
- MEDIUM 异常类状态可上主 UI，但必须附可验证原因和 next action
- LOW confidence 仅在 detail/diagnostics panel 显示

**AC-4: Hook 健康检测（expected-event pairing + OTel 交叉验证）**
- hook-ingest.js 记录 last_success / last_duration_ms / last_error 到 source_health
- PreToolUse 到达后建立 expected closing（PostToolUse / PostToolUseFailure / Stop / timeout）
- Hook health 三档：
  - `healthy`：近期 hook success 且无 pending expected event 超时
  - `suspect`：存在 open expectation 超阈值，但无独立 OTel ��证
  - `degraded`：OTel 记录 tool_result/hook_execution 但 hook-ingest 缺对应事件（强证据 hook 丢失）
- 不使用 PM2 CPU + sequence 不增长作为丢 hook 的唯一证据
- 无法验证时标 degraded/UNKNOWN，不推强结论
