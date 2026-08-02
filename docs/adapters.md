# Adapters

A ProviderAdapter translates a normalized request, executes it with an AbortSignal and normalizes usage and provider errors. The repository includes OpenAI, Anthropic, Google, OpenRouter and generic OpenAI-compatible adapters.

Credentials and endpoints are passed to constructors. The core never reads environment variables. Endpoints must be HTTP(S); custom deployments should additionally use allowHosts.

Provider-specific options stay under providerOptions.openai, providerOptions.anthropic, providerOptions.google, providerOptions.openrouter or providerOptions.compatible. An adapter may expose features that are not in the common denominator, but must preserve limitations in its documentation.

New adapters should copy the contract test and add simulated success, usage, rate-limit, timeout, cancellation and redaction cases.
