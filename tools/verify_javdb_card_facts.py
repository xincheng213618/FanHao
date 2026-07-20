from bs4 import BeautifulSoup

from backfill_javdb_actor_page import parse_actor_movie_facts
from cache_javdb_rankings import parse_card_facts
from javdb_card_facts import parse_javdb_rating_facts


def main() -> None:
    cases = [
        (
            "ABF-363 完全主観 追撃5.000ピストン【限定特典映像30分付き】 2025-01-01 4.45分, 由910人評價",
            True,
            (4.45, 910),
        ),
        ("MDTD-008 プレミアムBEST 4800分 4.10分，由3人评价", True, (4.1, 3)),
        ("CEMD-794 ベストBOX 21時間06分8枚組 4.2分, 由2人評價", True, (4.2, 2)),
        ("ABF-260 限定特典映像35分付き", True, (None, None)),
        ("限定特典映像3分付き", True, (None, None)),
        ("5.0分，由1,234人評價", True, (5.0, 1234)),
        ("6.0分，由100人評價", True, (None, None)),
        ("评分 4.35分", False, (4.35, None)),
    ]

    for text, require_paired_count, expected in cases:
        actual = parse_javdb_rating_facts(text, require_paired_count=require_paired_count)
        if actual != expected:
            raise AssertionError(f"JavDB rating parse mismatch: {text!r}: expected {expected!r}, got {actual!r}")

    fixture = BeautifulSoup(
        '<div class="item"><div>ABF-363 限定特典映像30分付き</div><div>4.45分, 由910人評價</div></div>',
        "html.parser",
    ).select_one(".item")
    for parser in (parse_actor_movie_facts, parse_card_facts):
        facts = parser(fixture)
        if (facts["rating"], facts["rating_count"]) != (4.45, 910):
            raise AssertionError(f"{parser.__name__} did not use the guarded JavDB rating parser: {facts!r}")

    print(f"JavDB card rating parser checks passed: {len(cases)} cases + 2 scraper integrations")


if __name__ == "__main__":
    main()
