import express from "express";
import { randomUUID } from "node:crypto";
import {
  createExampleRouter,
  toCompletionResponse,
  toRoutingRequest,
  toStreamChunk,
} from "../shared/router.js";

const app = express();
const router = createExampleRouter();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.post("/v1/chat/completions", async (request, response) => {
  const requestId = request.header("x-request-id") ?? randomUUID();
  response.setHeader("x-request-id", requestId);
  try {
    const routingRequest = toRoutingRequest(request.body, requestId);
    if (request.body.stream === true) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for await (const event of router.stream(routingRequest))
        response.write(`data: ${JSON.stringify(toStreamChunk(event))}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.status(200).json(toCompletionResponse(await router.execute(routingRequest)));
  } catch {
    if (!response.headersSent)
      response.status(500).json({ error: { code: "example-error", message: "Request failed." } });
    else response.end();
  }
});

app.listen(3000, "127.0.0.1", () => {
  console.log("Express example listening at http://127.0.0.1:3000");
});
