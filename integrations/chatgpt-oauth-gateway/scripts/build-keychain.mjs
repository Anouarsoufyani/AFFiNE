import { safeError } from '../src/errors.mjs';
import { buildKeychain } from '../src/keychain.mjs';
try {
  await buildKeychain();
  console.log('Helper Keychain compilé.');
} catch (error) {
  console.error(safeError(error).code);
  process.exitCode = 1;
}
