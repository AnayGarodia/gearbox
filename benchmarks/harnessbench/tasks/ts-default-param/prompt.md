`getValue` uses `||` to apply defaults, which silently replaces falsy values like `0`, `false`, and `""` with the default even when those are valid inputs.
Switch to nullish coalescing (`??`) so that only `null` and `undefined` fall back to the default.
File to edit: `src/config.ts`
