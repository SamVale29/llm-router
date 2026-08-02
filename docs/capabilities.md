# Capabilities

The catalog distinguishes text, image, audio, video and file input from text, image and audio output. It also distinguishes function calling, parallel tool calls, structured outputs, JSON mode, reasoning, prompt caching, realtime, embeddings and fine-tuning.

JSON mode is not treated as strict structured output. A schema requires confirmed structuredOutputs support. A tools request requires confirmed functionCalling support. unknown is not support.

Use checkCompatibility(request, model) when writing an adapter or catalog validation test.
