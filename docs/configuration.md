# Configuration

Policies can be authored as YAML or TypeScript. YAML accepts comments and maps strategy names such as weighted-score to the typed strategy configuration.

The catalog is passed explicitly to createRouter. Applications can replace the demo catalog with a validated internal catalog. Core packages do not download catalog data at runtime.

Recommended hard constraints include required capabilities, modalities, regions, tags, context and output limits, price ceilings, latency ceilings, privacy requirements and fallback permissions.

The built-in output validator intentionally supports a dependency-free JSON Schema subset: types,
required/properties, enums, const, anyOf/oneOf/allOf, numeric and string bounds, array bounds,
`uniqueItems`, `additionalProperties: false` and `email`/`uri` formats. `$ref`, recursive schemas
and provider-specific extensions are not resolved; supply `input.estimatedTokens` when a request
contains high-resolution media and the automatic estimate is not representative. By default, each
non-text content part contributes 256 estimated input tokens. Configure that heuristic globally when
you have a calibrated estimate, and the decision will stop warning about the default:

```ts
const router = createRouter({
  catalog,
  policy,
  tokenEstimation: { nonTextPartTokens: 1024 },
});
```

For a request-specific total, set `input.estimatedTokens`; this also records the estimate as explicit
and avoids the default-heuristic warning for that request.

Use policy schema generation from the CLI:

```bash
pnpm cli catalog validate --catalog catalog.json
pnpm cli catalog build --output schemas
```

Validation is read-only. `catalog build` writes `policy.schema.json` and `catalog.schema.json` for editor integration.
