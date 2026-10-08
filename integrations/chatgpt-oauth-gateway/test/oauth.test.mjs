import assert from 'node:assert/strict';
import test from 'node:test';

import { OAuthClient, pkceChallenge, SCOPES } from '../src/oauth.mjs';
import { oauthFixture } from './helpers.mjs';

test('PKCE uses the RFC 7636 S256 test vector', () => {
  assert.equal(
    pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  );
});

test('dynamic registration uses our app, host and separate inference consent', async () => {
  const fixture = await oauthFixture();
  const { url, transaction } = await fixture.oauth.authorization({
    hostId: 'urn:uuid:test-host',
    redirectUri: 'http://127.0.0.1:12345/auth/callback',
    browserSession: 'test-browser',
  });
  const params = new URL(url).searchParams;
  assert.equal(params.get('client_id'), 'dynamic_agent_client');
  assert.equal(params.get('agent_name_hint'), 'AFFiNE Local OAuth Gateway');
  assert.equal(params.get('scope'), SCOPES);
  assert.equal(
    params.get('code_challenge'),
    pkceChallenge(transaction.verifier)
  );
  assert.equal(params.get('resource'), 'https://api.openai.com/v1');
  assert.equal(params.has('client_secret'), false);
  assert.equal(params.has('id_token_hint'), false);
});

test('returning registration reuses issued client and host without app-name or token URL hints', async () => {
  const fixture = await oauthFixture();
  const result = await fixture.oauth.authorization({
    hostId: 'urn:uuid:original-host',
    redirectUri: 'http://127.0.0.1:12345/auth/callback',
    browserSession: 'browser',
    registration: {
      client_id: 'oaiapp_saved',
      subject: 'test-user',
      tokens: { id_token: 'mock-secret' },
    },
  });
  const params = new URL(result.url).searchParams;
  assert.equal(params.get('client_id'), 'oaiapp_saved');
  assert.equal(params.get('ext_agent_host_id'), 'urn:uuid:original-host');
  assert.equal(params.has('agent_name_hint'), false);
  assert.equal(result.url.includes('mock-secret'), false);
});

async function pending(fixture, registration) {
  const { transaction } = await fixture.oauth.authorization({
    hostId: 'urn:uuid:host',
    redirectUri: 'http://127.0.0.1:12345/auth/callback',
    browserSession: 'browser',
    registration,
  });
  fixture.nonce = transaction.nonce;
  return {
    transaction,
    params: new URLSearchParams({
      state: transaction.state,
      code: 'mock-code',
      client_id: fixture.clientId,
    }),
  };
}

test('authorization code is exchanged using issued client; signed identity and exact callback verified', async () => {
  const fixture = await oauthFixture();
  const { transaction, params } = await pending(fixture);
  const saved = await fixture.oauth.exchange(transaction, params, 'browser');
  assert.equal(saved.client_id, 'oaiapp_test');
  assert.equal(saved.subject, 'test-user');
  const tokenCall = fixture.calls.find(call =>
    call.url.endsWith('/oauth/token')
  );
  assert.equal(tokenCall.options.body.get('client_id'), 'oaiapp_test');
  assert.equal(
    tokenCall.options.body.get('redirect_uri'),
    transaction.redirectUri
  );
  assert.equal(
    tokenCall.options.body.get('code_verifier'),
    transaction.verifier
  );
});

for (const scenario of [
  'state',
  'browser',
  'expired',
  'denied',
  'missing-client',
  'changed-client',
]) {
  test(`OAuth callback rejects ${scenario} before exchanging a code`, async () => {
    const fixture = await oauthFixture();
    const { transaction, params } = await pending(
      fixture,
      scenario === 'changed-client' ? { client_id: 'oaiapp_saved' } : undefined
    );
    let browser = 'browser';
    if (scenario === 'state') params.set('state', 'wrong');
    if (scenario === 'browser') browser = 'wrong';
    if (scenario === 'expired') transaction.expiresAt = 0;
    if (scenario === 'denied') params.set('error', 'access_denied');
    if (scenario === 'missing-client') params.delete('client_id');
    await assert.rejects(fixture.oauth.exchange(transaction, params, browser));
    assert.equal(
      fixture.calls.some(call => call.url.endsWith('/oauth/token')),
      false
    );
  });
}

for (const scenario of [
  'nonce',
  'audience',
  'issuer',
  'subject',
  'expired',
  'signature',
]) {
  test(`OIDC verification rejects incorrect ${scenario}`, async () => {
    const fixture = await oauthFixture();
    let jwt = await fixture.idToken(
      scenario === 'nonce' ? { nonce: 'wrong' } : {}
    );
    if (scenario === 'audience') fixture.clientId = 'oaiapp_other';
    if (scenario === 'issuer') {
      jwt = await fixture.idToken({ iss: 'https://attacker.invalid' });
    }
    if (scenario === 'expired') {
      jwt = await fixture.idToken({ exp: 1 });
    }
    if (scenario === 'signature') jwt = jwt.slice(0, -8) + 'AAAAAAAA';
    await assert.rejects(
      fixture.oauth.verifyIdentity(
        jwt,
        fixture.clientId,
        fixture.nonce,
        scenario === 'subject' ? 'another-user' : 'test-user'
      ),
      { code: 'oauth_id_token_invalid' }
    );
  });
}

test('refresh uses own issued client, rotates token and retains scope without requesting new scope', async () => {
  const fixture = await oauthFixture();
  fixture.tokenResponse = async () =>
    Response.json({
      ...(await fixture.tokens()),
      refresh_token: 'mock-new-refresh',
      scope: undefined,
    });
  const tokens = await fixture.oauth.refresh({
    client_id: fixture.clientId,
    subject: fixture.subject,
    tokens: { refresh_token: 'mock-old-refresh', scope: SCOPES },
  });
  assert.equal(tokens.refresh_token, 'mock-new-refresh');
  assert.equal(tokens.scope, SCOPES);
  const body = fixture.calls.find(call => call.url.endsWith('/oauth/token'))
    .options.body;
  assert.equal(body.get('client_id'), fixture.clientId);
  assert.equal(body.has('scope'), false);
});

test('discovery rejects token endpoints outside the official issuer', async () => {
  const oauth = new OAuthClient({
    fetchImpl: async () =>
      Response.json({
        issuer: 'https://auth.openai.com',
        authorization_endpoint: 'https://attacker.invalid/authorize',
      }),
  });
  await assert.rejects(oauth.discovery(), { code: 'oauth_endpoint_rejected' });
});

test('invalid_grant response never echoes upstream secrets', async () => {
  const fixture = await oauthFixture();
  fixture.tokenResponse = async () =>
    Response.json(
      { error: 'invalid_grant', error_description: 'mock-private-value' },
      { status: 400 }
    );
  await assert.rejects(
    fixture.oauth.tokenRequest({ grant_type: 'refresh_token' }),
    error =>
      error.code === 'oauth_reauthentication_required' &&
      !String(error).includes('mock-private-value')
  );
});
