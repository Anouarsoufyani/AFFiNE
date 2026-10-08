// Explicitly invoked only. Consumes one small real GPT request via the local daemon.
// It reads only the gateway key, never the OAuth token record, and prints no secrets.
import { GatewayError, safeError } from '../src/errors.mjs';
import { KeychainStore } from '../src/keychain.mjs';

try {
  const model = process.argv[2] ?? 'gpt-6-sol';
  const store = new KeychainStore();
  await store.prepare();
  const key = await store.get('local-access-v1');
  if (!key) throw new GatewayError('start_gateway_first');
  const response = await fetch('http://127.0.0.1:43187/v1/responses', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(180_000),
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'user',
          content: 'Return answer equal to OK in the requested JSON schema.',
        },
      ],
      reasoning: { effort: 'low' },
      stream: false,
      temperature: 0,
      max_output_tokens: 16,
      text: {
        format: {
          type: 'json_schema',
          name: 'gateway_probe',
          strict: true,
          schema: {
            type: 'object',
            properties: { answer: { type: 'string', enum: ['OK'] } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!response.ok)
    throw new GatewayError('live_structured_probe_failed', response.status);
  const result = await response.json();
  const text = result.output
    .flatMap(item => (item.type === 'message' ? item.content : []))
    .filter(item => item.type === 'output_text')
    .map(item => item.text)
    .join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayError('live_structured_json_invalid');
  }
  if (
    parsed.answer !== 'OK' ||
    Object.keys(parsed).length !== 1 ||
    result.status !== 'completed'
  ) {
    throw new GatewayError('live_structured_schema_mismatch');
  }
  console.log(
    JSON.stringify(
      {
        model,
        status: result.status,
        structured_schema_valid: true,
        omitted_parameters: response.headers.get(
          'x-gateway-omitted-parameters'
        ),
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(safeError(error).code);
  process.exitCode = 1;
}
