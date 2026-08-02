# Evaluation

The evaluation package consumes JSONL items with id, task, input, expected and metadata. Decision-only evaluation does not call a provider. If an application supplies an execution harness, it can add exact-match, regex, JSON Schema, custom, reference-similarity or explicitly enabled judge metrics.

Reports include selection, cost, latency, constraint violations, routing overhead, model distribution, savings versus baseline and quality delta versus baseline. Cost savings without quality context are not presented as a success claim.

Use evaluation gates in CI for maximum quality drop, minimum cost reduction, constraint violations and P95 latency increase.
