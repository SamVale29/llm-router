# Launch post — English

Applications use different models for code, translation, OCR, long context and tool use. Hardcoded if/else routing becomes difficult to audit. Proxies often hide the decision.

LLM Router makes model routing a testable policy. Constraints run before scoring, candidates explain why they were eliminated, and decisions include cost and latency estimates with explicit unknowns.

The public playground is decision-only and needs no API key. Shadow mode compares policies without duplicating a prompt call. Replay and evaluation let teams inspect cost, latency, quality and constraint regressions before rollout.

Try the demo: https://samvale29.github.io/llm-router/
Repository: https://github.com/SamVale29/llm-router

Feedback is especially welcome on policy ergonomics, catalog provenance, adapter contracts and evaluation design.
