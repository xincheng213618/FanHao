from __future__ import annotations

import sys
import unittest
from pathlib import Path


MODULE_DIR = Path(__file__).resolve().parents[1]
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from manager_core.download_state import DownloadManager


class DownloadCyclePolicyTests(unittest.TestCase):
    def test_partial_cycle_resets_after_continuous_idle_without_stopping_watcher(self) -> None:
        manager = DownloadManager()
        manager.active = True
        manager.watch_new = True
        manager.job_id = 1979
        manager.cycle_sidecar_success = 52

        self.assertTrue(manager._begin_cycle_idle(now=1_000))
        self.assertEqual(manager._reset_cycle_after_idle(1_800, 350, now=2_799), 0)
        self.assertEqual(manager.cycle_sidecar_success, 52)

        self.assertEqual(manager._reset_cycle_after_idle(1_800, 350, now=2_800), 52)
        self.assertEqual(manager.cycle_sidecar_success, 0)
        self.assertIsNone(manager.cycle_idle_since)
        self.assertTrue(manager.active)
        self.assertTrue(manager.watch_new)
        self.assertEqual(manager.job_id, 1979)

    def test_new_work_cancels_idle_wait_and_next_idle_period_starts_fresh(self) -> None:
        manager = DownloadManager()
        manager.cycle_sidecar_success = 349

        manager._begin_cycle_idle(now=100)
        manager._cancel_cycle_idle()
        self.assertEqual(manager._reset_cycle_after_idle(1_800, 350, now=10_000), 0)
        self.assertEqual(manager.cycle_sidecar_success, 349)

        self.assertTrue(manager._begin_cycle_idle(now=10_000))
        self.assertEqual(manager._reset_cycle_after_idle(1_800, 350, now=11_799), 0)
        self.assertEqual(manager._reset_cycle_after_idle(1_800, 350, now=11_800), 349)

    def test_cycle_limit_cannot_be_bypassed_by_idle_reset(self) -> None:
        manager = DownloadManager()
        manager.cycle_sidecar_success = 350
        manager._begin_cycle_idle(now=100)

        self.assertEqual(manager._reset_cycle_after_idle(1_800, 350, now=10_000), 0)
        self.assertEqual(manager.cycle_sidecar_success, 350)
        self.assertEqual(manager.cycle_idle_since, 100)


if __name__ == "__main__":
    unittest.main()
