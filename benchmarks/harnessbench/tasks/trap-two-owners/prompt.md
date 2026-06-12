Modify `Cache` in src/cache.ts so that:

1. `set(key, value)` stores a value AND immediately evicts it if the cache already contains that key (so `get` after a re-`set` always returns `undefined`).
2. `set(key, value)` stores a value AND the value is accessible via `get(key)` immediately after.

Both requirements must hold simultaneously.
