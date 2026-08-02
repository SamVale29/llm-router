import type { EstimatedCost, ModelDefinition } from "./types.js";

export function estimateRequestCost(input: {
  model: ModelDefinition;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cachedInputTokens?: number;
}): EstimatedCost {
  const pricing = input.model.pricing;
  if (!pricing)
    return {
      currency: "USD",
      inputCost: null,
      outputCost: null,
      cachedInputCost: null,
      total: null,
      unknownReason: "model has no pricing data",
    };
  const cachedTokens = Math.min(input.cachedInputTokens ?? 0, input.estimatedInputTokens);
  const regularTokens = input.estimatedInputTokens - cachedTokens;
  const inputCost =
    pricing.inputPerMillion == null ? null : (regularTokens / 1_000_000) * pricing.inputPerMillion;
  const cachedInputCost =
    cachedTokens === 0
      ? 0
      : pricing.cachedInputPerMillion == null
        ? null
        : (cachedTokens / 1_000_000) * pricing.cachedInputPerMillion;
  const outputCost =
    pricing.outputPerMillion == null
      ? null
      : (input.estimatedOutputTokens / 1_000_000) * pricing.outputPerMillion;
  const total =
    inputCost == null || outputCost == null || cachedInputCost == null
      ? null
      : inputCost + outputCost + cachedInputCost;
  return {
    currency: "USD",
    inputCost,
    outputCost,
    cachedInputCost,
    total,
    ...(total == null ? { unknownReason: "one or more token price fields are unknown" } : {}),
  };
}
