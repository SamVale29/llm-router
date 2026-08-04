import type {
  HealthKey,
  HealthStatus,
  HealthStore,
  NormalizedProviderError,
  BudgetScope,
  BudgetStore,
  BudgetUsage,
  UsageEntry,
} from "./types.js";

interface HealthRecord {
  successes: number;
  failures: number;
  rateLimits: number;
  timeouts: number;
  consecutiveFailures: number;
  latencies: number[];
  lastSuccessAt?: string;
  lastErrorAt?: string;
  openedAt?: number;
}

export function createInMemoryHealthStore(
  options: { failureThreshold?: number; cooldownMs?: number; now?: () => Date } = {},
): HealthStore {
  const records = new Map<string, HealthRecord>();
  const failureThreshold = options.failureThreshold ?? 3;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const getRecord = (key: HealthKey): HealthRecord => {
    const id = `${key.providerId}:${key.modelId}`;
    const current = records.get(id);
    if (current) return current;
    const created: HealthRecord = {
      successes: 0,
      failures: 0,
      rateLimits: 0,
      timeouts: 0,
      consecutiveFailures: 0,
      latencies: [],
    };
    records.set(id, created);
    return created;
  };
  return {
    async get(key) {
      const record = getRecord(key);
      const total = record.successes + record.failures;
      const state =
        record.openedAt === undefined
          ? "closed"
          : now().getTime() - record.openedAt >= cooldownMs
            ? "half-open"
            : "open";
      return {
        state,
        successRate: total === 0 ? 1 : record.successes / total,
        errorRate: total === 0 ? 0 : record.failures / total,
        rateLimitRate: total === 0 ? 0 : record.rateLimits / total,
        timeoutRate: total === 0 ? 0 : record.timeouts / total,
        p50LatencyMs: percentile(record.latencies, 0.5),
        p95LatencyMs: percentile(record.latencies, 0.95),
        ...(record.lastSuccessAt ? { lastSuccessAt: record.lastSuccessAt } : {}),
        ...(record.lastErrorAt ? { lastErrorAt: record.lastErrorAt } : {}),
        consecutiveFailures: record.consecutiveFailures,
      } satisfies HealthStatus;
    },
    async recordSuccess(key, durationMs) {
      const record = getRecord(key);
      record.successes += 1;
      record.consecutiveFailures = 0;
      record.latencies.push(durationMs);
      record.latencies = record.latencies.slice(-200);
      record.lastSuccessAt = now().toISOString();
      record.openedAt = undefined;
    },
    async recordFailure(key, error: NormalizedProviderError, durationMs) {
      const record = getRecord(key);
      record.failures += 1;
      record.consecutiveFailures += 1;
      record.latencies.push(durationMs);
      record.latencies = record.latencies.slice(-200);
      record.lastErrorAt = now().toISOString();
      if (error.code === "rate-limit") record.rateLimits += 1;
      if (error.code === "timeout") record.timeouts += 1;
      if (record.consecutiveFailures >= failureThreshold) record.openedAt = now().getTime();
    },
  };
}

function percentile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function createInMemoryBudgetStore(): BudgetStore {
  const usages = new Map<string, BudgetUsage>();
  return {
    async getUsage(scope) {
      return usages.get(scopeKey(scope)) ?? { scope, amount: 0, currency: "USD" };
    },
    async recordUsage(entry: UsageEntry) {
      const current = usages.get(scopeKey(entry.scope)) ?? {
        scope: entry.scope,
        amount: 0,
        currency: "USD" as const,
      };
      usages.set(scopeKey(entry.scope), { ...current, amount: current.amount + entry.amount });
    },
  };
}

function scopeKey(scope: BudgetScope): string {
  return `${scope.type}:${scope.id}:${scope.periodStart ?? "unbounded"}`;
}
