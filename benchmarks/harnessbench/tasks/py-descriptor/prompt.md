`Temperature` uses a descriptor to store Celsius and expose a `fahrenheit` property, but the descriptor stores the value as a class-level attribute instead of per-instance — all instances share the same temperature.

Fix the descriptor so each `Temperature` instance has its own backing value.
Do not change the public interface (`t.celsius`, `t.fahrenheit`, the constructor).

File to edit: `temperature.py`
