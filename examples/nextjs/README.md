# Next.js route handler example

The runnable route handler is `app/api/chat/route.ts`. Copy it into a Next.js App Router project and run `pnpm dev`; the handler uses the standard `Request`/`Response` API and keeps the router, policy, catalog and adapters server-side.

The example uses deterministic mock adapters. The primary adapter fails with a simulated `503`, so both normal and streaming requests demonstrate the router fallback without provider credentials.
