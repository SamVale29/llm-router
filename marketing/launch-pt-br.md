# Post de lançamento — português

Aplicações usam modelos diferentes para código, tradução, OCR, contexto longo e uso de ferramentas. Com o tempo, o roteamento hardcoded vira uma sequência difícil de auditar.

O LLM Router transforma a escolha em uma política testável. Primeiro elimina candidatos incompatíveis; depois aplica score, custo, latência, confiabilidade e preferências. Cada decisão explica o escolhido, os descartados e os fallbacks.

O playground público funciona sem chave. Shadow mode compara políticas sem duplicar a chamada ao provider. Replay e avaliação ajudam a enxergar custo, latência, qualidade e regressões antes do rollout.

Demo: https://samvale29.github.io/llm-router/
Código: https://github.com/SamVale29/llm-router

Feedback técnico sobre DSL de políticas, proveniência do catálogo e contratos de adapters é muito bem-vindo.
