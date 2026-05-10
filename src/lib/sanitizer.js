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

      const metadata = {};
      if (tool_name) metadata.tool_name = tool_name;
      if (tool_use_id) metadata.tool_use_id = tool_use_id;

      const safeFields = ['timestamp', 'hook_event_name', 'runtime'];
      for (const key of safeFields) {
        if (rawPayload[key] !== undefined) metadata[key] = rawPayload[key];
      }

      this._redactObject(metadata);

      for (const key of STRIP_KEYS) {
        delete metadata[key];
      }

      const summary = this.buildSummary(hookEventName, tool_name, duration_ms);

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

  buildSummary(hookEventName, toolName, durationMs) {
    switch (hookEventName) {
      case 'PreToolUse':
        return `${toolName || 'Unknown'} tool started`;
      case 'PostToolUse':
        return `${toolName || 'Unknown'} tool completed${durationMs ? `, ${durationMs}ms` : ''}`;
      case 'UserPromptSubmit':
        return 'Turn started';
      case 'Stop':
        return 'Turn ended';
      case 'PermissionRequest':
        return `Permission requested: ${toolName || 'Unknown'}`;
      default:
        return hookEventName || 'unknown event';
    }
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
