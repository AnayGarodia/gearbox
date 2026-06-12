class Animal:
    def __init__(self, name: str) -> None:
        self.name = name

    def speak(self) -> str:
        return f"{self.name} says ..."


class Dog(Animal):
    def __init__(self, name: str) -> None:
        self.breed = "unknown"

    def speak(self) -> str:
        return f"{self.name} says woof"
