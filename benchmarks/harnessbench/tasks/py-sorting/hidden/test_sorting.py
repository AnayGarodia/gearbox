import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from leaderboard import ranked_players

def test_basic_sort():
    players = [{"name": "Alice", "score": 10}, {"name": "Bob", "score": 20}]
    result = ranked_players(players)
    assert result[0]["name"] == "Bob"
    assert result[1]["name"] == "Alice"

def test_tie_broken_alphabetically():
    players = [
        {"name": "Zara", "score": 100},
        {"name": "Alice", "score": 100},
        {"name": "Mike", "score": 100},
    ]
    result = ranked_players(players)
    names = [p["name"] for p in result]
    assert names == ["Alice", "Mike", "Zara"], f"Expected alphabetical tiebreak, got {names}"

def test_tie_mixed_scores():
    players = [
        {"name": "Carol", "score": 50},
        {"name": "Alice", "score": 100},
        {"name": "Bob", "score": 50},
    ]
    result = ranked_players(players)
    assert result[0]["name"] == "Alice"
    assert result[1]["name"] == "Bob"
    assert result[2]["name"] == "Carol"

if __name__ == "__main__":
    test_basic_sort()
    test_tie_broken_alphabetically()
    test_tie_mixed_scores()
    print("All tests passed")
