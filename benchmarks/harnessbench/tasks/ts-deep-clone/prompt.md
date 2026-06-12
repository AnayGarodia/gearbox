The `deepClone` function has several bugs:

1. It crashes on `null` (treats it as an object and tries to iterate keys).
2. It does not clone `Date` objects — they share a reference.
3. It does not clone `Array` values inside objects — the nested arrays share references.
4. It does not handle circular references — it will infinite-loop or stack-overflow.

Fix all four bugs. The function signature must remain `deepClone<T>(value: T): T`.

File to edit: `src/clone.ts`
