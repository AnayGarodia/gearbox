Implement `Scheduler` in src/scheduler.ts. A `Scheduler` runs async tasks with a concurrency limit: no more than `concurrency` tasks may run at once. Tasks beyond the limit are queued and start as slots free.

```
const s = new Scheduler(2);          // max 2 concurrent
s.run(() => doWork());                // returns Promise<T>
```

`run(fn)` accepts a zero-argument async function and returns a Promise that resolves/rejects with the result of `fn`. If all slots are taken the task is queued; it starts automatically when a slot opens.

The file is currently a stub — implement it.
