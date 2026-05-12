import path from 'node:path';

const CREDENTIAL_PATTERNS = [
  [/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]'],
  [/xoxb-[a-zA-Z0-9-]+/g, '[REDACTED]'],
  [/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]'],
  [/Bearer\s+[a-zA-Z0-9._\-]+/g, 'Bearer [REDACTED]'],
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]']
];

const STRIP_KEYS = new Set([
  'tool_input', 'tool_response', 'tool_output',
  'prompt', 'content', 'message'
]);

export class Sanitizer {
  constructor(zylosDir) {
    this.zylosDir = zylosDir;
  }

  sanitizeHookPayload(hookEventName, rawPayload) {
    try {
      const session_id = rawPayload.session_id || null;
      const duration_ms = rawPayload.duration_ms || null;
      const tool_name = rawPayload.tool_name || rawPayload.tool || null;
      const tool_use_id = rawPayload.tool_use_id || null;

      const tool_detail = this._extractToolDetail(tool_name, rawPayload.tool_input);

      const metadata = {};
      if (tool_name) metadata.tool_name = tool_name;
      if (tool_use_id) metadata.tool_use_id = tool_use_id;
      if (tool_detail) metadata.tool_detail = tool_detail;

      const safeFields = ['timestamp', 'hook_event_name', 'runtime'];
      for (const key of safeFields) {
        if (rawPayload[key] !== undefined) metadata[key] = rawPayload[key];
      }

      this._redactObject(metadata);

      for (const key of STRIP_KEYS) {
        delete metadata[key];
      }

      const agentId = rawPayload.agent_id || null;
      const agentType = rawPayload.agent_type || null;
      if (agentId) metadata.agent_id = agentId;
      if (agentType) metadata.agent_type = agentType;

      if (hookEventName === 'SubagentStop') {
        const msg = rawPayload.last_assistant_message;
        if (typeof msg === 'string' && msg.length > 0) {
          const redacted = this.redactCredentials(msg);
          metadata.assistant_summary = redacted.length > 120 ? redacted.slice(0, 117) + '...' : redacted;
        }
      }

      const summary = this.buildSummary(hookEventName, tool_name, duration_ms, tool_detail);

      return { session_id, duration_ms, summary, metadata };
    } catch {
      return {
        session_id: null,
        duration_ms: null,
        summary: hookEventName || 'unknown event',
        metadata: {}
      };
    }
  }

  sanitizePath(fullPath) {
    if (!fullPath || typeof fullPath !== 'string') return '';
    const rel = path.relative(this.zylosDir, fullPath);
    if (rel.startsWith('..')) return path.basename(fullPath);
    return rel;
  }

  redactCredentials(text) {
    if (typeof text !== 'string') return text;
    let result = text;
    for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  buildSummary(hookEventName, toolName, durationMs, toolDetail) {
    const detail = toolDetail ? `: ${toolDetail}` : '';
    switch (hookEventName) {
      case 'PreToolUse':
        return `${toolName || 'Unknown'}${detail}`;
      case 'PostToolUse':
        return `${toolName || 'Unknown'}${detail}${durationMs ? ` (${durationMs}ms)` : ''}`;
      case 'UserPromptSubmit':
        return 'Turn started';
      case 'Stop':
        return 'Turn ended';
      case 'PermissionRequest':
        return `Permission requested: ${toolName || 'Unknown'}${detail}`;
      case 'SubagentStart':
        return 'Subagent started';
      case 'SubagentStop':
        return 'Subagent completed';
      default:
        return hookEventName || 'unknown event';
    }
  }

  _extractToolDetail(toolName, toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return null;
    try {
      if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
        const fp = toolInput.file_path;
        return fp ? this.sanitizePath(fp) : null;
      }
      if (toolName === 'Bash') {
        const cmd = toolInput.command;
        if (!cmd) return null;
        const firstLine = cmd.split('\n')[0];
        return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
      }
      if (toolName === 'Agent' || toolName === 'Task') {
        return toolInput.description || null;
      }
      if (toolName === 'WebSearch') {
        return toolInput.query ? `"${toolInput.query}"` : null;
      }
      if (toolName === 'WebFetch') {
        try {
          const u = new URL(toolInput.url || '');
          return u.hostname + u.pathname;
        } catch { return null; }
      }
    } catch { /* extraction failed — not critical */ }
    return null;
  }

  _redactObject(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        obj[key] = this.redactCredentials(value);
      } else if (value && typeof value === 'object') {
        this._redactObject(value);
      }
    }
  }
}
