from __future__ import annotations

import re


MAX_JAVDB_RATING = 5.0

_RATING_WITH_COUNT_RE = re.compile(
    r"(?P<rating>\d+(?:\.\d+)?)\s*(?:分|points?)"
    r"\s*[,，、·/|;；:：-]*\s*(?:由|from)\s*"
    r"(?P<count>[\d,，]+)\s*(?:人|users?|ratings?)",
    flags=re.I,
)
_RATING_RE = re.compile(r"(?P<rating>\d+(?:\.\d+)?)\s*(?:分|points?)", flags=re.I)
_COUNT_RE = re.compile(r"(?:由|from)?\s*(?P<count>[\d,，]+)\s*(?:人|users?|ratings?)", flags=re.I)


def parse_javdb_rating_facts(value: str, *, require_paired_count: bool = False) -> tuple[float | None, int | None]:
    """Parse JavDB's five-point rating without mistaking title durations for scores."""

    text = str(value or "")
    for match in reversed(list(_RATING_WITH_COUNT_RE.finditer(text))):
        rating = _valid_rating(match.group("rating"))
        if rating is not None:
            return rating, _count(match.group("count"))

    count_match = _COUNT_RE.search(text)
    rating_count = _count(count_match.group("count")) if count_match else None
    if require_paired_count:
        return None, None

    for match in reversed(list(_RATING_RE.finditer(text))):
        rating = _valid_rating(match.group("rating"))
        if rating is not None:
            return rating, rating_count
    return None, rating_count


def _valid_rating(value: str) -> float | None:
    try:
        rating = float(value)
    except (TypeError, ValueError):
        return None
    return rating if 0 <= rating <= MAX_JAVDB_RATING else None


def _count(value: str) -> int | None:
    try:
        return int(str(value or "").replace(",", "").replace("，", ""))
    except (TypeError, ValueError):
        return None
