# Production operations checklist

The repository is safe to explore locally, but a production deployment needs explicit operational controls.

## Before exposing a proxy

- Set `authToken` and restrict `allowedOrigins` to known application origins.
- Keep the proxy bound to a private interface unless an authenticated gateway is in front of it.
- Keep endpoint allowlists enabled for OpenAI-compatible adapters; reject arbitrary user-supplied URLs.
- Set payload, request, timeout and rate limits for the expected workload.
- Do not log prompts, responses, images, authorization headers or provider credentials.

## Health, budgets and resilience

The default health and budget state is in-memory and process-local. For multiple replicas, provide a durable shared implementation before relying on circuit state, reservations or spend ceilings across instances.

Monitor at least:

- selected model and fallback rate by route;
- estimated versus observed input/output tokens and cost;
- P50/P95 latency and timeout/rate-limit rates;
- rejected requests and constraint violations;
- budget reservation failures and circuit transitions.

## Catalog and policy changes

Treat policy and catalog changes like code:

```bash
pnpm catalog:validate
pnpm catalog:check-sources
pnpm catalog:diff
pnpm test
pnpm eval:demo
```

Use a replay report before changing a production policy. Demo catalog prices are illustrative and must be replaced with observed, dated values.

## Release gate

Run the full local gate before opening a release PR:

```bash
pnpm release:check
pnpm test:e2e
pnpm pack:check
```

The decision-only playground and evaluation/replay reports do not call providers. Provider execution should be enabled only in an application that has reviewed credentials, privacy, retry and data-retention behavior.
