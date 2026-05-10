# Codex Runtime 数据样例

> 数据来源：Codex CLI v0.128/v0.130 隔离 spike、OTLP 本地 collector、项目级 hook logger。
> 本文只保留脱敏后的代表性结构。真实 `session_id`、`turn_id`、`conversation.id`、账号、邮箱、主机名、prompt/tool output 原文、绝对工作路径均已替换。

## 采集通道总览

| 通道 | 配置要求 | 提取方式 | 适合用途 | 默认处理 |
|------|----------|----------|----------|----------|
| Hook | `.codex/hooks.json` 或用户级 hooks；需要在 Codex `/hooks` 界面 review/trust | hook 命令从 stdin 读取 JSON，写入 JSONL | 工具调用、权限请求、compact 生命周期、turn 边界 | 保留结构化字段，strip/hash prompt 与工具 I/O |
| OTel Logs | `~/.codex/config.toml` `[otel].exporter` 指向本地 OTLP HTTP collector | collector 接收 OTLP JSON，展开 `resourceLogs[].scopeLogs[].logRecords[]` | 会话、prompt、WebSocket、SSE、工具决策/结果 | 保留计数/状态/耗时/token，默认不存原文 |
| OTel Metrics | `[otel].metrics_exporter` 必须显式配置；默认不是本地 OTLP | collector 展开 `resourceMetrics[].scopeMetrics[].metrics[]` | token、TTFT/TTFM、工具耗时、thread/shell/plugin 指标 | 可持久化聚合指标 |
| OTel Traces | `[otel].trace_exporter` 必须显式配置 | collector 展开 `resourceSpans[].scopeSpans[].spans[]` | 调试执行链路、定位慢路径 | 视为实现级补充，不作为稳定 UI 合约 |
| Rollout JSONL | Codex 默认生成 | 读取 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | token/rate limit/response item 诊断 | 默认不进入 dashboard persistence |

## Hook 样例

### 配置要求

```json
{
  "hooks": {
    "SessionStart": [{ "command": "node ./hook-logger.mjs SessionStart" }],
    "UserPromptSubmit": [{ "command": "node ./hook-logger.mjs UserPromptSubmit" }],
    "PreToolUse": [{ "command": "node ./hook-logger.mjs PreToolUse" }],
    "PostToolUse": [{ "command": "node ./hook-logger.mjs PostToolUse" }],
    "PermissionRequest": [{ "command": "node ./hook-logger.mjs PermissionRequest" }],
    "Stop": [{ "command": "node ./hook-logger.mjs Stop" }],
    "PreCompact": [{ "command": "node ./hook-logger.mjs PreCompact" }],
    "PostCompact": [{ "command": "node ./hook-logger.mjs PostCompact" }]
  }
}
```

Hook logger 读取 stdin JSON；需要影响权限请求时，`PermissionRequest` 可从 stdout 返回 allow/deny 决策。

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "message": "dashboard spike allow"
    }
  }
}
```

### `SessionStart`

触发条件：Codex session 启动。TUI 路径已实测；`source` 可表示 `startup` 等来源。

```json
{
  "session_id": "session-uuid",
  "transcript_path": "~/.codex/sessions/2026/05/10/rollout-*.jsonl",
  "cwd": "/workspace/project",
  "hook_event_name": "SessionStart",
  "model": "gpt-5.5",
  "permission_mode": "default",
  "source": "startup"
}
```

提取方式：按 `hook_event_name == "SessionStart"` 过滤 hook JSONL。

Dashboard 用途：session 边界、模型/权限模式快照、工作目录关联。`transcript_path` 和 `cwd` 属于本机路径，默认只在本机展示或 hash。

### `UserPromptSubmit`

触发条件：用户提交一轮输入。

```json
{
  "session_id": "session-uuid",
  "turn_id": "turn-uuid",
  "transcript_path": "~/.codex/sessions/2026/05/10/rollout-*.jsonl",
  "cwd": "/workspace/project",
  "hook_event_name": "UserPromptSubmit",
  "model": "gpt-5.5",
  "permission_mode": "default",
  "prompt": "[REDACTED_USER_PROMPT]"
}
```

行为特征：
- `turn_id` 从用户输入开始出现，可关联同一轮的 tool/stop/compact 事件。
- `prompt` 是完整原文，可能包含 C4 注入消息、业务上下文或机密，默认不持久化。

### `PreToolUse`

触发条件：Codex 准备调用工具前。一次权限请求场景中可能出现两条 `PreToolUse`：第一条来自工具规划，第二条进入实际审批/执行路径；以 `tool_use_id` 区分。

```json
{
  "session_id": "session-uuid",
  "turn_id": "turn-uuid",
  "transcript_path": "~/.codex/sessions/2026/05/10/rollout-*.jsonl",
  "cwd": "/workspace/project",
  "hook_event_name": "PreToolUse",
  "model": "gpt-5.5",
  "permission_mode": "default",
  "tool_name": "Bash",
  "tool_input": {
    "command": "mkdir -p workspace/example && printf '[REDACTED]' > workspace/example/out.txt"
  },
  "tool_use_id": "call_abc123"
}
```

Dashboard 用途：工具调用计数、工具类型分布、审批前风险分类。`tool_input` 可能包含 shell 命令、文件路径、prompt 片段或 secrets，默认 strip；需要调试时按 owner 开关保留短摘要。

### `PermissionRequest`

触发条件：非 bypass 权限路径下，工具调用需要权限。实测方式：只读 sandbox 下请求写文件，触发 `PermissionRequest`。

```json
{
  "session_id": "session-uuid",
  "turn_id": "turn-uuid",
  "transcript_path": "~/.codex/sessions/2026/05/10/rollout-*.jsonl",
  "cwd": "/workspace/project",
  "hook_event_name": "PermissionRequest",
  "model": "gpt-5.5",
  "permission_mode": "default",
  "tool_name": "Bash",
  "tool_input": {
    "command": "mkdir -p workspace/example && printf '[REDACTED]' > workspace/example/out.txt"
  }
}
```

行为特征：
- 实测 `permission_mode` 为 `default`；bypass 模式不会触发权限请求。
- 该事件没有 `tool_use_id`。同一轮相邻的 `PreToolUse` / `PostToolUse` 有 `tool_use_id`，需要通过 `turn_id`、`tool_name`、`tool_input` 摘要和时间顺序关联。
- Hook stdout 可以返回 allow/deny 决策；dashboard 采集 handler 默认不应自动放行生产请求。

### `PostToolUse`

触发条件：工具调用完成后。

```json
{
  "session_id": "session-uuid",
  "turn_id": "turn-uuid",
  "transcript_path": "~/.codex/sessions/2026/05/10/rollout-*.jsonl",
  "cwd": "/workspace/project",
  "hook_event_name": "PostToolUse",
  "model": "gpt-5.5",
  "permission_mode": "default",
  "tool_name": "Bash",
  "tool_input": {
    "command": "wc -c workspace/example/out.txt"
  },
  "tool_response": "[REDACTED_TOOL_OUTPUT]",
  "tool_use_id": "call_abc123"
}
```

行为特征：
- `tool_response` 是完整工具输出，可能包含文件内容、日志、密钥或路径。
- Codex hook payload 本身没有 `duration_ms`；工具耗时来自 OTel `codex.tool_result.duration_ms` 或 metric `codex.tool.call.duration_ms`。

### `Stop`

触发条件：一轮助手回复完成。

```json
{
  "session_id": "session-uuid",
  "turn_id": "turn-uuid",
  "transcript_path": "~/.codex/sessions/2026/05/10/rollout-*.jsonl",
  "cwd": "/workspace/project",
  "hook_event_name": "Stop",
  "model": "gpt-5.5",
  "permission_mode": "default",
  "stop_hook_active": false,
  "last_assistant_message": "[REDACTED_ASSISTANT_MESSAGE]"
}
```

Dashboard 用途：turn 完成边界、最后回复摘要、成功/中断状态推断。`last_assistant_message` 默认截断或省略。

### `PreCompact` / `PostCompact`

触发条件：手动 `/compact` 或自动 compact。当前实测为 manual `/compact`；payload 通过 `trigger` 区分。

```json
{
  "session_id": "session-uuid",
  "turn_id": "turn-uuid",
  "transcript_path": "~/.codex/sessions/2026/05/10/rollout-*.jsonl",
  "cwd": "/workspace/project",
  "hook_event_name": "PreCompact",
  "model": "gpt-5.5",
  "trigger": "manual"
}
```

```json
{
  "session_id": "session-uuid",
  "turn_id": "turn-uuid",
  "transcript_path": "~/.codex/sessions/2026/05/10/rollout-*.jsonl",
  "cwd": "/workspace/project",
  "hook_event_name": "PostCompact",
  "model": "gpt-5.5",
  "trigger": "manual"
}
```

行为特征：
- `trigger` 为 `manual` 或 `auto`。auto compact 未在本轮强制触发，但同字段结构由源码和手动实测共同确认。
- 可用 `PreCompact` / `PostCompact` 成对计算 compact 过程耗时；当前 payload 无 token 节省量，需要从 rollout 或后续状态源推断。

## OTel 配置样例

Codex 使用 TOML 配置，不使用 Claude Code 的 `OTEL_*` 环境变量。

```toml
[otel]
log_user_prompt = true
environment = "dev"
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318", protocol = "json" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318", protocol = "json" } }
metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318", protocol = "json" } }
```

配置要求：
- `exporter` 只启用 logs。
- `trace_exporter` 需要显式声明，否则 traces 默认不发本地 collector。
- `metrics_exporter` 需要显式声明，否则 metrics 默认走 Codex 内置 Statsig 路径。
- OTLP HTTP JSON 必须声明 `protocol = "json"`。
- `log_user_prompt = true` 会让 OTel logs 携带 prompt 原文；默认 dashboard 不应开启或持久化原文。

## OTel Logs 样例

OTLP HTTP 请求结构：

```json
{
  "resourceLogs": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "codex_cli_rs" } },
          { "key": "service.version", "value": { "stringValue": "0.128.0" } },
          { "key": "telemetry.sdk.language", "value": { "stringValue": "rust" } },
          { "key": "env", "value": { "stringValue": "dev" } }
        ]
      },
      "scopeLogs": [
        {
          "scope": { "name": "codex_otel.log_only" },
          "logRecords": [
            {
              "severityText": "INFO",
              "attributes": [
                { "key": "event.name", "value": { "stringValue": "codex.sse_event" } },
                { "key": "event.kind", "value": { "stringValue": "response.completed" } },
                { "key": "conversation.id", "value": { "stringValue": "conversation-uuid" } },
                { "key": "input_token_count", "value": { "intValue": "1200" } },
                { "key": "output_token_count", "value": { "intValue": "450" } },
                { "key": "cached_token_count", "value": { "intValue": "800" } },
                { "key": "reasoning_token_count", "value": { "intValue": "120" } },
                { "key": "tool_token_count", "value": { "intValue": "90" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### `codex.user_prompt`

触发条件：用户 prompt 提交；需要 logs exporter。`log_user_prompt=true` 时包含 `prompt` 原文。

```json
{
  "event.name": "codex.user_prompt",
  "prompt_length": "130",
  "prompt": "[REDACTED_USER_PROMPT]",
  "conversation.id": "conversation-uuid",
  "app.version": "0.128.0",
  "auth_mode": "Chatgpt",
  "originator": "codex_exec",
  "terminal.type": "iTerm2/3.6.10",
  "model": "gpt-5.5"
}
```

默认处理：保留 `prompt_length`，丢弃或 hash `prompt`。`user.email`、`user.account_id` 默认不出现在 dashboard API。

### `codex.tool_decision`

触发条件：Codex 决定是否调用某个工具。

```json
{
  "event.name": "codex.tool_decision",
  "tool_name": "Bash",
  "call_id": "call_abc123",
  "decision": "approved",
  "source": "policy",
  "conversation.id": "conversation-uuid",
  "model": "gpt-5.5"
}
```

用途：按工具统计允许/阻断/审批来源。`call_id` 可和 `codex.tool_result` 关联。

### `codex.tool_result`

触发条件：工具执行完成。

```json
{
  "event.name": "codex.tool_result",
  "tool_name": "Bash",
  "call_id": "call_abc123",
  "arguments": "[REDACTED_TOOL_ARGUMENTS]",
  "duration_ms": 184,
  "success": true,
  "output": "[REDACTED_TOOL_OUTPUT]",
  "conversation.id": "conversation-uuid",
  "model": "gpt-5.5"
}
```

行为特征：
- `duration_ms` 是工具耗时的主要来源之一。
- `arguments` 和 `output` 都可能包含敏感内容，默认不持久化原文。
- `success` 可用于工具失败率；失败原因需从脱敏后的输出摘要或后续结构化字段补充。

### `codex.sse_event`

触发条件：模型流式响应事件到达。完成类事件携带 token 计数。

```json
{
  "event.name": "codex.sse_event",
  "event.kind": "response.completed",
  "conversation.id": "conversation-uuid",
  "input_token_count": 1200,
  "output_token_count": 450,
  "cached_token_count": 800,
  "reasoning_token_count": 120,
  "tool_token_count": 90,
  "model": "gpt-5.5"
}
```

用途：按 conversation/turn 聚合 token。注意 `event.kind` 不同事件的字段完整度不同，adapter 需要容忍缺字段。

### `codex.websocket_request` / `codex.websocket_event`

触发条件：Codex 与模型服务的 WebSocket 请求和事件传输。

```json
{
  "event.name": "codex.websocket_request",
  "duration_ms": 732,
  "success": true,
  "conversation.id": "conversation-uuid",
  "model": "gpt-5.5"
}
```

```json
{
  "event.name": "codex.websocket_event",
  "event.kind": "response.output_item.done",
  "duration_ms": 8,
  "success": true,
  "conversation.id": "conversation-uuid",
  "model": "gpt-5.5"
}
```

用途：连接/传输健康、模型服务延迟、事件量。不要直接用 WebSocket event 数量等价于用户-visible token 或 tool 数。

## OTel Metrics 样例

触发条件：配置 `metrics_exporter` 后按 flush 周期发送。实测为 33 个 metric，包含 sum 和 histogram。

```json
{
  "resourceMetrics": [
    {
      "scopeMetrics": [
        {
          "metrics": [
            {
              "name": "codex.turn.ttft.duration_ms",
              "description": "Duration in milliseconds.",
              "unit": "ms",
              "histogram": {
                "dataPoints": [
                  {
                    "count": "1",
                    "sum": 350,
                    "attributes": [
                      { "key": "model", "value": { "stringValue": "gpt-5.5" } },
                      { "key": "originator", "value": { "stringValue": "codex_exec" } }
                    ]
                  }
                ]
              }
            },
            {
              "name": "codex.tool.call",
              "sum": {
                "dataPoints": [
                  {
                    "asInt": "1",
                    "attributes": [
                      { "key": "tool_name", "value": { "stringValue": "Bash" } },
                      { "key": "success", "value": { "boolValue": true } }
                    ]
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

Dashboard 用途：
- `codex.turn.ttft.duration_ms` / `codex.turn.ttfm.duration_ms`：响应延迟。
- `codex.turn.token_usage`：turn 级 token 使用。
- `codex.tool.call` / `codex.tool.call.duration_ms`：工具量和耗时。
- `codex.websocket.*`：传输健康。
- `codex.thread.*`、`codex.shell_snapshot.*`、`codex.plugins.*`：运行时内部健康，适合作为高级诊断。

## OTel Traces 样例

触发条件：配置 `trace_exporter`。Codex traces 是实现级 span，名称和层级不应作为稳定 UI 合约。

```json
{
  "resourceSpans": [
    {
      "scopeSpans": [
        {
          "spans": [
            {
              "traceId": "trace-id",
              "spanId": "span-id",
              "parentSpanId": "parent-span-id",
              "name": "handle_responses",
              "kind": 1,
              "startTimeUnixNano": "1778242129000000000",
              "endTimeUnixNano": "1778242130123000000",
              "attributes": [
                { "key": "target", "value": { "stringValue": "codex_core::client" } },
                { "key": "busy_ns", "value": { "intValue": "120000000" } },
                { "key": "idle_ns", "value": { "intValue": "1000000000" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

行为特征：
- 实测常见 span 包括 `session_init`、`run_turn`、`session_task.turn`、`handle_responses`、`handle_tool_call`、`exec_command`、`write_stdin`、`model_client.stream_responses_websocket`、`responses_websocket.*`、`app_server.thread_start.*`。
- span 属性包含实现路径、线程、busy/idle 时间等内部细节；适合 debug 面板，不适合作为核心指标唯一来源。

## Rollout JSONL 诊断样例

触发条件：Codex session 默认写入 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。

```json
{
  "timestamp": "2026-05-10T02:40:00.000Z",
  "type": "turn_context",
  "last_token_usage": {
    "input_tokens": 1200,
    "cached_input_tokens": 800,
    "output_tokens": 450,
    "reasoning_output_tokens": 120,
    "total_tokens": 1650
  },
  "total_token_usage": {
    "input_tokens": 8200,
    "cached_input_tokens": 5000,
    "output_tokens": 3100,
    "reasoning_output_tokens": 900,
    "total_tokens": 11300
  },
  "model_context_window": 200000,
  "rate_limits": {
    "primary": {
      "used_percent": 32,
      "window_minutes": 300,
      "resets_at": "2026-05-10T07:00:00Z"
    },
    "secondary": {
      "used_percent": 8,
      "window_minutes": 10080,
      "resets_at": "2026-05-17T00:00:00Z"
    }
  },
  "plan_type": "max"
}
```

提取方式：按 rollout JSONL 逐行解析，优先提取 token/rate-limit 结构化字段；不要 tail 全文件原文进 dashboard API。

默认处理：
- token/rate-limit 结构化数值可持久化。
- response items、prompt、tool call arguments、tool output 默认不持久化。
- 实现上需要 reverse-tail 或 rotation-aware reader，避免大文件全量扫描。

## Dashboard 字段处理建议

| 字段类型 | 示例 | 处理 |
|----------|------|------|
| 关联键 | `session_id`, `turn_id`, `conversation.id`, `call_id` | 本机持久化可保留；外部导出 hash |
| 本机路径 | `cwd`, `transcript_path` | 默认 hash 或相对化 |
| 原文输入 | `prompt`, `tool_input`, `arguments` | 默认 strip；可存长度、hash、工具名 |
| 原文输出 | `tool_response`, `output`, `last_assistant_message` | 默认 strip/截断；调试开关才保留 |
| 结构化指标 | token、duration、success、event.kind、tool_name | 可持久化 |
| 账号信息 | `user.email`, `user.account_id`, host name | dashboard API 默认不返回 |

## 实现注意事项

- Hook 与 OTel 是互补关系：Hook 提供完整生命周期和工具 I/O 边界，OTel 提供 token、耗时、传输和运行时内部指标。
- Codex Hook 的 `turn_id` 比 OTel logs 的 `conversation.id` 更细；跨源关联可用时间窗口 + tool/call id + session/conversation 维度近似关联。
- `PermissionRequest` 没有 `tool_use_id`，不要用它直接 join `PostToolUse`。
- OTel traces 名称是实现细节，UI 应优先消费 metrics/logs 的稳定字段。
- 默认 dashboard persistence 只存结构化观测数据，原始 payload 仅在 owner 显式开启 debug 模式时短期保存。
