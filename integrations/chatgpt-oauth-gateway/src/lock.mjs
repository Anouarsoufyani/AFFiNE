import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayError } from './errors.mjs';
import { nativeBinary } from './keychain.mjs';

export function acquireLock(
  path = join(
    tmpdir(),
    `affine-chatgpt-oauth-${process.getuid?.() ?? 'user'}.lockfile`
  )
) {
  return new Promise((resolve, reject) => {
    const child = spawn(nativeBinary, ['--lock', path], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let pending = '',
      ready = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new GatewayError('daemon_lock_failed', 503));
    }, 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      pending += data;
      if (!ready && pending.includes('\n')) {
        clearTimeout(timer);
        try {
          if (!JSON.parse(pending).ok) throw new Error();
          ready = true;
          resolve(
            () =>
              new Promise(done => {
                child.once('close', done);
                child.stdin.end();
              })
          );
        } catch {
          child.kill();
          reject(new GatewayError('daemon_lock_failed', 503));
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new GatewayError('daemon_lock_failed', 503));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!ready) reject(new GatewayError('gateway_already_running', 409));
    });
    child.stdin.on('error', () => {});
  });
}
