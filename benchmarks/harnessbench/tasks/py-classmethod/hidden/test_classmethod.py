import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from counter import Counter

def test_from_list_on_class():
    c = Counter.from_list([1, 2, 3])
    assert c.value == 6, f"expected 6 got {c.value}"

def test_from_list_empty():
    c = Counter.from_list([])
    assert c.value == 0

def test_increment_still_works():
    c = Counter(10)
    c.increment()
    assert c.value == 11

if __name__ == "__main__":
    test_from_list_on_class()
    test_from_list_empty()
    test_increment_still_works()
    print("All tests passed")
