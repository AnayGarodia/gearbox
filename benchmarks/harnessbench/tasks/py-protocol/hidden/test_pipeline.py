import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.pipeline import Pipeline

class TestPipeline(unittest.TestCase):
    def test_forward_order(self):
        p = Pipeline()
        p.pipe(lambda x: x * 2)
        p.pipe(lambda x: x + 1)
        # correct: (3 * 2) + 1 = 7; reversed would be (3 + 1) * 2 = 8
        self.assertEqual(p.run(3), 7)

    def test_method_chaining(self):
        p = Pipeline()
        result = p.pipe(lambda x: x + 10).pipe(lambda x: x * 3)
        self.assertIsNotNone(result)
        self.assertEqual(result.run(0), 30)

    def test_single_step(self):
        p = Pipeline()
        p.pipe(str)
        self.assertEqual(p.run(42), "42")

    def test_empty_pipeline(self):
        p = Pipeline()
        self.assertEqual(p.run(99), 99)

if __name__ == "__main__":
    unittest.main()
