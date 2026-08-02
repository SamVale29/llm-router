import { StrictMode, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { demoCatalog } from "@llm-router/catalog";
import {
  createRouter,
  parsePolicyYaml,
  type MessageContent,
  type RoutingDecision,
  type RoutingRequest,
} from "@llm-router/core";
import "./styles.css";

type Preset = { id: string; label: string; note: string; request: RoutingRequest };

function messageContentToText(content: MessageContent | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[${part.type} attachment]`))
    .join("\n");
}

const policyText = [
  'version: "1.0.0"',
  "defaults:",
  "  strategy: weighted-score",
  "  fallbackAllowed: true",
  "models:",
  "  - { id: demo-code-pro, provider: demo-openai, model: demo-code-pro }",
  "  - { id: demo-economy, provider: demo-openrouter, model: demo-economy }",
  "  - { id: demo-vision, provider: demo-google, model: demo-vision }",
  "  - { id: demo-long-context, provider: demo-anthropic, model: demo-long-context }",
  "  - { id: demo-private, provider: demo-compatible, model: demo-private }",
  "routes:",
  "  - id: code",
  "    when: { task: code-review }",
  "    require: { capabilities: [structured-outputs] }",
  "    prefer: { tags: [code] }",
  "    select: { strategy: { kind: weighted-score, weights: { taskFit: 0.45, quality: 0.30, cost: 0.15, latency: 0.10 } } }",
  "  - id: translation",
  "    when: { task: translation }",
  "    select: { strategy: cheapest-qualified }",
  "  - id: ocr",
  "    when: { task: ocr }",
  "    require: { inputModalities: [image] }",
  "    select: { strategy: cheapest-qualified, candidates: [demo-vision] }",
  "  - id: long-summary",
  "    when: { task: long-document-summarization }",
  "    require: { minContextTokens: 100000 }",
  "    select: { strategy: weighted-score }",
  "fallbacks:",
  "  - { from: demo-code-pro, to: [demo-long-context, demo-economy], on: [rate-limit, timeout, unavailable] }",
].join("\n");

const presets: Preset[] = [
  {
    id: "code-review",
    label: "Code review",
    note: "Structured code review prefers a code-capable model.",
    request: {
      messages: [
        { role: "user", content: "Review this TypeScript function and return structured issues." },
      ],
      hints: { task: "code-review" },
      output: {
        schema: { type: "object", required: ["issues"], properties: { issues: { type: "array" } } },
      },
    },
  },
  {
    id: "translation",
    label: "Translation",
    note: "Economy profile demonstrates cost-aware selection.",
    request: {
      messages: [{ role: "user", content: "Traduza este parágrafo do português para o inglês." }],
      hints: { task: "translation", quality: "economy" },
      constraints: { maxEstimatedRequestCost: 0.01 },
    },
  },
  {
    id: "invoice-ocr",
    label: "Invoice OCR",
    note: "An image requirement eliminates text-only candidates.",
    request: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract invoice fields." },
            {
              type: "image",
              source: { type: "url", value: "https://example.invalid/invoice.png" },
            },
          ],
        },
      ],
      hints: { task: "ocr" },
      constraints: { requiredInputModalities: ["image"] },
    },
  },
  {
    id: "long-summary",
    label: "Long summary",
    note: "A large context requirement demonstrates capability filtering.",
    request: {
      messages: [{ role: "user", content: "Summarize this long report." }],
      hints: { task: "long-document-summarization" },
      input: { estimatedTokens: 120000 },
      constraints: { minContextTokens: 100000 },
    },
  },
  {
    id: "structured-extraction",
    label: "Structured extraction",
    note: "Schema support is treated as a hard requirement.",
    request: {
      messages: [{ role: "user", content: "Extract the customer record from this text." }],
      output: {
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
    },
  },
  {
    id: "customer-support",
    label: "Customer support",
    note: "Unknown task uses the policy default with a warning.",
    request: {
      messages: [{ role: "user", content: "A customer needs help changing their plan." }],
    },
  },
  {
    id: "tool-agent",
    label: "Tool-using agent",
    note: "Function calling is filtered before scoring.",
    request: {
      messages: [{ role: "user", content: "Look up the order status." }],
      hints: { task: "tool-use" },
      tools: [
        {
          name: "lookup_order",
          description: "Look up an order",
          parameters: {
            type: "object",
            properties: { orderId: { type: "string" } },
            required: ["orderId"],
          },
          strict: true,
        },
      ],
    },
  },
  {
    id: "privacy",
    label: "Privacy restricted",
    note: "The private EU endpoint is the only demo model with zero retention.",
    request: {
      messages: [{ role: "user", content: "Classify this sensitive document." }],
      constraints: { requiredRegions: ["eu"], zeroDataRetentionRequired: true },
    },
  },
  {
    id: "outage",
    label: "Provider outage",
    note: "Inspect the fallback chain in the decision trace.",
    request: {
      messages: [{ role: "user", content: "Please complete this request." }],
      hints: { task: "chat" },
    },
  },
  {
    id: "budget",
    label: "Budget exceeded",
    note: "A hard cost ceiling can eliminate expensive candidates.",
    request: {
      messages: [{ role: "user", content: "Reason over this difficult question." }],
      hints: { task: "reasoning" },
      constraints: { maxEstimatedRequestCost: 0.0001 },
    },
  },
];

const pages = [
  "Overview",
  "Policy editor",
  "Request builder",
  "Decision explorer",
  "Candidate comparison",
  "Replay report",
  "Evaluation report",
  "Architecture",
  "Documentation",
];

function App(): ReactElement {
  const [policy, setPolicy] = useState(policyText);
  const [presetId, setPresetId] = useState("code-review");
  const [requestText, setRequestText] = useState(
    messageContentToText(presets[0]?.request.messages[0]?.content),
  );
  const [decision, setDecision] = useState<RoutingDecision | null>(null);
  const [page, setPage] = useState("Overview");
  const [policyError, setPolicyError] = useState<string | null>(null);
  const preset = presets.find((item) => item.id === presetId) ?? presets[0];
  const parsed = useMemo(() => {
    try {
      const value = parsePolicyYaml(policy, demoCatalog);
      setPolicyError(null);
      return value;
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [policy]);

  const runDecision = (): void => {
    if (!parsed || !preset) return;
    const request: RoutingRequest = {
      ...preset.request,
      messages: [{ role: "user", content: requestText || "Run the selected preset." }],
    };
    void createRouter({ catalog: demoCatalog, policy: parsed })
      .decide(request)
      .then((value) => {
        setDecision(value);
        setPage("Decision explorer");
      });
  };
  const choosePreset = (id: string): void => {
    const next = presets.find((item) => item.id === id);
    setPresetId(id);
    setRequestText(next ? messageContentToText(next.request.messages[0]?.content) : "");
    setDecision(null);
  };
  const shareScenario = (): void => {
    const encoded = window.btoa(unescape(encodeURIComponent(JSON.stringify({ policy, presetId }))));
    window.history.replaceState({}, "", "#scenario=" + encoded);
    void navigator.clipboard?.writeText(window.location.href);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#overview" onClick={() => setPage("Overview")}>
          <span className="brand-mark">↗</span>
          <span>LLM Router</span>
        </a>
        <span className="tagline">Route every AI request to the right model — transparently.</span>
        <a
          className="github-link"
          href="https://github.com/SamVale29/llm-router"
          target="_blank"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
      </header>
      <div className="layout">
        <aside className="sidebar" aria-label="Playground pages">
          <p className="eyebrow">PLAYGROUND</p>
          {pages.map((item) => (
            <button
              key={item}
              className={page === item ? "nav-item active" : "nav-item"}
              onClick={() => setPage(item)}
            >
              {item}
            </button>
          ))}
          <div className="privacy-note">
            <span>◉</span>
            <p>
              <strong>Decision-only mode</strong>
              <br />
              No API keys. No prompt leaves this browser.
            </p>
          </div>
        </aside>
        <main className="main-content">
          <section className="hero">
            <div>
              <p className="eyebrow accent">MODEL ROUTING AS CODE</p>
              <h1>
                Make every model choice
                <br />
                <em>explainable.</em>
              </h1>
              <p className="hero-copy">
                LLM Router applies constraints first, then scores qualified candidates by task fit,
                quality, cost, latency and reliability.
              </p>
              <div className="hero-actions">
                <button
                  className="primary"
                  onClick={() => {
                    setPage("Request builder");
                    runDecision();
                  }}
                >
                  Try a preset <span>→</span>
                </button>
                <button className="secondary" onClick={() => setPage("Architecture")}>
                  Explore the pipeline
                </button>
              </div>
            </div>
            <div className="hero-card">
              <div className="card-top">
                <span className="status-dot" /> LIVE DECISION TRACE{" "}
                <span className="trace-id">#demo-042</span>
              </div>
              <div className="trace-row">
                <span>REQUEST</span>
                <strong>code-review</strong>
              </div>
              <div className="trace-arrow">↓</div>
              <div className="trace-row">
                <span>CONSTRAINTS</span>
                <strong className="muted">structured outputs · tools</strong>
              </div>
              <div className="trace-arrow">↓</div>
              <div className="trace-selected">
                <div>
                  <span>SELECTED MODEL</span>
                  <strong>demo-code-pro</strong>
                </div>
                <span className="score">0.91</span>
              </div>
              <div className="trace-reason">
                “Highest weighted score among 3 qualified candidates.”
              </div>
            </div>
          </section>
          <section className="stat-strip">
            <div>
              <strong>5</strong>
              <span>adapter surfaces</span>
            </div>
            <div>
              <strong>8</strong>
              <span>routing strategies</span>
            </div>
            <div>
              <strong>0</strong>
              <span>API keys required</span>
            </div>
            <div>
              <strong>100%</strong>
              <span>decision trace</span>
            </div>
          </section>
          <section className="workspace-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">INTERACTIVE EXPLORER</p>
                <h2>See the policy make the call.</h2>
              </div>
              <button className="share-button" onClick={shareScenario}>
                Share scenario ↗
              </button>
            </div>
            <div className="explorer-grid">
              <div className="control-column">
                <label htmlFor="preset">Preset</label>
                <select
                  id="preset"
                  data-testid="preset"
                  value={presetId}
                  onChange={(event) => choosePreset(event.target.value)}
                >
                  {presets.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <p className="field-help">{preset?.note}</p>
                <label htmlFor="request">Request text</label>
                <textarea
                  id="request"
                  value={requestText}
                  onChange={(event) => setRequestText(event.target.value)}
                  rows={5}
                />
                <button
                  className="primary full"
                  data-testid="run-decision"
                  onClick={runDecision}
                  disabled={!parsed}
                >
                  Run decision <span>→</span>
                </button>
                <div className="policy-mini">
                  <div className="mini-heading">
                    <span>POLICY</span>
                    <button onClick={() => setPage("Policy editor")}>Edit</button>
                  </div>
                  <pre>{policy.split("\n").slice(0, 9).join("\n")}\n…</pre>
                </div>
              </div>
              <div className="decision-column">
                {decision ? <DecisionView decision={decision} /> : <EmptyDecision />}
              </div>
            </div>
          </section>
          {page === "Policy editor" && (
            <section className="detail-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">POLICY EDITOR</p>
                  <h2>Version routing rules with your codebase.</h2>
                </div>
                <button className="secondary" onClick={() => setPolicy(policyText)}>
                  Reset example
                </button>
              </div>
              <textarea
                className="policy-editor"
                aria-label="Policy YAML"
                value={policy}
                onChange={(event) => setPolicy(event.target.value)}
              />
              {policyError ? (
                <p className="error-banner">{policyError}</p>
              ) : (
                <p className="valid-banner">✓ Valid policy · version {parsed?.version}</p>
              )}
            </section>
          )}
          {page === "Architecture" && <Architecture />}
          {page === "Documentation" && <Documentation />}
          {page === "Candidate comparison" && decision && (
            <section className="detail-panel">
              <p className="eyebrow">CANDIDATE COMPARISON</p>
              <h2>Every elimination is visible.</h2>
              <CandidateTable decision={decision} />
            </section>
          )}
          {page === "Replay report" && (
            <ReportPlaceholder
              title="Replay report"
              body="Load anonymized JSONL traces locally with the CLI to compare policy versions."
            />
          )}
          {page === "Evaluation report" && (
            <ReportPlaceholder
              title="Evaluation report"
              body="Run the offline evaluation harness to generate JSON, Markdown, HTML and CSV reports."
            />
          )}
        </main>
      </div>
    </div>
  );
}

function EmptyDecision(): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-icon">✦</div>
      <h3>Your decision trace will appear here.</h3>
      <p>
        Choose a preset and run it to see constraints, candidate elimination and the final model
        selection.
      </p>
      <div className="pipeline-mini">
        <span>Normalize</span>
        <b>→</b>
        <span>Filter</span>
        <b>→</b>
        <span>Score</span>
        <b>→</b>
        <span>Select</span>
      </div>
    </div>
  );
}
function DecisionView({ decision }: { decision: RoutingDecision }): ReactElement {
  return (
    <div className="decision-view">
      <div className="decision-header">
        <div>
          <span className="label">SELECTED MODEL</span>
          <h3 data-testid="selected-model">{decision.selected?.modelId ?? "No eligible model"}</h3>
          <p>{decision.explanation.summary}</p>
        </div>
        <div className="decision-badge">
          {decision.estimates.cost == null
            ? "cost unknown"
            : "$" + decision.estimates.cost.toFixed(5) + " est."}
        </div>
      </div>
      <div className="reason-box">
        <span>WHY THIS MODEL?</span>
        <p>{decision.explanation.reasons[0]}</p>
      </div>
      <div className="metrics">
        <div>
          <span>Task</span>
          <strong>{decision.task.type}</strong>
        </div>
        <div>
          <span>Strategy</span>
          <strong>{decision.strategy.id}</strong>
        </div>
        <div>
          <span>Latency</span>
          <strong>
            {decision.estimates.latencyMs ? decision.estimates.latencyMs + " ms" : "unknown"}
          </strong>
        </div>
        <div>
          <span>Fallbacks</span>
          <strong>{decision.fallbackChain.length}</strong>
        </div>
      </div>
      <div className="candidate-heading">
        <span>CANDIDATES</span>
        <span>
          {decision.candidates.filter((candidate) => candidate.eligible).length} qualified ·{" "}
          {decision.candidates.length} total
        </span>
      </div>
      <CandidateTable decision={decision} />
      {decision.explanation.warnings.length > 0 && (
        <div className="warning-box">⚠ {decision.explanation.warnings[0]}</div>
      )}
    </div>
  );
}
function CandidateTable({ decision }: { decision: RoutingDecision }): ReactElement {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Status</th>
            <th>Score</th>
            <th>Est. cost</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {decision.candidates.map((candidate) => (
            <tr key={candidate.model.id}>
              <td>
                <strong>{candidate.model.id}</strong>
                <small>{candidate.model.providerId}</small>
              </td>
              <td>
                <span className={candidate.eligible ? "pill eligible" : "pill eliminated"}>
                  {candidate.eligible ? "qualified" : "eliminated"}
                </span>
              </td>
              <td>
                {candidate.scores.total === null || candidate.scores.total === undefined
                  ? "—"
                  : candidate.scores.total.toFixed(2)}
              </td>
              <td>
                {candidate.predicted.cost === null || candidate.predicted.cost === undefined
                  ? "unknown"
                  : "$" + candidate.predicted.cost.toFixed(5)}
              </td>
              <td className="reason-cell">
                {candidate.eligible ? "Available to strategy" : candidate.eliminatedBy[0]?.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Architecture(): ReactElement {
  return (
    <section className="detail-panel architecture">
      <p className="eyebrow">ARCHITECTURE</p>
      <h2>Constraints before optimization.</h2>
      <div className="flow">
        <span>Request</span>
        <b>→</b>
        <span>Normalize</span>
        <b>→</b>
        <span>Detect task</span>
        <b>→</b>
        <span className="highlight">Filter candidates</span>
        <b>→</b>
        <span>Score</span>
        <b>→</b>
        <span className="highlight">Explain</span>
      </div>
      <p>
        The router never treats a missing capability, price or latency observation as a silent pass.
        Every decision contains the request fingerprint, policy and catalog versions, candidate
        signals and fallback chain.
      </p>
    </section>
  );
}
function Documentation(): ReactElement {
  return (
    <section className="detail-panel documentation">
      <p className="eyebrow">DOCUMENTATION</p>
      <h2>What to explore next.</h2>
      <div className="doc-grid">
        <article>
          <span>01</span>
          <h3>Policy as code</h3>
          <p>Write rules in YAML or TypeScript, validate references and test changes offline.</p>
        </article>
        <article>
          <span>02</span>
          <h3>Explainability</h3>
          <p>
            See why models were eliminated, which signals drove the score and what will happen on
            failure.
          </p>
        </article>
        <article>
          <span>03</span>
          <h3>Shadow + replay</h3>
          <p>Compare candidate policies without duplicating provider calls or exposing prompts.</p>
        </article>
      </div>
      <a href="https://github.com/SamVale29/llm-router#readme" target="_blank" rel="noreferrer">
        Read the full documentation ↗
      </a>
    </section>
  );
}
function ReportPlaceholder({ title, body }: { title: string; body: string }): ReactElement {
  return (
    <section className="detail-panel">
      <p className="eyebrow">OFFLINE REPORT</p>
      <h2>{title}</h2>
      <p className="placeholder-copy">{body}</p>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
