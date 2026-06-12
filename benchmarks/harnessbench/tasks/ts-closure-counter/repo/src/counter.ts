let _count = 0;

export function makeCounter() {
  return {
    increment: () => { _count++; },
    decrement: () => { _count--; },
    value: () => _count,
  };
}
