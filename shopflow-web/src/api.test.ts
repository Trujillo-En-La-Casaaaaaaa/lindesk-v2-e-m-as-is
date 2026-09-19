import assert from "node:assert/strict";
import { afterEach, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("creates orders through the API HTTP boundary", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "order-1", status: "CONFIRMED" }), {
    status: 201,
    headers: { "content-type": "application/json" }
  }));
  vi.stubGlobal("fetch", fetchMock);
  await api.createOrder({ productId: "product-a", quantity: 2, customerEmail: "buyer@example.com" });
  assert.equal(fetchMock.mock.calls[0][0], "/api/orders");
  assert.equal(fetchMock.mock.calls[0][1].method, "POST");
});

it("cancels orders through the API HTTP boundary", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "order-1", status: "CANCELLED" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  vi.stubGlobal("fetch", fetchMock);
  await api.cancelOrder("order-1", "changed my mind");
  assert.equal(fetchMock.mock.calls[0][0], "/api/orders/order-1/cancel");
  assert.equal(fetchMock.mock.calls[0][1].method, "POST");
  assert.equal(fetchMock.mock.calls[0][1].body, JSON.stringify({ reason: "changed my mind" }));
  assert.equal(fetchMock.mock.calls[0][1].headers["content-type"], "application/json");
});

it("surfaces cancellation API errors unchanged", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Shipped orders cannot be cancelled" }), {
    status: 409,
    headers: { "content-type": "application/json" }
  })));
  await assert.rejects(() => api.cancelOrder("order-1", "changed my mind"), /Shipped orders cannot be cancelled/);
});
