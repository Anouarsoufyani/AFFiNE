import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { ISSUER, OAuthClient, SCOPES } from '../src/oauth.mjs';

export class MemoryStore {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
}

export async function oauthFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };
  const fixture = {
    calls: [],
    nonce: 'test-nonce',
    subject: 'test-user',
    scope: SCOPES,
    clientId: 'oaiapp_test',
    revokeStatus: 200,
  };
  fixture.idToken = async (overrides = {}) =>
    new SignJWT({
      nonce: fixture.nonce,
      email: 'test@example.invalid',
      iss: ISSUER,
      aud: fixture.clientId,
      sub: fixture.subject,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(privateKey);
  fixture.tokens = async () => ({
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    id_token: await fixture.idToken(),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: fixture.scope,
  });
  fixture.fetch = async (url, options = {}) => {
    fixture.calls.push({ url, options });
    if (url.endsWith('/.well-known/openid-configuration'))
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
        token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
      });
    if (url.endsWith('/.well-known/jwks.json'))
      return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/token'))
      return fixture.tokenResponse
        ? fixture.tokenResponse(options)
        : Response.json(await fixture.tokens());
    if (url.endsWith('/oauth/revoke'))
      return new Response(null, { status: fixture.revokeStatus });
    throw new Error('Unexpected mocked URL');
  };
  fixture.oauth = new OAuthClient({ fetchImpl: fixture.fetch });
  return fixture;
}

export const registration = () => ({
  client_id: 'oaiapp_test',
  subject: 'test-user',
  label: 'Test',
  tokens: {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    scope: SCOPES,
    expires_at: Date.now() + 3600_000,
    earliest_refresh_at: 0,
  },
});

export const completed = (
  output = [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Bonjour !' }],
    },
  ]
) => ({
  type: 'response.completed',
  response: {
    id: 'resp_mock',
    object: 'response',
    status: 'completed',
    output,
  },
});

export function sseResponse(events) {
  return new Response(
    events
      .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(''),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    }
  );
}
