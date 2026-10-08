export class GatewayError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Never echo upstream bodies, callback URLs, child-process diagnostics or prompts.
export function safeError(error) {
  return error instanceof GatewayError
    ? error
    : new GatewayError('internal_error', 500);
}

export async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new GatewayError('invalid_upstream_json', 502);
  }
}
