import { access } from "node:fs/promises";
import { join } from "node:path";

const packages = [
  "core",
  "catalog",
  "evals",
  "cli",
  "proxy",
  "observability",
  "testing",
  "adapter-openai",
  "adapter-anthropic",
  "adapter-google",
  "adapter-openrouter",
  "adapter-openai-compatible",
];
const missing: string[] = [];
for (const name of packages) {
  try {
    await access(join("packages", name, "dist", "index.js"));
    await access(join("packages", name, "package.json"));
  } catch {
    missing.push(name);
  }
}
if (missing.length) {
  console.error("Pack check failed. Missing built packages: " + missing.join(", "));
  process.exitCode = 1;
} else {
  console.log(
    "Pack check passed for " +
      packages.length +
      " packages. Each package has dist/index.js and package metadata.",
  );
}
