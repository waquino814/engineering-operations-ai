import { ContractError } from './intake/contract.ts';
import { validateBundle } from './intake/validate-bundle.ts';

/**
 * `node src/cli.ts validate <bundle-dir> [--json]`: validates a bundle against the contract.
 * Exit codes: 0 valid, 1 invalid, 2 usage or contract error. It never modifies the bundle.
 */
const USAGE = 'usage: node src/cli.ts validate <bundle-dir> [--json]';

/** Where the CLI writes; process.stdout and process.stderr satisfy it. */
export interface Writer {
  write(text: string): unknown;
}

export async function main(
  argv: readonly string[],
  out: Writer = process.stdout,
  err: Writer = process.stderr,
): Promise<number> {
  const args = argv.filter((a) => a !== '--json');
  const json = argv.includes('--json');
  if (args[0] !== 'validate' || args.length !== 2 || args[1] === undefined) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const report = await validateBundle(args[1]);
    if (json) {
      out.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (report.valid) {
      out.write(`valid: ${report.bundleDir} (schema ${report.schemaVersion ?? '?'})\n`);
    } else {
      out.write(`invalid: ${report.bundleDir} (${String(report.issues.length)} issue(s))\n`);
      for (const i of report.issues) {
        const at = [
          i.file ?? '(directory)',
          i.line === undefined ? '' : `line ${String(i.line)}`,
          i.field ?? '',
        ]
          .filter(Boolean)
          .join(' ');
        out.write(`  rule ${String(i.rule)} ${i.ruleId} | ${at} | ${i.message}\n`);
      }
    }
    return report.valid ? 0 : 1;
  } catch (e) {
    if (e instanceof ContractError) {
      err.write(`contract error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  process.exitCode = await main(process.argv.slice(2));
}
