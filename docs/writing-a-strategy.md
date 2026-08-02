# Writing a strategy

Implement RoutingStrategy.select(context). The context contains normalized request metadata, task classification, candidates and warnings. Candidates are already filtered for hard constraints.

Return a selected model ID, a human-readable reason and an optional trace. Keep state external and explicit. If randomness is needed, accept a seed and include the seed in the reason. Do not call the strategy a quality oracle.
