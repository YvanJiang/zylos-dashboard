# Codex Runtime 适配计划

## 背景

Zylos Dashboard 当前已经具备多运行时的基础形态：PM2、系统健康、通信、调度等数据源不依赖 Claude；前端也已经有 Codex degraded mode，用于隐藏 Claude-only 面板并保留通用监控能力。但 Codex Runtime 还没有达到与 Claude Runtime 等价的可观测体验，主要缺口在实时 runtime 事件、token/context/cost 映射、hook 安装生命周期，以及 Codex 专属数据源的验证与产品化。

本计划的目标是把 Codex Runtime 从“可降级运行”推进到“可被 Dashboard 正式观测和诊断”。

## 目标状态表

适配完成后，Dashboard 在 Codex Runtime 下不应只有一个笼统的 degraded mode，而应按面板和指标分别呈现目标状态：

| Dashboard 区域 | Codex 目标状态 | 期望表现 | 主要来源 | 备注 |
|---|---|---|---|---|
| Agent 状态 / 当前工具 | 正常 | 显示 idle/running/waiting/stuck 与当前工具名 | Codex hook + state engine | Phase 1-2 先落地 |
| 工具调用流 / 工具耗时 | 正常 | 展示工具名、成功/失败、耗时、来源置信度 | Codex hook + rollout JSONL | MVP 不展示完整输入/输出 |
| Token 使用 / cache hit | 正常 | 显示 session/today/7d input/output/cache | Codex rollout JSONL `token_count` | 与 Claude JSONL collector 同类 |
| Context 使用率 / 新会话阈值 | 正常 | activity-monitor 已能用 Codex context usage 触发 new-session；Dashboard 展示同一口径 | Codex rollout JSONL + `codex_new_session_threshold` | threshold 来自 zylos config，默认 75 |
| Cost / 花费趋势 | 正常但标明估算口径 | 用 Codex token 乘 Dashboard price table，与 Claude JSONL cost 口径一致 | Codex rollout JSONL + `modelPrices` | 无官方 cost 字段时 confidence 仍可为 priced/estimated |
| Turn 延迟 / TTFT | 正常 | 显示 turn duration、TTFT、P50/P95 | Codex rollout JSONL `task_complete` | OTel 可后续增强 |
| Permission 请求 | 正常但中等置信度 | 显示等待人工/权限请求状态 | Codex hook | Codex 匹配键可能弱于 Claude |
| PM2 / 系统健康 | 正常 | 与 Claude Runtime 相同 | PM2/system collectors | runtime 无关 |
| 通信 / 调度 | 正常 | 与 Claude Runtime 相同 | C4/scheduler DB | runtime 无关 |
| Claude-only 面板 | 隐藏 | 不展示 statusline、Claude-only subagent/usage 字段 | capability model | 避免误导 |
| Runtime actions | 部分降级 | 支持 runtime switch/new-session threshold；模型/effort 切换保持 not implemented | actions API | 后续另拆 |

## 现有依据

本地已有一次 Codex Runtime 数据采集试验，相关内容仍在：

- `spike/codex-hook-logger.mjs`：Codex hook payload 采集探针。
- `spike/codex-otlp-receiver.mjs`：本地 OTLP HTTP 接收探针。
- `spike/analyze-codex-spike.mjs`：Codex hook/OTLP 样本分析脚本。
- `~/zylos/components/dashboard/spike/codex-hooks.jsonl`：Codex hook 样本。
- `~/zylos/components/dashboard/spike/codex-otlp.jsonl`：Codex OTLP 样本。
- `~/zylos/components/dashboard/spike/codex-spike-summary.json`：样本汇总。

样本中的关键事实：

- Codex hook 已捕获 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`。
- Hook payload 包含 `session_id`、`turn_id`、`model`、`permission_mode`、`cwd`、`tool_name`、`tool_use_id`、`tool_input`、`tool_response` 等字段。
- Codex OTLP resource 标识为 `service.name=codex_cli_rs`，样本版本为 `service.version=0.128.0`。
- Codex OTLP logs 中已有 `codex.conversation_starts`、`codex.user_prompt`、`codex.websocket_*`、`codex.sse_event`、`codex.tool_decision`、`codex.tool_result` 等事件。
- Codex OTLP metrics 中已有 `codex.turn.ttft.duration_ms`、`codex.turn.e2e_duration_ms`、`codex.tool.call.duration_ms`、`codex.turn.token_usage`、`codex.conversation.turn.count` 等指标。
- Codex traces 中已有 `turn/start`、`session_task.turn`、`exec_command`、`write_stdin`、`handle_responses` 等 span，可用于定位一轮交互、工具调用和 token 使用。

Dashboard 现有代码基础：

- `src/lib/hook-installer.js` 已有 Codex hooks.json 读写和 `installCodexHooks()` 雏形。
- `src/lib/hook-ingest.cjs`、`src/lib/ingest-handler.js`、`src/lib/spool-drainer.js` 已经形成通用 hook ingestion + 离线 spool 管道。
- `src/lib/store.js` 已有 `runtime_events`、`metric_points`、`state_snapshots`、`source_health` 等通用表结构，字段中已经包含 `runtime`。
- `docs/modules/data-sources.md` 和 `docs/modules/metric-model.md` 已定义 multi-runtime adapter/resolver 模型，优先级为 `telemetry > hook > 状态文件`。
- `hooks/post-install.js` 当前明确写着 “Codex hooks: not yet adapted, skip for now”，这是要补齐的生命周期缺口。

zylos-core 最新 `main`（本地确认 commit `106fbdf`）中的相关事实：

- `cli/lib/runtime/codex-context-monitor.js` 已经实现 `CodexContextMonitor`。
- 该 monitor 的首选数据源是 Codex rollout JSONL 中的 `event_msg:token_count` 事件，读取 `payload.info.last_token_usage.input_tokens` 作为当前 context fill，读取 `payload.info.model_context_window` 作为窗口上限。
- 该 monitor 已通过 `cli/lib/runtime/codex.js#getContextMonitor()` 暴露给 activity-monitor runtime context monitor，用于阈值和新会话判断。
- activity-monitor 已经在 Codex Runtime 下通过该 monitor 的轮询结果触发 early memory sync 与 new-session handoff；这说明 context usage 的控制流能力已经存在。
- 当前仍需要为 Dashboard 固化一个稳定、可消费、与 Claude context 展示同语义的 Codex 状态输出，或让 Dashboard 直接复用 activity-monitor 已有的 monitor/check 结果；Dashboard 不应另起一套 Codex rollout/SQLite 解析。

当前代码接入点（已核对）：

- zylos-core `cli/lib/runtime/context-monitor-base.js` 的 `check()` 已把 `getUsage()` 结果标准化为 `{ used, ceiling, ratio }`。
- activity-monitor `scripts/adapters/runtime-components.js` 每 30 秒调用 adapter-provided context monitor；`onExceed` 里用同一组 `{ used, ceiling, ratio }` 触发 `enqueueContextRotationHandoff()`，`onEarlyThreshold` 触发 memory sync。
- activity-monitor `scripts/monitor.js` 的 `enqueueContextRotationHandoff()` 再调用 zylos-core `cli/lib/runtime/session-handoff.js#enqueueNewSession()`，Codex runtime 下生成 `$new-session` 控制消息。
- Dashboard `src/index.js` 目前在非 Claude runtime 下跳过 `StatuslineCollector` 和 `ConversationCollector`，因此 Codex context usage 不会进入 Dashboard 的 `metric_points`。
- Dashboard `src/lib/metric-resolver.js` 已有 `context_pct` resolver chain：`statusline.actual -> rollout.actual -> derived_token_estimate.estimated`，所以 Codex 最小接入路径是把 activity-monitor 的 Codex context poll result 写成 `source='rollout'` 的 `context_pct` metric，或写入状态文件后由 Dashboard collector 转成该 metric。
- Dashboard 现有 `src/lib/collectors/statusline-collector.js` 只读取 `activity-monitor/statusline.json`，并固定写 `runtime: 'claude'`、`source: 'statusline'`；Codex 不能直接复用这个 collector，需要新增小型 Codex context collector，或抽出通用 context-state collector。

实测 Codex rollout JSONL 字段：

- 当前 session 的 active rollout 可通过 `~/.codex/state_5.sqlite` 的 `threads.rollout_path` 定位；本地文件扫描 `~/.codex/sessions/**/rollout-*.jsonl` 可作为降级定位方式，但 SQLite 更精确。
- 最近一条 `event_msg` / `token_count` 事件的 `payload.info` 包含 `total_token_usage`、`last_token_usage`、`model_context_window`。
- `last_token_usage.input_tokens` 是当前 turn 发给模型的上下文 token，可作为 context window fill，用于 context usage / new-session threshold。
- `model_context_window` 是当前有效 context window 上限，可直接作为分母；样本中没有单独出现 `context_window` 或 `effective_context_window_percent` 字段。
- `total_token_usage.input_tokens` 是 session 累计输入 token，适合用量/成本统计，不适合用作 context fill，因为它会跨 turn 累加。
- 因此 Codex context percentage 的直接口径是 `last_token_usage.input_tokens / model_context_window * 100`；如果 JSONL 中缺 `model_context_window`，再降级到 `~/.codex/models_cache.json` 或 zylos-core fallback 口径。
- 同一 `token_count` 事件还带 `rate_limits.primary` / `rate_limits.secondary`，样本中分别对应 5h（`window_minutes=300`）和 weekly（`window_minutes=10080`）使用率及 `resets_at`。
- `task_complete` 事件包含 `duration_ms` 与 `time_to_first_token_ms`，可直接支持 turn duration 与 TTFT。
- `response_item` 事件包含 `function_call` / `function_call_output`，可用 `call_id` 关联工具调用历史；MVP 只保存工具名、call_id、时间和脱敏摘要，不保存 `arguments` / `output` 原文。

## 当前结论：MVP 不强依赖 OTLP

对齐当前 Claude Runtime 页面指标，Codex 第一版可以采用 **hooks + rollout JSONL + activity-monitor/config**，不必把 OTLP 放在阻塞路径：

| 页面指标 / 能力 | Codex MVP 来源 | 是否需要 OTLP | 说明 |
|---|---|---:|---|
| Agent 状态、当前工具、等待人工、stuck | Codex hooks -> `/api/ingest` -> state-engine | 否 | 与 Claude Runtime 的 hook/state-engine 路径一致 |
| 工具调用历史 | hooks 为主，JSONL `response_item.function_call` 可补历史 | 否 | 完整 arguments/output 不落库 |
| 工具耗时 | hook Pre/Post 时间差；JSONL function_call/function_call_output 时间差 | 否 | OTel 后续可提供更准 histogram/span |
| Context 使用率 | JSONL `token_count.last_token_usage.input_tokens / model_context_window` | 否 | zylos-core 已用同口径驱动 new-session |
| New session threshold | zylos config `codex_new_session_threshold`，默认 75 | 否 | `CodexAdapter#getContextMonitor()` 已这样实现 |
| 5h / weekly rate limit | JSONL `token_count.rate_limits.primary/secondary` | 否 | 映射到 `rate_limit` / `rate_limit_7d` |
| Token session/today/7d | JSONL `token_count` 增量或去重后的累计差值 | 否 | 写入现有 `api_request_tokens` 聚合表即可复用 UI |
| Cache hit | JSONL `cached_input_tokens / input_tokens` | 否 | 与现有 `cache_hit_rate` 聚合接口兼容 |
| Cost session/today/7d | JSONL token × Dashboard `modelPrices` | 否 | 借鉴 Claude `ConversationCollector#_calculateCost()` |
| Turn duration / TTFT | JSONL `task_complete.duration_ms/time_to_first_token_ms` | 否 | 写入 `metric_points`，可做当前值和趋势 |
| PM2/system/communication/scheduler | 现有 collectors / C4 / scheduler | 否 | runtime 无关 |

OTLP 仍然有价值，但定位为第二层增强：更标准的 tool duration histogram、trace waterfall、transport/websocket/API 细节、hook 开销，以及与外部 observability 后端对齐。它不应阻塞当前 Dashboard 指标对齐。

## 当前本机配置审计（2026-05-23）

本地 Codex Runtime 与计划的对齐状态：

- `zylos config get runtime` 当前为 `codex`。
- `codex_new_session_threshold` 当前为 `75`，`new_session_threshold` 当前为 `70`；这与 zylos-core `CodexAdapter#getContextMonitor()` 的默认策略一致。
- `~/.codex/config.toml` 目前主要配置 trusted projects 和 model NUX；未看到 `[otel]` 配置。
- `~/zylos/.codex/config.toml` 已启用 `features.multi_agent = true`，并隐藏交互式 notice，符合 headless runtime 需要。
- `~/.codex/hooks.json` 当前仍是 spike logger 配置，command 指向 `spike/codex-hook-logger.mjs`，不是 Dashboard `hook-ingest.cjs`。
- `~/zylos/components/dashboard/spike/codex-hooks.jsonl` 最后更新时间是 2026-05-11，说明当前生产 Dashboard 采集链并没有依赖这条 spike hook 持续入库。
- Dashboard DB 当前只有 Codex 的 PM2/system 指标；没有 `runtime_events` 的 Codex hook 事件，也没有 Codex `context_pct`、`rate_limit`、`api_request_tokens`、`api_request_cost`、`ttft` 等指标。
- Dashboard `/api/state` 已按 runtime 读取 zylos config 的 `codex_new_session_threshold`，但 runtime actions metadata 仍需确认统一读取同一来源，避免 UI 设置面板显示旧默认。
- Dashboard config 当前没有 Codex/OpenAI model price 前缀；第一批实现需要补默认价格或要求用户在 settings 中配置，否则 token 可显示但 cost 应标 missing。

当前建议：

1. 不手工覆盖 `~/.codex/hooks.json`；通过 Dashboard implementation PR 修 `HookInstaller.installCodexHooks()`、post-install runtime 分支和测试后再由组件安装/升级流程写入。
2. 第一批 implementation 不启用 OTLP；先落 `CodexRolloutCollector` 和 hook ingestion，使当前页面指标可用。
3. 将 spike logger 保留为历史证据，但不要作为生产采集路径；脱敏样本进入 `test/fixtures/codex/`。
4. Codex cost 第一版沿用 Dashboard `modelPrices`，缺价格时明确降级，不估算未知模型。

## 适配目标

### 必须达到

1. Dashboard 在 Codex Runtime 下能自动安装和卸载 Dashboard hook。
2. Codex hook 事件能进入现有 `/api/ingest` 管道，落入 `runtime_events`，并能驱动状态机。
3. Codex rollout JSONL 能被 Dashboard 增量读取，写入现有 `metric_points` 聚合模型。
4. Codex 的 token、context、rate limit、cost、工具调用、工具耗时、turn 耗时、TTFT、permission 等核心指标能在 UI 中正常展示或明确降级。
5. 不采集、不落库、不展示 raw prompt、完整工具输入输出、用户邮箱等敏感字段。
6. Claude Runtime 现有能力不回退。

### 暂不追求

- 不在第一轮实现 Codex 模型切换和推理力度切换；`actions.js` 当前的 not implemented 可以保留，另开工作项。
- 不依赖 raw API body 或完整工具内容。
- 不要求第一轮接入 Codex OTLP；OTLP 作为后续增强，不阻塞 MVP。
- 不要求 Codex 与 Claude 的每个指标完全同源，只要求统一语义和可解释的 source/confidence。

## 总体设计

Codex Runtime 适配应沿用 Dashboard 已有的三层数据源模型：

```text
Codex CLI
  ├─ hooks.json command hooks
  │    └─ hook-ingest.cjs
  │         └─ /api/ingest
  │              └─ runtime_events + state_engine
  ├─ rollout JSONL
  │    └─ CodexRolloutCollector
  │         └─ metric_points + runtime_events
  ├─ zylos-core/activity-monitor state files
  │    └─ File/System/PM2 collectors
  └─ OTLP logs/metrics/traces (enhancement)
       └─ dashboard OTLP receiver / collector
            └─ metric_points + activity_facts
```

解析层按 runtime 分 codec：

- Claude codec：继续消费 `claude_code.*`。
- Codex codec：新增或补齐 `codex.*` logs/metrics/traces 映射。

Resolver 仍然只对外暴露统一指标，不让前端直接感知底层来源差异。

## 分阶段实施

### Phase 0：收敛现状与样本

交付：

- 把现有 spike 结论整理到文档和测试 fixture，避免只存在运行时数据目录。
- 固化 Codex hook payload 的最小可用字段集。
- 固化 Codex OTLP logs/metrics/traces 的可用事件清单和字段映射表。
- 明确这些字段是 Dashboard 的 defensive mapping 输入假设，不是要求 Codex CLI 保持的双向契约。

实现建议：

- 新增 `test/fixtures/codex/`，放脱敏后的 hook 和 OTLP 样本。
- 新增脚本或测试复用 `spike/analyze-codex-spike.mjs` 的分析逻辑，但不要依赖 `~/zylos/components/dashboard/spike` 运行时目录。
- 明确删除或脱敏字段：`prompt`、`last_assistant_message`、`tool_input.command`、`tool_response`、`user.email`、`user.account_id`。
- mapper 必须忽略未知字段；缺少非关键字段时返回 partial/degraded，而不是拒绝整条事件。
- 只有 `runtime`、`event name`、`timestamp/received_at`、`session_id` 这类最小字段可作为 hard requirement；其余字段都按 best-effort 解析。

验收：

- fixture 中不含真实 prompt、邮箱、账户 ID、完整命令输出。
- 测试能从 fixture 验证 Codex hook/OTLP 字段 shape。
- 同一 fixture 删除可选字段后，mapper 仍能产出降级 canonical event。

### Phase 1：Codex hook 生命周期接入

交付：

- `post-install` 在当前 runtime 为 Codex 时安装 Dashboard hooks。
- `pre-uninstall` 能清理 Claude 和 Codex hooks。
- Codex hook 事件通过现有 `hook-ingest.cjs` 写入 `/api/ingest`，失败时 spool。
- Codex hook ingestion 不阻塞 runtime。

实现建议：

- 复核 `src/lib/hook-installer.js` 的 Codex hooks.json 格式是否与当前 Codex CLI 版本一致。
- Codex hook command 显式注入：
  - `ZYLOS_RUNTIME=codex`
  - `ZYLOS_DIR=<zylos dir>`
  - `DASHBOARD_BASE_URL=http://127.0.0.1:<port>`
- Codex hook timeout 设置为 1-5 秒；由于 Codex hook 同步阻塞，hook 脚本必须只做本地 POST/spool，不能做重计算。
- `hooks/post-install.js` 去掉 “Codex hooks skipped” 的临时代码，改为按 runtime 调用 `HookInstaller.install()`.

验收：

- 在 Codex Runtime 下安装后，`~/.codex/hooks.json` 包含 Dashboard hook。
- 执行一轮 Codex 会话后，`runtime_events` 有 `runtime="codex"` 的 `session_start`、`user_prompt_submit`、`pre_tool_use`、`post_tool_use`、`stop`。
- Dashboard 不在线时，事件写入 spool；Dashboard 恢复后 drain 入库且按 `ingest_id` 去重。

### Phase 2：Codex hook 事件语义映射

交付：

- Codex hook payload 被映射为 Dashboard canonical event。
- `state-engine` 能用 Codex hook 推导 `RUNNING_TOOL`、`WAITING_HUMAN`、`IDLE`、`POSSIBLY_STUCK`。
- 工具调用列表、工具耗时、permission request 等面板支持 Codex。

实现建议：

- 用 `session_id + turn_id + tool_use_id` 作为 hook 关联主键。
- `PreToolUse` 打开 running tool。
- `PostToolUse` 关闭 running tool，并记录 duration；如果 payload 无 duration，则用 Pre/Post 时间差。
- `PermissionRequest` 在 Codex 上 confidence 先标为 `medium`，因为某些场景缺少 Claude 那样稳定的 tool_use_id 匹配。
- `Stop` 关闭 open turn，但不保存 `last_assistant_message` 原文，只保留长度、是否存在、截断摘要或 hash。

验收：

- 注入 Codex fixture 后，状态机快照按预期变化。
- 对缺失 PostToolUse 的场景，状态机会进入 possibly stuck，而不是永久 busy。
- 前端 Codex degraded banner 不应隐藏已支持的工具/状态能力。

### Phase 3：Codex rollout JSONL collector

交付：

- Dashboard 能定位 active Codex rollout JSONL，并增量读取新事件。
- `token_count`、`task_complete`、`response_item.function_call/function_call_output` 被映射到现有 `metric_points` / `runtime_events`。
- Codex token、cache hit、rate limit、context percentage、turn duration、TTFT、cost 可以进入当前 Overview 与趋势图。

字段映射初稿：

| Dashboard 指标 | Codex 来源 | 映射 |
|---|---|---|
| `context_pct` | JSONL `token_count.info.last_token_usage.input_tokens` + `model_context_window` | percentage |
| `rate_limit` | JSONL `token_count.rate_limits.primary` | 5h percent + reset |
| `rate_limit_7d` | JSONL `token_count.rate_limits.secondary` | weekly percent + reset |
| `api_request_tokens` | JSONL `token_count.info.last_token_usage` 或累计差值 | input/output/cache_read/reasoning |
| `cache_hit_rate` | JSONL `cached_input_tokens / input_tokens` | ratio |
| `api_request_cost` | JSONL token × Dashboard `modelPrices` | same pattern as Claude `ConversationCollector` |
| `ttft` | JSONL `task_complete.time_to_first_token_ms` | ms |
| `turn_duration` | JSONL `task_complete.duration_ms` | ms |
| `tool_calls` | JSONL `response_item.function_call` + hooks | tool_name, call_id |
| `tool_duration` | hook Pre/Post or JSONL call/output timestamp delta | ms |

安全处理：

- 不保存 `prompt`、`arguments`、`output` 原文。
- `cwd`、file path、command 等只允许进入 sanitized summary，不进入 raw metadata。
- JSONL collector 只读取白名单 event：`token_count`、`task_complete`、`response_item` 的工具 envelope；`agent_message` / `user_message` 默认不持久化正文。

验收：

- 用脱敏 Codex rollout fixture 跑 collector 单元测试。
- `metric_points` 中有 Codex `context_pct`、`rate_limit`、`rate_limit_7d`、`api_request_tokens`、`api_request_cost`、`cache_hit_rate`、`ttft`、`turn_duration`。
- 前端现有 `/api/metrics/*` 和 `/api/metrics/aggregate` 在 Codex Runtime 下能显示 Overview 指标。

### Phase 4：Context usage、threshold 与成本口径

交付：

- Codex context usage、new-session threshold、token/cost 展示有明确来源和置信度。

实现路径：

- 责任边界：zylos-core/activity-monitor 已负责基于 `CodexContextMonitor` 检测 Codex context usage，并在达到阈值时触发 early memory sync / new-session handoff；Dashboard 负责把同一口径展示出来，不在 Dashboard 内重复实现 Codex rollout/SQLite 解析。
- 当前 zylos-core 已有 `cli/lib/runtime/codex-context-monitor.js`，并能从 Codex `token_count` 事件读取 used tokens 与 context window；activity-monitor 的 Codex 轮询路径已经证明该数据可用于控制流。
- Threshold 来源与 activity-monitor 对齐：读取 zylos config `codex_new_session_threshold`，默认 75；前端 threshold marker 不使用 Claude 默认 70。
- 首选方案：Dashboard 直接从 Codex rollout collector 写入 `context_pct`，并从 config/API 返回 `new_session_threshold`；activity-monitor 可另行持久化 `{ used, ceiling, ratio, threshold }` 作为交叉校验。
- 成本口径借鉴 Claude `ConversationCollector#_calculateCost()`：把 JSONL token 映射成 input/output/cacheRead/cacheCreation/reasoning 维度，再按 Dashboard `modelPrices` 计算 `api_request_cost`。无官方 billed-cost 字段时，source/confidence 应清楚标成 priced/estimated。
- 工作归属：zylos-dashboard 负责 rollout locator/collector、price mapping、resolver/UI 接入；zylos-core/activity-monitor 继续负责 new-session 控制流，必要时仅补充状态文件作为交叉校验。

验收：

- Codex Runtime 下 Overview 显示 context 使用率。
- 阈值提示、新会话倒计时、Dashboard context 卡片的口径一致。
- Codex Runtime 下 token、cache、cost session/today/7d 正常显示。
- 如果 price table 缺少当前 model，显示 token 但 cost 标为 missing/estimated unavailable，不瞎填美元。

### Phase 5：Codex OTLP 增强

交付：

- Dashboard 能接收 Codex OTLP HTTP JSON（后续再扩展 protobuf/gRPC）。
- Codex codec 将 `codex.*` logs/metrics/traces 转为补充指标。
- OTel collector liveness 与 runtime progress 分开记录。

增强项：

| Dashboard 指标 | Codex OTel 来源 | 用途 |
|---|---|---|
| `tool_duration` | `codex.tool_result.duration_ms` 或 `codex.tool.call.duration_ms` | 更准确 histogram |
| `llm_latency` | websocket request/event duration 或 traces | P50/P95/P99 |
| `ttft` | `codex.turn.ttft.duration_ms` | 与 JSONL 交叉校验 |
| `turn_duration` | `codex.turn.e2e_duration_ms` | 与 JSONL 交叉校验 |
| source health | `codex.hooks.run.duration_ms`、websocket metrics | 采集链路诊断 |

安全处理：

- 不保存 `prompt`、`arguments`、`output` 原文。
- `user.email`、`user.account_id` 只允许落 hash 或直接丢弃。

验收：

- 用脱敏 Codex OTLP fixture 跑 codec 单元测试。
- 同一指标有 JSONL/hook 和 telemetry 双来源时，Resolver 可选择 telemetry 作为增强来源，JSONL/hook 作为 fallback/alternative。

### Phase 6：前端产品化

交付：

- Codex Runtime 下不再只显示笼统 degraded banner，而是按指标能力显示：
  - supported 且 ok：正常显示。
  - supported 但 missing/stale：灰态或黄灯。
  - unsupported：隐藏或标记 not available。
- Runtime info 卡展示 Codex model、reasoning effort、sandbox/approval policy、session/conversation ID。
- 数据源状态面板显示 hook、OTel、state file 三条链路的 liveness。

验收：

- 切到 Codex Runtime 后，PM2/system/communication/scheduler 保持可用。
- Codex hook 到达后，工具和状态卡从 degraded 转为 ok。
- JSONL 到达后，token/context/rate/cost/TTFT 指标从 degraded 转为 ok。
- OTel 到达后，latency/tool duration/source health 可升级为 telemetry。

## 工作拆分建议

建议拆成 6 个独立 PR：

1. **docs/fixtures**：固化 Codex spike 结论、脱敏 fixture、字段契约测试。
2. **hooks**：Codex hook install/uninstall + ingestion 验证。
3. **state**：Codex hook canonical mapping + state-engine 支持。
4. **jsonl**：Codex rollout locator/collector + token/context/rate/cost/TTFT 映射。
5. **otel**：Codex OTLP receiver/codec + telemetry enhancement。
6. **ui**：Codex capability-aware 展示和 source health 面板。

这样每个 PR 都可以单独验收，不会把 hook、OTel、UI 一次性耦合。

## 风险与处理

| 风险 | 影响 | 处理 |
|---|---|---|
| Codex hook 同步阻塞 | 卡住 runtime | hook 脚本只做本地 POST/spool，超时 1-5 秒，失败不抛出 |
| Codex hook schema 变动 | ingestion 失败 | canonical mapper 忽略未知字段，fixture 覆盖最低字段契约 |
| OTLP 字段高基数 | DB 膨胀、UI 噪音 | 丢弃 user/email/path/raw content，按指标白名单入库 |
| raw prompt/tool I/O 泄漏 | 安全风险 | sanitizer 默认拒绝 raw content，只保留长度、工具名、成功状态、耗时 |
| price table 缺少 Codex model | cost 无法计算 | token 正常显示，cost 标 missing；允许在设置中补 model prefix 价格 |
| Claude 能力回退 | 影响现有用户 | 所有改动按 runtime 分支，Claude fixture/测试保持通过 |

## 验收清单

- `npm test` 通过。
- Codex hook install/uninstall 单元测试通过。
- Codex hook fixture 能写入 `runtime_events`，并驱动 state snapshot。
- Codex rollout fixture 能写入 `metric_points`，Resolver 返回 context/rate/token/cost/TTFT 指标。
- Codex OTLP fixture 能写入增强指标，Resolver 可在 telemetry/source priority 下选择或展示 alternative。
- Dashboard 在 Codex Runtime 下不展示 Claude-only 面板，但展示已支持的通用/Codex 指标。
- Spool 机制在 Dashboard 离线时仍然工作。
- 源码和测试 fixture 中不包含真实 prompt、完整工具输出、邮箱、账号 ID、token 或 secret。

## 第一批落地动作

1. 从现有 spike 样本生成脱敏 fixtures。
2. 给 `HookInstaller.installCodexHooks()` 和 post-install runtime 分支补测试。
3. 将 Codex 的 5 个已验证 hook 事件接入 canonical event mapper。
4. 新增 `CodexRolloutCollector`，先接 `context_pct`、`rate_limit`、`rate_limit_7d`、`api_request_tokens`、`api_request_cost`、`cache_hit_rate`、`ttft`、`turn_duration`。
5. 新增 Codex source health：`codex_hooks`、`codex_rollout`，OTLP 后续再加 `codex_otel`。
6. 补一个最小 Codex Overview 验收：hook 到达后状态/工具卡可用，JSONL 到达后 token/context/rate/cost/TTFT 可用。
