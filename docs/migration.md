# Migration

Policies are versioned independently from the catalog. When changing a route, replay anonymized traces against the candidate policy, inspect changed model distribution and run evaluation gates before production.

The v0.1 API is intentionally small. Treat normalized request and decision fields as public contracts, and add a changeset for breaking changes.
