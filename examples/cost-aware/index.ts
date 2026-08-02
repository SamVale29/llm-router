import { createRouter } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const router = createRouter({
  catalog: demoCatalog,
  policy: {
    version: "cost-example",
    routes: [
      {
        id: "translation",
        when: { task: "translation" },
        select: { strategy: { kind: "cheapest-qualified" } },
      },
    ],
  },
});

const decision = await router.decide({
  messages: [{ role: "user", content: "Translate this paragraph." }],
  hints: { task: "translation", quality: "economy" },
  constraints: { maxEstimatedRequestCost: 0.01 },
});

console.log(decision.selected?.modelId, decision.estimates);
