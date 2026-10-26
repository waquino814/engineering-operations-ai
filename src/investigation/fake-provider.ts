import {
  ProviderError,
  type ModelProvider,
  type ModelReply,
  type ModelRequest,
} from './provider.ts';

/**
 * A deterministic, injectable provider for tests and the evaluation harness: no network, no
 * credentials, no SDK. Each call consumes the next scripted step; every request is recorded so
 * tests can assert what would have been sent.
 */
export type FakeStep =
  | { reply: string | object; usage?: ModelReply['usage'] }
  | { error: ProviderError }
  /** Never settles until the call's signal aborts, to exercise timeouts and deadlines. */
  | { hang: true };

export class FakeProvider implements ModelProvider {
  readonly provider = 'fake';
  readonly model: string;
  readonly requests: ModelRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[], model = 'fake-model') {
    this.steps = [...steps];
    this.model = model;
  }

  complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelReply> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) return Promise.reject(new Error('FakeProvider has no scripted step left'));
    if ('error' in step) return Promise.reject(step.error);
    if ('hang' in step) {
      return new Promise((_, reject) => {
        const abort = () => {
          reject(new ProviderError('timeout', 'request aborted'));
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    }
    const text = typeof step.reply === 'string' ? step.reply : JSON.stringify(step.reply);
    return Promise.resolve({ text, ...(step.usage ? { usage: step.usage } : {}) });
  }

  /** Scripted steps not yet used. */
  get remaining(): number {
    return this.steps.length;
  }
}
