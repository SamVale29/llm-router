# Retries

The resilience block supports deadlineMs, retry.maxAttempts, retry.retryableErrors, retry.baseDelayMs, retry.maxDelayMs, fallback.maxModelFallbacks and fallback.errors.

Each attempt receives a signal with a timeout no larger than the remaining global deadline. Retry-After is honored when an adapter reports it. Use nativeRetries: false or an adapter-specific setting when the provider SDK already retries, to avoid multiplicative behavior.
