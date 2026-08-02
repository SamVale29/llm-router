# Concepts

A provider owns an adapter and one or more model definitions. A model definition describes modalities, capabilities, limits, pricing provenance, regions, tags and operational metadata.

A routing request describes messages, tools, structured output, task hints and hard constraints. A policy maps request signals to route requirements and a strategy.

A decision is a record, not just a model ID. It contains candidates, eliminations, score components, estimates, fallbacks, policy/catalog versions, a normalized request hash and timing.

Unknown is deliberately distinct from false. The router does not claim support for an unconfirmed capability, and does not turn an absent price or latency observation into zero or instantaneous service.
