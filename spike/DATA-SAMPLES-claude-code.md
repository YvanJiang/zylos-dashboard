# Claude Code 数据样例参考

> 运行时：Claude Code v2.1.138
> 采集环境：zylos01（无头模式，bypassPermissions）
> 采集时间：2026-05-08 ~ 2026-05-10
> 数据来源：Hook 系统 + OTel + StatusLine

## 使用说明

本文档为每种数据信号提供一份代表性的脱敏 JSON 样例，配合触发条件、配置要求和提取方式说明。目的是让后续 adapter 开发有明确的参照，避免因数据格式不确定导致的返工。

**脱敏规则**：
- `session_id` → `"<session-id>"`
- `transcript_path` → `"<transcript-path>"`
- `agent_transcript_path` → `"<agent-transcript-path>"`
- `cwd` / 文件路径 → `/home/user/project/...`
- `prompt` 原文 → `"<user-prompt-text>"`
- `last_assistant_message` → `"<assistant-message-truncated>"`
- `stdout` 输出内容 → `"<command-output-truncated>"`
- OTel 中的 `user.id`（哈希值）、`user.email`、`user.account_uuid`、`user.account_id`、`organization.id` → 对应占位符
- `tool_use_id`、`request_id`、`client_request_id` → 对应占位符

字段名、类型和结构保持原样。

---

## 一、Hook 事件样例

**数据格式说明**

每条 hook 事件为一行 JSON，外层结构如下：

```json
{
  "ts": "<ISO8601 timestamp>",
  "event": "unknown",
  "payload": { ... }
}
```

- `ts`：事件时间戳（ISO 8601，UTC）
- `event`：固定为 `"unknown"`（分类靠 payload 内 `hook_event_name`）
- `payload`：事件详情，所有事件均包含以下公共字段：`session_id`、`transcript_path`、`cwd`、`permission_mode`（部分事件无此字段）、`hook_event_name`

---

### 1.1 SessionStart

**触发条件**：Claude Code 启动新 session 时，或执行 `/clear` 重置会话时触发。每个新 session_id 对应一次。
**配置要求**：在 `settings.json` 的 `hooks.SessionStart` 数组中注册探针脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "SessionStart")' hook-events.jsonl`
**敏感字段**：`session_id`（会话标识）、`transcript_path`（本地文件路径）、`cwd`（工作目录）
**Dashboard 建议**：每次 SessionStart 递增 session 计数器；记录启动来源（`source: "clear"` 表示 /clear 触发，否则为新启动）；以 session_id 为 key 建立 session 生命周期状态机

```json
{
  "ts": "2026-05-08T12:46:57.694Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "hook_event_name": "SessionStart",
    "source": "clear"
  }
}
```

---

### 1.2 SessionEnd

**触发条件**：会话结束时触发，包括：用户执行 `/clear`（在 SessionStart 之前紧跟触发）、进程退出等。
**配置要求**：在 `hooks.SessionEnd` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "SessionEnd")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`
**Dashboard 建议**：配合 SessionStart 计算 session 时长；`reason` 字段区分正常结束（`"clear"`）与异常退出；标记该 session 为已完成

```json
{
  "ts": "2026-05-08T12:46:57.660Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project/spike",
    "hook_event_name": "SessionEnd",
    "reason": "clear"
  }
}
```

---

### 1.3 Stop

**触发条件**：Claude 完成一轮 turn（助手输出结束，等待用户输入时）触发。在无头/C4-dispatch 模式下可能不触发（已确认：headless 模式下 Stop 事件不稳定）。
**配置要求**：在 `hooks.Stop` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "Stop")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`、`last_assistant_message`（含助手响应文本）
**Dashboard 建议**：用于标记 turn 结束；`last_assistant_message` 截断后可用于摘要显示；`stop_hook_active: false` 表示没有阻塞型 stop hook 正在运行

```json
{
  "ts": "2026-05-08T12:07:20.650Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project/spike",
    "permission_mode": "bypassPermissions",
    "hook_event_name": "Stop",
    "stop_hook_active": false,
    "last_assistant_message": "<assistant-message-truncated>"
  }
}
```

---

### 1.4 UserPromptSubmit

**触发条件**：用户提交 prompt（发送消息）时触发。在无头/C4-dispatch 模式下可能不触发（已确认：headless 模式下此事件不稳定）。
**配置要求**：在 `hooks.UserPromptSubmit` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "UserPromptSubmit")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`、`prompt`（用户原始输入，含私密内容）
**Dashboard 建议**：`prompt` 字段必须脱敏或不存储；可存储 `length(prompt)` 用于统计；用于标记 turn 开始，配合 Stop 计算 turn 时长

```json
{
  "ts": "2026-05-08T12:11:05.371Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project/spike",
    "permission_mode": "bypassPermissions",
    "hook_event_name": "UserPromptSubmit",
    "prompt": "<user-prompt-text>"
  }
}
```

---

### 1.5 PreToolUse（Bash 示例）

**触发条件**：Claude 决定调用工具、工具执行开始之前触发。每个工具调用一次。
**配置要求**：在 `hooks.PreToolUse` 数组中注册脚本；可配置 `matcher` 字段按 tool_name 过滤
**提取方式**：`jq 'select(.payload.hook_event_name == "PreToolUse" and .payload.tool_name == "Bash")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`、`tool_input.command`（可能含敏感命令或路径）
**Dashboard 建议**：工具调用前审计入口；`tool_use_id` 用于与对应 PostToolUse 关联；可按 `tool_name` 统计工具使用频率；`permission_mode` 决定是否需要用户确认

```json
{
  "ts": "2026-05-08T11:53:51.191Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "permission_mode": "bypassPermissions",
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": {
      "command": "wc -l /home/user/config/.env",
      "description": "Check config file size"
    },
    "tool_use_id": "<tool-use-id>"
  }
}
```

---

### 1.6 PostToolUse（Bash 示例，含 stdout）

**触发条件**：工具执行完成后触发。与 PreToolUse 通过 `tool_use_id` 配对。
**配置要求**：在 `hooks.PostToolUse` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "PostToolUse" and .payload.tool_name == "Bash")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`、`tool_input.command`、`tool_response.stdout`（可能含敏感输出）
**Dashboard 建议**：`duration_ms` 是性能追踪的核心字段，直接可用；`tool_response.stdout` 需截断或不存储；`stderr` 非空时标记为警告；`interrupted: true` 表示用户中断执行

```json
{
  "ts": "2026-05-08T11:53:51.253Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "permission_mode": "bypassPermissions",
    "hook_event_name": "PostToolUse",
    "tool_name": "Bash",
    "tool_input": {
      "command": "wc -l /home/user/config/.env",
      "description": "Check config file size"
    },
    "tool_response": {
      "stdout": "<command-output-truncated>",
      "stderr": "",
      "interrupted": false,
      "isImage": false,
      "noOutputExpected": false
    },
    "tool_use_id": "<tool-use-id>",
    "duration_ms": 31
  }
}
```

---

### 1.7 PostToolBatch（多工具并发示例）

**触发条件**：Claude 在一轮 turn 内并发调用多个工具、全部执行完成后触发一次。`tool_calls` 数组包含该批次所有工具的输入和输出。
**配置要求**：在 `hooks.PostToolBatch` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "PostToolBatch")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`；`tool_calls[].tool_input` 和 `tool_calls[].tool_response`（可能含敏感内容）
**Dashboard 建议**：`tool_calls | length` 表示并发批次大小；批次是最自然的"工具组"聚合单位，适合 timeline 展示；每个 `tool_use_id` 与 PreToolUse/PostToolUse 事件对应；`tool_response` 为字符串格式（非对象），需注意

```json
{
  "ts": "2026-05-08T11:54:42.125Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "permission_mode": "bypassPermissions",
    "hook_event_name": "PostToolBatch",
    "tool_calls": [
      {
        "tool_name": "Bash",
        "tool_input": {
          "command": "ls -la /home/user/project/spike/data/ 2>/dev/null",
          "description": "Check if hook probes captured any data yet"
        },
        "tool_use_id": "<tool-use-id-1>",
        "tool_response": "total 96\ndrwxr-xr-x 2 user user 4096 May 8 11:53 .\n<command-output-truncated>"
      },
      {
        "tool_name": "Bash",
        "tool_input": {
          "command": "cat >> /home/user/config/.env <<'EOF'\n# OTel config appended\nEOF",
          "description": "Add OTel env vars to config"
        },
        "tool_use_id": "<tool-use-id-2>",
        "tool_response": "(Bash completed with no output)"
      }
    ]
  }
}
```

---

### 1.8 PostToolUseFailure

**触发条件**：工具执行失败（非零退出码、超时、权限拒绝等）时触发，替代 PostToolUse。
**配置要求**：在 `hooks.PostToolUseFailure` 数组中注册脚本（或使用通用 PostToolUse 钩子，检查 `error` 字段）
**提取方式**：`jq 'select(.payload.hook_event_name == "PostToolUseFailure")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`、`tool_input`（含失败的命令/参数）、`error`（含错误信息）
**Dashboard 建议**：`error` 字段包含退出码和错误信息，适合错误分类；`duration_ms` 仍可用；`is_interrupt: true` 表示用户主动中断；按 `tool_name` 统计失败率

```json
{
  "ts": "2026-05-08T11:55:35.846Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "permission_mode": "bypassPermissions",
    "hook_event_name": "PostToolUseFailure",
    "tool_name": "Bash",
    "tool_input": {
      "command": "node /home/user/scripts/send.js \"channel\" \"target-id\"",
      "description": "Send message via communication bridge"
    },
    "tool_use_id": "<tool-use-id>",
    "error": "Exit code 1\nError: Target not found\n[Bridge] Failed to send message (exit code: 1)",
    "is_interrupt": false,
    "duration_ms": 1746
  }
}
```

---

### 1.9 SubagentStart

**触发条件**：主 Claude 实例通过 Task 工具启动一个后台 subagent 时触发。
**配置要求**：在 `hooks.SubagentStart` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "SubagentStart")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`
**Dashboard 建议**：`agent_id` 用于追踪 subagent 生命周期（与 SubagentStop 配对）；`agent_type` 目前只有 `"general-purpose"`；注意：SubagentStart 没有 `permission_mode` 字段

```json
{
  "ts": "2026-05-08T12:04:44.969Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "agent_id": "<agent-id>",
    "agent_type": "general-purpose",
    "hook_event_name": "SubagentStart"
  }
}
```

---

### 1.10 SubagentStop

**触发条件**：subagent 完成任务并退出时触发。与 SubagentStart 通过 `agent_id` 配对。
**配置要求**：在 `hooks.SubagentStop` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "SubagentStop")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`agent_transcript_path`（subagent 的对话记录路径）、`last_assistant_message`
**Dashboard 建议**：`agent_transcript_path` 可用于读取完整 subagent 对话记录；配合 SubagentStart 时间戳计算 subagent 执行时长；`last_assistant_message` 含 subagent 返回结果摘要

```json
{
  "ts": "2026-05-08T12:04:48.883Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "permission_mode": "bypassPermissions",
    "agent_id": "<agent-id>",
    "agent_type": "general-purpose",
    "hook_event_name": "SubagentStop",
    "stop_hook_active": false,
    "agent_transcript_path": "<agent-transcript-path>",
    "last_assistant_message": "Task completed successfully"
  }
}
```

---

### 1.11 InstructionsLoaded

**触发条件**：Claude Code 加载 CLAUDE.md 或其他 instruction 文件时触发（session 启动阶段）。
**配置要求**：在 `hooks.InstructionsLoaded` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "InstructionsLoaded")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`file_path`（instruction 文件绝对路径）
**Dashboard 建议**：`memory_type` 区分 `"Project"`（项目级 CLAUDE.md）、`"User"`（用户级）等；`load_reason` 值 `"session_start"` 表示启动时加载；可用于审计哪些 instruction 文件被加载

```json
{
  "ts": "2026-05-08T12:47:02.894Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "hook_event_name": "InstructionsLoaded",
    "file_path": "/home/user/project/CLAUDE.md",
    "memory_type": "Project",
    "load_reason": "session_start"
  }
}
```

---

### 1.12 ConfigChange

**触发条件**：Claude Code 检测到配置文件或相关文件变更时触发（包括 token 缓存文件、settings.json 等）。
**配置要求**：在 `hooks.ConfigChange` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "ConfigChange")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`、`file_path`（变更的文件路径）
**Dashboard 建议**：`source` 字段标识变更来源（如 `"skills"`）；`file_path` 可能包含 token 缓存等敏感文件路径，不应存储完整路径；可用于追踪配置漂移

```json
{
  "ts": "2026-05-08T15:56:25.759Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "hook_event_name": "ConfigChange",
    "source": "skills",
    "file_path": "/home/user/.claude/skills/some-skill/.token_cache"
  }
}
```

---

### 1.13 CwdChanged

**触发条件**：Claude 的当前工作目录变更时触发（通常由 Bash `cd` 命令或工具调用引起）。
**配置要求**：在 `hooks.CwdChanged` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "CwdChanged")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`old_cwd`、`new_cwd`（工作目录路径）
**Dashboard 建议**：追踪 Claude 在哪些目录工作；`old_cwd` → `new_cwd` 路径变更可用于理解工作上下文；注意：`cwd` 字段仍是旧目录，`new_cwd` 才是变更后的目录

```json
{
  "ts": "2026-05-08T12:06:39.462Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "hook_event_name": "CwdChanged",
    "old_cwd": "/home/user/project",
    "new_cwd": "/home/user/project/spike"
  }
}
```

---

### 1.14 Notification

**触发条件**：Claude Code 发出系统通知时触发（如等待用户输入超时提醒、长时间运行警告等）。
**配置要求**：在 `hooks.Notification` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "Notification")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`
**Dashboard 建议**：`notification_type` 用于分类（如 `"idle_prompt"` 表示 Claude 在等待用户）；`message` 是人类可读的通知文本；可转发到外部通知渠道（Telegram、Lark 等）

```json
{
  "ts": "2026-05-08T12:08:20.696Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project/spike",
    "hook_event_name": "Notification",
    "message": "Claude is waiting for your input",
    "notification_type": "idle_prompt"
  }
}
```

---

### 1.15 TaskCreated

**触发条件**：Claude 通过调度系统（scheduler）创建新的定时任务时触发。
**配置要求**：在 `hooks.TaskCreated` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "TaskCreated")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`
**Dashboard 建议**：`task_id` 用于与 TaskCompleted 配对；`task_subject` 和 `task_description` 是任务摘要；可用于可视化 Claude 的自主任务创建情况

```json
{
  "ts": "2026-05-09T04:15:26.241Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project",
    "hook_event_name": "TaskCreated",
    "task_id": "1",
    "task_subject": "Memory Sync #231",
    "task_description": "Process 31 unsummarized conversations into structured memory"
  }
}
```

---

### 1.16 TaskCompleted

**触发条件**：调度系统中的任务执行完成时触发。
**配置要求**：在 `hooks.TaskCompleted` 数组中注册脚本
**提取方式**：`jq 'select(.payload.hook_event_name == "TaskCompleted")' hook-events.jsonl`
**敏感字段**：`session_id`、`transcript_path`、`cwd`
**Dashboard 建议**：配合 TaskCreated 时间戳计算任务执行时长；`task_id` 对应关系；注意 `cwd` 在任务执行期间可能发生变更（如本例中已变为不同目录）

```json
{
  "ts": "2026-05-09T04:19:33.153Z",
  "event": "unknown",
  "payload": {
    "session_id": "<session-id>",
    "transcript_path": "<transcript-path>",
    "cwd": "/home/user/project/workspace",
    "hook_event_name": "TaskCompleted",
    "task_id": "1",
    "task_subject": "Memory Sync #231",
    "task_description": "Process 31 unsummarized conversations into structured memory"
  }
}
```

---

## 二、OTel 信号样例

**数据格式说明**

OTel 数据以 OTLP/HTTP JSON 协议发送，每行为一次 HTTP 请求体的原始 JSON，外层结构为：

```json
{
  "ts": "<ISO8601 timestamp>",
  "contentType": "application/json",
  "url": "/v1/logs | /v1/metrics | /v1/traces",
  "body": { "resourceLogs|resourceMetrics|resourceSpans": [...] }
}
```

**Resource 公共属性**（所有 OTel 信号共享，位于 `resourceLogs/resourceMetrics/resourceSpans[].resource`）：

```json
{
  "attributes": [
    { "key": "host.arch",       "value": { "stringValue": "amd64" } },
    { "key": "os.type",         "value": { "stringValue": "linux" } },
    { "key": "os.version",      "value": { "stringValue": "6.8.0-110-generic" } },
    { "key": "service.name",    "value": { "stringValue": "claude-code" } },
    { "key": "service.version", "value": { "stringValue": "2.1.138" } }
  ],
  "droppedAttributesCount": 0
}
```

**Scope 信息**（位于 `scopeLogs/scopeMetrics/scopeSpans[].scope`）：通常为空对象 `{}`。

**公共 attributes**（log records 和 spans 中每条记录均包含，以下不再重复展示）：

| key | 说明 | 脱敏处理 |
|-----|------|---------|
| `user.id` | 用户 ID（SHA256 哈希） | 替换为 `<user-id-hash>` |
| `session.id` | 会话 UUID | 替换为 `<session-id>` |
| `app.version` | Claude Code 版本 | 保留 |
| `organization.id` | 组织 UUID | 替换为 `<organization-id>` |
| `user.email` | 用户邮箱 | 替换为 `<user-email>` |
| `user.account_uuid` | 账户 UUID | 替换为 `<account-uuid>` |
| `user.account_id` | 账户 ID | 替换为 `<account-id>` |
| `terminal.type` | 终端类型 | 保留 |

下方样例中，公共 attributes 以省略形式展示，仅保留事件特有字段。

---

### 2.1 OTel 日志事件（`/v1/logs`）

OTel 日志采集 Claude Code 的各类运行时事件，通过 `event.name` attribute 区分类型。以下每个小节展示一种事件类型的完整 log record（已脱敏）。

**配置要求**：
```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
# 可选：启用 prompt/tool 内容日志
OTel_LOG_USER_PROMPTS=true
OTel_LOG_TOOL_DETAILS=true
OTel_LOG_TOOL_CONTENT=true
```

**提取方式**：
```bash
# 按 event.name 筛选
jq -c '.body.resourceLogs[].scopeLogs[].logRecords[]
  | select(.attributes[]? | select(.key == "event.name") | .value.stringValue == "EVENT_NAME")
' otel-logs.jsonl
```

**观察到的事件类型统计**（采集期间）：

| event.name | 数量 | 说明 |
|-----------|------|------|
| `hook_execution_start` | 1228 | Hook 执行开始 |
| `hook_execution_complete` | 1228 | Hook 执行完成 |
| `api_request` | 423 | API 调用完成 |
| `tool_result` | 396 | 工具执行结果 |
| `tool_decision` | 396 | 工具权限决策 |
| `user_prompt` | 50 | 用户提交 prompt |
| `at_mention` | 18 | @ 提及事件 |
| `internal_error` | 5 | 内部错误 |
| `api_error` | 3 | API 错误 |
| `skill_activated` | 2 | Skill 激活 |

---

#### 2.1.1 user_prompt

**触发条件**：用户每次提交 prompt 时记录。
**Dashboard 建议**：`prompt_length` 用于统计（不存储 `prompt` 原文）；`command_name` 非空时表示内置命令（如 `/exit`、`/clear`）；`event.sequence` 为会话内事件序号；`prompt.id` 是 turn 标识

```json
{
  "timeUnixNano": "1778341739008000000",
  "observedTimeUnixNano": "1778341739008000000",
  "body": { "stringValue": "claude_code.user_prompt" },
  "attributes": [
    { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
    { "key": "event.name",        "value": { "stringValue": "user_prompt" } },
    { "key": "event.timestamp",   "value": { "stringValue": "2026-05-09T15:48:59.008Z" } },
    { "key": "event.sequence",    "value": { "intValue": 2 } },
    { "key": "prompt.id",         "value": { "stringValue": "<prompt-id>" } },
    { "key": "prompt_length",     "value": { "stringValue": "106" } },
    { "key": "prompt",            "value": { "stringValue": "<user-prompt-text>" } },
    { "key": "command_name",      "value": { "stringValue": "exit" } },
    { "key": "command_source",    "value": { "stringValue": "builtin" } }
  ],
  "droppedAttributesCount": 0
}
```

---

#### 2.1.2 api_request

**触发条件**：每次 Claude Code 向 Anthropic API 发起请求并收到响应后记录。
**Dashboard 建议**：`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens` 和 `cost_usd` 是费用分析的核心；`duration_ms` 用于 API 延迟监控；`model` + `query_source` 组合可区分 main/auxiliary/subagent 调用；`request_id` 可与 Anthropic 日志关联

```json
{
  "timeUnixNano": "1778341780134000000",
  "observedTimeUnixNano": "1778341780134000000",
  "body": { "stringValue": "claude_code.api_request" },
  "attributes": [
    { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
    { "key": "event.name",        "value": { "stringValue": "api_request" } },
    { "key": "event.timestamp",   "value": { "stringValue": "2026-05-09T15:49:40.134Z" } },
    { "key": "event.sequence",    "value": { "intValue": 5 } },
    { "key": "prompt.id",         "value": { "stringValue": "<prompt-id>" } },
    { "key": "model",             "value": { "stringValue": "claude-haiku-4-5-20251001" } },
    { "key": "input_tokens",      "value": { "intValue": 387 } },
    { "key": "output_tokens",     "value": { "intValue": 18 } },
    { "key": "cache_read_tokens", "value": { "intValue": 0 } },
    { "key": "cache_creation_tokens", "value": { "intValue": 0 } },
    { "key": "cost_usd",          "value": { "doubleValue": 0.000477 } },
    { "key": "duration_ms",       "value": { "intValue": 2218 } },
    { "key": "request_id",        "value": { "stringValue": "<request-id>" } },
    { "key": "speed",             "value": { "stringValue": "normal" } },
    { "key": "query_source",      "value": { "stringValue": "generate_session_title" } }
  ],
  "droppedAttributesCount": 0
}
```

---

#### 2.1.3 tool_result

**触发条件**：工具执行完成、结果返回给 Claude 时记录。
**Dashboard 建议**：`success: "true"/"false"` 用于错误率统计；`duration_ms` 为工具执行时长；`tool_input_size_bytes` / `tool_result_size_bytes` 可用于分析 context 占用；`decision_type` 配合 `decision_source` 记录权限决策来源（`config` 表示自动允许）；`tool_parameters` 含 bash_command 等详情

```json
{
  "timeUnixNano": "1778341788594000000",
  "observedTimeUnixNano": "1778341788594000000",
  "body": { "stringValue": "claude_code.tool_result" },
  "attributes": [
    { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
    { "key": "event.name",        "value": { "stringValue": "tool_result" } },
    { "key": "event.timestamp",   "value": { "stringValue": "2026-05-09T15:49:48.594Z" } },
    { "key": "event.sequence",    "value": { "intValue": 9 } },
    { "key": "prompt.id",         "value": { "stringValue": "<prompt-id>" } },
    { "key": "tool_name",         "value": { "stringValue": "Bash" } },
    { "key": "tool_use_id",       "value": { "stringValue": "<tool-use-id>" } },
    { "key": "success",           "value": { "stringValue": "true" } },
    { "key": "duration_ms",       "value": { "stringValue": "62" } },
    { "key": "tool_parameters",   "value": { "stringValue": "{\"bash_command\":\"env | grep OTEL\",\"description\":\"Check OTel env vars\"}" } },
    { "key": "tool_input",        "value": { "stringValue": "{\"command\":\"env | grep OTEL\",\"description\":\"Check OTel env vars\"}" } },
    { "key": "tool_input_size_bytes",  "value": { "stringValue": "117" } },
    { "key": "tool_result_size_bytes", "value": { "stringValue": "316" } },
    { "key": "decision_source",   "value": { "stringValue": "config" } },
    { "key": "decision_type",     "value": { "stringValue": "accept" } }
  ],
  "droppedAttributesCount": 0
}
```

---

#### 2.1.4 tool_decision

**触发条件**：Claude Code 对工具调用进行权限判断时记录（在工具执行之前）。
**Dashboard 建议**：`decision` 值为 `"accept"` / `"reject"`；`source` 值为 `"config"`（自动）/ `"user"`（人工确认）；与 `tool_result` 通过 `tool_use_id` 关联；可用于统计自动允许率 vs 人工干预率

```json
{
  "timeUnixNano": "1778341788532000000",
  "observedTimeUnixNano": "1778341788532000000",
  "body": { "stringValue": "claude_code.tool_decision" },
  "attributes": [
    { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
    { "key": "event.name",        "value": { "stringValue": "tool_decision" } },
    { "key": "event.timestamp",   "value": { "stringValue": "2026-05-09T15:49:48.532Z" } },
    { "key": "event.sequence",    "value": { "intValue": 8 } },
    { "key": "prompt.id",         "value": { "stringValue": "<prompt-id>" } },
    { "key": "decision",          "value": { "stringValue": "accept" } },
    { "key": "source",            "value": { "stringValue": "config" } },
    { "key": "tool_name",         "value": { "stringValue": "Bash" } },
    { "key": "tool_use_id",       "value": { "stringValue": "<tool-use-id>" } }
  ],
  "droppedAttributesCount": 0
}
```

---

#### 2.1.5 hook_execution_start

**触发条件**：Claude Code 开始执行注册在某 hook 事件上的脚本组时记录。
**Dashboard 建议**：`hook_event` 标识触发的 hook 类型；`num_hooks` 是本次需执行的 hook 数量；`hook_source: "merged"` 表示合并了 project 和 user 级别的配置；与 hook_execution_complete 配对计算 hook 总耗时

```json
{
  "timeUnixNano": "1778341733626000000",
  "observedTimeUnixNano": "1778341733626000000",
  "body": { "stringValue": "claude_code.hook_execution_start" },
  "attributes": [
    { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
    { "key": "event.name",        "value": { "stringValue": "hook_execution_start" } },
    { "key": "event.timestamp",   "value": { "stringValue": "2026-05-09T15:48:53.626Z" } },
    { "key": "event.sequence",    "value": { "intValue": 0 } },
    { "key": "hook_event",        "value": { "stringValue": "SessionStart" } },
    { "key": "hook_name",         "value": { "stringValue": "SessionStart:startup" } },
    { "key": "num_hooks",         "value": { "stringValue": "5" } },
    { "key": "managed_only",      "value": { "stringValue": "false" } },
    { "key": "hook_source",       "value": { "stringValue": "merged" } }
  ],
  "droppedAttributesCount": 0
}
```

---

#### 2.1.6 hook_execution_complete

**触发条件**：Claude Code 完成本轮所有 hook 脚本执行后记录。
**Dashboard 建议**：`total_duration_ms` 为 hook 总执行耗时；`num_success` / `num_blocking` / `num_non_blocking_error` / `num_cancelled` 细分各脚本执行结果；`num_blocking > 0` 表示有 hook 阻塞了主流程；可用于识别 hook 性能问题

```json
{
  "timeUnixNano": "1778341734322000000",
  "observedTimeUnixNano": "1778341734322000000",
  "body": { "stringValue": "claude_code.hook_execution_complete" },
  "attributes": [
    { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
    { "key": "event.name",        "value": { "stringValue": "hook_execution_complete" } },
    { "key": "event.timestamp",   "value": { "stringValue": "2026-05-09T15:48:54.322Z" } },
    { "key": "event.sequence",    "value": { "intValue": 1 } },
    { "key": "hook_event",        "value": { "stringValue": "SessionStart" } },
    { "key": "hook_name",         "value": { "stringValue": "SessionStart:startup" } },
    { "key": "num_hooks",             "value": { "stringValue": "5" } },
    { "key": "num_success",           "value": { "stringValue": "5" } },
    { "key": "num_blocking",          "value": { "stringValue": "0" } },
    { "key": "num_non_blocking_error","value": { "stringValue": "0" } },
    { "key": "num_cancelled",         "value": { "stringValue": "0" } },
    { "key": "total_duration_ms",     "value": { "stringValue": "601" } },
    { "key": "managed_only",      "value": { "stringValue": "false" } },
    { "key": "hook_source",       "value": { "stringValue": "merged" } }
  ],
  "droppedAttributesCount": 0
}
```

---

### 2.2 OTel 指标（`/v1/metrics`）

**配置要求**：
```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
# 可选
OTEL_METRICS_INCLUDE_SESSION_ID=true
OTEL_METRICS_INCLUDE_VERSION=true
```

**提取方式**：
```bash
jq -c '.body.resourceMetrics[].scopeMetrics[].metrics[] | select(.name == "METRIC_NAME")' otel-metrics.jsonl
```

所有指标均为 **累积 sum**（`aggregationTemporality: 1`，`isMonotonic: true`），即单调递增计数器，需在 adapter 侧计算差值。

**观察到的指标列表**：

| 指标名 | 单位 | 说明 |
|--------|------|------|
| `claude_code.session.count` | — | session 启动次数 |
| `claude_code.token.usage` | tokens | 按 model + type(input/output/cacheRead/cacheCreation) 分类 |
| `claude_code.cost.usage` | USD | 按 model + query_source 分类的费用 |
| `claude_code.active_time.total` | s | 活跃时间（user / llm 分类） |
| `claude_code.code_edit_tool.decision` | — | 代码编辑工具权限决策次数 |
| `claude_code.lines_of_code.count` | — | 代码行变更数（added/removed） |
| `claude_code.commit.count` | — | git commit 次数 |
| `claude_code.pull_request.count` | — | PR 次数 |

---

#### 2.2.1 session.count

**Dashboard 建议**：单次 dataPoint，`asDouble: 1` 固定。主要价值在 attributes：`start_type: "fresh"` vs `"resumed"` 区分新建 vs 恢复；配合时间窗口统计每日 session 数

```json
{
  "name": "claude_code.session.count",
  "description": "Count of CLI sessions started",
  "unit": "",
  "sum": {
    "aggregationTemporality": 1,
    "isMonotonic": true,
    "dataPoints": [
      {
        "attributes": [
          { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
          { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
          { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
          { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
          { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
          { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
          { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
          { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
          { "key": "start_type",        "value": { "stringValue": "fresh" } }
        ],
        "startTimeUnixNano": "1778341732697000000",
        "timeUnixNano": "1778341739010000000",
        "asDouble": 1
      }
    ]
  }
}
```

---

#### 2.2.2 token.usage

**Dashboard 建议**：每次 metrics flush 包含多个 dataPoints，按 `model` × `query_source` × `type`（input/output/cacheRead/cacheCreation）× `effort` 组合。需 group-by 聚合后累加。重要发现：`cacheRead` token 在 opus 主模型上通常远大于 input（本例 168193 vs 9），说明长上下文场景下缓存命中显著降低费用。

```json
{
  "name": "claude_code.token.usage",
  "description": "Number of tokens used",
  "unit": "tokens",
  "sum": {
    "aggregationTemporality": 1,
    "isMonotonic": true,
    "dataPoints": [
      {
        "attributes": [
          { "key": "user.id",       "value": { "stringValue": "<user-id-hash>" } },
          { "key": "session.id",    "value": { "stringValue": "<session-id>" } },
          { "key": "app.version",   "value": { "stringValue": "2.1.138" } },
          { "key": "organization.id","value": { "stringValue": "<organization-id>" } },
          { "key": "user.email",    "value": { "stringValue": "<user-email>" } },
          { "key": "user.account_uuid","value": { "stringValue": "<account-uuid>" } },
          { "key": "user.account_id","value": { "stringValue": "<account-id>" } },
          { "key": "terminal.type", "value": { "stringValue": "xterm-256color" } },
          { "key": "model",         "value": { "stringValue": "claude-opus-4-6" } },
          { "key": "query_source",  "value": { "stringValue": "main" } },
          { "key": "effort",        "value": { "stringValue": "high" } },
          { "key": "type",          "value": { "stringValue": "input" } }
        ],
        "startTimeUnixNano": "1778341788959000000",
        "timeUnixNano": "1778341836261000000",
        "asDouble": 9
      },
      {
        "attributes": [
          { "key": "model",        "value": { "stringValue": "claude-opus-4-6" } },
          { "key": "query_source", "value": { "stringValue": "main" } },
          { "key": "effort",       "value": { "stringValue": "high" } },
          { "key": "type",         "value": { "stringValue": "output" } }
        ],
        "startTimeUnixNano": "1778341788959000000",
        "timeUnixNano": "1778341836261000000",
        "asDouble": 2067
      },
      {
        "attributes": [
          { "key": "model",        "value": { "stringValue": "claude-opus-4-6" } },
          { "key": "query_source", "value": { "stringValue": "main" } },
          { "key": "effort",       "value": { "stringValue": "high" } },
          { "key": "type",         "value": { "stringValue": "cacheRead" } }
        ],
        "startTimeUnixNano": "1778341788959000000",
        "timeUnixNano": "1778341836261000000",
        "asDouble": 168193
      },
      {
        "attributes": [
          { "key": "model",        "value": { "stringValue": "claude-opus-4-6" } },
          { "key": "query_source", "value": { "stringValue": "main" } },
          { "key": "effort",       "value": { "stringValue": "high" } },
          { "key": "type",         "value": { "stringValue": "cacheCreation" } }
        ],
        "startTimeUnixNano": "1778341788959000000",
        "timeUnixNano": "1778341836261000000",
        "asDouble": 17761
      }
    ]
  }
}
```

---

#### 2.2.3 cost.usage

**Dashboard 建议**：费用按 `model` × `query_source` × `effort` 分组；累积计数器，需计算差值或在 session 结束时取最终值；`asDouble` 单位为 USD；可按 `query_source`（main/auxiliary/subagent）分析费用构成

```json
{
  "name": "claude_code.cost.usage",
  "description": "Cost of the Claude Code session",
  "unit": "USD",
  "sum": {
    "aggregationTemporality": 1,
    "isMonotonic": true,
    "dataPoints": [
      {
        "attributes": [
          { "key": "user.id",       "value": { "stringValue": "<user-id-hash>" } },
          { "key": "session.id",    "value": { "stringValue": "<session-id>" } },
          { "key": "app.version",   "value": { "stringValue": "2.1.138" } },
          { "key": "organization.id","value": { "stringValue": "<organization-id>" } },
          { "key": "user.email",    "value": { "stringValue": "<user-email>" } },
          { "key": "user.account_uuid","value": { "stringValue": "<account-uuid>" } },
          { "key": "user.account_id","value": { "stringValue": "<account-id>" } },
          { "key": "terminal.type", "value": { "stringValue": "xterm-256color" } },
          { "key": "model",         "value": { "stringValue": "claude-opus-4-6" } },
          { "key": "query_source",  "value": { "stringValue": "main" } },
          { "key": "effort",        "value": { "stringValue": "high" } }
        ],
        "startTimeUnixNano": "1778341788959000000",
        "timeUnixNano": "1778341836261000000",
        "asDouble": 0.24682275
      },
      {
        "attributes": [
          { "key": "model",         "value": { "stringValue": "claude-haiku-4-5-20251001" } },
          { "key": "query_source",  "value": { "stringValue": "auxiliary" } }
        ],
        "startTimeUnixNano": "1778341780130000000",
        "timeUnixNano": "1778341836261000000",
        "asDouble": 0.000477
      },
      {
        "attributes": [
          { "key": "model",         "value": { "stringValue": "claude-sonnet-4-6" } },
          { "key": "query_source",  "value": { "stringValue": "subagent" } },
          { "key": "effort",        "value": { "stringValue": "high" } }
        ],
        "startTimeUnixNano": "1778341824360000000",
        "timeUnixNano": "1778341836261000000",
        "asDouble": 0.0355332
      }
    ]
  }
}
```

---

#### 2.2.4 code_edit_tool.decision

**Dashboard 建议**：`decision`（accept/reject）× `source`（config/user）× `tool_name`（Edit/Write/NotebookEdit）× `language` 多维分组；可用于统计编辑操作频率和拒绝率；`language` 字段（如 `"Markdown"`、`"TypeScript"`）反映主要编辑的语言

```json
{
  "name": "claude_code.code_edit_tool.decision",
  "description": "Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools",
  "unit": "",
  "sum": {
    "aggregationTemporality": 1,
    "isMonotonic": true,
    "dataPoints": [
      {
        "attributes": [
          { "key": "user.id",       "value": { "stringValue": "<user-id-hash>" } },
          { "key": "session.id",    "value": { "stringValue": "<session-id>" } },
          { "key": "app.version",   "value": { "stringValue": "2.1.138" } },
          { "key": "organization.id","value": { "stringValue": "<organization-id>" } },
          { "key": "user.email",    "value": { "stringValue": "<user-email>" } },
          { "key": "user.account_uuid","value": { "stringValue": "<account-uuid>" } },
          { "key": "user.account_id","value": { "stringValue": "<account-id>" } },
          { "key": "terminal.type", "value": { "stringValue": "xterm-256color" } },
          { "key": "decision",      "value": { "stringValue": "accept" } },
          { "key": "source",        "value": { "stringValue": "config" } },
          { "key": "tool_name",     "value": { "stringValue": "Edit" } },
          { "key": "language",      "value": { "stringValue": "Markdown" } }
        ],
        "startTimeUnixNano": "1778341840033000000",
        "timeUnixNano": "1778341896261000000",
        "asDouble": 2
      }
    ]
  }
}
```

---

### 2.3 OTel 链路追踪（`/v1/traces`）

**配置要求**：同指标配置，额外需要：
```bash
OTEL_TRACES_EXPORTER=otlp
```

**提取方式**：
```bash
jq -c '.body.resourceSpans[].scopeSpans[].spans[] | select(.name == "SPAN_NAME")' otel-traces.jsonl
```

**Span 层级关系**（父子关系通过 `parentSpanId` 建立）：

```
claude_code.interaction          (根 span，一次 turn)
└── claude_code.llm_request      (LLM API 调用)
└── claude_code.tool             (一次工具调用，包含输入输出)
    ├── claude_code.tool.blocked_on_user   (权限决策等待)
    └── claude_code.tool.execution         (实际执行)
```

**观察到的 span 类型统计**：

| span name | 数量 | 说明 |
|-----------|------|------|
| `claude_code.llm_request` | 431 | LLM 请求 |
| `claude_code.tool.execution` | 403 | 工具实际执行 |
| `claude_code.tool.blocked_on_user` | 403 | 工具权限决策 |
| `claude_code.tool` | 403 | 工具调用（含输入输出） |
| `claude_code.interaction` | 50 | 用户交互 turn |

---

#### 2.3.1 interaction（根 span）

**触发条件**：用户提交 prompt → Claude 响应完成，整个 turn 对应一个 interaction span。
**Dashboard 建议**：`traceId` 是 turn 级别的追踪 ID，可关联该 turn 内所有子 span；`user_prompt_length` 不含原文（脱敏）；`interaction.duration_ms` 为整个 turn 耗时；`interaction.sequence` 是 session 内交互序号；注意：此处没有 `parentSpanId`（根 span）

```json
{
  "traceId": "<trace-id>",
  "spanId": "<span-id>",
  "name": "claude_code.interaction",
  "kind": 1,
  "startTimeUnixNano": "1778341739007000000",
  "endTimeUnixNano": "1778341739010433265",
  "attributes": [
    { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
    { "key": "span.type",         "value": { "stringValue": "interaction" } },
    { "key": "user_prompt",       "value": { "stringValue": "<user-prompt-text>" } },
    { "key": "user_prompt_length","value": { "intValue": 106 } },
    { "key": "interaction.sequence", "value": { "intValue": 1 } },
    { "key": "interaction.duration_ms", "value": { "intValue": 3 } }
  ],
  "droppedAttributesCount": 0,
  "events": [],
  "droppedEventsCount": 0,
  "status": { "code": 0 },
  "links": [],
  "droppedLinksCount": 0,
  "flags": 257
}
```

---

#### 2.3.2 llm_request（LLM 调用 span）

**触发条件**：每次调用 Anthropic API 对应一个 span。
**Dashboard 建议**：`model` / `gen_ai.request.model` 双字段（值相同）；`ttft_ms`（time-to-first-token）是 LLM 响应速度的关键指标；`stop_reason` 区分 `"end_turn"`（正常）/ `"tool_use"`（触发工具）/ `"max_tokens"`（截断）；`links` 数组建立跨 trace 关联（如 subagent 链路关联）；`events[].name == "gen_ai.request.attempt"` 记录每次重试

```json
{
  "traceId": "<trace-id>",
  "spanId": "<span-id>",
  "parentSpanId": "<parent-span-id>",
  "name": "claude_code.llm_request",
  "kind": 1,
  "startTimeUnixNano": "1778341777909000000",
  "endTimeUnixNano": "1778341780135437210",
  "attributes": [
    { "key": "user.id",           "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",        "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",       "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id",   "value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",        "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid", "value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id",   "value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type",     "value": { "stringValue": "xterm-256color" } },
    { "key": "span.type",         "value": { "stringValue": "llm_request" } },
    { "key": "model",             "value": { "stringValue": "claude-haiku-4-5-20251001" } },
    { "key": "gen_ai.system",     "value": { "stringValue": "anthropic" } },
    { "key": "gen_ai.request.model", "value": { "stringValue": "claude-haiku-4-5-20251001" } },
    { "key": "llm_request.context",  "value": { "stringValue": "interaction" } },
    { "key": "speed",             "value": { "stringValue": "normal" } },
    { "key": "duration_ms",       "value": { "intValue": 2225 } },
    { "key": "input_tokens",      "value": { "intValue": 387 } },
    { "key": "output_tokens",     "value": { "intValue": 18 } },
    { "key": "cache_read_tokens", "value": { "intValue": 0 } },
    { "key": "cache_creation_tokens", "value": { "intValue": 0 } },
    { "key": "success",           "value": { "boolValue": true } },
    { "key": "attempt",           "value": { "intValue": 1 } },
    { "key": "request_id",        "value": { "stringValue": "<request-id>" } },
    { "key": "gen_ai.response.id","value": { "stringValue": "<request-id>" } },
    { "key": "client_request_id", "value": { "stringValue": "<client-request-id>" } },
    { "key": "ttft_ms",           "value": { "intValue": 2166 } },
    { "key": "stop_reason",       "value": { "stringValue": "end_turn" } },
    { "key": "gen_ai.response.finish_reasons", "value": { "arrayValue": { "values": [{ "stringValue": "end_turn" }] } } }
  ],
  "droppedAttributesCount": 0,
  "events": [
    {
      "attributes": [
        { "key": "attempt",           "value": { "intValue": 1 } },
        { "key": "client_request_id", "value": { "stringValue": "<client-request-id>" } }
      ],
      "name": "gen_ai.request.attempt",
      "timeUnixNano": "1778341777916045576",
      "droppedAttributesCount": 0
    }
  ],
  "droppedEventsCount": 0,
  "status": { "code": 0 },
  "links": [
    {
      "attributes": [
        { "key": "link.type", "value": { "stringValue": "parent_of" } }
      ],
      "spanId": "<linked-span-id>",
      "traceId": "<linked-trace-id>",
      "droppedAttributesCount": 0,
      "flags": 769
    }
  ],
  "droppedLinksCount": 0,
  "flags": 257
}
```

---

#### 2.3.3 tool（工具调用 span）

**触发条件**：每个工具调用对应一个 tool span，包含工具执行完整信息。
**Dashboard 建议**：`full_command` 含实际执行命令（需脱敏）；`events[].name == "tool.output"` 含完整输出（启用 `OTel_LOG_TOOL_CONTENT=true` 时）；`duration_ms` 是工具整体耗时（含权限等待）；tool span 的时间范围包含 `tool.blocked_on_user` 和 `tool.execution` 两个子 span

```json
{
  "traceId": "<trace-id>",
  "spanId": "<span-id>",
  "parentSpanId": "<parent-span-id>",
  "name": "claude_code.tool",
  "kind": 1,
  "startTimeUnixNano": "1778341788525000000",
  "endTimeUnixNano": "1778341788594281824",
  "attributes": [
    { "key": "user.id",       "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",    "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",   "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id","value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",    "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid","value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id","value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type", "value": { "stringValue": "xterm-256color" } },
    { "key": "span.type",     "value": { "stringValue": "tool" } },
    { "key": "tool_name",     "value": { "stringValue": "Bash" } },
    { "key": "full_command",  "value": { "stringValue": "env | grep OTEL" } },
    { "key": "duration_ms",   "value": { "intValue": 69 } }
  ],
  "droppedAttributesCount": 0,
  "events": [
    {
      "attributes": [
        { "key": "bash_command", "value": { "stringValue": "<command-truncated>" } },
        { "key": "output",       "value": { "stringValue": "<command-output-truncated>" } }
      ],
      "name": "tool.output",
      "timeUnixNano": "1778341788594101700",
      "droppedAttributesCount": 0
    }
  ],
  "droppedEventsCount": 0,
  "status": { "code": 0 },
  "links": [],
  "droppedLinksCount": 0,
  "flags": 257
}
```

---

#### 2.3.4 tool.execution（工具实际执行 span）

**触发条件**：工具实际执行阶段（权限决策通过后）对应的 span，是 `tool` span 的子 span。
**Dashboard 建议**：`success: true/false` 用于工具失败率统计；`duration_ms` 为纯执行时长（不含权限等待），与 `tool` span 的差值即为 `blocked_on_user` 时长；无额外 attributes，主要用于时间线分析

```json
{
  "traceId": "<trace-id>",
  "spanId": "<span-id>",
  "parentSpanId": "<parent-tool-span-id>",
  "name": "claude_code.tool.execution",
  "kind": 1,
  "startTimeUnixNano": "1778341788532000000",
  "endTimeUnixNano": "1778341788593591737",
  "attributes": [
    { "key": "user.id",       "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",    "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",   "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id","value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",    "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid","value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id","value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type", "value": { "stringValue": "xterm-256color" } },
    { "key": "span.type",     "value": { "stringValue": "tool.execution" } },
    { "key": "duration_ms",   "value": { "intValue": 62 } },
    { "key": "success",       "value": { "boolValue": true } }
  ],
  "droppedAttributesCount": 0,
  "events": [],
  "droppedEventsCount": 0,
  "status": { "code": 0 },
  "links": [],
  "droppedLinksCount": 0,
  "flags": 257
}
```

---

#### 2.3.5 tool.blocked_on_user（权限决策 span）

**触发条件**：工具调用发出后、等待权限决策期间对应的 span，是 `tool` span 的另一个子 span。
**Dashboard 建议**：`decision` 为权限结果（`"accept"` / `"reject"`）；`source` 为决策来源（`"config"` 表示自动，`"user"` 表示人工确认）；`duration_ms` 为等待决策的时长；`bypassPermissions` 模式下 `source = "config"`，`duration_ms` 极短（通常 < 10ms）

```json
{
  "traceId": "<trace-id>",
  "spanId": "<span-id>",
  "parentSpanId": "<parent-tool-span-id>",
  "name": "claude_code.tool.blocked_on_user",
  "kind": 1,
  "startTimeUnixNano": "1778341788525000000",
  "endTimeUnixNano": "1778341788532272473",
  "attributes": [
    { "key": "user.id",       "value": { "stringValue": "<user-id-hash>" } },
    { "key": "session.id",    "value": { "stringValue": "<session-id>" } },
    { "key": "app.version",   "value": { "stringValue": "2.1.138" } },
    { "key": "organization.id","value": { "stringValue": "<organization-id>" } },
    { "key": "user.email",    "value": { "stringValue": "<user-email>" } },
    { "key": "user.account_uuid","value": { "stringValue": "<account-uuid>" } },
    { "key": "user.account_id","value": { "stringValue": "<account-id>" } },
    { "key": "terminal.type", "value": { "stringValue": "xterm-256color" } },
    { "key": "span.type",     "value": { "stringValue": "tool.blocked_on_user" } },
    { "key": "duration_ms",   "value": { "intValue": 7 } },
    { "key": "decision",      "value": { "stringValue": "accept" } },
    { "key": "source",        "value": { "stringValue": "config" } }
  ],
  "droppedAttributesCount": 0,
  "events": [],
  "droppedEventsCount": 0,
  "status": { "code": 0 },
  "links": [],
  "droppedLinksCount": 0,
  "flags": 257
}
```

---

## 三、StatusLine 样例

> **说明**：StatusLine 数据在本次 spike 未成功落盘（statusline-events.jsonl 未捕获到实际数据）。以下为根据 DATA-INVENTORY-hooks.md 第十节文档说明重建的**预期结构**，标注为"预期结构，待实采验证"。

**触发条件**：Claude Code 每次生成助手消息后、`/compact` 完成后、权限模式变更后更新（300ms 防抖）；也按 `refreshInterval` 定时推送（空闲时也触发）。
**配置要求**：在 `settings.json` 中配置：
```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "refreshInterval": 5
  }
}
```
脚本从 stdin 读取 JSON，stdout 输出显示内容（影响状态栏）。
**采集方式**：脚本中同时写入 JSONL 文件：
```bash
#!/bin/bash
input=$(cat)
echo "$input" >> ~/path/to/statusline-events.jsonl
# 输出状态栏内容
echo "$input" | jq -r '"\(.model.display_name) \(.context_window.used_percentage | floor)% | $\(.cost.total_cost_usd)"'
```
**敏感字段**：`session_id`、`transcript_path`、`workspace.current_dir`、`workspace.project_dir`（本地路径）
**Dashboard 建议**：StatusLine 是获取以下数据的唯一 Hook 外来源：实时 context 使用率（`context_window.used_percentage`）、会话累计费用（`cost.total_cost_usd`）、速率限制状态（`rate_limits`）、推理力度（`effort.level`）。适合驱动 dashboard 顶部状态栏。

```json
{
  "session_id": "<session-id>",
  "transcript_path": "<transcript-path>",
  "version": "2.1.138",
  "model": {
    "id": "claude-opus-4-6",
    "display_name": "Opus"
  },
  "context_window": {
    "total_input_tokens": 185420,
    "total_output_tokens": 3240,
    "context_window_size": 200000,
    "used_percentage": 94.3,
    "remaining_percentage": 5.7,
    "current_usage": {
      "input_tokens": 12800,
      "output_tokens": 2067,
      "cache_creation_input_tokens": 17761,
      "cache_read_input_tokens": 168193
    }
  },
  "cost": {
    "total_cost_usd": 0.2824,
    "total_duration_ms": 95420,
    "total_api_duration_ms": 31200,
    "total_lines_added": 48,
    "total_lines_removed": 12
  },
  "rate_limits": {
    "five_hour": {
      "used_percentage": 18.5,
      "resets_at": 1778359200
    },
    "seven_day": {
      "used_percentage": 7.2,
      "resets_at": 1778860800
    }
  },
  "effort": {
    "level": "high"
  },
  "thinking": {
    "enabled": false
  },
  "workspace": {
    "current_dir": "/home/user/project",
    "project_dir": "/home/user/project",
    "added_dirs": [],
    "git_worktree": null
  },
  "output_style": {
    "name": "default"
  },
  "exceeds_200k_tokens": false
}
```

---

## 四、数据关联关系总结

| 关联维度 | 关联键 | 说明 |
|---------|--------|------|
| Hook 同一 session 内所有事件 | `session_id` | 串联 session 生命周期 |
| PreToolUse ↔ PostToolUse | `tool_use_id` | 匹配工具调用前后 |
| SubagentStart ↔ SubagentStop | `agent_id` | 匹配 subagent 生命周期 |
| TaskCreated ↔ TaskCompleted | `task_id` | 匹配任务生命周期 |
| Hook ↔ OTel log | `session_id` + 时间戳 | 跨源关联（无唯一 key，靠时间对齐） |
| OTel log ↔ OTel span | `prompt.id` / `tool_use_id` | 日志与 trace 关联 |
| OTel span 父子关系 | `parentSpanId` / `spanId` | 构建 trace 树 |
| OTel 跨 trace 关联 | `links[]` | subagent 与 parent 的 trace 关联 |

## 五、各数据源独有信息

| 信息类别 | Hook | OTel 日志 | OTel 指标 | OTel Traces | StatusLine |
|---------|------|----------|----------|------------|-----------|
| 工具 stdout/stderr 原文 | ✅ PostToolUse | ✅ tool_result | ❌ | ✅ tool.output event | ❌ |
| 工具执行 duration_ms | ✅ PostToolUse | ✅ tool_result | ❌ | ✅ span duration | ❌ |
| API token 详情（单次）| ❌ | ✅ api_request | ✅ token.usage | ✅ llm_request | ❌ |
| 费用（按次）| ❌ | ✅ api_request | ✅ cost.usage | ❌ | ❌ |
| 费用（累计）| ❌ | ❌ | ❌ | ❌ | ✅ cost.total_cost_usd |
| context window 使用率 | ❌ | ❌ | ❌ | ❌ | ✅ used_percentage |
| 速率限制状态 | ❌ | ❌ | ❌ | ❌ | ✅ rate_limits |
| 推理力度 effort | ❌ | ❌ | ✅（dim） | ✅（dim） | ✅ effort.level |
| Subagent 生命周期 | ✅ SubagentStart/Stop | ❌ | ❌ | ❌ | ❌ |
| Task 生命周期 | ✅ TaskCreated/Completed | ❌ | ❌ | ❌ | ❌ |
| Hook 执行时长 | ❌ | ✅ hook_execution_complete | ❌ | ❌ | ❌ |
| 权限决策详情 | ❌ | ✅ tool_decision | ✅（dim） | ✅ tool.blocked_on_user | ❌ |
| 工具调用 trace 树 | ❌ | ❌ | ❌ | ✅ | ❌ |
