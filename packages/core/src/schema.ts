export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateJsonSchema(value: unknown, schema: unknown): ValidationResult {
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const errors: string[] = [];
  validateNode(value, schema as Record<string, unknown>, "$", errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${path} must be ${type}`);
    return;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
  )
    errors.push(`${path} must match one of enum values`);
  if (
    typeof schema.pattern === "string" &&
    typeof value === "string" &&
    !new RegExp(schema.pattern).test(value)
  )
    errors.push(`${path} does not match pattern`);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required))
      for (const required of schema.required)
        if (typeof required === "string" && !(required in record))
          errors.push(`${path}.${required} is required`);
    if (schema.properties && typeof schema.properties === "object") {
      const properties = schema.properties as Record<string, unknown>;
      for (const [key, childSchema] of Object.entries(properties))
        if (key in record && childSchema && typeof childSchema === "object")
          validateNode(
            record[key],
            childSchema as Record<string, unknown>,
            `${path}.${key}`,
            errors,
          );
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object")
    value.forEach((item, index) =>
      validateNode(item, schema.items as Record<string, unknown>, `${path}[${index}]`, errors),
    );
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}
