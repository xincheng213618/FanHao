from __future__ import annotations

import sqlite3
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE_DIR = Path(__file__).resolve().parents[1]
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from manager_core.queue import (
    clear_download_queue_changed,
    notify_download_queue_changed,
    queue_pending_count,
    wait_for_download_queue_changed,
)
from manager_core import profiles_links


class DownloadQueueIdleTests(unittest.TestCase):
    def tearDown(self) -> None:
        clear_download_queue_changed()

    def test_pending_count_is_a_single_read_only_query(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE links (
              id INTEGER PRIMARY KEY,
              profile_id INTEGER NOT NULL,
              status TEXT NOT NULL
            );
            CREATE TABLE profile_download_queue (
              profile_id INTEGER PRIMARY KEY,
              enabled INTEGER NOT NULL
            );
            INSERT INTO profile_download_queue(profile_id, enabled) VALUES(1, 1), (2, 0);
            INSERT INTO links(profile_id, status) VALUES
              (1, 'pending'), (1, 'downloaded'), (2, 'pending');
            """
        )
        statements: list[str] = []
        conn.set_trace_callback(statements.append)
        before_changes = conn.total_changes

        self.assertEqual(queue_pending_count(conn), 1)

        self.assertEqual(conn.total_changes, before_changes)
        self.assertEqual(len(statements), 1)
        self.assertTrue(statements[0].lstrip().upper().startswith("SELECT COUNT(*)"))
        conn.close()

    def test_queue_change_signal_wakes_an_idle_waiter(self) -> None:
        clear_download_queue_changed()
        timer = threading.Timer(0.05, notify_download_queue_changed)
        timer.start()
        started = time.monotonic()
        try:
            self.assertTrue(wait_for_download_queue_changed(1.0))
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - started, 0.5)

    def test_newly_inserted_link_notifies_the_idle_watcher(self) -> None:
        connection = MagicMock()

        def execute(sql: str, _params: object = None) -> MagicMock:
            result = MagicMock()
            normalized = " ".join(sql.split())
            if normalized.startswith("SELECT sec_uid, tab FROM profiles"):
                result.fetchone.return_value = {"sec_uid": "MS4wQueueSignal", "tab": "post"}
            elif normalized.startswith("SELECT id FROM links"):
                result.fetchone.return_value = None
            elif "GROUP BY author_uid" in normalized:
                result.fetchone.return_value = None
            return result

        connection.execute.side_effect = execute
        database_context = MagicMock()
        database_context.__enter__.return_value = connection
        database_context.__exit__.return_value = False

        with (
            patch.object(profiles_links, "db", return_value=database_context),
            patch.object(profiles_links, "ensure_profile_in_download_queue"),
            patch.object(profiles_links, "notify_download_queue_changed") as notify,
        ):
            inserted, updated = profiles_links.upsert_links(
                1,
                [
                    {
                        "aweme_id": "7550000000000000001",
                        "url": "https://www.douyin.com/video/7550000000000000001",
                        "author_sec_uid": "MS4wQueueSignal",
                    }
                ],
            )

        self.assertEqual((inserted, updated), (1, 0))
        notify.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
