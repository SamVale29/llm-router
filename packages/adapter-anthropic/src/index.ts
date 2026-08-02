import { normalizedErrorFromUnknown, sanitizeMessage } from "@llm-router/core";
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
        headers: {
          "content-type": "application/json",
          "anthropic-version": options.version ?? "2023-06-01",
          ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
        },
        body: JSON.stringify(toPayload(request, model)),
        signal: context.signal,
      });
      if (!response.ok) throw await providerError(response);
      return parseResponse(response, model);
    },
    async *stream(request, model, context): AsyncIterable<AdapterStreamEvent> {
      const response = await fetchImpl(`${endpoint}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": options.version ?? "2023-06-01",
          ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
        },
        body: JSON.stringify({ ...toPayload(request, model), stream: true }),
        signal: context.signal,
      });
      if (!response.ok) throw await providerError(response);
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
          const data = line.trim().replace(/^data:\s*/, "");
          if (!data) continue;
          const parsed: unknown = JSON.parse(data);
          const delta = getPath(parsed, ["delta", "text"]);
          if (typeof delta === "string") yield { type: "text-delta", text: delta };
        }
      }
    },
    normalizeError(error) {
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
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content:
        typeof message.content === "string"
          ? message.content
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
    }));
  return {
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
    ...(request.providerOptions?.anthropic ?? {}),
  };
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
function normalizeUsage(value: object): { inputTokens?: number; outputTokens?: number } {
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.input_tokens === "number" ? { inputTokens: record.input_tokens } : {}),
    ...(typeof record.output_tokens === "number" ? { outputTokens: record.output_tokens } : {}),
  };
}
async function providerError(response: Response): Promise<Error> {
  let message = `Anthropic returned HTTP ${response.status}.`;
  try {
    const body: unknown = await response.json();
    const candidate = getPath(body, ["error", "message"]);
    if (typeof candidate === "string") message = candidate;
  } catch {
    /* ignore malformed error body */
  }
  return new Error(sanitizeMessage(message));
}
function validateEndpoint(endpoint: string, allowHosts?: string[]): string {
  const url = new URL(endpoint);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Adapter endpoint must use HTTP or HTTPS.");
  if (allowHosts && !allowHosts.includes(url.hostname))
    throw new Error(`Adapter endpoint host ${url.hostname} is not in the allowlist.`);
  return endpoint.replace(/\/$/, "");
}
function getPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
