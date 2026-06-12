import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.cart import Cart

class TestCart(unittest.TestCase):
    def test_independent_carts(self):
        a = Cart()
        b = Cart()
        a.add("apple")
        self.assertEqual(a.total_items(), 1)
        self.assertEqual(b.total_items(), 0)

    def test_add_items(self):
        c = Cart()
        c.add("x")
        c.add("y")
        self.assertEqual(c.total_items(), 2)

    def test_starts_empty(self):
        self.assertEqual(Cart().total_items(), 0)

if __name__ == "__main__":
    unittest.main()
