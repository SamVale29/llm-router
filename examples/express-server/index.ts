import { createProxyServer } from "@llm-router/proxy";
import { createRouter } from "@llm-router/core";
import { demoCatalog } from "@llm-router/catalog";

const router = createRouter({
  catalog: demoCatalog,
  policy: {
    version: "server",
    routes: [{ id: "all", when: {}, select: { strategy: { kind: "priority" } } }],
  },
});
const proxy = createProxyServer({
  router,
  catalog: demoCatalog,
  host: "127.0.0.1",
  port: 8787,
  authToken: "local-development-token",
});
console.log(proxy.url);
