import { Ajv2020 } from 'ajv/dist/2020.js';
import standaloneModule from 'ajv/dist/standalone/index.js';
import { INVESTIGATION_RESULT_SCHEMA } from '../src/investigation/schemas.ts';

// The CommonJS default export, as in src/intake/contract.ts.
const standaloneCode = standaloneModule.default;

/** Ajv's own `ucs2length` runtime helper, inlined so the generated module has no imports. */
const UCS2_LENGTH = `function ucs2length(str) {
  const len = str.length;
  let length = 0;
  let pos = 0;
  let value;
  while (pos < len) {
    length++;
    value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      value = str.charCodeAt(pos);
      if ((value & 0xfc00) === 0xdc00) pos++;
    }
  }
  return length;
}
`;

/**
 * The source of an ES module that exports `validateResult`: the published result schema,
 * precompiled by Ajv with the same options as src/investigation/result-validator.ts. It needs no
 * `eval` or `new Function`, so it runs under the application's Content-Security-Policy. Throws if
 * Ajv emits anything this function does not know how to make self-contained.
 */
export function resultValidatorSource(): string {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    code: { source: true, esm: true },
  });
  const validate = ajv.compile(INVESTIGATION_RESULT_SCHEMA);
  const generated = standaloneCode(ajv, validate).replaceAll(
    'require("ajv/dist/runtime/ucs2length").default',
    'ucs2length',
  );
  if (/\brequire\(|\bimport\b|\beval\(|new Function/.test(generated)) {
    throw new Error(
      'the generated validator is not self-contained; update scripts/standalone-validator.ts',
    );
  }
  return `${generated}\n${UCS2_LENGTH}export { validate20 as validateResult };\n`;
}
