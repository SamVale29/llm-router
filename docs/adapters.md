# Adapters

A ProviderAdapter translates a normalized request, executes it with an AbortSignal and normalizes usage and provider errors. The repository includes OpenAI, Anthropic, Google, OpenRouter and generic OpenAI-compatible adapters.

Credentials and endpoints are passed to constructors. The core never reads environment variables. Remote endpoints must use HTTPS; HTTP is accepted only for localhost development. Custom deployments should additionally use `allowHosts` and must never accept arbitrary endpoint URLs from an untrusted request.

Provider-specific options stay under providerOptions.openai, providerOptions.anthropic, providerOptions.google, providerOptions.openrouter or providerOptions.compatible. An adapter may expose features that are not in the common denominator, but must preserve limitations in its documentation.

New adapters should copy the contract test and add simulated success, usage, rate-limit, timeout, cancellation, streaming and redaction cases. HTTP adapters should preserve status codes and `Retry-After` through `HttpAdapterError`; managed request fields such as model and messages must not be overridable through `providerOptions`.
