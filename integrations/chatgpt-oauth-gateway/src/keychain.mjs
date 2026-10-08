import { spawn } from 'node:child_process';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { GatewayError } from './errors.mjs';

const directory = fileURLToPath(new URL('../.runtime/', import.meta.url));
export const nativeBinary = fileURLToPath(
  new URL('../.runtime/keychain-helper', import.meta.url)
);
const binary = nativeBinary;
const source = fileURLToPath(
  new URL('../native/Keychain.swift', import.meta.url)
);

function processResult(command, args, input = '', timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new GatewayError('keychain_timeout', 503));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      output += data;
      if (output.length > 2_097_152) {
        child.kill();
      }
    });
    child.stderr.resume(); // Do not relay diagnostics: they can contain request data.
    child.on('error', () => {
      clearTimeout(timer);
      reject(new GatewayError('keychain_process_failed', 503));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new GatewayError('keychain_unavailable', 503));
      else resolve(output);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function buildKeychain() {
  if (process.platform !== 'darwin')
    throw new GatewayError('macos_keychain_required', 503);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await processResult('/usr/bin/xcrun', [
    'swiftc',
    '-O',
    '-module-cache-path',
    `${directory}module-cache`,
    source,
    '-o',
    binary,
  ]);
  await chmod(binary, 0o700);
}

export class KeychainStore {
  constructor(service = 'org.affine-local.chatgpt-oauth-gateway') {
    this.service = service;
  }
  async prepare() {
    if (process.platform !== 'darwin')
      throw new GatewayError('macos_keychain_required', 503);
    let outdated;
    try {
      outdated = (await stat(binary)).mtimeMs < (await stat(source)).mtimeMs;
    } catch {
      outdated = true;
    }
    if (outdated) await buildKeychain();
  }
  async call(operation, account, value) {
    const result = await processResult(
      binary,
      [],
      JSON.stringify({ operation, service: this.service, account, value })
    );
    try {
      const parsed = JSON.parse(result);
      if (!parsed.ok) throw new Error();
      return parsed.value ?? null;
    } catch {
      throw new GatewayError('keychain_invalid_result', 503);
    }
  }
  async get(account) {
    const value = await this.call('get', account);
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      throw new GatewayError('keychain_corrupt_record', 503);
    }
  }
  async set(account, value) {
    await this.call('set', account, JSON.stringify(value));
  }
  async delete(account) {
    await this.call('delete', account);
  }
}
