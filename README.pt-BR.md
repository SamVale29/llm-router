# LLM Router

## Roteie cada requisição de IA para o modelo certo — com transparência.

LLM Router é uma biblioteca TypeScript de roteamento orientada por políticas para escolher modelos por tarefa, capacidades, custo, latência, privacidade e confiabilidade.

[Abra o playground decision-only](https://samvale29.github.io/llm-router/) · [Leia a arquitetura](docs/architecture.md) · [Veja a release v0.1.0](https://github.com/SamVale29/llm-router/releases/tag/v0.1.0)

O playground não chama providers e não pede API key. Os preços e scores do catálogo de demonstração são explicitamente ilustrativos. Substitua-os por observações do seu workload antes de produção.

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
pnpm exec llm-router init
pnpm exec llm-router decide request.json --policy policy.yaml
pnpm exec llm-router explain request.json --policy policy.yaml
pnpm exec llm-router eval run --dataset fixtures/evals/tasks.jsonl --policy fixtures/policies/default.yaml
```

Leia a documentação em [docs/](docs/architecture.md), [SECURITY.md](SECURITY.md) e [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

Apache License 2.0.
