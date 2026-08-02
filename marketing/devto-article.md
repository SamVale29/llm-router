# Model routing should be a testable policy, not a pile of if statements

## The problem

A single universal model is a convenient assumption but a poor production policy. Different tasks need different modalities, context limits, quality profiles and tool capabilities. Provider health and privacy rules also change over time.

## Requirements before scores

A cost score cannot rescue a model that cannot see an image, accept a schema, fit the context or satisfy residency. LLM Router filters those candidates before optimization and records the reason.

## Determinism and explanation

The decision includes policy/catalog versions, a normalized request hash, candidate signals, scores and warnings. This is useful in code review and policy migration.

## Shadow and replay

Shadow decisions compare a candidate policy without duplicating a paid call. Replay recalculates anonymized traces offline and reports selection changes, estimated cost and constraint regressions.

## Evaluation

Cost is reported with quality and latency. A lower cost with a quality regression is not presented as an automatic win.

## Limitations

Catalog data goes stale, quality is workload-specific and demo pricing is illustrative. The tool chooses according to a policy; it does not know the universal best model.
