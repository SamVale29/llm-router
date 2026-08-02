import { createRouter } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const router = createRouter({
  catalog: demoCatalog,
  policy: {
    version: "ocr-example",
    routes: [
      {
        id: "ocr",
        when: { task: "ocr" },
        require: { inputModalities: ["image"] },
        select: { strategy: { kind: "cheapest-qualified" }, candidates: ["demo-vision"] },
      },
    ],
  },
});

const decision = await router.decide({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Extract the text and table structure." },
        { type: "image", source: { type: "url", value: "https://example.invalid/invoice.png" } },
      ],
    },
  ],
  hints: { task: "ocr" },
});

console.log(decision.explanation);
