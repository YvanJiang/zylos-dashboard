import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

export class HookInstaller {
  constructor(projectRoot, zylosDir) {
    this.projectRoot = projectRoot || path.resolve(__dirname, '..', '..');
    this.zylosDir = zylosDir || process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
    this.hookScript = path.join(this.projectRoot, 'lib', 'hook-ingest.cjs');
    this.statuslineScript = path.join(this.projectRoot, 'lib', 'statusline-ingest.cjs');
  }

  detectRuntime() {
    const rt = process.env.ZYLOS_RUNTIME;
    if (rt === 'claude' || rt === 'codex') return rt;
    return rt ? null : 'claude';
  }

  _command() {
    return `node ${this.hookScript}`;
  }

  _isOwn(command) {
    if (!command) return false;
    return command.includes(this.hookScript) ||
      (command.includes('hook-ingest.cjs') && command.includes('dashboard'));
  }

  // --- Claude Code ---

  _claudePath() {
    return path.join(this.zylosDir, '.claude', 'settings.json');
  }

  _readClaude() {
    try {
      return JSON.parse(fs.readFileSync(this._claudePath(), 'utf8'));
    } catch {
      return {};
    }
  }

  _writeClaude(settings) {
    const p = this._claudePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  }

  installClaudeHooks() {
    const settings = this._readClaude();
    if (!settings.hooks) settings.hooks = {};

    const cmd = this._command();
    let added = 0;

    for (const event of HOOK_EVENTS) {
      if (!Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = [];
      }

      const exists = settings.hooks[event].some(g =>
        g.hooks?.some(h => this._isOwn(h.command))
      );
      if (exists) continue;

      const entry = {
        hooks: [{ type: 'command', command: cmd, timeout: 2000 }]
      };
      if (TOOL_EVENTS.has(event)) entry.matcher = '';
      settings.hooks[event].push(entry);
      added++;
    }

    if (added > 0) this._writeClaude(settings);
    return { runtime: 'claude', added, total: HOOK_EVENTS.length, path: this._claudePath() };
  }

  uninstallClaudeHooks() {
    const settings = this._readClaude();
    if (!settings.hooks) return { runtime: 'claude', removed: 0 };

    let removed = 0;
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      const before = settings.hooks[event].length;
      settings.hooks[event] = settings.hooks[event].filter(g =>
        !g.hooks?.some(h => this._isOwn(h.command))
      );
      removed += before - settings.hooks[event].length;
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }

    if (removed > 0) this._writeClaude(settings);
    return { runtime: 'claude', removed, path: this._claudePath() };
  }

  // --- Codex ---

  _codexPath() {
    return path.join(os.homedir(), '.codex', 'hooks.json');
  }

  _readCodex() {
    try {
      return JSON.parse(fs.readFileSync(this._codexPath(), 'utf8'));
    } catch {
      return [];
    }
  }

  _writeCodex(hooks) {
    const p = this._codexPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(hooks, null, 2) + '\n');
  }

  installCodexHooks() {
    const hooks = this._readCodex();
    const cmd = this._command();
    let added = 0;

    for (const event of HOOK_EVENTS) {
      const exists = hooks.some(h => h.event === event && this._isOwn(h.command));
      if (exists) continue;
      hooks.push({ event, command: cmd, timeout: 2000 });
      added++;
    }

    if (added > 0) this._writeCodex(hooks);
    return { runtime: 'codex', added, total: HOOK_EVENTS.length, path: this._codexPath() };
  }

  uninstallCodexHooks() {
    const hooks = this._readCodex();
    const before = hooks.length;
    const filtered = hooks.filter(h => !this._isOwn(h.command));
    const removed = before - filtered.length;
    if (removed > 0) this._writeCodex(filtered);
    return { runtime: 'codex', removed, path: this._codexPath() };
  }

  // --- StatusLine ---

  _isOwnStatusline(command) {
    if (!command) return false;
    return command.includes(this.statuslineScript) ||
      (command.includes('statusline-ingest.cjs') && command.includes('dashboard'));
  }

  installStatusline() {
    const settings = this._readClaude();
    const cmd = `node ${this.statuslineScript}`;

    if (settings.statusLine?.command && this._isOwnStatusline(settings.statusLine.command)) {
      return { installed: false, reason: 'already_installed', path: this._claudePath() };
    }

    if (settings.statusLine?.command && !this._isOwnStatusline(settings.statusLine.command)) {
      return { installed: false, reason: 'existing_statusline', path: this._claudePath() };
    }

    settings.statusLine = {
      type: 'command',
      command: cmd,
      refreshInterval: 5
    };

    this._writeClaude(settings);
    return { installed: true, path: this._claudePath() };
  }

  uninstallStatusline() {
    const settings = this._readClaude();
    if (!settings.statusLine || !this._isOwnStatusline(settings.statusLine.command)) {
      return { removed: false };
    }

    delete settings.statusLine;
    this._writeClaude(settings);
    return { removed: true, path: this._claudePath() };
  }

  // --- Combined ---

  install() {
    const rt = this.detectRuntime();
    const hooks = rt === 'codex' ? this.installCodexHooks() : this.installClaudeHooks();
    const statusline = rt === 'claude' ? this.installStatusline() : { installed: false, reason: 'codex_runtime' };
    return { hooks, statusline };
  }

  uninstall() {
    return {
      claude: this.uninstallClaudeHooks(),
      codex: this.uninstallCodexHooks(),
      statusline: this.uninstallStatusline()
    };
  }
}
