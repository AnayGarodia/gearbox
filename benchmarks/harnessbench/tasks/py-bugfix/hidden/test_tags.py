import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.tags import add_tag

class T(unittest.TestCase):
    def test_fresh_list_per_call(self):
        self.assertEqual(add_tag("a"), ["a"])
        self.assertEqual(add_tag("b"), ["b"])
    def test_explicit_list_mutated(self):
        xs = ["x"]
        self.assertIs(add_tag("y", xs), xs)
        self.assertEqual(xs, ["x", "y"])

if __name__ == "__main__":
    unittest.main()
