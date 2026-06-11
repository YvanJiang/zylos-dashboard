import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryBrowser, validateMemoryQueryPath } from '../src/lib/memory-browser.js';

function makeZylosDir() {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-memory-browser-test-'));
  fs.mkdirSync(path.join(zylosDir, 'memory', 'reference'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, 'memory', 'identity.md'), '# Identity\n');
  fs.writeFileSync(path.join(zylosDir, 'memory', 'reference', 'projects.md'), '# Projects\n');
  fs.mkdirSync(path.join(zylosDir, 'memory', '.git'), { recursive: true });
  try {
    fs.symlinkSync(os.tmpdir(), path.join(zylosDir, 'memory', 'escape-link'));
  } catch {
    // Some platforms disallow symlinks in temp dirs; the tree test still covers .git hiding.
  }
  return zylosDir;
}

test('memory tree returns navigation metadata without hashes or symlinks', async () => {
  const zylosDir = makeZylosDir();
  try {
    const browser = new MemoryBrowser({ zylosDir });
    const tree = await browser.tree();
    const serialized = JSON.stringify(tree);
    assert.equal(serialized.includes('.git'), false);
    assert.equal(serialized.includes('escape-link'), false);
    assert.equal(serialized.includes('sha256'), false);
    const identity = tree.root.children.find(node => node.name === 'identity.md');
    assert.equal(identity.type, 'file');
    assert.equal(identity.renderable, true);
    assert.equal(typeof identity.size_bytes, 'number');
    assert.equal(typeof identity.mtime, 'string');
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory file returns text metadata and rejects traversal, large, and binary files', async () => {
  const zylosDir = makeZylosDir();
  try {
    const memoryDir = path.join(zylosDir, 'memory');
    fs.writeFileSync(path.join(memoryDir, 'large.md'), Buffer.alloc(1024 * 1024 + 1, 'a'));
    fs.writeFileSync(path.join(memoryDir, 'binary.md'), Buffer.from([0xff, 0xfe, 0x00, 0x61]));
    const browser = new MemoryBrowser({ zylosDir });

    const file = await browser.file('identity.md');
    assert.equal(file.path, 'identity.md');
    assert.equal(file.markdown, true);
    assert.equal(file.text, '# Identity\n');
    assert.match(file.sha256, /^[a-f0-9]{64}$/);

    await assert.rejects(() => browser.file('../state.md'), /invalid_memory_path/);
    await assert.rejects(() => browser.file('/tmp/state.md'), /invalid_memory_path/);
    await assert.rejects(() => browser.file('reference/../../.env'), /invalid_memory_path/);
    await assert.rejects(() => browser.file('large.md'), (err) => err.code === 'memory_file_too_large' && err.status === 413);
    await assert.rejects(() => browser.file('binary.md'), (err) => err.code === 'unsupported_memory_file' && err.status === 415);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory git metadata uses validated relative paths and returns latest commit', async () => {
  const zylosDir = makeZylosDir();
  try {
    const memoryDir = path.join(zylosDir, 'memory');
    execFileSync('git', ['-C', memoryDir, 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', memoryDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', memoryDir, 'config', 'user.name', 'Test User']);
    execFileSync('git', ['-C', memoryDir, 'add', 'identity.md']);
    execFileSync('git', ['-C', memoryDir, 'commit', '-m', 'add identity'], { stdio: 'ignore' });

    const browser = new MemoryBrowser({ zylosDir });
    const result = await browser.git('identity.md');
    assert.equal(result.path, 'identity.md');
    assert.equal(result.commit.subject, 'add identity');
    assert.match(result.commit.hash, /^[a-f0-9]{40}$/);
    assert.match(result.commit.short_hash, /^[a-f0-9]+$/);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('memory query path grammar allows nested query slashes but rejects unsafe paths', () => {
  assert.equal(validateMemoryQueryPath('reference/projects.md'), 'reference/projects.md');
  assert.throws(() => validateMemoryQueryPath('../state.md'), /invalid_memory_path/);
  assert.throws(() => validateMemoryQueryPath('reference/../../.env'), /invalid_memory_path/);
  assert.throws(() => validateMemoryQueryPath('C:\\secret.md'), /invalid_memory_path/);
  assert.throws(() => validateMemoryQueryPath('reference\\projects.md'), /invalid_memory_path/);
});
