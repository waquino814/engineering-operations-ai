import { homedir } from 'node:os';
import { ContractError } from './intake/contract.ts';
import { validateBundle } from './intake/validate-bundle.ts';
import { AppConfigError } from './app/config.ts';
import { createApplication, type AppDeps } from './app/application.ts';
import { jsonLinesSink, type EventSink } from './app/events.ts';
import { ProviderPolicyError, type AppEnv } from './app/provider-gate.ts';
import {
  resolveListenHost,
  resolveListenPort,
  ServerConfigError,
  startServer,
} from './app/http-server.ts';
import { summarize } from './investigation/summary.ts';
import { withDataDefaults } from './app/data-dirs.ts';

/**
 * `node src/cli.ts validate <bundle-dir> [--json]`: validates a bundle against the contract.
 * Exit codes: 0 valid, 1 invalid, 2 usage or contract error. It never modifies the bundle.
 *
 * `node src/cli.ts investigate <bundle-id> [--json]` (ADR 0012): runs the application layer's
 * provider gate, then an investigation, and stores the result. Exit codes: 0 completed or
 * inconclusive, 1 failed or budget exceeded, 2 usage, configuration or policy error (no request).
 */
const USAGE = [
  'usage: node src/cli.ts validate <bundle-dir> [--json]',
  '       node src/cli.ts investigate <bundle-id> [--json]',
  '       node src/cli.ts serve [--host <loopback-address>] [--port <n>] [--events stderr]',
].join('\n');

/** Where the CLI writes; process.stdout and process.stderr satisfy it. */
export interface Writer {
  write(text: string): unknown;
}

async function investigate(
  bundleId: string,
  json: boolean,
  out: Writer,
  err: Writer,
  env: AppEnv,
  deps: AppDeps,
): Promise<number> {
  let app;
  try {
    app = createApplication(env, deps);
  } catch (e) {
    if (e instanceof ProviderPolicyError || e instanceof AppConfigError) {
      err.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const outcome = await app.startInvestigation(bundleId);
  if (outcome.status === 'refused') {
    err.write(`${outcome.message}\n`);
    return 2;
  }
  if (outcome.status === 'error') {
    err.write(`${outcome.reason}: ${bundleId}\n`);
    return 2;
  }
  if (json) {
    out.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
  } else {
    const s = summarize(outcome.result);
    out.write(
      `run ${outcome.runId}: ${s.outcome}${s.failureClass ? ` (${s.failureClass})` : ''}, ` +
        `${String(s.findings)} finding(s), ${String(s.usage.modelCalls)} model call(s)\n`,
    );
  }
  return outcome.result.outcome === 'completed' || outcome.result.outcome === 'inconclusive'
    ? 0
    : 1;
}

export interface CliDeps extends AppDeps {
  /** The user's home directory; when given, data directories default to a place under it. */
  home?: string;
  /** Called with a function that stops the server; the entry point wires signals to it. */
  onServing?: (stop: () => Promise<void>) => void;
}

/** `serve`: the loopback server for the console (ADR 0012). Runs until the process is signalled. */
async function serve(
  rest: readonly string[],
  out: Writer,
  err: Writer,
  env: AppEnv,
  deps: CliDeps,
): Promise<number> {
  let host: string | undefined;
  let port: number | undefined;
  let events: EventSink | undefined;
  const fromEnv = env['EOAI_PORT'];
  if (fromEnv !== undefined && fromEnv !== '')
    port = /^\d{1,5}$/.test(fromEnv) ? Number(fromEnv) : -1;
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] === '--host' && value !== undefined) host = value;
    else if (rest[i] === '--events' && value === 'stderr') events = jsonLinesSink(err);
    else if (rest[i] === '--port' && value !== undefined)
      port = /^\d{1,5}$/.test(value) ? Number(value) : -1;
    else {
      err.write(`${USAGE}\n`);
      return 2;
    }
  }
  try {
    resolveListenHost(host);
    resolveListenPort(port);
    const { onServing } = deps;
    const appDeps: AppDeps = { ...deps, ...(events ? { events } : {}) };
    delete appDeps.signal;
    const withDirs = deps.home === undefined ? env : withDataDefaults(env, deps.home);
    const server = await startServer({
      env: withDirs,
      ensureDirs: true,
      appDeps,
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
      staticDir: new URL('../dist/ui/', import.meta.url).pathname,
    });
    out.write(
      `listening on http://${server.host.includes(':') ? `[${server.host}]` : server.host}:${String(server.port)}\n`,
    );
    if (!server.consoleServed)
      err.write('the console is not built (pnpm ui:build); serving the API only\n');
    await new Promise<void>((resolve) => {
      onServing?.(async () => {
        await server.close();
        resolve();
      });
    });
    return 0;
  } catch (e) {
    if (
      e instanceof ProviderPolicyError ||
      e instanceof AppConfigError ||
      e instanceof ServerConfigError
    ) {
      err.write(`${e.message}\n`);
      return 2;
    }
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      err.write(
        'that port is already in use on this machine: another process (possibly an earlier instance) is listening on it. Stop it, or use --port / EOAI_PORT.\n',
      );
      return 2;
    }
    throw e;
  }
}

export async function main(
  argv: readonly string[],
  out: Writer = process.stdout,
  err: Writer = process.stderr,
  // The only place the process environment is read (ADR 0012).
  env: AppEnv = process.env,
  deps: CliDeps = {},
): Promise<number> {
  const args = argv.filter((a) => a !== '--json');
  const json = argv.includes('--json');
  if (args[0] === 'serve') {
    return serve(args.slice(1), out, err, env, deps);
  }
  if (args[0] === 'investigate' && args.length === 2 && args[1] !== undefined) {
    return investigate(
      args[1],
      json,
      out,
      err,
      deps.home === undefined ? env : withDataDefaults(env, deps.home),
      deps,
    );
  }
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
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  process.exitCode = await main(
    process.argv.slice(2),
    process.stdout,
    process.stderr,
    process.env,
    {
      home: homedir(),
      signal: controller.signal,
      onServing: (stop) => {
        for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void stop());
      },
    },
  );
}
