import { describe, expect, it } from "vitest";
import { demoCatalog } from "@llm-router/catalog";
import { createRouter, type RoutingPolicy } from "@llm-router/core";
import { evaluateDataset, renderEvalMarkdown, replayTraces } from "@llm-router/evals";

const policy: RoutingPolicy = {
  version: "eval-test",
  routes: [{ id: "all", when: {}, select: { strategy: { kind: "cheapest-qualified" } } }],
};

describe("offline evaluation and replay", () => {
  it("produces comparable decision-only reports", async () => {
    const router = createRouter({ catalog: demoCatalog, policy });
    const report = await evaluateDataset({
      router,
      policy,
      dataset: [
        {
          id: "one",
          task: "translation",
          input: { messages: [{ role: "user", content: "translate" }] },
        },
        { id: "two", task: "ocr", input: { messages: [{ role: "user", content: "read" }] } },
      ],
    });
    expect(report.summary.total).toBe(2);
    expect(renderEvalMarkdown(report)).toContain("Evaluation report");
  });

  it("replays traces without calling a provider", async () => {
    const router = createRouter({ catalog: demoCatalog, policy });
    const report = await replayTraces(router, policy, [
      {
        id: "one",
        request: {
          messages: [{ role: "user", content: "translate" }],
          hints: { task: "translation" },
        },
      },
    ]);
    expect(report.rows[0]?.candidateModelId).toBe("demo-economy");
    expect(report.distribution["demo-economy"]).toBe(1);
  });
});
