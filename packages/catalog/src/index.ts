import type { Catalog, ModelDefinition, ProviderDefinition } from "@llm-router/core";

const source = {
  url: "https://github.com/SamVale29/llm-router/blob/main/packages/catalog/src/index.ts",
  checkedAt: "2026-08-02",
};

export const demoProviders: ProviderDefinition[] = [
  {
    id: "demo-openai",
    name: "Demo OpenAI-compatible",
    adapter: "openai-compatible",
    capabilities: { streaming: true, usageReporting: true, requestCancellation: true },
    regions: ["us", "eu"],
    tags: ["demo", "general"],
  },
  {
    id: "demo-anthropic",
    name: "Demo Anthropic",
    adapter: "anthropic",
    capabilities: { streaming: true, usageReporting: true, requestCancellation: true },
    regions: ["us", "eu"],
    tags: ["demo", "reasoning"],
  },
  {
    id: "demo-google",
    name: "Demo Google Gemini",
    adapter: "google",
    capabilities: { streaming: true, usageReporting: true, requestCancellation: true },
    regions: ["us", "eu"],
    tags: ["demo", "multimodal"],
  },
  {
    id: "demo-openrouter",
    name: "Demo OpenRouter",
    adapter: "openrouter",
    capabilities: { streaming: true, usageReporting: true, requestCancellation: true },
    regions: ["us", "eu"],
    tags: ["demo", "multi-provider"],
  },
  {
    id: "demo-compatible",
    name: "Demo generic endpoint",
    adapter: "openai-compatible",
    capabilities: { streaming: true, usageReporting: true, requestCancellation: true },
    regions: ["us", "eu"],
    tags: ["demo", "self-hosted"],
  },
];

const demoPricing = (input: number, output: number) => ({
  currency: "USD" as const,
  inputPerMillion: input,
  outputPerMillion: output,
  cachedInputPerMillion: input / 2,
});

export const demoModels: ModelDefinition[] = [
  {
    id: "demo-code-pro",
    providerId: "demo-openai",
    apiModelId: "demo-code-pro",
    displayName: "Demo Code Pro",
    status: "active",
    modalities: { input: ["text", "image", "file"], output: ["text"] },
    capabilities: {
      functionCalling: true,
      structuredOutputs: true,
      reasoning: true,
      promptCaching: true,
      fineTuning: "unknown",
      realtime: false,
      parallelToolCalls: true,
      jsonMode: true,
    },
    limits: { contextTokens: 128_000, outputTokens: 16_000 },
    pricing: demoPricing(2, 8),
    operational: { enabled: true, priority: 90 },
    tags: ["demo", "code", "tools", "quality"],
    regions: ["us", "eu"],
    metadata: {
      demo: true,
      sourceNote: "Illustrative values for the public playground; not provider pricing.",
      qualityByTask: { "code-review": 0.93, "structured-extraction": 0.9, reasoning: 0.94 },
      observedLatencyMs: 850,
      observedP95LatencyMs: 1_400,
      reliability: 0.985,
      zeroDataRetention: false,
    },
    source,
  },
  {
    id: "demo-economy",
    providerId: "demo-openrouter",
    apiModelId: "demo-economy",
    displayName: "Demo Economy",
    status: "active",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      functionCalling: true,
      structuredOutputs: true,
      reasoning: false,
      promptCaching: false,
      fineTuning: "unknown",
      realtime: false,
      parallelToolCalls: false,
      jsonMode: true,
    },
    limits: { contextTokens: 32_000, outputTokens: 8_000 },
    pricing: demoPricing(0.15, 0.6),
    operational: { enabled: true, priority: 70 },
    tags: ["demo", "translation", "low-cost", "economy"],
    regions: ["us", "eu"],
    metadata: {
      demo: true,
      sourceNote: "Illustrative values for the public playground; not provider pricing.",
      qualityByTask: { translation: 0.86, chat: 0.76, summarization: 0.75 },
      observedLatencyMs: 320,
      observedP95LatencyMs: 600,
      reliability: 0.97,
      zeroDataRetention: false,
    },
    source,
  },
  {
    id: "demo-vision",
    providerId: "demo-google",
    apiModelId: "demo-vision",
    displayName: "Demo Vision",
    status: "active",
    modalities: { input: ["text", "image", "audio", "video", "file"], output: ["text"] },
    capabilities: {
      functionCalling: true,
      structuredOutputs: true,
      reasoning: true,
      promptCaching: true,
      fineTuning: "unknown",
      realtime: "unknown",
      parallelToolCalls: true,
      jsonMode: true,
    },
    limits: { contextTokens: 1_000_000, outputTokens: 8_000 },
    pricing: demoPricing(0.8, 3),
    operational: { enabled: true, priority: 80 },
    tags: ["demo", "vision", "ocr", "multimodal"],
    regions: ["us", "eu"],
    metadata: {
      demo: true,
      sourceNote: "Illustrative values for the public playground; not provider pricing.",
      qualityByTask: { ocr: 0.92, "vision-analysis": 0.93, "long-document-summarization": 0.86 },
      observedLatencyMs: 700,
      observedP95LatencyMs: 1_200,
      reliability: 0.975,
      zeroDataRetention: false,
    },
    source,
  },
  {
    id: "demo-long-context",
    providerId: "demo-anthropic",
    apiModelId: "demo-long-context",
    displayName: "Demo Long Context",
    status: "active",
    modalities: { input: ["text", "image", "file"], output: ["text"] },
    capabilities: {
      functionCalling: true,
      structuredOutputs: true,
      reasoning: true,
      promptCaching: true,
      fineTuning: "unknown",
      realtime: false,
      parallelToolCalls: true,
      jsonMode: true,
    },
    limits: { contextTokens: 200_000, outputTokens: 12_000 },
    pricing: demoPricing(3, 12),
    operational: { enabled: true, priority: 85 },
    tags: ["demo", "long-context", "reasoning", "quality"],
    regions: ["us", "eu"],
    metadata: {
      demo: true,
      sourceNote: "Illustrative values for the public playground; not provider pricing.",
      qualityByTask: {
        "long-document-summarization": 0.94,
        reasoning: 0.95,
        "structured-extraction": 0.9,
      },
      observedLatencyMs: 1_100,
      observedP95LatencyMs: 2_000,
      reliability: 0.98,
      zeroDataRetention: false,
    },
    source,
  },
  {
    id: "demo-private",
    providerId: "demo-compatible",
    apiModelId: "demo-private",
    displayName: "Demo Private Endpoint",
    status: "active",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      functionCalling: true,
      structuredOutputs: true,
      reasoning: "unknown",
      promptCaching: "unknown",
      fineTuning: "unknown",
      realtime: false,
      parallelToolCalls: "unknown",
      jsonMode: true,
    },
    limits: { contextTokens: 64_000, outputTokens: 8_000 },
    pricing: {
      currency: "USD",
      inputPerMillion: 1,
      outputPerMillion: 4,
      cachedInputPerMillion: 0.5,
    },
    operational: { enabled: true, priority: 75 },
    tags: ["demo", "private", "eu-only"],
    regions: ["eu"],
    metadata: {
      demo: true,
      sourceNote: "Illustrative private endpoint for privacy policy examples; not a real endpoint.",
      qualityByTask: { chat: 0.78, "structured-extraction": 0.82 },
      observedLatencyMs: 500,
      observedP95LatencyMs: 900,
      reliability: 0.96,
      zeroDataRetention: true,
    },
    source,
  },
];

export const demoCatalog: Catalog = {
  version: "2026.08.02-demo",
  providers: demoProviders,
  models: demoModels,
  generatedAt: "2026-08-02T00:00:00.000Z",
};

export function validateCatalog(catalog: Catalog): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const providerIds = new Set(catalog.providers.map((provider) => provider.id));
  const modelIds = new Set<string>();
  for (const [index, model] of catalog.models.entries()) {
    if (modelIds.has(model.id))
      issues.push({ path: `models.${index}.id`, message: `Duplicate model id ${model.id}.` });
    modelIds.add(model.id);
    if (!providerIds.has(model.providerId))
      issues.push({
        path: `models.${index}.providerId`,
        message: `Unknown provider ${model.providerId}.`,
      });
    if (model.pricing && !model.source)
      issues.push({
        path: `models.${index}.source`,
        message: "Pricing data must include a source and checkedAt date.",
      });
    if (
      model.pricing &&
      model.metadata?.demo !== true &&
      (!model.source?.checkedAt || !model.source.url)
    )
      issues.push({
        path: `models.${index}.source`,
        message: "Pricing data must include a source and checkedAt date.",
      });
  }
  return issues;
}

export function catalogJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "LLM Router catalog",
    type: "object",
    required: ["version", "providers", "models"],
    properties: {
      version: { type: "string" },
      providers: { type: "array" },
      models: { type: "array" },
    },
  };
}

export function catalogToJson(catalog: Catalog = demoCatalog): string {
  return JSON.stringify(catalog, null, 2);
}
