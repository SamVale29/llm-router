import {
  httpError,
  isHttpAdapterError,
  isPrivateOrReservedHost,
  normalizedErrorFromUnknown,
} from "@llm-router/core";
import type {
  AdapterResponse,
  AdapterStreamEvent,
  ExecutionContext,
  ModelDefinition,
  MessagePart,
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
        redirect: "manual",
        headers: {
          ...(options.headers ?? {}),
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(toChatPayload(request, model, context)),
        signal: context.signal,
      });
      return parseResponse(response, model);
    },
    async *stream(request, model, context): AsyncIterable<AdapterStreamEvent> {
      const response = await fetchImpl(`${endpoint}/chat/completions`, {
        method: "POST",
        redirect: "manual",
        headers: {
          ...(options.headers ?? {}),
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...toChatPayload(request, model, context), stream: true }),
        signal: context.signal,
      });
      rejectRedirect(response);
      if (!response.ok) throw await httpError(response, model.providerId);
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const payload = parseSseData(line);
            if (payload === undefined || payload === "[DONE]") continue;
            const parsed = parseSseJson(payload);
            const delta = getPath(parsed, ["choices", 0, "delta", "content"]);
            if (typeof delta === "string") yield { type: "text-delta", text: delta };
            const usage = getPath(parsed, ["usage"]);
            if (usage && typeof usage === "object")
              yield { type: "usage", usage: normalizeUsage(usage) };
          }
        }
        const payload = parseSseData(buffer);
        if (payload !== undefined && payload !== "[DONE]") {
          const parsed = parseSseJson(payload);
          const delta = getPath(parsed, ["choices", 0, "delta", "content"]);
          if (typeof delta === "string") yield { type: "text-delta", text: delta };
        }
      } finally {
        reader.releaseLock();
      }
    },
    normalizeError(error) {
      if (isHttpAdapterError(error))
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
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname)))
    throw new Error("Adapter endpoint must use HTTPS; HTTP is allowed only for localhost.");
  if (allowHosts && !allowHosts.includes(url.hostname))
    throw new Error(`Adapter endpoint host ${url.hostname} is not in the allowlist.`);
  if (!allowHosts && !isLocalHost(url.hostname) && isPrivateOrReservedHost(url.hostname))
    throw new Error(
      "Adapter endpoint cannot target a private or reserved network host without allowHosts.",
    );
  return endpoint.replace(/\/$/, "");
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function toChatPayload(
  request: NormalizedRoutingRequest,
  model: ModelDefinition,
  context: ExecutionContext,
): Record<string, unknown> {
  return {
    ...(request.providerOptions?.compatible ?? {}),
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
    request_id: context.requestId,
  };
}

function toMessage(message: RouterMessage): Record<string, unknown> {
  return {
    role: message.role,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    content: typeof message.content === "string" ? message.content : message.content.map(toPart),
  };
}

function toPart(part: MessagePart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image")
    return {
      type: "image_url",
      image_url: {
        url:
          part.source.type === "url"
            ? part.source.value
            : `data:${part.source.mediaType ?? "application/octet-stream"};base64,${part.source.value}`,
      },
    };
  return {
    type: part.type,
    source:
      part.source.type === "url"
        ? { url: part.source.value }
        : {
            type: "base64",
            media_type: part.source.mediaType ?? "application/octet-stream",
            data: part.source.value,
          },
  };
}

async function parseResponse(response: Response, model: ModelDefinition): Promise<AdapterResponse> {
  rejectRedirect(response);
  if (!response.ok) throw await httpError(response, model.providerId);
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

function rejectRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400)
    throw new Error("Provider endpoint redirect rejected.");
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

function parseSseData(line: string): string | undefined {
  const trimmed = line.trimEnd();
  if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) return undefined;
  return trimmed.slice("data:".length).trimStart();
}

function parseSseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error("Provider returned malformed SSE data.");
  }
}

function getPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
