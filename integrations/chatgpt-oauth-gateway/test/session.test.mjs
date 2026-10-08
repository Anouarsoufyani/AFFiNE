import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayError } from '../src/errors.mjs';
import { SessionManager } from '../src/session.mjs';
import { MemoryStore, registration } from './helpers.mjs';

async function manager(oauth = {}) {
  const store = new MemoryStore();
  const session = new SessionManager(store, oauth);
  await session.initialize();
  await session.accept(registration());
  return { session, store };
}

test('parallel expiry requests perform only one refresh and persist the replacement', async () => {
  let refreshes = 0;
  const { session, store } = await manager({
    refresh: async () => {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        ...registration().tokens,
        access_token: 'mock-new-access',
        refresh_token: 'mock-new-refresh',
      };
    },
  });
  session.active().tokens.expires_at = 0;
  const results = await Promise.all(
    Array.from({ length: 10 }, () => session.accessToken())
  );
  assert.equal(refreshes, 1);
  assert.ok(results.every(value => value === 'mock-new-access'));
  assert.equal(
    (await store.get('registrations-v1')).registrations[0].tokens.refresh_token,
    'mock-new-refresh'
  );
});

test('revoked refresh removes unusable tokens without deleting the registration or host', async () => {
  const { session } = await manager({
    refresh: async () => {
      throw new GatewayError('oauth_reauthentication_required', 401);
    },
  });
  const host = session.state.host_id;
  session.active().tokens.expires_at = 0;
  await assert.rejects(session.accessToken(), {
    code: 'oauth_reauthentication_required',
  });
  assert.equal(session.active().tokens, undefined);
  assert.equal(session.state.host_id, host);
  assert.equal(session.active().client_id, 'oaiapp_test');
});

test('identity-only consent never allows inference', async () => {
  const { session } = await manager();
  session.active().tokens.scope = 'openid profile email';
  await assert.rejects(session.accessToken(), {
    code: 'chatgpt_plan_consent_required',
  });
  assert.equal(session.status().accounts[0].plan_enabled, false);
});

test('earliest_refresh_at is respected', async () => {
  const { session } = await manager({
    refresh: async () => {
      throw new Error('Must not run');
    },
  });
  session.active().tokens.expires_at = 0;
  session.active().tokens.earliest_refresh_at = Date.now() + 60_000;
  await assert.rejects(session.accessToken(), {
    code: 'oauth_refresh_not_yet_allowed',
  });
});

test('logout aborts requests, attempts revocation, deletes credentials and keeps registration for reauthorization', async () => {
  let revokes = 0;
  const { session, store } = await manager({
    revoke: async () => {
      revokes++;
      return true;
    },
  });
  const controller = new AbortController();
  session.track(controller);
  const result = await session.logout();
  assert.equal(controller.signal.aborted, true);
  assert.equal(revokes, 1);
  assert.equal(result.revocation_confirmed, true);
  assert.equal(session.active().tokens, undefined);
  assert.equal(
    (await store.get('registrations-v1')).registrations[0].tokens,
    undefined
  );
  await assert.rejects(session.accessToken(), { code: 'sign_in_required' });
});

test('failed revocation still clears local secrets and reports that remote revocation is unconfirmed', async () => {
  const { session } = await manager({
    revoke: async () => {
      throw new Error('mock-private-value');
    },
  });
  const result = await session.logout({ forget: true });
  assert.equal(result.revocation_confirmed, false);
  assert.deepEqual(session.state.registrations, []);
  assert.equal(
    JSON.stringify(session.state).includes('mock-refresh-token'),
    false
  );
});

test('accounts remain separate and reauthorization cannot overwrite another identity', async () => {
  const { session } = await manager();
  await session.accept({
    ...registration(),
    client_id: 'oaiapp_second',
    subject: 'second-user',
  });
  assert.equal(session.state.registrations.length, 2);
  await session.select('oaiapp_test');
  await assert.rejects(
    session.accept({ ...registration(), subject: 'attacker' }),
    { code: 'oauth_account_mismatch' }
  );
  assert.equal(session.active().subject, 'test-user');
});

test('status never discloses access, refresh, ID or local gateway credentials', async () => {
  const { session } = await manager();
  session.active().tokens.id_token = 'mock-id-secret';
  const status = JSON.stringify(session.status());
  for (const value of [
    'mock-access-token',
    'mock-refresh-token',
    'mock-id-secret',
    session.localKey,
  ])
    assert.equal(status.includes(value), false);
});

test('sign-out during an OAuth exchange cannot reactivate the account afterwards', async () => {
  const { session } = await manager({ revoke: async () => true });
  const generation = session.generation;
  await session.logout();
  await assert.rejects(session.accept(registration(), generation), {
    code: 'oauth_attempt_cancelled',
  });
  assert.equal(session.active().tokens, undefined);
});

test('a Keychain write failure blocks inference with an unsaved replacement token', async () => {
  const { session, store } = await manager({
    refresh: async () => ({
      ...registration().tokens,
      access_token: 'mock-rotated',
    }),
  });
  session.active().tokens.expires_at = 0;
  store.set = async () => {
    throw new Error('Storage failure');
  };
  await assert.rejects(session.accessToken(), {
    code: 'credential_storage_failed',
  });
  await assert.rejects(session.accessToken(), {
    code: 'credential_storage_failed',
  });
});

test('logout all forgets every saved account and deletes every OAuth token set', async () => {
  let revokes = 0;
  const { session, store } = await manager({
    revoke: async () => {
      revokes++;
      return true;
    },
  });
  await session.accept({
    ...registration(),
    client_id: 'oaiapp_second',
    subject: 'second-user',
  });
  await session.logout({ forget: true, all: true });
  assert.equal(revokes, 2);
  assert.deepEqual(session.state.registrations, []);
  assert.equal(session.state.active, null);
  assert.equal(
    JSON.stringify(await store.get('registrations-v1')).includes(
      'mock-refresh-token'
    ),
    false
  );
});
