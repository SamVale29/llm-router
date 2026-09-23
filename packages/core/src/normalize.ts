import type {
  Modality,
  NormalizedRoutingRequest,
  RoutingRequest,
  TokenEstimationOptions,
} from "./types.js";

let requestCounter = 0;
export const DEFAULT_NON_TEXT_PART_TOKENS = 256;

export function normalizeRequest(
  request: RoutingRequest,
  tokenEstimation?: TokenEstimationOptions,
): NormalizedRoutingRequest {
  if (!Array.isArray(request.messages) || !request.messages.length)
    throw new Error("A non-empty messages array is required.");
  for (const message of request.messages) {
    if (
      !message ||
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      (typeof message.content !== "string" && !Array.isArray(message.content))
    )
      throw new Error("Invalid routing message.");
  }
  const constraints = request.constraints ?? {};
  const numericFields = [
    "maxInputPricePerMillion",
    "maxOutputPricePerMillion",
    "maxEstimatedRequestCost",
    "maxMonthlyBudget",
    "maxExpectedLatencyMs",
    "minContextTokens",
    "minOutputTokens",
  ];
  const values = {
    ...constraints,
    estimatedTokens: request.input?.estimatedTokens,
    maxTokens: request.output?.maxTokens,
  } as Record<string, unknown>;
  for (const key of [...numericFields, "estimatedTokens", "maxTokens"]) {
    const value = values[key];
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (key === "maxTokens" && (!Number.isInteger(value) || value === 0)))
    )
      throw new Error(`Invalid numeric request field ${key}.`);
  }
  for (const key of [
    "fallbackAllowed",
    "zeroDataRetentionRequired",
    "remoteClassificationAllowed",
    "requireObservedLatency",
  ]) {
    const value = (constraints as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean")
      throw new Error(`${key} must be boolean.`);
  }
  for (const key of [
    "allowedProviders",
    "deniedProviders",
    "allowedModels",
    "deniedModels",
    "requiredCapabilities",
    "requiredInputModalities",
    "requiredRegions",
    "requiredTags",
    "forbiddenTags",
    "dataResidency",
  ]) {
    const value = (constraints as Record<string, unknown>)[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    )
      throw new Error(`${key} must be a string array.`);
  }
  for (const message of request.messages) {
    if (Array.isArray(message.content))
      for (const part of message.content) {
        if (!part || !["text", "image", "audio", "video", "file"].includes(part.type))
          throw new Error("Unsupported message part.");
        if (part.type === "text") {
          if (typeof part.text !== "string") throw new Error("Text part requires text.");
        } else if (
          !part.source ||
          !["url", "base64"].includes(part.source.type) ||
          typeof part.source.value !== "string"
        )
          throw new Error("Invalid media source.");
      }
    if (
      message.toolCalls !== undefined &&
      (!Array.isArray(message.toolCalls) ||
        message.toolCalls.some(
          (call) =>
            !call ||
            typeof call.callId !== "string" ||
            typeof call.name !== "string" ||
            typeof call.arguments !== "string",
        ))
    )
      throw new Error("Invalid tool calls.");
  }
  if (
    request.input?.modalities !== undefined &&
    (!Array.isArray(request.input.modalities) ||
      request.input.modalities.some(
        (value) => !["text", "image", "audio", "video", "file"].includes(value),
      ))
  )
    throw new Error("Invalid input modalities.");
  if (request.hints?.task !== undefined && typeof request.hints.task !== "string")
    throw new Error("Task must be a string.");
  const input = request.input ?? {};
  const output = request.output ?? {};
  const detectedModalities = inferModalities(request);
  const modalities = unique([...(input.modalities ?? []), ...detectedModalities]);
  const nonTextParts = countNonTextParts(request);
  const configuredNonTextPartTokens = resolveNonTextPartTokens(tokenEstimation?.nonTextPartTokens);
  const hasConfiguredEstimate =
    tokenEstimation?.nonTextPartTokens !== undefined &&
    isValidNonTextPartTokens(tokenEstimation.nonTextPartTokens);
  const estimatedInputTokens =
    input.estimatedTokens ?? estimateInputTokens(request, configuredNonTextPartTokens);
  return {
    ...request,
    id: request.id ?? `request-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`,
    input: { ...input, modalities },
    output,
    constraints: { ...(request.constraints ?? {}) },
    detectedModalities: modalities,
    estimatedInputTokens,
    inputTokenEstimate: {
      source:
        input.estimatedTokens !== undefined
          ? "explicit"
          : hasConfiguredEstimate
            ? "configured"
            : "default",
      nonTextParts,
      nonTextPartTokens: configuredNonTextPartTokens,
    },
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

export function estimateInputTokens(
  request: RoutingRequest,
  nonTextPartTokens = DEFAULT_NON_TEXT_PART_TOKENS,
): number {
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
  characters += JSON.stringify(request.tools ?? []).length;
  for (const message of request.messages)
    characters += JSON.stringify(message.toolCalls ?? []).length;
  return Math.max(
    1,
    Math.ceil(characters / 4) + nonTextParts * resolveNonTextPartTokens(nonTextPartTokens),
  );
}

export function countNonTextParts(request: RoutingRequest): number {
  let nonTextParts = 0;
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "text") nonTextParts += 1;
    }
  }
  return nonTextParts;
}

function resolveNonTextPartTokens(value: number | undefined): number {
  return isValidNonTextPartTokens(value) ? value : DEFAULT_NON_TEXT_PART_TOKENS;
}

function isValidNonTextPartTokens(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function unique(values: Modality[]): Modality[] {
  return Array.from(new Set(values));
}
