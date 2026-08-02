import type {
  CapabilityName,
  CompatibilityResult,
  EliminationReason,
  ModelDefinition,
  NormalizedRoutingRequest,
  RoutingConstraints,
} from "./types.js";

export function checkCompatibility(
  request: NormalizedRoutingRequest,
  model: ModelDefinition,
  constraints: RoutingConstraints = request.constraints,
): CompatibilityResult {
  const reasons: EliminationReason[] = [];
  if (model.status === "disabled" || model.operational?.enabled === false)
    reasons.push({
      code: "MODEL_DISABLED",
      message: "The model is disabled in the catalog.",
      field: "status",
    });
  if (constraints.allowedProviders && !constraints.allowedProviders.includes(model.providerId))
    reasons.push({
      code: "PROVIDER_NOT_ALLOWED",
      message: `Provider ${model.providerId} is not in the allowed provider list.`,
      field: "allowedProviders",
    });
  if (constraints.deniedProviders?.includes(model.providerId))
    reasons.push({
      code: "PROVIDER_DENIED",
      message: `Provider ${model.providerId} is denied by policy.`,
      field: "deniedProviders",
    });
  if (constraints.allowedModels && !constraints.allowedModels.includes(model.id))
    reasons.push({
      code: "MODEL_NOT_ALLOWED",
      message: `Model ${model.id} is not in the allowed model list.`,
      field: "allowedModels",
    });
  if (constraints.deniedModels?.includes(model.id))
    reasons.push({
      code: "MODEL_DENIED",
      message: `Model ${model.id} is denied by policy.`,
      field: "deniedModels",
    });
  const requiredModalities = Array.from(
    new Set([
      ...(request.detectedModalities ?? []),
      ...(constraints.requiredInputModalities ?? []),
    ]),
  );
  for (const modality of requiredModalities) {
    if (!model.modalities.input.includes(modality))
      reasons.push({
        code: `MISSING_${modality.toUpperCase()}_INPUT`,
        message: `The request requires ${modality} input but the model does not advertise support.`,
        field: "modalities.input",
      });
  }
  if (request.output?.modality && !model.modalities.output.includes(request.output.modality))
    reasons.push({
      code: "MISSING_OUTPUT_MODALITY",
      message: `The model does not advertise ${request.output.modality} output.`,
      field: "modalities.output",
    });
  for (const capability of constraints.requiredCapabilities ?? []) {
    if (!hasCapability(model, capability))
      reasons.push({
        code: `MISSING_${capability.toUpperCase().replaceAll("-", "_")}`,
        message: `The model does not have confirmed ${capability} support.`,
        field: `capabilities.${capability}`,
      });
  }
  if (request.output?.schema && !hasCapability(model, "structured-outputs"))
    reasons.push({
      code: "MISSING_STRUCTURED_OUTPUTS",
      message: "A structured output schema requires confirmed structured output support.",
      field: "capabilities.structuredOutputs",
    });
  if (request.tools?.length && !hasCapability(model, "function-calling"))
    reasons.push({
      code: "MISSING_FUNCTION_CALLING",
      message:
        "The request contains tools but the model does not have confirmed function calling support.",
      field: "capabilities.functionCalling",
    });
  if (
    request.tools &&
    request.tools.length > 1 &&
    !hasCapability(model, "parallel-tool-calls") &&
    request.metadata?.parallelToolCalls === true
  )
    reasons.push({
      code: "MISSING_PARALLEL_TOOL_CALLS",
      message: "Parallel tool calls were requested but are not confirmed.",
      field: "capabilities.parallelToolCalls",
    });
  if (
    constraints.minContextTokens &&
    model.limits.contextTokens != null &&
    model.limits.contextTokens < constraints.minContextTokens
  )
    reasons.push({
      code: "CONTEXT_LIMIT_TOO_SMALL",
      message: `The model context limit ${model.limits.contextTokens} is below the required ${constraints.minContextTokens}.`,
      field: "limits.contextTokens",
    });
  if (constraints.minContextTokens && model.limits.contextTokens == null)
    reasons.push({
      code: "UNKNOWN_CONTEXT_LIMIT",
      message: "The model context limit is unknown and a minimum was required.",
      field: "limits.contextTokens",
    });
  if (
    request.estimatedInputTokens > 0 &&
    model.limits.contextTokens != null &&
    request.estimatedInputTokens > model.limits.contextTokens
  )
    reasons.push({
      code: "REQUEST_CONTEXT_TOO_LARGE",
      message: `The estimated request context exceeds the model limit of ${model.limits.contextTokens}.`,
      field: "limits.contextTokens",
    });
  if (
    request.output?.maxTokens &&
    model.limits.outputTokens != null &&
    request.output.maxTokens > model.limits.outputTokens
  )
    reasons.push({
      code: "OUTPUT_LIMIT_TOO_SMALL",
      message: `The requested output exceeds the model output limit of ${model.limits.outputTokens}.`,
      field: "limits.outputTokens",
    });
  if (
    constraints.minOutputTokens &&
    model.limits.outputTokens != null &&
    model.limits.outputTokens < constraints.minOutputTokens
  )
    reasons.push({
      code: "MIN_OUTPUT_LIMIT_NOT_MET",
      message: "The model maximum output is below the required minimum.",
      field: "limits.outputTokens",
    });
  if (priceLimitFails(model.pricing?.inputPerMillion, constraints.maxInputPricePerMillion))
    reasons.push({
      code: model.pricing?.inputPerMillion == null ? "INPUT_PRICE_UNKNOWN" : "INPUT_PRICE_TOO_HIGH",
      message:
        model.pricing?.inputPerMillion == null
          ? "The model input price is unknown under a hard price limit."
          : "The model input price exceeds the configured limit.",
      field: "pricing.inputPerMillion",
    });
  if (priceLimitFails(model.pricing?.outputPerMillion, constraints.maxOutputPricePerMillion))
    reasons.push({
      code:
        model.pricing?.outputPerMillion == null ? "OUTPUT_PRICE_UNKNOWN" : "OUTPUT_PRICE_TOO_HIGH",
      message:
        model.pricing?.outputPerMillion == null
          ? "The model output price is unknown under a hard price limit."
          : "The model output price exceeds the configured limit.",
      field: "pricing.outputPerMillion",
    });
  const regions = model.regions ?? [];
  if (constraints.requiredRegions?.some((region) => !regions.includes(region)))
    reasons.push({
      code: "REGION_UNAVAILABLE",
      message: "The model is not advertised in every required region.",
      field: "regions",
    });
  if (constraints.requiredTags?.some((tag) => !model.tags?.includes(tag)))
    reasons.push({
      code: "REQUIRED_TAG_MISSING",
      message: "The model is missing a required catalog tag.",
      field: "tags",
    });
  if (constraints.forbiddenTags?.some((tag) => model.tags?.includes(tag)))
    reasons.push({
      code: "FORBIDDEN_TAG_PRESENT",
      message: "The model has a forbidden catalog tag.",
      field: "tags",
    });
  if (
    constraints.dataResidency?.length &&
    constraints.dataResidency.some((region) => !regions.includes(region))
  )
    reasons.push({
      code: "DATA_RESIDENCY_UNAVAILABLE",
      message: "The model does not advertise the required data residency.",
      field: "regions",
    });
  if (constraints.zeroDataRetentionRequired && model.metadata?.zeroDataRetention !== true)
    reasons.push({
      code: "ZERO_RETENTION_UNCONFIRMED",
      message: "Zero data retention is not confirmed for this model.",
      field: "metadata.zeroDataRetention",
    });
  return { compatible: reasons.length === 0, reasons };
}

function hasCapability(model: ModelDefinition, capability: CapabilityName): boolean {
  const value = {
    "function-calling": model.capabilities.functionCalling,
    "structured-outputs": model.capabilities.structuredOutputs,
    reasoning: model.capabilities.reasoning,
    "prompt-caching": model.capabilities.promptCaching,
    realtime: model.capabilities.realtime,
    "parallel-tool-calls": model.capabilities.parallelToolCalls,
    "json-mode": model.capabilities.jsonMode,
    embeddings: model.capabilities.embeddings,
    "fine-tuning": model.capabilities.fineTuning,
  }[capability];
  return value === true;
}

function priceLimitFails(value: number | null | undefined, limit: number | undefined): boolean {
  return limit !== undefined && (value === undefined || value === null || value > limit);
}
