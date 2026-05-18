#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookInstaller } from '../src/lib/hook-installer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');
const configPath = path.join(dataDir, 'config.json');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

if (!fs.existsSync(configPath)) {
  const config = {
    port: 3470,
    host: '127.0.0.1',
    theme: 'default',
    refreshMs: 5000,
    auth: {
      enabled: false,
      bearerToken: null,
      allowUrlTokenOnLocalhost: false
    },
    retention: {
      metrics: 'full',
      logs: 'full',
      tracesSampleRate: 0.1,
      archiveAfterDays: 30
    }
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

console.log(`dashboard data dir ready: ${dataDir}`);

const installer = new HookInstaller(projectRoot, zylosDir);
const rt = installer.detectRuntime();
if (rt === 'claude') {
  const result = installer.installClaudeHooks();
  console.log(`claude hooks: ${result.added} added (${result.total} events)`);
} else if (rt === 'codex') {
  const result = installer.installCodexHooks();
  console.log(`codex hooks: ${result.added} added (${result.total} events)`);
} else {
  console.log('unknown runtime, skipping hook installation');
}
