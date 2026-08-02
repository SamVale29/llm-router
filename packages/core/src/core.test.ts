import { describe, expect, it } from "vitest";
import {
  checkCompatibility,
  createInMemoryHealthStore,
  createRouter,
  definePolicy,
  estimateRequestCost,
  normalizedErrorFromUnknown,
  parsePolicyYaml,
  type ProviderAdapter,
  type RoutingPolicy,
} from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const defaultPolicy = definePolicy<RoutingPolicy>({
  version: "test-1",
  defaults: { strategy: { kind: "weighted-score" }, fallbackAllowed: true },
  routes: [
    {
      id: "code",
      when: { task: "code-review" },
      require: { capabilities: ["structured-outputs"] },
      prefer: { tags: ["code"] },
      select: {
        strategy: {
          kind: "weighted-score",
          weights: { taskFit: 0.35, quality: 0.25, cost: 0.15, latency: 0.15, reliability: 0.1 },
        },
      },
    },
    {
      id: "translation",
      when: { task: "translation" },
      select: { strategy: { kind: "cheapest-qualified" } },
    },
    {
      id: "ocr",
      when: { task: "ocr" },
      require: { inputModalities: ["image"] },
      select: { strategy: { kind: "cheapest-qualified" }, candidates: ["demo-vision"] },
    },
    { id: "default", when: {}, select: { strategy: { kind: "priority" } } },
  ],
});

describe("routing decisions", () => {
  it("filters capabilities before scoring and explains the selection", async () => {
    const router = createRouter({ catalog: demoCatalog, policy: defaultPolicy });
    const decision = await router.decide({
      messages: [{ role: "user", content: "Review this code and return issues." }],
      hints: { task: "code-review" },
      output: { schema: { type: "object", properties: { issues: { type: "array" } } } },
    });
    expect(decision.selected?.modelId).toBe("demo-code-pro");
    expect(
      decision.candidates.some((candidate) =>
        candidate.eliminatedBy.some((reason) => reason.code === "MISSING_STRUCTURED_OUTPUTS"),
      ),
    ).toBe(false);
    expect(decision.explanation.summary).toContain("Demo Code Pro");
    expect(decision.reproducibility.normalizedRequestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses cheapest-qualified for translation and hard cost ceilings", async () => {
    const router = createRouter({ catalog: demoCatalog, policy: defaultPolicy });
    const economy = await router.decide({
      messages: [{ role: "user", content: "Translate this paragraph." }],
      hints: { task: "translation" },
    });
    expect(economy.selected?.modelId).toBe("demo-economy");
    const blocked = await router.decide({
      messages: [{ role: "user", content: "Translate this paragraph." }],
      hints: { task: "translation" },
      constraints: { maxEstimatedRequestCost: 0.000001 },
    });
    expect(blocked.selected).toBeNull();
    expect(blocked.candidates.every((candidate) => !candidate.eligible)).toBe(true);
  });

  it("enforces multimodal requirements before selection", async () => {
    const router = createRouter({ catalog: demoCatalog, policy: defaultPolicy });
    const decision = await router.decide({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this invoice." },
            {
              type: "image",
              source: { type: "url", value: "https://example.invalid/invoice.png" },
            },
          ],
        },
      ],
      hints: { task: "ocr" },
    });
    expect(decision.selected?.modelId).toBe("demo-vision");
    expect(decision.candidates).toHaveLength(1);
  });

  it("treats unknown capability metadata as incompatible", () => {
    const model = demoCatalog.models.find((candidate) => candidate.id === "demo-private");
    if (!model) throw new Error("fixture missing");
    const request = {
      id: "test",
      messages: [{ role: "user" as const, content: "hello" }],
      input: { modalities: ["text" as const] },
      output: {},
      constraints: { requiredCapabilities: ["reasoning" as const] },
      detectedModalities: ["text" as const],
      estimatedInputTokens: 1,
    };
    const result = checkCompatibility(request, model);
    expect(result.compatible).toBe(false);
    expect(result.reasons[0]?.code).toBe("MISSING_REASONING");
  });

  it("estimates known and unknown prices without treating unknown as zero", () => {
    const model = demoCatalog.models[0];
    if (!model) throw new Error("fixture missing");
    expect(
      estimateRequestCost({ model, estimatedInputTokens: 1000, estimatedOutputTokens: 500 }).total,
    ).toBeGreaterThan(0);
    expect(
      estimateRequestCost({
        model: { ...model, pricing: undefined },
        estimatedInputTokens: 1000,
        estimatedOutputTokens: 500,
      }).total,
    ).toBeNull();
  });
});

describe("resilience", () => {
  it("retries/falls back using normalized provider errors", async () => {
    const policy: RoutingPolicy = {
      version: "resilience-test",
      models: [
        { id: "demo-code-pro", provider: "demo-openai", model: "demo-code-pro" },
        { id: "demo-economy", provider: "demo-openrouter", model: "demo-economy" },
      ],
      routes: [
        {
          id: "all",
          when: {},
          select: { strategy: { kind: "rules" }, candidates: ["demo-code-pro", "demo-economy"] },
        },
      ],
      fallbacks: [{ from: "demo-code-pro", to: ["demo-economy"], on: ["rate-limit"] }],
      resilience: {
        retry: { maxAttempts: 1, retryableErrors: ["rate-limit"] },
        fallback: { maxModelFallbacks: 1, errors: ["rate-limit"] },
      },
    };
    const fail: ProviderAdapter = {
      id: "openai-compatible",
      validateModel() {
        return;
      },
      async execute() {
        throw new Error("429 rate limit");
      },
      normalizeError(error) {
        return normalizedErrorFromUnknown(error);
      },
    };
    const success: ProviderAdapter = {
      id: "openrouter",
      validateModel() {
        return;
      },
      async execute() {
        return { data: { ok: true }, text: "fallback response" };
      },
      normalizeError(error) {
        return normalizedErrorFromUnknown(error);
      },
    };
    const router = createRouter({
      catalog: demoCatalog,
      policy,
      adapters: { "openai-compatible": fail, openrouter: success },
      healthStore: createInMemoryHealthStore({ failureThreshold: 5 }),
    });
    const result = await router.execute({ messages: [{ role: "user", content: "hello" }] });
    expect(result.response).toEqual({ ok: true });
    expect(
      result.execution.attempts.some(
        (attempt) => attempt.ok === false && attempt.error?.code === "rate-limit",
      ),
    ).toBe(true);
    expect(result.execution.attempts.at(-1)?.modelId).toBe("demo-economy");
  });
});

describe("policy validation", () => {
  it("parses YAML and rejects fallback cycles", () => {
    const parsed = parsePolicyYaml(
      "version: '1'\nroutes:\n  - id: all\n    when: {}\n    select:\n      strategy: rules\n",
      demoCatalog,
    );
    expect(parsed.routes[0]?.select.strategy?.kind).toBe("rules");
    expect(() =>
      parsePolicyYaml(
        "version: '1'\nmodels:\n  - {id: a, provider: demo-openai, model: a}\n  - {id: b, provider: demo-openai, model: b}\nroutes:\n  - {id: all, when: {}, select: {strategy: rules}}\nfallbacks:\n  - {from: a, to: [b], on: [timeout]}\n  - {from: b, to: [a], on: [timeout]}\n",
        demoCatalog,
      ),
    ).toThrow("Fallback cycle");
  });
});
