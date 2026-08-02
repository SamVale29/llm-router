import type { NormalizedProviderError, ProviderErrorCode } from "./types.js";

export class RouterError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.details = details;
  }
}

export class PolicyValidationError extends RouterError {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    super(
      "invalid-policy",
      `Policy validation failed with ${issues.length} issue(s): ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      { issues },
    );
    this.name = "PolicyValidationError";
    this.issues = issues;
  }
}

export class NoEligibleModelError extends RouterError {
  constructor(
    message = "No eligible model matched the request constraints.",
    details: Record<string, unknown> = {},
  ) {
    super("no-eligible-model", message, details);
    this.name = "NoEligibleModelError";
  }
}

export function normalizedErrorFromUnknown(
  error: unknown,
  fallback: Partial<NormalizedProviderError> = {},
): NormalizedProviderError {
  if (isNormalizedProviderError(error)) return error;
  const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
  const code = (fallback.code ?? inferErrorCode(message)) as ProviderErrorCode;
  const retryable =
    fallback.retryable ?? ["rate-limit", "timeout", "unavailable", "connection"].includes(code);
  return {
    code,
    message,
    retryable,
    fallbackEligible: fallback.fallbackEligible ?? retryable,
    ...(fallback.statusCode === undefined ? {} : { statusCode: fallback.statusCode }),
    ...(fallback.retryAfterMs === undefined ? {} : { retryAfterMs: fallback.retryAfterMs }),
    ...(fallback.providerId === undefined ? {} : { providerId: fallback.providerId }),
    ...(fallback.modelId === undefined ? {} : { modelId: fallback.modelId }),
  };
}

export function sanitizeMessage(message: string): string {
  return message
    .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

function isNormalizedProviderError(value: unknown): value is NormalizedProviderError {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean" &&
    typeof record.fallbackEligible === "boolean"
  );
}

function inferErrorCode(message: string): ProviderErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("api key"))
    return "authentication";
  if (lower.includes("403") || lower.includes("forbidden")) return "permission";
  if (lower.includes("429") || lower.includes("rate limit")) return "rate-limit";
  if (lower.includes("timeout") || lower.includes("deadline")) return "timeout";
  if (lower.includes("context") && lower.includes("length")) return "context-length";
  if (lower.includes("abort") || lower.includes("cancel")) return "cancelled";
  if (lower.includes("connect") || lower.includes("fetch")) return "connection";
  if (lower.includes("503") || lower.includes("unavailable")) return "unavailable";
  return "unknown";
}
