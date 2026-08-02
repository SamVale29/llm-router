# LLM Router v0.1.0 — Explainable model routing

LLM Router v0.1.0 turns model selection into a versioned, testable policy.

## Included

- hard constraints before optimization;
- candidate elimination reasons and score breakdowns;
- deterministic decision fingerprints;
- cost and latency estimates with explicit unknowns;
- retries, fallbacks, circuit state and health signals;
- OpenAI, Anthropic, Google, OpenRouter and generic OpenAI-compatible adapters;
- decision-only, execute, explain, shadow and stream modes;
- CLI, optional local proxy, offline evaluation and replay;
- static playground with presets and no API keys.

## Limitations

The demo catalog is fictional and illustrative. It is not a provider benchmark, price registry or service-level guarantee. Quality metrics require a workload-specific evaluator, and the core does not execute tools automatically. npm packages are not published by this repository release unless explicitly listed by the release owner.

## Roadmap

External health/budget stores, integrations and experimental learned strategies are planned for later versions. Feedback and adapters are welcome.
