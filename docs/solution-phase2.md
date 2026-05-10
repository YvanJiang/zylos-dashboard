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
│  │ Today: $2.14 (actual)   │      │  │ C4: connected (3s ago)  │ │
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
│  │ 3 PR reviews            │      │  │ TG: 12 in / 8 out      │ │
│  │ 1 PR submitted          │      │  │ Lark: 3 in / 2 out     │ │
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
| 当前工具名称 + 已运行时长 | PreToolUse / PostToolUse 事件 | 实时 |
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
| 活跃时长 | SessionStart 到 SessionEnd/最后事件的时间累加 | Hook events |
| 工具调用总数 | count(PostToolUse) | Hook events |
| PR 提交/Review/Merge | 定时调用 `gh pr list --json number,title,state,createdAt,mergedAt --limit 20` 采集 PR 状态变化，写入 activity_facts。不从工具输出推断（隐私原则） | GitHub API (gh CLI) |
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

**回答**：消息处理及时吗？有没有漏消息？

| 指标 | 计算方式 | 数据来源 | 论证 |
|------|---------|---------|------|
| 各渠道消息量 (in/out) | count group by channel, direction | c4.db messages 表 | 直接查询，可靠 |
| 平均响应延迟 | 对每条 inbound，找最近的同 endpoint outbound 的时间差 | c4.db messages 表 | 可靠，但假设：第一条 outbound 是对该 inbound 的回复。局限：如果多条 inbound 连续到达，或回复是异步的，延迟计算可能不准确 |
| P50/P95 响应延迟 | 分位数统计 | 同上 | 同上 |
| 未回复消息数 | inbound messages 无对应 outbound 且超过阈值时间 | c4.db messages 表 | 需要定义"未回复"阈值。建议：5 分钟内无同 endpoint outbound 视为 pending |
| 失败/重试消息 | status = 'failed' 或 retry_count > 0 | c4.db messages 表 | 直接查询，可靠 |

**待 Howard 决策 [D1]**：Communication 的"未回复"阈值定为多少？建议 5 分钟。某些场景下（如 scheduled task 处理中），可能超过 5 分钟才回复，这算不算"未回复"？

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
| **Positive Evidence（满足任一场景）** | **场景 A — 工具卡住**：有未结束的工具调用，持续时间超过该工具类型 P95 阈值 × 2，且期间无其他 Hook 事件。**场景 B — 模型卡住**：收到 UserPromptSubmit 后超过 120s 无 PreToolUse 或 Stop（可能模型在生成极长回复或 API 挂起）。**场景 C — 主循环无进展**：PM2 online + 所有采集源在最近 300s 有数据，但最后的 active 信号（PreToolUse/UserPromptSubmit）距今超过 300s 且 turn 未结束（无 Stop） |
| **Counter Evidence** | (1) 收到任何新的 Hook/OTel 事件 → 有进展，不卡; (2) 场景 B 中如果 OTel 有活跃的 `llm_request` span，说明模型确实在运行（只是慢），降低 stuck 可能性; (3) 工具是已知长时间工具（如 Agent subagent、大型 npm install）且未超过该工具的硬上限 |
| **Clear Condition** | 收到任何新 Hook 事件（PostToolUse、Stop、PreToolUse 等） |
| **Runtime Differences** | Claude: 场景 B 可通过 OTel `llm_request` span 区分"模型在运行"和"API 挂起"。Codex: OTel 有 `codex.api_request` 日志和 `codex.websocket_request` 日志，可检测 websocket 超时（success=false + duration > threshold） |
| **Freshness Requirement** | PM2 采样必须在 30s 内。如果采集管线本身 stale，应判 UNKNOWN 而非 POSSIBLY_STUCK |
| **Confidence Downgrade** | 默认 MEDIUM。如果有活跃 OTel span 证明模型/API 仍在通信 → 降为 LOW（可能只是慢，不是卡）。如果采集管线部分 stale → 标注 "部分数据源不可用，判断可能不准确" |
| **工具 P95 阈值初始值** | Bash: 120s, Read: 5s, Edit: 5s, Write: 5s, WebSearch: 30s, WebFetch: 30s, Agent: 300s。**待验证 [V2]**：需从实际 PostToolUse duration_ms 数据统计确认 |
| **判定逻辑** | `pm2_online AND ingestion_fresh AND (scenario_a OR scenario_b OR scenario_c) AND no_counter_evidence` |
| **置信度** | MEDIUM（默认）/ LOW（有活跃 OTel span 或已知长时间工具） |
| **Owner 看到** | 橙色指示灯 + "可能卡住" + 原因（如 "Bash 已运行 5 分钟，超过正常时长"、"收到消息后 2 分钟无响应"） |

#### STUCK — 已卡住

| 项 | 内容 |
|---|------|
| **含义** | Agent 大概率遇到了问题，需要人工关注 |
| **Positive Evidence（全部满足）** | (1) 已处于 POSSIBLY_STUCK 状态超过 300s; (2) 期间无任何新 Hook/OTel 事件; (3) PM2 进程仍 online（如果已 crash 则是 OFFLINE 不是 STUCK）; (4) 采集管线仍 fresh（确保不是采集中断导致的假象） |
| **Counter Evidence** | (1) 收到任何新事件 → 立即清除 STUCK; (2) 采集管线变 stale → 应降级为 UNKNOWN; (3) PM2 进程 crash → 应转为 OFFLINE |
| **Clear Condition** | 收到任何新 Hook/OTel 事件，或 PM2 进程状态变化 |
| **Runtime Differences** | 无显著差异。两个 runtime 的 STUCK 判定逻辑相同 |
| **Freshness Requirement** | PM2 + 至少一个采集源（hook 或 OTel）必须在 30s 内有新数据或已确认 fresh。如果所有采集源都 stale，不能判 STUCK（应为 UNKNOWN） |
| **Confidence Downgrade** | 默认 MEDIUM（不使用 HIGH，因为"无事件"是 absence of evidence，不是 evidence of absence。可能有 hook 丢失、OTel 发送延迟等原因）。仅当满足额外条件时提升为 HIGH：POSSIBLY_STUCK 超过 600s + PM2 进程 CPU 为 0% + 所有采集源 confirmed fresh |
| **判定逻辑** | `was_possibly_stuck_for >= 300s AND no_new_events AND pm2_online AND ingestion_fresh` |
| **置信度** | MEDIUM（默认）/ HIGH（600s + CPU=0 + all sources fresh） |
| **Owner 看到** | 红色指示灯 + "已卡住" + 原因 + 建议动作（如 "Bash 已运行 10 分钟无响应，建议检查终端"） |
| **待 Howard 决策 [D3]** | STUCK 状态下是否提供自助操作（如"重启 session"）？涉及只读原则 |

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
| **Positive Evidence（满足任一）** | (1) PM2 jlist 调用失败; (2) PM2 online 但所有采集源 stale > 300s（hook + OTel 均无数据，无法判定 active/idle/stuck）; (3) ACTIVE 的运行中工具证据超过 300s 无更新（可能 hook 丢失）; (4) WAITING_HUMAN 的 pending permission 超过 600s 无清除 |
| **Counter Evidence** | 收到任何新的 fresh 数据 → 重新评估为其他状态 |
| **Clear Condition** | 任何采集源恢复 fresh 状态，或 PM2 jlist 恢复正常 |
| **Runtime Differences** | 无差异 |
| **Freshness Requirement** | N/A（UNKNOWN 本身就是对 freshness 不足的表达） |
| **Confidence Downgrade** | N/A |
| **判定逻辑** | `pm2_unavailable OR (pm2_online AND all_sources_stale) OR evidence_too_old` |
| **置信度** | N/A — 承认不知道比错误判定更可靠 |
| **Owner 看到** | 灰色问号 + "状态不确定" + 原因（如 "遥测数据中断 5 分钟，无法确认当前状态"） |

### 4.3 状态判定引擎伪代码

```javascript
function deriveAgentState(signals) {
  const { pm2Status, pm2SampleAge, pm2Cpu,
          runningTool, openTurn, pendingPermission,
          lastEventAge, lastEventType, ingestionFresh,
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
  // permission 超过 600s 未清除 → 证据过期，降级为 UNKNOWN
  if (pendingPermission && pendingPermission.age >= 600) {
    return { state: 'UNKNOWN', confidence: 'N/A',
             reason: 'Permission request stale (>10min), may have missed clear event' };
  }

  // 4. 检查 STUCK / POSSIBLY_STUCK（多场景）
  const stuckScenario = detectStuckScenario(signals);
  if (stuckScenario) {
    if (possiblyStuckSince && Date.now() - possiblyStuckSince > 300_000) {
      const confidence = (Date.now() - possiblyStuckSince > 600_000 
                          && pm2Cpu === 0 && ingestionFresh) ? 'HIGH' : 'MEDIUM';
      return { state: 'STUCK', confidence, reason: stuckScenario.reason };
    }
    // 有活跃 OTel span 说明模型/API 仍在通信 → 降低 confidence
    const confidence = activeOtelSpan ? 'LOW' : 'MEDIUM';
    return { state: 'POSSIBLY_STUCK', confidence, reason: stuckScenario.reason };
  }

  // 5. 采集管线全部 stale + PM2 online → UNKNOWN
  if (!ingestionFresh && lastEventAge > 300) {
    return { state: 'UNKNOWN', confidence: 'N/A',
             reason: 'All telemetry stale, unable to determine state' };
  }

  // 6. 有运行中的工具或 open turn → ACTIVE
  if (runningTool) {
    return { state: 'ACTIVE', confidence: 'HIGH',
             reason: `Running: ${runningTool.name} (${fmt(runningTool.duration)})` };
  }
  if (openTurn) {
    // open turn 但无工具 → 可能在思考/生成
    return { state: 'ACTIVE', confidence: 'MEDIUM',
             reason: 'Processing prompt (no tool call yet)' };
  }

  // 7. 运行中工具的证据超过 300s → 可能 hook 丢失
  if (runningTool && runningTool.evidenceAge > 300) {
    return { state: 'UNKNOWN', confidence: 'N/A',
             reason: 'Running tool evidence stale, hook may have been lost' };
  }

  // 8. 最后事件是结束型，无 pending 状态 → IDLE
  const isTerminalEvent = ['stop', 'turn_end', 'tool_end', 'session_start'].includes(lastEventType);
  if (isTerminalEvent || lastEventAge >= 120) {
    const confidence = lastEventAge >= 120 ? 'HIGH' : 'MEDIUM';
    return { state: 'IDLE', confidence, reason: `Last activity ${fmt(lastEventAge)} ago` };
  }

  // 9. 短暂的 turn 间隙 → IDLE (MEDIUM)
  return { state: 'IDLE', confidence: 'MEDIUM',
           reason: `Last event: ${lastEventType}, ${fmt(lastEventAge)} ago` };
}

function detectStuckScenario(signals) {
  const { runningTool, openTurn, lastEventAge } = signals;
  // A: 工具卡住
  if (runningTool && runningTool.duration > runningTool.p95Threshold * 2 && lastEventAge > 60) {
    return { scenario: 'tool_stuck',
             reason: `${runningTool.name} running ${fmt(runningTool.duration)}, exceeds expected duration` };
  }
  // B: 模型卡住（prompt 后 120s 无工具/stop）
  if (openTurn && openTurn.age > 120 && !runningTool) {
    return { scenario: 'model_stuck',
             reason: `Prompt received ${fmt(openTurn.age)} ago, no response events` };
  }
  // C: 主循环无进展（turn 未结束但 300s 无活动）
  if (openTurn && lastEventAge > 300) {
    return { scenario: 'loop_stuck',
             reason: `No progress for ${fmt(lastEventAge)}, turn still open` };
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

Dashboard 注册自己的 hook handler，但 Claude Code 和 Codex 使用不同的配置文件和 schema：

**Claude Code**（`~/.claude/settings.json` → `hooks` 字段，支持 project/local/user 三层）：

```json
{
  "hooks": {
    "PreToolUse": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "PostToolUse": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "PostToolUseFailure": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "Stop": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "StopFailure": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "SessionStart": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "SessionEnd": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "PermissionRequest": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "PermissionDenied": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "SubagentStart": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "SubagentStop": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "PostCompact": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "UserPromptSubmit": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }],
    "Notification": [{ "type": "command", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }]
  }
}
```

**Codex**（`~/.codex/hooks.json` 或 `<repo>/.codex/hooks.json`，不支持 `type` 字段——只支持 command）：

```json
[
  { "event": "SessionStart", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "UserPromptSubmit", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "PreToolUse", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "PostToolUse", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "PermissionRequest", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "Stop", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "PreCompact", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" },
  { "event": "PostCompact", "command": "node ~/zylos/components/dashboard/lib/hook-ingest.js" }
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
CREATE TABLE source_health (
  source_name TEXT PRIMARY KEY,   -- 'hook' | 'otel' | 'statusline' | 'rollout' | 'pm2' | 'system' | 'c4' | 'scheduler'
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

**待 Howard 决策 [D2]**：数据保留时长是否合适？30 天事件 + 90 天指标 + 365 天事实，预估 SQLite 文件大小约 50-200MB/年。

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

### 待 Howard 决策

| ID | 问题 | 建议 | 影响范围 |
|----|------|------|---------|
| D1 | Communication "未回复" 阈值 | 5 分钟 | §3.2 ⑥ |
| D2 | 数据保留时长 (30天事件/90天指标/365天事实) | 如上 | §6.2 |
| D3 | STUCK 状态下是否提供自助操作（如重启 session） | 第一版不提供（只读），待讨论 | §4.2 |
| D4 | Dashboard 是否需要认证（Phase 1 已有 basic auth） | 沿用 Phase 1 basic auth | §10 |

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
