import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.duration import parse_duration

class T(unittest.TestCase):
    def test_values(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("45s"), 45)
        self.assertEqual(parse_duration("2h"), 7200)
        self.assertEqual(parse_duration("1h2m3s"), 3723)
        self.assertEqual(parse_duration("0s"), 0)
    def test_rejects(self):
        for bad in ["", "30m1h", "1h1h", "90", "1d", "h", "1.5h", " 1h"]:
            with self.assertRaises(ValueError, msg=bad):
                parse_duration(bad)

if __name__ == "__main__":
    unittest.main()
