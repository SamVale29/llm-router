# Privacy

The default core stores no prompt or response. Decisions contain a secure request fingerprint, not the normalized content. Hooks receive request IDs, tasks and decisions rather than raw messages.

The playground is decision-only. Remote classification is not built into the core. The proxy disables content logging and is intended for localhost or an authenticated internal deployment.

Applications remain responsible for adapter logs, provider terms, data residency, retention, redaction and access control.
