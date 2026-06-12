`ManagedResource` opens and closes a resource but does not implement the context manager protocol (`__enter__` / `__exit__`).
Add the two methods so the class works with `with ManagedResource() as r:`.
Requirements:
- `__enter__` should call `open()` and return `self`.
- `__exit__` must call `close()` even if the body raised an exception.
- `__exit__` should not suppress exceptions (return `False` or `None`).

File to edit: `resource.py`
