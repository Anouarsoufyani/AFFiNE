import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeDemoTool,
  InferenceClient,
  normalizeRequest,
  parseSSE,
  toolDemo,
} from '../src/inference.mjs';
import { completed, sseResponse } from './helpers.mjs';

const request = () => ({
  model: 'gpt-6-luna',
  input: [{ role: 'user', content: 'Bonjour' }],
});
const session = { accessToken: async () => 'mock-access-token' };

test('protocol diagnostics never retain prompts, tool arguments, generated content or OAuth tokens', async () => {
  const client = new InferenceClient(session, {
    fetchImpl: async () =>
      sseResponse([
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'call1',
            name: 'doc_read',
            arguments: 'PRIVATE-ARGUMENT',
          },
        },
        completed(),
      ]),
  });
  await client.complete({
    ...request(),
    input: [{ role: 'user', content: 'PRIVATE-PROMPT' }],
  });
  const trace = JSON.stringify(client.traces);
  assert.ok(trace.includes('doc_read'));
  for (const secret of [
    'PRIVATE-PROMPT',
    'PRIVATE-ARGUMENT',
    'mock-access-token',
  ])
    assert.equal(trace.includes(secret), false);
});

test('SIWC normalization preserves instructions/schema, forces streaming and omits unsupported tuning', () => {
  const original = {
    ...request(),
    store: true,
    stream: false,
    temperature: 0.2,
    max_output_tokens: 100,
    input: [
      { type: 'message', role: 'system', content: 'Instructions importantes' },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'result',
        schema: { type: 'object' },
      },
    },
  };
  const { body, omitted } = normalizeRequest(original);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.input[0].role, 'developer');
  assert.equal(body.input[0].content, 'Instructions importantes');
  assert.deepEqual(body.text, original.text);
  assert.deepEqual(omitted.sort(), ['max_output_tokens', 'temperature']);
  assert.equal(original.store, true);
  assert.equal(original.input[0].role, 'system');
});

test('named function choice exposes only the selected tool and requires its call', () => {
  const { body } = normalizeRequest({
    ...request(),
    tools: [
      { type: 'function', name: 'doc_read', parameters: {} },
      { type: 'function', name: 'doc_write', parameters: {} },
    ],
    tool_choice: { type: 'function', name: 'doc_read' },
  });
  assert.equal(body.tools[0].type, 'namespace');
  assert.equal(body.tools[0].tools[0].name, 'doc_read');
  assert.equal(body.tools[0].tools.length, 1);
  assert.equal(body.tool_choice, 'required');
  assert.throws(
    () =>
      normalizeRequest({
        ...request(),
        tools: [{ type: 'function', name: 'doc_read', parameters: {} }],
        tool_choice: { type: 'function', name: 'unknown' },
      }),
    { code: 'named_tool_choice_not_found' }
  );
});

test('hosted unsupported tools and persistent HTTP response references are rejected explicitly', () => {
  for (const type of [
    'image_generation',
    'file_search',
    'code_interpreter',
    'mcp',
    'tool_search',
    'programmatic_tool_calling',
  ]) {
    assert.throws(() => normalizeRequest({ ...request(), tools: [{ type }] }), {
      code: 'siwc_tool_not_supported',
    });
  }
  assert.throws(
    () =>
      normalizeRequest({ ...request(), previous_response_id: 'resp_other' }),
    { code: 'send_full_history_in_input' }
  );
  assert.throws(
    () => normalizeRequest({ ...request(), input: 'string input' }),
    { code: 'input_array_required' }
  );
});

test('SSE parses multibyte UTF-8, CRLF, multiline data and network splits', async () => {
  const bytes = Buffer.from(
    ': keepalive\r\n\r\nevent: delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"été 🐈"}\r\n\r\ndata: [DONE]\r\n\r\n'
  );
  async function* chunks() {
    for (let index = 0; index < bytes.length; index++)
      yield bytes.subarray(index, index + 1);
  }
  const events = [];
  for await (const event of parseSSE(chunks())) events.push(event);
  assert.deepEqual(events, [
    { type: 'response.output_text.delta', delta: 'été 🐈' },
  ]);
});

test('truncated JSON in a stream fails instead of returning a partial success', async () => {
  async function* chunks() {
    yield Buffer.from('data: {"type":');
  }
  await assert.rejects(
    async () => {
      for await (const event of parseSSE(chunks())) void event;
    },
    { code: 'invalid_upstream_event' }
  );
});

test('model catalog uses OAuth and returns only visible account-specific slugs', async () => {
  const client = new InferenceClient(session, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer mock-access-token');
      return Response.json({
        models: [
          {
            slug: 'gpt-6-luna',
            display_name: 'GPT-6 Luna',
            visibility: 'list',
          },
          { slug: 'hidden-model', visibility: 'hidden' },
        ],
      });
    },
  });
  assert.deepEqual(
    (await client.models()).map(model => model.id),
    ['gpt-6-luna']
  );
});

test('completion waits for response.completed and preserves the complete output', async () => {
  const client = new InferenceClient(session, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      return sseResponse([
        { type: 'response.output_text.delta', delta: 'Bonjour !' },
        completed(),
      ]);
    },
  });
  const result = await client.complete(request());
  assert.deepEqual(result, completed().response);
});

for (const scenario of ['interrupted', 'failed', 'incomplete']) {
  test(`stream ${scenario} is never marked successful, even after text deltas`, async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'Partial text' },
    ];
    if (scenario !== 'interrupted')
      events.push({
        type: `response.${scenario}`,
        response: {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'mock-private-value',
          },
        },
      });
    const client = new InferenceClient(session, {
      fetchImpl: async () => sseResponse(events),
    });
    await assert.rejects(
      client.complete(request()),
      error =>
        error.code ===
          (scenario === 'interrupted'
            ? 'upstream_stream_interrupted'
            : 'subscription_sharing_usage_limit_exceeded') &&
        !String(error).includes('mock-private-value')
    );
  });
}

test('two-turn function demo executes add and replays reasoning, call IDs and result', async () => {
  const requests = [];
  const reasoning = {
    type: 'reasoning',
    id: 'rs_mock',
    encrypted_content: 'mock-reasoning-state',
    summary: [],
  };
  const call = {
    type: 'function_call',
    namespace: 'affine',
    name: 'add',
    arguments: '{"a":19,"b":23}',
    call_id: 'call_mock',
    id: 'fc_mock',
  };
  const client = new InferenceClient(session, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return sseResponse([
        requests.length === 1 ? completed([reasoning, call]) : completed(),
      ]);
    },
  });
  const events = [];
  await toolDemo(client, 'gpt-6-luna', {
    onEvent: async event => events.push(event),
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].input[1], reasoning);
  assert.deepEqual(requests[1].input[2], call);
  assert.deepEqual(requests[1].input[3], {
    type: 'function_call_output',
    call_id: 'call_mock',
    output: '{"sum":42}',
  });
  assert.equal(events.at(-1).type, 'gateway.demo.completed');
});

test('demo rejects arbitrary functions, non-finite values and extra arguments', () => {
  for (const call of [
    { name: 'shell', arguments: '{}' },
    { name: 'add', arguments: '{"a":1e999,"b":2}' },
    { name: 'add', arguments: '{"a":1,"b":2,"command":"attack"}' },
    { name: 'add', namespace: 'other', arguments: '{"a":1,"b":2}' },
  ])
    assert.throws(() => executeDemoTool({ call_id: 'call_mock', ...call }));
});

test('client cancellation reaches the upstream request', async () => {
  const controller = new AbortController();
  const client = new InferenceClient(session, {
    fetchImpl: async (url, options) => {
      controller.abort();
      assert.equal(options.signal.aborted, true);
      throw new DOMException('Aborted', 'AbortError');
    },
  });
  await assert.rejects(
    client.complete(request(), { signal: controller.signal }),
    { name: 'AbortError' }
  );
});

test('real SIWC contract allows missing Content-Type only with valid SSE framing', async () => {
  const client = new InferenceClient(session, {
    fetchImpl: async () => {
      const bytes = Buffer.from(`data: ${JSON.stringify(completed())}\n\n`);
      return new Response(bytes);
    },
  });
  assert.equal((await client.complete(request())).status, 'completed');
});

test('missing Content-Type with ordinary JSON is rejected instead of guessed successful', async () => {
  const client = new InferenceClient(session, {
    fetchImpl: async () =>
      new Response(Buffer.from(JSON.stringify(completed().response))),
  });
  await assert.rejects(client.complete(request()), {
    code: 'upstream_stream_interrupted',
  });
});

test('real SIWC contract rebuilds ordered tool outputs when the terminal output is empty', async () => {
  const call = {
    type: 'function_call',
    id: 'fc_mock',
    call_id: 'call_mock',
    namespace: 'affine',
    name: 'add',
    arguments: '{"a":19,"b":23}',
  };
  const reasoning = {
    type: 'reasoning',
    id: 'rs_mock',
    encrypted_content: 'mock-encrypted',
    summary: [],
  };
  const client = new InferenceClient(session, {
    fetchImpl: async () =>
      sseResponse([
        { type: 'response.output_item.done', output_index: 1, item: call },
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
        completed([]),
      ]),
  });
  const events = [];
  const result = await client.complete(request(), {
    onEvent: async event => events.push(event),
  });
  assert.deepEqual(result.output, [reasoning, call]);
  assert.deepEqual(events.at(-1).response.output, [reasoning, call]);
});

test('terminal items override streamed copies without duplicate IDs', async () => {
  const item = { type: 'message', id: 'msg_mock', content: [] };
  const final = { ...item, status: 'completed' };
  const client = new InferenceClient(session, {
    fetchImpl: async () =>
      sseResponse([
        { type: 'response.output_item.done', output_index: 0, item },
        completed([final]),
      ]),
  });
  assert.deepEqual((await client.complete(request())).output, [final]);
});
