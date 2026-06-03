"""
sample.py — a small utility library with a CLI.

Covers: dataclasses, file I/O, argument parsing, basic statistics,
a retry decorator, and a simple CSV reader/writer.
"""

from __future__ import annotations

import argparse
import csv
import functools
import math
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, TypeVar

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

T = TypeVar("T")


# ---------------------------------------------------------------------------
# Retry decorator
# ---------------------------------------------------------------------------

def retry(times: int = 3, delay: float = 0.1, exceptions: tuple = (Exception,)):
    """Retry a function up to *times* attempts on the given exceptions."""
    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            last_exc: Exception | None = None
            for attempt in range(1, times + 1):
                try:
                    return fn(*args, **kwargs)
                except exceptions as exc:
                    last_exc = exc
                    if attempt < times:
                        time.sleep(delay)
            raise RuntimeError(f"{fn.__name__} failed after {times} attempts") from last_exc
        return wrapper
    return decorator


# ---------------------------------------------------------------------------
# Statistics helpers
# ---------------------------------------------------------------------------

def mean(values: Iterable[float]) -> float:
    data = list(values)
    if not data:
        raise ValueError("mean of empty sequence")
    return sum(data) / len(data)


def std_dev(values: Iterable[float]) -> float:
    data = list(values)
    if len(data) < 2:
        raise ValueError("std_dev requires at least two values")
    m = mean(data)
    variance = sum((x - m) ** 2 for x in data) / (len(data) - 1)
    return math.sqrt(variance)


def median(values: Iterable[float]) -> float:
    data = sorted(values)
    if not data:
        raise ValueError("median of empty sequence")
    n = len(data)
    mid = n // 2
    return data[mid] if n % 2 else (data[mid - 1] + data[mid]) / 2.0


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Sample:
    name: str
    values: list[float] = field(default_factory=list)

    def add(self, value: float) -> None:
        self.values.append(value)

    def summary(self) -> dict:
        if not self.values:
            return {"name": self.name, "n": 0}
        return {
            "name": self.name,
            "n": len(self.values),
            "mean": round(mean(self.values), 4),
            "median": round(median(self.values), 4),
            "std_dev": round(std_dev(self.values), 4) if len(self.values) >= 2 else None,
            "min": min(self.values),
            "max": max(self.values),
        }


# ---------------------------------------------------------------------------
# CSV I/O
# ---------------------------------------------------------------------------

def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="") as fh:
        return list(csv.DictReader(fh))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Generate random samples and print statistics.")
    p.add_argument("--samples", type=int, default=3, help="number of named samples")
    p.add_argument("--size", type=int, default=20, help="values per sample")
    p.add_argument("--seed", type=int, default=None, help="random seed")
    p.add_argument("--out", type=Path, default=None, help="write summary CSV here")
    return p


def main() -> None:
    args = build_parser().parse_args()
    rng = random.Random(args.seed)

    samples = []
    for i in range(args.samples):
        s = Sample(name=f"group_{i}")
        for _ in range(args.size):
            s.add(rng.gauss(mu=i * 10, sigma=2 + i))
        samples.append(s)

    summaries = [s.summary() for s in samples]
    for row in summaries:
        print(row)

    if args.out:
        write_csv(args.out, summaries)
        print(f"\nSummary written to {args.out}")


if __name__ == "__main__":
    main()
