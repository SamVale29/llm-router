# Contributing

Thanks for helping improve LLM Router.

## Development

Requirements: Node.js 20 or newer and pnpm 9 or newer.

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Provider tests must use simulated servers or injected fetch implementations. Do not add a paid API requirement to CI. New catalog prices and capabilities require a source URL, checked date and a changelog entry.

## Pull requests

Use a Conventional Commit title. Explain the policy behavior, hard constraints, privacy impact and tests. Keep public exports typed and avoid any. Add documentation for new strategies or adapters.

## Releases

Changes are versioned through Changesets. A release owner runs the quality commands, reviews the catalog diff, creates a tag and publishes the GitHub release. npm publication is separate and must only happen with explicit namespace authorization.

## Code of conduct

By participating, you agree to the Code of Conduct.
