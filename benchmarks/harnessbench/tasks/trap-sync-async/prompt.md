Add a cache layer to `fetchUser`: when the same `id` has been fetched before, return the cached result SYNCHRONOUSLY (no Promise, just the value directly). For uncached ids, call the existing async `loader` as normal.

Requirements:
- `fetchUser(id)` must return `User` (not `Promise<User>`) for cached ids.
- `fetchUser(id)` must return `Promise<User>` for uncached ids.
- The type signature must remain `fetchUser(id: string): User | Promise<User>`.

File to edit: `src/cache.ts`
