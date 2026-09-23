import { spawnSync } from "node:child_process";

// Run with an administrator's existing GitHub CLI session. Preview is the default.
const repository = "SamVale29/llm-router";
const rulesetId = "20253678";
function api(path: string, body?: unknown): unknown {
  const result = spawnSync(
    "gh",
    ["api", path, ...(body ? ["--method", "PUT", "--input", "-"] : [])],
    {
      encoding: "utf8",
      input: body ? JSON.stringify(body) : undefined,
    },
  );
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout) as unknown;
}
interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}
interface Ruleset {
  name: string;
  target: string;
  enforcement: string;
  conditions: unknown;
  bypass_actors: unknown[];
  rules: Rule[];
}
const path = `repos/${repository}/rulesets/${rulesetId}`;
const current = api(path) as Ruleset;
if (current.name !== "main-protection" || current.target !== "branch")
  throw new Error("Unexpected ruleset; refusing to modify it.");
const checks = current.rules.find((rule) => rule.type === "required_status_checks");
const required = (checks?.parameters?.required_status_checks ?? []) as Array<{ context: string }>;
const payload: Ruleset = {
  name: current.name,
  target: current.target,
  enforcement: "active",
  conditions: current.conditions,
  bypass_actors: current.bypass_actors,
  rules: [
    ...current.rules.filter((rule) => rule.type !== "required_status_checks"),
    {
      type: "required_status_checks",
      parameters: {
        ...checks?.parameters,
        strict_required_status_checks_policy: true,
        required_status_checks: required.some((check) => check.context === "audit-required")
          ? required
          : [...required, { context: "audit-required" }],
      },
    },
  ],
};
if (process.argv.includes("--apply")) {
  api(path, payload);
  const verified = api(path) as Ruleset;
  if (!JSON.stringify(verified.rules).includes('"audit-required"'))
    throw new Error("Required CI check was not saved.");
  process.stdout.write("Required CI check audit-required is active on main.\n");
} else {
  process.stdout.write(
    `${JSON.stringify(payload, null, 2)}\nPreview only. Run with --apply to save this ruleset.\n`,
  );
}
