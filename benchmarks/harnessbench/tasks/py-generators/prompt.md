`process_batches` converts a generator to a list twice — the second call to `list(data)` gets nothing because the generator is already exhausted.
Fix the pipeline so that all three stages (validate, transform, output) operate on the same data without exhausting it.

File to edit: `pipeline.py`
