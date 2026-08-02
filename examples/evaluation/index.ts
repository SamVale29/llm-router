import { readFile } from "node:fs/promises";
import { createRouter, parsePolicyYaml } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";
import { evaluateDataset, parseJsonl, renderEvalMarkdown } from "@llm-router/evals";

const policy = parsePolicyYaml(
  await readFile("fixtures/policies/default.yaml", "utf8"),
  demoCatalog,
);
const dataset = parseJsonl(await readFile("fixtures/evals/tasks.jsonl", "utf8"));
const report = await evaluateDataset({
  router: createRouter({ catalog: demoCatalog, policy }),
  policy,
  dataset: dataset as never[],
});
console.log(renderEvalMarkdown(report));
