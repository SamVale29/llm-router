# Strategies

- rules chooses the first eligible route candidate;
- cheapest-qualified compares estimated input and output cost and can exclude unknown prices;
- fastest-qualified uses observed or catalog workload latency, never marketing claims;
- weighted-score combines task fit, quality, cost, latency and reliability;
- priority chooses the highest operational priority;
- random-weighted uses a seed when configured and includes a trace;
- round-robin distributes among equivalent eligible candidates;
- cascade begins with the first eligible stage and records escalation during execution;
- custom strategies implement RoutingStrategy and are registered in createRouter.

No strategy produces a universal model ranking. It answers a policy-specific question for a given catalog and operational state.
