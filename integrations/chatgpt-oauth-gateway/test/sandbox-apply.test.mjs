import assert from 'node:assert/strict';
import test from 'node:test';

import { definition, SandboxIntegration } from '../src/sandbox.mjs';

test('switching an embedding model updates its real ID and enables workspace indexing', async () => {
  const calls = [];
  const service = new SandboxIntegration(
    {},
    { localKey: 'mock-local-key' },
    {}
  );
  service.catalog = async () => ({
    chatModels: [{ id: 'gpt-6-luna' }],
    embeddingModels: [{ id: 'new-embedding', compatible: true }],
    embeddingModel: 'old-embedding',
  });
  service.workspace = async () => ({
    id: 'sandbox',
    byokSettings: {
      profiles: [
        {
          profileId: 'chat',
          name: 'ChatGPT OAuth',
          revision: 2,
          enabled: true,
          definition: definition('gpt-6-luna'),
        },
        {
          profileId: 'emb',
          name: 'Ollama local embeddings',
          revision: 3,
          enabled: true,
          definition: definition('old-embedding', true),
        },
      ],
    },
  });
  service.request = async () =>
    Response.json({
      data: [0, 1].map(index => ({
        index,
        embedding: Array.from({ length: 1024 }, () => 0.1),
      })),
    });
  service.gql = async (query, variables) => {
    calls.push({ query, variables });
    return {};
  };
  const result = await service.apply({
    chatModel: 'gpt-6-luna',
    embeddingModel: 'new-embedding',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].variables.input.profileId, 'emb');
  assert.equal(calls[0].variables.input.expectedRevision, 3);
  assert.equal(
    calls[0].variables.input.definition.models[0].modelId,
    'new-embedding'
  );
  assert.equal(calls[1].variables.input.enableDocEmbedding, true);
  assert.equal(result.reindexRequired, true);
});

test('invalid real embeddings leave working profiles untouched', async () => {
  const service = new SandboxIntegration({}, {}, {});
  service.catalog = async () => ({
    chatModels: [{ id: 'gpt-6-luna' }],
    embeddingModels: [{ id: 'bad', compatible: true }],
  });
  service.request = async () =>
    Response.json({
      data: [{ index: 0, embedding: Array.from({ length: 768 }, () => 1) }],
    });
  service.workspace = async () => {
    throw new Error('must not mutate');
  };
  await assert.rejects(
    service.apply({ chatModel: 'gpt-6-luna', embeddingModel: 'bad' }),
    { code: 'embedding_vectors_invalid' }
  );
});

test('registers all account chat models while keeping the default first', async () => {
  const calls = [];
  const service = new SandboxIntegration(
    {},
    { localKey: 'mock-local-key' },
    {}
  );
  service.catalog = async () => ({
    chatModels: [{ id: 'gpt-6-sol' }, { id: 'gpt-6-luna' }],
    embeddingModels: [{ id: 'embedding', compatible: true }],
  });
  service.workspace = async () => ({
    id: 'sandbox',
    byokSettings: { profiles: [] },
  });
  service.request = async () =>
    Response.json({
      data: [0, 1].map(index => ({
        index,
        embedding: Array.from({ length: 1024 }, () => 0.1),
      })),
    });
  service.gql = async (query, variables) => {
    calls.push(variables);
    return {};
  };
  await service.apply({ chatModel: 'gpt-6-luna', embeddingModel: 'embedding' });
  assert.deepEqual(
    calls[0].input.definition.models.map(model => model.modelId),
    ['gpt-6-luna', 'gpt-6-sol']
  );
  assert.deepEqual(
    calls[1].input.definition.models.map(model => model.modelId),
    ['embedding']
  );
});
