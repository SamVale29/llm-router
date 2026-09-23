import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AnySchema, ValidateFunction } from "ajv";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
const cache = new Map<string, ValidateFunction>();

/** JSON Schema 2020-12, local references only, no coercion or mutation. */
export function validateJsonSchema(value: unknown, schema: unknown): ValidationResult {
  try {
    if (
      typeof schema !== "boolean" &&
      (!schema || typeof schema !== "object" || Array.isArray(schema))
    )
      throw new Error("A boolean or object JSON Schema is required.");
    const key = JSON.stringify(schema);
    if (key.length > 64_000) throw new Error("Schema exceeds 64 KB.");
    inspect(schema, 0);
    let validate = cache.get(key);
    if (!validate) {
      const ajv = new Ajv2020({
        strictSchema: true,
        strictTypes: false,
        strictTuples: false,
        strictRequired: false,
        allErrors: false,
        ownProperties: true,
        allowUnionTypes: true,
      });
      addFormats(ajv);
      validate = ajv.compile(schema as AnySchema);
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, validate);
    }
    const valid = validate(value) === true;
    return {
      valid,
      errors: valid
        ? []
        : (validate.errors ?? []).map(
            (error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`,
          ),
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Invalid schema or value."],
    };
  }
}
function inspect(value: unknown, depth: number): void {
  if (depth > 40) throw new Error("Schema nesting exceeds 40 levels.");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "$ref" || key === "$dynamicRef") &&
      typeof child === "string" &&
      !child.startsWith("#")
    )
      throw new Error("Only local schema references are supported.");
    inspect(child, depth + 1);
  }
}
