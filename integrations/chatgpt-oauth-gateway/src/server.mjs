import { once } from 'node:events';
import { createServer } from 'node:http';

import { GatewayError, safeError } from './errors.mjs';
import { normalizeRequest, toolDemo } from './inference.mjs';
import { randomSecret, sameSecret } from './oauth.mjs';
import { page } from './ui.mjs';

async function requestBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new GatewayError('json_required', 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2_097_152) throw new GatewayError('request_too_large', 413);
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error();
    return result;
  } catch {
    throw new GatewayError('invalid_json');
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}
async function writeEvent(response, event) {
  if (response.destroyed) throw new GatewayError('client_disconnected', 499);
  const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (!response.write(data)) {
    await Promise.race([
      once(response, 'drain'),
      once(response, 'close').then(() => {
        throw new GatewayError('client_disconnected', 499);
      }),
    ]);
  }
}

export async function startServer({
  session,
  oauth,
  inference,
  sandbox,
  port = 43187,
  startRefresh = true,
}) {
  const browserSession = randomSecret(),
    csrf = randomSecret();
  const transactions = new Map();
  let expectedHost, origin;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    let controller, untrack;
    try {
      if (request.headers.host !== expectedHost)
        throw new GatewayError('host_rejected', 403);
      if (request.headers.origin && request.headers.origin !== origin)
        throw new GatewayError('origin_rejected', 403);
      if (
        request.headers['sec-fetch-site'] === 'cross-site' &&
        request.url !== '/' &&
        !request.url?.startsWith('/auth/callback?')
      ) {
        throw new GatewayError('cross_site_rejected', 403);
      }
      const url = new URL(request.url, origin);
      const cookie = (request.headers.cookie ?? '')
        .split(';')
        .map(item => item.trim())
        .find(item => item.startsWith('gateway_session='))
        ?.slice(16);
      const bearer = request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7)
        : null;
      const browserAuthorized =
        sameSecret(cookie, browserSession) &&
        sameSecret(request.headers['x-gateway-csrf'], csrf);
      const authorized = session.authorized(bearer) || browserAuthorized;
      if (request.method === 'GET' && url.pathname === '/healthz')
        return json(response, 200, {
          status: 'ok',
          reference: 'AFFiNE v0.27.4',
        });
      if (request.method === 'GET' && url.pathname === '/') {
        const nonce = randomSecret();
        response.setHeader(
          'Content-Security-Policy',
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
        );
        response.setHeader(
          'Set-Cookie',
          `gateway_session=${browserSession}; HttpOnly; SameSite=Lax; Path=/`
        );
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end(page(nonce, csrf));
      }
      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        const state = url.searchParams.get('state');
        const transaction = transactions.get(state);
        if (!transaction)
          throw new GatewayError('oauth_transaction_missing', 401);
        if (!sameSecret(cookie, transaction.browserSession))
          throw new GatewayError('oauth_browser_session_invalid', 401);
        // Consume once, before any asynchronous code exchange.
        transactions.delete(state);
        const registration = await oauth.exchange(
          transaction,
          url.searchParams,
          cookie
        );
        try {
          await session.accept(registration, transaction.generation);
        } catch (error) {
          // A sign-out/account change during exchange must not reconnect a cancelled session.
          if (error.code === 'oauth_attempt_cancelled') {
            try {
              await oauth.revoke(registration);
            } catch {}
          }
          throw error;
        }
        response.setHeader('Location', '/');
        response.writeHead(303);
        return response.end();
      }
      if (!authorized)
        throw new GatewayError('local_authentication_required', 401);
      if (request.method === 'GET' && url.pathname === '/api/diagnostics')
        return json(response, 200, { traces: inference.traces ?? [] });
      if (url.pathname.startsWith('/api/sandbox/')) {
        if (!sandbox) throw new GatewayError('sandbox_not_configured', 503);
        if (request.method === 'GET' && url.pathname === '/api/sandbox/catalog')
          return json(response, 200, await sandbox.catalog());
        if (request.method === 'POST' && url.pathname === '/api/sandbox/apply')
          return json(
            response,
            200,
            await sandbox.apply(await requestBody(request))
          );
        if (
          request.method === 'POST' &&
          url.pathname === '/api/sandbox/install'
        )
          return json(
            response,
            200,
            await sandbox.install(await requestBody(request))
          );
      }
      if (request.method === 'POST' && url.pathname === '/auth/start') {
        const body = await requestBody(request);
        for (const [state, transaction] of transactions)
          if (transaction.expiresAt < Date.now()) transactions.delete(state);
        if (transactions.size >= 8)
          throw new GatewayError('too_many_sign_in_attempts', 429);
        // Bind every callback to the browser cookie; CLI never starts browser OAuth.
        if (!browserAuthorized)
          throw new GatewayError('use_local_browser_to_sign_in', 403);
        const { url: authorizationUrl, transaction } =
          await oauth.authorization({
            hostId: session.state.host_id,
            redirectUri: `${origin}/auth/callback`,
            registration: body.new_account ? undefined : session.active(),
            browserSession,
          });
        transaction.generation = session.generation;
        transactions.set(transaction.state, transaction);
        return json(response, 200, { authorization_url: authorizationUrl });
      }
      if (request.method === 'GET' && url.pathname === '/api/status')
        return json(response, 200, session.status());
      if (request.method === 'POST' && url.pathname === '/api/account') {
        const body = await requestBody(request);
        transactions.clear();
        await session.select(body.client_id);
        return json(response, 200, session.status());
      }
      if (request.method === 'POST' && url.pathname === '/auth/logout') {
        const body = await requestBody(request);
        transactions.clear();
        return json(
          response,
          200,
          await session.logout({
            forget: body.forget === true,
            all: body.all === true,
          })
        );
      }
      controller = new AbortController();
      untrack = session.track(controller);
      request.on('aborted', () => controller.abort());
      response.on('close', () => {
        if (!response.writableEnded) controller.abort();
      });
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return json(response, 200, {
          object: 'list',
          data: await inference.models(controller.signal),
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await requestBody(request);
        const { omitted } = normalizeRequest(body);
        if (omitted.length)
          response.setHeader('X-Gateway-Omitted-Parameters', omitted.join(','));
        if (body.stream === true) {
          // Pull the first event before sending 200, so authentication failures remain HTTP errors.
          const events = inference.events(body, controller.signal);
          const first = await events.next();
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'X-Accel-Buffering': 'no',
          });
          try {
            if (!first.done) await writeEvent(response, first.value);
            for await (const event of events) await writeEvent(response, event);
          } finally {
            await events.return();
          }
          return response.end();
        }
        const result = await inference.complete(body, {
          signal: controller.signal,
        });
        return json(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/demo/tool') {
        const body = await requestBody(request);
        if (
          typeof body.model !== 'string' ||
          !body.model ||
          body.model.length > 512
        )
          throw new GatewayError('model_required');
        // Preflight authorization before sending stream headers.
        await session.accessToken();
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'X-Accel-Buffering': 'no',
        });
        await toolDemo(inference, body.model, {
          signal: controller.signal,
          onEvent: event => writeEvent(response, event),
        });
        return response.end();
      }
      throw new GatewayError('not_found', 404);
    } catch (error) {
      const safe = safeError(error);
      if (!response.destroyed) {
        if (response.headersSent) {
          response.write(
            `event: gateway.error\ndata: ${JSON.stringify({ type: 'gateway.error', error: { code: safe.code } })}\n\n`
          );
          response.end();
        } else json(response, safe.status, { error: { code: safe.code } });
      }
    } finally {
      untrack?.();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  expectedHost = `127.0.0.1:${server.address().port}`;
  origin = `http://${expectedHost}`;
  const timer = startRefresh
    ? setInterval(() => {
        if (session.active()?.tokens)
          void session.accessToken().catch(() => {});
      }, 30_000).unref()
    : null;
  const cleanup = setInterval(() => {
    for (const [state, transaction] of transactions)
      if (transaction.expiresAt < Date.now()) transactions.delete(state);
  }, 30_000).unref();
  return {
    server,
    origin,
    async close() {
      clearInterval(timer);
      clearInterval(cleanup);
      transactions.clear();
      session.cancelAll();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
