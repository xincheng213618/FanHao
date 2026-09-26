from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from utils.abogus_v2 import ABogus, decode, structure_error
from utils.sm3 import sm3_hexdigest


SAMPLES = json.loads(
    (Path(__file__).parent / "fixtures" / "signing" / "abogus_browser.json").read_text(
        encoding="utf-8"
    )
)["samples"]


@pytest.mark.parametrize("index", range(len(SAMPLES)))
def test_browser_captures_are_valid_current_abogus(index: int) -> None:
    sample = SAMPLES[index]

    assert structure_error(sample["a_bogus"]) is None
    decoded = decode(sample["a_bogus"])
    assert decoded["aid"] == 6383
    assert decoded["page_id"] == 6241
    assert decoded["browser_info"] == sample["browser_info"]
    assert 0 <= decoded["now_ms"] - sample["sibling_timestamp"] * 1000 < 1000


@pytest.mark.parametrize("index", range(len(SAMPLES)))
def test_local_signer_reproduces_browser_payload_fields(index: int) -> None:
    sample = SAMPLES[index]
    browser_value = decode(sample["a_bogus"])
    local_value = ABogus(
        sample["user_agent"],
        browser_info=sample["browser_info"],
        rng=random.Random(index),
    ).get_value(
        sample["query"],
        body=sample["body"],
        now_ms=browser_value["now_ms"],
    )

    assert local_value != sample["a_bogus"]
    assert decode(local_value) == browser_value


@pytest.mark.parametrize(
    ("message", "digest"),
    [
        (b"abc", "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0"),
        (
            b"abcd" * 16,
            "debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732",
        ),
    ],
)
def test_sm3_matches_published_vectors(message: bytes, digest: str) -> None:
    assert sm3_hexdigest(message) == digest
