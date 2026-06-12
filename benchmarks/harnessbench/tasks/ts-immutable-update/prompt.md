`updateUser` is supposed to return a new object with the given fields updated, leaving the original unchanged.
Currently it mutates the original `user` object in place and returns it.
Fix the function to return a fresh object every time.
File to edit: `src/state.ts`
