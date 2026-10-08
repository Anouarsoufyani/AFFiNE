import { GatewayError, safeError } from './errors.mjs';
import { InferenceClient, parseSSE } from './inference.mjs';
import { KeychainStore } from './keychain.mjs';
import { acquireLock } from './lock.mjs';
import { OAuthClient } from './oauth.mjs';
import { SandboxIntegration } from './sandbox.mjs';
import { startServer } from './server.mjs';
import { LOCAL_AUTH, SessionManager } from './session.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const port = Number(option('--port', '43187'));

async function main() {
  if (command === 'help') {
    console.log(
      'serve | status | models | chat --model ID --prompt TEXTE | tool --model ID | logout [--forget] [--all]\nOptions : --port 43187. Connexion OAuth : ouvrir http://127.0.0.1:43187/.'
    );
    return;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new GatewayError('invalid_port');
  const store = new KeychainStore();
  await store.prepare();
  if (command === 'serve') {
    const release = await acquireLock();
    try {
      const oauth = new OAuthClient();
      const session = new SessionManager(store, oauth);
      await session.initialize();
      const inference = new InferenceClient(session);
      const gateway = await startServer({
        session,
        oauth,
        inference,
        sandbox: new SandboxIntegration(store, session, inference),
        port,
      });
      console.log(
        `Passerelle locale : ${gateway.origin}/\nOAuth et tokens : Trousseau macOS. Ctrl+C arrête le service ; logout supprime les tokens.`
      );
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await gateway.close();
        await session.queue;
        await release();
      };
      process.once('SIGINT', () => {
        void stop();
      });
      process.once('SIGTERM', () => {
        void stop();
      });
    } catch (error) {
      await release();
      throw error;
    }
    return;
  }
  const key = await store.get(LOCAL_AUTH);
  if (!key) throw new GatewayError('start_gateway_first', 401);
  const base = `http://127.0.0.1:${port}`;
  let path, body;
  switch (command) {
    case 'status':
      path = '/api/status';
      break;
    case 'models':
      path = '/v1/models';
      break;
    case 'diagnostics':
      path = '/api/diagnostics';
      break;
    case 'logout':
      path = '/auth/logout';
      body = { forget: args.includes('--forget'), all: args.includes('--all') };
      break;
    case 'chat':
      path = '/v1/responses';
      body = {
        model: option('--model'),
        input: [
          {
            role: 'user',
            content: option('--prompt', 'Dis bonjour en une phrase.'),
          },
        ],
        stream: true,
      };
      break;
    case 'tool':
      path = '/api/demo/tool';
      body = { model: option('--model') };
      break;
    default:
      throw new GatewayError('unknown_command');
  }
  const response = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(180_000),
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    // The local daemon emits only predefined error codes.
    const result = await response.json();
    throw new GatewayError(
      result.error?.code ?? 'gateway_request_failed',
      response.status
    );
  }
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    let completed = false;
    for await (const event of parseSSE(response.body)) {
      if (event.type === 'response.output_text.delta')
        process.stdout.write(event.delta);
      if (event.type === 'gateway.demo.tool_executed')
        console.log(
          `\nFonction add exécutée : ${JSON.stringify(event.result)}`
        );
      if (
        event.type ===
        (command === 'tool' ? 'gateway.demo.completed' : 'response.completed')
      )
        completed = true;
      if (event.type === 'gateway.error')
        throw new GatewayError(event.error.code, 502);
    }
    if (!completed) throw new GatewayError('stream_not_completed', 502);
    process.stdout.write('\n');
  } else console.log(JSON.stringify(await response.json(), null, 2));
}

main().catch(error => {
  console.error(safeError(error).code);
  process.exitCode = 1;
});
