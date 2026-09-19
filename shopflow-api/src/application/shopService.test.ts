import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShopService } from "./shopService.js";
import { DomainError, type Order, type OrderCancellation, type OrderConfirmation, type Product } from "../domain/models.js";
import type { NotificationPort, OrderPort, ProductPort, UnitOfWorkPort } from "../ports/index.js";

class MemoryStore implements UnitOfWorkPort {
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

class Notifications implements NotificationPort {
  sent: OrderConfirmation[] = [];
  cancellations: OrderCancellation[] = [];
  async sendConfirmation(message: OrderConfirmation) { this.sent.push(message); }
  async sendCancellation(message: OrderCancellation) { this.cancellations.push(message); }
}

function fixture() {
  const store = new MemoryStore();
  const notifications = new Notifications();
  const service = new ShopService(store.productPort, store.orderPort, store, notifications, { next: () => "order-1" }, { now: () => "2026-01-01T00:00:00.000Z" });
  return { service, store, notifications };
}

async function fixtureWithOrder(quantity = 3) {
  const context = fixture();
  const order = await context.service.createOrder({ productId: "product-a", quantity, customerEmail: "buyer@example.com" });
  return { ...context, order };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, received ${String(error)}`);
    return error.code;
  }
  throw new Error("expected the promise to reject");
}

describe("ShopService", () => {
  it("creates a CONFIRMED order, decrements stock, and sends confirmation", async () => {
    const { service, store, notifications } = fixture();
    const order = await service.createOrder({ productId: "product-a", quantity: 3, customerEmail: "buyer@example.com" });
    assert.equal(order.status, "CONFIRMED");
    assert.equal(order.totalCents, 3600);
    assert.equal(store.products.get("product-a")?.stock, 7);
    assert.deepEqual(notifications.sent, [{ type: "ORDER_CONFIRMATION", orderId: "order-1", customerEmail: "buyer@example.com" }]);
  });

  it("rejects insufficient stock without creating an order or notification", async () => {
    const { service, store, notifications } = fixture();
    await assert.rejects(service.createOrder({ productId: "product-a", quantity: 11, customerEmail: "buyer@example.com" }), /Insufficient stock/);
    assert.equal(store.orders.size, 0);
    assert.equal(notifications.sent.length, 0);
  });

  it("marks a CONFIRMED order SHIPPED and cannot ship it twice", async () => {
    const { service } = fixture();
    await service.createOrder({ productId: "product-a", quantity: 1, customerEmail: "buyer@example.com" });
    assert.equal((await service.shipOrder("order-1")).status, "SHIPPED");
    await assert.rejects(service.shipOrder("order-1"), /Only CONFIRMED/);
  });

  it("creates orders with null cancellation fields so the response matches the contract", async () => {
    const { service } = fixture();
    const order = await service.createOrder({ productId: "product-a", quantity: 2, customerEmail: "buyer@example.com" });
    assert.equal(order.cancelledAt, null);
    assert.equal(order.cancellationReason, null);
    assert.deepEqual(Object.keys(order).sort(), [
      "cancellationReason",
      "cancelledAt",
      "createdAt",
      "customerEmail",
      "id",
      "productId",
      "quantity",
      "status",
      "totalCents"
    ]);
  });

  describe("cancelOrder", () => {
    it("cancels a CONFIRMED order, restores stock once, and sends one cancellation", async () => {
      const { service, store, notifications, order } = await fixtureWithOrder(3);
      assert.equal(store.products.get("product-a")?.stock, 7);

      const cancelled = await service.cancelOrder(order.id, "changed my mind");

      assert.equal(cancelled.status, "CANCELLED");
      assert.equal(cancelled.cancelledAt, "2026-01-01T00:00:00.000Z");
      assert.equal(cancelled.cancellationReason, "changed my mind");
      assert.equal(store.products.get("product-a")?.stock, 10);
      assert.equal(store.restoreCount, 1);
      assert.equal(store.orders.get(order.id)?.status, "CANCELLED");
      assert.equal(store.orders.get(order.id)?.cancellationReason, "changed my mind");
      assert.equal(notifications.cancellations.length, 1);
      assert.deepEqual(notifications.cancellations, [
        { type: "ORDER_CANCELLATION", orderId: "order-1", customerEmail: "buyer@example.com", reason: "changed my mind" }
      ]);
      assert.equal(notifications.sent.length, 1);
    });

    it("trims the stored reason and the notification reason", async () => {
      const { service, store, notifications, order } = await fixtureWithOrder(1);
      const cancelled = await service.cancelOrder(order.id, "  changed my mind  ");
      assert.equal(cancelled.cancellationReason, "changed my mind");
      assert.equal(notifications.cancellations[0]?.reason, "changed my mind");
      assert.equal(store.restoreCount, 1);
    });

    it("rejects an empty or whitespace-only reason without any state change", async () => {
      for (const reason of ["", "   ", "\t\n"]) {
        const { service, store, notifications, order } = await fixtureWithOrder(3);
        assert.equal(await codeOf(service.cancelOrder(order.id, reason)), "INVALID");
        assert.equal(store.orders.get(order.id)?.status, "CONFIRMED");
        assert.equal(store.orders.get(order.id)?.cancelledAt, null);
        assert.equal(store.products.get("product-a")?.stock, 7);
        assert.equal(store.restoreCount, 0);
        assert.equal(notifications.cancellations.length, 0);
      }
    });

    it("accepts a 200 character reason and rejects 201 characters", async () => {
      const { service, store, notifications, order } = await fixtureWithOrder(2);
      const exactly200 = "r".repeat(200);
      const tooLong = "r".repeat(201);

      assert.equal(await codeOf(service.cancelOrder(order.id, tooLong)), "INVALID");
      assert.equal(store.orders.get(order.id)?.status, "CONFIRMED");
      assert.equal(store.restoreCount, 0);
      assert.equal(notifications.cancellations.length, 0);

      const cancelled = await service.cancelOrder(order.id, exactly200);
      assert.equal(cancelled.status, "CANCELLED");
      assert.equal(cancelled.cancellationReason, exactly200);
      assert.equal(store.restoreCount, 1);
      assert.equal(notifications.cancellations.length, 1);
    });

    it("rejects cancelling a SHIPPED order without restoring stock or notifying", async () => {
      const { service, store, notifications, order } = await fixtureWithOrder(3);
      await service.shipOrder(order.id);
      assert.equal(store.products.get("product-a")?.stock, 7);

      assert.equal(await codeOf(service.cancelOrder(order.id, "changed my mind")), "INVALID_STATUS");

      assert.equal(store.orders.get(order.id)?.status, "SHIPPED");
      assert.equal(store.orders.get(order.id)?.cancelledAt, null);
      assert.equal(store.products.get("product-a")?.stock, 7);
      assert.equal(store.restoreCount, 0);
      assert.equal(notifications.cancellations.length, 0);
    });

    it("rejects an unknown order id with NOT_FOUND", async () => {
      const { service, store, notifications } = fixture();
      assert.equal(await codeOf(service.cancelOrder("missing-order", "changed my mind")), "NOT_FOUND");
      assert.equal(store.restoreCount, 0);
      assert.equal(notifications.cancellations.length, 0);
    });

    it("treats a repeated cancellation as an idempotent no-op", async () => {
      const { service, store, notifications, order } = await fixtureWithOrder(3);

      const first = await service.cancelOrder(order.id, "changed my mind");
      const second = await service.cancelOrder(order.id, "a different reason");

      assert.equal(second.status, "CANCELLED");
      assert.equal(second.cancelledAt, first.cancelledAt);
      assert.notEqual(second.cancelledAt, null);
      assert.equal(second.cancellationReason, "changed my mind");
      assert.equal(store.products.get("product-a")?.stock, 10);
      assert.equal(store.restoreCount, 1);
      assert.equal(notifications.cancellations.length, 1);
      assert.equal(store.orders.get(order.id)?.cancellationReason, "changed my mind");
    });

    it("resolves concurrent cancellations of the same order with a single restore and notification", async () => {
      const { service, store, notifications, order } = await fixtureWithOrder(4);

      const [first, second] = await Promise.all([
        service.cancelOrder(order.id, "changed my mind"),
        service.cancelOrder(order.id, "changed my mind")
      ]);

      assert.equal(first.status, "CANCELLED");
      assert.equal(second.status, "CANCELLED");
      assert.equal(first.cancelledAt, second.cancelledAt);
      assert.equal(store.products.get("product-a")?.stock, 10);
      assert.equal(store.restoreCount, 1);
      assert.equal(notifications.cancellations.length, 1);
    });
  });
});
