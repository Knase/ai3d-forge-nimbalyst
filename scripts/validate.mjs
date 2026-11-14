// The SDK index pulls in host-only modules, so load the validator file directly.
import { validateExtensionBundle, printValidationResult } from '../node_modules/@nimbalyst/extension-sdk/dist/validate.js';

const result = await validateExtensionBundle('./dist');
printValidationResult(result);
process.exit(result.valid ? 0 : 1);
