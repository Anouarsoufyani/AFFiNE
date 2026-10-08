import { safeError } from '../src/errors.mjs';
import { KeychainStore } from '../src/keychain.mjs';
import { SANDBOX_RECORD, SandboxIntegration } from '../src/sandbox.mjs';
import { LOCAL_AUTH } from '../src/session.mjs';

try {
  const store = new KeychainStore();
  await store.prepare();
  if (process.argv.includes('--forget')) {
    await store.delete(SANDBOX_RECORD);
    console.log('Connexion du panneau AFFiNE supprimée du Trousseau.');
    process.exit(0);
  }
  if (process.argv.includes('--configure')) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const config = JSON.parse(input);
    if (
      typeof config.workspaceId !== 'string' ||
      typeof config.email !== 'string' ||
      typeof config.password !== 'string'
    )
      throw new Error('invalid config');
    await store.set(SANDBOX_RECORD, {
      workspaceId: config.workspaceId,
      email: config.email,
      password: config.password,
    });
  }
  const localKey = await store.get(LOCAL_AUTH);
  const inference = {
    models: async () => {
      const response = await fetch('http://127.0.0.1:43187/v1/models', {
        headers: { Authorization: `Bearer ${localKey}` },
        redirect: 'error',
      });
      if (!response.ok) throw new Error('catalog unavailable');
      return (await response.json()).data;
    },
  };
  const sandbox = new SandboxIntegration(store, { localKey }, inference);
  const apply = process.argv.indexOf('--apply');
  const result =
    apply >= 0
      ? await sandbox.apply({
          chatModel: process.argv[apply + 1],
          embeddingModel: process.argv[apply + 2],
        })
      : await sandbox.catalog();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(safeError(error).code);
  process.exitCode = 1;
}
