`Pipeline` in src/pipeline.py chains transforms: each `step` is a callable that receives a value and returns a transformed value. `Pipeline.run(value)` applies all steps in order. `Pipeline.pipe(fn)` adds a step and returns `self` for chaining.

There are two bugs:

1. `run` applies steps in reverse order instead of forward order.
2. `pipe` does not return `self`, breaking method chaining.

Fix both bugs. Do not change the `Step` type alias or the `__init__` signature.
