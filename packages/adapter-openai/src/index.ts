import {
  createOpenAICompatibleAdapter,
  type OpenAICompatibleAdapterOptions,
} from "@llm-router/adapter-openai-compatible";
import type { ProviderAdapter } from "@llm-router/core";

export interface OpenAIAdapterOptions extends Omit<
  OpenAICompatibleAdapterOptions,
  "endpoint" | "id"
> {
  endpoint?: string;
}

export function createOpenAIAdapter(options: OpenAIAdapterOptions): ProviderAdapter {
  return createOpenAICompatibleAdapter({
    ...options,
    endpoint: options.endpoint ?? "https://api.openai.com/v1",
    id: "openai",
  });
}
