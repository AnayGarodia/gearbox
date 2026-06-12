from typing import Callable, TypeVar, Generic

T = TypeVar("T")
Step = Callable[[T], T]


class Pipeline(Generic[T]):
    def __init__(self) -> None:
        self._steps: list[Step] = []

        self._steps.append(fn)

    def run(self, value: T) -> T:
            value = step(value)
        return value
