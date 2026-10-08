import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { Script } from 'node:vm';

import { InferenceClient } from '../src/inference.mjs';
import { startServer } from '../src/server.mjs';
import { SessionManager } from '../src/session.mjs';
import {
  completed,
  MemoryStore,
  oauthFixture,
  registration,
  sseResponse,
} from './helpers.mjs';

async function gateway(
  t,
  fetchImpl = async () => sseResponse([completed()]),
  oauth = {}
) {
  const session = new SessionManager(new MemoryStore(), oauth);
  await session.initialize();
  await session.accept(registration());
  const result = await startServer({
    session,
    oauth,
    inference: new InferenceClient(session, { fetchImpl }),
    port: 0,
    startRefresh: false,
  });
  t.after(() => result.close());
  result.session = session;
  result.headers = {
    Authorization: `Bearer ${session.localKey}`,
    'Content-Type': 'application/json',
  };
  return result;
}

test('local UI has valid JavaScript, CSP and a protected same-site cookie', async t => {
  const app = await gateway(t);
  const response = await fetch(app.origin);
  const html = await response.text();
  assert.match(
    response.headers.get('content-security-policy'),
    /default-src 'none'/
  );
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.doesNotThrow(
    () => new Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1])
  );
  assert.equal(html.includes(app.session.localKey), false);
});

test('unauthenticated requests and hostile browser origins cannot consume the plan', async t => {
  const app = await gateway(t);
  assert.equal((await fetch(`${app.origin}/v1/models`)).status, 401);
  assert.equal(
    (
      await fetch(`${app.origin}/v1/models`, {
        headers: { ...app.headers, Origin: 'https://attacker.invalid' },
      })
    ).status,
    403
  );
  assert.equal(
    (
      await fetch(`${app.origin}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401
  );
});

test('DNS rebinding host header is rejected before serving the UI', async t => {
  const app = await gateway(t);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(
      app.origin,
      { headers: { Host: 'attacker.invalid' } },
      response => {
        response.resume();
        resolve(response.statusCode);
      }
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 403);
});

test('AFFiNE-style non-streaming probe receives JSON after upstream SSE completion', async t => {
  let upstream;
  const app = await gateway(t, async (url, options) => {
    upstream = JSON.parse(options.body);
    return sseResponse([completed()]);
  });
  const response = await fetch(`${app.origin}/v1/responses`, {
    method: 'POST',
    headers: app.headers,
    body: JSON.stringify({
      model: 'gpt-6-luna',
      input: [{ role: 'user', content: 'OK' }],
      stream: false,
      temperature: 0,
      max_output_tokens: 8,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'completed');
  assert.equal(upstream.stream, true);
  assert.equal(upstream.temperature, undefined);
  assert.equal(
    response.headers.get('x-gateway-omitted-parameters'),
    'temperature,max_output_tokens'
  );
});

test('streaming bridge forwards deltas and the terminal response', async t => {
  const app = await gateway(t, async () =>
    sseResponse([
      { type: 'response.output_text.delta', delta: 'Bonjour !' },
      completed(),
    ])
  );
  const response = await fetch(`${app.origin}/v1/responses`, {
    method: 'POST',
    headers: app.headers,
    body: JSON.stringify({
      model: 'gpt-6-luna',
      input: [{ role: 'user', content: 'Bonjour' }],
      stream: true,
    }),
  });
  assert.match(response.headers.get('content-type'), /event-stream/);
  const body = await response.text();
  assert.match(body, /response.output_text.delta/);
  assert.match(body, /response.completed/);
});

test('late quota failure is sanitized and never followed by completed', async t => {
  const app = await gateway(t, async () =>
    sseResponse([
      { type: 'response.output_text.delta', delta: 'Début' },
      {
        type: 'response.failed',
        response: {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'mock-private-value',
          },
        },
      },
    ])
  );
  const response = await fetch(`${app.origin}/v1/responses`, {
    method: 'POST',
    headers: app.headers,
    body: JSON.stringify({
      model: 'gpt-6-luna',
      input: [{ role: 'user', content: 'Bonjour' }],
      stream: true,
    }),
  });
  const body = await response.text();
  assert.match(body, /gateway.error/);
  assert.match(body, /subscription_sharing_usage_limit_exceeded/);
  assert.equal(body.includes('response.completed'), false);
  assert.equal(body.includes('mock-private-value'), false);
});

test('full mocked browser OAuth binds cookie/state, verifies JWT and consumes callback once', async t => {
  const fixture = await oauthFixture();
  const app = await gateway(t, undefined, fixture.oauth);
  // Force first registration instead of reauthorizing the fixture's existing account.
  const home = await fetch(app.origin);
  const html = await home.text();
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const csrf = JSON.parse(html.match(/const csrf=("[^"]+")/)[1]);
  const start = await fetch(`${app.origin}/auth/start`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-Gateway-CSRF': csrf,
      'Content-Type': 'application/json',
    },
    body: '{"new_account":true}',
  });
  assert.equal(start.status, 200);
  const auth = new URL((await start.json()).authorization_url);
  fixture.nonce = auth.searchParams.get('nonce');
  const callback = `${app.origin}/auth/callback?${new URLSearchParams({ state: auth.searchParams.get('state'), code: 'mock-code', client_id: fixture.clientId })}`;
  assert.equal(
    (await fetch(callback, { headers: { Cookie: cookie }, redirect: 'manual' }))
      .status,
    303
  );
  assert.equal(app.session.active().tokens.access_token, 'mock-access-token');
  assert.equal(
    (await fetch(callback, { headers: { Cookie: cookie }, redirect: 'manual' }))
      .status,
    401
  );
});

test('logout invalidates pending OAuth so an old callback cannot reconnect', async t => {
  const fixture = await oauthFixture();
  const app = await gateway(t, undefined, fixture.oauth);
  const home = await fetch(app.origin);
  const html = await home.text();
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const csrf = JSON.parse(html.match(/const csrf=("[^"]+")/)[1]);
  const start = await fetch(`${app.origin}/auth/start`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-Gateway-CSRF': csrf,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const auth = new URL((await start.json()).authorization_url);
  await fetch(`${app.origin}/auth/logout`, {
    method: 'POST',
    headers: app.headers,
    body: '{}',
  });
  const callback = `${app.origin}/auth/callback?${new URLSearchParams({ state: auth.searchParams.get('state'), code: 'mock-code', client_id: fixture.clientId })}`;
  assert.equal(
    (await fetch(callback, { headers: { Cookie: cookie } })).status,
    401
  );
});
