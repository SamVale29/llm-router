# Fallbacks

Retries keep the same model offer. A fallback changes model or deployment. The policy separates retryable errors from fallback errors and bounds both attempts and total deadline.

Authentication and permission failures are not automatically retried or converted to model fallbacks. Rate limits, timeouts and availability failures are the common default.

Policy validation rejects cycles. Runtime fallback also tracks visited models, so a malformed external policy cannot create an infinite loop.

Streaming retries and fallbacks are attempted only before the first output token. Once output has been emitted, the router returns a normalized stream error instead of silently concatenating two model responses.
