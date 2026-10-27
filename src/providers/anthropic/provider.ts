import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, ModelReply, ModelRequest } from '../../investigation/provider.ts';
import { buildMessageParams, mapError, mapMessage, type AnthropicSettings } from './mapping.ts';

/**
 * The smallest part of the SDK client this adapter uses, so tests inject a stub and no network or
 * credential is involved. `Anthropic` satisfies it structurally.
 */
export interface MessageStreamLike {
  finalMessage(): Promise<unknown>;
}
export interface AnthropicClientLike {
  messages: {
    stream(
      params: Record<string, unknown>,
      options: { signal: AbortSignal; maxRetries: number },
    ): MessageStreamLike;
  };
}

/**
 * The Anthropic adapter behind the `ModelProvider` port (ADR 0008). It streams, because a large
 * `max_tokens` is not accepted otherwise, and returns the final message. SDK retries are off
 * (`maxRetries: 0` per call), so the investigator counts every attempt against its limits.
 */
export class AnthropicProvider implements ModelProvider {
  readonly provider = 'anthropic';
  readonly model: string;
  private readonly client: AnthropicClientLike;
  private readonly settings: AnthropicSettings;

  constructor(client: AnthropicClientLike, settings: AnthropicSettings) {
    this.client = client;
    this.settings = settings;
    this.model = settings.model;
  }

  async complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelReply> {
    let message: unknown;
    try {
      message = await this.client.messages
        .stream(buildMessageParams(request, this.settings), {
          signal: options.signal,
          maxRetries: 0,
        })
        .finalMessage();
    } catch (error) {
      throw mapError(error);
    }
    return mapMessage(message);
  }
}

/**
 * Builds the real client with the key given by the caller; this module never reads the
 * environment or logs the key. Constructing it makes no request.
 */
export function createAnthropicProvider(
  apiKey: string,
  settings: AnthropicSettings,
): AnthropicProvider {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return new AnthropicProvider(client, settings);
}
