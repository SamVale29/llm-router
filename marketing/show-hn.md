# Show HN

## Title

Show HN: LLM Router — explainable, policy-driven routing across AI models

## Post

LLM Router is a TypeScript library that treats model routing as a versioned policy.

The interesting part is not another provider wrapper. A request first passes hard capability, modality, context, privacy, budget and health constraints. Only qualified candidates are scored. The resulting decision contains elimination reasons, signals, estimates, fallback chain and a reproducible request fingerprint.

The playground is decision-only and needs no API key. Shadow mode computes a candidate policy without sending a second request. Replay and evaluation compare model distribution, quality, cost, latency and constraint regressions offline.

The demo catalog is fictional and labeled illustrative. The project does not claim a universal best model or guaranteed savings.

Repository: https://github.com/SamVale29/llm-router/
Demo: https://samvale29.github.io/llm-router/

I would appreciate technical feedback on the policy DSL, adapter contracts and evaluation methodology.
