export type OrderStatus = "CONFIRMED" | "SHIPPED" | "CANCELLED";

export interface Product {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
}

export interface Order {
  id: string;
  customerEmail: string;
  status: OrderStatus;
  productId: string;
  quantity: number;
  totalCents: number;
  createdAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

export interface OrderConfirmation {
  type: "ORDER_CONFIRMATION";
  orderId: string;
  customerEmail: string;
}

export interface OrderCancellation {
  type: "ORDER_CANCELLATION";
  orderId: string;
  customerEmail: string;
  reason: string;
}

export class DomainError extends Error {
  constructor(message: string, readonly code: "INVALID" | "NOT_FOUND" | "INSUFFICIENT_STOCK" | "INVALID_STATUS") {
    super(message);
  }
}
