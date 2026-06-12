from dataclasses import dataclass
from typing import List

@dataclass
class Cart:
    items: List[str] = []

    def add(self, item: str) -> None:
        self.items.append(item)

    def total_items(self) -> int:
        return len(self.items)
