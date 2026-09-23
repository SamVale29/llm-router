import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { demoCatalog } from "@llm-router/catalog";
import type { ExecutionResult, Router, RouterEvent, RoutingDecision } from "@llm-router/core";
import { createProxyServer, type ProxyHandle } from "@llm-router/proxy";

const handles: ProxyHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function stubRouter(stream: () => AsyncIterable<RouterEvent>): Router {
  return {
    decide: async () => ({}) as RoutingDecision,
    explain: async () => ({}) as RoutingDecision,
    execute: async <T = unknown>() =>
      ({
        decision: {} as RoutingDecision,
        response: "ok",
        execution: { attempts: [], totalDurationMs: 0 },
      }) as unknown as ExecutionResult<T>,
    stream,
    shadow: async () => [],
  };
}

async function start(
  router: Router,
  options: { enableCompletions?: boolean } = {},
): Promise<string> {
  const handle = createProxyServer({
    router,
    catalog: demoCatalog,
    port: 0,
    allowedOrigins: ["https://trusted.test"],
    ...options,
  });
  handles.push(handle);
  await once(handle.server, "listening");
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind to a port.");
  return `http://127.0.0.1:${address.port}`;
}

describe("proxy safety contract", () => {
  it("converts a streaming failure after headers into an SSE error event", async () => {
    const router = stubRouter(async function* () {
      yield { type: "decision", decision: {} as RoutingDecision };
      throw new Error("stream hook failed");
    });
    const url = await start(router, { enableCompletions: true });
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"code":"proxy-error"');
  });

  it("returns safe client errors for malformed JSON", async () => {
    const url = await start(stubRouter(async function* () {}));
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid-request" } });
  });

  it("does not grant a null CORS origin and hides the model list by default", async () => {
    const url = await start(stubRouter(async function* () {}));
    const corsResponse = await fetch(`${url}/health`, {
      headers: { origin: "https://untrusted.test" },
    });
    expect(corsResponse.headers.get("access-control-allow-origin")).toBeNull();
    const modelsResponse = await fetch(`${url}/v1/router/models`);
    expect(modelsResponse.status).toBe(404);
  });
});

describe("audited proxy compatibility", () => {
  it("preserves native routing constraints, input, hints and schema", async () => {
    const router = stubRouter(async function* () {});
    let captured: unknown;
    router.decide = async (request) => {
      captured = request;
      return {} as RoutingDecision;
    };
    const url = await start(router);
    const body = {
      messages: [{ role: "user", content: "x" }],
      constraints: { deniedModels: ["demo-code-pro"], maxMonthlyBudget: 1 },
      input: { estimatedTokens: 90 },
      hints: { task: "ocr" },
      output: { maxTokens: 20, schema: { type: "object" } },
    };
    const response = await fetch(`${url}/v1/router/decide`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(captured).toMatchObject(body);
  });
  it("converts Responses input, OpenAI tools and generation settings", async () => {
    const router = stubRouter(async function* () {});
    let captured: unknown;
    const execute = router.execute;
    router.execute = async <T = unknown>(request: Parameters<Router["execute"]>[0]) => {
      captured = request;
      const result = await execute<T>(request);
      return {
        ...result,
        text: "OK",
        toolCalls: [{ callId: "call-1", name: "lookup", arguments: "{}" }],
      };
    };
    const url = await start(router);
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
        input: "hello",
        temperature: 0.2,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      }),
    });
    expect(response.status).toBe(200);
    expect(captured).toMatchObject({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup" }],
      providerOptions: { compatible: { temperature: 0.2 } },
    });
    expect(await response.json()).toMatchObject({
      object: "response",
      output: [
        { type: "message", content: [{ text: "OK" }] },
        { type: "function_call", call_id: "call-1" },
      ],
    });
  });
  it("uses normalized text and tools in chat responses", async () => {
    const router = stubRouter(async function* () {});
    const execute = router.execute;
    router.execute = async <T = unknown>(request: Parameters<Router["execute"]>[0]) => ({
      ...(await execute<T>(request)),
      text: "OK",
      toolCalls: [{ callId: "call-1", name: "lookup", arguments: "{}" }],
    });
    const url = await start(router);
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(await response.json()).toMatchObject({
      choices: [
        {
          message: { content: "OK", tool_calls: [{ id: "call-1", function: { name: "lookup" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
  });
  it("rejects invalid native fields and unsupported Responses state with HTTP 400", async () => {
    const url = await start(stubRouter(async function* () {}));
    for (const [path, body] of [
      [
        "/v1/router/decide",
        {
          messages: [{ role: "user", content: "x" }],
          constraints: { maxMonthlyBudget: "invalid" },
        },
      ],
      ["/v1/responses", { input: "x", previous_response_id: "r" }],
    ] as const) {
      const response = await fetch(url + path, { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
  });
  it("filters internal stream events and carries tool calls and usage", async () => {
    const result = await stubRouter(async function* () {}).execute({
      messages: [{ role: "user", content: "x" }],
    });
    result.usage = { inputTokens: 2, outputTokens: 3 };
    result.toolCalls = [{ callId: "call", name: "lookup", arguments: "{}" }];
    const router = stubRouter(async function* () {
      yield { type: "decision", decision: {} as RoutingDecision };
      yield { type: "attempt-start", modelId: "a", providerId: "p", attempt: 1 };
      yield { type: "tool-call", callId: "call", name: "lookup", arguments: "{}" };
      yield { type: "complete", result };
    });
    const url = await start(router);
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    const text = await response.text();
    expect(text).not.toContain('"type":"decision"');
    expect(text).not.toContain("attempt-start");
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"total_tokens":5');
    expect(text).toContain("[DONE]");
  });
  it("requires authentication for external binding", () => {
    expect(() =>
      createProxyServer({
        router: stubRouter(async function* () {}),
        catalog: demoCatalog,
        host: "0.0.0.0",
      }),
    ).toThrow(/authToken/);
  });
  it("aborts provider work as soon as a streaming client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const router = stubRouter(async function* () {});
    router.stream = async function* (request) {
      upstreamSignal = request.signal;
      request.signal?.addEventListener("abort", cancelled, { once: true });
      yield { type: "text-delta", text: "hello" };
      await cancellation;
    };
    const url = await start(router);
    const controller = new AbortController();
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    await response.body!.getReader().read();
    controller.abort();
    await cancellation;
    expect(upstreamSignal?.aborted).toBe(true);
  });
});

it("emits ordered Responses lifecycle events for mixed text and tools", async () => {
  const result = await stubRouter(async function* () {}).execute({
    messages: [{ role: "user", content: "x" }],
  });
  result.decision.requestId = "r";
  result.text = "OK";
  result.toolCalls = [{ callId: "c1", name: "lookup", arguments: "{}" }];
  const router = stubRouter(async function* () {
    yield { type: "decision", decision: result.decision };
    yield { type: "text-delta", text: "OK" };
    yield { type: "tool-call", callId: "c1", name: "lookup", arguments: "{}" };
    yield { type: "complete", result };
  });
  const url = await start(router);
  const response = await fetch(`${url}/v1/responses`, {
    method: "POST",
    body: JSON.stringify({ stream: true, input: "x" }),
  });
  const frames = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  expect(frames[0]?.type).toBe("response.created");
  expect(frames.map((frame) => frame.sequence_number)).toEqual(
    frames.map((_frame, index) => index),
  );
  expect(
    frames
      .filter((frame) => frame.type === "response.output_item.added")
      .map((frame) => frame.output_index),
  ).toEqual([0, 1]);
  expect(frames.at(-1)).toMatchObject({
    type: "response.completed",
    response: {
      output: [
        { type: "message", content: [{ text: "OK" }] },
        { type: "function_call", name: "lookup" },
      ],
    },
  });
});
