The `EventEmitter` class has `on` and `emit` but is missing two methods:

1. `off(event, listener)` — removes a previously registered listener. If the listener was not registered, does nothing.
2. `once(event, listener)` — registers a listener that fires only on the first emit for that event and then automatically removes itself.

Add these two methods to `src/emitter.ts`. Do not change the existing `on` / `emit` behaviour.
