# LLM Router

## Roteie cada requisição de IA para o modelo certo — com transparência.

LLM Router é uma biblioteca TypeScript de roteamento orientada por políticas para escolher modelos por tarefa, capacidades, custo, latência, privacidade e confiabilidade.

[Abra o playground decision-only](https://samvale29.github.io/llm-router/) · [Leia a arquitetura](docs/architecture.md) · [Leia o checklist operacional](docs/operations.md) · [Veja a release v0.1.0](https://github.com/SamVale29/llm-router/releases/tag/v0.1.0)

O playground não chama providers e não pede API key. Os preços e scores do catálogo de demonstração são explicitamente ilustrativos. Substitua-os por observações do seu workload antes de produção.

## Executar localmente

```bash
pnpm install
pnpm dev
```

Abra http://127.0.0.1:5173/ para acessar o playground interativo. O demo é decision-only: não precisa de API key e não chama providers.

## Exemplo rápido

```ts
import { createRouter } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const router = createRouter({
  catalog: demoCatalog,
  policy: {
    version: "1.0.0",
    defaults: { strategy: { kind: "weighted-score" }, fallbackAllowed: true },
    routes: [
      {
        id: "code",
        when: { task: "code-review" },
        require: { capabilities: ["structured-outputs"] },
        prefer: { tags: ["code"] },
        select: { strategy: { kind: "weighted-score" } },
      },
    ],
  },
});

const decision = await router.decide({
  messages: [{ role: "user", content: "Revise esta função TypeScript." }],
  hints: { task: "code-review" },
});
```

O core não lê variáveis de ambiente e não faz chamadas de rede em decision-only.

## Princípios

- restrições duras antes do score;
- capacidades desconhecidas não viram suporte;
- preço desconhecido não vira custo zero;
- cada decisão explica seleção, eliminações, sinais, estimativas e fallbacks;
- replay, shadow e avaliação funcionam sem APIs pagas;
- nenhum modelo é declarado universalmente melhor.

## Comandos

```bash
pnpm install
pnpm build
pnpm cli init
pnpm cli decide request.json --policy policy.yaml --catalog catalog.json
pnpm cli explain request.json --policy policy.yaml --catalog catalog.json
pnpm cli eval run --dataset fixtures/evals/tasks.jsonl --policy fixtures/policies/default.yaml --catalog fixtures/catalogs/default.json
pnpm test:coverage
```

O CLI local é executado com `pnpm cli` depois do build.

Leia a documentação em [docs/](docs/architecture.md), [SECURITY.md](SECURITY.md) e [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

Apache License 2.0.

IntegraÃ§Ãµes de Express, Next.js e Fastify estÃ£o em [examples/README.md](examples/README.md). A validaÃ§Ã£o de catÃ¡logo Ã© somente leitura; use `pnpm cli catalog build --output schemas` para gerar schemas.
