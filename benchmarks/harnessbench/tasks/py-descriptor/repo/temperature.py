class CelsiusDescriptor:
    def __set_name__(self, owner, name):
        self.name = name

    def __get__(self, obj, objtype=None):
        if obj is None:
            return self
        return getattr(obj, f"__{self.name}", 0.0)

    def __set__(self, obj, value: float):
        # BUG: stores on the CLASS, not the instance
        setattr(type(obj), f"__{self.name}", value)


class Temperature:
    celsius = CelsiusDescriptor()

    def __init__(self, celsius: float = 0.0):
        self.celsius = celsius

    @property
    def fahrenheit(self) -> float:
        return self.celsius * 9 / 5 + 32
