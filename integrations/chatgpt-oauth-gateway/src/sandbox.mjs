import { GatewayError } from './errors.mjs';

// This controller is deliberately limited to the isolated local test environment.
// It cannot connect to the installed desktop application or a remote server.
export const SANDBOX_RECORD = 'affine-sandbox-v1';
const AFFINE = 'http://127.0.0.1:3010';
const OLLAMA = 'http://127.0.0.1:11435';
const GATEWAY = 'http://127.0.0.1:43187/v1';
const FIELDS =
  'profileId name revision enabled definition { endpoint { kind url dialect } models { modelId enabled capabilities { input output features attachmentKinds attachmentSources } } }';
const capability = (output, features = []) => ({
  input: ['text'],
  output: [output],
  features,
  attachmentKinds: [],
  attachmentSources: [],
});
export function definition(modelId, embedding = false) {
  return {
    endpoint: {
      kind: 'openai_compatible',
      url: embedding ? `${OLLAMA}/v1` : GATEWAY,
      dialect: embedding ? 'chat_completions' : 'responses',
    },
    models: [
      {
        modelId,
        enabled: true,
        capabilities: embedding
          ? [capability('embedding')]
          : [
              capability('text'),
              capability('text', ['tool_calling']),
              capability('structured'),
            ],
      },
    ],
  };
}
export function validVectors(body, count) {
  return (
    Array.isArray(body.data) &&
    body.data.length === count &&
    body.data.every(
      (item, i) =>
        item.index === i &&
        Array.isArray(item.embedding) &&
        item.embedding.length === 1024 &&
        item.embedding.every(Number.isFinite) &&
        item.embedding.some(value => value !== 0)
    )
  );
}

export class SandboxIntegration {
  constructor(store, session, inference, { fetchImpl = fetch } = {}) {
    this.store = store;
    this.session = session;
    this.inference = inference;
    this.fetch = fetchImpl;
    this.queue = Promise.resolve();
    this.cookie = null;
  }
  async request(url, body, headers = {}) {
    const response = await this.fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new GatewayError('sandbox_service_request_failed', 502);
    return response;
  }
  async config() {
    const config = await this.store.get(SANDBOX_RECORD);
    if (!config?.workspaceId || !config.email || !config.password)
      throw new GatewayError('sandbox_not_configured', 503);
    return config;
  }
  async login() {
    const config = await this.config();
    const response = await this.request(`${AFFINE}/api/auth/sign-in`, {
      email: config.email,
      password: config.password,
    });
    this.cookie = response.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    if (!this.cookie) throw new GatewayError('sandbox_login_failed', 502);
  }
  async gql(query, variables, retry = true) {
    if (!this.cookie) await this.login();
    let response = await this.fetch(`${AFFINE}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: JSON.stringify({ query, variables }),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 401 && retry) {
      this.cookie = null;
      await this.login();
      return this.gql(query, variables, false);
    }
    const body = await response.json();
    if (!response.ok || body.errors?.length || !body.data)
      throw new GatewayError('sandbox_graphql_failed', 502);
    return body.data;
  }
  async workspace() {
    const config = await this.config();
    const data = await this.gql(
      `query($id:String!){workspace(id:$id){id enableDocEmbedding byokSettings{profiles{${FIELDS}}}}}`,
      { id: config.workspaceId }
    );
    return data.workspace;
  }
  async embeddings() {
    const tags = await (await this.request(`${OLLAMA}/api/tags`)).json();
    const result = [];
    for (const model of tags.models ?? []) {
      const info = await (
        await this.request(`${OLLAMA}/api/show`, { model: model.name })
      ).json();
      if (!info.capabilities?.includes('embedding')) continue;
      const dimensions = Object.entries(info.model_info ?? {}).find(([key]) =>
        key.endsWith('.embedding_length')
      )?.[1];
      result.push({
        id: model.name,
        display_name:
          {
            'qwen3-embedding:0.6b': 'Qwen3 Embedding 0.6B',
            'bge-m3:latest': 'BGE M3',
            'bge-m3': 'BGE M3',
          }[model.name] ?? model.name.replaceAll('-', ' '),
        size: model.size,
        dimensions,
        compatible: Number.isInteger(dimensions) && dimensions >= 1024,
      });
    }
    return result;
  }
  async install({ model }) {
    if (!['qwen3-embedding:0.6b', 'bge-m3'].includes(model))
      throw new GatewayError('embedding_install_not_allowed');
    const response = await this.fetch(`${OLLAMA}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
      redirect: 'error',
      signal: AbortSignal.timeout(600_000),
    });
    const result = await response.json();
    if (!response.ok || result.status !== 'success')
      throw new GatewayError('embedding_install_failed', 502);
    return { installed: true, embeddingModels: await this.embeddings() };
  }
  async catalog() {
    const [workspace, chatModels, embeddingModels] = await Promise.all([
      this.workspace(),
      this.inference.models(),
      this.embeddings(),
    ]);
    const profiles = workspace.byokSettings.profiles;
    return {
      workspaceId: workspace.id,
      affineUrl: `http://127.0.0.1:33080/workspace/${workspace.id}/chat`,
      indexingEnabled: workspace.enableDocEmbedding,
      chatModels,
      embeddingModels,
      chatModel: profiles.find(p => p.definition.endpoint.url === GATEWAY)
        ?.definition.models[0]?.modelId,
      embeddingModel: profiles.find(p => p.name === 'Ollama local embeddings')
        ?.definition.models[0]?.modelId,
    };
  }
  apply(input) {
    const task = this.queue.then(() => this.applyInner(input));
    this.queue = task.catch(() => {});
    return task;
  }
  async applyInner({ chatModel, embeddingModel }) {
    const catalog = await this.catalog();
    if (!catalog.chatModels.some(model => model.id === chatModel))
      throw new GatewayError('chat_model_not_accessible');
    if (
      !catalog.embeddingModels.some(
        model => model.id === embeddingModel && model.compatible
      )
    )
      throw new GatewayError('embedding_model_incompatible');
    // Validate the real wire response before changing a working AFFiNE profile.
    const vectors = await (
      await this.request(`${OLLAMA}/v1/embeddings`, {
        model: embeddingModel,
        input: ['Local document indexing test.', 'Local retrieval query test.'],
        dimensions: 1024,
      })
    ).json();
    if (!validVectors(vectors, 2))
      throw new GatewayError('embedding_vectors_invalid', 502);
    const workspace = await this.workspace();
    const profiles = workspace.byokSettings.profiles;
    const save = async (existing, name, model, embedding) => {
      const next = definition(model, embedding);
      if (!embedding) {
        next.models = [
          model,
          ...catalog.chatModels.map(item => item.id).filter(id => id !== model),
        ].map(id => definition(id).models[0]);
      }
      if (
        existing &&
        JSON.stringify(existing.definition) === JSON.stringify(next) &&
        existing.enabled
      )
        return;
      const input = {
        workspaceId: workspace.id,
        name,
        description: 'Managed by the local OAuth sandbox control panel.',
        enabled: true,
        definition: next,
        credential: embedding ? 'ollama-local' : this.session.localKey,
      };
      if (existing) {
        input.profileId = existing.profileId;
        input.expectedRevision = existing.revision;
        await this.gql(
          'mutation($input:ReplaceWorkspaceByokProfileInput!){replaceWorkspaceByokProfile(input:$input){profileId revision}}',
          { input }
        );
      } else {
        input.provider = 'openai';
        await this.gql(
          'mutation($input:CreateWorkspaceByokProfileInput!){createWorkspaceByokProfile(input:$input){profileId revision}}',
          { input }
        );
      }
    };
    await save(
      profiles.find(p => p.definition.endpoint.url === GATEWAY),
      'ChatGPT OAuth',
      chatModel,
      false
    );
    await save(
      profiles.find(p => p.name === 'Ollama local embeddings'),
      'Ollama local embeddings',
      embeddingModel,
      true
    );
    await this.gql(
      'mutation($input:UpdateWorkspaceInput!){updateWorkspace(input:$input){id enableDocEmbedding}}',
      {
        input: { id: workspace.id, enableDocEmbedding: true },
      }
    );
    return {
      ...(await this.catalog()),
      reindexRequired: catalog.embeddingModel !== embeddingModel,
    };
  }
}
