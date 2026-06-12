export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delay: number,
): ((...args: T) => void) & { cancel(): void } {
  // TODO: implement
  throw new Error("not implemented");
}
