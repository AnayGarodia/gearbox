class ManagedResource:
    def __init__(self):
        self.opened = False
        self.closed = False
        self.log: list[str] = []

    def open(self):
        self.opened = True
        self.log.append("open")

    def close(self):
        self.closed = True
        self.log.append("close")

    def read(self) -> str:
        if not self.opened or self.closed:
            raise RuntimeError("resource not open")
        return "data"
