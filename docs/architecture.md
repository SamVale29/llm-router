# Architecture

LLM Router is split into a dependency-light core, an independently versioned catalog, adapters, evaluation tooling, an optional proxy and a static playground.

The core accepts a catalog and policy as values. It does not discover providers, read environment variables, log prompt content or make network calls. Network access begins only when an application explicitly calls execute and supplies an adapter.

The decision pipeline is:

1. normalize messages, modalities and estimates;
2. accept an explicit task hint or use deterministic/local classification;
3. merge route requirements with request constraints;
4. build candidates from the catalog;
5. eliminate disabled, incompatible, unhealthy or over-budget candidates;
6. calculate task-fit, quality, cost, latency and reliability signals;
7. apply a configured strategy;
8. build an acyclic fallback chain;
9. return an explainable, hashable decision;
10. execute, validate, retry, fall back and record outcome only when requested.

See [routing-pipeline.md](routing-pipeline.md) and [security.md](security.md).
