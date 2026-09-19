import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { HttpNotificationAdapter } from "./httpNotification.js";

interface Recorded {
  method: string;
  url: string;
  contentType: string | undefined;
  body: unknown;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function withProvider(status: number, run: (baseUrl: string, recorded: Recorded[]) => Promise<void>): Promise<void> {
  const recorded: Recorded[] = [];
  const server: Server = createServer(async (request, response) => {
    const raw = await readBody(request);
    recorded.push({
      method: request.method ?? "",
      url: request.url ?? "",
      contentType: request.headers["content-type"],
      body: raw.length > 0 ? JSON.parse(raw) : undefined
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: status < 400 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, recorded);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("HttpNotificationAdapter", () => {
  it("posts ORDER_CANCELLATION to the existing /notifications endpoint", async () => {
    await withProvider(201, async (baseUrl, recorded) => {
      await new HttpNotificationAdapter(baseUrl).sendCancellation({
        type: "ORDER_CANCELLATION",
        orderId: "order-1",
        customerEmail: "buyer@example.com",
        reason: "changed my mind"
      });

      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]?.method, "POST");
      assert.equal(recorded[0]?.url, "/notifications");
      assert.equal(recorded[0]?.contentType, "application/json");
      assert.deepEqual(recorded[0]?.body, {
        type: "ORDER_CANCELLATION",
        orderId: "order-1",
        customerEmail: "buyer@example.com",
        reason: "changed my mind"
      });
    });
  });

  it("still posts ORDER_CONFIRMATION to the same endpoint", async () => {
    await withProvider(201, async (baseUrl, recorded) => {
      await new HttpNotificationAdapter(baseUrl).sendConfirmation({
        type: "ORDER_CONFIRMATION",
        orderId: "order-1",
        customerEmail: "buyer@example.com"
      });

      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]?.url, "/notifications");
      assert.deepEqual(recorded[0]?.body, {
        type: "ORDER_CONFIRMATION",
        orderId: "order-1",
        customerEmail: "buyer@example.com"
      });
    });
  });

  it("fails when the provider rejects the cancellation message", async () => {
    await withProvider(400, async (baseUrl, recorded) => {
      await assert.rejects(
        new HttpNotificationAdapter(baseUrl).sendCancellation({
          type: "ORDER_CANCELLATION",
          orderId: "order-1",
          customerEmail: "buyer@example.com",
          reason: "changed my mind"
        }),
        /Notification provider returned 400/
      );
      assert.equal(recorded.length, 1);
    });
  });
});
