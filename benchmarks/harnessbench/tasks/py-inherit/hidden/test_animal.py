import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.animal import Dog, Animal

class TestDog(unittest.TestCase):
    def test_name_set(self):
        d = Dog("Rex")
        self.assertEqual(d.name, "Rex")

    def test_speak(self):
        self.assertEqual(Dog("Buddy").speak(), "Buddy says woof")

    def test_is_animal(self):
        self.assertIsInstance(Dog("x"), Animal)

    def test_breed_default(self):
        self.assertEqual(Dog("x").breed, "unknown")

if __name__ == "__main__":
    unittest.main()
