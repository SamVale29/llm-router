import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRouter, parsePolicyYaml } from "../packages/core/src/index";
import { demoCatalog } from "../packages/catalog/src/index";
import {
  evaluateDataset,
  parseJsonl,
  renderEvalCsv,
  renderEvalHtml,
  renderEvalMarkdown,
  type EvalItem,
} from "../packages/evals/src/index";

const policy = parsePolicyYaml(
  await readFile("fixtures/policies/default.yaml", "utf8"),
  demoCatalog,
);
const dataset = parseJsonl(await readFile("fixtures/evals/tasks.jsonl", "utf8")) as EvalItem[];
const report = await evaluateDataset({
  router: createRouter({ catalog: demoCatalog, policy }),
  policy,
  dataset,
});
await mkdir("reports/eval", { recursive: true });
await writeFile("reports/eval/report.json", JSON.stringify(report, null, 2));
await writeFile("reports/eval/report.md", renderEvalMarkdown(report));
await writeFile("reports/eval/report.html", renderEvalHtml(report));
await writeFile("reports/eval/report.csv", renderEvalCsv(report));
console.log("Demo evaluation written to reports/eval.");
