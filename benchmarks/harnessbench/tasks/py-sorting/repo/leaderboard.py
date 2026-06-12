from typing import TypedDict

class Player(TypedDict):
    name: str
    score: int

def ranked_players(players: list[Player]) -> list[Player]:
    """Returns players sorted by score descending."""
    return sorted(players, key=lambda p: p["score"], reverse=True)
