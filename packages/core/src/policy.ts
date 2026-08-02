import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PolicyValidationError } from "./errors.js";
import type {
  Catalog,
  CapabilityName,
  FallbackRule,
  Modality,
  PolicyModelRef,
  PolicyRoute,
  RoutingPolicy,
  StrategyConfig,
  StrategyWeights,
} from "./types.js";

const strategySchema = z.union([
  z.string(),
  z.object({
    kind: z.string(),
    id: z.string().optional(),
    weights: z.record(z.number()).optional(),
    candidates: z.array(z.string()).optional(),
    stages: z.array(z.unknown()).optional(),
    seed: z.number().optional(),
  }),
]);

const policySchema = z.object({
  version: z.string(),
  defaults: z
    .object({
      strategy: strategySchema.optional(),
      fallbackAllowed: z.boolean().optional(),
      qualityProfile: z.enum(["economy", "balanced", "premium"]).optional(),
    })
    .optional(),
  models: z
    .array(
      z.object({
        id: z.string(),
        provider: z.string(),
        model: z.string(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  routes: z
    .array(
      z.object({
        id: z.string(),
        when: z.record(z.unknown()).default({}),
        require: z.record(z.unknown()).optional(),
        prefer: z.record(z.unknown()).optional(),
        select: z.record(z.unknown()),
      }),
    )
    .min(1),
  fallbacks: z
    .array(z.object({ from: z.string(), to: z.array(z.string()), on: z.array(z.string()) }))
    .optional(),
  resilience: z.record(z.unknown()).optional(),
  evaluation: z.record(z.unknown()).optional(),
});

export function definePolicy<T extends RoutingPolicy>(policy: T): T {
  validatePolicy(policy);
  return policy;
}

export function parsePolicyYaml(source: string, catalog?: Catalog): RoutingPolicy {
  const parsed: unknown = parseYaml(source);
  const result = policySchema.safeParse(parsed);
  if (!result.success)
    throw new PolicyValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "$",
        message: issue.message,
      })),
    );
  const policy = normalizePolicy(result.data);
  validatePolicy(policy, catalog);
  return policy;
}

export function validatePolicy(
  policy: RoutingPolicy,
  catalog?: Catalog,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  if (!policy.version) issues.push({ path: "version", message: "A policy version is required." });
  const routeIds = new Set<string>();
  let previousRouteIsCatchAll = false;
  for (const [index, route] of policy.routes.entries()) {
    if (routeIds.has(route.id))
      issues.push({ path: `routes.${index}.id`, message: `Duplicate route id ${route.id}.` });
    routeIds.add(route.id);
    if (previousRouteIsCatchAll)
      issues.push({
        path: `routes.${index}`,
        message: "This route is unreachable because an earlier catch-all route matches first.",
      });
    if (!route.select)
      issues.push({
        path: `routes.${index}.select`,
        message: "A route must define a selection strategy.",
      });
    if (route.when.task && Array.isArray(route.when.task) && route.when.task.length === 0)
      issues.push({
        path: `routes.${index}.when.task`,
        message: "A task matcher cannot be empty.",
      });
    if (
      route.when.task &&
      typeof route.when.task === "object" &&
      "anyOf" in route.when.task &&
      route.when.task.anyOf.length === 0
    )
      issues.push({
        path: `routes.${index}.when.task.anyOf`,
        message: "anyOf cannot be empty; the route would be unreachable.",
      });
    const weights =
      route.select.weights ??
      (route.select.strategy?.kind === "weighted-score"
        ? route.select.strategy.weights
        : undefined);
    if (weights) validateWeights(weights, `routes.${index}.select.weights`, issues);
    previousRouteIsCatchAll = previousRouteIsCatchAll || Object.keys(route.when).length === 0;
    for (const [candidateIndex, candidate] of (route.select.candidates ?? []).entries()) {
      if (
        policy.models &&
        !policy.models.some((model) => model.id === candidate) &&
        catalog &&
        !catalog.models.some((model) => model.id === candidate)
      )
        issues.push({
          path: `routes.${index}.select.candidates.${candidateIndex}`,
          message: `Unknown model reference ${candidate}.`,
        });
    }
  }
  const modelIds = new Set([
    ...(policy.models ?? []).map((model) => model.id),
    ...(catalog?.models ?? []).map((model) => model.id),
  ]);
  for (const [index, model] of (policy.models ?? []).entries()) {
    if (!model.provider)
      issues.push({
        path: `models.${index}.provider`,
        message: "A provider reference is required.",
      });
    if (!model.model)
      issues.push({
        path: `models.${index}.model`,
        message: "An API model reference is required.",
      });
  }
  for (const [index, fallback] of (policy.fallbacks ?? []).entries()) {
    if (!modelIds.has(fallback.from))
      issues.push({
        path: `fallbacks.${index}.from`,
        message: `Unknown fallback source ${fallback.from}.`,
      });
    for (const [targetIndex, target] of fallback.to.entries())
      if (!modelIds.has(target))
        issues.push({
          path: `fallbacks.${index}.to.${targetIndex}`,
          message: `Unknown fallback target ${target}.`,
        });
  }
  issues.push(...findFallbackCycles(policy.fallbacks ?? []));
  if (policy.defaults?.strategy?.kind === "weighted-score" && policy.defaults.strategy.weights)
    validateWeights(policy.defaults.strategy.weights, "defaults.strategy.weights", issues);
  if (issues.length) throw new PolicyValidationError(issues);
  return issues;
}

export function normalizePolicy(input: Record<string, unknown>): RoutingPolicy {
  const defaults = input.defaults as Record<string, unknown> | undefined;
  const routes = Array.isArray(input.routes)
    ? input.routes.map((raw) => normalizeRoute(raw as Record<string, unknown>))
    : [];
  return {
    version: String(input.version),
    ...(defaults
      ? {
          defaults: {
            ...(defaults.fallbackAllowed === undefined
              ? {}
              : { fallbackAllowed: Boolean(defaults.fallbackAllowed) }),
            ...(defaults.qualityProfile
              ? { qualityProfile: defaults.qualityProfile as "economy" | "balanced" | "premium" }
              : {}),
            ...(defaults.strategy ? { strategy: normalizeStrategy(defaults.strategy) } : {}),
          },
        }
      : {}),
    ...(Array.isArray(input.models)
      ? { models: input.models.map((model) => normalizeModel(model as Record<string, unknown>)) }
      : {}),
    routes,
    ...(Array.isArray(input.fallbacks)
      ? {
          fallbacks: input.fallbacks.map((fallback) => ({
            from: String((fallback as Record<string, unknown>).from),
            to: ((fallback as Record<string, unknown>).to as string[]).map(String),
            on: (fallback as Record<string, unknown>).on as string[] as FallbackRule["on"],
          })),
        }
      : {}),
    ...(input.resilience && typeof input.resilience === "object"
      ? { resilience: input.resilience as RoutingPolicy["resilience"] }
      : {}),
    ...(input.evaluation && typeof input.evaluation === "object"
      ? { evaluation: input.evaluation as RoutingPolicy["evaluation"] }
      : {}),
  };
}

export function policyJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "LLM Router policy",
    type: "object",
    required: ["version", "routes"],
    properties: {
      version: { type: "string" },
      defaults: {
        type: "object",
        properties: {
          fallbackAllowed: { type: "boolean" },
          qualityProfile: { enum: ["economy", "balanced", "premium"] },
          strategy: { type: ["string", "object"] },
        },
      },
      models: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "provider", "model"],
          properties: {
            id: { type: "string" },
            provider: { type: "string" },
            model: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      routes: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "when", "select"],
          properties: {
            id: { type: "string" },
            when: { type: "object" },
            require: { type: "object" },
            prefer: { type: "object" },
            select: { type: "object" },
          },
        },
      },
      fallbacks: { type: "array", items: { type: "object", required: ["from", "to", "on"] } },
    },
  };
}

export function route(id: string): PolicyRouteBuilder {
  return new PolicyRouteBuilder(id);
}

export function weightedScore(weights?: StrategyWeights): StrategyConfig {
  return { kind: "weighted-score", ...(weights ? { weights } : {}) };
}
export function cheapestQualified(): StrategyConfig {
  return { kind: "cheapest-qualified" };
}
export function fastestQualified(
  options: { requireObservedLatency?: boolean } = {},
): StrategyConfig {
  return { kind: "fastest-qualified", ...options };
}
export function priority(): StrategyConfig {
  return { kind: "priority" };
}
export function cascade(
  stages: NonNullable<Extract<StrategyConfig, { kind: "cascade" }>["stages"]>,
): StrategyConfig {
  return { kind: "cascade", stages };
}

class PolicyRouteBuilder {
  private readonly value: PolicyRoute;
  constructor(private readonly id: string) {
    this.value = { id, when: {}, select: {} };
  }
  when(value: PolicyRoute["when"]): this {
    this.value.when = value;
    return this;
  }
  require(value: PolicyRoute["require"]): this {
    this.value.require = value;
    return this;
  }
  prefer(value: NonNullable<PolicyRoute["prefer"]>): this {
    this.value.prefer = value;
    return this;
  }
  select(strategy: StrategyConfig, candidates?: string[]): PolicyRoute {
    this.value.select = { strategy, ...(candidates ? { candidates } : {}) };
    return this.value;
  }
}

function normalizeRoute(input: Record<string, unknown>): PolicyRoute {
  const select = (input.select ?? {}) as Record<string, unknown>;
  const require = input.require as Record<string, unknown> | undefined;
  return {
    id: String(input.id),
    when: (input.when ?? {}) as PolicyRoute["when"],
    ...(require
      ? {
          require: {
            ...(require.capabilities
              ? { capabilities: require.capabilities as CapabilityName[] }
              : {}),
            ...(require.inputModalities
              ? { inputModalities: require.inputModalities as Modality[] }
              : {}),
            ...(require.minContextTokens
              ? { minContextTokens: Number(require.minContextTokens) }
              : {}),
            ...(require.tags ? { tags: require.tags as string[] } : {}),
          },
        }
      : {}),
    ...(input.prefer ? { prefer: input.prefer as PolicyRoute["prefer"] } : {}),
    select: {
      ...(Array.isArray(select.candidates) ? { candidates: select.candidates.map(String) } : {}),
      ...(select.weights ? { weights: select.weights as StrategyWeights } : {}),
      ...(select.strategy ? { strategy: normalizeStrategy(select.strategy) } : {}),
    },
  };
}

function normalizeModel(input: Record<string, unknown>): PolicyModelRef {
  return {
    id: String(input.id),
    provider: String(input.provider),
    model: String(input.model),
    ...(input.tags ? { tags: input.tags as string[] } : {}),
  };
}

function normalizeStrategy(input: unknown): StrategyConfig {
  if (typeof input === "string") return { kind: input as StrategyConfig["kind"] } as StrategyConfig;
  return input as StrategyConfig;
}

function validateWeights(
  weights: StrategyWeights,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  const values = Object.values(weights).filter(
    (value): value is number => typeof value === "number",
  );
  if (values.some((value) => value < 0))
    issues.push({ path, message: "Weights cannot be negative." });
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length && Math.abs(total - 1) > 0.001)
    issues.push({ path, message: `Weights must sum to 1. Received ${total.toFixed(4)}.` });
}

function findFallbackCycles(fallbacks: FallbackRule[]): Array<{ path: string; message: string }> {
  const graph = new Map(fallbacks.map((fallback) => [fallback.from, fallback.to]));
  const issues: Array<{ path: string; message: string }> = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string, path: string): void => {
    if (visiting.has(node)) {
      issues.push({ path, message: `Fallback cycle detected at ${node}.` });
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target, `${path}.${target}`);
    visiting.delete(node);
    visited.add(node);
  };
  for (const from of graph.keys()) visit(from, `fallbacks.${from}`);
  return issues;
}
