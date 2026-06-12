The `getDisplayName` function crashes when passed a null or undefined user. Fix it so that:
- A null/undefined user returns an empty string `""`
- A user with both first and last name returns `"First Last"`
- A user with only a first name returns just the first name
- A user with only a last name returns just the last name

File to edit: `src/user.ts`
