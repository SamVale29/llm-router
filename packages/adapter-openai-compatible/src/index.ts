import { normalizedErrorFromUnknown, sanitizeMessage } from "@llm-router/core";
import type {
  AdapterResponse,
  AdapterStreamEvent,
  ExecutionContext,
  ModelDefinition,
  NormalizedRoutingRequest,
  ProviderAdapter,
  RouterMessage,
} from "@llm-router/core";

export interface OpenAICompatibleAdapterOptions {
  endpoint: string;
  apiKey?: string;
  headers?: Record<string, string>;
  allowHosts?: string[];
  fetchImpl?: typeof fetch;
  id?: string;
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleAdapterOptions,
): ProviderAdapter {
  const endpoint = validateEndpoint(options.endpoint, options.allowHosts);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    id: options.id ?? "openai-compatible",
    validateModel(model) {
      if (!model.apiModelId) throw new Error(`Model ${model.id} has no apiModelId.`);
    },
    async execute(request, model, context) {
      const response = await fetchImpl(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...(options.headers ?? {}),
        },
        body: JSON.stringify(toChatPayload(request, model, context)),
        signal: context.signal,
      });
      return parseResponse(response, model);
    },
    async *stream(request, model, context): AsyncIterable<AdapterStreamEvent> {
      const response = await fetchImpl(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...(options.headers ?? {}),
        },
        body: JSON.stringify({ ...toChatPayload(request, model, context), stream: true }),
        signal: context.signal,
      });
      if (!response.ok) throw await httpError(response);
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const payload = line.trim().replace(/^data:\s*/, "");
          if (!payload || payload === "[DONE]") continue;
          const parsed: unknown = JSON.parse(payload);
          const delta = getPath(parsed, ["choices", 0, "delta", "content"]);
          if (typeof delta === "string") yield { type: "text-delta", text: delta };
          const usage = getPath(parsed, ["usage"]);
          if (usage && typeof usage === "object")
            yield { type: "usage", usage: normalizeUsage(usage) };
        }
      }
    },
    normalizeError(error) {
      if (isHttpError(error))
        return normalizedErrorFromUnknown(error, {
          code: error.code,
          statusCode: error.statusCode,
          retryAfterMs: error.retryAfterMs,
          providerId: undefined,
          retryable: ["rate-limit", "timeout", "unavailable", "connection"].includes(error.code),
          fallbackEligible: ["rate-limit", "timeout", "unavailable"].includes(error.code),
        });
      return normalizedErrorFromUnknown(error);
    },
  };
}

export function validateEndpoint(endpoint: string, allowHosts?: string[]): string {
  const url = new URL(endpoint);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Adapter endpoint must use HTTP or HTTPS.");
  if (allowHosts && !allowHosts.includes(url.hostname))
    throw new Error(`Adapter endpoint host ${url.hostname} is not in the allowlist.`);
  return endpoint.replace(/\/$/, "");
}

function toChatPayload(
  request: NormalizedRoutingRequest,
  model: ModelDefinition,
  context: ExecutionContext,
): Record<string, unknown> {
  return {
    model: model.apiModelId,
    messages: request.messages.map(toMessage),
    ...(request.output?.maxTokens ? { max_tokens: request.output.maxTokens } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: tool.strict,
            },
          })),
        }
      : {}),
    ...(request.output?.schema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "router_output",
              strict: request.output.strict ?? true,
              schema: request.output.schema,
            },
          },
        }
      : {}),
    ...(request.hints?.latency === "realtime" ? { stream_options: { include_usage: true } } : {}),
    ...(request.providerOptions?.compatible ?? {}),
    request_id: context.requestId,
  };
}

function toMessage(message: RouterMessage): Record<string, unknown> {
  return {
    role: message.role,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : {
                  type: part.type === "image" ? "image_url" : part.type,
                  [part.type === "image" ? "image_url" : "source"]:
                    part.source.type === "url" ? { url: part.source.value } : part.source.value,
                },
          ),
  };
}

async function parseResponse(response: Response, model: ModelDefinition): Promise<AdapterResponse> {
  if (!response.ok) throw await httpError(response);
  const body: unknown = await response.json();
  const text = getPath(body, ["choices", 0, "message", "content"]);
  const message = getPath(body, ["choices", 0, "message"]);
  const usage = getPath(body, ["usage"]);
  return {
    data: message ?? body,
    ...(typeof text === "string" ? { text } : {}),
    ...(usage && typeof usage === "object" ? { usage: normalizeUsage(usage) } : {}),
    raw: { provider: model.providerId, hasContent: typeof text === "string" },
  };
}

function normalizeUsage(value: object): {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cost?: number;
} {
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.prompt_tokens === "number" ? { inputTokens: record.prompt_tokens } : {}),
    ...(typeof record.completion_tokens === "number"
      ? { outputTokens: record.completion_tokens }
      : {}),
    ...(typeof record.total_cost === "number" ? { cost: record.total_cost } : {}),
  };
}

class HttpAdapterError extends Error {
  readonly code:
    | "authentication"
    | "permission"
    | "rate-limit"
    | "quota"
    | "timeout"
    | "unavailable"
    | "invalid-request"
    | "context-length"
    | "content-filter"
    | "connection"
    | "unknown";
  readonly statusCode: number;
  readonly retryAfterMs?: number;
  constructor(
    code: HttpAdapterError["code"],
    statusCode: number,
    message: string,
    retryAfterMs?: number,
  ) {
    super(sanitizeMessage(message));
    this.name = "HttpAdapterError";
    this.code = code;
    this.statusCode = statusCode;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

async function httpError(response: Response): Promise<HttpAdapterError> {
  let message = `Provider returned HTTP ${response.status}.`;
  try {
    const body: unknown = await response.json();
    const candidate = getPath(body, ["error", "message"]);
    if (typeof candidate === "string") message = candidate;
  } catch {
    /* body may not be JSON */
  }
  const code =
    response.status === 401
      ? "authentication"
      : response.status === 403
        ? "permission"
        : response.status === 429
          ? "rate-limit"
          : response.status === 408
            ? "timeout"
            : response.status === 400
              ? "invalid-request"
              : response.status >= 500
                ? "unavailable"
                : "unknown";
  const retryAfter = response.headers.get("retry-after");
  return new HttpAdapterError(
    code,
    response.status,
    message,
    retryAfter ? Number(retryAfter) * 1_000 : undefined,
  );
}

function isHttpError(error: unknown): error is HttpAdapterError {
  return error instanceof HttpAdapterError;
}
function getPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
