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
  NormalizedRoutingRequest,
  ProviderAdapter,
  RouterMessage,
} from "@llm-router/core";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  endpoint?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  allowHosts?: string[];
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions): ProviderAdapter {
  const endpoint = validateEndpoint(
    options.endpoint ?? "https://api.anthropic.com/v1",
    options.allowHosts,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    id: "anthropic",
    validateModel(model) {
      if (!model.apiModelId) throw new Error(`Model ${model.id} has no apiModelId.`);
    },
    async execute(request, model, context) {
      const response = await fetchImpl(`${endpoint}/messages`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "anthropic-version": options.version ?? "2023-06-01",
          ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
        },
        body: JSON.stringify(toPayload(request, model)),
        signal: context.signal,
      });
      rejectRedirect(response);
      if (!response.ok) throw await httpError(response, "Anthropic");
      return parseResponse(response, model);
    },
    async *stream(request, model, context): AsyncIterable<AdapterStreamEvent> {
      const response = await fetchImpl(`${endpoint}/messages`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "anthropic-version": options.version ?? "2023-06-01",
          ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
        },
        body: JSON.stringify({ ...toPayload(request, model), stream: true }),
        signal: context.signal,
      });
      rejectRedirect(response);
      if (!response.ok) throw await httpError(response, "Anthropic");
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
            const data = parseSseData(line);
            if (data === undefined) continue;
            const parsed = parseSseJson(data);
            const delta = getPath(parsed, ["delta", "text"]);
            if (typeof delta === "string") yield { type: "text-delta", text: delta };
          }
        }
        const data = parseSseData(buffer);
        if (data !== undefined) {
          const parsed = parseSseJson(data);
          const delta = getPath(parsed, ["delta", "text"]);
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
          retryable: ["rate-limit", "timeout", "unavailable", "connection"].includes(error.code),
          fallbackEligible: ["rate-limit", "timeout", "unavailable"].includes(error.code),
        });
      return normalizedErrorFromUnknown(error);
    },
  };
}

function toPayload(
  request: NormalizedRoutingRequest,
  model: ModelDefinition,
): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message))
    .join("\n");
  const messages = mergeMessages(
    request.messages.filter((message) => message.role !== "system").flatMap(toMessages),
  );
  return {
    ...(request.providerOptions?.anthropic ?? {}),
    model: model.apiModelId,
    max_tokens: request.output.maxTokens ?? 512,
    ...(system ? { system } : {}),
    messages,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
    ...(request.output.schema
      ? {
          output_config: {
            format: { type: "json_schema", schema: request.output.schema },
          },
        }
      : {}),
  };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

function toMessages(message: RouterMessage): AnthropicMessage[] {
  if (message.role === "tool")
    return [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "unknown-tool-call",
            content: contentText(message),
          },
        ],
      },
    ];
  return [
    {
      role: message.role === "assistant" ? "assistant" : "user",
      content:
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map((part) =>
              part.type === "text"
                ? { type: "text", text: part.text }
                : {
                    type: part.type === "image" ? "image" : "document",
                    source:
                      part.source.type === "url"
                        ? { type: "url", url: part.source.value }
                        : {
                            type: "base64",
                            media_type: part.source.mediaType ?? "application/octet-stream",
                            data: part.source.value,
                          },
                  },
            ),
    },
  ];
}

function mergeMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) previous.content.push(...message.content);
    else merged.push({ role: message.role, content: [...message.content] });
  }
  return merged;
}

function contentText(message: RouterMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ");
}
async function parseResponse(response: Response, model: ModelDefinition): Promise<AdapterResponse> {
  rejectRedirect(response);
  const body: unknown = await response.json();
  const content = getPath(body, ["content", 0, "text"]);
  const usage = getPath(body, ["usage"]);
  return {
    data: body,
    ...(typeof content === "string" ? { text: content } : {}),
    ...(usage && typeof usage === "object" ? { usage: normalizeUsage(usage) } : {}),
    raw: { provider: model.providerId },
  };
}

function rejectRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400)
    throw new Error("Provider endpoint redirect rejected.");
}
function normalizeUsage(value: object): { inputTokens?: number; outputTokens?: number } {
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.input_tokens === "number" ? { inputTokens: record.input_tokens } : {}),
    ...(typeof record.output_tokens === "number" ? { outputTokens: record.output_tokens } : {}),
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
function validateEndpoint(endpoint: string, allowHosts?: string[]): string {
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
function getPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
