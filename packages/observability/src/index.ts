import type { RoutingDecision, RouterHooks } from "@llm-router/core";

export const OTEL_ATTRIBUTE_NAMESPACE = "llm_router";

export interface SpanLike {
  setAttribute(name: string, value: string | number | boolean): void;
  end(): void;
}

export interface TracerLike {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): SpanLike;
}

export function decisionAttributes(
  decision: RoutingDecision,
): Record<string, string | number | boolean> {
  return {
    "llm_router.decision.id": decision.decisionId,
    "llm_router.policy.version": decision.reproducibility.policyVersion,
    "llm_router.strategy.id": decision.strategy.id,
    "llm_router.task.type": decision.task.type,
    "llm_router.candidate.count": decision.candidates.length,
    "llm_router.fallback.count": decision.fallbackChain.length,
    "llm_router.estimated.cost": decision.estimates.cost ?? -1,
    "llm_router.routing.duration_ms": decision.timing.durationMs,
    ...(decision.selected
      ? {
          "llm_router.selected.provider": decision.selected.providerId,
          "llm_router.selected.model": decision.selected.modelId,
        }
      : {}),
  };
}

export function createTelemetryHooks(
  tracer: TracerLike,
  onError?: (error: unknown) => void,
): RouterHooks {
  return {
    afterSelect: async ({ decision }) => {
      if (!decision) return;
      const span = tracer.startSpan("llm_router.routing_decision", decisionAttributes(decision));
      try {
        span.end();
      } catch (error) {
        onError?.(error);
      }
    },
    onAttemptError: ({ decision }) => {
      if (decision)
        tracer
          .startSpan("llm_router.provider_attempt.error", {
            "llm_router.decision.id": decision.decisionId,
          })
          .end();
    },
  };
}

export function redactTelemetryAttributes(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const forbidden =
    /(prompt|response|content|image|audio|file|authorization|api[_-]?key|secret|token)/i;
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !forbidden.test(key)));
}
