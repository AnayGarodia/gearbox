class Counter:
    def __init__(self, initial: int = 0):
        self.value = initial

    def from_list(self, items: list[int]) -> "Counter":
        total = sum(items)
        return Counter(total)

    def increment(self) -> None:
        self.value += 1
