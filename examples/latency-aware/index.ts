import { createRouter } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const router = createRouter({
  catalog: demoCatalog,
  policy: {
    version: "latency-example",
    routes: [{ id: "interactive", when: {}, select: { strategy: { kind: "fastest-qualified" } } }],
  },
});

const decision = await router.decide({
  messages: [{ role: "user", content: "Give a short interactive answer." }],
  constraints: { maxExpectedLatencyMs: 1000, requireObservedLatency: true },
});

console.log(decision.selected?.modelId, decision.explanation.warnings);
