import { describe, expect, it } from "vitest";
import {
  checkCompatibility,
  createInMemoryHealthStore,
  createRouter,
  definePolicy,
  estimateRequestCost,
  normalizeRequest,
  normalizedErrorFromUnknown,
  parsePolicyYaml,
  policyJsonSchema,
  type ProviderAdapter,
  type RoutingPolicy,
} from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";
import { sha256 } from "./hash.js";

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

  it("warns for the default multimodal token heuristic and supports calibration", async () => {
    const request = {
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Read this image." },
            {
              type: "image" as const,
              source: { type: "url" as const, value: "https://example.invalid/image.png" },
            },
          ],
        },
      ],
      hints: { task: "ocr" as const },
    };
    const defaultNormalized = normalizeRequest(request);
    expect(defaultNormalized.inputTokenEstimate).toEqual({
      source: "default",
      nonTextParts: 1,
      nonTextPartTokens: 256,
    });
    const defaultDecision = await createRouter({
      catalog: demoCatalog,
      policy: defaultPolicy,
    }).decide(request);
    expect(
      defaultDecision.explanation.warnings.some((warning) =>
        warning.includes("default 256 tokens per non-text part"),
      ),
    ).toBe(true);

    const configuredNormalized = normalizeRequest(request, { nonTextPartTokens: 1024 });
    expect(configuredNormalized.inputTokenEstimate).toEqual({
      source: "configured",
      nonTextParts: 1,
      nonTextPartTokens: 1024,
    });
    expect(configuredNormalized.estimatedInputTokens).toBeGreaterThan(
      defaultNormalized.estimatedInputTokens,
    );
    const configuredDecision = await createRouter({
      catalog: demoCatalog,
      policy: defaultPolicy,
      tokenEstimation: { nonTextPartTokens: 1024 },
    }).decide(request);
    expect(
      configuredDecision.explanation.warnings.some((warning) =>
        warning.includes("default 256 tokens per non-text part"),
      ),
    ).toBe(false);
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

  it("applies configured weighted-score weights to candidate totals", async () => {
    const makePolicy = (
      weights: RoutingPolicy["routes"][number]["select"]["weights"],
    ): RoutingPolicy => ({
      version: "weights-test",
      routes: [
        {
          id: "all",
          when: {},
          select: { strategy: { kind: "weighted-score", weights } },
        },
      ],
    });
    const request = {
      messages: [{ role: "user" as const, content: "Review this code." }],
      hints: { task: "code-review" as const },
    };
    const costDecision = await createRouter({
      catalog: demoCatalog,
      policy: makePolicy({ taskFit: 0, quality: 0, cost: 1, latency: 0, reliability: 0 }),
    }).decide(request);
    const qualityDecision = await createRouter({
      catalog: demoCatalog,
      policy: makePolicy({ taskFit: 0, quality: 1, cost: 0, latency: 0, reliability: 0 }),
    }).decide(request);
    expect(costDecision.selected?.modelId).toBe("demo-economy");
    expect(qualityDecision.selected?.modelId).toBe("demo-code-pro");
    expect(costDecision.candidates.map((candidate) => candidate.scores.total)).not.toEqual(
      qualityDecision.candidates.map((candidate) => candidate.scores.total),
    );
  });

  it("generates unique request IDs when callers do not provide one", async () => {
    const router = createRouter({ catalog: demoCatalog, policy: defaultPolicy });
    const decisions = await Promise.all(
      Array.from({ length: 50 }, () =>
        router.decide({ messages: [{ role: "user", content: "hello" }] }),
      ),
    );
    expect(new Set(decisions.map((decision) => decision.requestId)).size).toBe(50);
  });

  it("enforces a monthly budget in the global scope when no user or project is supplied", async () => {
    const policy: RoutingPolicy = {
      version: "budget-test",
      models: [{ id: "demo-economy", provider: "demo-openrouter", model: "demo-economy" }],
      routes: [{ id: "all", when: {}, select: { strategy: { kind: "rules" } } }],
    };
    const adapter: ProviderAdapter = {
      id: "openrouter",
      validateModel() {
        return;
      },
      async execute() {
        return { data: { ok: true }, usage: { cost: 0.0003 } };
      },
      normalizeError(error) {
        return normalizedErrorFromUnknown(error);
      },
    };
    const router = createRouter({
      catalog: demoCatalog,
      policy,
      adapters: { openrouter: adapter },
    });
    const request = {
      messages: [{ role: "user" as const, content: "hello" }],
      constraints: { maxMonthlyBudget: 0.0005 },
    };
    await router.execute(request);
    const blocked = await router.decide(request);
    expect(blocked.selected).toBeNull();
    expect(
      blocked.candidates.some((candidate) =>
        candidate.eliminatedBy.some((reason) => reason.code === "MONTHLY_BUDGET_EXCEEDED"),
      ),
    ).toBe(true);
  });
});

describe("request hashing", () => {
  it("matches the standard SHA-256 vector for abc", async () => {
    await expect(sha256("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
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

  it("does not retry a deterministic response schema validation failure", async () => {
    let calls = 0;
    const policy: RoutingPolicy = {
      version: "schema-resilience-test",
      routes: [{ id: "all", when: {}, select: { strategy: { kind: "rules" } } }],
      resilience: { retry: { maxAttempts: 3 } },
    };
    const adapter: ProviderAdapter = {
      id: "openai-compatible",
      validateModel() {
        return;
      },
      async execute() {
        calls += 1;
        return { data: { invalid: true } };
      },
      normalizeError(error) {
        return normalizedErrorFromUnknown(error);
      },
    };
    const router = createRouter({
      catalog: demoCatalog,
      policy,
      adapters: { "openai-compatible": adapter },
    });
    await expect(
      router.execute({
        messages: [{ role: "user", content: "hello" }],
        output: { schema: { type: "object", required: ["ok"] } },
      }),
    ).rejects.toThrow("schema validation");
    expect(calls).toBe(1);
  });

  it("retries and falls back on a streaming provider failure before output", async () => {
    const policy: RoutingPolicy = {
      version: "stream-resilience-test",
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
      fallbacks: [{ from: "demo-code-pro", to: ["demo-economy"], on: ["unavailable"] }],
      resilience: {
        retry: { maxAttempts: 1, retryableErrors: ["unavailable"] },
        fallback: { maxModelFallbacks: 1, errors: ["unavailable"] },
      },
    };
    const fail: ProviderAdapter = {
      id: "openai-compatible",
      validateModel() {
        return;
      },
      async execute() {
        throw new Error("503 unavailable");
      },
      async *stream() {
        for (const event of [] as Array<never>) yield event;
        throw new Error("503 unavailable");
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
      async *stream() {
        yield { type: "text-delta", text: "fallback response" };
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
    const events = [];
    for await (const event of router.stream({
      messages: [{ role: "user", content: "hello" }],
    }))
      events.push(event);
    expect(events.some((event) => event.type === "fallback")).toBe(true);
    expect(
      events.some((event) => event.type === "text-delta" && event.text.includes("fallback")),
    ).toBe(true);
    const complete = events.find((event) => event.type === "complete");
    expect(complete?.type === "complete" ? complete.result.execution.attempts : []).toHaveLength(2);
  });
});

describe("policy validation", () => {
  it("keeps the generated policy schema aligned with optional route matchers", () => {
    const schema = policyJsonSchema();
    const routes = schema.properties as Record<string, unknown>;
    const routeItems = (routes.routes as { items: { required: string[] } }).items;
    expect(routeItems.required).toEqual(["id", "select"]);
  });

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
    expect(() =>
      parsePolicyYaml(
        "version: '1'\nroutes:\n  - id: all\n    when: {}\n    select:\n      strategy: cheapest-qualifed\n",
        demoCatalog,
      ),
    ).toThrow("routes.0.select.strategy");
  });
});
