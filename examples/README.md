# Examples

All examples use the fictional catalog and deterministic mock adapters. They never read provider credentials or call a paid API.

## Runnable integrations

- `express-server`: Express 5 server with request IDs, normal completion, SSE streaming, fallback and safe errors. Run with `pnpm exec tsx examples/express-server/index.ts`, then call `http://127.0.0.1:3000/v1/chat/completions`.
- `nextjs`: App Router route handler at `nextjs/app/api/chat/route.ts`. Copy the `app` directory into a Next.js project and run `pnpm dev`.
- `fastify-server`: Fastify 5 server with the same behavior at `http://127.0.0.1:3001`. Run with `pnpm exec tsx examples/fastify-server/index.ts`.

## Other examples

- `basic-routing`, `cost-aware`, `latency-aware`, `multimodal-ocr`, `shadow-mode` and `evaluation` demonstrate decision-only APIs.
- `cascade` and `fallback-chain` demonstrate policy selection and fallback configuration.
- `privacy-policy` and `task-rules` are YAML policy fixtures.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:coverage` from the repository root before opening a change. The framework examples use mock adapters so streaming and fallback behavior remain deterministic in CI.
