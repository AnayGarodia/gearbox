`Counter.from_list` is intended to be a class constructor (called as `Counter.from_list([1, 2, 3])`) but it is defined as an instance method, so calling it on the class raises a `TypeError`.
Fix it so `Counter.from_list(items)` works correctly as a class-level factory.
File to edit: `counter.py`
