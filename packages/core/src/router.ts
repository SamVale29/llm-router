import { checkCompatibility } from "./compatibility.js";
import { estimateRequestCost } from "./cost.js";
import { NoEligibleModelError, normalizedErrorFromUnknown } from "./errors.js";
import { createInMemoryBudgetStore, createInMemoryHealthStore } from "./health.js";
import { sha256, stableStringify } from "./hash.js";
import { normalizeRequest } from "./normalize.js";
import { validatePolicy } from "./policy.js";
import { validateJsonSchema } from "./schema.js";
import { detectTask } from "./tasks.js";
import type {
  AdapterResponse,
  AdapterStreamEvent,
  Catalog,
  ExecutionContext,
  ExecutionResult,
  ModelDefinition,
  NormalizedProviderError,
  NormalizedRoutingRequest,
  PolicyRoute,
  ProviderAdapter,
  ProviderAttempt,
  RoutingCandidate,
  RoutingDecision,
  RoutingPolicy,
  RoutingRequest,
  Router,
  RouterEvent,
  RouterHookContext,
  RouterOptions,
  StrategyConfig,
  StrategyContext,
  StrategyResult,
  StrategyWeights,
  TaskClassificationResult,
} from "./types.js";

const DEFAULT_LIBRARY_VERSION = "0.1.0";

export function createRouter(options: RouterOptions): Router {
  validatePolicy(options.policy, options.catalog);
  const healthStore = options.healthStore ?? createInMemoryHealthStore({ now: options.now });
  const budgetStore = options.budgetStore ?? createInMemoryBudgetStore();
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const roundRobinCounters = new Map<string, number>();
  const adapterByProvider = new Map(
    options.catalog.providers
      .map((provider) => [
        provider.id,
        options.adapters?.[provider.adapter] ?? options.adapters?.[provider.id],
      ])
      .filter((entry): entry is [string, ProviderAdapter] => Boolean(entry[1])),
  );

  async function decide(request: RoutingRequest): Promise<RoutingDecision> {
    return buildDecision(request, options.policy);
  }

  async function buildDecision(
    request: RoutingRequest,
    policy: RoutingPolicy,
  ): Promise<RoutingDecision> {
    const startedAt = now();
    const started = performance.now();
    const requestId = request.id ?? `request-${Date.now().toString(36)}`;
    await runHook(options.hooks?.beforeNormalize, { requestId, event: "beforeNormalize" });
    const normalized = normalizeRequest({ ...request, ...(request.id ? {} : { id: requestId }) });
    await runHook(options.hooks?.afterNormalize, {
      requestId: normalized.id,
      event: "afterNormalize",
    });
    await runHook(options.hooks?.beforeClassify, {
      requestId: normalized.id,
      event: "beforeClassify",
    });
    const task = await detectTask(
      normalized,
      options.taskClassifier,
      normalized.constraints.remoteClassificationAllowed === true,
    );
    await runHook(options.hooks?.afterClassify, {
      requestId: normalized.id,
      task,
      event: "afterClassify",
    });
    const route = findRoute(policy, normalized, task);
    const constraints = mergeRouteRequirements(normalized.constraints, route?.require);
    const effectiveRequest = { ...normalized, constraints };
    const policyModels = materializeModels(options.catalog, policy);
    const selectedIds = route?.select.candidates ?? policyModels.map((model) => model.id);
    const selectedIdSet = new Set(selectedIds);
    const models = policyModels.filter((model) => selectedIdSet.has(model.id));
    const warnings: string[] = [];
    const budgetScope = usageScope(effectiveRequest);
    const budgetUsage =
      constraints.maxMonthlyBudget === undefined ? null : await budgetStore.getUsage(budgetScope);
    const candidates: RoutingCandidate[] = [];
    for (const model of models) {
      const health = await healthStore.get({ providerId: model.providerId, modelId: model.id });
      const compatibility = checkCompatibility(effectiveRequest, model, constraints);
      const eliminatedBy = [...compatibility.reasons];
      if (health.state === "open")
        eliminatedBy.push({
          code: "CIRCUIT_OPEN",
          message: "The in-memory health circuit is open for this model.",
          field: "health.state",
        });
      if (
        constraints.maxExpectedLatencyMs !== undefined &&
        model.metadata?.observedLatencyMs === undefined &&
        health.p95LatencyMs === undefined
      )
        eliminatedBy.push({
          code: "LATENCY_UNKNOWN",
          message: "No observed latency is available for the configured latency ceiling.",
          field: "latency",
        });
      const predictedOutputTokens =
        effectiveRequest.output.maxTokens ?? Math.min(model.limits.outputTokens ?? 512, 512);
      const estimated = estimateRequestCost({
        model,
        estimatedInputTokens: effectiveRequest.estimatedInputTokens,
        estimatedOutputTokens: predictedOutputTokens,
      });
      if (constraints.unknownCost === "exclude" && estimated.total === null)
        eliminatedBy.push({
          code: "COST_UNKNOWN",
          message: "The policy excludes models without complete pricing data.",
          field: "pricing",
        });
      if (
        constraints.maxEstimatedRequestCost !== undefined &&
        (estimated.total === null || estimated.total > constraints.maxEstimatedRequestCost)
      )
        eliminatedBy.push({
          code: "REQUEST_COST_TOO_HIGH",
          message:
            estimated.total === null
              ? "The request cost cannot be estimated under a hard cost ceiling."
              : `The estimated request cost ${estimated.total.toFixed(6)} USD exceeds the configured ceiling of ${constraints.maxEstimatedRequestCost.toFixed(6)} USD.`,
          field: "maxEstimatedRequestCost",
        });
      if (
        constraints.maxMonthlyBudget !== undefined &&
        budgetUsage &&
        (estimated.total === null ||
          budgetUsage.amount + estimated.total > constraints.maxMonthlyBudget)
      )
        eliminatedBy.push({
          code: "MONTHLY_BUDGET_EXCEEDED",
          message:
            estimated.total === null
              ? "The request cost is unknown under the configured budget limit."
              : `Current budget usage plus the estimated request cost exceeds ${constraints.maxMonthlyBudget.toFixed(6)} USD.`,
          field: "maxMonthlyBudget",
        });
      const predictedLatency =
        health.p95LatencyMs ??
        model.metadata?.observedP95LatencyMs ??
        model.metadata?.observedLatencyMs ??
        null;
      if (
        constraints.maxExpectedLatencyMs !== undefined &&
        predictedLatency !== null &&
        predictedLatency > constraints.maxExpectedLatencyMs
      )
        eliminatedBy.push({
          code: "LATENCY_TOO_HIGH",
          message: "The observed/published workload latency exceeds the configured ceiling.",
          field: "latency",
        });
      const quality = qualitySignal(model, task.task);
      const taskFit = taskFitSignal(model, task.task, route?.prefer?.tags ?? []);
      const reliability = model.metadata?.reliability ?? health.successRate;
      candidates.push({
        model,
        eligible: eliminatedBy.length === 0,
        eliminatedBy,
        signals: {
          task: task.task,
          quality,
          taskFit,
          reliability,
          healthState: health.state,
          ...(predictedLatency === null ? { latencyMs: null } : { latencyMs: predictedLatency }),
          ...(estimated.total === null
            ? { estimatedCost: null }
            : { estimatedCost: estimated.total }),
        },
        scores: { quality, taskFit, reliability, cost: estimated.total, latency: predictedLatency },
        predicted: {
          inputTokens: effectiveRequest.estimatedInputTokens,
          outputTokens: predictedOutputTokens,
          cost: estimated.total,
          latencyMs: predictedLatency,
        },
      });
    }
    if (!candidates.length) warnings.push("The selected route has no model candidates.");
    normalizeCandidateScores(candidates, warnings);
    await runHook(options.hooks?.beforeSelect, {
      requestId: normalized.id,
      task,
      event: "beforeSelect",
    });
    const strategy = resolveStrategy(
      route?.select.strategy ?? policy.defaults?.strategy ?? { kind: "weighted-score" },
      route?.select.weights,
    );
    const strategyResult = await selectModel(
      strategy,
      {
        request: effectiveRequest,
        task,
        candidates,
        preferredTags: route?.prefer?.tags ?? [],
        warnings,
      },
      roundRobinCounters,
      random,
      options.customStrategies,
    );
    const selected =
      candidates.find(
        (candidate) => candidate.model.id === strategyResult.selectedModelId && candidate.eligible,
      ) ?? null;
    if (strategyResult.selectedModelId && !selected)
      warnings.push("The strategy returned a model that was not eligible; no model was selected.");
    if (candidates.some((candidate) => candidate.predicted.cost === null))
      warnings.push("Some candidates have unknown pricing; estimates are not a billing guarantee.");
    if (candidates.some((candidate) => candidate.predicted.latencyMs === null))
      warnings.push(
        "Some latency signals are missing; fastest-qualified only uses observed or catalog demonstration data.",
      );
    if (task.source === "rule")
      warnings.push(
        "Task detection used local deterministic signals; provide hints.task for the highest confidence.",
      );
    if (task.source === "default")
      warnings.push("Task type is unknown; routing used the policy default.");
    const fallbackChain = buildFallbackChain(
      policy,
      selected?.model.id ?? null,
      candidates,
      constraints.fallbackAllowed !== false,
      policy.resilience?.fallback?.maxModelFallbacks ?? 2,
    );
    const hashInput = { ...effectiveRequest, id: undefined };
    const normalizedRequestHash = await sha256(stableStringify(hashInput));
    const durationMs = Math.max(0, performance.now() - started);
    const decision: RoutingDecision = {
      requestId: normalized.id,
      decisionId: `decision-${normalized.id}-${Math.round(started)}`,
      selected: selected
        ? {
            providerId: selected.model.providerId,
            modelId: selected.model.id,
            apiModelId: selected.model.apiModelId,
          }
        : null,
      fallbackChain,
      task: { type: task.task, confidence: task.confidence ?? null, source: task.source },
      strategy: { id: strategyResult.strategyId, version: strategyResult.strategyVersion },
      candidates,
      explanation: {
        summary: selected
          ? `${selected.model.displayName} was selected by ${strategyResult.strategyId}.`
          : "No eligible model satisfied the request and policy constraints.",
        reasons: [strategyResult.reason, ...taskSignals(task), ...routeReason(route)],
        warnings,
      },
      estimates: {
        cost: selected?.predicted.cost ?? null,
        latencyMs: selected?.predicted.latencyMs ?? null,
      },
      reproducibility: {
        libraryVersion: options.libraryVersion ?? DEFAULT_LIBRARY_VERSION,
        policyVersion: policy.version,
        catalogVersion: options.catalog.version,
        normalizedRequestHash,
      },
      timing: { startedAt: startedAt.toISOString(), durationMs },
    };
    await runHook(options.hooks?.afterSelect, {
      requestId: normalized.id,
      task,
      decision,
      event: "afterSelect",
    });
    return decision;
  }

  async function execute<T = unknown>(request: RoutingRequest): Promise<ExecutionResult<T>> {
    const decision = await decide(request);
    await runHook(options.hooks?.beforeExecute, {
      requestId: decision.requestId,
      decision,
      event: "beforeExecute",
    });
    if (!decision.selected) throw new NoEligibleModelError(undefined, { decision });
    const normalized = normalizeRequest({ ...request, id: decision.requestId });
    const candidatesById = new Map(
      decision.candidates.map((candidate) => [candidate.model.id, candidate.model]),
    );
    const chain = [
      decision.selected.modelId,
      ...decision.fallbackChain.map((entry) => entry.modelId),
    ];
    const maxAttempts = policyRetryMax(options.policy);
    const retryableErrors = options.policy.resilience?.retry?.retryableErrors ?? [
      "rate-limit",
      "timeout",
      "unavailable",
      "connection",
    ];
    const fallbackErrors = options.policy.resilience?.fallback?.errors ?? [
      "rate-limit",
      "timeout",
      "unavailable",
    ];
    const deadlineMs = options.policy.resilience?.deadlineMs ?? 20_000;
    const executionStarted = performance.now();
    const attempts: ProviderAttempt[] = [];
    let selectedAttempt: number | undefined;
    let finalResponse: AdapterResponse | undefined;
    let finalError: NormalizedProviderError | undefined;
    for (let chainIndex = 0; chainIndex < chain.length; chainIndex++) {
      const modelId = chain[chainIndex];
      if (!modelId) continue;
      const model = candidatesById.get(modelId);
      if (!model) continue;
      const provider = options.catalog.providers.find((item) => item.id === model.providerId);
      const adapter = provider ? adapterByProvider.get(provider.id) : undefined;
      if (!adapter) {
        finalError = {
          code: "unavailable",
          message: `No adapter is registered for provider ${model.providerId}.`,
          retryable: false,
          fallbackEligible: true,
          providerId: model.providerId,
          modelId: model.id,
        };
        continue;
      }
      adapter.validateModel(model);
      for (let retry = 0; retry < maxAttempts; retry++) {
        const attemptNumber = attempts.length + 1;
        const attemptStartedAt = now();
        const attemptStarted = performance.now();
        const remaining = Math.max(1, deadlineMs - (performance.now() - executionStarted));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), remaining);
        const context: ExecutionContext = {
          signal: controller.signal,
          requestId: decision.requestId,
          attempt: attemptNumber,
          timeoutMs: remaining,
          ...(normalized.providerOptions?.[
            provider?.adapter as keyof NonNullable<RoutingRequest["providerOptions"]>
          ]
            ? {
                providerOptions:
                  normalized.providerOptions?.[
                    provider?.adapter as keyof NonNullable<RoutingRequest["providerOptions"]>
                  ],
              }
            : {}),
        };
        try {
          await emitStreamlessAttempt(
            options,
            decision.requestId,
            model,
            attemptNumber,
            "attempt-start",
          );
          const response = await adapter.execute(normalized, model, context);
          clearTimeout(timeout);
          const durationMs = performance.now() - attemptStarted;
          const validation = validateResponse(response, normalized);
          if (!validation.valid) {
            const error: NormalizedProviderError = {
              code: "invalid-request",
              message: `Provider response failed local schema validation: ${validation.errors.join("; ")}`,
              retryable: false,
              fallbackEligible: true,
              providerId: model.providerId,
              modelId: model.id,
            };
            await healthStore.recordFailure(
              { providerId: model.providerId, modelId: model.id },
              error,
              durationMs,
            );
            attempts.push({
              providerId: model.providerId,
              modelId: model.id,
              attempt: attemptNumber,
              startedAt: attemptStartedAt.toISOString(),
              durationMs,
              ok: false,
              error,
            });
            finalError = error;
          } else {
            await healthStore.recordSuccess(
              { providerId: model.providerId, modelId: model.id },
              durationMs,
            );
            attempts.push({
              providerId: model.providerId,
              modelId: model.id,
              attempt: attemptNumber,
              startedAt: attemptStartedAt.toISOString(),
              durationMs,
              ok: true,
            });
            selectedAttempt = attemptNumber;
            finalResponse = response;
            const usageCost =
              response.usage?.cost ??
              (response.usage?.inputTokens !== undefined &&
              response.usage?.outputTokens !== undefined
                ? (estimateRequestCost({
                    model,
                    estimatedInputTokens: response.usage.inputTokens,
                    estimatedOutputTokens: response.usage.outputTokens,
                  }).total ?? 0)
                : 0);
            const scope = usageScope(normalized);
            if (usageCost > 0)
              await budgetStore.recordUsage({
                scope,
                amount: usageCost,
                currency: "USD",
                requestId: decision.requestId,
                modelId: model.id,
              });
            break;
          }
        } catch (cause) {
          clearTimeout(timeout);
          const error = adapter.normalizeError(cause);
          const durationMs = performance.now() - attemptStarted;
          await healthStore.recordFailure(
            { providerId: model.providerId, modelId: model.id },
            error,
            durationMs,
          );
          attempts.push({
            providerId: model.providerId,
            modelId: model.id,
            attempt: attemptNumber,
            startedAt: attemptStartedAt.toISOString(),
            durationMs,
            ok: false,
            error,
          });
          finalError = error;
          await runHook(options.hooks?.onAttemptError, {
            requestId: decision.requestId,
            decision,
            event: "onAttemptError",
          });
          if (!error.retryable || !retryableErrors.includes(error.code)) break;
          if (retry + 1 < maxAttempts)
            await delay(backoffMs(retry, error.retryAfterMs, options.random ?? Math.random));
        }
        if (finalResponse) break;
      }
      if (finalResponse) break;
      const canFallback =
        finalError &&
        fallbackErrors.includes(finalError.code) &&
        constraintsAllowFallback(normalized);
      if (!canFallback) break;
      const nextModelId = chain[chainIndex + 1];
      if (nextModelId) {
        await runHook(options.hooks?.onFallback, {
          requestId: decision.requestId,
          decision,
          event: "onFallback",
        });
      }
    }
    if (!finalResponse)
      throw new NoEligibleModelError(finalError?.message ?? "All model attempts failed.", {
        decision,
        attempts,
      });
    const result: ExecutionResult<T> = {
      decision,
      response: finalResponse.data as T,
      ...(finalResponse.usage ? { usage: finalResponse.usage } : {}),
      execution: {
        attempts,
        ...(selectedAttempt === undefined ? {} : { selectedAttempt }),
        totalDurationMs: performance.now() - executionStarted,
      },
    };
    await runHook(options.hooks?.afterExecute, {
      requestId: decision.requestId,
      decision,
      event: "afterExecute",
    });
    await runHook(options.hooks?.onComplete, {
      requestId: decision.requestId,
      decision,
      event: "onComplete",
    });
    return result;
  }

  async function* stream(request: RoutingRequest): AsyncIterable<RouterEvent> {
    const decision = await decide(request);
    yield { type: "decision", decision };
    if (!decision.selected) {
      yield {
        type: "error",
        error: {
          code: "invalid-request",
          message: "No eligible model was selected.",
          retryable: false,
          fallbackEligible: false,
        },
      };
      return;
    }
    const selected = options.catalog.models.find(
      (model) => model.id === decision.selected?.modelId,
    );
    const provider = selected
      ? options.catalog.providers.find((item) => item.id === selected.providerId)
      : undefined;
    const adapter = provider ? adapterByProvider.get(provider.id) : undefined;
    if (selected && adapter?.stream) {
      const normalized = normalizeRequest({ ...request, id: decision.requestId });
      const controller = new AbortController();
      try {
        yield {
          type: "attempt-start",
          providerId: selected.providerId,
          modelId: selected.id,
          attempt: 1,
        };
        for await (const event of adapter.stream(normalized, selected, {
          signal: controller.signal,
          requestId: decision.requestId,
          attempt: 1,
          timeoutMs: options.policy.resilience?.deadlineMs ?? 20_000,
        }))
          yield* mapAdapterEvent(event);
        yield {
          type: "complete",
          result: { decision, execution: { attempts: [], totalDurationMs: 0 } },
        };
        return;
      } catch (cause) {
        const error = adapter.normalizeError(cause);
        yield { type: "error", error };
        return;
      }
    }
    try {
      const result = await execute(request);
      if (typeof result.response === "string") yield { type: "text-delta", text: result.response };
      if (result.usage) yield { type: "usage", usage: result.usage };
      yield { type: "complete", result };
    } catch (cause) {
      yield { type: "error", error: normalizedErrorFromUnknown(cause) };
    }
  }

  async function shadow(
    request: RoutingRequest,
  ): Promise<Array<{ policyVersion: string; decision: RoutingDecision }>> {
    const policies = options.shadowPolicies ?? [];
    const results: Array<{ policyVersion: string; decision: RoutingDecision }> = [];
    for (const policy of policies)
      results.push({
        policyVersion: policy.version,
        decision: await buildDecision(request, policy),
      });
    return results;
  }

  return { decide, explain: decide, execute, stream, shadow };
}

function materializeModels(catalog: Catalog, policy: RoutingPolicy): ModelDefinition[] {
  const catalogById = new Map(catalog.models.map((model) => [model.id, model]));
  if (!policy.models?.length) return catalog.models;
  return policy.models.map(
    (ref) =>
      catalogById.get(ref.id) ?? {
        id: ref.id,
        providerId: ref.provider,
        apiModelId: ref.model,
        displayName: ref.model,
        status: "active",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: {
          functionCalling: "unknown",
          structuredOutputs: "unknown",
          reasoning: "unknown",
          promptCaching: "unknown",
          fineTuning: "unknown",
          realtime: "unknown",
          parallelToolCalls: "unknown",
          jsonMode: "unknown",
          embeddings: "unknown",
        },
        limits: { contextTokens: null, outputTokens: null },
        tags: ref.tags,
        operational: { enabled: true },
        metadata: {
          sourceNote:
            "Policy-local model reference; verify capabilities and pricing before production.",
        },
      },
  );
}

function findRoute(
  policy: RoutingPolicy,
  request: NormalizedRoutingRequest,
  task: TaskClassificationResult,
): PolicyRoute | undefined {
  return policy.routes.find((route) => {
    const when = route.when;
    if (when.task) {
      if (Array.isArray(when.task) && !when.task.includes(task.task)) return false;
      if (
        typeof when.task === "object" &&
        "anyOf" in when.task &&
        !when.task.anyOf.includes(task.task)
      )
        return false;
      if (typeof when.task === "string" && when.task !== task.task) return false;
    }
    if (
      when.modalities &&
      !when.modalities.every((modality) => request.detectedModalities.includes(modality))
    )
      return false;
    if (when.language) {
      const languages = Array.isArray(when.language) ? when.language : [when.language];
      if (!request.input.language || !languages.includes(request.input.language)) return false;
    }
    if (
      when.metadata &&
      Object.entries(when.metadata).some(([key, value]) => request.metadata?.[key] !== value)
    )
      return false;
    return true;
  });
}

function mergeRouteRequirements(
  constraints: NormalizedRoutingRequest["constraints"],
  require: PolicyRoute["require"],
): NormalizedRoutingRequest["constraints"] {
  if (!require) return constraints;
  return {
    ...constraints,
    requiredCapabilities: Array.from(
      new Set([...(constraints.requiredCapabilities ?? []), ...(require.capabilities ?? [])]),
    ),
    requiredInputModalities: Array.from(
      new Set([...(constraints.requiredInputModalities ?? []), ...(require.inputModalities ?? [])]),
    ),
    ...(require.minContextTokens !== undefined
      ? { minContextTokens: Math.max(constraints.minContextTokens ?? 0, require.minContextTokens) }
      : {}),
    requiredTags: Array.from(
      new Set([...(constraints.requiredTags ?? []), ...(require.tags ?? [])]),
    ),
  };
}

function resolveStrategy(config: StrategyConfig, routeWeights?: StrategyWeights): StrategyConfig {
  if (config.kind === "weighted-score" && routeWeights) return { ...config, weights: routeWeights };
  return config;
}

async function selectModel(
  config: StrategyConfig,
  context: StrategyContext,
  counters: Map<string, number>,
  random: () => number,
  customStrategies: RouterOptions["customStrategies"],
): Promise<StrategyResult & { strategyId: string; strategyVersion: string }> {
  const eligible = context.candidates.filter((candidate) => candidate.eligible);
  if (config.kind === "rules")
    return {
      selectedModelId: eligible[0]?.model.id ?? null,
      reason: "The first eligible candidate in route order was selected.",
      strategyId: config.id ?? "rules",
      strategyVersion: "1",
    };
  if (config.kind === "cheapest-qualified") {
    const known = eligible
      .filter((candidate) => candidate.predicted.cost !== null)
      .sort(
        (a, b) =>
          (a.predicted.cost ?? Number.POSITIVE_INFINITY) -
          (b.predicted.cost ?? Number.POSITIVE_INFINITY),
      );
    const selected =
      known[0] ?? (config.unknownCost === "allow-with-warning" ? eligible[0] : undefined);
    return {
      selectedModelId: selected?.model.id ?? null,
      reason: selected
        ? `Selected the lowest estimated qualified cost (${formatNumber(selected.predicted.cost)} USD).`
        : "No qualified candidate has a usable cost estimate.",
      strategyId: config.id ?? "cheapest-qualified",
      strategyVersion: "1",
    };
  }
  if (config.kind === "fastest-qualified") {
    const known = eligible
      .filter((candidate) => candidate.predicted.latencyMs !== null)
      .sort(
        (a, b) =>
          (a.predicted.latencyMs ?? Number.POSITIVE_INFINITY) -
          (b.predicted.latencyMs ?? Number.POSITIVE_INFINITY),
      );
    const selected =
      known[0] ?? (config.requireObservedLatency === false ? eligible[0] : undefined);
    return {
      selectedModelId: selected?.model.id ?? null,
      reason: selected
        ? `Selected the lowest observed/catalog latency (${formatNumber(selected.predicted.latencyMs)} ms).`
        : "No qualified candidate has observed latency data.",
      strategyId: config.id ?? "fastest-qualified",
      strategyVersion: "1",
    };
  }
  if (config.kind === "priority") {
    const selected = [...eligible].sort(
      (a, b) => (b.model.operational?.priority ?? 0) - (a.model.operational?.priority ?? 0),
    )[0];
    return {
      selectedModelId: selected?.model.id ?? null,
      reason: selected
        ? "Selected the highest-priority healthy qualified candidate."
        : "There are no eligible candidates.",
      strategyId: config.id ?? "priority",
      strategyVersion: "1",
    };
  }
  if (config.kind === "random-weighted") {
    const values = eligible.map((candidate) => ({
      id: candidate.model.id,
      weight: config.weights?.[candidate.model.id] ?? 1,
    }));
    const total = values.reduce((sum, value) => sum + value.weight, 0);
    const source = config.seed === undefined ? random : seededRandom(config.seed);
    let cursor = source() * total;
    const selected = values.find((value) => {
      cursor -= value.weight;
      return cursor <= 0;
    });
    return {
      selectedModelId: selected?.id ?? values[0]?.id ?? null,
      reason: `Selected using a seeded/configured weighted distribution; seed=${config.seed ?? "runtime"}.`,
      strategyId: config.id ?? "random-weighted",
      strategyVersion: "1",
    };
  }
  if (config.kind === "round-robin") {
    const key = context.task.task;
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    const selected = eligible[index % Math.max(1, eligible.length)];
    return {
      selectedModelId: selected?.model.id ?? null,
      reason: `Selected the next eligible deployment in round-robin order (${index + 1}).`,
      strategyId: config.id ?? "round-robin",
      strategyVersion: "1",
    };
  }
  if (config.kind === "cascade") {
    for (const stage of config.stages) {
      const stageCandidates = eligible.filter(
        (candidate) =>
          !stage.model ||
          candidate.model.id === stage.model ||
          stage.candidates?.includes(candidate.model.id),
      );
      if (stageCandidates[0])
        return {
          selectedModelId: stageCandidates[0].model.id,
          reason: `Selected the first eligible cascade stage; acceptance is evaluated during execution.`,
          strategyId: config.id ?? "cascade",
          strategyVersion: "1",
        };
    }
    return {
      selectedModelId: null,
      reason: "No cascade stage has an eligible candidate.",
      strategyId: config.id ?? "cascade",
      strategyVersion: "1",
    };
  }
  if (config.kind === "weighted-score") {
    const weights = normalizeWeights(config.weights);
    const selected = [...eligible].sort(
      (a, b) => (b.scores.total ?? -1) - (a.scores.total ?? -1),
    )[0];
    return {
      selectedModelId: selected?.model.id ?? null,
      reason: selected
        ? `Selected the highest weighted score (${formatNumber(selected.scores.total)}), with weights ${JSON.stringify(weights)}.`
        : "There are no eligible candidates.",
      strategyId: config.id ?? "weighted-score",
      strategyVersion: "1",
    };
  }
  const custom = customStrategies?.find(
    (strategy) => strategy.id === config.id || strategy.id === config.kind,
  );
  if (custom) {
    const selected = await custom.select(context);
    return { ...selected, strategyId: custom.id, strategyVersion: custom.version };
  }
  return {
    selectedModelId: eligible[0]?.model.id ?? null,
    reason: "Unknown strategy kind; selected first eligible candidate as a safe fallback.",
    strategyId: config.id ?? config.kind,
    strategyVersion: "1",
  };
}

function normalizeCandidateScores(candidates: RoutingCandidate[], warnings: string[]): void {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const costs = eligible
    .map((candidate) => candidate.predicted.cost)
    .filter((value): value is number => value !== null && value !== undefined);
  const latencies = eligible
    .map((candidate) => candidate.predicted.latencyMs)
    .filter((value): value is number => value !== null && value !== undefined);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);
  const weights = normalizeWeights(undefined);
  for (const candidate of candidates) {
    if (!candidate.eligible) {
      candidate.scores.total = null;
      continue;
    }
    const costScore =
      candidate.predicted.cost === null || candidate.predicted.cost === undefined
        ? null
        : maxCost === minCost
          ? 1
          : 1 - (candidate.predicted.cost - minCost) / Math.max(Number.EPSILON, maxCost - minCost);
    const latencyScore =
      candidate.predicted.latencyMs === null || candidate.predicted.latencyMs === undefined
        ? null
        : maxLatency === minLatency
          ? 1
          : 1 -
            (candidate.predicted.latencyMs - minLatency) /
              Math.max(Number.EPSILON, maxLatency - minLatency);
    candidate.scores.cost = costScore;
    candidate.scores.latency = latencyScore;
    const components = [
      candidate.scores.taskFit,
      candidate.scores.quality,
      costScore,
      latencyScore,
      candidate.scores.reliability,
    ].filter((value): value is number => value !== null && value !== undefined);
    if (components.length < 5)
      warnings.push(
        `Candidate ${candidate.model.id} has missing score signals; weighted score is partial.`,
      );
    candidate.scores.total =
      weights.taskFit * (candidate.scores.taskFit ?? 0.5) +
      weights.quality * (candidate.scores.quality ?? 0.5) +
      weights.cost * (costScore ?? 0.5) +
      weights.latency * (latencyScore ?? 0.5) +
      weights.reliability * (candidate.scores.reliability ?? 0.5);
  }
}

function normalizeWeights(
  weights: StrategyConfig extends { kind: "weighted-score"; weights?: infer W } ? W : never,
): { taskFit: number; quality: number; cost: number; latency: number; reliability: number };
function normalizeWeights(
  weights:
    | undefined
    | { taskFit?: number; quality?: number; cost?: number; latency?: number; reliability?: number },
): { taskFit: number; quality: number; cost: number; latency: number; reliability: number };
function normalizeWeights(
  weights:
    | { taskFit?: number; quality?: number; cost?: number; latency?: number; reliability?: number }
    | undefined,
) {
  const value = {
    taskFit: weights?.taskFit ?? 0.35,
    quality: weights?.quality ?? 0.25,
    cost: weights?.cost ?? 0.15,
    latency: weights?.latency ?? 0.15,
    reliability: weights?.reliability ?? 0.1,
  };
  const total = Object.values(value).reduce((sum, item) => sum + item, 0);
  return total === 0
    ? { taskFit: 0.2, quality: 0.2, cost: 0.2, latency: 0.2, reliability: 0.2 }
    : (Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, item / total]),
      ) as typeof value);
}

function qualitySignal(model: ModelDefinition, task: string): number {
  const explicit = model.metadata?.qualityByTask?.[task];
  if (typeof explicit === "number") return clamp(explicit);
  if (model.tags?.some((tag) => task.includes(tag) || tag.includes(task))) return 0.85;
  if (task === "unknown" || task === "chat") return 0.6;
  return 0.5;
}

function taskFitSignal(model: ModelDefinition, task: string, preferredTags: string[]): number {
  const tags = model.tags ?? [];
  const preferred = preferredTags.filter((tag) => tags.includes(tag)).length;
  const direct = tags.some((tag) => task.includes(tag) || tag.includes(task));
  return clamp((direct ? 0.8 : 0.5) + Math.min(0.2, preferred * 0.1));
}

function buildFallbackChain(
  policy: RoutingPolicy,
  selectedId: string | null,
  candidates: RoutingCandidate[],
  allowed: boolean,
  maxFallbacks: number,
): RoutingDecision["fallbackChain"] {
  if (!allowed) return [];
  const eligible = new Map(
    candidates
      .filter((candidate) => candidate.eligible)
      .map((candidate) => [candidate.model.id, candidate.model]),
  );
  const result: RoutingDecision["fallbackChain"] = [];
  const seen = new Set<string>(selectedId ? [selectedId] : []);
  const explicit = selectedId
    ? (policy.fallbacks?.find((fallback) => fallback.from === selectedId)?.to ?? [])
    : [];
  const candidatesToTry = [...explicit, ...candidates.map((candidate) => candidate.model.id)];
  for (const modelId of candidatesToTry) {
    if (result.length >= maxFallbacks || seen.has(modelId) || !eligible.has(modelId)) continue;
    seen.add(modelId);
    const model = eligible.get(modelId);
    if (model)
      result.push({
        providerId: model.providerId,
        modelId: model.id,
        reason: explicit.includes(modelId) ? "explicit policy fallback" : "next eligible candidate",
      });
  }
  return result;
}

function validateResponse(
  response: AdapterResponse,
  request: NormalizedRoutingRequest,
): { valid: boolean; errors: string[] } {
  if (!request.output.schema) return { valid: true, errors: [] };
  const value = response.data ?? (response.text ? tryParseJson(response.text) : undefined);
  return validateJsonSchema(value, request.output.schema);
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
function policyRetryMax(policy: RoutingPolicy): number {
  return Math.max(1, Math.min(5, policy.resilience?.retry?.maxAttempts ?? 2));
}
function backoffMs(retry: number, retryAfterMs: number | undefined, random: () => number): number {
  return retryAfterMs ?? Math.min(2_000, 100 * 2 ** retry + Math.round(random() * 100));
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatNumber(value: number | null | undefined): string {
  return value == null ? "unknown" : Number(value.toFixed(6)).toString();
}
function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
function taskSignals(task: TaskClassificationResult): string[] {
  return task.signals?.map((signal) => `Task signal: ${signal}.`) ?? [];
}
function routeReason(route: PolicyRoute | undefined): string[] {
  return route
    ? [`Matched policy route ${route.id}.`]
    : ["No specialized route matched; policy defaults were used."];
}
function constraintsAllowFallback(request: NormalizedRoutingRequest): boolean {
  return request.constraints.fallbackAllowed !== false;
}
function usageScope(request: NormalizedRoutingRequest): {
  type: "request" | "user" | "project" | "period";
  id: string;
} {
  const metadata = request.metadata ?? {};
  if (typeof metadata.userId === "string") return { type: "user", id: metadata.userId };
  if (typeof metadata.projectId === "string") return { type: "project", id: metadata.projectId };
  return { type: "request", id: request.id };
}
async function runHook(
  hook: ((context: RouterHookContext) => void | Promise<void>) | undefined,
  context: RouterHookContext,
): Promise<void> {
  if (hook) await hook(context);
}
async function emitStreamlessAttempt(
  options: RouterOptions,
  requestId: string,
  model: ModelDefinition,
  attempt: number,
  event: string,
): Promise<void> {
  await runHook(options.hooks?.afterSelect, {
    requestId,
    event: `${event}:${model.id}:${attempt}`,
  });
}
function mapAdapterEvent(event: AdapterStreamEvent): RouterEvent[] {
  if (event.type === "text-delta") return [{ type: "text-delta", text: event.text }];
  if (event.type === "tool-call")
    return [
      {
        type: "tool-call",
        name: event.name,
        arguments: event.arguments,
        ...(event.callId ? { callId: event.callId } : {}),
      },
    ];
  if (event.type === "usage") return [{ type: "usage", usage: event.usage }];
  return [];
}
function seededRandom(seed: number): () => number {
  let state = Math.floor(seed) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
