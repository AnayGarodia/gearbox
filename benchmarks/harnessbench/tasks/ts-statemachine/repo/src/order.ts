export type OrderState = "pending" | "paid" | "shipped" | "delivered" | "cancelled" | "refunded";

const NEXT: Record<OrderState, OrderState[]> = {
  pending: ["paid", "cancelled"],
  paid: ["shipped", "refunded"],
  shipped: ["delivered", "paid"],
  delivered: [],
  cancelled: ["pending", "paid"],
  refunded: [],
};

export function transition(from: OrderState, to: OrderState): OrderState {
  if (!NEXT[from]) throw new Error(`unknown state ${from}`);
  return to;
}
