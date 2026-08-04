import { randomUUID } from "node:crypto";
import {
  createExampleRouter,
  toCompletionResponse,
  toRoutingRequest,
  toStreamChunk,
} from "../../../../shared/router.js";

export const runtime = "nodejs";

const router = createExampleRouter();

export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const routingRequest = toRoutingRequest(body, requestId);
    if (body.stream === true) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const event of router.stream(routingRequest))
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(toStreamChunk(event))}\n\n`),
              );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: { code: "example-error", message: "Request failed." } })}\n\n`,
              ),
            );
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-request-id": requestId,
        },
      });
    }
    return Response.json(toCompletionResponse(await router.execute(routingRequest)), {
      headers: { "x-request-id": requestId },
    });
  } catch {
    return Response.json(
      { error: { code: "example-error", message: "Request failed." } },
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
}
