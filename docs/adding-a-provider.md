# Adding a provider

1. Add a provider definition with a stable adapter ID.
2. Add model entries only with sourced capabilities, limits, regions and prices.
3. Implement execute, optional stream, validateModel and normalizeError.
4. Keep credentials out of error messages, raw telemetry and tests.
5. Add contract tests using an injected fetch or local mock server.
6. Document provider-specific options and limitations.
7. Add an example and a changeset.
