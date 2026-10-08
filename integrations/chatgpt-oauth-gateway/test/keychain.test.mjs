import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { KeychainStore } from '../src/keychain.mjs';
import { acquireLock } from '../src/lock.mjs';

test(
  'native macOS Keychain stores, updates and removes a synthetic credential',
  {
    skip:
      process.platform !== 'darwin' ||
      process.env.GATEWAY_TEST_KEYCHAIN !== '1',
  },
  async t => {
    const store = new KeychainStore(
      `org.affine-local.chatgpt-oauth-gateway.test.${randomUUID()}`
    );
    await store.prepare();
    const account = 'synthetic-test-only';
    t.after(() => store.delete(account));
    assert.equal(await store.get(account), null);
    await store.set(account, { secret: 'synthetic-value-A' });
    assert.deepEqual(await store.get(account), { secret: 'synthetic-value-A' });
    await store.set(account, { secret: 'synthetic-value-B' });
    assert.deepEqual(await store.get(account), { secret: 'synthetic-value-B' });
    await store.delete(account);
    assert.equal(await store.get(account), null);
  }
);

test(
  'kernel lock excludes concurrent daemons and can be reacquired after release',
  {
    skip:
      process.platform !== 'darwin' ||
      process.env.GATEWAY_TEST_KEYCHAIN !== '1',
  },
  async t => {
    await new KeychainStore().prepare();
    const path = join(tmpdir(), `affine-oauth-test-${randomUUID()}.lockfile`);
    t.after(() => unlink(path));
    const release = await acquireLock(path);
    try {
      await assert.rejects(acquireLock(path), {
        code: 'gateway_already_running',
      });
    } finally {
      await release();
    }
    const releaseAgain = await acquireLock(path);
    await releaseAgain();
  }
);
