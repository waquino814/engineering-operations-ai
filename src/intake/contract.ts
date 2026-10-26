import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

/**
 * The incident-bundle contract as vendored from Commerce Platform (its ADR 0007): which files a
 * bundle has, which schema validates each, and which major versions are supported. The schema
 * files are read from docs/contracts/, the single copy in this repository, and their bytes are
 * pinned here so a changed vendored file is caught instead of silently changing the contract
 * (ADR 0005).
 */
export const MANIFEST_FILE = 'manifest.json';
export const GROUND_TRUTH_FILE = 'ground_truth.json';
export const TELEMETRY_FILES = ['traces.jsonl', 'metrics.jsonl', 'logs.jsonl'] as const;
export const BUNDLE_FILES = [MANIFEST_FILE, GROUND_TRUTH_FILE, ...TELEMETRY_FILES] as const;

export type TelemetryFile = (typeof TELEMETRY_FILES)[number];
export type BundleFile = (typeof BUNDLE_FILES)[number];

export type SchemaName =
  'manifest' | 'ground-truth' | 'trace-record' | 'metrics-record' | 'logs-record';

export const RECORD_SCHEMA: Record<TelemetryFile, SchemaName> = {
  'traces.jsonl': 'trace-record',
  'metrics.jsonl': 'metrics-record',
  'logs.jsonl': 'logs-record',
};

/** SHA-256 of each vendored schema file, as listed in docs/contracts/incident-bundle/README.md. */
export const PINNED_SCHEMAS: Record<number, Record<SchemaName, string>> = {
  1: {
    manifest: '5a0f6e3f153ea71b3187318302538da3e887a1bed202164a36afe475d46b9d8d',
    'ground-truth': '589b08c5d4de52cb960a0fabe50829525babf6b0c3230286371e061e9456b441',
    'trace-record': 'fdd5760206bb2ea0dfa6a27f55f5a0eded854669509f6fcbfd245d62de081bc1',
    'metrics-record': '504d29b675f48874e84b42893dec9778f2b99f8938f2decf4ba0219433d8f17e',
    'logs-record': '17fbf3ada612eff2c58b0105d76e22fc6afaca097fdbae9d8b7577ed9b03e994',
  },
};

export const SUPPORTED_MAJOR_VERSIONS: readonly number[] = Object.keys(PINNED_SCHEMAS).map(Number);

export const CONTRACTS_DIR = fileURLToPath(
  new URL('../../docs/contracts/incident-bundle/', import.meta.url),
);

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

export type Validators = Record<SchemaName, ValidateFunction>;

// ajv-formats is CommonJS; under NodeNext its default export arrives as the module namespace.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const compiled = new Map<number, Promise<Validators>>();

/**
 * The compiled validators for one supported major version, checked against the pinned checksums.
 * Compiled once per process. Strict mode stays on; `allowUnionTypes` admits `type: [..]`, which
 * the vendored ground-truth schema uses and JSON Schema allows.
 */
export function validatorsFor(major: number): Promise<Validators> {
  const pinned = PINNED_SCHEMAS[major];
  if (!pinned) {
    return Promise.reject(new ContractError(`major version ${String(major)} is not vendored`));
  }
  let entry = compiled.get(major);
  if (!entry) {
    entry = (async () => {
      const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
      addFormats(ajv);
      const out: Partial<Validators> = {};
      for (const [name, sha256] of Object.entries(pinned) as [SchemaName, string][]) {
        const path = `${CONTRACTS_DIR}v${String(major)}/${name}.schema.json`;
        const bytes = await readFile(path);
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== sha256) {
          throw new ContractError(
            `vendored schema ${path} has SHA-256 ${actual}, but ${sha256} is pinned; re-vendor it deliberately and update the pin`,
          );
        }
        out[name] = ajv.compile(JSON.parse(bytes.toString('utf8')) as object);
      }
      return out as Validators;
    })();
    entry.catch(() => compiled.delete(major));
    compiled.set(major, entry);
  }
  return entry;
}

/** The major version of a semver string such as "1.0.0", or null if it is not one. */
export function majorOf(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/.exec(version);
  return m ? Number(m[1]) : null;
}
