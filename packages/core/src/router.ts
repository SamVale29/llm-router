import { checkCompatibility } from "./compatibility.js";
import { estimateRequestCost } from "./cost.js";
import { NoEligibleModelError, normalizedErrorFromUnknown } from "./errors.js";
import { createInMemoryBudgetStore, createInMemoryHealthStore } from "./health.js";
import { sha256, stableStringify } from "./hash.js";
import { DEFAULT_NON_TEXT_PART_TOKENS, normalizeRequest } from "./normalize.js";
import { validatePolicy } from "./policy.js";
import { validateJsonSchema } from "./schema.js";
import { detectTask } from "./tasks.js";
import type {
  AdapterResponse,
  AdapterUsage,
  ToolCall,
  CascadeStage,
  AdapterStreamEvent,
  Catalog,
  ExecutionContext,
  ExecutionResult,
  ModelDefinition,
  NormalizedProviderError,
  NormalizedRoutingRequest,
  PolicyRoute,
  ProviderAttempt,
  ProviderAdapter,
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
let requestSequence = 0;

function createRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `request-${uuid}`;

  requestSequence = (requestSequence + 1) % 0x1_0000_0000;
  return `request-${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createRouter(options: RouterOptions): Router {
  validatePolicy(options.policy, options.catalog);
  if (options.executeShadowRequests)
    throw new Error(
      "executeShadowRequests is unsupported; shadow() evaluates decisions without provider calls.",
    );
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
    const requestId = request.id ?? createRequestId();
    await runHook(options.hooks?.beforeNormalize, { requestId, event: "beforeNormalize" });
    const normalized = normalizeRequest(
      { ...request, ...(request.id ? {} : { id: requestId }) },
      options.tokenEstimation,
    );
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
    const models = [...selectedIdSet].flatMap(
      (id) => policyModels.find((model) => model.id === id) ?? [],
    );
    const warnings: string[] = [];
    if (
      normalized.inputTokenEstimate?.source === "default" &&
      normalized.inputTokenEstimate.nonTextParts > 0
    )
      warnings.push(
        `Input token estimate uses the default ${DEFAULT_NON_TEXT_PART_TOKENS} tokens per non-text part; provide input.estimatedTokens or configure tokenEstimation.nonTextPartTokens for a calibrated estimate.`,
      );
    const budgetScope = usageScope(effectiveRequest, now());
    if (constraints.maxMonthlyBudget !== undefined && !hasExplicitBudgetScope(effectiveRequest))
      warnings.push(
        "maxMonthlyBudget is enforced against the router-wide monthly scope because no userId or projectId was provided.",
      );
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
        model.metadata?.observedP95LatencyMs === undefined &&
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
    const strategy = resolveStrategy(
      route?.select.strategy ?? policy.defaults?.strategy ?? { kind: "weighted-score" },
      route?.select.weights,
    );
    normalizeCandidateScores(
      candidates,
      warnings,
      strategy.kind === "weighted-score" ? strategy.weights : undefined,
    );
    await runHook(options.hooks?.beforeSelect, {
      requestId: normalized.id,
      task,
      event: "beforeSelect",
    });
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
      constraints.fallbackAllowed !== false && policy.defaults?.fallbackAllowed !== false,
      policy.resilience?.fallback?.maxModelFallbacks ?? 2,
    );
    const hashInput = { ...effectiveRequest, id: undefined, signal: undefined };
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
    for await (const event of run(request, false)) {
      if (event.type === "complete") return event.result as ExecutionResult<T>;
      if (event.type === "error")
        throw new NoEligibleModelError(event.error.message, { error: event.error });
    }
    throw new NoEligibleModelError("Execution did not complete.");
  }

  async function* stream(request: RoutingRequest): AsyncIterable<RouterEvent> {
    yield* run(request, true);
  }

  // A single decision and lifecycle for normal and streaming execution.
  async function* run(request: RoutingRequest, streaming: boolean): AsyncGenerator<RouterEvent> {
    if (options.decisionOnly) {
      yield {
        type: "error",
        error: executionError(
          "permission",
          "Provider execution is disabled in decision-only mode.",
        ),
      };
      return;
    }
    const started = performance.now();
    const deadlineMs = options.policy.resilience?.deadlineMs ?? 20_000;
    const controller = new AbortController();
    const signal = controller.signal;
    const cancel = () => controller.abort(executionError("cancelled", "Request cancelled."));
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const timer = setTimeout(
      () => controller.abort(executionError("timeout", "Global execution deadline exceeded.")),
      deadlineMs,
    );
    const attempts: ProviderAttempt[] = [];
    let emitted = false;
    let lastError: NormalizedProviderError | undefined;
    try {
      const decision = await abortable(decide(request), signal);
      yield { type: "decision", decision };
      if (!decision.selected)
        throw executionError("invalid-request", "No eligible model was selected.");
      const normalized = normalizeRequest(
        { ...request, id: decision.requestId },
        options.tokenEstimation,
      );
      const task: TaskClassificationResult = {
        task: decision.task.type,
        source: decision.task.source,
      };
      const route = findRoute(options.policy, normalized, task);
      const strategy = route?.select.strategy ?? options.policy.defaults?.strategy;
      const cascade = strategy?.kind === "cascade" ? strategy : undefined;
      const qualified = decision.candidates.filter((candidate) => candidate.eligible);
      const byId = new Map(qualified.map((candidate) => [candidate.model.id, candidate]));
      const plan: Array<{ modelId: string; accept?: CascadeStage["accept"] }> = cascade
        ? cascade.stages
            .flatMap((stage) => {
              const ids = stage.model
                ? [stage.model]
                : (stage.candidates ?? qualified.map((c) => c.model.id));
              const id = ids.find((id) => byId.has(id));
              return id ? [{ modelId: id, accept: stage.accept }] : [];
            })
            .filter(
              (entry, index, all) =>
                all.findIndex((other) => other.modelId === entry.modelId) === index,
            )
        : [decision.selected.modelId, ...decision.fallbackChain.map((entry) => entry.modelId)].map(
            (modelId) => ({ modelId }),
          );
      const scope = usageScope(normalized, now());
      const fallbackAllowed =
        normalized.constraints.fallbackAllowed !== false &&
        options.policy.defaults?.fallbackAllowed !== false;
      const fallbackCodes = options.policy.resilience?.fallback?.errors ?? [
        "rate-limit",
        "timeout",
        "unavailable",
      ];
      const retryCodes = options.policy.resilience?.retry?.retryableErrors ?? [
        "rate-limit",
        "timeout",
        "unavailable",
        "connection",
      ];
      await runHook(options.hooks?.beforeExecute, {
        requestId: decision.requestId,
        decision,
        event: "beforeExecute",
      });
      for (let stageIndex = 0; stageIndex < plan.length; stageIndex++) {
        const stage = plan[stageIndex];
        const candidate = stage ? byId.get(stage.modelId) : undefined;
        if (!stage || !candidate) continue;
        const model = candidate.model;
        const provider = options.catalog.providers.find((item) => item.id === model.providerId);
        const adapter = adapterByProvider.get(model.providerId);
        let rejectedByCascade = false;
        for (let retry = 0; retry < policyRetryMax(options.policy); retry++) {
          throwIfAborted(signal);
          const attemptStarted = performance.now();
          const attemptDate = now().toISOString();
          const attempt = attempts.length + 1;
          let reservation: string | undefined;
          let dispatched = false;
          let reconciled = false;
          let usage: AdapterUsage | undefined;
          let response: AdapterResponse | undefined;
          let iterator: AsyncIterator<AdapterStreamEvent> | undefined;
          const estimate = candidate.predicted.cost ?? null;
          // Reserve for every paid attempt, including retries and rejected cascade stages.
          const settle = async (): Promise<void> => {
            if (reconciled) return;
            reconciled = true;
            const wasDispatched = dispatched;
            dispatched = false;
            const amount = wasDispatched ? observedCost(usage, model, estimate) : 0;
            try {
              if (reservation) {
                await budgetStore.settle!(reservation, amount);
                reservation = undefined;
              } else if (wasDispatched && amount > 0) {
                await budgetStore.recordUsage({
                  scope,
                  amount,
                  currency: "USD",
                  requestId: decision.requestId,
                  modelId: model.id,
                });
              }
            } catch {
              throw executionError(
                "permission",
                "Budget reconciliation failed; execution stopped.",
              );
            }
          };
          try {
            if (!provider || !adapter)
              throw executionError(
                "unavailable",
                `No adapter is registered for provider ${model.providerId}.`,
              );
            adapter.validateModel(model);
            const limit = normalized.constraints.maxMonthlyBudget;
            if (limit !== undefined) {
              if (!budgetStore.reserve || !budgetStore.settle)
                throw executionError(
                  "permission",
                  "Budget ceilings require an atomic reserve/settle BudgetStore.",
                );
              if (estimate === null)
                throw executionError("quota", "Cannot reserve unknown request cost.");
              reservation =
                (await budgetStore.reserve(
                  {
                    scope,
                    amount: estimate,
                    currency: "USD",
                    requestId: decision.requestId,
                    modelId: model.id,
                  },
                  limit,
                )) ?? undefined;
              if (!reservation)
                throw executionError("quota", "Monthly budget reservation rejected.");
            }
            throwIfAborted(signal);
            const attemptRequest = {
              ...normalized,
              output: {
                ...normalized.output,
                maxTokens: normalized.output.maxTokens ?? candidate.predicted.outputTokens ?? 512,
              },
            };
            const context: ExecutionContext = {
              signal,
              requestId: decision.requestId,
              attempt,
              timeoutMs: Math.max(0, deadlineMs - (performance.now() - started)),
              providerOptions:
                normalized.providerOptions?.[
                  provider.adapter as keyof NonNullable<RoutingRequest["providerOptions"]>
                ],
            };
            await runHook(options.hooks?.onAttemptStart, {
              requestId: decision.requestId,
              decision,
              event: "onAttemptStart",
            });
            throwIfAborted(signal);
            yield {
              type: "attempt-start",
              providerId: model.providerId,
              modelId: model.id,
              attempt,
            };
            dispatched = true;
            const buffered = normalized.output.schema !== undefined || !!stage.accept;
            const pending: RouterEvent[] = [];
            if (streaming && adapter.stream) {
              let text = "";
              const toolCalls: ToolCall[] = [];
              iterator = adapter.stream(attemptRequest, model, context)[Symbol.asyncIterator]();
              while (true) {
                const item = await abortable(iterator.next(), signal);
                if (item.done) break;
                const event = item.value;
                if (event.type === "text-delta") text += event.text;
                if (text.length > 8_000_000)
                  throw executionError("invalid-request", "Provider stream exceeds output limit.");
                if (event.type === "tool-call")
                  toolCalls.push({
                    callId: event.callId ?? `call-${toolCalls.length}`,
                    name: event.name,
                    arguments: event.arguments,
                  });
                if (event.type === "usage") usage = { ...usage, ...event.usage };
                if (event.type === "complete" && event.response) {
                  response = event.response;
                  usage = { ...usage, ...event.response.usage };
                }
                for (const output of mapAdapterEvent(event)) {
                  if (buffered) pending.push(output);
                  else {
                    if (output.type === "text-delta" || output.type === "tool-call") emitted = true;
                    yield output;
                  }
                }
              }
              response = { data: text, text, toolCalls, ...response, usage };
            } else {
              response = await abortable(adapter.execute(attemptRequest, model, context), signal);
              usage = response.usage;
            }
            await settle();
            throwIfAborted(signal);
            const validation = validateResponse(response, normalized);
            if (!validation.valid)
              throw executionError(
                "invalid-request",
                `Provider response failed local schema validation: ${validation.errors.join("; ")}`,
              );
            if (stage.accept && !acceptResponse(response, stage.accept)) {
              rejectedByCascade = true;
              throw executionError(
                "invalid-request",
                "Cascade response did not satisfy the stage acceptance criterion.",
              );
            }
            const durationMs = performance.now() - attemptStarted;
            attempts.push({
              providerId: model.providerId,
              modelId: model.id,
              attempt,
              startedAt: attemptDate,
              durationMs,
              ok: true,
            });
            await healthStore.recordSuccess(
              { providerId: model.providerId, modelId: model.id },
              durationMs,
            );
            if (streaming) {
              if (adapter.stream) {
                for (const event of pending) yield event;
              } else {
                const text =
                  response.text ?? (typeof response.data === "string" ? response.data : undefined);
                if (text) yield { type: "text-delta", text };
                for (const tool of response.toolCalls ?? []) yield { type: "tool-call", ...tool };
                if (usage) yield { type: "usage", usage };
              }
            }
            const result: ExecutionResult = {
              decision,
              response:
                normalized.output.schema !== undefined ? responseValue(response) : response.data,
              text: response.text,
              toolCalls: response.toolCalls,
              usage,
              execution: {
                attempts,
                selectedAttempt: attempt,
                totalDurationMs: performance.now() - started,
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
            yield { type: "complete", result };
            return;
          } catch (cause) {
            lastError = signal.aborted
              ? normalizedErrorFromUnknown(signal.reason)
              : adapter
                ? adapter.normalizeError(cause)
                : normalizedErrorFromUnknown(cause);
            const durationMs = performance.now() - attemptStarted;
            attempts.push({
              providerId: model.providerId,
              modelId: model.id,
              attempt,
              startedAt: attemptDate,
              durationMs,
              ok: false,
              error: lastError,
            });
            if (dispatched)
              await healthStore.recordFailure(
                { providerId: model.providerId, modelId: model.id },
                lastError,
                durationMs,
              );
            await runHook(options.hooks?.onAttemptError, {
              requestId: decision.requestId,
              decision,
              event: "onAttemptError",
            });
            await settle();
            if (
              emitted ||
              rejectedByCascade ||
              signal.aborted ||
              !lastError.retryable ||
              !retryCodes.includes(lastError.code) ||
              retry + 1 >= policyRetryMax(options.policy)
            )
              break;
            const waitMs = backoffMs(retry, lastError.retryAfterMs, random, options.policy);
            const remaining = deadlineMs - (performance.now() - started);
            if (waitMs >= remaining)
              throw executionError("timeout", "Retry would exceed global execution deadline.");
            await abortableDelay(waitMs, signal);
          } finally {
            // Consumer return() also runs this path: stop network activity before reconciling usage.
            if (dispatched && !signal.aborted)
              controller.abort(executionError("cancelled", "Stream consumer stopped."));
            if (iterator?.return) void iterator.return().catch(() => undefined);
            await settle();
          }
        }
        const next = plan[stageIndex + 1];
        const rule = options.policy.fallbacks?.find((rule) => rule.from === model.id);
        const permitted = rejectedByCascade
          ? !!cascade
          : !!lastError?.fallbackEligible &&
            fallbackCodes.includes(lastError.code) &&
            (!rule ||
              (!!next && rule.to.includes(next.modelId) && rule.on.includes(lastError.code)));
        if (
          !next ||
          emitted ||
          signal.aborted ||
          !fallbackAllowed ||
          !permitted ||
          stageIndex >= (options.policy.resilience?.fallback?.maxModelFallbacks ?? 2)
        )
          break;
        await runHook(options.hooks?.onFallback, {
          requestId: decision.requestId,
          decision,
          event: "onFallback",
        });
        yield {
          type: "fallback",
          fromModelId: model.id,
          toModelId: next.modelId,
          reason: lastError?.message ?? "Cascade escalation",
        };
      }
      throw lastError ?? executionError("unavailable", "All model attempts failed.");
    } catch (cause) {
      yield { type: "error", error: normalizedErrorFromUnknown(cause) };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
      if (!signal.aborted) controller.abort(executionError("cancelled", "Execution closed."));
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
    const source =
      config.seed === undefined
        ? random
        : seededRandom((config.seed ^ stringSeed(context.request.id)) >>> 0);
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
      const ids = stage.model
        ? [stage.model]
        : (stage.candidates ?? eligible.map((candidate) => candidate.model.id));
      const stageCandidates = ids.flatMap(
        (id) => eligible.find((candidate) => candidate.model.id === id) ?? [],
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

function normalizeCandidateScores(
  candidates: RoutingCandidate[],
  warnings: string[],
  configuredWeights?: StrategyWeights,
): void {
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
  const weights = normalizeWeights(configuredWeights);
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
  if (request.output.schema === undefined) return { valid: true, errors: [] };
  const value = responseValue(response);
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
function backoffMs(
  retry: number,
  retryAfterMs: number | undefined,
  random: () => number,
  policy: RoutingPolicy,
): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) return Math.max(0, retryAfterMs);
  const base = policy.resilience?.retry?.baseDelayMs ?? 100;
  const max = policy.resilience?.retry?.maxDelayMs ?? 2000;
  return Math.min(max, base * 2 ** retry + Math.round(random() * base));
}
function executionError(
  code: NormalizedProviderError["code"],
  message: string,
): NormalizedProviderError {
  const retryable = ["timeout", "unavailable", "connection", "rate-limit"].includes(code);
  return { code, message, retryable, fallbackEligible: retryable };
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw signal.reason;
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
function responseValue(response: AdapterResponse): unknown {
  return response.text !== undefined
    ? tryParseJson(response.text)
    : typeof response.data === "string"
      ? tryParseJson(response.data)
      : response.data;
}
function acceptResponse(
  response: AdapterResponse,
  accept: NonNullable<CascadeStage["accept"]>,
): boolean {
  return accept.type === "regex"
    ? new RegExp(accept.pattern).test(
        response.text ??
          (typeof response.data === "string" ? response.data : JSON.stringify(response.data)),
      )
    : validateJsonSchema(responseValue(response), accept.schema).valid;
}
function observedCost(
  usage: AdapterUsage | undefined,
  model: ModelDefinition,
  estimate: number | null,
): number {
  if (usage?.cost !== undefined && Number.isFinite(usage.cost) && usage.cost >= 0)
    return usage.cost;
  if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined) {
    const actual = estimateRequestCost({
      model,
      estimatedInputTokens: usage.inputTokens,
      estimatedOutputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
    }).total;
    if (actual !== null && Number.isFinite(actual) && actual >= 0) return actual;
  }
  // Unknown billing is conservatively charged at the reserved estimate, never silently free.
  return estimate ?? 0;
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
function usageScope(
  request: NormalizedRoutingRequest,
  date: Date,
): {
  type: "user" | "project" | "period";
  id: string;
  periodStart: string;
} {
  const metadata = request.metadata ?? {};
  const periodStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
  ).toISOString();
  if (typeof metadata.userId === "string")
    return { type: "user", id: metadata.userId, periodStart };
  if (typeof metadata.projectId === "string")
    return { type: "project", id: metadata.projectId, periodStart };
  return { type: "period", id: "global", periodStart };
}
function hasExplicitBudgetScope(request: NormalizedRoutingRequest): boolean {
  const metadata = request.metadata ?? {};
  return typeof metadata.userId === "string" || typeof metadata.projectId === "string";
}
async function runHook(
  hook: ((context: RouterHookContext) => void | Promise<void>) | undefined,
  context: RouterHookContext,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(context);
  } catch {
    // Hooks are observability extensions and must not change routing behavior.
  }
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
function stringSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
