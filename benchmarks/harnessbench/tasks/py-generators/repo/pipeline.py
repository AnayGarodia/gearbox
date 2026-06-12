from typing import Generator

def make_numbers(n: int) -> Generator[int, None, None]:
    for i in range(n):
        yield i

def process_batches(data: Generator[int, None, None]) -> dict:
    validated = [x for x in data if x >= 0]
    # BUG: data is already exhausted; this produces []
    transformed = [x * 2 for x in data]
    return {"validated": validated, "transformed": transformed}
