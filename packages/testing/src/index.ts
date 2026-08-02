import { normalizedErrorFromUnknown } from "@llm-router/core";
import type {
  AdapterResponse,
  AdapterStreamEvent,
  ExecutionContext,
  ModelDefinition,
  NormalizedRoutingRequest,
  ProviderAdapter,
} from "@llm-router/core";

export interface MockAdapterOptions {
  id?: string;
  response?: AdapterResponse;
  failWith?: Error;
  latencyMs?: number;
  streamText?: string;
}

export function createMockAdapter(options: MockAdapterOptions = {}): ProviderAdapter {
  return {
    id: options.id ?? "mock",
    validateModel() {
      return;
    },
    async execute(
      _request: NormalizedRoutingRequest,
      _model: ModelDefinition,
      context: ExecutionContext,
    ): Promise<AdapterResponse> {
      if (options.latencyMs)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.latencyMs);
          context.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      if (options.failWith) throw options.failWith;
      return (
        options.response ?? {
          data: { ok: true },
          text: "mock response",
          usage: { inputTokens: 10, outputTokens: 4 },
        }
      );
    },
    async *stream(
      _request: NormalizedRoutingRequest,
      _model: ModelDefinition,
      _context: ExecutionContext,
    ): AsyncIterable<AdapterStreamEvent> {
      for (const word of (options.streamText ?? "mock response").split(" "))
        yield { type: "text-delta", text: `${word} ` };
      yield { type: "complete", response: options.response };
    },
    normalizeError(error) {
      return normalizedErrorFromUnknown(error);
    },
  };
}
