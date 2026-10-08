import { GatewayError, readJson } from './errors.mjs';
import { RESOURCE } from './oauth.mjs';

const OMIT = new Set([
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
]);
const ALLOWED = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'text',
  'reasoning',
  'include',
  'prompt_cache_key',
  'service_tier',
]);
const ERROR_CODES = new Set([
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable',
  'rate_limit_exceeded',
  'model_not_found',
  'invalid_api_key',
  'insufficient_quota',
]);

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > 64)
    throw new GatewayError('invalid_tools');
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object')
      throw new GatewayError('invalid_tools');
    if (tool.type === 'namespace') {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tool.name ?? '') ||
        !Array.isArray(tool.tools) ||
        tool.tools.length > 64 ||
        tool.tools.some(item => !['function', 'custom'].includes(item.type))
      ) {
        throw new GatewayError('invalid_tool_namespace');
      }
    } else if (
      !['function', 'custom', 'web_search', 'web_search_preview'].includes(
        tool.type
      )
    ) {
      throw new GatewayError('siwc_tool_not_supported');
    }
  }
}

export function normalizeRequest(request) {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    typeof request.model !== 'string' ||
    !request.model ||
    request.model.length > 512 ||
    (request.stream !== undefined && typeof request.stream !== 'boolean')
  )
    throw new GatewayError('invalid_request');
  if (request.previous_response_id != null)
    throw new GatewayError('send_full_history_in_input');
  if (!Array.isArray(request.input) || !request.input.length)
    throw new GatewayError('input_array_required');
  const body = { store: false, stream: true };
  const omitted = [];
  for (const [key, value] of Object.entries(request)) {
    if (OMIT.has(key)) omitted.push(key);
    else if (ALLOWED.has(key)) body[key] = structuredClone(value);
    else if (!['store', 'stream', 'previous_response_id'].includes(key))
      throw new GatewayError('unsupported_request_field');
  }
  body.input = body.input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new GatewayError('invalid_input_item');
    // Preserve developer/system instructions rather than discarding their content.
    if (item.role === 'system') return { ...item, role: 'developer' };
    return item;
  });
  if (body.tools) {
    validateTools(body.tools);
    const functions = body.tools.filter(tool =>
      ['function', 'custom'].includes(tool.type)
    );
    const existingNamespaces = body.tools.filter(
      tool => tool.type === 'namespace'
    );
    if (functions.length) {
      if (existingNamespaces.some(tool => tool.name === 'affine'))
        throw new GatewayError('reserved_tool_namespace');
      body.tools = [
        ...body.tools.filter(tool => !functions.includes(tool)),
        {
          type: 'namespace',
          name: 'affine',
          description: 'Tools executed by the connected AFFiNE application.',
          tools: functions,
        },
      ];
      if (body.tool_choice?.type === 'function') {
        body.tool_choice = {
          ...body.tool_choice,
          namespace: body.tool_choice.namespace ?? 'affine',
        };
      }
    }
  }
  body.include ??= ['reasoning.encrypted_content'];
  if (body.tool_choice?.type === 'function') {
    // The SIWC account route rejected an explicit namespace selector during live
    // validation. Offer only that function and require a tool call instead.
    const choice = body.tool_choice;
    const matches = (body.tools ?? [])
      .filter(
        tool =>
          tool.type === 'namespace' &&
          (choice.namespace === undefined || choice.namespace === tool.name)
      )
      .flatMap(namespace =>
        namespace.tools
          .filter(tool => tool.type === 'function' && tool.name === choice.name)
          .map(tool => ({ namespace, tool }))
      );
    if (matches.length !== 1)
      throw new GatewayError('named_tool_choice_not_found');
    body.tools = [{ ...matches[0].namespace, tools: [matches[0].tool] }];
    body.tool_choice = 'required';
  }
  return { body, omitted };
}

// SSE is framed by blank lines, not TCP chunks. Handle UTF-8 and CRLF boundaries.
export async function* parseSSE(body) {
  let pending = '';
  const decoder = new TextDecoder();
  const parseFrame = frame => {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') return null;
    try {
      const event = JSON.parse(data);
      if (!event || typeof event.type !== 'string') throw new Error();
      return event;
    } catch {
      throw new GatewayError('invalid_upstream_event', 502);
    }
  };
  for await (const chunk of body) {
    pending +=
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      if (match.index > 8_388_608)
        throw new GatewayError('upstream_event_too_large', 502);
      const event = parseFrame(pending.slice(0, match.index));
      pending = pending.slice(match.index + match[0].length);
      if (event) yield event;
    }
    if (pending.length > 8_388_608)
      throw new GatewayError('upstream_event_too_large', 502);
  }
  pending += decoder.decode();
  // A final event is allowed without a trailing blank line; a truncated JSON is rejected.
  if (pending.trim()) {
    const event = parseFrame(pending);
    if (event) yield event;
  }
}

export class InferenceClient {
  constructor(session, { fetchImpl = fetch } = {}) {
    this.session = session;
    this.fetch = fetchImpl;
    this.traces = [];
  }
  async models(signal) {
    const accessToken = await this.session.accessToken();
    const response = await this.fetch(`${RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(15_000),
      ]),
    });
    if (!response.ok)
      throw new GatewayError(
        response.status === 401 ? 'sign_in_required' : 'model_catalog_failed',
        response.status === 401 ? 401 : 502
      );
    const result = await readJson(response);
    if (!Array.isArray(result.models))
      throw new GatewayError('model_catalog_invalid', 502);
    return result.models
      .filter(
        model => model.visibility === 'list' && typeof model.slug === 'string'
      )
      .map(model => ({
        id: model.slug,
        object: 'model',
        display_name: model.display_name ?? model.slug,
        owned_by: 'openai',
      }));
  }
  async *events(request, signal) {
    const { body } = normalizeRequest(request);
    const trace = {
      model: body.model,
      started_at: new Date().toISOString(),
      tools: (body.tools ?? []).flatMap(tool =>
        tool.type === 'namespace'
          ? tool.tools.map(item => item.name)
          : [tool.name ?? tool.type]
      ),
      events: {},
      outputs: [],
      completed: false,
    };
    // In-memory protocol metadata only: no inputs, tool arguments, outputs or credentials.
    this.traces.push(trace);
    if (this.traces.length > 20) this.traces.shift();
    const accessToken = await this.session.accessToken();
    const response = await this.fetch(`${RESOURCE}/responses`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(180_000),
      ]),
    });
    if (!response.ok) {
      let code = 'inference_upstream_failed';
      try {
        const data = await response.json();
        if (ERROR_CODES.has(data.error?.code)) code = data.error.code;
      } catch {
        /* no raw data */
      }
      if (response.status === 401) code = 'sign_in_required';
      throw new GatewayError(
        code,
        response.status === 401 ? 401 : response.status === 429 ? 429 : 502
      );
    }
    const contentType = response.headers.get('content-type');
    // Observed on the public SIWC endpoint: SSE can arrive without a MIME header.
    // In that case parseSSE must still validate framed JSON events. An explicitly
    // different MIME type remains rejected.
    if (
      !response.body ||
      (contentType && !contentType.includes('text/event-stream'))
    ) {
      throw new GatewayError('upstream_sse_required', 502);
    }
    let completed = false;
    const outputItems = new Map();
    for await (let event of parseSSE(response.body)) {
      trace.events[event.type] = (trace.events[event.type] ?? 0) + 1;
      if (
        ['response.failed', 'response.incomplete', 'error'].includes(event.type)
      ) {
        const code = event.response?.error?.code ?? event.code;
        throw new GatewayError(
          ERROR_CODES.has(code) ? code : 'inference_not_completed',
          502
        );
      }
      if (event.type === 'response.output_item.done') {
        if (
          !Number.isSafeInteger(event.output_index) ||
          event.output_index < 0 ||
          !event.item ||
          typeof event.item.type !== 'string'
        )
          throw new GatewayError('invalid_upstream_output_item', 502);
        outputItems.set(event.output_index, event.item);
        trace.outputs.push({
          type: event.item.type,
          name:
            event.item.type === 'function_call' ? event.item.name : undefined,
        });
      }
      if (event.type === 'response.completed') {
        if (
          event.response?.status !== 'completed' ||
          !Array.isArray(event.response.output)
        ) {
          throw new GatewayError('invalid_completed_response', 502);
        }
        // SIWC was observed to emit completed tool items while leaving terminal
        // output empty. Rebuild ordered output from authoritative item.done events.
        // Do this for the forwarded SSE too, so non-streaming and streaming clients agree.
        if (outputItems.size) {
          const finalItems = event.response.output;
          const streamed = [...outputItems.entries()]
            .sort(([a], [b]) => a - b)
            .map(
              ([, item]) =>
                finalItems.find(final => item.id && final.id === item.id) ??
                item
            );
          const ids = new Set(streamed.map(item => item.id).filter(Boolean));
          const additional = finalItems.filter(
            item => !item.id || !ids.has(item.id)
          );
          event = {
            ...event,
            response: {
              ...event.response,
              output: [...streamed, ...additional],
            },
          };
        }
        completed = true;
        trace.completed = true;
      }
      yield event;
      if (completed) return;
    }
    throw new GatewayError('upstream_stream_interrupted', 502);
  }
  async complete(request, { signal, onEvent = async () => {} } = {}) {
    let result;
    for await (const event of this.events(request, signal)) {
      await onEvent(event);
      if (event.type === 'response.completed') result = event.response;
    }
    return result;
  }
}

export const ADD_TOOL = {
  type: 'function',
  name: 'add',
  description: 'Add two finite numbers without side effects.',
  strict: true,
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
};

export function executeDemoTool(call) {
  if (
    call.name !== 'add' ||
    (call.namespace !== undefined && call.namespace !== 'affine') ||
    typeof call.call_id !== 'string' ||
    !call.call_id ||
    typeof call.arguments !== 'string' ||
    call.arguments.length > 32_768
  ) {
    throw new GatewayError('demo_tool_rejected');
  }
  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    throw new GatewayError('demo_tool_invalid_arguments');
  }
  if (
    !args ||
    Array.isArray(args) ||
    Object.keys(args).sort().join(',') !== 'a,b' ||
    !Number.isFinite(args.a) ||
    !Number.isFinite(args.b) ||
    Math.abs(args.a) > 1e12 ||
    Math.abs(args.b) > 1e12
  )
    throw new GatewayError('demo_tool_invalid_arguments');
  return {
    type: 'function_call_output',
    call_id: call.call_id,
    output: JSON.stringify({ sum: args.a + args.b }),
  };
}

export async function toolDemo(
  client,
  model,
  { signal, onEvent = async () => {} } = {}
) {
  const input = [
    {
      role: 'user',
      content:
        'Use the add tool to add 19 and 23, then state the result briefly.',
    },
  ];
  let count = 0;
  for (let turn = 0; turn < 4; turn++) {
    const response = await client.complete(
      {
        model,
        input,
        tools: [ADD_TOOL],
        tool_choice: turn === 0 ? 'required' : 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'low' },
        stream: true,
      },
      { signal, onEvent }
    );
    const calls = response.output.filter(item => item.type === 'function_call');
    if (!calls.length) {
      if (!count) throw new GatewayError('demo_no_tool_call', 502);
      await onEvent({ type: 'gateway.demo.completed', calls: count });
      return response;
    }
    count += calls.length;
    if (count > 8) throw new GatewayError('demo_tool_limit', 502);
    const outputs = calls.map(executeDemoTool);
    // Preserve reasoning (including encrypted content) and every output item.
    input.push(...response.output, ...outputs);
    await onEvent({
      type: 'gateway.demo.tool_executed',
      calls: calls.length,
      result: outputs.map(item => JSON.parse(item.output)),
    });
  }
  throw new GatewayError('demo_turn_limit', 502);
}
