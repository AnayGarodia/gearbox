The `LRUCache` uses a plain object and a `Map` but eviction is broken: `set()` always evicts the first-inserted key instead of the least-recently-used one, and `get()` does not promote accessed entries to "most recently used".

Fix the cache so that:
1. `get(key)` marks the entry as most-recently-used.
2. `set(key, value)` when the cache is full evicts the least-recently-used entry (the one that was accessed or inserted longest ago).
3. `set(key, value)` for an existing key updates the value AND marks it most-recently-used.

The capacity is set in the constructor. Do not change the public interface.

File to edit: `src/lru.ts`
