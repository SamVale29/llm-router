import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "@llm-router/adapter-openai-compatible";
import type { ModelDefinition, NormalizedRoutingRequest } from "@llm-router/core";

const model: ModelDefinition = {
  id: "m",
  providerId: "p",
  apiModelId: "api-model",
  displayName: "M",
  status: "active",
  modalities: { input: ["text"], output: ["text"] },
  capabilities: {},
  limits: { contextTokens: 1000, outputTokens: 100 },
  operational: { enabled: true },
};
const request: NormalizedRoutingRequest = {
  id: "r",
  messages: [{ role: "user", content: "hello" }],
  input: { modalities: ["text"] },
  output: {},
  constraints: {},
  detectedModalities: ["text"],
  estimatedInputTokens: 2,
};

describe("adapter contract", () => {
  it("maps messages/tools and normalizes usage without exposing credentials", async () => {
    let captured = "";
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.test/v1",
      apiKey: "secret-value",
      fetchImpl: (async (_input, init) => {
        captured = String(init?.body);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const response = await adapter.execute(
      { ...request, tools: [{ name: "lookup", parameters: { type: "object" } }] },
      model,
      { signal: new AbortController().signal, requestId: "r", attempt: 1, timeoutMs: 1000 },
    );
    expect(captured).toContain("api-model");
    expect(captured).toContain("lookup");
    expect(response.text).toBe("ok");
    expect(response.usage?.inputTokens).toBe(2);
    expect(JSON.stringify(response)).not.toContain("secret-value");
  });
});
