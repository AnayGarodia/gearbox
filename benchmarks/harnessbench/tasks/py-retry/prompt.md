`retry_async` has three bugs:
1. It catches ALL exceptions but the docstring says it should only retry on `RetryableError`; other exceptions should propagate immediately.
2. It re-raises the FIRST exception after exhausting retries, not the LAST one.
3. The `attempts` counter is never reset between calls (it is a mutable default argument).

Fix all three bugs. The function signature must remain unchanged.

File to edit: `retry.py`
