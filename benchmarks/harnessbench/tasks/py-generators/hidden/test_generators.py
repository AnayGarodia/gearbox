import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pipeline import make_numbers, process_batches

def test_both_stages_see_data():
    result = process_batches(make_numbers(5))
    assert result["validated"] == [0, 1, 2, 3, 4], f"got {result['validated']}"
    assert result["transformed"] == [0, 2, 4, 6, 8], f"got {result['transformed']}"

def test_negative_filtered():
    def gen():
        yield from [-1, 0, 2, -3, 4]
    result = process_batches(gen())
    assert result["validated"] == [0, 2, 4]
    assert result["transformed"] == [0, 4, 8]

if __name__ == "__main__":
    test_both_stages_see_data()
    test_negative_filtered()
    print("All tests passed")
