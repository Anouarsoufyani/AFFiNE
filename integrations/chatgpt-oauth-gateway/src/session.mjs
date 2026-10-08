import { randomUUID } from 'node:crypto';

import { GatewayError } from './errors.mjs';
import { randomSecret, sameSecret } from './oauth.mjs';

const RECORD = 'registrations-v1';
export const LOCAL_AUTH = 'local-access-v1';

// All credential mutations, including refresh, sign-in and sign-out, serialize.
// The daemon holds a separate OS-level singleton lock (see cli.mjs).
export class SessionManager {
  constructor(store, oauth, { now = Date.now } = {}) {
    this.store = store;
    this.oauth = oauth;
    this.now = now;
    this.queue = Promise.resolve();
    this.controllers = new Set();
    this.generation = 0;
    this.storageHealthy = true;
  }
  exclusive(callback) {
    const task = this.queue.then(callback);
    this.queue = task.catch(() => {});
    return task;
  }
  async initialize() {
    this.state = (await this.store.get(RECORD)) ?? {
      version: 1,
      host_id: `urn:uuid:${randomUUID()}`,
      active: null,
      registrations: [],
    };
    if (
      this.state.version !== 1 ||
      !Array.isArray(this.state.registrations) ||
      typeof this.state.host_id !== 'string'
    )
      throw new GatewayError('credential_record_invalid', 503);
    await this.store.set(RECORD, this.state);
    this.localKey = await this.store.get(LOCAL_AUTH);
    if (!this.localKey) {
      this.localKey = randomSecret();
      await this.store.set(LOCAL_AUTH, this.localKey);
    }
  }
  authorized(value) {
    return sameSecret(value, this.localKey);
  }
  active() {
    return this.state.registrations.find(
      item => item.client_id === this.state.active
    );
  }
  status() {
    return {
      application: 'AFFiNE Local OAuth Gateway',
      active: this.state.active,
      accounts: this.state.registrations.map(item => ({
        client_id: item.client_id,
        label: item.label,
        connected: !!item.tokens,
        plan_enabled: !!item.tokens && hasPlanScope(item.tokens.scope),
      })),
    };
  }
  async save() {
    try {
      await this.store.set(RECORD, this.state);
      this.storageHealthy = true;
    } catch {
      this.storageHealthy = false;
      throw new GatewayError('credential_storage_failed', 503);
    }
  }
  async accept(registration, generation = this.generation) {
    return this.exclusive(async () => {
      if (generation !== this.generation)
        throw new GatewayError('oauth_attempt_cancelled', 401);
      const existing = this.state.registrations.find(
        item => item.client_id === registration.client_id
      );
      if (existing && existing.subject !== registration.subject)
        throw new GatewayError('oauth_account_mismatch', 401);
      if (existing) Object.assign(existing, registration);
      else this.state.registrations.push(registration);
      this.state.active = registration.client_id;
      await this.save();
      this.generation++;
      this.cancelAll();
    });
  }
  async select(clientId) {
    this.generation++;
    return this.exclusive(async () => {
      if (!this.storageHealthy)
        throw new GatewayError('credential_storage_failed', 503);
      if (!this.state.registrations.some(item => item.client_id === clientId))
        throw new GatewayError('account_not_found', 404);
      this.cancelAll();
      this.state.active = clientId;
      await this.save();
    });
  }
  async accessToken() {
    return this.exclusive(async () => {
      if (!this.storageHealthy)
        throw new GatewayError('credential_storage_failed', 503);
      const registration = this.active();
      if (!registration?.tokens)
        throw new GatewayError('sign_in_required', 401);
      if (!hasPlanScope(registration.tokens.scope))
        throw new GatewayError('chatgpt_plan_consent_required', 403);
      if (registration.tokens.expires_at <= this.now() + 60_000) {
        if (registration.tokens.earliest_refresh_at > this.now())
          throw new GatewayError('oauth_refresh_not_yet_allowed', 503);
        try {
          const replacement = await this.oauth.refresh(registration);
          registration.tokens = replacement;
          await this.save(); // Save the rotating refresh token before allowing inference.
        } catch (error) {
          if (
            error instanceof GatewayError &&
            error.code === 'oauth_reauthentication_required'
          ) {
            delete registration.tokens;
            await this.save();
          }
          throw error;
        }
        if (!hasPlanScope(registration.tokens.scope))
          throw new GatewayError('chatgpt_plan_consent_required', 403);
      }
      return registration.tokens.access_token;
    });
  }
  track(controller) {
    this.controllers.add(controller);
    return () => this.controllers.delete(controller);
  }
  cancelAll() {
    for (const controller of this.controllers) controller.abort();
  }
  async logout({ forget = false, all = false } = {}) {
    this.generation++;
    this.cancelAll();
    return this.exclusive(async () => {
      const registrations = all
        ? [...this.state.registrations]
        : [this.active()].filter(Boolean);
      let confirmed = true;
      for (const registration of registrations) {
        let revoked = !registration.tokens;
        if (registration.tokens) {
          // At most two attempts; never retain a token merely to complete revocation.
          for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
            try {
              revoked = await this.oauth.revoke(registration);
            } catch {
              /* safe local removal below */
            }
          }
          delete registration.tokens;
        }
        confirmed &&= revoked;
      }
      if (forget) {
        this.state.registrations = this.state.registrations.filter(
          item => !registrations.includes(item)
        );
        if (!this.active()) this.state.active = null;
      }
      await this.save();
      return {
        disconnected: true,
        credentials_deleted: true,
        registration_deleted: forget,
        revocation_confirmed: confirmed,
      };
    });
  }
}

export function hasPlanScope(scope) {
  const scopes = new Set(scope?.split(/\s+/));
  return (
    scopes.has('chatgpt.tokens.use.direct') && scopes.has('resource.invoke')
  );
}
