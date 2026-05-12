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

      if (hookEventName === 'SubagentStop' || hookEventName === 'Stop') {
        const msg = rawPayload.last_assistant_message;
        if (typeof msg === 'string' && msg.length > 0) {
          const redacted = this.redactCredentials(msg);
          metadata.assistant_summary = redacted.length > 200 ? redacted.slice(0, 197) + '...' : redacted;
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
        return this._summarizeBashCommand(toolInput.command);
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

  _summarizeBashCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return null;

    let line = cmd.split('\n')[0].trim();

    // Strip leading comment-only lines
    if (/^#\s/.test(line)) {
      const lines = cmd.split('\n');
      for (const l of lines) {
        const t = l.trim();
        if (t && !/^#\s/.test(t)) { line = t; break; }
      }
      if (/^#\s/.test(line)) return line.slice(0, 60);
    }

    // Strip shell chains: cd xxx && actual_command → actual_command
    line = line.replace(/^cd\s+\S+\s*&&\s*/i, '');
    // Strip leading env exports: export $(grep...) && cmd → cmd
    line = line.replace(/^export\s+\$\([^)]*\)\s*&&\s*/i, '');

    // Take first command in a pipe chain (handles optional whitespace around |)
    const pipeMatch = line.match(/(?<![|\\])\|(?!\|)/);
    const pipeIdx = pipeMatch ? pipeMatch.index : -1;
    const pipeCmd = pipeIdx > 0 ? line.slice(0, pipeIdx).trimEnd() : line;

    // Strip redirections at the end
    let clean = pipeCmd.replace(/\s+\d*>[>&]?\s*\S+\s*$/g, '').trim();

    // Shorten filesystem paths (preceded by whitespace/quote/start, not inside URLs)
    clean = clean.replace(/(?<=^|[\s"'=])(?:\/(?:home|Users|tmp|var|usr|opt|etc|root)(?:\/[\w.@+-]+){3,}|~(?:\/[\w.@+-]+){3,})/g, (p) => this._shortenPath(p));

    // Truncate
    if (pipeIdx > 0 && clean.length < 70) clean += ' | ...';
    return clean.length > 80 ? clean.slice(0, 77) + '...' : clean;
  }

  _shortenPath(fullPath) {
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length <= 3) return fullPath;
    return parts.slice(-3).join('/');
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
