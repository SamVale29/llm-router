import type {
  NormalizedRoutingRequest,
  TaskClassificationResult,
  TaskClassifier,
  TaskType,
} from "./types.js";

export async function detectTask(
  request: NormalizedRoutingRequest,
  classifier?: TaskClassifier,
  remoteClassificationAllowed = false,
): Promise<TaskClassificationResult> {
  if (request.hints?.task)
    return {
      task: request.hints.task,
      confidence: 1,
      source: "hint",
      signals: ["explicit task hint"],
    };
  const ruleResult = detectByRules(request);
  if (ruleResult) return ruleResult;
  if (classifier && (classifier.kind !== "remote" || remoteClassificationAllowed)) {
    try {
      return await classifier.classify(request);
    } catch {
      return {
        task: "unknown",
        confidence: 0,
        source: "default",
        signals: ["configured classifier failed; deterministic fallback used"],
      };
    }
  }
  if (classifier?.kind === "remote" && !remoteClassificationAllowed)
    return {
      task: "unknown",
      confidence: 0,
      source: "default",
      signals: ["remote classifier was not explicitly allowed"],
    };
  return {
    task: "unknown",
    confidence: 0,
    source: "default",
    signals: ["no explicit or deterministic task signal"],
  };
}

function detectByRules(request: NormalizedRoutingRequest): TaskClassificationResult | null {
  const text = request.messages
    .map((message) => contentText(message.content))
    .join(" ")
    .toLowerCase();
  const metadata = request.metadata ?? {};
  const operation = typeof metadata.operation === "string" ? metadata.operation.toLowerCase() : "";
  if (request.detectedModalities.some((modality) => modality !== "text")) {
    if (/(ocr|invoice|receipt|nota fiscal|extract|read|document)/i.test(`${text} ${operation}`))
      return result("ocr", 0.9, "image/file signal");
    return result("vision-analysis", 0.82, "non-text input modality");
  }
  if (request.output?.schema)
    return result("structured-extraction", 0.92, "structured output schema");
  if (request.tools?.length) return result("tool-use", 0.92, "tools present");
  if (request.estimatedInputTokens >= 100_000)
    return result("long-document-summarization", 0.88, "large context estimate");
  if (
    /(translate|translation|traduza|tradução|traduzir|translate from|idioma)/i.test(
      `${text} ${operation}`,
    )
  )
    return result("translation", 0.83, "translation language pattern");
  if (/(debug|bug|stack trace|erro|exception|corrija)/i.test(`${text} ${operation}`))
    return result("debugging", 0.75, "debugging pattern");
  if (
    /(code review|review this code|revisão de código|pull request|typescript|python|javascript)/i.test(
      `${text} ${operation}`,
    )
  )
    return result("code-review", 0.72, "code-related pattern");
  if (/(summarize|summary|resuma|resumo|tl;dr)/i.test(`${text} ${operation}`))
    return result("summarization", 0.8, "summary pattern");
  if (/(classify|classification|classifique|categoria)/i.test(`${text} ${operation}`))
    return result("classification", 0.72, "classification pattern");
  if (
    /(reason|reasoning|prove|derive|raciocínio|analise profundamente)/i.test(`${text} ${operation}`)
  )
    return result("reasoning", 0.7, "reasoning pattern");
  if (/(write a story|creative|poem|história|poema|criativo)/i.test(`${text} ${operation}`))
    return result("creative-writing", 0.72, "creative-writing pattern");
  return null;
}

function contentText(content: NormalizedRoutingRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

function result(task: TaskType, confidence: number, signal: string): TaskClassificationResult {
  return { task, confidence, source: "rule", signals: [signal] };
}
