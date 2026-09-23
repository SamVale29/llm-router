import { describe, expect, it } from "vitest";
import { createExampleRouter } from "../examples/shared/router.js";

const request = { messages: [{ role: "user" as const, content: "hello" }] };

describe("framework example behavior", () => {
  it("demonstrates normal completion with deterministic fallback", async () => {
    const result = await createExampleRouter().execute(request);
    expect(result.decision.selected?.modelId).toBe("demo-code-pro");
    expect(result.response).toEqual({ message: "mock response" });
    expect(result.execution.attempts.at(-1)?.modelId).toBe("demo-economy");
  });

  it("demonstrates streaming and fallback without provider credentials", async () => {
    const events = [];
    for await (const event of createExampleRouter().stream({ ...request })) events.push(event);
    expect(events.some((event) => event.type === "fallback")).toBe(true);
    expect(events.some((event) => event.type === "text-delta")).toBe(true);
    expect(events.some((event) => event.type === "complete")).toBe(true);
  });
});
