The `ranked_players` function returns players sorted by score (highest first), but when two players have the same score their relative order is non-deterministic, which makes the leaderboard flicker. Fix the function so that players with equal scores are sorted alphabetically by name (A–Z) as a stable tiebreaker.

File to edit: `leaderboard.py`
