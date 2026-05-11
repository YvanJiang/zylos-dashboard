import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HookInstaller } from '../src/lib/hook-installer.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hook-installer-test-'));
}

function makeInstaller(projectRoot, tmpHome) {
  const installer = new HookInstaller(projectRoot, tmpHome);
  installer._codexPath = () => path.join(tmpHome, '.codex', 'hooks.json');
  return installer;
}

test('HookInstaller — Claude', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();
  const installer = makeInstaller(projectRoot, tmpHome);

  await t.test('install creates hook entries for all 5 events', () => {
    const result = installer.installClaudeHooks();
    assert.equal(result.added, 5);

    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      assert.ok(settings.hooks[event], `missing event ${event}`);
      assert.ok(settings.hooks[event].length > 0);
    }
  });

  await t.test('idempotent — second install adds nothing', () => {
    const result = installer.installClaudeHooks();
    assert.equal(result.added, 0);

    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      assert.equal(settings.hooks[event].length, 1);
    }
  });

  await t.test('tool events have matcher, non-tool events do not', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(settings.hooks.PreToolUse[0].matcher, '');
    assert.equal(settings.hooks.PostToolUse[0].matcher, '');
    assert.equal(settings.hooks.UserPromptSubmit[0].matcher, undefined);
    assert.equal(settings.hooks.Stop[0].matcher, undefined);
    assert.equal(settings.hooks.PermissionRequest[0].matcher, undefined);
  });

  await t.test('hooks are registered as async with short timeout', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.equal(hook.async, true, `${event} hook should be async`);
      assert.equal(hook.timeout, 5, `${event} hook timeout should be 5ms`);
    }
  });

  await t.test('preserves existing hooks', () => {
    const existingHook = {
      hooks: [{ type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js', timeout: 5 }],
      matcher: ''
    };
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    settings.hooks.PreToolUse.unshift(existingHook);
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    installer.installClaudeHooks();

    const after = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(after.hooks.PreToolUse.length, 2);
    assert.ok(after.hooks.PreToolUse[0].hooks[0].command.includes('activity-monitor'));
  });

  await t.test('upgrades existing sync hooks to async in-place', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      if (!settings.hooks[event]) continue;
      for (const group of settings.hooks[event]) {
        for (const h of group.hooks || []) {
          if (installer._isOwn(h.command)) {
            h.timeout = 2000;
            delete h.async;
          }
        }
      }
    }
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    const result = installer.installClaudeHooks();
    assert.ok(result.added > 0, 'should report updated hooks');

    const after = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      const hook = after.hooks[event].find(g => g.hooks?.some(h => installer._isOwn(h.command)));
      const h = hook.hooks.find(h => installer._isOwn(h.command));
      assert.equal(h.async, true, `${event} should be async after upgrade`);
      assert.equal(h.timeout, 5, `${event} timeout should be 5 after upgrade`);
    }
  });

  await t.test('uninstall removes only own hooks', () => {
    const result = installer.uninstallClaudeHooks();
    assert.equal(result.removed, 5);

    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes('activity-monitor'));
    assert.equal(settings.hooks.PostToolUse, undefined);
  });

  await t.test('uninstall is idempotent', () => {
    const result = installer.uninstallClaudeHooks();
    assert.equal(result.removed, 0);
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('HookInstaller — Codex', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();
  const installer = makeInstaller(projectRoot, tmpHome);

  await t.test('install creates entries for all 5 events', () => {
    const result = installer.installCodexHooks();
    assert.equal(result.added, 5);

    const hooks = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.equal(hooks.length, 5);
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      assert.ok(hooks.some(h => h.event === event), `missing event ${event}`);
    }
  });

  await t.test('idempotent — second install adds nothing', () => {
    const result = installer.installCodexHooks();
    assert.equal(result.added, 0);

    const hooks = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.equal(hooks.length, 5);
  });

  await t.test('preserves existing entries', () => {
    const hooks = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    hooks.unshift({ event: 'PreToolUse', command: 'node ~/other-script.js', timeout: 1000 });
    fs.writeFileSync(installer._codexPath(), JSON.stringify(hooks, null, 2) + '\n');

    installer.installCodexHooks();

    const after = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.equal(after.length, 6);
    assert.ok(after[0].command.includes('other-script'));
  });

  await t.test('upgrades existing sync hooks to async in-place', () => {
    const hooks = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    for (const h of hooks) {
      if (installer._isOwn(h.command)) {
        h.timeout = 2000;
        delete h.async;
      }
    }
    fs.writeFileSync(installer._codexPath(), JSON.stringify(hooks, null, 2) + '\n');

    const result = installer.installCodexHooks();
    assert.ok(result.added > 0, 'should report updated hooks');

    const after = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      const h = after.find(e => e.event === event && installer._isOwn(e.command));
      assert.ok(h, `${event} own hook should still exist`);
      assert.equal(h.async, true, `${event} should be async after upgrade`);
      assert.equal(h.timeout, 5, `${event} timeout should be 5 after upgrade`);
    }
  });

  await t.test('uninstall removes only own entries', () => {
    const result = installer.uninstallCodexHooks();
    assert.equal(result.removed, 5);

    const hooks = JSON.parse(fs.readFileSync(installer._codexPath(), 'utf8'));
    assert.equal(hooks.length, 1);
    assert.ok(hooks[0].command.includes('other-script'));
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('HookInstaller — detectRuntime', async (t) => {
  const installer = new HookInstaller('/tmp/fake');

  await t.test('defaults to claude when ZYLOS_RUNTIME unset', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    delete process.env.ZYLOS_RUNTIME;
    assert.equal(installer.detectRuntime(), 'claude');
    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
  });

  await t.test('returns codex when set', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    process.env.ZYLOS_RUNTIME = 'codex';
    assert.equal(installer.detectRuntime(), 'codex');
    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
    else delete process.env.ZYLOS_RUNTIME;
  });

  await t.test('returns null for unknown runtime', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    process.env.ZYLOS_RUNTIME = 'unknown';
    assert.equal(installer.detectRuntime(), null);
    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
    else delete process.env.ZYLOS_RUNTIME;
  });
});

test('HookInstaller — StatusLine', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();
  const installer = makeInstaller(projectRoot, tmpHome);

  await t.test('install creates statusLine entry', () => {
    const result = installer.installStatusline();
    assert.equal(result.installed, true);

    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(settings.statusLine.type, 'command');
    assert.ok(settings.statusLine.command.includes('statusline-ingest.cjs'));
    assert.equal(settings.statusLine.refreshInterval, 5);
  });

  await t.test('idempotent — second install skips', () => {
    const result = installer.installStatusline();
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'already_installed');
  });

  await t.test('does not overwrite existing non-dashboard statusline', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    settings.statusLine = { type: 'command', command: 'node ~/my-statusline.js', refreshInterval: 10 };
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    const result = installer.installStatusline();
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'existing_statusline');
  });

  await t.test('uninstall removes own statusline only', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    settings.statusLine = { type: 'command', command: `node ${installer.statuslineScript}`, refreshInterval: 5 };
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    const result = installer.uninstallStatusline();
    assert.equal(result.removed, true);

    const after = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    assert.equal(after.statusLine, undefined);
  });

  await t.test('uninstall does not remove non-dashboard statusline', () => {
    const settings = JSON.parse(fs.readFileSync(installer._claudePath(), 'utf8'));
    settings.statusLine = { type: 'command', command: 'node ~/other.js', refreshInterval: 10 };
    fs.writeFileSync(installer._claudePath(), JSON.stringify(settings, null, 2) + '\n');

    const result = installer.uninstallStatusline();
    assert.equal(result.removed, false);
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('HookInstaller — install() dispatches by runtime', async (t) => {
  const tmpHome = makeTmpDir();
  const projectRoot = makeTmpDir();

  await t.test('installs claude hooks + statusline when runtime is claude', () => {
    const prev = process.env.ZYLOS_RUNTIME;
    process.env.ZYLOS_RUNTIME = 'claude';

    const installer = makeInstaller(projectRoot, tmpHome);
    const result = installer.install();
    assert.equal(result.hooks.runtime, 'claude');
    assert.equal(result.hooks.added, 5);
    assert.equal(result.statusline.installed, true);

    if (prev !== undefined) process.env.ZYLOS_RUNTIME = prev;
    else delete process.env.ZYLOS_RUNTIME;
  });

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});
