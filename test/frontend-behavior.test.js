import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('prompt source transient display is capped at 5 seconds', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /const PROMPT_TRANSIENT_SECONDS = 5;/);
  assert.match(app, /promptAge < PROMPT_TRANSIENT_SECONDS/);
  assert.doesNotMatch(app, /promptAge < 30/);
});

test('runtime info upgrade badges use semver-aware comparison', () => {
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  const runtimeInfo = fs.readFileSync(path.resolve('src/lib/runtime-info.js'), 'utf8');
  assert.match(runtimeInfo, /isNewerVersion\(latest\.cc, ccEffectiveVersion\)/);
  assert.match(runtimeInfo, /isNewerVersion\(latest\.zylos, zylosVersion\)/);
  assert.match(runtimeInfo, /isNewerVersion\(latest\.codex, codexInstalledVersion\)/);
  assert.match(index, /applyVersionUpdateFields\(info, latest,/);
  assert.doesNotMatch(index, /latest\.cc !== ccEffective/);
  assert.doesNotMatch(index, /latest\.zylos !== zylosVersion/);
});

test('Codex runtime renders CLI update badge in info bar and actions modal', () => {
  const app = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  assert.match(app, /const codexVersion = ri\.codex_running \|\| ri\.codex_version \|\| ri\.codex_installed;/);
  assert.match(app, /if \(ri\.codex_restart\) cv \+=/);
  assert.match(app, /else if \(ri\.codex_update\) cv \+=/);
  assert.match(app, /const cliUpdate = meta\.runtime_cli === 'codex' \? ri\?\.codex_restart \|\| ri\?\.codex_update : ri\?\.cc_update;/);
  assert.match(app, /ccVer\.classList\.toggle\('action-ver-dot', !!cliUpdate\)/);
});

test('Codex runtime info exposes running, installed, effective, and restart fields', () => {
  const index = fs.readFileSync(path.resolve('src/index.js'), 'utf8');
  assert.match(index, /const codexRunning = activeRuntime === 'codex' \? codexRuntimeInfo\?\.cli_version \|\| null : null;/);
  assert.match(index, /codex_version: codexRunning \|\| codexInstalledVersion \|\| null,/);
  assert.match(index, /codex_running: codexRunning,/);
  assert.match(index, /codex_installed: codexInstalledVersion \|\| null,/);
  assert.match(index, /info\.codex_restart = codexInstalledVersion;/);
  assert.match(index, /pending_restart: !!needsRestart,/);
});

test('upgrade-zylos writes a restart marker and uses double-fork spawning', () => {
  const actions = fs.readFileSync(path.resolve('src/lib/actions.js'), 'utf8');
  assert.match(actions, /upgrade-zylos-pending\.json/);
  assert.match(actions, /spawn\(process\.execPath, \['-e', script\]/);
  assert.match(actions, /spawn\('zylos', \['upgrade', '--self', '-y'\]/);
});
