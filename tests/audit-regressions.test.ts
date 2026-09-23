import { describe, expect, it, vi } from "vitest";
import { demoCatalog } from "@llm-router/catalog";
import {
  createRouter,
  createInMemoryBudgetStore,
  normalizedErrorFromUnknown,
  validateJsonSchema,
  type Catalog,
  type ModelDefinition,
  type ProviderAdapter,
  type RoutingPolicy,
  type RoutingRequest,
  type RouterEvent,
} from "@llm-router/core";
import { evaluateDataset, compareReports } from "@llm-router/evals";

const request: RoutingRequest = { messages: [{ role: "user", content: "hello" }] };
const model = (id: string, extra: Partial<ModelDefinition> = {}): ModelDefinition => ({
  ...structuredClone(demoCatalog.models[0]!),
  id,
  apiModelId: id,
  providerId: "p",
  ...extra,
});
const catalog: Catalog = {
  version: "test",
  providers: [{ id: "p", name: "p", adapter: "mock" }],
  models: [model("a"), model("b")],
};
const policy = (extra: Partial<RoutingPolicy> = {}): RoutingPolicy => ({
  version: "test",
  routes: [{ id: "all", when: {}, select: { strategy: { kind: "rules" } } }],
  resilience: { retry: { maxAttempts: 1 } },
  ...extra,
});
const adapter = (extra: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
  id: "mock",
  validateModel() {},
  async execute() {
    return { data: "OK" };
  },
  normalizeError: normalizedErrorFromUnknown,
  ...extra,
});
const collect = async (events: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> => {
  const out: RouterEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};
const rateLimit = { code: "rate-limit", message: "429", retryable: true, fallbackEligible: true };

describe("audited execution guarantees", () => {
  it.each(["defaults", "request", "rule", "eligibility"])(
    "honors fallback %s restrictions",
    async (variant) => {
      const calls: string[] = [];
      const router = createRouter({
        catalog,
        policy: policy({
          defaults: { fallbackAllowed: variant !== "defaults" },
          fallbacks: [
            { from: "a", to: ["b"], on: variant === "rule" ? ["timeout"] : ["rate-limit"] },
          ],
        }),
        adapters: {
          mock: adapter({
            async execute(_request, m) {
              calls.push(m.id);
              throw { ...rateLimit, fallbackEligible: variant !== "eligibility" };
            },
          }),
        },
      });
      await expect(
        router.execute({ ...request, constraints: { fallbackAllowed: variant !== "request" } }),
      ).rejects.toThrow();
      expect(calls).toEqual(["a"]);
    },
  );
  it("allows configured fallback and preserves attempt history", async () => {
    const router = createRouter({
      catalog,
      policy: policy({ fallbacks: [{ from: "a", to: ["b"], on: ["rate-limit"] }] }),
      adapters: {
        mock: adapter({
          async execute(_request, m) {
            if (m.id === "a") throw rateLimit;
            return { data: "OK" };
          },
        }),
      },
    });
    const result = await router.execute(request);
    expect(result.execution.attempts.map((a) => [a.modelId, a.ok])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });
  it("validates JSON content instead of provider envelopes", async () => {
    const router = createRouter({
      catalog,
      policy: policy(),
      adapters: {
        mock: adapter({
          async execute() {
            return { data: { content: '{"ok":true}' }, text: '{"ok":true}' };
          },
        }),
      },
    });
    const result = await router.execute({
      ...request,
      output: {
        schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      },
    });
    expect(result.response).toEqual({ ok: true });
  });
  it("reserves the monthly budget atomically across concurrent streams and executions", async () => {
    const budgetStore = createInMemoryBudgetStore();
    let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const priced = {
      ...catalog,
      models: [
        model("a", { pricing: { currency: "USD", inputPerMillion: 0, outputPerMillion: 600000 } }),
      ],
    };
    const router = createRouter({
      catalog: priced,
      policy: policy(),
      budgetStore,
      adapters: {
        mock: adapter({
          async execute() {
            calls++;
            await barrier;
            return { data: "OK", usage: { cost: 0.6 } };
          },
          async *stream() {
            calls++;
            await barrier;
            yield { type: "usage", usage: { cost: 0.6 } };
            yield { type: "text-delta", text: "OK" };
          },
        }),
      },
    });
    const capped = { ...request, output: { maxTokens: 1 }, constraints: { maxMonthlyBudget: 1 } };
    const one = collect(router.stream(capped));
    await vi.waitFor(() => expect(calls).toBe(1));
    await expect(router.execute(capped)).rejects.toThrow();
    release();
    await one;
    expect(calls).toBe(1);
    await expect(router.execute(capped)).rejects.toThrow();
  });
  it("charges rejected output before considering another paid attempt", async () => {
    const budgetStore = createInMemoryBudgetStore();
    let calls = 0;
    const router = createRouter({
      catalog: {
        ...catalog,
        models: [
          model("a", {
            pricing: { currency: "USD", inputPerMillion: 0, outputPerMillion: 600000 },
          }),
        ],
      },
      policy: policy(),
      budgetStore,
      adapters: {
        mock: adapter({
          async execute() {
            calls++;
            return { data: "bad", usage: { cost: 0.6 } };
          },
        }),
      },
    });
    const capped = {
      ...request,
      output: { maxTokens: 1, schema: { type: "object" } },
      constraints: { maxMonthlyBudget: 1 },
    };
    await expect(router.execute(capped)).rejects.toThrow();
    await expect(router.execute(capped)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("does not retry beyond the deadline or before Retry-After", async () => {
    const execute = vi.fn(async () => {
      throw { ...rateLimit, retryAfterMs: 1000 };
    });
    const router = createRouter({
      catalog,
      policy: policy({
        resilience: { deadlineMs: 40, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } },
      }),
      adapters: { mock: adapter({ execute }) },
    });
    await expect(router.execute(request)).rejects.toThrow(/deadline/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("honors configured backoff and aborts hanging providers", async () => {
    const starts: number[] = [];
    const execute = vi.fn(async () => {
      starts.push(performance.now());
      throw rateLimit;
    });
    const router = createRouter({
      catalog,
      policy: policy({
        resilience: {
          deadlineMs: 1000,
          retry: { maxAttempts: 2, baseDelayMs: 40, maxDelayMs: 40 },
          fallback: { maxModelFallbacks: 0 },
        },
      }),
      random: () => 0,
      adapters: { mock: adapter({ execute }) },
    });
    await expect(router.execute(request)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35);
    let signal: AbortSignal | undefined;
    const hanging = createRouter({
      catalog,
      policy: policy({ resilience: { deadlineMs: 30 } }),
      adapters: {
        mock: adapter({
          execute: async (_r, _m, ctx) => {
            signal = ctx.signal;
            return new Promise(() => undefined);
          },
        }),
      },
    });
    await expect(hanging.execute(request)).rejects.toThrow(/deadline/);
    expect(signal?.aborted).toBe(true);
  });
  it("blocks execution in decision-only mode and rejects unsupported shadow execution", async () => {
    const execute = vi.fn();
    const router = createRouter({
      catalog,
      policy: policy(),
      decisionOnly: true,
      adapters: { mock: adapter({ execute }) },
    });
    await expect(router.execute(request)).rejects.toThrow(/decision-only/);
    expect((await collect(router.stream(request))).at(-1)?.type).toBe("error");
    expect(execute).not.toHaveBeenCalled();
    expect(() => createRouter({ catalog, policy: policy(), executeShadowRequests: true })).toThrow(
      /unsupported/,
    );
  });
  it("applies cascade candidate and acceptance rules before exposing output", async () => {
    const calls: string[] = [];
    const router = createRouter({
      catalog,
      policy: policy({
        routes: [
          {
            id: "all",
            when: {},
            select: {
              strategy: {
                kind: "cascade",
                stages: [
                  { candidates: ["b"], accept: { type: "regex", pattern: "GOOD" } },
                  { model: "a" },
                ],
              },
            },
          },
        ],
      }),
      adapters: {
        mock: adapter({
          async *stream(_r, m) {
            calls.push(m.id);
            yield { type: "text-delta", text: m.id === "b" ? "BAD" : "GOOD" };
          },
        }),
      },
    });
    const events = await collect(router.stream(request));
    expect(calls).toEqual(["b", "a"]);
    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("GOOD");
  });
  it("never replays output after a partial stream failure", async () => {
    let calls = 0;
    const router = createRouter({
      catalog,
      policy: policy({ resilience: { retry: { maxAttempts: 3 } } }),
      adapters: {
        mock: adapter({
          async *stream() {
            calls++;
            yield { type: "text-delta", text: "HELLO" };
            throw rateLimit;
          },
        }),
      },
    });
    const events = await collect(router.stream(request));
    expect(calls).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.filter((event) => event.type === "text-delta")).toHaveLength(1);
  });
  it("rejects invalid structured streams without exposing their output", async () => {
    const router = createRouter({
      catalog,
      policy: policy(),
      adapters: {
        mock: adapter({
          async *stream() {
            yield { type: "text-delta", text: "NOT JSON" };
          },
        }),
      },
    });
    const events = await collect(
      router.stream({ ...request, output: { schema: { type: "object" } } }),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some((event) => event.type === "text-delta")).toBe(false);
  });
  it("aborts immediately when the stream consumer returns", async () => {
    let signal: AbortSignal | undefined;
    const router = createRouter({
      catalog,
      policy: policy(),
      adapters: {
        mock: adapter({
          async *stream(_r, _m, context) {
            signal = context.signal;
            yield { type: "text-delta", text: "hello" };
            await new Promise(() => undefined);
          },
        }),
      },
    });
    for await (const event of router.stream(request)) if (event.type === "text-delta") break;
    expect(signal?.aborted).toBe(true);
  });
  it("executes the announced round-robin model exactly once without native streaming", async () => {
    const calls: string[] = [];
    const router = createRouter({
      catalog,
      policy: policy({
        routes: [{ id: "all", when: {}, select: { strategy: { kind: "round-robin" } } }],
      }),
      adapters: {
        mock: adapter({
          async execute(_r, m) {
            calls.push(m.id);
            return { data: { content: "OK" }, text: "OK" };
          },
        }),
      },
    });
    const events = await collect(router.stream(request));
    const decision = events.find((event) => event.type === "decision");
    expect(calls).toEqual([decision?.decision.selected?.modelId]);
    expect(events).toContainEqual({ type: "text-delta", text: "OK" });
  });
});

describe("audited decision and evaluation guarantees", () => {
  it("enforces local refs, false schemas, and closed objects", () => {
    expect(
      validateJsonSchema("x", { $defs: { n: { type: "number" } }, $ref: "#/$defs/n" }).valid,
    ).toBe(false);
    expect(validateJsonSchema(1, false).valid).toBe(false);
    expect(
      validateJsonSchema({ x: 1 }, { type: "object", additionalProperties: false }).valid,
    ).toBe(false);
    expect(validateJsonSchema(1, { $ref: "https://example.com/schema" }).valid).toBe(false);
    expect(validateJsonSchema(1, { typoKeyword: true }).valid).toBe(false);
  });
  it("checks combined context and unknown output limits", async () => {
    const small = {
      ...catalog,
      models: [model("a", { limits: { contextTokens: 100, outputTokens: 100 } })],
    };
    expect(
      (
        await createRouter({ catalog: small, policy: policy() }).decide({
          ...request,
          input: { estimatedTokens: 90 },
          output: { maxTokens: 20 },
        })
      ).selected,
    ).toBeNull();
    small.models[0]!.limits!.outputTokens = null;
    expect(
      (
        await createRouter({ catalog: small, policy: policy() }).decide({
          ...request,
          constraints: { minOutputTokens: 1000 },
        })
      ).selected,
    ).toBeNull();
  });
  it("uses observed P95-only latency and declared candidate order", async () => {
    const p95 = { ...catalog, models: [model("a", { metadata: { observedP95LatencyMs: 100 } })] };
    expect(
      (
        await createRouter({ catalog: p95, policy: policy() }).decide({
          ...request,
          constraints: { maxExpectedLatencyMs: 200 },
        })
      ).selected?.modelId,
    ).toBe("a");
    const ordered = policy({
      routes: [
        { id: "all", when: {}, select: { candidates: ["b", "a"], strategy: { kind: "priority" } } },
      ],
    });
    expect(
      (await createRouter({ catalog, policy: ordered }).decide(request)).selected?.modelId,
    ).toBe("b");
  });
  it("fails evaluation gates closed when evidence is incomplete", async () => {
    const p = policy();
    const router = createRouter({ catalog, policy: p });
    const report = await evaluateDataset({
      router,
      policy: p,
      dataset: [
        { id: "1", task: "chat", input: request },
        { id: "2", task: "chat", input: request },
      ],
      baselineCosts: { "1": 1 },
      baselineQuality: { "1": 1 },
      evaluateQuality: () => 1,
    });
    expect(report.summary.fallbackRate).toBeNull();
    expect(report.summary.savingsVsBaseline).toBeNull();
    expect(report.summary.qualityDeltaVsBaseline).toBeNull();
    expect(compareReports(report, report).passed).toBe(false);
  });
});
