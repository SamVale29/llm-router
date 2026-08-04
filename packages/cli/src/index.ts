#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogJsonSchema, demoCatalog, validateCatalog } from "@llm-router/catalog";
import { createAnthropicAdapter } from "@llm-router/adapter-anthropic";
import { createGoogleAdapter } from "@llm-router/adapter-google";
import { createOpenAIAdapter } from "@llm-router/adapter-openai";
import { createOpenRouterAdapter } from "@llm-router/adapter-openrouter";
import { createOpenAICompatibleAdapter } from "@llm-router/adapter-openai-compatible";
import {
  createRouter,
  parsePolicyYaml,
  policyJsonSchema,
  type Catalog,
  type ProviderAdapter,
  type RoutingPolicy,
  type RoutingRequest,
} from "@llm-router/core";
import {
  compareReports,
  evaluateDataset,
  parseJsonl,
  replayTraces,
  renderEvalCsv,
  renderEvalHtml,
  renderEvalMarkdown,
  type EvalItem,
  type EvalReport,
  type ReplayTrace,
} from "@llm-router/evals";
import { createProxyServer } from "@llm-router/proxy";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, subcommand, ...rest] = argv;
  const commandArgs = subcommand ? [subcommand, ...rest] : rest;
  try {
    if (command === "init") return await init();
    if (command === "validate") return await validate(commandArgs);
    if (command === "decide" || command === "explain")
      return await decide(commandArgs, command === "explain");
    if (command === "serve") return await serve(commandArgs);
    if (command === "replay") return await replay(commandArgs);
    if (command === "eval" && subcommand === "run") return await evalRun(rest);
    if (command === "eval" && subcommand === "compare") return await evalCompare(rest);
    if (command === "catalog" && subcommand === "validate") return await catalogValidate(rest);
    if (command === "catalog" && subcommand === "build") return await catalogBuild(rest);
    if (command === "doctor") return await doctor(commandArgs);
    printHelp();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function init(): Promise<void> {
  await writeFile("policy.yaml", defaultPolicy, "utf8");
  await writeFile("catalog.json", JSON.stringify(demoCatalog, null, 2), "utf8");
  await writeFile(
    "request.json",
    JSON.stringify(
      {
        messages: [
          {
            role: "user",
            content: "Review this TypeScript function and return structured issues.",
          },
        ],
        hints: { task: "code-review" },
        output: {
          schema: {
            type: "object",
            required: ["issues"],
            properties: { issues: { type: "array" } },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    ".env.example",
    "# Pass provider credentials explicitly to adapters in your application.\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\nGOOGLE_API_KEY=\nOPENROUTER_API_KEY=\n",
    "utf8",
  );
  await writeFile(
    "README.local.md",
    "# Local LLM Router\n\nRun `pnpm cli decide request.json --policy policy.yaml` for a decision-only explanation after building the repository.\n",
    "utf8",
  );
  process.stdout.write(
    "Created policy.yaml, catalog.json, request.json, .env.example and README.local.md.\n",
  );
}

async function validate(args: string[]): Promise<void> {
  const policyPath = args[0] ?? "policy.yaml";
  const policy = await loadPolicy(policyPath, await loadCatalog(valueAfter(args, "--catalog")));
  process.stdout.write(`Policy ${policyPath} is valid (version ${policy.version}).\n`);
}

async function decide(args: string[], explain: boolean): Promise<void> {
  const requestPath = args[0];
  const policyPath = valueAfter(args, "--policy") ?? "policy.yaml";
  const catalog = await loadCatalog(valueAfter(args, "--catalog"));
  if (!requestPath) throw new Error("Usage: llm-router decide request.json --policy policy.yaml");
  const request = JSON.parse(await readFile(resolve(requestPath), "utf8")) as RoutingRequest;
  const policy = await loadPolicy(policyPath, catalog);
  const router = createRouter({ catalog, policy });
  const decision = explain ? await router.explain(request) : await router.decide(request);
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}

async function serve(args: string[]): Promise<void> {
  const policyPath = valueAfter(args, "--policy") ?? "policy.yaml";
  const catalog = await loadCatalog(valueAfter(args, "--catalog"));
  const port = Number(valueAfter(args, "--port") ?? 8787);
  const policy = await loadPolicy(policyPath, catalog);
  const adapters = configuredAdapters(catalog);
  const router = createRouter({ catalog, policy, adapters });
  const proxy = createProxyServer({
    router,
    catalog,
    port,
    authToken: process.env.LLM_ROUTER_PROXY_TOKEN,
    enableCompletions: Object.keys(adapters).length > 0,
    exposeModels: args.includes("--expose-models"),
  });
  process.stdout.write(
    `LLM Router proxy listening at ${proxy.url}. Content logging is disabled.\n`,
  );
  await new Promise<void>(() => undefined);
}

async function replay(args: string[]): Promise<void> {
  const tracePath = args[0];
  const policyPath = valueAfter(args, "--policy") ?? "policy.yaml";
  const catalog = await loadCatalog(valueAfter(args, "--catalog"));
  if (!tracePath) throw new Error("Usage: llm-router replay traces.jsonl --policy policy.yaml");
  const traces = parseJsonl(await readFile(resolve(tracePath), "utf8")) as ReplayTrace[];
  const policy = await loadPolicy(policyPath, catalog);
  const report = await replayTraces(createRouter({ catalog, policy }), policy, traces);
  const output = valueAfter(args, "--output") ?? "replay-report.json";
  await writeFile(resolve(output), JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`Replay report written to ${output}.\n`);
}

async function evalRun(args: string[]): Promise<void> {
  const datasetPath = valueAfter(args, "--dataset");
  const policyPath = valueAfter(args, "--policy") ?? "policy.yaml";
  const catalog = await loadCatalog(valueAfter(args, "--catalog"));
  if (!datasetPath)
    throw new Error("Usage: llm-router eval run --dataset tasks.jsonl --policy policy.yaml");
  const policy = await loadPolicy(policyPath, catalog);
  const dataset = parseJsonl(await readFile(resolve(datasetPath), "utf8")) as EvalItem[];
  const report = await evaluateDataset({
    router: createRouter({ catalog, policy }),
    dataset,
    policy,
  });
  const output = valueAfter(args, "--output") ?? "reports/eval";
  await mkdir(resolve(output), { recursive: true });
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(resolve(output, "report.md"), renderEvalMarkdown(report), "utf8");
  await writeFile(resolve(output, "report.html"), renderEvalHtml(report), "utf8");
  await writeFile(resolve(output, "report.csv"), renderEvalCsv(report), "utf8");
  process.stdout.write(`Evaluation reports written to ${output}.\n`);
}

async function evalCompare(args: string[]): Promise<void> {
  const [baselinePath, candidatePath] = args;
  if (!baselinePath || !candidatePath)
    throw new Error("Usage: llm-router eval compare baseline.json candidate.json");
  const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf8")) as EvalReport;
  const candidate = JSON.parse(await readFile(resolve(candidatePath), "utf8")) as EvalReport;
  const comparison = compareReports(baseline, candidate);
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  if (!comparison.passed) process.exitCode = 2;
}

async function catalogValidate(args: string[]): Promise<void> {
  const catalog = await loadCatalog(valueAfter(args, "--catalog"));
  const issues = validateCatalog(catalog);
  if (issues.length) throw new Error(JSON.stringify(issues, null, 2));
  process.stdout.write("Catalog is valid.\n");
}

async function catalogBuild(args: string[]): Promise<void> {
  const output = valueAfter(args, "--output") ?? ".";
  await mkdir(resolve(output), { recursive: true });
  await writeFile(
    resolve(output, "catalog.schema.json"),
    JSON.stringify(catalogJsonSchema(), null, 2),
    "utf8",
  );
  await writeFile(
    resolve(output, "policy.schema.json"),
    JSON.stringify(policyJsonSchema(), null, 2),
    "utf8",
  );
  process.stdout.write(`Schemas written to ${output}.\n`);
}

async function doctor(args: string[]): Promise<void> {
  const policyPath = valueAfter(args, "--policy");
  const catalog = await loadCatalog(valueAfter(args, "--catalog"));
  const checks = [
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 20,
      detail: process.versions.node,
    },
    {
      name: "catalog",
      ok: validateCatalog(catalog).length === 0,
      detail: `${catalog.models.length} models`,
    },
    {
      name: "openai key configured",
      ok: Boolean(process.env.OPENAI_API_KEY),
      detail: "value hidden",
    },
    {
      name: "anthropic key configured",
      ok: Boolean(process.env.ANTHROPIC_API_KEY),
      detail: "value hidden",
    },
  ];
  if (policyPath) {
    try {
      await loadPolicy(policyPath, catalog);
      checks.push({ name: "policy", ok: true, detail: policyPath });
    } catch {
      checks.push({ name: "policy", ok: false, detail: policyPath });
    }
  }
  process.stdout.write(
    `${checks.map((check) => `${check.ok ? "OK" : "WARN"} ${check.name}: ${check.detail}`).join("\n")}\n`,
  );
  if (
    checks.some(
      (check) =>
        !check.ok &&
        check.name !== "openai key configured" &&
        check.name !== "anthropic key configured",
    )
  )
    process.exitCode = 1;
}

async function loadPolicy(path: string, catalog: Catalog = demoCatalog): Promise<RoutingPolicy> {
  return parsePolicyYaml(await readFile(resolve(path), "utf8"), catalog);
}
async function loadCatalog(path?: string): Promise<Catalog> {
  if (!path) return demoCatalog;
  const catalog = JSON.parse(await readFile(resolve(path), "utf8")) as Catalog;
  const issues = validateCatalog(catalog);
  if (issues.length) throw new Error(JSON.stringify(issues, null, 2));
  return catalog;
}

function configuredAdapters(catalog: Catalog): Record<string, ProviderAdapter> {
  const adapters: Record<string, ProviderAdapter> = {};
  for (const provider of catalog.providers) {
    if (provider.adapter === "openai" && process.env.OPENAI_API_KEY)
      adapters[provider.adapter] = createOpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY });
    if (provider.adapter === "openrouter" && process.env.OPENROUTER_API_KEY)
      adapters[provider.adapter] = createOpenRouterAdapter({
        apiKey: process.env.OPENROUTER_API_KEY,
      });
    if (provider.adapter === "anthropic" && process.env.ANTHROPIC_API_KEY)
      adapters[provider.adapter] = createAnthropicAdapter({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    if (provider.adapter === "google" && process.env.GOOGLE_API_KEY)
      adapters[provider.adapter] = createGoogleAdapter({ apiKey: process.env.GOOGLE_API_KEY });
    if (provider.adapter === "openai-compatible" && process.env.OPENAI_COMPATIBLE_ENDPOINT)
      adapters[provider.adapter] = createOpenAICompatibleAdapter({
        endpoint: process.env.OPENAI_COMPATIBLE_ENDPOINT,
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
      });
  }
  return adapters;
}
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
function printHelp(): void {
  process.stdout.write(
    "LLM Router CLI\n\nCommands: init | validate | decide | explain | serve | replay | eval run | eval compare | catalog validate | catalog build | doctor\n",
  );
}

const defaultPolicy = `version: "1.0.0"\ndefaults:\n  strategy: weighted-score\n  fallbackAllowed: true\nmodels:\n  - id: demo-code-pro\n    provider: demo-openai\n    model: demo-code-pro\n  - id: demo-economy\n    provider: demo-openrouter\n    model: demo-economy\n  - id: demo-vision\n    provider: demo-google\n    model: demo-vision\n  - id: demo-long-context\n    provider: demo-anthropic\n    model: demo-long-context\nroutes:\n  - id: code\n    when:\n      task: code-review\n    require:\n      capabilities: [structured-outputs]\n    prefer:\n      tags: [code]\n    select:\n      strategy:\n        kind: weighted-score\n        weights:\n          taskFit: 0.45\n          quality: 0.30\n          cost: 0.15\n          latency: 0.10\n  - id: translation\n    when:\n      task: translation\n    select:\n      strategy: cheapest-qualified\n  - id: vision\n    when:\n      task: ocr\n    require:\n      inputModalities: [image]\n    select:\n      strategy: cheapest-qualified\n      candidates: [demo-vision]\n  - id: long-summary\n    when:\n      task: long-document-summarization\n    require:\n      minContextTokens: 100000\n    select:\n      strategy: weighted-score\nfallbacks:\n  - from: demo-code-pro\n    to: [demo-long-context, demo-economy]\n    on: [rate-limit, timeout, unavailable]\nresilience:\n  deadlineMs: 20000\n  retry:\n    maxAttempts: 2\n    retryableErrors: [rate-limit, timeout, unavailable]\n  fallback:\n    maxModelFallbacks: 2\n    errors: [rate-limit, timeout, unavailable]\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
