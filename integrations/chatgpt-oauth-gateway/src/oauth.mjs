import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { createLocalJWKSet, jwtVerify } from 'jose';

import { GatewayError, readJson } from './errors.mjs';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const APP_NAME = 'AFFiNE Local OAuth Gateway';
export const randomSecret = () => randomBytes(32).toString('base64url');
export const pkceChallenge = verifier =>
  createHash('sha256').update(verifier).digest('base64url');
export function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OAuthClient {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl;
  }
  async discovery() {
    if (!this.metadata) {
      const response = await this.fetch(
        `${ISSUER}/.well-known/openid-configuration`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (!response.ok) throw new GatewayError('oauth_discovery_failed', 502);
      const metadata = await readJson(response);
      if (metadata.issuer !== ISSUER)
        throw new GatewayError('oauth_issuer_mismatch', 502);
      for (const field of [
        'authorization_endpoint',
        'token_endpoint',
        'jwks_uri',
        'revocation_endpoint',
      ]) {
        let url;
        try {
          url = new URL(metadata[field]);
        } catch {
          throw new GatewayError('oauth_discovery_invalid', 502);
        }
        if (url.origin !== ISSUER || url.username || url.password || url.hash) {
          throw new GatewayError('oauth_endpoint_rejected', 502);
        }
      }
      this.metadata = metadata;
    }
    return this.metadata;
  }
  async authorization({ hostId, redirectUri, registration, browserSession }) {
    const metadata = await this.discovery();
    const verifier = randomSecret();
    const transaction = {
      state: randomSecret(),
      nonce: randomSecret(),
      verifier,
      redirectUri,
      browserSession,
      clientId: registration?.client_id,
      subject: registration?.subject,
      expiresAt: Date.now() + 5 * 60_000,
    };
    const url = new URL(metadata.authorization_endpoint);
    const params = {
      client_id: registration?.client_id ?? 'dynamic_agent_client',
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge_method: 'S256',
      code_challenge: pkceChallenge(verifier),
    };
    if (!registration) params.agent_name_hint = APP_NAME;
    // Avoid id_token_hint URLs entirely; returning users see the account selector.
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return { url: url.toString(), transaction };
  }
  async tokenRequest(fields) {
    const metadata = await this.discovery();
    const response = await this.fetch(metadata.token_endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, resource: RESOURCE }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      const code =
        body.error === 'invalid_grant'
          ? 'oauth_reauthentication_required'
          : 'oauth_token_exchange_failed';
      throw new GatewayError(code, response.status >= 500 ? 502 : 401);
    }
    return body;
  }
  async verifyIdentity(idToken, clientId, nonce, subject) {
    if (typeof idToken !== 'string')
      throw new GatewayError('oauth_id_token_missing', 401);
    const metadata = await this.discovery();
    const response = await this.fetch(metadata.jwks_uri, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GatewayError('oauth_jwks_failed', 502);
    const jwks = await readJson(response);
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
        issuer: ISSUER,
        audience: clientId,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      });
      if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        (nonce !== undefined && !sameSecret(payload.nonce, nonce)) ||
        (subject !== undefined && payload.sub !== subject) ||
        (payload.azp !== undefined && payload.azp !== clientId) ||
        (Array.isArray(payload.aud) &&
          payload.aud.length > 1 &&
          payload.azp !== clientId)
      )
        throw new Error();
      return payload;
    } catch {
      throw new GatewayError('oauth_id_token_invalid', 401);
    }
  }
  normalizeTokens(tokens, previous) {
    if (
      typeof tokens.access_token !== 'string' ||
      !tokens.access_token ||
      typeof tokens.refresh_token !== 'string' ||
      !tokens.refresh_token ||
      tokens.token_type?.toLowerCase() !== 'bearer' ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      tokens.expires_in > 86_400
    ) {
      throw new GatewayError('oauth_token_response_invalid', 502);
    }
    const scope = tokens.scope ?? previous?.scope;
    if (typeof scope !== 'string')
      throw new GatewayError('oauth_scope_missing', 401);
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token ?? previous?.id_token,
      scope,
      expires_at: Date.now() + tokens.expires_in * 1000,
      earliest_refresh_at: Number.isFinite(tokens.earliest_refresh_at)
        ? tokens.earliest_refresh_at * 1000
        : 0,
    };
  }
  async exchange(transaction, params, browserSession) {
    if (
      Date.now() > transaction.expiresAt ||
      !sameSecret(params.get('state'), transaction.state) ||
      !sameSecret(browserSession, transaction.browserSession)
    )
      throw new GatewayError('oauth_state_invalid', 401);
    if (params.has('error'))
      throw new GatewayError('oauth_authorization_declined', 401);
    const returnedId = params.get('client_id');
    const clientId = transaction.clientId ?? returnedId;
    if (
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      !/^[A-Za-z0-9_-]{4,200}$/.test(clientId) ||
      (transaction.clientId &&
        returnedId &&
        returnedId !== transaction.clientId)
    ) {
      throw new GatewayError('oauth_client_id_invalid', 401);
    }
    const code = params.get('code');
    if (!code || code.length > 8192)
      throw new GatewayError('oauth_code_missing', 401);
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: transaction.verifier,
      redirect_uri: transaction.redirectUri,
    });
    const identity = await this.verifyIdentity(
      tokens.id_token,
      clientId,
      transaction.nonce,
      transaction.subject
    );
    return {
      client_id: clientId,
      subject: identity.sub,
      label:
        typeof identity.email === 'string' ? identity.email : 'Compte ChatGPT',
      tokens: this.normalizeTokens(tokens),
    };
  }
  async refresh(registration) {
    const tokens = await this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: registration.client_id,
      refresh_token: registration.tokens.refresh_token,
    });
    if (tokens.id_token)
      await this.verifyIdentity(
        tokens.id_token,
        registration.client_id,
        undefined,
        registration.subject
      );
    return this.normalizeTokens(tokens, registration.tokens);
  }
  async revoke(registration) {
    const metadata = await this.discovery();
    const response = await this.fetch(metadata.revocation_endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: registration.tokens.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: registration.client_id,
      }),
    });
    return response.status === 200;
  }
}
