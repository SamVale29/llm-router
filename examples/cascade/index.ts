import { createRouter, type RoutingPolicy } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const policy: RoutingPolicy = {
  version: "cascade-example",
  routes: [
    {
      id: "extract",
      when: { task: "structured-extraction" },
      select: {
        strategy: {
          kind: "cascade",
          stages: [
            {
              model: "demo-economy",
              accept: { type: "json-schema", schema: { type: "object", required: ["name"] } },
            },
            { model: "demo-code-pro" },
          ],
        },
      },
    },
  ],
};

const decision = await createRouter({ catalog: demoCatalog, policy }).decide({
  messages: [{ role: "user", content: "Extract the customer name." }],
  hints: { task: "structured-extraction" },
  output: { schema: { type: "object", required: ["name"] } },
});

console.log(decision);
