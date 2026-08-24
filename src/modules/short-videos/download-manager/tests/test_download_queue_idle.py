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
from manager_core import download_supervisor, profiles_links, server


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

    def test_start_uses_global_queue_when_current_profile_does_not_resolve(self) -> None:
        manager = download_supervisor.SidecarDownloadManager()
        connection = MagicMock()

        def execute(sql: str, _params: object = None) -> MagicMock:
            result = MagicMock()
            if "SELECT COUNT(*) c FROM links WHERE status='pending' AND profile_id=?" in sql:
                result.fetchone.return_value = {"c": 0}
            return result

        connection.execute.side_effect = execute
        database_context = MagicMock()
        database_context.__enter__.return_value = connection
        database_context.__exit__.return_value = False
        supervisor_thread = MagicMock()

        with (
            patch.object(manager, "_clear_failure_guard_locked"),
            patch.object(download_supervisor, "db", return_value=database_context),
            patch.object(download_supervisor, "sync_download_queue"),
            patch.object(download_supervisor, "next_download_queue_profile", return_value=42),
            patch.object(download_supervisor, "queue_pending_count", return_value=3),
            patch.object(download_supervisor, "create_job", return_value=1001),
            patch.object(download_supervisor, "download_timing"),
            patch.object(download_supervisor, "add_event"),
            patch.object(download_supervisor.threading, "Thread", return_value=supervisor_thread),
        ):
            result = manager.start(8, profile_id=None, watch_new=True)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["pending"], 3)
        self.assertEqual(manager.profile_id, 42)
        supervisor_thread.start.assert_called_once_with()

    def test_global_watcher_starts_even_when_queue_is_empty(self) -> None:
        manager = download_supervisor.SidecarDownloadManager()
        connection = MagicMock()
        database_context = MagicMock()
        database_context.__enter__.return_value = connection
        database_context.__exit__.return_value = False
        supervisor_thread = MagicMock()

        with (
            patch.object(manager, "_clear_failure_guard_locked"),
            patch.object(download_supervisor, "db", return_value=database_context),
            patch.object(download_supervisor, "sync_download_queue"),
            patch.object(download_supervisor, "next_download_queue_profile", return_value=None),
            patch.object(download_supervisor, "queue_pending_count", return_value=0),
            patch.object(download_supervisor, "create_job", return_value=1002),
            patch.object(download_supervisor, "download_timing"),
            patch.object(download_supervisor, "add_event"),
            patch.object(download_supervisor.threading, "Thread", return_value=supervisor_thread),
        ):
            result = manager.start(8, profile_id=None, watch_new=True, manual=False)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["pending"], 0)
        self.assertIsNone(manager.profile_id)
        self.assertTrue(manager.active)
        supervisor_thread.start.assert_called_once_with()

    def test_server_starts_automatic_global_watcher(self) -> None:
        with (
            patch.object(server, "setting", return_value="11"),
            patch.object(server.download_manager, "start", return_value={"ok": True}) as start,
        ):
            result = server.start_automatic_downloads()

        self.assertTrue(result["ok"])
        start.assert_called_once_with(
            11,
            retry_failed=False,
            limit=0,
            profile_id=None,
            watch_new=True,
            manual=False,
        )


if __name__ == "__main__":
    unittest.main()
