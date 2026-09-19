import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { ShopService } from "../../application/shopService.js";
import type { Order, OrderCancellation, OrderConfirmation, Product } from "../../domain/models.js";
import type { NotificationPort, OrderPort, ProductPort, UnitOfWorkPort } from "../../ports/index.js";
import { createApp } from "./app.js";

class InMemoryStore implements UnitOfWorkPort {
  products = new Map<string, Product>([["product-a", { id: "product-a", sku: "SKU-A", name: "Product A", priceCents: 1200, stock: 10 }]]);
  orders = new Map<string, Order>();
  restoreCount = 0;
  productPort: ProductPort = {
    list: async () => [...this.products.values()],
    getById: async (id) => this.products.get(id) ?? null,
    decrementStock: async (id, quantity) => {
      const product = this.products.get(id);
      if (!product || product.stock < quantity) return false;
      product.stock -= quantity;
      return true;
    },
    restoreStock: async (id, quantity) => {
      const product = this.products.get(id);
      if (!product) return false;
      product.stock += quantity;
      this.restoreCount += 1;
      return true;
    }
  };
  orderPort: OrderPort = {
    getById: async (id) => this.orders.get(id) ?? null,
    create: async (order) => { this.orders.set(order.id, order); },
    markShipped: async (id) => {
      const order = this.orders.get(id);
      if (!order || order.status !== "CONFIRMED") return null;
      order.status = "SHIPPED";
      return order;
    },
    cancel: async (id, reason, cancelledAt) => {
      const order = this.orders.get(id);
      if (!order || order.status !== "CONFIRMED") return null;
      order.status = "CANCELLED";
      order.cancelledAt = cancelledAt;
      order.cancellationReason = reason;
      return order;
    }
  };
  execute<T>(work: (products: ProductPort, orders: OrderPort) => Promise<T>) { return work(this.productPort, this.orderPort); }
}

class InMemoryNotifications implements NotificationPort {
  confirmations: OrderConfirmation[] = [];
  cancellations: OrderCancellation[] = [];
  async sendConfirmation(message: OrderConfirmation) { this.confirmations.push(message); }
  async sendCancellation(message: OrderCancellation) { this.cancellations.push(message); }
}

const CANCELLED_AT = "2026-01-01T00:05:00.000Z";

function makeService() {
  const store = new InMemoryStore();
  const notifications = new InMemoryNotifications();
  let sequence = 0;
  const service = new ShopService(
    store.productPort,
    store.orderPort,
    store,
    notifications,
    { next: () => `order-${++sequence}` },
    { now: () => CANCELLED_AT }
  );
  return { store, notifications, service };
}

interface Harness {
  baseUrl: string;
  store: InMemoryStore;
  notifications: InMemoryNotifications;
  service: ShopService;
  orderId: string;
}

async function withServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const { store, notifications, service } = makeService();
  const order = await service.createOrder({ productId: "product-a", quantity: 3, customerEmail: "buyer@example.com" });
  const server = createApp(service).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, store, notifications, service, orderId: order.id });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function post(baseUrl: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function get(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("HTTP adapter cancellation route", () => {
  it("cancels a CONFIRMED order and returns the contract order shape", async () => {
    await withServer(async ({ baseUrl, store, notifications, orderId }) => {
      const cancelled = await post(baseUrl, `/orders/${orderId}/cancel`, { reason: "changed my mind" });

      assert.equal(cancelled.status, 200);
      assert.deepEqual(cancelled.body, {
        id: orderId,
        customerEmail: "buyer@example.com",
        status: "CANCELLED",
        productId: "product-a",
        quantity: 3,
        totalCents: 3600,
        createdAt: CANCELLED_AT,
        cancelledAt: CANCELLED_AT,
        cancellationReason: "changed my mind"
      });
      assert.equal(store.products.get("product-a")?.stock, 10);
      assert.equal(store.restoreCount, 1);
      assert.deepEqual(notifications.cancellations, [
        { type: "ORDER_CANCELLATION", orderId, customerEmail: "buyer@example.com", reason: "changed my mind" }
      ]);

      const fetched = await get(baseUrl, `/orders/${orderId}`);
      assert.equal(fetched.status, 200);
      assert.deepEqual(fetched.body, cancelled.body);
    });
  });

  it("rejects a missing, empty, whitespace-only, or oversized reason with 400 INVALID and no state change", async () => {
    await withServer(async ({ baseUrl, store, notifications, orderId }) => {
      const rejections = [
        await post(baseUrl, `/orders/${orderId}/cancel`),
        await post(baseUrl, `/orders/${orderId}/cancel`, {}),
        await post(baseUrl, `/orders/${orderId}/cancel`, { reason: "" }),
        await post(baseUrl, `/orders/${orderId}/cancel`, { reason: "   " }),
        await post(baseUrl, `/orders/${orderId}/cancel`, { reason: "r".repeat(201) })
      ];

      for (const rejection of rejections) {
        assert.equal(rejection.status, 400);
        assert.equal(rejection.body.code, "INVALID");
      }

      const order = await get(baseUrl, `/orders/${orderId}`);
      assert.equal(order.body.status, "CONFIRMED");
      assert.equal(order.body.cancelledAt, null);
      assert.equal(order.body.cancellationReason, null);
      assert.equal(store.products.get("product-a")?.stock, 7);
      assert.equal(store.restoreCount, 0);
      assert.equal(notifications.cancellations.length, 0);
    });
  });

  it("accepts a reason of exactly 200 characters", async () => {
    await withServer(async ({ baseUrl, orderId }) => {
      const reason = "r".repeat(200);
      const cancelled = await post(baseUrl, `/orders/${orderId}/cancel`, { reason });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, "CANCELLED");
      assert.equal(cancelled.body.cancellationReason, reason);
    });
  });

  it("rejects a SHIPPED order with 409 INVALID_STATUS and no state change", async () => {
    await withServer(async ({ baseUrl, store, notifications, orderId }) => {
      const shipped = await post(baseUrl, `/admin/orders/${orderId}/ship`);
      assert.equal(shipped.status, 200);
      assert.equal(shipped.body.status, "SHIPPED");

      const rejected = await post(baseUrl, `/orders/${orderId}/cancel`, { reason: "changed my mind" });
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.code, "INVALID_STATUS");
      assert.equal(store.products.get("product-a")?.stock, 7);
      assert.equal(store.restoreCount, 0);
      assert.equal(notifications.cancellations.length, 0);
    });
  });

  it("returns 404 NOT_FOUND for an unknown order id", async () => {
    await withServer(async ({ baseUrl, store, notifications }) => {
      const rejected = await post(baseUrl, "/orders/does-not-exist/cancel", { reason: "changed my mind" });
      assert.equal(rejected.status, 404);
      assert.equal(rejected.body.code, "NOT_FOUND");
      assert.equal(store.restoreCount, 0);
      assert.equal(notifications.cancellations.length, 0);
    });
  });

  it("returns 200 with the original details when the cancellation is repeated", async () => {
    await withServer(async ({ baseUrl, store, notifications, orderId }) => {
      const first = await post(baseUrl, `/orders/${orderId}/cancel`, { reason: "changed my mind" });
      const second = await post(baseUrl, `/orders/${orderId}/cancel`, { reason: "changed my mind again" });

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(second.body, first.body);
      assert.equal(store.restoreCount, 1);
      assert.equal(notifications.cancellations.length, 1);
    });
  });

  it("preserves the existing product, order creation, order lookup, and shipping behavior", async () => {
    await withServer(async ({ baseUrl, store }) => {
      const health = await get(baseUrl, "/health");
      assert.equal(health.status, 200);
      assert.deepEqual(health.body, { ok: true });

      const products = await get(baseUrl, "/products");
      assert.equal(products.status, 200);
      assert.deepEqual((products.body as unknown as Array<Record<string, unknown>>)[0]?.id, "product-a");

      const created = await post(baseUrl, "/orders", { productId: "product-a", quantity: 2, customerEmail: "second@example.com" });
      assert.equal(created.status, 201);
      assert.equal(created.body.status, "CONFIRMED");
      assert.equal(created.body.cancelledAt, null);
      assert.equal(created.body.cancellationReason, null);
      assert.equal(store.products.get("product-a")?.stock, 5);

      const orderId = created.body.id as string;
      const fetched = await get(baseUrl, `/orders/${orderId}`);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.status, "CONFIRMED");

      const shipped = await post(baseUrl, `/admin/orders/${orderId}/ship`);
      assert.equal(shipped.status, 200);
      assert.equal(shipped.body.status, "SHIPPED");

      const reshipped = await post(baseUrl, `/admin/orders/${orderId}/ship`);
      assert.equal(reshipped.status, 409);
      assert.equal(reshipped.body.code, "INVALID_STATUS");

      const invalid = await post(baseUrl, "/orders", { productId: "product-a", quantity: 0, customerEmail: "second@example.com" });
      assert.equal(invalid.status, 400);

      const missing = await get(baseUrl, "/orders/unknown");
      assert.equal(missing.status, 404);
    });
  });
});
