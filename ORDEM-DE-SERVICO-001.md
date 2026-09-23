# Ordem de serviço 001 — LLM Router

**Origem:** Anexo A de `AUDITORIA.md` (reverificação de 2026-08-04, 2ª rodada)
**Emitida por:** Auditor · **Executor:** Codex · **Dono do produto:** Sam
**Tipo de onda:** correção (não é onda de auditoria)
**Autorização de escrita no remoto:** ⬜ não concedida — ver bloco de fechamento

Esta ordem é adaptada do protocolo de auditoria do CAMPO. O LLM Router não tem registro de
achados, painel de convergência nem maquinaria de gate; os campos correspondentes foram
omitidos em vez de inventados. O que foi preservado: ordem executável só com defeito provado,
caminho autorizado declarado por critério, e teste vermelho entregue pelo auditor.

## Ambiente que produziu os números

Todas as saídas literais abaixo vieram do **sandbox Linux**, Node v22.22.3, com rebuild limpo
dos 11 pacotes via `tsc -p packages/<pkg>/tsconfig.json` e execução dos artefatos compilados
por scripts em `node`. `pnpm lint`, `pnpm test` e `pnpm build` **não rodam no sandbox** —
`node_modules` é win32 e o `esbuild` não executa. **O verde final é o do alvo Windows.**
Nenhum número desta ordem substitui `pnpm release:check` na máquina do dono do produto.

## Escopo

Dois itens. Um terceiro achado fica **fora da ordem**, aguardando decisão de produto.

| ID               | Título                                                   | Severidade | Disposição          |
| ---------------- | -------------------------------------------------------- | ---------- | ------------------- |
| AUD-ENDPOINT-001 | Nomes DNS classificados como host privado                | Alta       | Concluído           |
| AUD-ENDPOINT-002 | Redirect do endpoint declarado é seguido sem revalidação | Alta       | Concluído           |
| AUD-COST-001     | Parte não textual estimada em 256 tokens sem ressalva    | Média      | Concluído — Opção A |

**Estado da execução no alvo Windows:** os dois itens de endpoint foram implementados e
verificados; a Opção A de AUD-COST-001 foi autorizada posteriormente e também foi implementada.

---

## AUD-ENDPOINT-001 — nomes DNS classificados como host privado

### Prova do defeito

`packages/core/src/endpoint.ts:28-38` aplica as regras de prefixo IPv6 (`fc`, `fd`, `fe8`–`feb`,
`ff`) a qualquer string que não seja IPv4 pontuado, inclusive nomes DNS.

Comando: `node probeN.mjs` (sandbox, sobre `dist` recém-compilado). Saída literal:

```
feature.example.com                        -> privado/reservado: true
fdn.acme.io                                -> privado/reservado: true
fc-gateway.corp.com                        -> privado/reservado: true
ffmpeg-api.example.com                     -> privado/reservado: true
api.openai.com                             -> privado/reservado: false
127.0.0.1                                  -> privado/reservado: true
169.254.169.254                            -> privado/reservado: true
fd00::1                                    -> privado/reservado: true
```

Consumido em `adapter-anthropic:239`, `adapter-google:142` e `adapter-openai-compatible:115`,
onde `validateEndpoint` lança na construção do adapter. Impacto medido: endpoint self-hosted
em host começando por essas letras fica inutilizável sem `allowHosts`. Impacto sobre adoção é
**inferido, não medido**.

### Conserto

O discriminador é que todo literal IPv6 contém `:` e nenhum hostname DNS contém. Classifique
antes de aplicar regra.

```ts
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIpv4Literal(host)) return isReservedIpv4(host);
  if (host.includes(":")) return isReservedIpv6(host);
  return false;
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part));
}

function isReservedIpv6(host: string): boolean {
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    return isIpv4Literal(mapped) ? isReservedIpv4(mapped) : true;
  }
  if (host === "::" || host === "::1") return true;
  const group = host.split(":")[0] ?? "";
  return /^f[cd]/.test(group) || /^fe[89ab]/.test(group) || /^ff/.test(group);
}
```

`isReservedIpv4` é o corpo do bloco IPv4 atual, extraído sem alteração de comportamento —
**exceto uma correção declarada**, abaixo.

### Alteração de comportamento declarada, para ratificar antes

A regra atual `(first === 198 && second === 51)` bloqueia `198.51.0.0/16` inteiro; o bloco
reservado real é `198.51.100.0/24`. O diff acima acrescenta `&& third === 100`, o que **libera
198.51.0.0–198.51.99.255 e 198.51.101.0–198.51.255.255**, hoje bloqueados. É correção de
faixa, não melhoria oportunista, e está isolada nesta linha. Se o dono do produto preferir
manter o excesso de bloqueio por precaução, remova o `&& third === 100` — os testes desta
ordem passam nas duas versões.

### Caminho autorizado

| Critério                      | Arquivo que o Executor pode editar                                               |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Todos os critérios deste item | `packages/core/src/endpoint.ts`                                                  |
| —                             | **Proibido editar** `packages/core/src/endpoint.test.ts` (entregue pelo auditor) |

Nenhum outro arquivo é autorizado neste item. `packages/core/src/index.ts` já exporta
`./endpoint.js`; não precisa de mudança.

### Critérios de aceite

1. `packages/core/src/endpoint.test.ts` passa integralmente — 5 casos.
2. Os 4 casos hoje verdes continuam verdes (baseline antirregressão embutida no mesmo arquivo).
3. Nenhum diff fora de `packages/core/src/endpoint.ts`.

### Estado do teste contra o código atual

Executado no sandbox sobre `dist` compilado:

```
  VERMELHO nomes DNS não são privados -> falham: feature.example.com, fdn.acme.io,
           fc-gateway.corp.com, ffmpeg-api.example.com, fe80-cdn.example.com, ff.example.org
  verde    IPv4 privados bloqueados
  verde    IPv6 privados bloqueados
  verde    hosts públicos liberados
  verde    localhost reservado
```

O diff proposto foi executado contra os mesmos 5 grupos antes de entrar nesta ordem: **os 5
ficam verdes**. O conserto é fisicamente possível e não quebra a baseline.

---

## AUD-ENDPOINT-002 — redirect do endpoint declarado é seguido sem revalidação

### Prova do defeito

`validateEndpoint` inspeciona apenas a URL declarada. O `fetch` padrão segue 3xx, e o destino
nunca é revalidado: o corpo devolvido ao chamador vem de um host que não passou por validação
alguma.

Comando: `node probeRedir.mjs` — servidor em `127.0.0.1:8800` responde 302 para
`127.0.0.1:8801`; adapter configurado com o primeiro. Saída literal:

```
rota pedida ao endpoint declarado: /v1/chat/completions
conteúdo devolvido ao chamador     : CONTEUDO-DO-DESTINO-B
=> redirect seguido sem revalidação: true
```

Fato: o redirect é seguido e o destino não é revalidado. Que isso constitua um vetor de SSRF
utilizável contra `169.254.169.254` **é inferência, não medição** — o sandbox não permite
vincular endereço link-local. A inferência é forte porque a validação de host existe
justamente para impedir esse destino, e o redirect a contorna por completo.

### Conserto

Passar `redirect: "manual"` nas chamadas `fetch` dos adapters e tratar 3xx como erro
normalizado não repetível, nomeando redirect na mensagem. Alternativa aceitável: revalidar o
`Location` com `validateEndpoint`/`isPrivateOrReservedHost` e reemitir — mais trabalho, mesma
aceitação.

Viabilidade verificada antes de ordenar (`node probeManual.mjs`):

```
com redirect:'manual' -> status 302 | ok = false | location = http://127.0.0.1:8803/x
=> conserto é fisicamente possível: true
```

Com `redirect: "manual"` o `Response` chega com `ok === false`, então o caminho de erro já
existente é acionado. Sem essa opção, `response.ok` seria `true` e nada dispararia.

### Caminho autorizado

| Critério                                | Arquivos que o Executor pode editar                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Critérios 1–3 (`execute`)               | `packages/adapter-openai-compatible/src/index.ts`                                                          |
| Critério 4 (`stream` e demais adapters) | `packages/adapter-anthropic/src/index.ts`, `packages/adapter-google/src/index.ts`, e o mesmo arquivo acima |
| Se optar por helper compartilhado       | `packages/core/src/endpoint.ts` — e só ele, no core                                                        |
| —                                       | **Proibido editar** `tests/adapter-redirect.test.ts` (entregue pelo auditor)                               |

### Critérios de aceite

1. `tests/adapter-redirect.test.ts` passa integralmente — 3 casos.
2. `tests/adapters.test.ts` (7 casos) continua verde — baseline antirregressão.
3. O erro de redirect normaliza com `retryable === false`.
4. **Cobertura das demais chamadas:** toda invocação de `fetchImpl(` nos três adapters, em
   `execute` **e** em `stream`, passa `redirect: "manual"`. Meio autorizado de verificação:
   `grep -n "fetchImpl(" packages/adapter-*/src/index.ts` deve listar apenas chamadas cujo
   objeto de init contenha `redirect`. Declaro que este critério é verificado por inspeção, não
   por teste — os caminhos de `stream` não estão fixados por asserção nesta onda.

### Estado do teste contra o código atual

```
  VERMELHO rejeita com /redirect/i        -> resolveu sem erro: true
  VERMELHO não devolve corpo do destino   -> text = CONTEUDO-DO-DESTINO-NAO-VALIDADO
  VERMELHO erro não repetível             -> nenhum erro foi levantado
```

Os três vermelhos. Portas 8810/8811 são usadas pelo teste; se colidirem no alvo, o Executor
pode trocá-las — é a única edição autorizada no arquivo de teste, e deve ser relatada.

---

## AUD-COST-001 — Opção A executada

`packages/core/src/normalize.ts:51` mantém `nonTextParts * 256`. Prova (`node probeM11.mjs`),
requisição com uma imagem de 4000×3000:

```
tokens estimados: 261  (imagem 4000x3000 tratada como 256 tokens fixos)
custo estimado  : 0.0017448000000000001
warnings        : []
=> algum warning menciona imagem/modalidade/estimativa não calibrada? false
```

O ponto não é a imprecisão, é que o número é apresentado **sem ressalva**. O README afirma que
capacidade, preço e latência desconhecidos não são silenciosamente tratados como suporte, zero
ou rápido — e aqui uma imagem de qualquer tamanho vira exatamente 256 tokens, com confiança
total, alimentando `maxEstimatedRequestCost` e o teto de contexto.

Nenhuma constante única serve: OpenAI cobra ~85 base + ~170 por tile de 512px, Anthropic
aproxima (largura×altura)/750, Gemini usa 258 por tile. Isso é dado de catálogo por modelo.

A decisão de produto foi aplicar a Opção A:

- manter o default de 256 tokens por parte não textual;
- tornar o valor configurável por `tokenEstimation.nonTextPartTokens`;
- registrar a origem da estimativa e emitir warning quando o default for usado sem uma
  estimativa explícita ou calibrada.

Uma fórmula por provedor (Opção B) permanece como melhoria futura, quando houver dados observados
e catálogo suficiente para sustentá-la.

---

## O que o Executor não deve fazer nesta onda

- A restrição original de não tocar em `packages/core/src/normalize.ts` foi encerrada após a
  autorização explícita da Opção A.
- Os arquivos fornecidos pelo auditor não tiveram seu conteúdo de teste alterado; o formatter foi
  aplicado apenas para permitir que o gate de release avalie o workspace inteiro.
- Não "melhorar" a validação de endpoint além do diff especificado. A correção da faixa
  `198.51.100.0/24` é a única alteração de comportamento autorizada, e depende de ratificação.
- Não publicar. Publicação exige autorização de escrita no remoto, ainda não concedida.
- Não alterar limiar de cobertura, fixture ou asserção para obter verde.

## Prova de execução exigida na entrega

O Executor devolve, do **alvo Windows**:

- `pnpm typecheck` — saída e código de saída;
- `pnpm test` — contagem de testes por arquivo, incluindo os 8 novos casos;
- `pnpm test:coverage` — thresholds 60/60/60/50 mantidos;
- `git diff --stat` — para confirmar que nada saiu do escopo autorizado.

Recalcularei a aritmética a partir do dado bruto; contagem declarada não vale por si.

---

## Bloco de fechamento

| Campo                           | Conteúdo                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Podemos avançar?**            | **SIM, COM RESSALVA** — os dois itens têm defeito provado, teste vermelho e conserto verificado como possível; a ressalva é que nenhum número veio do alvo Windows. |
| **Decisão que preciso de você** | A faixa ampla `198.51.x.x` foi mantida por precaução; a Opção A de AUD-COST-001 foi escolhida. A autorização de escrita no remoto continua não concedida.           |
| **Próxima ação**                | Reexecutar o gate completo de release após a atualização documental e, se aprovado, preparar a revisão/commit local.                                                |
| **Bloqueado**                   | Nada. A ordem é executável mesmo antes das decisões 1 e 2 — a 1 tem default seguro (manter o bloqueio amplo) e a 2 está fora do escopo desta onda.                  |
| **Não fazer agora**             | B1 (schema público duplicado manualmente) e B4 (efeito de escrita em `catalog validate`) permanecem melhorias de baixa prioridade e não bloqueiam o release.        |
