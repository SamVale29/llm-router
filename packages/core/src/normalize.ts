import type { Modality, NormalizedRoutingRequest, RoutingRequest } from "./types.js";

let requestCounter = 0;

export function normalizeRequest(request: RoutingRequest): NormalizedRoutingRequest {
  const input = request.input ?? {};
  const output = request.output ?? {};
  const detectedModalities = inferModalities(request);
  const modalities = unique([...(input.modalities ?? []), ...detectedModalities]);
  const estimatedInputTokens = input.estimatedTokens ?? estimateInputTokens(request);
  return {
    ...request,
    id: request.id ?? `request-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`,
    input: { ...input, modalities },
    output,
    constraints: { ...(request.constraints ?? {}) },
    detectedModalities: modalities,
    estimatedInputTokens,
    messages: request.messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) => ({ ...part }))
        : message.content,
    })),
  };
}

export function inferModalities(request: RoutingRequest): Modality[] {
  const modalities: Modality[] = ["text"];
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "text" && !modalities.includes(part.type)) modalities.push(part.type);
    }
  }
  return modalities;
}

export function estimateInputTokens(request: RoutingRequest): number {
  let characters = 0;
  let nonTextParts = 0;
  for (const message of request.messages) {
    if (typeof message.content === "string") characters += message.content.length;
    else {
      for (const part of message.content) {
        if (part.type === "text") characters += part.text.length;
        else nonTextParts += 1;
      }
    }
  }
  return Math.max(1, Math.ceil(characters / 4) + nonTextParts * 256);
}

function unique(values: Modality[]): Modality[] {
  return Array.from(new Set(values));
}
