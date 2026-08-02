import { createRouter } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const router = createRouter({
  catalog: demoCatalog,
  policy: {
    version: "example-1",
    defaults: { strategy: { kind: "weighted-score" } },
    routes: [
      {
        id: "code",
        when: { task: "code-review" },
        require: { capabilities: ["structured-outputs"] },
        prefer: { tags: ["code"] },
        select: { strategy: { kind: "weighted-score" } },
      },
    ],
  },
});

const decision = await router.decide({
  messages: [{ role: "user", content: "Review this TypeScript function." }],
  hints: { task: "code-review" },
  output: { schema: { type: "object", properties: { issues: { type: "array" } } } },
});

console.log(decision.selected, decision.explanation);
