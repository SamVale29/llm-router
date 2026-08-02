import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      exclude: ["**/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@llm-router/core": source("./packages/core/src/index.ts"),
      "@llm-router/catalog": source("./packages/catalog/src/index.ts"),
      "@llm-router/evals": source("./packages/evals/src/index.ts"),
      "@llm-router/observability": source("./packages/observability/src/index.ts"),
      "@llm-router/adapter-openai-compatible": source(
        "./packages/adapter-openai-compatible/src/index.ts",
      ),
      "@llm-router/adapter-openai": source("./packages/adapter-openai/src/index.ts"),
      "@llm-router/adapter-anthropic": source("./packages/adapter-anthropic/src/index.ts"),
      "@llm-router/adapter-google": source("./packages/adapter-google/src/index.ts"),
      "@llm-router/adapter-openrouter": source("./packages/adapter-openrouter/src/index.ts"),
      "@llm-router/proxy": source("./packages/proxy/src/index.ts"),
    },
  },
});
