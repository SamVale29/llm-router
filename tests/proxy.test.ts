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
