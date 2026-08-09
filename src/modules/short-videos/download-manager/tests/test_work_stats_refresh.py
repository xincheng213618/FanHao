from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

try:
    from .test_runtime_characterization import IsolatedManager
except ImportError:
    from test_runtime_characterization import IsolatedManager


class WorkStatsRefreshTests(unittest.TestCase):
    def test_existing_work_stats_refresh_without_requeueing_download(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-work-stats-") as temp_dir:
            manager = IsolatedManager(Path(temp_dir)).start()
            try:
                profile_url = "https://www.douyin.com/user/MS4wStatsRefresh"
                work_url = "https://www.douyin.com/video/7551234567890123456"
                initial = manager.json_request(
                    "/api/links/import",
                    method="POST",
                    payload={
                        "profile_url": profile_url,
                        "profile_tab": "post",
                        "works": [
                            {
                                "aweme_id": "7551234567890123456",
                                "url": work_url,
                                "author_sec_uid": "MS4wStatsRefresh",
                                "digg_count": 0,
                                "comment_count": 0,
                                "collect_count": 0,
                                "share_count": 0,
                            }
                        ],
                    },
                )
                self.assertTrue(initial["ok"])
                self.assertEqual(initial["inserted"], 1)

                with closing(sqlite3.connect(manager.db_path)) as connection:
                    connection.row_factory = sqlite3.Row
                    stored = connection.execute(
                        "SELECT id, digg_count, comment_count, collect_count, share_count FROM links"
                    ).fetchone()
                    self.assertIsNotNone(stored)
                    self.assertEqual(
                        tuple(stored[key] for key in ("digg_count", "comment_count", "collect_count", "share_count")),
                        (0, 0, 0, 0),
                    )
                    connection.execute(
                        "UPDATE links SET status='downloaded', downloaded_at='2026-08-09T10:00:00+08:00' WHERE id=?",
                        (stored["id"],),
                    )
                    connection.commit()

                refreshed = manager.json_request(
                    "/api/links/import",
                    method="POST",
                    payload={
                        "profile_url": profile_url,
                        "profile_tab": "post",
                        "works": [
                            {
                                "aweme_id": "7551234567890123456",
                                "url": work_url,
                                "authorSecUid": "MS4wStatsRefresh",
                                "diggCount": 125,
                                "commentCount": 14,
                                "collectCount": 23,
                                "shareCount": 7,
                            }
                        ],
                    },
                )
                self.assertTrue(refreshed["ok"])
                self.assertEqual(refreshed["inserted"], 0)
                self.assertEqual(refreshed["updated"], 1)

                manager.json_request(
                    "/api/links/import",
                    method="POST",
                    payload={
                        "profile_url": profile_url,
                        "profile_tab": "post",
                        "works": [{
                            "aweme_id": "7551234567890123456",
                            "url": work_url,
                            "author_sec_uid": "MS4wStatsRefresh",
                        }],
                    },
                )

                with closing(sqlite3.connect(manager.db_path)) as connection:
                    connection.row_factory = sqlite3.Row
                    stored = connection.execute(
                        """
                        SELECT status, downloaded_at, digg_count, comment_count, collect_count, share_count
                        FROM links
                        """
                    ).fetchone()
                self.assertEqual(stored["status"], "downloaded")
                self.assertEqual(stored["downloaded_at"], "2026-08-09T10:00:00+08:00")
                self.assertEqual(
                    tuple(stored[key] for key in ("digg_count", "comment_count", "collect_count", "share_count")),
                    (125, 14, 23, 7),
                )
                self.assertFalse(manager.forbidden_fanhao_db_path.exists())
            finally:
                manager.close()


if __name__ == "__main__":
    unittest.main()
