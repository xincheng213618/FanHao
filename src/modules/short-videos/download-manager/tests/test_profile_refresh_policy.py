from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path


MODULE_DIR = Path(__file__).resolve().parents[1]
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from manager_core.profile_refresh_policy import (  # noqa: E402
    DEFAULT_REFRESH_INTERVAL_SECONDS,
    MAX_REFRESH_INTERVAL_SECONDS,
    MIN_REFRESH_INTERVAL_SECONDS,
    profile_refresh_decision,
)


def iso_at(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds")


class ProfileRefreshPolicyTests(unittest.TestCase):
    def test_recent_posting_gap_schedules_the_next_check(self) -> None:
        collected = 2_000_000_000
        cadence = 12 * 60 * 60
        profile = {
            "tab": "post",
            "last_extracted_at": iso_at(collected),
            "latest_work_create_time": collected - 60 * 60,
            "previous_work_create_time": collected - 60 * 60 - cadence,
        }

        waiting = profile_refresh_decision(profile, now_timestamp=collected + cadence - 1)
        due = profile_refresh_decision(profile, now_timestamp=collected + cadence)

        self.assertEqual(waiting["refresh_interval_seconds"], cadence)
        self.assertEqual(waiting["refresh_due"], 0)
        self.assertEqual(due["refresh_due"], 1)

    def test_dormant_profile_backs_off_to_the_maximum_interval(self) -> None:
        collected = 2_000_000_000
        profile = {
            "tab": "post",
            "last_extracted_at": iso_at(collected),
            "latest_work_create_time": collected - 90 * 24 * 60 * 60,
            "previous_work_create_time": collected - 91 * 24 * 60 * 60,
        }

        decision = profile_refresh_decision(profile, now_timestamp=collected)

        self.assertEqual(decision["refresh_interval_seconds"], MAX_REFRESH_INTERVAL_SECONDS)
        self.assertEqual(decision["refresh_due"], 0)

    def test_very_frequent_profile_is_clamped_to_six_hours(self) -> None:
        collected = 2_000_000_000
        profile = {
            "tab": "post",
            "last_extracted_at": iso_at(collected),
            "latest_work_create_time": collected - 60 * 60,
            "previous_work_create_time": collected - 65 * 60,
        }

        decision = profile_refresh_decision(profile, now_timestamp=collected)

        self.assertEqual(decision["refresh_interval_seconds"], MIN_REFRESH_INTERVAL_SECONDS)

    def test_missing_second_work_uses_one_day_fallback(self) -> None:
        collected = 2_000_000_000
        profile = {
            "tab": "post",
            "last_extracted_at": iso_at(collected),
            "latest_work_create_time": collected - 60 * 60,
            "previous_work_create_time": None,
        }

        decision = profile_refresh_decision(profile, now_timestamp=collected)

        self.assertEqual(decision["refresh_interval_seconds"], DEFAULT_REFRESH_INTERVAL_SECONDS)
        self.assertEqual(decision["refresh_basis"], "insufficient_history")

    def test_like_tab_and_never_collected_profile_are_immediately_due(self) -> None:
        like_decision = profile_refresh_decision(
            {"tab": "like", "last_extracted_at": iso_at(2_000_000_000)},
            now_timestamp=2_000_000_000,
        )
        new_profile_decision = profile_refresh_decision(
            {"tab": "post", "last_extracted_at": None},
            now_timestamp=2_000_000_000,
        )

        self.assertEqual(like_decision["refresh_due"], 1)
        self.assertEqual(like_decision["refresh_basis"], "like_activity")
        self.assertEqual(new_profile_decision["refresh_due"], 1)
        self.assertEqual(new_profile_decision["refresh_basis"], "never_collected")


if __name__ == "__main__":
    unittest.main()
