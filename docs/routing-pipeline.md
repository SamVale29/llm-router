# Routing pipeline

## Normalize

Messages are copied into a normalized representation. Text is estimated at roughly four characters per token unless the application supplies input.estimateTokens. Images and files receive a conservative modality estimate.

## Detect

Explicit hints win. Deterministic signals then inspect modalities, schemas, tools, context size, metadata and multilingual task patterns. An application-provided local classifier can run after deterministic rules. A remote classifier is intentionally not bundled into the core.

## Filter

Compatibility is evaluated before any score. Missing modality, capability, context, output, region, price, tag, privacy or health conditions become an elimination reason.

## Score and select

Strategies operate on eligible candidates. Scores are normalized so larger means better. Unknown signals are reported and follow the configured unknown-data policy.

## Execute and observe

Execution has a global deadline, bounded retries, exponential delay with jitter, normalized provider errors and model fallback. Tools are never invoked by core; the application owns tool execution. Health and budget stores are interfaces, with in-memory implementations included.
