import {
  createRouter,
  normalizedErrorFromUnknown,
  type AdapterStreamEvent,
  type ExecutionResult,
  type ProviderAdapter,
  type Router,
  type RouterEvent,
  type RoutingPolicy,
  type RoutingRequest,
} from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const policy: RoutingPolicy = {
  version: "examples",
  routes: [
    {
      id: "all",
      when: {},
      select: { strategy: { kind: "rules" }, candidates: ["demo-code-pro", "demo-economy"] },
    },
  ],
  fallbacks: [{ from: "demo-code-pro", to: ["demo-economy"], on: ["unavailable"] }],
  resilience: {
    retry: { maxAttempts: 1, retryableErrors: ["unavailable"] },
    fallback: { maxModelFallbacks: 1, errors: ["unavailable"] },
  },
};

export function createExampleRouter(): Router {
  return createRouter({
    catalog: demoCatalog,
    policy,
    adapters: {
      "openai-compatible": createMockAdapter("openai-compatible", true),
      openrouter: createMockAdapter("openrouter", false),
    },
  });
}

export function toRoutingRequest(body: unknown, requestId: string): RoutingRequest {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("JSON object expected.");
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.messages) || record.messages.length === 0)
    throw new Error("Request must contain a non-empty messages array.");
  return {
    id: requestId,
    messages: record.messages as RoutingRequest["messages"],
    ...(typeof record.max_tokens === "number" ? { output: { maxTokens: record.max_tokens } } : {}),
  };
}

export function toCompletionResponse(result: ExecutionResult): Record<string, unknown> {
  const text =
    typeof result.response === "string" ? result.response : JSON.stringify(result.response);
  return {
    id: `example-${result.decision.requestId}`,
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: result.usage?.inputTokens ?? 0,
      completion_tokens: result.usage?.outputTokens ?? 0,
    },
  };
}

export function toStreamChunk(event: RouterEvent): Record<string, unknown> {
  if (event.type === "text-delta")
    return { object: "chat.completion.chunk", choices: [{ delta: { content: event.text } }] };
  if (event.type === "error") return { error: event.error };
  return { type: event.type };
}

function createMockAdapter(id: string, shouldFail: boolean): ProviderAdapter {
  return {
    id,
    validateModel() {
      return;
    },
    async execute() {
      if (shouldFail) throw new Error("503 unavailable (deterministic example fallback)");
      return {
        data: { message: "mock response" },
        text: "mock response from the fallback adapter",
        usage: { inputTokens: 12, outputTokens: 8, cost: 0.0001 },
      };
    },
    async *stream(): AsyncIterable<AdapterStreamEvent> {
      if (shouldFail) throw new Error("503 unavailable (deterministic example fallback)");
      yield { type: "text-delta", text: "mock streaming response from the fallback adapter" };
      yield { type: "usage", usage: { inputTokens: 12, outputTokens: 8, cost: 0.0001 } };
    },
    normalizeError(error) {
      return normalizedErrorFromUnknown(error);
    },
  };
}
