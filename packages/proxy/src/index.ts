import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { sanitizeMessage } from "@llm-router/core";
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
  exposeModels?: boolean;
  enableCompletions?: boolean;
  onError?: (error: Error) => void;
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
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.writableEnded && !response.destroyed) response.end();
        return;
      }
      sendJson(response, 500, {
        error: { code: "proxy-error", message: "Proxy request failed." },
      });
      reportError(options.onError, error);
    });
  });
  server.on("error", (error) => reportError(options.onError, error));
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
    response.setHeader("x-request-id", requestId);
    const origin = request.headers.origin;
    if (origin && options.allowedOrigins?.includes(origin))
      response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-headers", "content-type, authorization, x-request-id");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (options.authToken && !hasValidAuthToken(request.headers.authorization, options.authToken)) {
      sendJson(response, 401, {
        error: { code: "authentication", message: "Authentication required." },
      });
      return;
    }
    const address = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    for (const [key, state] of windows) if (now - state.startedAt >= 60_000) windows.delete(key);
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
      if (
        request.method === "GET" &&
        path === "/v1/router/models" &&
        options.exposeModels === true
      ) {
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
        if (options.enableCompletions === false) {
          sendJson(response, 501, {
            error: {
              code: "not-configured",
              message: "Completion endpoints require a configured provider adapter.",
              requestId,
            },
          });
          return;
        }
        await handleCompletion(path, body, requestId, response);
        return;
      }
      sendJson(response, 404, { error: { code: "not-found", message: "Endpoint not found." } });
    } catch (error) {
      const proxyError = error instanceof ProxyRequestError ? error : undefined;
      sendJson(response, proxyError?.statusCode ?? 500, {
        error: {
          code: proxyError?.code ?? "proxy-error",
          message: sanitizeMessage(
            proxyError?.publicMessage ??
              (error instanceof Error ? error.message : "Proxy request failed."),
          ),
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
      try {
        for await (const event of options.router.stream(routingRequest)) {
          if (response.destroyed) return;
          response.write(`data: ${JSON.stringify(toOpenAIStreamEvent(event, path))}\n\n`);
        }
        if (!response.destroyed) {
          response.write("data: [DONE]\n\n");
          response.end();
        }
      } catch (error) {
        if (response.destroyed || response.writableEnded) return;
        response.write(
          `data: ${JSON.stringify({
            error: {
              code: "proxy-error",
              message: sanitizeMessage(
                error instanceof Error ? error.message : "Streaming request failed.",
              ),
              requestId,
            },
          })}\n\n`,
        );
        response.end();
      }
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
  const metadata: Record<string, unknown> = {};
  if (record.model && typeof record.model === "string") metadata.requestedModel = record.model;
  if (record.router && typeof record.router === "object" && !Array.isArray(record.router))
    for (const [key, value] of Object.entries(record.router))
      if (key !== "userId" && key !== "projectId") metadata[key] = value;
  return {
    id: requestId,
    messages: messages as RoutingRequest["messages"],
    ...(record.tools && Array.isArray(record.tools)
      ? { tools: record.tools as RoutingRequest["tools"] }
      : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(typeof record.max_tokens === "number" ? { output: { maxTokens: record.max_tokens } } : {}),
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
    throw new ProxyRequestError("invalid-request", 400, "JSON object expected.");
  return value as Record<string, unknown>;
}
async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes)
      throw new ProxyRequestError("payload-too-large", 413, "Payload too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ProxyRequestError("invalid-request", 400, "Invalid JSON payload.");
  }
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    if (!response.writableEnded && !response.destroyed) response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class ProxyRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ProxyRequestError";
  }
}

function reportError(onError: ProxyOptions["onError"], error: unknown): void {
  if (!onError) return;
  try {
    onError(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Error reporting must not become a second failure in the request handler.
  }
}

function hasValidAuthToken(value: string | undefined, token: string): boolean {
  const actual = Buffer.from(value ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
