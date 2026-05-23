# Codex Runtime 适配计划

## 背景

Zylos Dashboard 当前已经具备多运行时的基础形态：PM2、系统健康、通信、调度等数据源不依赖 Claude；前端也已经有 Codex degraded mode，用于隐藏 Claude-only 面板并保留通用监控能力。但 Codex Runtime 还没有达到与 Claude Runtime 等价的可观测体验，主要缺口在实时 runtime 事件、token/context/cost 映射、hook 安装生命周期，以及 Codex 专属数据源的验证与产品化。

本计划的目标是把 Codex Runtime 从“可降级运行”推进到“可被 Dashboard 正式观测和诊断”。

## 目标状态表

适配完成后，Dashboard 在 Codex Runtime 下不应只有一个笼统的 degraded mode，而应按面板和指标分别呈现目标状态：

| Dashboard 区域 | Codex 目标状态 | 期望表现 | 主要来源 | 备注 |
|---|---|---|---|---|
| Agent 状态 / 当前工具 | 正常 | 显示 idle/running/waiting/stuck 与当前工具名 | Codex hook + state engine | Phase 1-2 先落地 |
| 工具调用流 / 工具耗时 | 正常 | 展示工具名、成功/失败、耗时、来源置信度 | OTel 优先，hook fallback | 不展示完整输入/输出 |
| Token 使用 / cache hit | 正常或部分降级 | 有 OTel 时正常；缺字段时显示 partial/degraded | Codex OTel | Phase 3 验证字段稳定性 |
| Context 使用率 / 新会话阈值 | 部分降级到正常 | activity-monitor 已能用 Codex context usage 触发 new-session；Dashboard 需要接入可展示的状态输出 | zylos-core CodexContextMonitor + activity-monitor | 跨组件展示契约待固化，见 Phase 4 |
| Cost / 花费趋势 | 降级 | 若无稳定价格/成本来源，只显示 token usage，不估算成本 | OTel + 后续 pricing source | 不做不透明推算 |
| Turn 延迟 / TTFT | 正常 | 显示 turn duration、TTFT、P50/P95 | Codex OTel metrics/traces | Phase 3 |
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

## 适配目标

### 必须达到

1. Dashboard 在 Codex Runtime 下能自动安装和卸载 Dashboard hook。
2. Codex hook 事件能进入现有 `/api/ingest` 管道，落入 `runtime_events`，并能驱动状态机。
3. Codex OTel 能被 Dashboard 接收、解析和聚合到统一指标模型。
4. Codex 的 token、context、工具调用、工具耗时、turn 耗时、TTFT、permission 等核心指标能在 UI 中正常展示或明确降级。
5. 不采集、不落库、不展示 raw prompt、完整工具输入输出、用户邮箱等敏感字段。
6. Claude Runtime 现有能力不回退。

### 暂不追求

- 不在第一轮实现 Codex 模型切换和推理力度切换；`actions.js` 当前的 not implemented 可以保留，另开工作项。
- 不依赖 raw API body 或完整工具内容。
- 不要求 Codex 与 Claude 的每个指标完全同源，只要求统一语义和可解释的 source/confidence。

## 总体设计

Codex Runtime 适配应沿用 Dashboard 已有的三层数据源模型：

```text
Codex CLI
  ├─ hooks.json command hooks
  │    └─ hook-ingest.cjs
  │         └─ /api/ingest
  │              └─ runtime_events + state_engine
  ├─ OTLP logs/metrics/traces
  │    └─ dashboard OTLP receiver / collector
  │         └─ metric_points + activity_facts
  └─ zylos-core/activity-monitor state files
       └─ File/System/PM2 collectors
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

### Phase 3：Codex OTel 接收与 codec

交付：

- Dashboard 能接收 Codex OTLP HTTP JSON（后续再扩展 protobuf/gRPC）。
- Codex codec 将 `codex.*` logs/metrics/traces 转为 `metric_points` 和 `activity_facts`。
- OTel collector liveness 与 runtime progress 分开记录。

字段映射初稿：

| Dashboard 指标 | Codex 来源 | 映射 |
|---|---|---|
| `token_usage` | `codex.sse_event` logs 或 `codex.turn.token_usage` metrics | input/output/cached/reasoning/tool token |
| `cache_hit_rate` | `cached_token_count` + `input_token_count` | cached / (cached + input) |
| `tool_calls` | `codex.tool_result` logs 或 `codex.tool.call` metrics | tool_name, call_id, success |
| `tool_duration` | `codex.tool_result.duration_ms` 或 `codex.tool.call.duration_ms` | ms |
| `llm_latency` | websocket request/event duration 或 traces | P50/P95/P99 |
| `ttft` | `codex.turn.ttft.duration_ms` | ms |
| `turn_duration` | `codex.turn.e2e_duration_ms` | ms |
| `session_lifecycle` | `codex.conversation_starts` + hook SessionStart | conversation/session start |

安全处理：

- 不保存 `prompt`、`arguments`、`output` 原文。
- `user.email`、`user.account_id` 只允许落 hash 或直接丢弃。
- `cwd`、file path、command 等只允许进入 sanitized summary，不进入 raw metadata。

验收：

- 用脱敏 Codex OTLP fixture 跑 codec 单元测试。
- `metric_points` 中有 Codex token、tool duration、TTFT、turn duration 指标。
- 同一指标有 hook 和 telemetry 双来源时，Resolver 选择 telemetry，hook 作为 fallback/alternative。

### Phase 4：Context usage 与成本口径

交付：

- Codex context usage 从 degraded/missing 变为 supported。
- Codex token/cost 展示有明确来源和置信度。

实现路径：

- 责任边界：zylos-core/activity-monitor 已负责基于 `CodexContextMonitor` 检测 Codex context usage，并在达到阈值时触发 early memory sync / new-session handoff；Dashboard 负责把同一口径展示出来，不在 Dashboard 内重复实现 Codex rollout/SQLite 解析。
- 当前 zylos-core 已有 `cli/lib/runtime/codex-context-monitor.js`，并能从 Codex `token_count` 事件读取 used tokens 与 context window；activity-monitor 的 Codex 轮询路径已经证明该数据可用于控制流。
- 首选方案：复用 activity-monitor 已有 Codex context monitor 结果，写入或暴露一个 Dashboard 可消费的状态输出，字段至少包含 runtime、used percentage、used tokens、context window、threshold、source、updated_at。
- Dashboard fallback：如果 activity-monitor context state 缺失，但 Codex OTel 有 token usage，则展示 token-only partial 状态；如果 token usage 和 context window 都缺失，则显示 missing，不做估算。
- 如果 Codex OTel 能稳定提供 `model_context_window`，或 Dashboard 能从已验证 model catalog 获得窗口大小，则 TelemetryAdapter 可作为更高优先级来源。
- 工作归属：zylos-core/activity-monitor 负责把现有 Codex context monitor 结果暴露成 Dashboard 可消费状态；zylos-dashboard 负责 FileAdapter/Resolver/UI 消费；跨组件验收需要同时覆盖两边。

验收：

- Codex Runtime 下 Overview 显示 context 使用率。
- 阈值提示、新会话倒计时、Dashboard context 卡片的口径一致。
- 如果只有 token usage 没有 context window，UI 明确标记为 partial/degraded。
- 如果 activity-monitor context state 不可用，Dashboard 不报错，不显示虚假的百分比。

### Phase 5：前端产品化

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
- OTel 到达后，token/latency 指标 source 从 hook/state file 升级为 telemetry。

## 工作拆分建议

建议拆成 5 个独立 PR：

1. **docs/fixtures**：固化 Codex spike 结论、脱敏 fixture、字段契约测试。
2. **hooks**：Codex hook install/uninstall + ingestion 验证。
3. **state**：Codex hook canonical mapping + state-engine 支持。
4. **otel**：Codex OTLP receiver/codec + metric resolver 映射。
5. **ui**：Codex capability-aware 展示和 source health 面板。

这样每个 PR 都可以单独验收，不会把 hook、OTel、UI 一次性耦合。

## 风险与处理

| 风险 | 影响 | 处理 |
|---|---|---|
| Codex hook 同步阻塞 | 卡住 runtime | hook 脚本只做本地 POST/spool，超时 1-5 秒，失败不抛出 |
| Codex hook schema 变动 | ingestion 失败 | canonical mapper 忽略未知字段，fixture 覆盖最低字段契约 |
| OTLP 字段高基数 | DB 膨胀、UI 噪音 | 丢弃 user/email/path/raw content，按指标白名单入库 |
| raw prompt/tool I/O 泄漏 | 安全风险 | sanitizer 默认拒绝 raw content，只保留长度、工具名、成功状态、耗时 |
| context usage 依赖 zylos-core | Dashboard 无法单独完成 | 明确作为跨组件依赖，Dashboard 显示 partial/degraded |
| Claude 能力回退 | 影响现有用户 | 所有改动按 runtime 分支，Claude fixture/测试保持通过 |

## 验收清单

- `npm test` 通过。
- Codex hook install/uninstall 单元测试通过。
- Codex hook fixture 能写入 `runtime_events`，并驱动 state snapshot。
- Codex OTLP fixture 能写入 `metric_points`，Resolver 返回 token/tool/latency 指标。
- Dashboard 在 Codex Runtime 下不展示 Claude-only 面板，但展示已支持的通用/Codex 指标。
- Spool 机制在 Dashboard 离线时仍然工作。
- 源码和测试 fixture 中不包含真实 prompt、完整工具输出、邮箱、账号 ID、token 或 secret。

## 第一批落地动作

1. 从现有 spike 样本生成脱敏 fixtures。
2. 给 `HookInstaller.installCodexHooks()` 和 post-install runtime 分支补测试。
3. 将 Codex 的 5 个已验证 hook 事件接入 canonical event mapper。
4. 新增 Codex source health：`codex_hooks` 和 `codex_otel`。
5. 补一个最小 Codex Overview 验收：hook 到达后状态/工具卡可用，OTel 到达后 token/TTFT 可用。
