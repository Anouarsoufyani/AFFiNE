import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gateway = fileURLToPath(new URL('../', import.meta.url));
const repo = resolve(gateway, '../..');
const root = resolve(gateway, '.runtime/sandbox');
const config = JSON.parse(
  await readFile(resolve(root, 'home/.affine/config/config.json'), 'utf8')
);
const owned = [];
let stopping = false;
const listening = port =>
  new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    const done = value => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
function child(command, args, cwd, env) {
  const process = spawn(command, args, {
    cwd,
    env,
    stdio: 'ignore',
    detached: true,
  });
  owned.push(process);
  process.on('error', () =>
    console.error('Un service du sandbox ne peut pas démarrer.')
  );
  return process;
}
async function start(name, port, command, args, cwd, env) {
  if (await listening(port)) {
    console.log(`${name} : déjà lancé sur 127.0.0.1:${port}.`);
    return;
  }
  const process = child(command, args, cwd, env);
  for (let attempt = 0; attempt < 360; attempt++) {
    if (stopping || process.exitCode !== null)
      throw new Error(`${name} arrêté avant son démarrage.`);
    if (await listening(port)) {
      console.log(`${name} : prêt sur 127.0.0.1:${port}.`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${name} ne répond pas sur son port local.`);
}
function stop() {
  if (stopping) return;
  stopping = true;
  // Only child process groups created by this launcher are stopped.
  for (const process of owned)
    if (process.exitCode === null) {
      try {
        globalThis.process.kill(-process.pid, 'SIGTERM');
      } catch {}
    }
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const docker = spawn(
    'docker',
    ['compose', '-f', resolve(root, 'compose.yml'), 'up', '-d', '--wait'],
    { cwd: root, stdio: 'ignore' }
  );
  const exit = await new Promise(resolve => {
    docker.once('error', () => resolve(1));
    docker.once('exit', resolve);
  });
  if (exit !== 0)
    throw new Error(
      'OrbStack/Docker ne répond pas. Ouvre OrbStack puis relance.'
    );
  await start('Ollama embeddings', 11435, 'ollama', ['serve'], repo, {
    ...process.env,
    OLLAMA_HOST: '127.0.0.1:11435',
    OLLAMA_MODELS: resolve(root, 'ollama-models'),
    OLLAMA_NO_CLOUD: 'true',
  });
  const appEnv = {
    ...process.env,
    HOME: resolve(root, 'home'),
    NODE_ENV: 'development',
    AFFINE_ENV: 'dev',
    DEPLOYMENT_TYPE: 'selfhosted',
    SELF_HOSTED: 'true',
    DATABASE_URL: config.db.datasourceUrl,
    REDIS_SERVER_HOST: '127.0.0.1',
    REDIS_SERVER_PORT: '56379',
    AFFINE_SERVER_PORT: '3010',
    AFFINE_SERVER_EXTERNAL_URL: 'http://127.0.0.1:3010',
    LISTEN_ADDR: '127.0.0.1',
    AFFINE_BACKEND_RUNTIME_CONFIG_PATH: resolve(root, 'backend-runtime.json'),
    AFFINE_INDEXER_ENABLED: 'false',
  };
  await start(
    'Backend AFFiNE',
    3010,
    process.execPath,
    [
      resolve(repo, '.yarn/releases/yarn-4.18.0.cjs'),
      'affine',
      'server',
      'dev',
    ],
    repo,
    appEnv
  );
  const webSource = `import { Workspace } from '@affine-tools/utils/workspace'; import { BundleCommand } from './tools/cli/src/bundle.ts'; const w=new Workspace(); await BundleCommand.dev(w.getPackage('@affine/web'), {host:'127.0.0.1',port:33080,allowedHosts:['127.0.0.1','localhost'],client:{webSocketURL:'ws://127.0.0.1:33080/ws'}});`;
  await start(
    'Web AFFiNE',
    33080,
    process.execPath,
    [
      '--import',
      './tools/cli/tsx-register.js',
      '--input-type=module',
      '-e',
      webSource,
    ],
    repo,
    appEnv
  );
  await start(
    'Gateway OAuth',
    43187,
    process.execPath,
    ['src/cli.mjs', 'serve'],
    gateway,
    process.env
  );
  console.log(
    'AFFiNE : http://127.0.0.1:33080/\nModèle GPT : Settings → Integrations → AI BYOK (ordre des profils).\nEmbeddings et défaut : http://127.0.0.1:43187/\nCtrl+C arrête uniquement les services lancés par cette commande. Les volumes PostgreSQL/Redis sont conservés.'
  );
} catch (error) {
  console.error(error.message);
  stop();
  process.exitCode = 1;
}
