# Observability

The observability package exposes stable llm_router.* attributes and a small tracer interface that can be connected to OpenTelemetry without coupling the core to a particular SDK version.

Recommended spans are routing_decision, task classification, candidate filtering, provider attempt, retry, fallback, validation and cascade stage. Do not add prompt, response, image, credential or authorization attributes without an explicit privacy review.
