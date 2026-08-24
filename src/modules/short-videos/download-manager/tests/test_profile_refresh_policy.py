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
    SMALL_PROFILE_FULL_SCAN_MAX_WORKS,
    profile_prefers_full_scan,
    profile_refresh_decision,
    profile_requires_full_scan,
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

    def test_pending_count_reconciliation_forces_one_full_scan(self) -> None:
        decision = profile_refresh_decision(
            {
                "tab": "post",
                "last_extracted_at": iso_at(2_000_000_000),
                "full_scan_required": 1,
                "full_scan_required_at": iso_at(2_000_000_100),
            },
            now_timestamp=2_000_000_000,
        )

        self.assertEqual(decision["refresh_due"], 1)
        self.assertEqual(decision["refresh_basis"], "full_scan_required")
        self.assertEqual(decision["refresh_mode"], "full")

    def test_unconfirmed_local_count_gap_is_actionable_before_the_flag_is_persisted(self) -> None:
        profile = {
            "tab": "post",
            "last_extracted_at": iso_at(2_000_000_000),
            "full_scan_required": 0,
            "has_deleted_works": 0,
            "last_full_scan_at": None,
            "link_total": 42,
            "aweme_count": 30,
        }

        decision = profile_refresh_decision(profile, now_timestamp=2_000_000_000)

        self.assertTrue(profile_requires_full_scan(profile))
        self.assertEqual(decision["refresh_due"], 1)
        self.assertEqual(decision["refresh_basis"], "full_scan_required")
        self.assertEqual(decision["refresh_mode"], "full")

    def test_completed_full_scan_suppresses_the_same_local_count_gap(self) -> None:
        profile = {
            "tab": "post",
            "full_scan_required": 0,
            "has_deleted_works": 0,
            "last_full_scan_at": iso_at(2_000_000_000),
            "link_total": 42,
            "aweme_count": 30,
        }

        self.assertFalse(profile_requires_full_scan(profile))

    def test_small_post_profile_uses_full_mode_without_becoming_immediately_due(self) -> None:
        collected = 2_000_000_000
        small_profile = {
            "tab": "post",
            "account_status": "active",
            "aweme_count": SMALL_PROFILE_FULL_SCAN_MAX_WORKS,
            "last_extracted_at": iso_at(collected),
            "latest_work_create_time": collected - 60 * 60,
            "previous_work_create_time": None,
            "full_scan_required": 0,
            "has_deleted_works": 0,
            "last_full_scan_at": iso_at(collected - 24 * 60 * 60),
        }

        decision = profile_refresh_decision(small_profile, now_timestamp=collected)

        self.assertTrue(profile_prefers_full_scan(small_profile))
        self.assertFalse(profile_requires_full_scan(small_profile))
        self.assertEqual(decision["refresh_due"], 0)
        self.assertEqual(decision["refresh_mode"], "full")

    def test_profiles_above_threshold_and_non_post_profiles_keep_quick_mode(self) -> None:
        collected = 2_000_000_000
        large_profile = {
            "tab": "post",
            "account_status": "active",
            "aweme_count": SMALL_PROFILE_FULL_SCAN_MAX_WORKS + 1,
            "last_extracted_at": iso_at(collected),
        }
        like_profile = {
            "tab": "like",
            "account_status": "active",
            "aweme_count": 50,
            "last_extracted_at": iso_at(collected),
        }

        self.assertFalse(profile_prefers_full_scan(large_profile))
        self.assertFalse(profile_prefers_full_scan(like_profile))
        self.assertEqual(
            profile_refresh_decision(large_profile, now_timestamp=collected)["refresh_mode"],
            "quick",
        )
        self.assertEqual(
            profile_refresh_decision(like_profile, now_timestamp=collected)["refresh_mode"],
            "quick",
        )

    def test_banned_profile_is_never_selected_for_automatic_refresh(self) -> None:
        decision = profile_refresh_decision(
            {
                "tab": "post",
                "account_status": "banned",
                "last_extracted_at": iso_at(1_000_000_000),
                "full_scan_required": 1,
                "full_scan_required_at": iso_at(1_000_000_100),
            },
            now_timestamp=2_000_000_000,
        )

        self.assertEqual(decision["refresh_due"], 0)
        self.assertEqual(decision["refresh_basis"], "account_banned")
        self.assertEqual(decision["refresh_mode"], "manual")


if __name__ == "__main__":
    unittest.main()
