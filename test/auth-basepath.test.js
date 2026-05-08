import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function writeConfig(zylosDir, password = 'secret') {
  const configDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), `${JSON.stringify({
    auth: {
      enabled: true,
      password
    }
  }, null, 2)}\n`);
}

async function makeServer() {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir);

  const previousZylosDir = process.env.ZYLOS_DIR;
  const previousPort = process.env.DASHBOARD_PORT;
  process.env.ZYLOS_DIR = zylosDir;
  process.env.DASHBOARD_PORT = '0';

  const moduleUrl = new URL(`../src/index.js?test=${Date.now()}-${Math.random()}`, import.meta.url);
  const { createServer } = await import(moduleUrl.href);

  process.env.ZYLOS_DIR = previousZylosDir;
  process.env.DASHBOARD_PORT = previousPort;
  if (previousZylosDir == null) delete process.env.ZYLOS_DIR;
  if (previousPort == null) delete process.env.DASHBOARD_PORT;

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
    zylosDir
  };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function form(body) {
  return new URLSearchParams(body);
}

test('auth protects API and renders proxy-prefixed login URLs', async () => {
  const { origin, server } = await makeServer();
  try {
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);

    const summary = await fetch(`${origin}/api/summary`);
    assert.equal(summary.status, 401);

    const root = await fetch(`${origin}/`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard' },
      redirect: 'manual'
    });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/dashboard/login?next=%2Fdashboard%2F');

    const login = await fetch(`${origin}/login?next=%2Fdashboard%2F`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard' },
      redirect: 'manual'
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /action="\/dashboard\/login"/);
    assert.match(body, /href="\/dashboard\/_assets\/css\/dashboard\.css"/);
    assert.match(body, /name="next" value="\/dashboard\/"/);
  } finally {
    await closeServer(server);
  }
});

test('login sets secure cookie and authenticated requests can reach API and SSE', async () => {
  const { origin, server } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Prefix': '/dashboard'
      },
      body: form({ password: 'secret', next: '/dashboard/' }),
      redirect: 'manual'
    });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/dashboard/');

    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /__Host-zylos_dashboard_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);

    const summary = await fetch(`${origin}/api/summary`, {
      headers: { Cookie: cookie }
    });
    assert.equal(summary.status, 200);

    const events = await fetch(`${origin}/api/events`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(1000)
    }).catch((err) => err);
    assert.equal(events.status, 200);
    await events.body.cancel();
  } finally {
    await closeServer(server);
  }
});

test('logout requires same-origin POST and respects forwarded prefix', async () => {
  const { origin, server } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'secret' }),
      redirect: 'manual'
    });
    const cookie = login.headers.get('set-cookie');

    const missingCsrf = await fetch(`${origin}/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual'
    });
    assert.equal(missingCsrf.status, 403);

    const logout = await fetch(`${origin}/logout`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'X-Forwarded-Prefix': '/dashboard'
      },
      redirect: 'manual'
    });
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get('location'), '/dashboard/login');
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await closeServer(server);
  }
});

test('unsafe forwarded prefixes fall back to direct root paths', async () => {
  const { origin, server } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard?next=//evil.test' },
      redirect: 'manual'
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /action="\/login"/);
    assert.match(body, /href="\/_assets\/css\/dashboard\.css"/);
    assert.doesNotMatch(body, /evil\.test/);
  } finally {
    await closeServer(server);
  }
});
