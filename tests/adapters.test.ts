import { describe, expect, it } from "vitest";
import { createAnthropicAdapter } from "@llm-router/adapter-anthropic";
import { createGoogleAdapter } from "@llm-router/adapter-google";
import { createOpenAIAdapter } from "@llm-router/adapter-openai";
import {
  createOpenAICompatibleAdapter,
  validateEndpoint,
} from "@llm-router/adapter-openai-compatible";
import { createOpenRouterAdapter } from "@llm-router/adapter-openrouter";
import {
  sanitizeMessage,
  type ModelDefinition,
  type NormalizedRoutingRequest,
} from "@llm-router/core";

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

  it("keeps managed fields authoritative and serializes base64 images as data URLs", async () => {
    let payload: Record<string, unknown> | undefined;
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.test/v1",
      fetchImpl: (async (_input, init) => {
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        });
      }) as typeof fetch,
    });
    await adapter.execute(
      {
        ...request,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", value: "iVBORw0KGgo=", mediaType: "image/png" },
              },
            ],
          },
        ],
        providerOptions: {
          compatible: { model: "attacker-model", messages: [], request_id: "attacker-id" },
        },
      },
      model,
      { signal: new AbortController().signal, requestId: "r", attempt: 1, timeoutMs: 1000 },
    );
    expect(payload?.model).toBe("api-model");
    expect(payload?.request_id).toBe("r");
    const messages = payload?.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect((content[0]?.image_url as Record<string, unknown>)?.url).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("sends the Google key in a header instead of the URL", async () => {
    let url = "";
    let headers: HeadersInit | undefined;
    const adapter = createGoogleAdapter({
      endpoint: "https://example.test/v1",
      apiKey: "google-secret",
      fetchImpl: (async (input, init) => {
        url = String(input);
        headers = init?.headers;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
          {
            status: 200,
          },
        );
      }) as typeof fetch,
    });
    await adapter.execute(request, model, {
      signal: new AbortController().signal,
      requestId: "r",
      attempt: 1,
      timeoutMs: 1000,
    });
    expect(url).not.toContain("google-secret");
    expect(new Headers(headers).get("x-goog-api-key")).toBe("google-secret");
  });

  it.each([
    [
      "openai",
      (fetchImpl: typeof fetch) =>
        createOpenAIAdapter({ endpoint: "https://example.test/v1", apiKey: "secret", fetchImpl }),
    ],
    [
      "openrouter",
      (fetchImpl: typeof fetch) =>
        createOpenRouterAdapter({
          endpoint: "https://example.test/v1",
          apiKey: "secret",
          fetchImpl,
        }),
    ],
    [
      "anthropic",
      (fetchImpl: typeof fetch) =>
        createAnthropicAdapter({
          endpoint: "https://example.test/v1",
          apiKey: "secret",
          fetchImpl,
        }),
    ],
    [
      "google",
      (fetchImpl: typeof fetch) =>
        createGoogleAdapter({ endpoint: "https://example.test/v1", apiKey: "secret", fetchImpl }),
    ],
  ])("preserves HTTP error classification for %s", async (_name, createAdapter) => {
    const adapter = createAdapter(
      (async () =>
        new Response(JSON.stringify({ error: { message: "provider overloaded" } }), {
          status: 529,
          headers: { "content-type": "application/json", "retry-after": "30" },
        })) as typeof fetch,
    );
    let thrown: unknown;
    try {
      await adapter.execute(request, model, {
        signal: new AbortController().signal,
        requestId: "r",
        attempt: 1,
        timeoutMs: 1000,
      });
    } catch (error) {
      thrown = error;
    }
    const normalized = adapter.normalizeError(thrown);
    expect(normalized.code).toBe("unavailable");
    expect(normalized.retryable).toBe(true);
    expect(normalized.fallbackEligible).toBe(true);
    expect(normalized.statusCode).toBe(529);
    expect(normalized.retryAfterMs).toBe(30_000);
  });

  it.each([
    [429, "rate-limit"],
    [500, "unavailable"],
    [503, "unavailable"],
    [529, "unavailable"],
  ])("maps HTTP %s to %s", async (status, expectedCode) => {
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.test/v1",
      fetchImpl: (async () => new Response("provider error", { status })) as typeof fetch,
    });
    let thrown: unknown;
    try {
      await adapter.execute(request, model, {
        signal: new AbortController().signal,
        requestId: "r",
        attempt: 1,
        timeoutMs: 1000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(adapter.normalizeError(thrown).code).toBe(expectedCode);
  });

  it("parses OpenAI-compatible SSE comments and releases the reader", async () => {
    let released = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            ': keepalive\n\nevent: message\ndata: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
      cancel() {
        released = true;
      },
    });
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.test/v1",
      fetchImpl: (async () => new Response(stream, { status: 200 })) as typeof fetch,
    });
    const events = [];
    if (!adapter.stream) throw new Error("streaming is required");
    for await (const event of adapter.stream(request, model, {
      signal: new AbortController().signal,
      requestId: "r",
      attempt: 1,
      timeoutMs: 1000,
    }))
      events.push(event);
    expect(events).toEqual([{ type: "text-delta", text: "hello" }]);
    expect(released).toBe(false);
  });

  it("parses Anthropic SSE event records and ignores event lines", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: message_start\ndata: {"type":"message_start"}\n\n' +
              'event: content_block_delta\ndata: {"delta":{"text":"hello"}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        );
        controller.close();
      },
    });
    const adapter = createAnthropicAdapter({
      endpoint: "https://example.test/v1",
      fetchImpl: (async () => new Response(stream, { status: 200 })) as typeof fetch,
    });
    if (!adapter.stream) throw new Error("streaming is required");
    const events = [];
    for await (const event of adapter.stream(request, model, {
      signal: new AbortController().signal,
      requestId: "r",
      attempt: 1,
      timeoutMs: 1000,
    }))
      events.push(event);
    expect(events).toEqual([{ type: "text-delta", text: "hello" }]);
  });

  it("redacts provider credential formats and complete bearer tokens", () => {
    const message = sanitizeMessage(
      "sk-proj-AbC123dEf456GhI789jKl AIzaSyD-1234567890abcdefg Authorization: Bearer eyJhbGciOi.J9+/=abc",
    );
    expect(message).not.toContain("sk-proj-");
    expect(message).not.toContain("AIza");
    expect(message).not.toContain("eyJhbGciOi");
    expect(message).toContain("Bearer [REDACTED]");
  });

  it("rejects private endpoint literals unless an explicit host allowlist is supplied", () => {
    expect(() => validateEndpoint("https://169.254.169.254/latest/meta-data")).toThrow(
      "private or reserved",
    );
    expect(() => validateEndpoint("http://example.test/v1")).toThrow("HTTPS");
    expect(validateEndpoint("https://169.254.169.254", ["169.254.169.254"])).toContain(
      "169.254.169.254",
    );
  });
});
