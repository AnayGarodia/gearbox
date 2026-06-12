`fetchWithFallback` is supposed to try a primary URL, and if that fails try a fallback URL. If both fail it should reject with the fallback error.
Currently it swallows all errors and always resolves with `null`.
Fix the logic so errors propagate correctly.

File to edit: `src/fetch.ts`
