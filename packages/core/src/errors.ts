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

export class HttpAdapterError extends Error {
  readonly code: ProviderErrorCode;
  readonly statusCode: number;
  readonly retryAfterMs?: number;

  constructor(code: ProviderErrorCode, statusCode: number, message: string, retryAfterMs?: number) {
    super(sanitizeMessage(message));
    this.name = "HttpAdapterError";
    this.code = code;
    this.statusCode = statusCode;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export async function httpError(
  response: Response,
  providerName = "Provider",
): Promise<HttpAdapterError> {
  let message = `${providerName} returned HTTP ${response.status}.`;
  try {
    const body: unknown = await response.json();
    const candidate = getNestedValue(body, ["error", "message"]);
    if (typeof candidate === "string") message = candidate;
  } catch {
    /* The provider may return a non-JSON error body. */
  }
  const code =
    response.status === 401
      ? "authentication"
      : response.status === 403
        ? "permission"
        : response.status === 408
          ? "timeout"
          : response.status === 409
            ? "quota"
            : response.status === 429
              ? "rate-limit"
              : response.status === 400
                ? "invalid-request"
                : response.status >= 500
                  ? "unavailable"
                  : "unknown";
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter ? parseRetryAfterMs(retryAfter) : undefined;
  return new HttpAdapterError(code, response.status, message, retryAfterMs);
}

export function isHttpAdapterError(error: unknown): error is HttpAdapterError {
  return error instanceof HttpAdapterError;
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
    .replace(/(authorization)\s*[:=]\s*bearer\s+[a-z0-9._+\x2f=~-]+/gi, "$1: Bearer [REDACTED]")
    .replace(/bearer\s+[a-z0-9._+\x2f=~-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-ant-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/\bsk-proj-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/\bAIza[0-9a-z_-]{20,}\b/gi, "[REDACTED]")
    .replace(/\bxai-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(
      /(api[_-]?key|authorization|token|secret)\s*[:=]\s*(?!bearer\b)[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 500);
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseRetryAfterMs(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
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
