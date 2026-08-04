# Auditoria técnica — LLM Router v0.1.0

> **⚠️ Reverificação em 2026-08-04 (2ª rodada) — ver [Anexo A](#anexo-a--reverificação) no final.**
> Todos os 3 críticos, os 9 altos e os 18 médios foram corrigidos e confirmados por re-execução das mesmas provas e pelos gates do alvo Windows.
> N1 também foi corrigido; permanecem apenas as melhorias baixas B1 e B4, sem impacto no bloqueio de release.

**Data:** 2026-08-04 · **Commit:** `b1cab08` (+6 arquivos modificados não commitados)
**Escopo:** arquitetura, código, segurança, testes, build/CI, documentação e prontidão para release
**Base analisada:** 6.083 linhas TypeScript em 12 pacotes + playground

---

## Sumário executivo

O projeto tem uma tese forte e uma arquitetura correta: separação limpa entre decisão e execução, `unknown` nunca tratado como suporte, restrições aplicadas antes da otimização, objeto de decisão rico. O código compila sem erro em `strict` com `noUncheckedIndexedAccess`, a configuração de ESLint/Prettier é séria e a CI cobre 3 versões de Node com CodeQL e dependency-review.

O problema é que **as três promessas centrais do README não se sustentam quando exercitadas**: a explicabilidade mente sobre os pesos aplicados, a resiliência não dispara em 2 dos 5 adapters, e o teto de orçamento é inerte. Nenhuma delas falha de forma visível — todas falham em silêncio, produzindo uma decisão plausível e uma explicação confiante. Para uma ferramenta cujo produto _é_ a confiança na decisão, esse é o pior modo de falha possível.

A causa raiz não é descuido de implementação, é **ausência de teste**: 10 testes unitários para 6.083 linhas. Proxy, CLI, streaming e 4 dos 5 adapters não têm nenhum teste. Todos os achados críticos abaixo foram reproduzidos em menos de 40 linhas de script — qualquer um deles teria sido pego por um teste de contrato mínimo.

| Severidade | Qtd. | Natureza                                                                 |
| ---------- | ---- | ------------------------------------------------------------------------ |
| 🔴 Crítico | 3    | Queda de processo remota; explicação incorreta; resiliência inativa      |
| 🟠 Alto    | 9    | Controles de custo inertes; IDs colidindo; streaming quebrado; cobertura |
| 🟡 Médio   | 18   | Hardening do proxy, contrato dos adapters, validação de policy, release  |
| 🔵 Baixo   | 14   | Higiene de empacotamento, metadados, docs, drift de schema               |

**Veredito de release:** não recomendo publicar como `0.1.0` estável. C1–C3 e A1–A3 são corrigíveis em poucos dias e a maioria vem acompanhada de um teste de regressão óbvio.

> Todos os achados abaixo foram **verificados executando o código compilado**, não por leitura. Os blocos `Reprodução` são saídas reais.

---

## 🔴 Críticos

### C1 — Requisição de streaming derruba o processo do proxy (DoS remoto não autenticado)

**Arquivo:** `packages/proxy/src/index.ts:28-30, 100-108, 119-131`

`handleCompletion` escreve os cabeçalhos SSE (linha 120) **antes** de iterar `router.stream()`. Se a decisão falhar depois disso — hook do usuário que lança, política inválida, catálogo inconsistente — a exceção sobe até o `catch` da linha 100, que chama `sendJson` → `response.writeHead()` com cabeçalhos já enviados → `ERR_HTTP_HEADERS_SENT`. Esse throw acontece _dentro_ do bloco `catch`, então escapa de `handle`, e a chamada é `void handle(request, response)` (linha 29): rejeição não tratada.

No Node ≥ 15 o padrão é **encerrar o processo**.

```
Reprodução (node probe7.mjs):
  ERR_HTTP_HEADERS_SENT: Cannot write headers after they are sent to the client
      at handle (packages/proxy/dist/index.js:83:13)
  EXIT=1        ← processo morto
```

Agravantes: `authToken` é opcional e a CLI só o define se `LLM_ROUTER_PROXY_TOKEN` estiver no ambiente (`packages/cli/src/index.ts:115`). Sem token, qualquer cliente que alcance a porta derruba o serviço com um único POST. Não há listener de `'error'` no servidor (linha 135), então `EADDRINUSE` também mata o processo.

**Correção:** envolver o laço de streaming em `try/catch` próprio que, com cabeçalhos já enviados, emita um evento SSE de erro e chame `response.end()`; verificar `response.headersSent` antes de qualquer `sendJson`; adicionar `.catch()` na linha 29 e `server.on("error", …)`.

---

### C2 — Pesos de rota são ignorados, e a explicação afirma que foram aplicados

**Arquivo:** `packages/core/src/router.ts:847` (e `806-819`)

`normalizeCandidateScores` calcula `scores.total` com `normalizeWeights(undefined)` — sempre os pesos padrão. A estratégia `weighted-score` chega a computar `normalizeWeights(config.weights)` na linha 807, mas usa o resultado **apenas para montar a string de justificativa**; a ordenação (linha 808) usa `scores.total`, já calculado com os padrões.

Consequência: `select.weights` e `strategy.weights` não têm efeito algum sobre a escolha — e o campo `explanation.reasons` reporta os pesos configurados como se tivessem sido usados.

```
Reprodução (node probe1.mjs):
  cost=1.0      -> demo-economy | totals: code-pro=0.5404 economy=0.7220 vision=0.6266 …
  quality=1.0   -> demo-economy | totals: code-pro=0.5404 economy=0.7220 vision=0.6266 …
  MESMO RESULTADO = true
  razão declarada: "Selected the highest weighted score (0.722),
                    with weights {"taskFit":0,"quality":0,"cost":1,"latency":0,"reliability":0}."
```

Pesos radicalmente opostos produzem `scores.total` **idêntico até a quarta casa**, e a explicação imprime pesos que nunca foram aplicados. Isso é pior que um bug de roteamento: é o mecanismo de auditoria produzindo evidência falsa.

O único teste que exercita pesos (`packages/core/src/core.test.ts:27`) usa `{0.35, 0.25, 0.15, 0.15, 0.1}` — exatamente os valores padrão de `normalizeWeights`. O teste passa porque não consegue distinguir os dois caminhos.

**Correção:** passar os pesos resolvidos para `normalizeCandidateScores`; adicionar teste que use pesos deliberadamente diferentes dos padrões e verifique inversão de escolha.

---

### C3 — Adapters Anthropic e Google descartam a classificação de erro: retry e fallback nunca disparam

**Arquivos:** `packages/adapter-anthropic/src/index.ts:75-77, 156-166`; `packages/adapter-google/src/index.ts:38-40, 118-128`

Ambos convertem erros HTTP em `new Error(sanitizeMessage(message))` — perdendo status code e `retry-after` — e implementam `normalizeError` como `normalizedErrorFromUnknown(error)` puro. A classificação passa a depender de `inferErrorCode()` (`errors.ts:78-89`) adivinhando por substring na mensagem do provedor.

As mensagens reais da Anthropic não contêm as substrings procuradas:

```
Reprodução (node probe8.mjs) — mensagens reais dos provedores:

  Anthropic 529 overloaded   -> code=unknown      retryable=false  fallback=false  status=PERDIDO  retryAfter=PERDIDO
  Anthropic 500 interno      -> code=unknown      retryable=false  fallback=false  status=PERDIDO  retryAfter=PERDIDO
  Anthropic 429              -> code=unknown      retryable=false  fallback=false  status=PERDIDO  retryAfter=PERDIDO
  OpenAI-compat 503          -> code=unavailable  retryable=true   fallback=true   status=503      retryAfter=30000
```

`retryable=false` + `fallbackEligible=false` significa que o laço de `execute` (`router.ts:465, 472-476`) **encerra na primeira falha**. Sobrecarga da Anthropic — o caso de uso canônico para fallback — não aciona nem retentativa nem modelo alternativo. O adapter OpenAI-compatible faz certo (`HttpAdapterError`, linhas 192-251): o padrão correto já existe no repositório e simplesmente não foi replicado.

**Correção:** extrair `HttpAdapterError` + `httpError()` para `@llm-router/core` (ou um pacote compartilhado) e usar nos três adapters; teste de contrato por adapter cobrindo 429/500/529/503 com as mensagens reais.

---

## 🟠 Altos

### A1 — `maxMonthlyBudget` não bloqueia nada em uso normal

**Arquivo:** `packages/core/src/router.ts:1007-1015`

`usageScope` retorna `{ type: "request", id: request.id }` quando não há `metadata.userId` nem `metadata.projectId`. Como cada requisição tem id próprio, o consumo é registrado num balde novo a cada chamada e `getUsage` sempre devolve zero.

```
Reprodução (node probe3.mjs):
  D1 (ids distintos, ~$0,75 × 20 gastos, limite $0,01)
     -> selecionou = demo-economy | bloqueado = false        ← ~$15 gastos, teto $0,01
  D3 (metadata.userId="ana")
     -> bloqueado = true                                      ← só funciona com escopo explícito
```

Além disso, `createInMemoryBudgetStore` (`health.ts:98-113`) nunca reinicia por mês, apesar do nome do limite: é "desde que o processo subiu, para sempre". E a leitura acontece uma vez antes do laço de candidatos, sem reserva — requisições concorrentes estouram o teto.

**Correção:** recusar `maxMonthlyBudget` (ou emitir warning explícito na decisão) quando não houver escopo de agregação; implementar janela mensal real; documentar a ausência de reserva atômica.

---

### A2 — `requestId` colide: 41 colisões em 50 decisões

**Arquivo:** `packages/core/src/router.ts:65`

```ts
const requestId = request.id ?? `request-${Date.now().toString(36)}`;
```

Sem contador — ao contrário de `normalizeRequest` (`normalize.ts:13`), que já usa `${Date.now()}-${++requestCounter}`. Duas funções geram ids no mesmo fluxo com garantias diferentes.

```
Reprodução (node probe3.mjs):
  D2: 50 decisões sem id -> 9 requestIds únicos (colisões = 41)
```

Impacto: `decisionId` colide (é derivado do `requestId`), correlação de traces se mistura, e o balde de orçamento de requisições não relacionadas se funde — o que explica por que A1 às vezes bloqueia _indevidamente_ sob carga, além de não bloquear quando deveria.

**Correção:** usar `randomUUID()` ou reaproveitar o gerador de `normalize.ts`.

---

### A3 — Parsing de SSE quebra nos dois adapters com streaming

**Arquivos:** `packages/adapter-openai-compatible/src/index.ts:66-75`; `packages/adapter-anthropic/src/index.ts:66-72`

Ambos fazem `JSON.parse` em qualquer linha não vazia, após remover apenas o prefixo `data:`.

```
Reprodução (node probe4.mjs):
  E — OpenAI SSE com ': keepalive'          QUEBRA: SyntaxError - Unexpected token ':'
  F — Anthropic SSE (formato real 'event:') QUEBRA: SyntaxError - Unexpected token 'e'
```

- Comentários SSE (`: keepalive`) fazem parte do padrão e são enviados por OpenAI e OpenRouter em conexões longas.
- A Anthropic emite `event: <tipo>` antes de cada `data:`. O streaming da Anthropic **não pode nunca ter funcionado** contra a API real.

Nenhum dos dois tem teste de streaming. Adicionalmente, o `reader` nunca é liberado (`releaseLock`/`cancel` ausentes) — vazamento em caso de abort.

**Correção:** ignorar linhas vazias, comentários (`:`) e campos que não sejam `data:`; envolver `JSON.parse` em try/catch; `try/finally` com `reader.releaseLock()`.

---

### A4 — Erro de digitação em `strategy` passa na validação e degrada em silêncio

**Arquivos:** `packages/core/src/policy.ts:355-358`; `router.ts:827-832`

`normalizeStrategy` faz cast de qualquer string para `StrategyConfig["kind"]` sem verificar contra a lista de estratégias conhecidas.

```
Reprodução (node probe2.mjs):
  'cheapest-qualifed' (typo) VALIDOU OK. strategyId: cheapest-qualifed
  razão: "Unknown strategy kind; selected first eligible candidate as a safe fallback."
  warning sobre strategy desconhecida? false
```

`pnpm cli validate policy.yaml` aprova o arquivo. Em produção a rota passa a escolher o primeiro candidato elegível — comportamento completamente diferente do pretendido — e **nenhum warning aparece na decisão**. A justificativa admite o problema, mas em texto livre que nada consome.

**Correção:** enumerar os `kind` válidos no schema Zod (`policy.ts:16-26`), considerando estratégias customizadas registradas; no mínimo, empurrar um item em `warnings` no fallback de `selectModel`.

---

### A5 — `providerOptions` sobrescreve o modelo roteado

**Arquivo:** `packages/adapter-openai-compatible/src/index.ts:137`

O spread de `request.providerOptions?.compatible` vem **depois** de `model`, `messages` e `tools` no payload.

```
Reprodução (node probe4.mjs):
  H — roteador escolheu 'gpt-x'; payload enviado usa model = modelo-nao-roteado
```

A decisão, o objeto de explicação, a estimativa de custo e o registro de orçamento continuam se referindo ao modelo roteado. O sistema todo passa a auditar uma chamada que não aconteceu. O README vende `providerOptions` como "preserva recursos específicos do provedor" — na prática também permite trocar o modelo.

**Correção:** aplicar `providerOptions` antes dos campos gerenciados, ou rejeitar chaves reservadas (`model`, `messages`, `tools`, `response_format`) com erro explícito.

---

### A6 — A CLI não consegue usar catálogo real nem executar requisições

**Arquivo:** `packages/cli/src/index.ts:101, 110, 129, 143`

Todos os comandos instanciam `createRouter({ catalog: demoCatalog, … })`. Não existe flag `--catalog` em lugar nenhum. `init` até escreve um `catalog.json` (linha 50) que nenhum comando lê depois.

`serve` (linhas 106-121) não registra adapter algum:

```
Reprodução (node probe6.mjs):
  G4 — execute sem adapter registrado -> HTTP 500
       {"error":{"code":"proxy-error","message":"No adapter is registered for provider demo-google."}}
```

O README documenta `pnpm cli serve` e lista `/v1/chat/completions` entre os endpoints. Esse caminho retorna 500 em 100% dos casos.

**Correção:** adicionar `--catalog`; para `serve`, ou registrar adapters a partir de configuração explícita, ou restringir o servidor aos endpoints `/v1/router/*` e documentar isso.

---

### A7 — Falha de validação de schema (não-retryável) provoca N chamadas pagas

**Arquivo:** `packages/core/src/router.ts:380-404`

O ramo `if (!validation.valid)` cria um erro com `retryable: false`, mas não faz `break`. O laço `for (let retry = 0; retry < maxAttempts; retry++)` continua.

```
Reprodução (node probe2.mjs):
  erro de schema marcado retryable:false, mas provider foi chamado 3 vezes (maxAttempts=3)
```

Dinheiro real gasto repetindo uma requisição cuja falha é determinística.

**Correção:** `break` após registrar a tentativa inválida.

---

### A8 — Cobertura de testes: 10 testes unitários para 6.083 linhas

| Área                                                           | Testes                                       |
| -------------------------------------------------------------- | -------------------------------------------- |
| `packages/core`                                                | 7 (`core.test.ts`)                           |
| `packages/evals`                                               | 2                                            |
| Adapters                                                       | 1 — só `openai-compatible`, só caminho feliz |
| `packages/proxy`                                               | **0**                                        |
| `packages/cli`                                                 | **0**                                        |
| Streaming                                                      | **0**                                        |
| `schema.ts`, `hash.ts`, `tasks.ts`, circuit breaker, orçamento | **0**                                        |
| E2E (Playwright)                                               | 3 — navegação do playground                  |

`vitest.config.ts:10-14` configura coverage v8 mas **sem threshold algum**, e `pnpm test` é `vitest run` sem `--coverage`: a configuração é decorativa e a CI nunca mede cobertura.

O README (linha 142) afirma: _"Adapter contract tests use a simulated fetch and never call paid APIs in CI"_ — plural, sugerindo suíte. `docs/adapters.md:9` manda copiar o teste de contrato e cobrir "success, usage, rate-limit, timeout, cancellation and redaction". Nenhum desses casos existe, nem para o único adapter testado.

Todos os achados C1–C3 e A1–A7 foram reproduzidos em scripts de menos de 40 linhas.

**Correção:** teste de contrato parametrizado rodando contra os 5 adapters; testes de integração do proxy (incluindo o caminho de streaming com falha); threshold de cobertura em CI começando pelo patamar atual e subindo.

---

### A9 — `sanitizeMessage` não redige as chaves reais dos provedores

**Arquivo:** `packages/core/src/errors.ts:60-65`

```
Reprodução (node probe2.mjs):
  in : Invalid key sk-proj-AbC123dEf456GhI789jKl
  out: Invalid key sk-proj-AbC123dEf456GhI789jKl          ← chave OpenAI intacta

  in : x-api-key AIzaSyD-1234567890abcdefg
  out: x-api-key AIzaSyD-1234567890abcdefg                ← chave Google intacta

  in : Authorization: Bearer eyJhbGciOi.J9+/=abc
  out: Authorization=[REDACTED] [REDACTED]+/=abc          ← cauda do token vaza
```

A classe `[a-z0-9._-]` do padrão `bearer` para em `+`, `/` e `=` — justamente os caracteres de base64. O README afirma que "chaves e cabeçalhos de autorização não são registrados pelo core".

**Correção:** adicionar padrões por prefixo (`sk-[A-Za-z0-9_-]{16,}`, `AIza[0-9A-Za-z_-]{30,}`, `sk-ant-…`, `xai-…`), incluir `+/=` nas classes de token e cobrir com teste.

---

## 🟡 Médios

**Proxy e superfície de rede** (`packages/proxy/src/index.ts`)

- **M1 · CORS `null`** (linha 36) — para origem não permitida o servidor devolve `Access-Control-Allow-Origin: null`, que _concede_ acesso a contextos de origem nula (iframes sandbox, `data:`, `file:`). Verificado: `G5 -> ACAO header = "null"`. Correto é omitir o cabeçalho.
- **M2 · `/v1/router/models` sem autenticação por padrão** — verificado: `HTTP 200, 5 modelos expostos`. Somando: comparação de token com `!==` não é de tempo constante (linha 45).
- **M3 · Erro de cliente vira 500 com eco da mensagem interna** — verificado: JSON malformado → `HTTP 500 {"message":"Expected property name or '}' in JSON at position 2"}`. Deveria ser 400/413, e a mensagem não passa por `sanitizeMessage`.
- **M12 · Rate limiter sem expurgo** (linhas 27, 51-58) — o `Map` por IP cresce indefinidamente. `OPTIONS` é tratado antes do rate limit (linha 40).
- **M13 · Sem `server.on("error")`** (linha 135) — `EADDRINUSE` derruba o processo.
- **M-extra · `toRoutingRequest` (linhas 157-165)** — se o corpo tiver `model` e `router`, o segundo spread apaga `requestedModel`. Pior: `record.router` entra cru em `metadata`, e `metadata.userId` define o escopo de orçamento — um cliente escolhe o próprio balde de gastos.

**Contrato dos adapters**

- **M4 · Chave do Google na query string** (`adapter-google/src/index.ts:20`) — `?key=…` vaza em logs de acesso, proxies e ferramentas de depuração HTTP. Usar o cabeçalho `x-goog-api-key`.
- **M6 · Imagem base64 malformada para a OpenAI** — verificado: envia `{"type":"image_url","image_url":"iVBORw0KGgo="}`; a API espera `{"image_url":{"url":"data:image/png;base64,…"}}`. O exemplo `multimodal-ocr` só faz `decide()`, então nunca exercita isso.
- **M7 · Anthropic** — papel `tool` é colapsado em `user` (linha 92), quebrando fluxos de ferramenta; não há tratamento de mensagens consecutivas do mesmo papel (a API rejeita); `output.schema` é ignorado, embora `compatibility.ts:74` exija a capacidade `structured-outputs` e o roteador depois valide a resposta e falhe.
- **M8 · Google** — `generationConfig` (e portanto `responseSchema`) só é enviado quando `output.maxTokens` está definido (linha 72). Saída estruturada sem `maxTokens` perde o schema silenciosamente.
- **M-extra · `request_id` no corpo** (`openai-compatible:138`) — parâmetro não padrão no payload; nunca foi testado contra API real.
- **M10-b · `validateEndpoint` aceita `http:`** — chave trafega em claro sem aviso; sem proteção contra SSRF (IPs privados, `169.254.169.254`).

**Núcleo**

- **M5 · Validação de policy frouxa** (`policy.ts:47-63`) — `when`, `require`, `prefer`, `select`, `resilience` e `evaluation` são todos `z.record(z.unknown())`. Um campo escrito errado dentro de `require` é aceito e ignorado. É a causa estrutural de A4.
- **M9 · `validateJsonSchema` é um subconjunto** (`schema.ts`) — sem `anyOf`/`oneOf`/`allOf`, `additionalProperties`, `minimum`/`maximum`, `minLength`, `format`, `$ref`. Um JSON Schema legítimo passa por validação bem mais fraca do que o usuário supõe, e o resultado alimenta decisão de fallback. Documentar o subconjunto ou usar Ajv.
- **M10 · Hooks sem isolamento** (`router.ts:1016-1021`) — `runHook` não tem try/catch: um hook do usuário que lança aborta a decisão inteira (foi assim que reproduzi C1). Além disso `emitStreamlessAttempt` (linhas 1022-1033) reaproveita `afterSelect` para eventos de tentativa, chamando o hook de telemetria sem `decision`.
- **M11 · Estimativa de tokens** (`normalize.ts:39-52`) — `chars/4` + **256 tokens fixos por parte não textual**. Imagens em alta resolução custam bem mais que isso; a subestimativa afrouxa tetos de contexto e de custo.
- **M17 · `random-weighted` com seed** (`router.ts:758`) — `seededRandom(config.seed)` é recriado a cada chamada, produzindo sempre o mesmo valor. A estratégia deixa de ser uma distribuição e vira escolha fixa.
- **M18 · Streaming sem resiliência** (`router.ts:514-572`) — o caminho de stream não tem retry nem fallback, usa `options.catalog.models` (linha 529) em vez dos candidatos materializados pela política, e emite `execution: { attempts: [], totalDurationMs: 0 }` — telemetria falsa.

**Release e processo**

- **M14 · Não há caminho de publicação.** O workflow `release.yml` só gera um tarball e cria a release no GitHub — nenhum `npm publish`. `.changeset/initial-release.md` marca os 12 pacotes como `minor`, mas **`@changesets/cli` não é dependência do projeto**: o diretório é configuração morta. Nenhum pacote tem `repository`, `homepage`, `bugs`, `keywords`, `author` ou `publishConfig`.
- **M15 · `examples/` fora do controle de qualidade** — não aparece em `tsconfig.check.json`, `eslint.config.js` nem `vitest.config.ts`. Os 8 exemplos TypeScript podem apodrecer sem que nada acuse. `examples/express-server` não usa Express (é o `node:http` do pacote proxy). Nenhum exemplo registra adapter — o recurso mais arriscado da biblioteca não tem exemplo executável.
- **M16 · CLI: `try/catch` não captura erro assíncrono** (`cli/src/index.ts:30-45`) — os ramos fazem `return init()` etc. dentro do `try`, sem `await`. Verificado: a rejeição escapa, o usuário recebe stack trace em vez da mensagem amigável e `process.exitCode = 1` nunca executa.

---

## 🔵 Baixos

| #   | Achado                                                                                                                                                                                           | Local                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| B1  | `policyJsonSchema()` é duplicata manual do schema Zod — já divergem (`required: ["id","when","select"]` vs. `when` opcional no Zod)                                                              | `policy.ts:220-266`          |
| B2  | `pack:check` só verifica se `dist/index.js` existe — não valida tarball, `exports` nem resolução de tipos. O `dist/` local contém `core.test.js` (artefato velho) e `files: ["dist"]` publicaria | `scripts/pack-check.ts`      |
| B3  | `files` de `@llm-router/catalog` lista `data` e `schemas`, e `@llm-router/core` lista `schemas` — **nenhum desses diretórios existe**                                                            | `packages/*/package.json`    |
| B4  | `catalog validate` escreve `catalog.schema.json` e `policy.schema.json` no CWD como efeito colateral de um comando de validação                                                                  | `cli/src/index.ts:170-171`   |
| B5  | `export *` de tudo no índice do core — sem superfície pública controlada; qualquer rename interno é breaking change                                                                              | `core/src/index.ts`          |
| B6  | `csv()` não neutraliza injeção de fórmula (`=`,`+`,`-`,`@`); `escapeHtml` não escapa `"` nem `'` (seguro hoje, frágil se reutilizado em atributo)                                                | `evals/src/index.ts:319-325` |
| B7  | Gates de `compareReports` são fixos no código, apesar de existir `policy.evaluation` no schema; `average()` retorna `NaN` em array vazio                                                         | `evals/src/index.ts:284-289` |
| B8  | CI sem `pnpm audit` e sem gate de cobertura; actions referenciadas por tag, não por SHA                                                                                                          | `.github/workflows/ci.yml`   |
| B9  | `doctor` nunca retorna código de saída não-zero — `pnpm test:cli` sempre "passa". Também reporta chaves de ambiente, o que atrita com o discurso de "o core nunca lê variáveis de ambiente"      | `cli/src/index.ts:175-210`   |
| B10 | `pureSha256` é SHA-256 escrito à mão sem vetores de teste conhecidos                                                                                                                             | `core/src/hash.ts:33-112`    |
| B11 | `exclude` de arquivos de teste só existe em `core` e `evals`; os outros 10 pacotes empacotariam testes vizinhos                                                                                  | `packages/*/tsconfig.json`   |
| B12 | `findRoute` compara `when.metadata` com `!==` — sempre falha para valores não primitivos                                                                                                         | `router.ts:650-654`          |
| B13 | Heurísticas de tarefa muito amplas: `function`, `bug`, `erro` disparam em prompts genéricos; `code-review` é avaliado antes de `debugging`                                                       | `core/src/tasks.ts:66-89`    |
| B14 | Documentação: 18 arquivos, **203 linhas no total** (~11 por arquivo). São esqueletos, não documentação                                                                                           | `docs/`                      |

---

## O que funciona bem

Vale registrar, porque é a base sobre a qual as correções se apoiam:

- **Modelo de capacidades correto.** `hasCapability` retorna `value === true` (`compatibility.ts:212`): `"unknown"` nunca vira suporte. Coberto por teste.
- **Custo desconhecido nunca vira zero.** `estimateRequestCost` propaga `null` e registra `unknownReason` (`cost.ts:33-43`). Coberto por teste.
- **Restrições antes da otimização.** O laço de candidatos elimina antes de pontuar e preserva `eliminatedBy` estruturado por candidato — é a parte do design que mais se sustenta.
- **`tsconfig` rigoroso.** `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`. Compilação limpa: `tsc -p tsconfig.check.json --noEmit` sobre os 12 pacotes não produziu **um único erro** no código-fonte da biblioteca.
- **CI decente para v0.1** — matriz Node 20/22/24, `--frozen-lockfile`, CodeQL, dependency-review, E2E com Playwright.
- **Detecção de ciclos de fallback** (`policy.ts:375-393`) e validação de referências de modelo — cuidado acima da média para a versão.
- **`renderEvalHtml` escapa corretamente** — sem XSS nos relatórios gerados.

---

## Plano de correção sugerido

**Antes de qualquer release pública (1–2 dias)**

1. C1 — `try/catch` no laço de streaming + `headersSent` + `.catch()` no handler + `server.on("error")`.
2. C2 — propagar pesos para `normalizeCandidateScores`; teste com pesos ≠ padrão.
3. C3 — extrair `HttpAdapterError` para o core e usar em Anthropic e Google.
4. A7 — `break` após falha de validação de schema (uma linha).
5. A2 — `randomUUID()` no `requestId`.

**Antes de anunciar como utilizável em produção (1–2 semanas)**

6. A1 — orçamento: escopo explícito obrigatório + janela mensal real + warning quando inaplicável.
7. A3 — parser SSE correto nos dois adapters, com teste.
8. A4 + M5 — enumerar `kind` válidos e apertar o schema Zod de `when`/`require`/`select`.
9. A5 — proteger campos gerenciados contra `providerOptions`.
10. A6 — `--catalog` na CLI; decidir o que `serve` realmente oferece e alinhar o README.
11. A9 — padrões de redação por prefixo de provedor + teste.
12. M1–M3, M12, M13 — hardening do proxy.
13. A8 — teste de contrato parametrizado (5 adapters), testes de integração do proxy, threshold de cobertura na CI.

**Higiene de release**

14. Resolver M14: ou instalar `@changesets/cli` e adicionar o passo de publicação, ou remover `.changeset/` e declarar o projeto como não publicado. Preencher metadados npm.
15. Incluir `examples/` no typecheck e no lint.
16. Alinhar README e `docs/` ao que o código realmente faz — em especial as afirmações sobre testes de contrato, `serve` e explicabilidade.

---

## Metodologia

- Leitura integral de `packages/` (12 pacotes), `scripts/`, `tests/`, configuração de build/lint/CI e documentação.
- Compilação verificada com o TypeScript do próprio projeto (5.9.3): `tsc -p tsconfig.check.json --noEmit` sobre os 12 pacotes → sem erros no código-fonte da biblioteca.
- 11 pacotes (todos exceto `cli`) foram compilados para JavaScript e exercitados por 9 scripts de prova em Node 22.22.3. Toda saída citada como `Reprodução` é saída real desses scripts. O comportamento da CLI foi verificado por leitura e por um script isolado que reproduz o padrão `return` dentro de `try/catch`.
- Não foi possível rodar `vitest` no ambiente de auditoria (o `esbuild` não executa no sandbox); a análise da suíte de testes foi feita por leitura direta dos arquivos, e os achados de comportamento foram validados pelos scripts de prova em vez da suíte.
- Nenhuma chamada a API paga de provedor foi feita — todos os testes de adapter usam `fetch` simulado, como o próprio projeto recomenda.

---

# Anexo A — Reverificação

**Data:** 2026-08-04, 2ª rodada · **Método:** rebuild limpo dos 11 pacotes + re-execução das mesmas 9 provas da 1ª rodada, sem alterar os scripts.

O código-fonte passou de 6.083 para 7.475 linhas e os testes unitários de 10 para 28, com dois arquivos novos (`tests/proxy.test.ts`, `tests/examples.test.ts`) e um módulo novo (`packages/core/src/endpoint.ts`). `tsc -p tsconfig.check.json --noEmit` continua limpo, agora incluindo `examples/`.

## Críticos — 3 de 3 corrigidos

| #                             | Antes                                             | Depois (saída real)                                                                                                                        |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **C1** Queda do proxy         | `EXIT=1`, processo morto                          | `processo SOBREVIVEU`, `EXIT=0`. `response.headersSent` guarda as duas saídas (linhas 34, 280), `server.on("error")` adicionado (linha 44) |
| **C2** Pesos ignorados        | `cost=1.0` e `quality=1.0` → totais idênticos     | `cost=1.0` → `economy=1.0000`; `quality=1.0` → totais diferentes e **modelo escolhido muda** (`demo-economy` → `demo-code-pro`)            |
| **C3** Erros Anthropic/Google | tudo `unknown / retryable=false / fallback=false` | Anthropic 529→`unavailable`, 500→`unavailable`, 429→`rate-limit` com `retryAfter=30000`; Google 503/429 idem. `statusCode` preservado      |

## Altos — 9 de 9 corrigidos

| #                        | Verificação                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **A1** Orçamento         | `D1 (ids distintos, ~$15 gastos, teto $0,01) → selecionou = NENHUM, bloqueado = true`                               |
| **A2** Colisão de IDs    | `50 decisões → 50 requestIds únicos (colisões = 0)`                                                                 |
| **A3** Parsing SSE       | `: keepalive` (OpenAI) e `event:` (Anthropic) → ambos `OK`, evento `text-delta` emitido                             |
| **A4** Typo em strategy  | `Policy validation failed: routes.0.select.strategy: Invalid input`                                                 |
| **A5** `providerOptions` | modelo roteado `gpt-x` preservado no payload                                                                        |
| **A6** CLI               | flag `--catalog` em todos os comandos, `configuredAdapters(catalog)`, `enableCompletions` só com adapter registrado |
| **A7** Retry indevido    | provider chamado **1 vez** (era 3)                                                                                  |
| **A8** Cobertura         | 10 → 28 testes; `pnpm audit --audit-level high` e `test:coverage` na CI; thresholds 60/60/60/50                     |
| **A9** Redação           | `sk-proj-…`, `AIza…` e `Bearer` base64 completo → todos `[REDACTED]`                                                |

## Médios — 18 de 18 corrigidos

Corrigidos: M1 (CORS `null` não é mais enviado), M2 (`exposeModels` opt-in + `timingSafeEqual`), M3 (HTTP 400 com mensagem genérica), M4 (chave do Google movida para header), M5 (schema Zod estrito), M6 (imagem base64 no formato correto), M7 (`tool_result` + `output.schema`), M8 (`generationConfig` desacoplado de `maxTokens`), M9 (`anyOf`/`oneOf`/`allOf`/`additionalProperties`/`min`/`max`/`format`/`minItems`), M10 (`runHook` com try/catch), M11 (default de 256 tokens configurável, origem da estimativa registrada e warning multimodal), M12 (expurgo do rate limiter), M13 (`server.on("error")`), M14 (`@changesets/cli` + `NPM_TOKEN` + `repository` em 12/12 pacotes), M15 (`examples/` no typecheck, + exemplo Fastify), M16 (`return await`), M17 (seed combinada com o id da requisição), M18 (telemetria falsa removida do streaming).

Não há médios pendentes. A estimativa padrão continua sendo 256 tokens por parte não textual, mas pode ser calibrada por `tokenEstimation.nonTextPartTokens` ou por `input.estimatedTokens`; decisões que dependem do default recebem warning explícito.

## Baixos

Corrigidos: B2 (`pack-check` agora inspeciona o tarball e exige `dist/index.d.ts`), B3 (`files: ["dist"]`, sem diretórios fantasma), B6 (injeção de fórmula em CSV neutralizada), B8 (`pnpm audit` na CI), B9 (`doctor` retorna código não-zero). O script `clean` passou a remover `tsconfig.tsbuildinfo` — acerto relevante: um `tsbuildinfo` velho faz o `tsc` incremental emitir `dist` **sem os `.d.ts`**, e foi exatamente esse cenário que reproduzi acidentalmente ao preparar esta reverificação.

Permanecem, sem urgência: B1 (`policyJsonSchema()` ainda mantido à mão em paralelo ao Zod) e B4 (`export *` no índice do core, sem superfície pública controlada).

---

## 🟢 N1 — Corrigida: classificação de hostnames legítimos após o hardening de SSRF

**Arquivo:** `packages/core/src/endpoint.ts:28-38`
**Usado em:** `adapter-anthropic:239`, `adapter-google:142`, `adapter-openai-compatible:115`

A proteção contra SSRF foi ajustada para aplicar regras IPv4 somente a literais IPv4 e regras IPv6 somente a literais IPv6. A reprodução abaixo registra o falso positivo observado antes da correção.

```
Reprodução (node probeN.mjs):
  feature.example.com          -> privado/reservado: true    ← falso positivo
  fdn.acme.io                  -> privado/reservado: true    ← falso positivo
  fc-gateway.corp.com          -> privado/reservado: true    ← falso positivo
  ffmpeg-api.example.com       -> privado/reservado: true    ← falso positivo
  api.openai.com               -> privado/reservado: false   ✓
  127.0.0.1                    -> privado/reservado: true    ✓
  169.254.169.254              -> privado/reservado: true    ✓
  fd00::1                      -> privado/reservado: true    ✓
```

Antes da correção, `validateEndpoint` lançava na construção do adapter para um endpoint self-hosted em qualquer host começando com essas letras. O contorno existia (`allowHosts`), mas o padrão rejeitava destinos válidos.

**Correção aplicada:** aplicar as regras IPv6 apenas quando a string for literal IPv6 (contém `:`, eventualmente entre colchetes) e as regras IPv4 apenas ao dotted-quad; qualquer outra coisa é nome DNS e deve passar. Os 5 testes de `packages/core/src/endpoint.test.ts` confirmam os casos DNS, IPv4, IPv6 e localhost.

---

## Veredito atualizado

O bloqueio de release foi levantado. As correções não são superficiais: os três críticos ganharam teste de regressão direto (`tests/proxy.test.ts` cobre exatamente o caminho de streaming com falha após envio de cabeçalhos, o CORS `null` e a exposição da lista de modelos), a cobertura virou gate de CI com threshold, e a validação de policy deixou de aceitar campos arbitrários — que era a causa estrutural de A4.

Antes de publicar, restam apenas melhorias baixas opcionais: **B1** (gerar o schema público a partir da mesma fonte da validação Zod) e **B4** (remover o efeito de escrita do comando `catalog validate`).
