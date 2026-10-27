import {
  ProviderError,
  type ModelProvider,
  type ModelReply,
  type ModelRequest,
} from '../../investigation/provider.ts';
import { toWireSchema } from '../wire-schema.ts';
import type { OllamaHttp } from './client.ts';
import type { VerifiedLocalModel } from './verify.ts';

/**
 * The Ollama adapter behind the `ModelProvider` port (ADR 0013). It takes only a model that passed
 * `verifyLocalModel`, talks to the loopback runtime through an injected client, never retries
 * (the investigator counts every attempt), and returns the reply text for the investigator to
 * parse and verify. An empty or malformed reply is not turned into anything: it goes back as
 * text, and fails parsing like any other invalid reply.
 */
export interface OllamaSettings {
  /** Context window requested from the runtime, in tokens. */
  numCtx: number;
  /**
   * `schema` passes the derived output schema as a constraint; `json` only asks for valid JSON
   * and puts the schema in the prompt. The reply is verified the same way either way.
   */
  format?: 'schema' | 'json';
}

/**
 * Plain guidance appended to the fixed instructions for a small local model, about the shape of
 * the reply only (it says nothing about any scenario). It keeps facts in `statement` and
 * hypotheses and uncertainty in `rationale` and `limitations`, the fields the result already has.
 */
export const LOCAL_GUIDANCE = [
  'How to write the reply:',
  '- Top-level keys: schemaVersion, outcome, findings, remediation, limitations.',
  '- Each finding has id (a short label such as "F1"), kind ("root_cause", "affected_component" or "symptom"), statement, components (service names), confidence ("high", "medium" or "low"), rationale and evidence.',
  '- statement says only what the cited records show. rationale explains your reasoning and marks anything that is a hypothesis. Put alternative explanations and what is not visible in limitations.',
  '- Each evidence item cites one record from the input and copies its identifiers exactly: for logs.jsonl give file, line, time and service; for metrics.jsonl give file, line and series {name, labels}; for traces.jsonl give file, line and traceId. Add no other field to an evidence item.',
  '- remediation is a list of {step, addresses}; addresses lists finding ids such as "F1", never component names. Order the steps as next debugging steps.',
  '- Reply with one JSON object only.',
].join('\n');

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export class OllamaProvider implements ModelProvider {
  readonly provider = 'ollama';
  readonly model: string;
  private readonly http: OllamaHttp;
  private readonly settings: OllamaSettings;

  constructor(http: OllamaHttp, model: VerifiedLocalModel, settings: OllamaSettings) {
    this.http = http;
    this.model = model.name;
    this.settings = settings;
  }

  async complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelReply> {
    const wire = toWireSchema(request.outputSchema).schema;
    const mode = this.settings.format ?? 'schema';
    const system = [
      request.instructions,
      LOCAL_GUIDANCE,
      ...(mode === 'json' ? [`Output JSON Schema:\n${JSON.stringify(wire)}`] : []),
    ].join('\n\n');
    let reply;
    try {
      reply = await this.http.post(
        '/api/chat',
        {
          model: this.model,
          stream: false,
          think: false,
          format: mode === 'json' ? 'json' : wire,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: request.input },
          ],
          options: {
            num_predict: request.maxOutputTokens,
            num_ctx: this.settings.numCtx,
            temperature: 0,
            seed: 0,
          },
        },
        options.signal,
      );
    } catch (error) {
      if (options.signal.aborted || (error as { name?: string }).name === 'AbortError')
        throw new ProviderError('timeout', 'the request was aborted');
      throw new ProviderError('unavailable', 'the local Ollama runtime could not be reached');
    }
    if (reply.status === 404)
      throw new ProviderError('rejected_request', 'Ollama does not have that model');
    if (reply.status >= 500)
      throw new ProviderError('unavailable', 'Ollama reported an internal error');
    if (reply.status !== 200)
      throw new ProviderError('rejected_request', 'Ollama rejected the request');
    if (!isObject(reply.body))
      throw new ProviderError('rejected_request', 'Ollama sent a reply that is not JSON');
    const message = reply.body['message'];
    const text =
      isObject(message) && typeof message['content'] === 'string' ? message['content'] : '';
    const usage: ModelReply['usage'] = {};
    if (isCount(reply.body['prompt_eval_count']))
      usage.inputTokens = reply.body['prompt_eval_count'];
    if (isCount(reply.body['eval_count'])) usage.outputTokens = reply.body['eval_count'];
    return { text, usage };
  }
}
