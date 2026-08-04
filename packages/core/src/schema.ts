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
  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map(() => [] as string[]);
    const matches = schema.anyOf.some((branch, index) => {
      if (!branch || typeof branch !== "object") return false;
      validateNode(value, branch as Record<string, unknown>, path, branchErrors[index] ?? []);
      return (branchErrors[index] ?? []).length === 0;
    });
    if (!matches) errors.push(`${path} must match at least one anyOf schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => {
      if (!branch || typeof branch !== "object") return false;
      const branchErrors: string[] = [];
      validateNode(value, branch as Record<string, unknown>, path, branchErrors);
      return branchErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${path} must match exactly one oneOf schema`);
  }
  if (Array.isArray(schema.allOf))
    for (const branch of schema.allOf)
      if (branch && typeof branch === "object")
        validateNode(value, branch as Record<string, unknown>, path, errors);
  const type = schema.type;
  const typeMatches = Array.isArray(type)
    ? type.some((candidate) => typeof candidate === "string" && matchesType(value, candidate))
    : typeof type === "string"
      ? matchesType(value, type)
      : true;
  if (!typeMatches) {
    errors.push(`${path} must be ${Array.isArray(type) ? type.join(" or ") : String(type)}`);
    return;
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value))
    errors.push(`${path} must equal const value`);
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
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${path} must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${path} must have at most ${schema.maxLength} characters`);
    if (schema.format === "email" && !/^\S+@\S+\.\S+$/.test(value))
      errors.push(`${path} must be a valid email`);
    if (schema.format === "uri") {
      try {
        new URL(value);
      } catch {
        errors.push(`${path} must be a valid URI`);
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push(`${path} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push(`${path} must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      errors.push(`${path} must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
      errors.push(`${path} must be < ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      errors.push(`${path} must contain at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) errors.push(`${path} must be unique`);
    }
  }
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
      if (schema.additionalProperties === false)
        for (const key of Object.keys(record))
          if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
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
