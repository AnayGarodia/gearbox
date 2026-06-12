export interface Money { cents: number }
export function fromDollars(d: number): Money {
  return { cents: d };
}
export function addMoney(a: Money, b: Money): Money {
  return { cents: a.cents + b.cents };
}
