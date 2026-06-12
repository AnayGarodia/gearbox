The `Observable` class has `subscribe` but is missing correct teardown: when `subscription.unsubscribe()` is called, the producer teardown function is never invoked and values can still arrive after unsubscription.

Fix the implementation so that:
1. The teardown function returned by the producer is called when `unsubscribe()` is called.
2. After `unsubscribe()`, the observer's `next`, `error`, and `complete` callbacks are never called.
3. If the producer calls `complete()` or `error()`, teardown is also called automatically.

File to edit: `src/observable.ts`
