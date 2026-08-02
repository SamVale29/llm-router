import { createRouter } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const router = createRouter({
  catalog: demoCatalog,
  policy: {
    version: "production",
    routes: [{ id: "all", when: {}, select: { strategy: { kind: "priority" } } }],
  },
  shadowPolicies: [
    {
      version: "candidate",
      routes: [{ id: "all", when: {}, select: { strategy: { kind: "cheapest-qualified" } } }],
    },
  ],
});

const comparisons = await router.shadow({
  messages: [{ role: "user", content: "Compare policy choices." }],
});
console.table(
  comparisons.map(({ policyVersion, decision }) => ({
    policyVersion,
    selected: decision.selected?.modelId,
  })),
);
