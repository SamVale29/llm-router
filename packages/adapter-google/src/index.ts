import {
  httpError,
  isHttpAdapterError,
  isPrivateOrReservedHost,
  normalizedErrorFromUnknown,
} from "@llm-router/core";
import type { NormalizedRoutingRequest, ProviderAdapter, RouterMessage } from "@llm-router/core";

export interface GoogleAdapterOptions {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  allowHosts?: string[];
}

export function createGoogleAdapter(options: GoogleAdapterOptions): ProviderAdapter {
  const endpoint = options.endpoint ?? "https://generativelanguage.googleapis.com/v1beta";
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    id: "google",
    validateModel(model) {
      if (!model.apiModelId) throw new Error(`Model ${model.id} has no apiModelId.`);
    },
    async execute(request, model, context) {
      const url = `${validateEndpoint(endpoint, options.allowHosts)}/models/${encodeURIComponent(model.apiModelId)}:generateContent`;
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { "x-goog-api-key": options.apiKey } : {}),
        },
        body: JSON.stringify(toPayload(request)),
        signal: context.signal,
      });
      rejectRedirect(response);
      if (!response.ok) throw await httpError(response, "Google");
      const body: unknown = await response.json();
      const text = getPath(body, ["candidates", 0, "content", "parts", 0, "text"]);
      const usage = getPath(body, ["usageMetadata"]);
      return {
        data: body,
        ...(typeof text === "string" ? { text } : {}),
        ...(usage && typeof usage === "object" ? { usage: normalizeUsage(usage) } : {}),
        raw: { provider: model.providerId },
      };
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

function rejectRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400)
    throw new Error("Provider endpoint redirect rejected.");
}

function toPayload(request: NormalizedRoutingRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map(contentText)
    .join("\n");
  const contents = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts:
        typeof message.content === "string"
          ? [{ text: message.content }]
          : message.content.map((part) =>
              part.type === "text"
                ? { text: part.text }
                : part.source.type === "url"
                  ? { fileData: { fileUri: part.source.value, mimeType: part.source.mediaType } }
                  : {
                      inlineData: {
                        data: part.source.value,
                        mimeType: part.source.mediaType ?? "application/octet-stream",
                      },
                    },
            ),
    }));
  return {
    ...(request.providerOptions?.google ?? {}),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(request.output.maxTokens !== undefined || request.output.schema !== undefined
      ? {
          generationConfig: {
            ...(request.output.maxTokens !== undefined
              ? { maxOutputTokens: request.output.maxTokens }
              : {}),
            ...(request.output.schema
              ? { responseMimeType: "application/json", responseSchema: request.output.schema }
              : {}),
          },
        }
      : {}),
    ...(request.tools?.length
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            },
          ],
        }
      : {}),
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
function normalizeUsage(value: object): { inputTokens?: number; outputTokens?: number } {
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.promptTokenCount === "number"
      ? { inputTokens: record.promptTokenCount }
      : {}),
    ...(typeof record.candidatesTokenCount === "number"
      ? { outputTokens: record.candidatesTokenCount }
      : {}),
  };
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
