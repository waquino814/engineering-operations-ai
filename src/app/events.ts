/**
 * Operational events (E7 hardening; proposal in docs/proposals/observability.md). The application
 * layer reports what happened to an investigation or an evaluation as a small, closed set of
 * events with bounded fields, so an operator can see outcomes, failure classes, durations and
 * token accounting without reading stored runs.
 *
 * What an event never holds: telemetry, finding statements, rationales, remediation text, model
 * replies, prompts, paths, URLs, credentials, error messages or exception text. Every field is a
 * count, a duration, a flag or an identifier from a closed or validated set (a run id, a bundle
 * id the application already validated, a failure class, a model name). A string that does not
 * look like such an identifier is replaced, not written. There is no sink unless the operator
 * asks for one (`serve --events stderr`); the application never writes a log on its own, makes no
 * request to report an event and adds no dependency.
 */
export type Field = string | number | boolean | null;

/** The events, and the only fields each may carry (checked again at the sink). */
export const EVENT_FIELDS = Object.freeze({
  'investigation.refused': ['reason'],
  'investigation.finished': [
    'runId',
    'bundleId',
    'provider',
    'model',
    'simulated',
    'outcome',
    'failureClass',
    'findings',
    'references',
    'modelCalls',
    'repairs',
    'retries',
    'chargedTokens',
    'tokenAccounting',
    'durationMs',
  ],
  'evaluation.refused': ['reason'],
  'evaluation.finished': [
    'evaluationId',
    'suiteId',
    'suiteVersion',
    'providerKind',
    'measuresModelQuality',
    'status',
    'cases',
    'completed',
    'failed',
    'notAdmitted',
    'harnessErrors',
    'answerLeaks',
    'durationMs',
  ],
} as const);

export type EventName = keyof typeof EVENT_FIELDS;

export interface AppEvent {
  event: EventName;
  /** Milliseconds since the epoch, from the application's clock. */
  at: number;
  fields: Readonly<Record<string, Field>>;
}

export type EventSink = (event: AppEvent) => void;

/** Reports an event; a sink that throws never affects the work being reported. */
export function emitEvent(
  sink: EventSink | undefined,
  now: () => number,
  event: EventName,
  fields: Readonly<Record<string, Field>>,
): void {
  if (sink === undefined) return;
  try {
    sink({ event, at: now(), fields });
  } catch {
    // Observability must not change the outcome of an investigation.
  }
}

// Identifiers only: no whitespace, quotes, slashes, backslashes or colons-then-paths.
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,119}$/;
export const WITHHELD = '(withheld)';

interface Writer {
  write(text: string): unknown;
}

/**
 * One JSON object per line: `{"v":1,"event":…,"at":ISO,…fields}`. Unknown fields are dropped,
 * strings that are not identifiers are withheld, non-finite numbers become null.
 */
export function jsonLinesSink(writer: Writer): EventSink {
  return ({ event, at, fields }) => {
    const allowed: readonly string[] = EVENT_FIELDS[event];
    const line: Record<string, Field> = {};
    for (const name of allowed) {
      const value = fields[name];
      if (value === undefined) continue;
      line[name] =
        typeof value === 'string'
          ? IDENTIFIER.test(value)
            ? value
            : WITHHELD
          : typeof value === 'number'
            ? Number.isFinite(value)
              ? value
              : null
            : value;
    }
    writer.write(`${JSON.stringify({ v: 1, event, at: new Date(at).toISOString(), ...line })}\n`);
  };
}
