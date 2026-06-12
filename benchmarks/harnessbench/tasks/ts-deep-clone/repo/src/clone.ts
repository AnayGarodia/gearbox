export function deepClone<T>(value: T): T {
  if (typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[key];
    result[key] = typeof v === "object" ? deepClone(v) : v;
  }
  return result as T;
}
