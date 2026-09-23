# Audit remediation — 23 September 2026

This change continues PR #24 from `38f839955ddc0a5511ae7f9a3f0edbd949f45b05`.
The original audit covered main `b1cab08e069d5f7a2864aa3b2167518ed305ad3b` and that PR revision.

| Finding | Remediation                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01     | Fallback requires both policy/request permission, the configured error class, the explicit transition rule and adapter eligibility.                                                          |
| A02     | Local validation parses the generated text, independently of the provider response envelope.                                                                                                 |
| A03     | Normal and streamed execution share budget reservations, deadline, schema validation and cancellation. Structured streams buffer output until acceptance.                                    |
| A04     | Atomic reserve/settle operations account for concurrent requests and every dispatched attempt, including failed validation and cascade rejection.                                            |
| A05     | One execution deadline covers retries and fallback; policy backoff is honored and Retry-After never starts a late retry.                                                                     |
| A06     | Native proxy endpoints preserve and validate request constraints, hints, input and output.                                                                                                   |
| A07     | A stream cannot retry or fall back after text or tool calls have been exposed to the consumer.                                                                                               |
| A08     | Chat/Responses conversion preserves normalized text, function calls, generation options and usage; invalid/unsupported representations return HTTP 400. Internal router events are filtered. |
| A09     | decisionOnly blocks both execution APIs. executeShadowRequests=true fails explicitly; shadow() remains decision-only.                                                                        |
| A10     | Cascade stages respect candidate order and enforce regex/JSON Schema acceptance before success or output delivery.                                                                           |
| A11     | Ajv validates JSON Schema 2020-12, including local references, boolean schemas and additionalProperties. Unknown keywords and remote references fail explicitly.                             |
| A12     | Compatibility considers input plus output tokens and rejects an unknown output limit when a minimum is required.                                                                             |
| A13     | Adapter namespaces work; tool calls and usage survive SSE parsing; unsupported request_id is removed. Assistant tool history and supported media are mapped explicitly.                      |
| A14     | Non-native streaming executes the original decision once and uses AdapterResponse.text.                                                                                                      |
| A15     | Unknown metrics cannot pass evaluation gates; partial costs/quality cannot produce full-dataset savings; unmeasured fallback rate is null. CLI comparison accepts --policy.                  |
| A16     | Updated dependency versions and transitive overrides remove the advisories found by the audit.                                                                                               |
| A17     | Added aggregate audit-required CI gate and an idempotent administrative ruleset script. **Live activation is pending administrator access.**                                                 |
| A18     | Compose names the correct Dockerfile; image uses an existing policy, authenticated external binding and an explicit offline mode. CI includes a container smoke test.                        |
| A19     | Shared scenarios restore the policy, preset and custom text, including Unicode. Malformed/oversized payloads safely fall back.                                                               |
| A20     | P95-only observed latency satisfies observed-latency constraints.                                                                                                                            |
| A21     | Existing PR weighted-score fix retained and regression covered.                                                                                                                              |
| A22     | Existing Anthropic SSE event/data fix retained; tool calls and usage added.                                                                                                                  |
| A23     | Existing independent Google schema configuration retained and regression covered.                                                                                                            |
| A24     | Provider options cannot override the selected model or router-controlled request fields.                                                                                                     |
| A25     | Existing monthly UTC budget scoping retained; reservations use the same scope.                                                                                                               |
| A26     | Candidate order follows the policy list instead of catalog order.                                                                                                                            |

## Migration and operational contract

- Node 20.19+ is required. Install the committed lockfile with pnpm 10.12.1.
- BudgetStore implementations used with maxMonthlyBudget must implement atomic `reserve(entry, limit)` and idempotent `settle(id, actualAmount)`. A capped request fails closed if these are missing. A shared database transaction is required across replicas; the supplied in-memory store coordinates one process only and resets on restart.
- Reservations use catalog prices and the requested output-token ceiling. All attempts are reconciled with actual reported cost/token usage; absent usage is charged conservatively at the reservation estimate. The router cannot guarantee a provider's invoice when prices or token estimates are inaccurate, tools add unpriced charges, or cancellation is not honored upstream. For a strict monetary ceiling, also configure provider-side spending controls and calibrated catalog/token estimates.
- Every attempt carries the same cancellation signal. A caller should pass `request.signal` to cancel while waiting for the next event. Breaking `for await` cancels promptly after a delivered event. A custom adapter must honor its ExecutionContext signal.
- Invalid structured responses are charged, rejected and never published as successful output. Structured/cascade streams buffer at most 8 million text characters; their first output is intentionally delayed until validation.
- Schemas use draft 2020-12 with local references only (64 KB / 40 nesting levels). Configure trusted schemas and patterns; synchronous regular-expression execution cannot be interrupted by AbortSignal.
- `executeShadowRequests: true` is rejected because paid shadow execution is not implemented. `shadow()` evaluates alternate decisions without calling providers.
- OpenAI proxy compatibility covers stateless text/image/audio input and function tools. Responses supports string input and message/function-call items. Stateful Responses features such as previous_response_id, background and store=true are explicitly rejected. The request's model is routing metadata, not a way to override policy selection.
- Native router request fields are preserved. Billing identity must be set by trusted application code; public completion metadata cannot impersonate userId/projectId.
- Google uses execute() for generated streaming events, not native token streaming. Anthropic rejects audio/video instead of disguising them as documents. Provider-specific feature compatibility still depends on the selected model.
- `eval compare baseline.json candidate.json --policy policy.yaml` applies the policy's gates. An offline report without quality measurements cannot qualify a release; null means unmeasured, never zero.
- `llm-router serve --decision-only` explicitly starts an offline decision service. Supply adapters/credentials and omit that option to enable completions. Binding outside localhost requires LLM_ROUTER_PROXY_TOKEN.
- Compose defaults to the demo decision-only service: set LLM_ROUTER_PROXY_TOKEN, then run `docker compose -f packages/proxy/docker-compose.yml up --build`. Use a real catalog and policy for provider execution.

## Required GitHub setting (A17)

A workflow file cannot make checks mandatory by itself. The connected GitHub App does not expose administration writes; live ruleset 20253678 still lacks required status checks.

After this branch has a successful `audit-required` check, an administrator can preview and apply the exact additive change using an existing authenticated GitHub CLI session:

```sh
node --import tsx scripts/require-ci.ts
node --import tsx scripts/require-ci.ts --apply
```

The script reads the latest ruleset, preserves existing rules/conditions/bypass actors and existing required checks, adds `audit-required`, requires an up-to-date branch and reads the result back. It neither grants bypass access nor changes review counts.

## Validation

The local regression suite passes 78 tests using deterministic fake providers and local HTTP endpoints; no paid provider calls were made. Coverage: 70.30% lines, 69.04% functions and 61.47% branches. Dependency audit reports zero known vulnerabilities. The committed lockfile was also accepted by pnpm 10.12.1 in frozen mode. Final local and GitHub CI outcomes are recorded in PR #24. Container and browser checks run in GitHub CI; if the local environment lacks Docker or cannot download Chromium, those checks must not be claimed as locally passed.
