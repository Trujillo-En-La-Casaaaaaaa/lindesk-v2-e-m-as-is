import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { ShopService } from "../../application/shopService.js";
import { DomainError, type OrderCancellation, type OrderConfirmation } from "../../domain/models.js";
import type { NotificationPort, UnitOfWorkPort } from "../../ports/index.js";
import { PostgresStore } from "./postgresStore.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * The persistence contract of the frozen cancellation contract. `IF NOT EXISTS` keeps this
 * evidence test runnable against a fresh database; an existing (infra-owned) schema is used
 * as is, so any schema drift fails loudly instead of being papered over.
 */
const contractSchema = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'SHIPPED', 'CANCELLED')),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT
);
`;

class RecordingNotifications implements NotificationPort {
  confirmations: OrderConfirmation[] = [];
  cancellations: OrderCancellation[] = [];
  async sendConfirmation(message: OrderConfirmation) { this.confirmations.push(message); }
  async sendCancellation(message: OrderCancellation) { this.cancellations.push(message); }
}

describe("PostgresStore cancellation against a real PostgreSQL", {
  skip: databaseUrl ? false : "DATABASE_URL is not set: real-persistence cancellation and concurrency evidence skipped"
}, () => {
  let pool!: Pool;
  let store!: PostgresStore;
  const productId = `test-product-${randomUUID()}`;

  function serviceWith(notifications: RecordingNotifications, unitOfWork: UnitOfWorkPort = store): ShopService {
    return new ShopService(
      store.products,
      store.orders,
      unitOfWork,
      notifications,
      { next: randomUUID },
      { now: () => new Date().toISOString() }
    );
  }

  async function createOrder(quantity: number): Promise<string> {
    const order = await serviceWith(new RecordingNotifications()).createOrder({
      productId,
      quantity,
      customerEmail: "buyer@example.com"
    });
    return order.id;
  }

  async function stock(): Promise<number> {
    const result = await pool.query<{ stock: number }>("SELECT stock FROM products WHERE id = $1", [productId]);
    return result.rows[0]!.stock;
  }

  // `pg` materialises TIMESTAMPTZ as a Date, so timestamps are compared as ISO strings.
  function iso(value: string | Date | null): string {
    assert.ok(value, "expected a cancellation timestamp");
    return new Date(value).toISOString();
  }

  async function row(orderId: string) {
    const result = await pool.query<{ status: string; cancelled_at: Date | null; cancellation_reason: string | null }>(
      "SELECT status, cancelled_at, cancellation_reason FROM orders WHERE id = $1",
      [orderId]
    );
    assert.equal(result.rowCount, 1, `expected exactly one row for ${orderId}`);
    return result.rows[0]!;
  }

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    await pool.query(contractSchema);
    await pool.query("INSERT INTO products (id, sku, name, price_cents, stock) VALUES ($1, $2, $3, $4, $5)", [
      productId,
      productId,
      "Cancellation evidence product",
      1200,
      100
    ]);
    store = new PostgresStore(pool);
  });

  after(async () => {
    await pool.query("DELETE FROM orders WHERE product_id = $1", [productId]);
    await pool.query("DELETE FROM products WHERE id = $1", [productId]);
    await pool.end();
  });

  it("persists the transition, restores stock once, and sends one notification", async () => {
    const notifications = new RecordingNotifications();
    const service = serviceWith(notifications);
    const orderId = await createOrder(2);
    const afterOrder = await stock();

    const cancelled = await service.cancelOrder(orderId, "changed my mind");

    assert.equal(cancelled.status, "CANCELLED");
    assert.ok(cancelled.cancelledAt, "cancelledAt must be set");
    assert.equal(cancelled.cancellationReason, "changed my mind");
    const persisted = await row(orderId);
    assert.equal(persisted.status, "CANCELLED");
    assert.equal(iso(persisted.cancelled_at), iso(cancelled.cancelledAt));
    assert.equal(persisted.cancellation_reason, "changed my mind");
    assert.equal(await stock(), afterOrder + 2);
    assert.deepEqual(notifications.cancellations, [
      { type: "ORDER_CANCELLATION", orderId, customerEmail: "buyer@example.com", reason: "changed my mind" }
    ]);

    const repeated = await service.cancelOrder(orderId, "second attempt");

    assert.equal(repeated.status, "CANCELLED");
    assert.equal(iso(repeated.cancelledAt), iso(cancelled.cancelledAt));
    assert.equal(repeated.cancellationReason, "changed my mind");
    assert.equal(await stock(), afterOrder + 2);
    assert.equal(notifications.cancellations.length, 1);
  });

  it("does not transition a SHIPPED order and reports INVALID_STATUS", async () => {
    const notifications = new RecordingNotifications();
    const service = serviceWith(notifications);
    const orderId = await createOrder(2);
    const afterOrder = await stock();
    assert.equal((await store.orders.markShipped(orderId))?.status, "SHIPPED");

    await assert.rejects(
      service.cancelOrder(orderId, "changed my mind"),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_STATUS"
    );

    const persisted = await row(orderId);
    assert.equal(persisted.status, "SHIPPED");
    assert.equal(persisted.cancelled_at, null);
    assert.equal(persisted.cancellation_reason, null);
    assert.equal(await stock(), afterOrder);
    assert.equal(notifications.cancellations.length, 0);
  });

  it("reports NOT_FOUND for an unknown order id", async () => {
    const notifications = new RecordingNotifications();
    const service = serviceWith(notifications);
    const before = await stock();

    await assert.rejects(
      service.cancelOrder(randomUUID(), "changed my mind"),
      (error: unknown) => error instanceof DomainError && error.code === "NOT_FOUND"
    );

    assert.equal(await stock(), before);
    assert.equal(notifications.cancellations.length, 0);
  });

  it("keeps exactly one transition, one stock increment, and one notification when two cancellations race", async () => {
    const notifications = new RecordingNotifications();
    const service = serviceWith(notifications);
    const orderId = await createOrder(3);
    const afterOrder = await stock();

    const [first, second] = await Promise.all([
      service.cancelOrder(orderId, "first request"),
      service.cancelOrder(orderId, "second request")
    ]);

    assert.equal(first.status, "CANCELLED");
    assert.equal(second.status, "CANCELLED");
    assert.ok(first.cancelledAt, "cancelledAt must be set");
    assert.equal(iso(first.cancelledAt), iso(second.cancelledAt), "both requests must report the same cancellation timestamp");
    assert.equal(await stock(), afterOrder + 3, "stock must be restored exactly once");
    assert.equal(notifications.cancellations.length, 1, "exactly one ORDER_CANCELLATION must be sent");

    const persisted = await row(orderId);
    assert.equal(persisted.status, "CANCELLED");
    assert.equal(iso(persisted.cancelled_at), iso(first.cancelledAt));
    const timestamps = await pool.query<{ count: string }>(
      "SELECT count(DISTINCT cancelled_at)::text AS count FROM orders WHERE id = $1",
      [orderId]
    );
    assert.equal(timestamps.rows[0]!.count, "1", "exactly one cancelled_at value must exist");
    const notifiedReason = notifications.cancellations[0]!.reason;
    assert.ok(["first request", "second request"].includes(notifiedReason));
    assert.equal(persisted.cancellation_reason, notifiedReason, "the persisted cancellation is the one that was notified");
  });

  it("makes a competing transaction wait for the open cancellation before deciding it lost", async () => {
    const winnerNotifications = new RecordingNotifications();
    const loserNotifications = new RecordingNotifications();

    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>((resolve) => { releaseWinner = resolve; });
    let winnerHoldsLock!: () => void;
    const winnerHolds = new Promise<void>((resolve) => { winnerHoldsLock = resolve; });

    // Same adapters as production, but the winner's transaction is held open after it has
    // acquired the row lock, so the loser provably overlaps it instead of merely racing.
    const gatedUnitOfWork: UnitOfWorkPort = {
      execute: (work) => store.execute((products, orders) => work(products, {
        getById: (id) => orders.getById(id),
        create: (order) => orders.create(order),
        markShipped: (id) => orders.markShipped(id),
        cancel: async (id, reason, cancelledAt) => {
          const cancelled = await orders.cancel(id, reason, cancelledAt);
          if (cancelled) {
            winnerHoldsLock();
            await winnerGate;
          }
          return cancelled;
        }
      }))
    };

    const winner = serviceWith(winnerNotifications, gatedUnitOfWork);
    const loser = serviceWith(loserNotifications, store);

    const orderId = await createOrder(4);
    const afterOrder = await stock();

    const winnerPromise = winner.cancelOrder(orderId, "first request");
    await winnerHolds;

    let loserSettled = false;
    const loserPromise = loser.cancelOrder(orderId, "second request").then(
      (order) => { loserSettled = true; return order; },
      (error) => { loserSettled = true; throw error; }
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(loserSettled, false, "the competing cancellation must block on the uncommitted transition");

    releaseWinner();
    const [winnerOrder, loserOrder] = await Promise.all([winnerPromise, loserPromise]);

    assert.equal(winnerOrder.status, "CANCELLED");
    assert.equal(winnerOrder.cancellationReason, "first request");
    assert.equal(loserOrder.status, "CANCELLED");
    assert.equal(iso(loserOrder.cancelledAt), iso(winnerOrder.cancelledAt));
    assert.equal(loserOrder.cancellationReason, "first request");
    assert.ok(winnerOrder.cancelledAt, "cancelledAt must be set");
    assert.equal(await stock(), afterOrder + 4, "stock must be restored exactly once");
    assert.equal(winnerNotifications.cancellations.length, 1);
    assert.equal(loserNotifications.cancellations.length, 0, "the losing request must not notify");

    const persisted = await row(orderId);
    assert.equal(persisted.status, "CANCELLED");
    assert.equal(iso(persisted.cancelled_at), iso(winnerOrder.cancelledAt));
    assert.equal(persisted.cancellation_reason, "first request");
  });
});
