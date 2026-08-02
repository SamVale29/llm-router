import {
  createOpenAICompatibleAdapter,
  type OpenAICompatibleAdapterOptions,
} from "@llm-router/adapter-openai-compatible";
import type { ProviderAdapter } from "@llm-router/core";

export interface OpenRouterAdapterOptions extends Omit<
  OpenAICompatibleAdapterOptions,
  "endpoint" | "id"
> {
  endpoint?: string;
  siteUrl?: string;
  appName?: string;
}

export function createOpenRouterAdapter(options: OpenRouterAdapterOptions): ProviderAdapter {
  return createOpenAICompatibleAdapter({
    endpoint: options.endpoint ?? "https://openrouter.ai/api/v1",
    id: "openrouter",
    apiKey: options.apiKey,
    allowHosts: options.allowHosts,
    fetchImpl: options.fetchImpl,
    headers: {
      ...(options.headers ?? {}),
      ...(options.siteUrl ? { "http-referer": options.siteUrl } : {}),
      ...(options.appName ? { "x-title": options.appName } : {}),
    },
  });
}
