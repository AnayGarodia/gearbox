class Animal:
    def __init__(self, name: str) -> None:
        self.name = name

    def speak(self) -> str:
        return f"{self.name} says ..."


class Dog(Animal):
    def __init__(self, name: str) -> None:
        # Bug: forgot to call super().__init__(name)
        self.breed = "unknown"

    def speak(self) -> str:
        return f"{self.name} says woof"
