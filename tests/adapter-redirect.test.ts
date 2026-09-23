import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "@llm-router/adapter-openai-compatible";
import type { ExecutionContext, ModelDefinition, NormalizedRoutingRequest } from "@llm-router/core";

// AUD-ENDPOINT-002 — validateEndpoint só inspeciona a URL declarada. Se o endpoint responder
// 3xx, o fetch padrão segue o redirect e o destino nunca é revalidado, então a resposta
// devolvida ao chamador vem de um host que jamais passou pela validação.

const CONTEUDO_DO_DESTINO = "CONTEUDO-DO-DESTINO-NAO-VALIDADO";

const model: ModelDefinition = {
  id: "m",
  providerId: "p",
  apiModelId: "modelo-x",
  displayName: "M",
  status: "active",
  modalities: { input: ["text"], output: ["text"] },
  capabilities: {},
  limits: { contextTokens: 1000, outputTokens: 100 },
  operational: { enabled: true },
};
const request: NormalizedRoutingRequest = {
  id: "r",
  messages: [{ role: "user", content: "oi" }],
  input: { modalities: ["text"] },
  output: {},
  constraints: {},
  detectedModalities: ["text"],
  estimatedInputTokens: 2,
};
const context: ExecutionContext = {
  signal: new AbortController().signal,
  requestId: "r",
  attempt: 1,
  timeoutMs: 5_000,
};

const listen = (server: Server, port: number): Promise<void> =>
  new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
const close = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

let destino: Server;
let declarado: Server;

beforeAll(async () => {
  destino = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: CONTEUDO_DO_DESTINO } }],
      }),
    );
  });
  declarado = createServer((incoming, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:8811${incoming.url ?? "/"}` });
    response.end();
  });
  await listen(destino, 8811);
  await listen(declarado, 8810);
});

afterAll(async () => {
  await close(declarado);
  await close(destino);
});

describe("AUD-ENDPOINT-002 — redirect do endpoint declarado", () => {
  it("não segue o redirect de forma transparente", async () => {
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "http://127.0.0.1:8810/v1",
      allowHosts: ["127.0.0.1"],
    });

    // VERMELHO hoje: execute() resolve com o corpo do destino em vez de rejeitar.
    await expect(adapter.execute(request, model, context)).rejects.toThrow(/redirect/i);
  });

  it("não devolve ao chamador conteúdo de um host não validado", async () => {
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "http://127.0.0.1:8810/v1",
      allowHosts: ["127.0.0.1"],
    });

    // VERMELHO hoje: response.text === CONTEUDO_DO_DESTINO.
    const resposta = await adapter.execute(request, model, context).catch(() => null);
    expect(resposta?.text).not.toBe(CONTEUDO_DO_DESTINO);
  });

  it("classifica a recusa como erro não repetível", async () => {
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "http://127.0.0.1:8810/v1",
      allowHosts: ["127.0.0.1"],
    });

    const erro = await adapter.execute(request, model, context).then(
      () => null,
      (cause: unknown) => adapter.normalizeError(cause),
    );
    expect(erro).not.toBeNull();
    expect(erro?.retryable).toBe(false);
  });
});
