import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArgs =
  process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd pack --dry-run --json"]
    : ["pack", "--dry-run", "--json"];
for (const name of packages) {
  const packageRoot = join("packages", name);
  try {
    await access(join(packageRoot, "dist", "index.js"));
    await access(join(packageRoot, "dist", "index.d.ts"));
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      files?: string[];
    };
    for (const file of manifest.files ?? []) await access(join(packageRoot, file));
    const { stdout } = await execFileAsync(npmCommand, npmArgs, {
      cwd: packageRoot,
      maxBuffer: 2_000_000,
    });
    const pack = JSON.parse(stdout) as Array<{
      files?: Array<{ path: string }>;
      filename?: string;
    }>;
    const files = pack[0]?.files ?? [];
    if (!files.some((file) => file.path === "dist/index.js"))
      throw new Error("tarball is missing dist/index.js");
    if (!files.some((file) => file.path === "dist/index.d.ts"))
      throw new Error("tarball is missing dist/index.d.ts");
  } catch (error) {
    missing.push(name);
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
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
