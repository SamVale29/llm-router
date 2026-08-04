import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import {
  createExampleRouter,
  toCompletionResponse,
  toRoutingRequest,
  toStreamChunk,
} from "../shared/router.js";

const app = Fastify({ logger: false });
const router = createExampleRouter();

app.post<{ Body: Record<string, unknown> }>("/v1/chat/completions", async (request, reply) => {
  const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
  reply.header("x-request-id", requestId);
  try {
    const routingRequest = toRoutingRequest(request.body, requestId);
    if (request.body.stream === true) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for await (const event of router.stream(routingRequest))
        reply.raw.write(`data: ${JSON.stringify(toStreamChunk(event))}\n\n`);
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    return reply.send(toCompletionResponse(await router.execute(routingRequest)));
  } catch {
    if (!reply.sent)
      return reply.code(500).send({ error: { code: "example-error", message: "Request failed." } });
    reply.raw.end();
  }
});

await app.listen({ host: "127.0.0.1", port: 3001 });
console.log("Fastify example listening at http://127.0.0.1:3001");
