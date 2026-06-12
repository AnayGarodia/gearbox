`getCity` crashes with a TypeError when `user`, `user.address`, or `user.address.city` is absent.
Fix the function so it returns `null` (not `undefined`, not a crash) whenever any part of the chain is absent.
File to edit: `src/profile.ts`
