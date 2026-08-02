# Configuration

Policies can be authored as YAML or TypeScript. YAML accepts comments and maps strategy names such as weighted-score to the typed strategy configuration.

The catalog is passed explicitly to createRouter. Applications can replace the demo catalog with a validated internal catalog. Core packages do not download catalog data at runtime.

Recommended hard constraints include required capabilities, modalities, regions, tags, context and output limits, price ceilings, latency ceilings, privacy requirements and fallback permissions.

Use policy schema generation from the CLI:

```bash
llm-router catalog validate
```

This writes policy.schema.json and catalog.schema.json for editor integration.
