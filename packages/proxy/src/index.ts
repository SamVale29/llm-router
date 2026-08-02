import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Catalog, Router, RoutingRequest, RouterEvent } from "@llm-router/core";

export interface ProxyOptions {
  router: Router;
  catalog: Catalog;
  authToken?: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  allowedOrigins?: string[];
  rateLimitPerMinute?: number;
}

export interface ProxyHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export function createProxyServer(options: ProxyOptions): ProxyHandle {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const limit = options.rateLimitPerMinute ?? 120;
  const windows = new Map<string, { startedAt: number; count: number }>();
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
    response.setHeader("x-request-id", requestId);
    const origin = request.headers.origin;
    if (origin && (!options.allowedOrigins || !options.allowedOrigins.includes(origin)))
      response.setHeader("access-control-allow-origin", "null");
    else if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-headers", "content-type, authorization, x-request-id");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (options.authToken && request.headers.authorization !== `Bearer ${options.authToken}`) {
      sendJson(response, 401, {
        error: { code: "authentication", message: "Authentication required." },
      });
      return;
    }
    const address = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const current = windows.get(address);
    const windowState =
      !current || now - current.startedAt >= 60_000
        ? { startedAt: now, count: 1 }
        : { ...current, count: current.count + 1 };
    windows.set(address, windowState);
    if (windowState.count > limit) {
      sendJson(response, 429, {
        error: { code: "rate-limit", message: "Proxy rate limit exceeded." },
      });
      return;
    }
    try {
      const path = request.url?.split("?")[0] ?? "/";
      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, { status: "ok", requestId });
        return;
      }
      if (request.method === "GET" && path === "/ready") {
        sendJson(response, 200, { status: "ready", requestId });
        return;
      }
      if (request.method === "GET" && path === "/v1/router/models") {
        sendJson(response, 200, {
          object: "list",
          data: options.catalog.models.map((model) => ({
            id: model.id,
            object: "model",
            owned_by: model.providerId,
          })),
        });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 404, { error: { code: "not-found", message: "Endpoint not found." } });
        return;
      }
      const body = await readJson(request, maxBodyBytes);
      if (path === "/v1/router/decide" || path === "/v1/router/explain") {
        sendJson(response, 200, await options.router.decide(toRoutingRequest(body, requestId)));
        return;
      }
      if (path === "/v1/chat/completions" || path === "/v1/responses") {
        await handleCompletion(path, body, requestId, response);
        return;
      }
      sendJson(response, 404, { error: { code: "not-found", message: "Endpoint not found." } });
    } catch (error) {
      sendJson(response, 500, {
        error: {
          code: "proxy-error",
          message: error instanceof Error ? error.message : "Proxy request failed.",
          requestId,
        },
      });
    }
  };
  const handleCompletion = async (
    path: string,
    body: unknown,
    requestId: string,
    response: ServerResponse,
  ): Promise<void> => {
    const record = asRecord(body);
    const routingRequest = toRoutingRequest(body, requestId);
    const stream = record.stream === true;
    if (stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for await (const event of options.router.stream(routingRequest)) {
        response.write(`data: ${JSON.stringify(toOpenAIStreamEvent(event, path))}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    const result = await options.router.execute(routingRequest);
    sendJson(response, 200, toOpenAIResponse(result, path));
  };
  server.listen(port, host);
  return {
    server,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function toRoutingRequest(body: unknown, requestId: string): RoutingRequest {
  const record = asRecord(body);
  const messages = record.messages;
  if (!Array.isArray(messages) || messages.length === 0)
    throw new Error("Request must contain a non-empty messages array.");
  return {
    id: requestId,
    messages: messages as RoutingRequest["messages"],
    ...(record.tools && Array.isArray(record.tools)
      ? { tools: record.tools as RoutingRequest["tools"] }
      : {}),
    ...(record.model && typeof record.model === "string"
      ? { metadata: { requestedModel: record.model } }
      : {}),
    ...(record.max_tokens && typeof record.max_tokens === "number"
      ? { output: { maxTokens: record.max_tokens } }
      : {}),
    ...(record.router && typeof record.router === "object"
      ? { metadata: record.router as Record<string, unknown> }
      : {}),
  };
}

function toOpenAIResponse(
  result: {
    decision: unknown;
    response?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
  },
  path: string,
): Record<string, unknown> {
  const text =
    typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? {});
  return path === "/v1/responses"
    ? {
        id:
          result.decision && typeof result.decision === "object" && "requestId" in result.decision
            ? `resp_${String((result.decision as Record<string, unknown>).requestId)}`
            : randomUUID(),
        object: "response",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: result.usage,
      }
    : {
        id: randomUUID(),
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: result.usage?.inputTokens ?? 0,
          completion_tokens: result.usage?.outputTokens ?? 0,
        },
      };
}
function toOpenAIStreamEvent(event: RouterEvent, path: string): Record<string, unknown> {
  if (event.type === "text-delta")
    return path === "/v1/responses"
      ? { type: "response.output_text.delta", delta: event.text }
      : { object: "chat.completion.chunk", choices: [{ delta: { content: event.text } }] };
  if (event.type === "error") return { error: event.error };
  return { type: event.type };
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JSON object expected.");
  return value as Record<string, unknown>;
}
async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Payload too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
