import { readFile, writeFile, mkdir } from "node:fs/promises";
import { demoCatalog, catalogJsonSchema, validateCatalog } from "../packages/catalog/src/index";
import { policyJsonSchema } from "../packages/core/src/index";

const action = process.argv[2] ?? "validate";
const issues = validateCatalog(demoCatalog);

if (action === "validate") {
  if (issues.length) {
    console.error(JSON.stringify(issues, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      "Catalog " +
        demoCatalog.version +
        " is valid: " +
        demoCatalog.providers.length +
        " providers, " +
        demoCatalog.models.length +
        " models.",
    );
  }
} else if (action === "build") {
  await mkdir("fixtures/catalogs", { recursive: true });
  await mkdir("schemas", { recursive: true });
  await writeFile("fixtures/catalogs/default.json", JSON.stringify(demoCatalog, null, 2));
  await writeFile("schemas/catalog.schema.json", JSON.stringify(catalogJsonSchema(), null, 2));
  await writeFile("schemas/policy.schema.json", JSON.stringify(policyJsonSchema(), null, 2));
  console.log("Catalog JSON and schemas written.");
} else if (action === "diff") {
  try {
    const previous = JSON.parse(await readFile("fixtures/catalogs/default.json", "utf8")) as {
      version?: string;
      models?: unknown[];
    };
    console.log(
      JSON.stringify(
        {
          previousVersion: previous.version ?? null,
          currentVersion: demoCatalog.version,
          previousModels: previous.models?.length ?? 0,
          currentModels: demoCatalog.models.length,
          changed: previous.version !== demoCatalog.version,
        },
        null,
        2,
      ),
    );
  } catch {
    console.log(JSON.stringify({ changed: true, reason: "no previous catalog snapshot" }, null, 2));
  }
} else if (action === "check-sources") {
  const missing = demoCatalog.models.filter(
    (model) => !model.source?.url || !model.source.checkedAt,
  );
  if (missing.length) {
    console.error("Missing source metadata for: " + missing.map((model) => model.id).join(", "));
    process.exitCode = 1;
  } else {
    console.log("All catalog entries have source metadata.");
  }
} else {
  console.error("Unknown catalog action: " + action);
  process.exitCode = 1;
}
