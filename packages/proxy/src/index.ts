import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { sanitizeMessage, normalizeRequest } from "@llm-router/core";
import type {
  Catalog,
  Router,
  RoutingRequest,
  RouterEvent,
  ExecutionResult,
} from "@llm-router/core";

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
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !options.authToken)
    throw new Error("External proxy binding requires authToken.");
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
        sendJson(
          response,
          200,
          await options.router.decide(toRoutingRequest(body, requestId, path)),
        );
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
    const routingRequest = toRoutingRequest(body, requestId, path);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once("close", cancel);
    routingRequest.signal = controller.signal;
    try {
      const stream = record.stream === true;
      if (stream) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        try {
          const encode = createStreamEncoder(path, requestId);
          for await (const event of options.router.stream(routingRequest)) {
            if (response.destroyed) return;
            for (const output of encode(event)) {
              const prefix = path === "/v1/responses" ? `event: ${String(output.type)}\n` : "";
              if (!response.write(`${prefix}data: ${JSON.stringify(output)}\n\n`))
                await new Promise<void>((resolve) => {
                  const done = () => {
                    response.off("drain", done);
                    response.off("close", done);
                    resolve();
                  };
                  response.once("drain", done);
                  response.once("close", done);
                });
              if (response.destroyed) return;
            }
          }
          if (!response.destroyed) {
            if (path !== "/v1/responses") response.write("data: [DONE]\n\n");
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
    } finally {
      response.off("close", cancel);
      controller.abort();
    }
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

function toRoutingRequest(body: unknown, requestId: string, path: string): RoutingRequest {
  const record = asRecord(body);
  try {
    if (path.startsWith("/v1/router/")) {
      const request = { ...record, id: requestId } as unknown as RoutingRequest;
      for (const key of [
        "constraints",
        "hints",
        "input",
        "output",
        "metadata",
        "providerOptions",
      ]) {
        if (record[key] !== undefined) asRecord(record[key]);
      }
      validateRequestShape(request);
      normalizeRequest(request);
      return request;
    }
    const responses = path === "/v1/responses";
    for (const key of ["previous_response_id", "conversation", "background", "store"]) {
      if (record[key]) throw new Error(`${key} is not supported by this stateless proxy.`);
    }
    let messages: RoutingRequest["messages"];
    if (responses) {
      if (typeof record.input === "string") messages = [{ role: "user", content: record.input }];
      else if (Array.isArray(record.input))
        messages = record.input.map((value) => {
          const item = asRecord(value);
          if (item.type === "function_call_output")
            return {
              role: "tool" as const,
              toolCallId: String(item.call_id),
              content: String(item.output),
            };
          if (item.type === "function_call")
            return {
              role: "assistant" as const,
              content: "",
              toolCalls: [
                {
                  callId: String(item.call_id),
                  name: String(item.name),
                  arguments: String(item.arguments),
                },
              ],
            };
          return convertMessage(item, true);
        });
      else throw new Error("Responses input must be a string or array.");
      if (typeof record.instructions === "string")
        messages.unshift({ role: "system", content: record.instructions });
    } else {
      if (!Array.isArray(record.messages)) throw new Error("messages must be an array.");
      messages = record.messages.map((value) => convertMessage(asRecord(value), false));
    }
    const extension = record.router === undefined ? {} : asRecord(record.router);
    const metadata = { ...(extension.metadata === undefined ? {} : asRecord(extension.metadata)) };
    // Public metadata cannot impersonate a server-authenticated billing identity.
    delete metadata.userId;
    delete metadata.projectId;
    if (typeof record.model === "string") metadata.requestedModel = record.model;
    const request: RoutingRequest = {
      id: requestId,
      messages,
      metadata,
      constraints: extension.constraints as RoutingRequest["constraints"],
      hints: extension.hints as RoutingRequest["hints"],
      output: {
        maxTokens: (responses
          ? record.max_output_tokens
          : (record.max_completion_tokens ?? record.max_tokens)) as number | undefined,
      },
    };
    if (record.tools !== undefined) {
      if (!Array.isArray(record.tools)) throw new Error("tools must be an array.");
      request.tools = record.tools.map((value) => {
        const tool = asRecord(value);
        if (tool.type !== "function") throw new Error("Only function tools are supported.");
        const fn = responses ? tool : asRecord(tool.function);
        if (typeof fn.name !== "string" || !fn.name) throw new Error("Tool name is required.");
        return {
          name: fn.name,
          description: fn.description as string | undefined,
          parameters: asRecord(fn.parameters ?? {}),
          strict: fn.strict as boolean | undefined,
        };
      });
    }
    const format = responses
      ? record.text
        ? asRecord(record.text).format
        : undefined
      : record.response_format;
    if (format !== undefined) {
      const wrapper = asRecord(format);
      if (wrapper.type === "json_schema") {
        const config = responses ? wrapper : asRecord(wrapper.json_schema);
        request.output = {
          ...request.output,
          schema: config.schema,
          strict: config.strict as boolean | undefined,
        };
      } else if (wrapper.type !== "text")
        throw new Error("Only text and json_schema response formats are supported.");
    }
    const providerOptions: Record<string, unknown> = {};
    for (const key of [
      "temperature",
      "top_p",
      "seed",
      "stop",
      "presence_penalty",
      "frequency_penalty",
      "tool_choice",
      "parallel_tool_calls",
    ])
      if (record[key] !== undefined) providerOptions[key] = record[key];
    request.providerOptions = {
      compatible: providerOptions,
      anthropic: {
        ...(record.temperature !== undefined ? { temperature: record.temperature } : {}),
        ...(record.top_p !== undefined ? { top_p: record.top_p } : {}),
      },
      google: {
        generationConfig: {
          ...(record.temperature !== undefined ? { temperature: record.temperature } : {}),
          ...(record.top_p !== undefined ? { topP: record.top_p } : {}),
        },
      },
    };
    validateRequestShape(request);
    normalizeRequest(request);
    return request;
  } catch (error) {
    if (error instanceof ProxyRequestError) throw error;
    throw new ProxyRequestError(
      "invalid-request",
      400,
      error instanceof Error ? error.message : "Invalid routing request.",
    );
  }
}

function validateRequestShape(request: RoutingRequest): void {
  if (request.constraints !== undefined) {
    const constraints = asRecord(request.constraints);
    for (const key of [
      "allowedModels",
      "deniedModels",
      "allowedProviders",
      "deniedProviders",
      "requiredCapabilities",
    ]) {
      const value = constraints[key];
      if (
        value !== undefined &&
        (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
      )
        throw new Error(`${key} must be a string array.`);
    }
  }
  if (request.hints !== undefined) asRecord(request.hints);
  if (
    request.tools !== undefined &&
    (!Array.isArray(request.tools) ||
      request.tools.some((tool) => !tool || typeof tool.name !== "string" || !tool.parameters))
  )
    throw new Error("Invalid tool definition.");
}

function convertMessage(
  message: Record<string, unknown>,
  responses: boolean,
): RoutingRequest["messages"][number] {
  const content = message.content;
  let converted: RoutingRequest["messages"][number]["content"];
  if (typeof content === "string") converted = content;
  else if (content === null && Array.isArray(message.tool_calls)) converted = "";
  else if (Array.isArray(content))
    converted = content.map((value) => {
      const part = asRecord(value);
      if (
        part.type === "text" ||
        (responses && ["input_text", "output_text"].includes(String(part.type)))
      ) {
        if (typeof part.text !== "string") throw new Error("Text content must be a string.");
        return { type: "text" as const, text: part.text };
      }
      if (part.type === "image_url" || (responses && part.type === "input_image")) {
        const url = responses ? part.image_url : asRecord(part.image_url).url;
        if (typeof url !== "string") throw new Error("Image URL must be a string.");
        return { type: "image" as const, source: { type: "url" as const, value: url } };
      }
      if (part.type === "input_audio") {
        const audio = asRecord(part.input_audio);
        if (typeof audio.data !== "string" || !["wav", "mp3"].includes(String(audio.format)))
          throw new Error("Invalid input_audio.");
        return {
          type: "audio" as const,
          source: {
            type: "base64" as const,
            value: audio.data,
            mediaType: audio.format === "wav" ? "audio/wav" : "audio/mpeg",
          },
        };
      }
      throw new Error(`Unsupported content part: ${String(part.type)}.`);
    });
  else throw new Error("Message content must be a string or supported content array.");
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((value) => {
        const call = asRecord(value);
        const fn = asRecord(call.function);
        if (
          typeof call.id !== "string" ||
          typeof fn.name !== "string" ||
          typeof fn.arguments !== "string"
        )
          throw new Error("Invalid tool call.");
        return { callId: call.id, name: fn.name, arguments: fn.arguments };
      })
    : undefined;
  return {
    role: (message.role === "developer"
      ? "system"
      : message.role) as RoutingRequest["messages"][number]["role"],
    content: converted,
    toolCalls,
    toolCallId: message.tool_call_id as string | undefined,
    name: message.name as string | undefined,
  };
}

function toOpenAIResponse(result: ExecutionResult, path: string): Record<string, unknown> {
  const text =
    result.text ??
    (typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? {}));
  const tools = result.toolCalls ?? [];
  const input = result.usage?.inputTokens ?? 0;
  const output = result.usage?.outputTokens ?? 0;
  const id = `${path === "/v1/responses" ? "resp" : "chatcmpl"}_${result.decision.requestId}`;
  const model = result.execution.attempts.at(-1)?.modelId ?? result.decision.selected?.modelId;
  return path === "/v1/responses"
    ? {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model,
        output: [
          ...(text
            ? [
                {
                  id: `msg_${result.decision.requestId}`,
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text, annotations: [] }],
                },
              ]
            : []),
          ...tools.map((call) => ({
            type: "function_call",
            id: call.callId,
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments,
            status: "completed",
          })),
        ],
        usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
      }
    : {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text || null,
              ...(tools.length
                ? {
                    tool_calls: tools.map((call) => ({
                      id: call.callId,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: tools.length ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
      };
}

function createStreamEncoder(
  path: string,
  requestId: string,
): (event: RouterEvent) => Array<Record<string, unknown>> {
  const responses = path === "/v1/responses";
  const created = Math.floor(Date.now() / 1000);
  const id = `${responses ? "resp" : "chatcmpl"}_${requestId}`;
  let model: string | undefined;
  let sequence = 0;
  let toolIndex = 0;
  let textIndex: number | undefined;
  let text = "";
  const items: Array<Record<string, unknown>> = [];
  const numbered = (event: Record<string, unknown>) => ({ ...event, sequence_number: sequence++ });
  return (event) => {
    if (event.type === "attempt-start") {
      model = event.modelId;
      return [];
    }
    if (event.type === "decision") {
      model = event.decision.selected?.modelId;
      if (responses)
        return [
          numbered({
            type: "response.created",
            response: {
              id,
              object: "response",
              created_at: created,
              status: "in_progress",
              model,
              output: [],
            },
          }),
        ];
      return [];
    }
    const base = { id, object: "chat.completion.chunk", created, model };
    if (!responses) {
      if (event.type === "text-delta")
        return [
          {
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant", content: event.text }, finish_reason: null },
            ],
          },
        ];
      if (event.type === "tool-call")
        return [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex++,
                      id: event.callId,
                      type: "function",
                      function: { name: event.name, arguments: event.arguments },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
        ];
      if (event.type === "complete")
        return [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: event.result.toolCalls?.length ? "tool_calls" : "stop",
              },
            ],
            usage: toOpenAIResponse(event.result, path).usage,
          },
        ];
      if (event.type === "error") return [{ error: event.error }];
      return [];
    }
    if (event.type === "text-delta") {
      const result: Array<Record<string, unknown>> = [];
      const itemId = `msg_${requestId}`;
      if (textIndex === undefined) {
        textIndex = items.length;
        const item = {
          id: itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        };
        items.push(item);
        result.push(
          numbered({ type: "response.output_item.added", output_index: textIndex, item }),
        );
        result.push(
          numbered({
            type: "response.content_part.added",
            item_id: itemId,
            output_index: textIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }),
        );
      }
      text += event.text;
      result.push(
        numbered({
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: textIndex,
          content_index: 0,
          delta: event.text,
        }),
      );
      return result;
    }
    if (event.type === "tool-call") {
      const outputIndex = items.length;
      const item = {
        type: "function_call",
        id: event.callId,
        call_id: event.callId,
        name: event.name,
        arguments: event.arguments,
        status: "completed",
      };
      items.push(item);
      return [
        numbered({
          type: "response.output_item.added",
          output_index: outputIndex,
          item: { ...item, arguments: "", status: "in_progress" },
        }),
        numbered({
          type: "response.function_call_arguments.delta",
          item_id: event.callId,
          output_index: outputIndex,
          delta: event.arguments,
        }),
        numbered({
          type: "response.function_call_arguments.done",
          item_id: event.callId,
          output_index: outputIndex,
          arguments: event.arguments,
        }),
        numbered({ type: "response.output_item.done", output_index: outputIndex, item }),
      ];
    }
    if (event.type === "complete") {
      const result: Array<Record<string, unknown>> = [];
      if (textIndex !== undefined) {
        const itemId = `msg_${requestId}`;
        const part = { type: "output_text", text, annotations: [] };
        const item = { ...items[textIndex], status: "completed", content: [part] };
        items[textIndex] = item;
        result.push(
          numbered({
            type: "response.output_text.done",
            item_id: itemId,
            output_index: textIndex,
            content_index: 0,
            text,
          }),
        );
        result.push(
          numbered({
            type: "response.content_part.done",
            item_id: itemId,
            output_index: textIndex,
            content_index: 0,
            part,
          }),
        );
        result.push(numbered({ type: "response.output_item.done", output_index: textIndex, item }));
      }
      result.push(
        numbered({
          type: "response.completed",
          response: { ...toOpenAIResponse(event.result, path), output: items },
        }),
      );
      return result;
    }
    if (event.type === "error")
      return [numbered({ type: "error", code: event.error.code, message: event.error.message })];
    return [];
  };
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
