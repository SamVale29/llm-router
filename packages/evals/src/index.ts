import type { RoutingDecision, RoutingPolicy, RoutingRequest, Router } from "@llm-router/core";

export interface EvalItem {
  id: string;
  task: string;
  input: { messages: RoutingRequest["messages"] };
  expected?: { type?: string; value?: unknown; regex?: string; schema?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
}

export interface EvalRow {
  id: string;
  task: string;
  selectedModelId: string | null;
  estimatedCost: number | null;
  estimatedLatencyMs: number | null;
  eligibleCandidateCount: number;
  constraintViolation: boolean;
  qualityScore: number | null;
  routingOverheadMs: number;
}

export interface EvalReport {
  version: "1";
  policyVersion: string;
  generatedAt: string;
  summary: {
    total: number;
    selected: number;
    averageEstimatedCost: number | null;
    totalEstimatedCost: number | null;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
    fallbackRate: number;
    errorRate: number;
    constraintViolationRate: number;
    routingOverheadP50Ms: number | null;
    savingsVsBaseline: number | null;
    qualityDeltaVsBaseline: number | null;
  };
  rows: EvalRow[];
  notes: string[];
}

export interface EvaluateOptions {
  router: Router;
  dataset: EvalItem[];
  policy: RoutingPolicy;
  baselineCosts?: Record<string, number>;
  baselineQuality?: Record<string, number>;
  evaluateQuality?: (item: EvalItem, decision: RoutingDecision) => number | null;
}

export async function evaluateDataset(options: EvaluateOptions): Promise<EvalReport> {
  const rows: EvalRow[] = [];
  for (const item of options.dataset) {
    const started = performance.now();
    try {
      const decision = await options.router.decide({
        messages: item.input.messages,
        hints: { task: item.task },
        metadata: item.metadata,
      });
      const routingOverheadMs = performance.now() - started;
      rows.push({
        id: item.id,
        task: item.task,
        selectedModelId: decision.selected?.modelId ?? null,
        estimatedCost: decision.estimates.cost ?? null,
        estimatedLatencyMs: decision.estimates.latencyMs ?? null,
        eligibleCandidateCount: decision.candidates.filter((candidate) => candidate.eligible)
          .length,
        constraintViolation: decision.selected === null,
        qualityScore: options.evaluateQuality?.(item, decision) ?? null,
        routingOverheadMs,
      });
    } catch {
      rows.push({
        id: item.id,
        task: item.task,
        selectedModelId: null,
        estimatedCost: null,
        estimatedLatencyMs: null,
        eligibleCandidateCount: 0,
        constraintViolation: true,
        qualityScore: null,
        routingOverheadMs: performance.now() - started,
      });
    }
  }
  const costs = rows
    .map((row) => row.estimatedCost)
    .filter((value): value is number => value !== null);
  const latencies = rows
    .map((row) => row.estimatedLatencyMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const overhead = rows.map((row) => row.routingOverheadMs).sort((a, b) => a - b);
  const baselineTotal = options.baselineCosts
    ? options.dataset.reduce((sum, item) => sum + (options.baselineCosts?.[item.id] ?? 0), 0)
    : null;
  const selectedQuality = rows
    .map((row) => row.qualityScore)
    .filter((value): value is number => value !== null);
  const baselineQuality = options.baselineQuality
    ? options.dataset
        .map((item) => options.baselineQuality?.[item.id])
        .filter((value): value is number => value !== undefined)
    : [];
  const totalCost = costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
  return {
    version: "1",
    policyVersion: options.policy.version,
    generatedAt: new Date().toISOString(),
    summary: {
      total: rows.length,
      selected: rows.filter((row) => row.selectedModelId !== null).length,
      averageEstimatedCost: totalCost === null ? null : totalCost / Math.max(1, costs.length),
      totalEstimatedCost: totalCost,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      fallbackRate: 0,
      errorRate:
        rows.filter((row) => row.selectedModelId === null).length / Math.max(1, rows.length),
      constraintViolationRate:
        rows.filter((row) => row.constraintViolation).length / Math.max(1, rows.length),
      routingOverheadP50Ms: percentile(overhead, 0.5),
      savingsVsBaseline:
        baselineTotal !== null && totalCost !== null && baselineTotal > 0
          ? (baselineTotal - totalCost) / baselineTotal
          : null,
      qualityDeltaVsBaseline:
        selectedQuality.length && baselineQuality.length
          ? average(selectedQuality) - average(baselineQuality)
          : null,
    },
    rows,
    notes: [
      "Decision-only evaluation does not call providers by default.",
      "Estimated cost is not provider billing; compare quality and latency alongside cost.",
      "Demo catalog values are illustrative and should be replaced with workload observations.",
    ],
  };
}

export interface ReplayTrace {
  id: string;
  request: RoutingRequest;
  decision?: RoutingDecision;
  metadata?: Record<string, unknown>;
}
export interface ReplayRow {
  id: string;
  previousModelId: string | null;
  candidateModelId: string | null;
  changed: boolean;
  previousCost: number | null;
  candidateCost: number | null;
  constraintRegression: boolean;
}
export interface ReplayReport {
  version: "1";
  policyVersion: string;
  rows: ReplayRow[];
  distribution: Record<string, number>;
  notes: string[];
}

export async function replayTraces(
  router: Router,
  policy: RoutingPolicy,
  traces: ReplayTrace[],
): Promise<ReplayReport> {
  const rows: ReplayRow[] = [];
  const distribution: Record<string, number> = {};
  for (const trace of traces) {
    const decision = await router.decide({
      ...trace.request,
      metadata: { ...(trace.request.metadata ?? {}), ...(trace.metadata ?? {}) },
    });
    const candidateModelId = decision.selected?.modelId ?? null;
    if (candidateModelId)
      distribution[candidateModelId] = (distribution[candidateModelId] ?? 0) + 1;
    rows.push({
      id: trace.id,
      previousModelId: trace.decision?.selected?.modelId ?? null,
      candidateModelId,
      changed: (trace.decision?.selected?.modelId ?? null) !== candidateModelId,
      previousCost: trace.decision?.estimates.cost ?? null,
      candidateCost: decision.estimates.cost ?? null,
      constraintRegression: decision.selected === null,
    });
  }
  return {
    version: "1",
    policyVersion: policy.version,
    rows,
    distribution,
    notes: [
      "Replay is decision-only unless the caller explicitly executes providers.",
      "Constraint regressions are cases with no selected model.",
    ],
  };
}

export function parseJsonl(source: string): unknown[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
export function renderEvalMarkdown(report: EvalReport): string {
  return [
    `# Evaluation report`,
    ``,
    `Policy: \`${report.policyVersion}\``,
    ``,
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Total | ${report.summary.total} |`,
    `| Selected | ${report.summary.selected} |`,
    `| Estimated cost | ${format(report.summary.totalEstimatedCost)} USD |`,
    `| Average estimated cost | ${format(report.summary.averageEstimatedCost)} USD |`,
    `| P50 latency | ${format(report.summary.p50LatencyMs)} ms |`,
    `| P95 latency | ${format(report.summary.p95LatencyMs)} ms |`,
    `| Constraint violation rate | ${(report.summary.constraintViolationRate * 100).toFixed(2)}% |`,
    `| Savings vs baseline | ${formatPercent(report.summary.savingsVsBaseline)} |`,
    `| Quality delta vs baseline | ${formatPercent(report.summary.qualityDeltaVsBaseline)} |`,
    ``,
    ...report.notes.map((note) => `> ${note}`),
  ].join("\n");
}
export function renderEvalHtml(report: EvalReport): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>LLM Router evaluation</title><style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.5rem;text-align:left}</style></head><body><h1>LLM Router evaluation</h1><p>Policy <code>${escapeHtml(report.policyVersion)}</code></p><table><tbody>${Object.entries(
    report.summary,
  )
    .map(
      ([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table><h2>Notes</h2><ul>${report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></body></html>`;
}
export function renderEvalCsv(report: EvalReport): string {
  return [
    "id,task,selectedModelId,estimatedCost,estimatedLatencyMs,eligibleCandidateCount,constraintViolation,qualityScore,routingOverheadMs",
    ...report.rows.map((row) =>
      [
        row.id,
        row.task,
        row.selectedModelId ?? "",
        row.estimatedCost ?? "",
        row.estimatedLatencyMs ?? "",
        row.eligibleCandidateCount,
        row.constraintViolation,
        row.qualityScore ?? "",
        row.routingOverheadMs,
      ]
        .map(csv)
        .join(","),
    ),
  ].join("\n");
}
export function compareReports(
  baseline: EvalReport,
  candidate: EvalReport,
): {
  costDelta: number | null;
  qualityDelta: number | null;
  p95LatencyDelta: number | null;
  passed: boolean;
  failures: string[];
} {
  const failures: string[] = [];
  const costDelta = ratio(
    candidate.summary.totalEstimatedCost,
    baseline.summary.totalEstimatedCost,
  );
  const qualityDelta =
    (candidate.summary.qualityDeltaVsBaseline ?? 0) -
    (baseline.summary.qualityDeltaVsBaseline ?? 0);
  const p95LatencyDelta = ratio(candidate.summary.p95LatencyMs, baseline.summary.p95LatencyMs);
  const gates = {
    maxQualityDrop: 0.01,
    minCostReduction: 0,
    maxConstraintViolations: 0,
    maxP95LatencyIncrease: 0.05,
  };
  if (qualityDelta < -gates.maxQualityDrop) failures.push("quality drop exceeded gate");
  if (costDelta !== null && -costDelta < gates.minCostReduction)
    failures.push("cost reduction gate not met");
  if (candidate.summary.constraintViolationRate > gates.maxConstraintViolations)
    failures.push("constraint violation gate exceeded");
  if (p95LatencyDelta !== null && p95LatencyDelta > gates.maxP95LatencyIncrease)
    failures.push("P95 latency increase gate exceeded");
  return { costDelta, qualityDelta, p95LatencyDelta, passed: failures.length === 0, failures };
}

function percentile(values: number[], fraction: number): number | null {
  return values.length
    ? (values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? null)
    : null;
}
function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function ratio(value: number | null, baseline: number | null): number | null {
  return value === null || baseline === null || baseline === 0
    ? null
    : (value - baseline) / baseline;
}
function format(value: number | null): string {
  return value === null ? "unknown" : value.toFixed(6);
}
function formatPercent(value: number | null): string {
  return value === null ? "unknown" : `${(value * 100).toFixed(2)}%`;
}
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function csv(value: unknown): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
