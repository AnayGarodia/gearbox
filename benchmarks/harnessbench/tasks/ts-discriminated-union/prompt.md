`area()` handles `"rect"` and `"triangle"` but silently returns `0` for `"circle"` because the case is missing.
Add the `"circle"` case. Area of a circle = π × r².
File to edit: `src/shape.ts`
