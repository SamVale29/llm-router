import {
  httpError,
  isHttpAdapterError,
  isPrivateOrReservedHost,
  normalizedErrorFromUnknown,
} from "@llm-router/core";
import type {
  AdapterResponse,
  AdapterStreamEvent,
  ModelDefinition,
  MessagePart,
  NormalizedRoutingRequest,
  ProviderAdapter,
  RouterMessage,
  ToolCall,
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
        body: JSON.stringify(toChatPayload(request, model, options.id)),
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
        body: JSON.stringify({
          ...toChatPayload(request, model, options.id),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: context.signal,
      });
      rejectRedirect(response);
      if (!response.ok) throw await httpError(response, model.providerId);
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const calls = new Map<number, ToolCall>();
      const process = function* (line: string): Generator<AdapterStreamEvent> {
        const payload = parseSseData(line);
        if (payload === undefined || payload === "[DONE]") return;
        const parsed = parseSseJson(payload);
        if (getPath(parsed, ["error"])) throw new Error("Provider returned an SSE error.");
        const delta = getPath(parsed, ["choices", 0, "delta", "content"]);
        if (typeof delta === "string") yield { type: "text-delta", text: delta };
        const fragments = getPath(parsed, ["choices", 0, "delta", "tool_calls"]);
        if (Array.isArray(fragments))
          for (const fragment of fragments) {
            const index = Number(fragment.index ?? 0);
            const call = calls.get(index) ?? { callId: "", name: "", arguments: "" };
            call.callId += fragment.id ?? "";
            call.name += fragment.function?.name ?? "";
            call.arguments += fragment.function?.arguments ?? "";
            if (call.arguments.length > 8_000_000)
              throw new Error("Provider tool arguments exceed limit.");
            calls.set(index, call);
          }
        const usage = getPath(parsed, ["usage"]);
        if (usage && typeof usage === "object")
          yield { type: "usage", usage: normalizeUsage(usage) };
      };
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 8_000_000) throw new Error("Provider SSE frame exceeds limit.");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) yield* process(line);
        }
        yield* process(buffer + decoder.decode());
        for (const call of calls.values()) yield { type: "tool-call", ...call };
      } finally {
        await reader.cancel().catch(() => undefined);
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
  adapterId?: string,
): Record<string, unknown> {
  const namespace =
    adapterId === "openai" ? "openai" : adapterId === "openrouter" ? "openrouter" : "compatible";
  const providerOptions = {
    ...request.providerOptions?.compatible,
    ...request.providerOptions?.[namespace],
  };
  // Only provider extensions may pass through; routing and protocol fields remain owned here.
  for (const key of [
    "model",
    "messages",
    "tools",
    "max_tokens",
    "max_completion_tokens",
    "stream",
    "stream_options",
    "request_id",
    "response_format",
  ])
    delete providerOptions[key];
  return {
    ...providerOptions,
    stream: false,
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
    ...(request.output?.schema !== undefined
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
  };
}

function toMessage(message: RouterMessage): Record<string, unknown> {
  return {
    role: message.role,
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.callId,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
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
  if (part.type === "audio" && part.source.type === "base64") {
    const format =
      part.source.mediaType === "audio/wav"
        ? "wav"
        : part.source.mediaType === "audio/mpeg"
          ? "mp3"
          : undefined;
    if (format) return { type: "input_audio", input_audio: { data: part.source.value, format } };
  }
  if (part.type === "file" && part.source.type === "base64")
    return {
      type: "file",
      file: {
        filename: "document",
        file_data: `data:${part.source.mediaType ?? "application/octet-stream"};base64,${part.source.value}`,
      },
    };
  throw normalizedErrorFromUnknown(new Error(`Unsupported ${part.type} input representation.`), {
    code: "unsupported-capability",
    retryable: false,
    fallbackEligible: false,
  });
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
    toolCalls: normalizeToolCalls(getPath(message, ["tool_calls"])),
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
    ...(typeof getPath(record, ["prompt_tokens_details", "cached_tokens"]) === "number"
      ? { cachedInputTokens: getPath(record, ["prompt_tokens_details", "cached_tokens"]) as number }
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

function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((call) => ({
    callId: String(call.id),
    name: String(call.function?.name),
    arguments: String(call.function?.arguments ?? "{}"),
  }));
}
