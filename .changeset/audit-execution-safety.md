---
"@llm-router/core": patch
"@llm-router/proxy": patch
"@llm-router/evals": patch
"@llm-router/cli": patch
"@llm-router/adapter-openai-compatible": patch
"@llm-router/adapter-anthropic": patch
"@llm-router/adapter-google": patch
---

Enforce execution budgets, deadlines, fallback permissions, cascade acceptance and structured output consistently across normal and streaming calls. Preserve provider tool calls and proxy protocol fields, reject unsupported paid shadow execution, and make evaluation gates fail closed when evidence is missing. See docs/audit-remediation.md for custom BudgetStore and runtime migration requirements.
