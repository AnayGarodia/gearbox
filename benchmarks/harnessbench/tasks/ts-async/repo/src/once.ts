/** Per-key async memoization: concurrent same-key calls share one in-flight
 *  promise; successes cache; rejections must NOT poison the cache. */
export function memoAsync<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, T>();
  return async (key: string) => {
    if (cache.has(key)) return cache.get(key)!;
    const v = await fn(key);
    cache.set(key, v);
    return v;
  };
}
