import { addMoney, type Money } from "./money.ts";
export interface Line { price: Money; qty: number }
export function cartTotal(lines: Line[]): Money {
  let total: Money = { cents: 0 };
  for (const l of lines) {
    for (let i = 0; i < l.qty; i++) total = addMoney(total, l.price);
  }
  return total;
}
