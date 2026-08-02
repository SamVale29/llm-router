export type Modality = "text" | "image" | "audio" | "video" | "file";
export type OutputModality = "text" | "image" | "audio" | "video";

export type TaskType =
  | "chat"
  | "code-generation"
  | "code-review"
  | "debugging"
  | "translation"
  | "summarization"
  | "long-document-summarization"
  | "ocr"
  | "vision-analysis"
  | "classification"
  | "structured-extraction"
  | "reasoning"
  | "tool-use"
  | "rag"
  | "creative-writing"
  | "embeddings"
  | "unknown"
  | (string & {});

export type CapabilityName =
  | "function-calling"
  | "structured-outputs"
  | "reasoning"
  | "prompt-caching"
  | "realtime"
  | "parallel-tool-calls"
  | "json-mode"
  | "embeddings"
  | "fine-tuning";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ImageSource {
  type: "url" | "base64";
  value: string;
  mediaType?: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | { type: "audio"; source: ImageSource }
  | { type: "video"; source: ImageSource }
  | { type: "file"; source: ImageSource; filename?: string };

export type MessageContent = string | MessagePart[];

export interface RouterMessage {
  role: MessageRole;
  content: MessageContent;
  name?: string;
  toolCallId?: string;
}

export interface RouterTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface RoutingRequest {
  id?: string;
  messages: RouterMessage[];
  input?: {
    estimatedTokens?: number;
    modalities?: Modality[];
    language?: string;
  };
  output?: {
    maxTokens?: number;
    modality?: OutputModality;
    schema?: unknown;
    strict?: boolean;
  };
  tools?: RouterTool[];
  hints?: {
    task?: TaskType;
    complexity?: "low" | "medium" | "high";
    quality?: "economy" | "balanced" | "premium";
    latency?: "background" | "interactive" | "realtime";
  };
  constraints?: RoutingConstraints;
  metadata?: Record<string, unknown>;
  providerOptions?: {
    openai?: Record<string, unknown>;
    anthropic?: Record<string, unknown>;
    google?: Record<string, unknown>;
    openrouter?: Record<string, unknown>;
    compatible?: Record<string, unknown>;
  };
}

export interface RoutingConstraints {
  allowedProviders?: string[];
  deniedProviders?: string[];
  allowedModels?: string[];
  deniedModels?: string[];
  requiredCapabilities?: CapabilityName[];
  requiredInputModalities?: Modality[];
  maxInputPricePerMillion?: number;
  maxOutputPricePerMillion?: number;
  maxEstimatedRequestCost?: number;
  maxMonthlyBudget?: number;
  maxExpectedLatencyMs?: number;
  minContextTokens?: number;
  minOutputTokens?: number;
  requiredRegions?: string[];
  requiredTags?: string[];
  forbiddenTags?: string[];
  dataResidency?: string[];
  zeroDataRetentionRequired?: boolean;
  fallbackAllowed?: boolean;
  remoteClassificationAllowed?: boolean;
  requireObservedLatency?: boolean;
  unknownCost?: "allow-with-warning" | "exclude";
}

export interface ProviderDefinition {
  id: string;
  name: string;
  adapter: string;
  capabilities?: {
    streaming?: boolean;
    nativeRetries?: boolean;
    usageReporting?: boolean;
    requestCancellation?: boolean;
  };
  regions?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ModelDefinition {
  id: string;
  providerId: string;
  apiModelId: string;
  displayName: string;
  status: "active" | "preview" | "deprecated" | "disabled";
  modalities: { input: Modality[]; output: OutputModality[] };
  capabilities: {
    functionCalling?: boolean | "unknown";
    structuredOutputs?: boolean | "unknown";
    reasoning?: boolean | "unknown";
    promptCaching?: boolean | "unknown";
    fineTuning?: boolean | "unknown";
    realtime?: boolean | "unknown";
    parallelToolCalls?: boolean | "unknown";
    jsonMode?: boolean | "unknown";
    embeddings?: boolean | "unknown";
  };
  limits: { contextTokens?: number | null; outputTokens?: number | null };
  pricing?: {
    currency: "USD";
    inputPerMillion?: number | null;
    outputPerMillion?: number | null;
    cachedInputPerMillion?: number | null;
  };
  operational?: { enabled: boolean; priority?: number; concurrencyLimit?: number };
  tags?: string[];
  regions?: string[];
  metadata?: {
    qualityByTask?: Record<string, number>;
    observedLatencyMs?: number;
    observedP95LatencyMs?: number;
    reliability?: number;
    zeroDataRetention?: boolean;
    demo?: boolean;
    sourceNote?: string;
    [key: string]: unknown;
  };
  source?: { url: string; checkedAt: string };
}

export interface Catalog {
  version: string;
  providers: ProviderDefinition[];
  models: ModelDefinition[];
  generatedAt?: string;
}

export interface NormalizedRoutingRequest extends RoutingRequest {
  id: string;
  input: NonNullable<RoutingRequest["input"]>;
  output: NonNullable<RoutingRequest["output"]>;
  constraints: RoutingConstraints;
  detectedModalities: Modality[];
  estimatedInputTokens: number;
}

export interface EliminationReason {
  code: string;
  message: string;
  field?: string;
}

export interface RoutingCandidate {
  model: ModelDefinition;
  eligible: boolean;
  eliminatedBy: EliminationReason[];
  signals: Record<string, number | string | boolean | null>;
  scores: {
    quality?: number | null;
    cost?: number | null;
    latency?: number | null;
    reliability?: number | null;
    taskFit?: number | null;
    total?: number | null;
  };
  predicted: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cost?: number | null;
    latencyMs?: number | null;
  };
}

export interface RoutingDecision {
  requestId: string;
  decisionId: string;
  selected: { providerId: string; modelId: string; apiModelId: string } | null;
  fallbackChain: Array<{ providerId: string; modelId: string; reason: string }>;
  task: {
    type: string;
    confidence?: number | null;
    source: "hint" | "rule" | "classifier" | "default";
  };
  strategy: { id: string; version: string };
  candidates: RoutingCandidate[];
  explanation: { summary: string; reasons: string[]; warnings: string[] };
  estimates: { cost?: number | null; latencyMs?: number | null };
  reproducibility: {
    libraryVersion: string;
    policyVersion: string;
    catalogVersion: string;
    normalizedRequestHash: string;
  };
  timing: { startedAt: string; durationMs: number };
}

export type ProviderErrorCode =
  | "authentication"
  | "permission"
  | "rate-limit"
  | "quota"
  | "timeout"
  | "unavailable"
  | "invalid-request"
  | "context-length"
  | "content-filter"
  | "unsupported-capability"
  | "connection"
  | "cancelled"
  | "unknown";

export interface NormalizedProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  fallbackEligible: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  providerId?: string;
  modelId?: string;
  cause?: unknown;
}

export interface AdapterUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cost?: number;
}

export interface AdapterResponse<T = unknown> {
  data: T;
  text?: string;
  usage?: AdapterUsage;
  raw?: unknown;
}

export type AdapterStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; name: string; arguments: string; callId?: string }
  | { type: "usage"; usage: AdapterUsage }
  | { type: "complete"; response?: AdapterResponse };

export interface ExecutionContext {
  signal: AbortSignal;
  requestId: string;
  attempt: number;
  timeoutMs: number;
  providerOptions?: Record<string, unknown>;
}

export interface ProviderAdapter {
  id: string;
  validateModel(model: ModelDefinition): void;
  execute(
    request: NormalizedRoutingRequest,
    model: ModelDefinition,
    context: ExecutionContext,
  ): Promise<AdapterResponse>;
  stream?(
    request: NormalizedRoutingRequest,
    model: ModelDefinition,
    context: ExecutionContext,
  ): AsyncIterable<AdapterStreamEvent>;
  normalizeError(error: unknown): NormalizedProviderError;
}

export interface ProviderAttempt {
  providerId: string;
  modelId: string;
  attempt: number;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  error?: NormalizedProviderError;
}

export interface ExecutionResult<T = unknown> {
  decision: RoutingDecision;
  response?: T;
  usage?: AdapterUsage;
  execution: { attempts: ProviderAttempt[]; selectedAttempt?: number; totalDurationMs: number };
}

export type RouterEvent =
  | { type: "decision"; decision: RoutingDecision }
  | { type: "attempt-start"; providerId: string; modelId: string; attempt: number }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; name: string; arguments: string; callId?: string }
  | { type: "usage"; usage: AdapterUsage }
  | { type: "fallback"; fromModelId: string; toModelId: string; reason: string }
  | { type: "error"; error: NormalizedProviderError }
  | { type: "complete"; result: ExecutionResult };

export interface TaskClassificationResult {
  task: TaskType;
  confidence?: number;
  source: "hint" | "rule" | "classifier" | "default";
  signals?: string[];
}

export interface TaskClassifier {
  id: string;
  kind?: "local" | "remote";
  classify(request: NormalizedRoutingRequest): Promise<TaskClassificationResult>;
}

export interface HealthStatus {
  state: "closed" | "open" | "half-open";
  successRate: number;
  errorRate: number;
  rateLimitRate: number;
  timeoutRate: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  consecutiveFailures: number;
}

export interface HealthKey {
  providerId: string;
  modelId: string;
}

export interface HealthStore {
  get(key: HealthKey): Promise<HealthStatus>;
  recordSuccess(key: HealthKey, durationMs: number): Promise<void>;
  recordFailure(key: HealthKey, error: NormalizedProviderError, durationMs: number): Promise<void>;
}

export interface BudgetScope {
  type: "request" | "user" | "project" | "period";
  id: string;
}

export interface BudgetUsage {
  scope: BudgetScope;
  amount: number;
  currency: "USD";
  periodStart?: string;
}

export interface UsageEntry {
  scope: BudgetScope;
  amount: number;
  currency: "USD";
  requestId: string;
  modelId: string;
}

export interface BudgetStore {
  getUsage(scope: BudgetScope): Promise<BudgetUsage>;
  recordUsage(entry: UsageEntry): Promise<void>;
}

export interface StrategyContext {
  request: NormalizedRoutingRequest;
  task: TaskClassificationResult;
  candidates: RoutingCandidate[];
  preferredTags: string[];
  warnings: string[];
}

export interface StrategyResult {
  selectedModelId: string | null;
  reason: string;
  trace?: Record<string, unknown>;
}

export interface RoutingStrategy {
  id: string;
  version: string;
  select(context: StrategyContext): Promise<StrategyResult>;
}

export interface StrategyWeights {
  taskFit?: number;
  quality?: number;
  cost?: number;
  latency?: number;
  reliability?: number;
}

export type StrategyConfig =
  | { kind: "rules"; id?: string }
  | { kind: "cheapest-qualified"; id?: string; unknownCost?: "allow-with-warning" | "exclude" }
  | { kind: "fastest-qualified"; id?: string; requireObservedLatency?: boolean }
  | { kind: "weighted-score"; id?: string; weights?: StrategyWeights }
  | { kind: "priority"; id?: string }
  | { kind: "random-weighted"; id?: string; seed?: number; weights?: Record<string, number> }
  | { kind: "round-robin"; id?: string }
  | { kind: "cascade"; id?: string; stages: CascadeStage[] }
  | { kind: "custom"; id: string };

export interface CascadeStage {
  model?: string;
  candidates?: string[];
  accept?:
    { type: "regex"; pattern: string } | { type: "json-schema"; schema: Record<string, unknown> };
}

export interface PolicyWhen {
  task?: TaskType | TaskType[] | { anyOf: TaskType[] };
  modalities?: Modality[];
  language?: string | string[];
  metadata?: Record<string, string | number | boolean>;
}

export interface PolicyRequire {
  capabilities?: CapabilityName[];
  inputModalities?: Modality[];
  minContextTokens?: number;
  tags?: string[];
}

export interface PolicySelect {
  strategy?: StrategyConfig;
  candidates?: string[];
  weights?: StrategyWeights;
}

export interface PolicyRoute {
  id: string;
  when: PolicyWhen;
  require?: PolicyRequire;
  prefer?: { tags?: string[]; providers?: string[] };
  select: PolicySelect;
}

export interface PolicyModelRef {
  id: string;
  provider: string;
  model: string;
  tags?: string[];
}

export interface FallbackRule {
  from: string;
  to: string[];
  on: ProviderErrorCode[];
}

export interface RoutingPolicy {
  version: string;
  defaults?: {
    strategy?: StrategyConfig;
    fallbackAllowed?: boolean;
    qualityProfile?: "economy" | "balanced" | "premium";
  };
  models?: PolicyModelRef[];
  routes: PolicyRoute[];
  fallbacks?: FallbackRule[];
  resilience?: {
    deadlineMs?: number;
    retry?: {
      maxAttempts?: number;
      retryableErrors?: ProviderErrorCode[];
      baseDelayMs?: number;
      maxDelayMs?: number;
    };
    fallback?: { maxModelFallbacks?: number; errors?: ProviderErrorCode[] };
  };
  evaluation?: {
    gates?: {
      maxQualityDrop?: number;
      minCostReduction?: number;
      maxConstraintViolations?: number;
      maxP95LatencyIncrease?: number;
    };
  };
}

export interface RouterHookContext {
  requestId: string;
  task?: TaskClassificationResult;
  decision?: RoutingDecision;
  event: string;
}

export interface RouterHooks {
  beforeNormalize?: (context: RouterHookContext) => void | Promise<void>;
  afterNormalize?: (context: RouterHookContext) => void | Promise<void>;
  beforeClassify?: (context: RouterHookContext) => void | Promise<void>;
  afterClassify?: (context: RouterHookContext) => void | Promise<void>;
  beforeSelect?: (context: RouterHookContext) => void | Promise<void>;
  afterSelect?: (context: RouterHookContext) => void | Promise<void>;
  beforeExecute?: (context: RouterHookContext) => void | Promise<void>;
  afterExecute?: (context: RouterHookContext) => void | Promise<void>;
  onAttemptError?: (context: RouterHookContext) => void | Promise<void>;
  onFallback?: (context: RouterHookContext) => void | Promise<void>;
  onComplete?: (context: RouterHookContext) => void | Promise<void>;
}

export interface RouterOptions {
  catalog: Catalog;
  policy: RoutingPolicy;
  adapters?: Record<string, ProviderAdapter>;
  taskClassifier?: TaskClassifier;
  healthStore?: HealthStore;
  budgetStore?: BudgetStore;
  libraryVersion?: string;
  now?: () => Date;
  random?: () => number;
  hooks?: RouterHooks;
  customStrategies?: RoutingStrategy[];
  executeShadowRequests?: boolean;
  shadowPolicies?: RoutingPolicy[];
  decisionOnly?: boolean;
}

export interface Router {
  decide(request: RoutingRequest): Promise<RoutingDecision>;
  explain(request: RoutingRequest): Promise<RoutingDecision>;
  execute<T = unknown>(request: RoutingRequest): Promise<ExecutionResult<T>>;
  stream(request: RoutingRequest): AsyncIterable<RouterEvent>;
  shadow(
    request: RoutingRequest,
  ): Promise<Array<{ policyVersion: string; decision: RoutingDecision }>>;
}

export interface EstimatedCost {
  currency: "USD";
  inputCost: number | null;
  outputCost: number | null;
  cachedInputCost: number | null;
  total: number | null;
  unknownReason?: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  reasons: EliminationReason[];
}
