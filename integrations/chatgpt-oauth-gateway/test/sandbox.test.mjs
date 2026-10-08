import assert from 'node:assert/strict';
import test from 'node:test';

import {
  definition,
  SandboxIntegration,
  validVectors,
} from '../src/sandbox.mjs';

test('embeddings use a separate loopback endpoint and only the embedding capability', () => {
  const profile = definition('qwen3-embedding:0.6b', true);
  assert.equal(profile.endpoint.url, 'http://127.0.0.1:11435/v1');
  assert.deepEqual(
    profile.models[0].capabilities.map(c => c.output),
    [['embedding']]
  );
  assert.equal(definition('gpt-6-luna').endpoint.dialect, 'responses');
});
test('reject incorrect dimension, nonfinite values, zero vectors and misordered batches', () => {
  const vector = Array.from({ length: 1024 }, () => 0.1);
  assert.equal(
    validVectors({ data: [{ index: 0, embedding: vector }] }, 1),
    true
  );
  for (const body of [
    { data: [{ index: 0, embedding: vector.slice(0, 768) }] },
    { data: [{ index: 0, embedding: [...vector.slice(1), NaN] }] },
    { data: [{ index: 0, embedding: Array.from({ length: 1024 }, () => 0) }] },
    { data: [{ index: 1, embedding: vector }] },
  ])
    assert.equal(validVectors(body, 1), false);
});
test('model selection rejects unavailable or incompatible choices before mutation', async () => {
  const service = new SandboxIntegration({}, {}, {});
  service.catalog = async () => ({
    chatModels: [{ id: 'gpt-6-luna' }],
    embeddingModels: [{ id: '768-model', compatible: false }],
  });
  await assert.rejects(
    service.apply({ chatModel: 'unavailable', embeddingModel: '768-model' }),
    { code: 'chat_model_not_accessible' }
  );
  await assert.rejects(
    service.apply({ chatModel: 'gpt-6-luna', embeddingModel: '768-model' }),
    { code: 'embedding_model_incompatible' }
  );
});
test('model installation cannot request arbitrary remote names', async () => {
  const service = new SandboxIntegration(
    {},
    {},
    {},
    {
      fetchImpl: () => {
        throw new Error('must not fetch');
      },
    }
  );
  await assert.rejects(service.install({ model: 'attacker.example/model' }), {
    code: 'embedding_install_not_allowed',
  });
});
