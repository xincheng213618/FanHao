from __future__ import annotations

import asyncio
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


MODULE_ROOT = Path(__file__).resolve().parents[1]
AUDIT_PATH = MODULE_ROOT / "tools" / "audit_video_quality.py"


def load_audit_module():
    spec = importlib.util.spec_from_file_location("download_manager_quality_audit", AUDIT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load quality audit module: {AUDIT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class QualityAuditCharacterizationTests(unittest.TestCase):
    def test_all_downloaded_mode_includes_existing_quality_queue(self) -> None:
        audit = load_audit_module()
        with tempfile.TemporaryDirectory(prefix="fanhao-quality-all-") as temp_dir:
            root = Path(temp_dir)
            manager_db = root / "manager.sqlite"
            fanhao_db = root / "fanhao.sqlite"
            with closing(sqlite3.connect(manager_db)) as conn:
                conn.execute(
                    """
                    CREATE TABLE links (
                      id INTEGER PRIMARY KEY, profile_id INTEGER, aweme_id TEXT, url TEXT,
                      downloaded_at TEXT, digg_count INTEGER, status TEXT, media_type TEXT,
                      kind TEXT, download_intent TEXT
                    )
                    """
                )
                conn.executemany(
                    """
                    INSERT INTO links VALUES (?, 1, ?, 'https://example.test/video',
                      '2026-07-16T00:00:00+08:00', 0, ?, 'video', 'video', ?)
                    """,
                    [
                        (1, "downloaded", "downloaded", None),
                        (2, "queued", "pending", audit.QUALITY_UPGRADE_INTENT),
                        (3, "ordinary-pending", "pending", None),
                    ],
                )
                conn.commit()
            with closing(sqlite3.connect(fanhao_db)) as conn:
                conn.execute(
                    """
                    CREATE TABLE short_videos (
                      aweme_id TEXT PRIMARY KEY, digg_count INTEGER, width INTEGER,
                      height INTEGER, source_path TEXT, size_bytes INTEGER
                    )
                    """
                )
                conn.executemany(
                    "INSERT INTO short_videos VALUES (?, 0, 1080, 1920, 'D:/Media/example.mp4', 1)",
                    [("downloaded",), ("queued",), ("ordinary-pending",)],
                )
                conn.commit()

            candidates = audit.load_candidates(
                manager_db, fanhao_db, None, 0, 0, 0, include_quality_queue=True
            )
            self.assertEqual({item["aweme_id"] for item in candidates}, {"downloaded", "queued"})

    def test_queue_upgrades_is_idempotent_and_does_not_reset_downloading(self) -> None:
        audit = load_audit_module()
        with tempfile.TemporaryDirectory(prefix="fanhao-quality-queue-") as temp_dir:
            manager_db = Path(temp_dir) / "manager.sqlite"
            with closing(sqlite3.connect(manager_db)) as conn:
                conn.executescript(
                    """
                    CREATE TABLE links (
                      id INTEGER PRIMARY KEY, profile_id INTEGER, aweme_id TEXT,
                      status TEXT, download_intent TEXT, failed_at TEXT,
                      last_started_at TEXT, last_error TEXT, digg_count INTEGER
                    );
                    CREATE TABLE profile_download_queue (
                      profile_id INTEGER PRIMARY KEY, sort_order INTEGER, enabled INTEGER,
                      created_at TEXT, updated_at TEXT
                    );
                    CREATE TABLE events (ts TEXT, level TEXT, message TEXT);
                    """
                )
                conn.executemany(
                    "INSERT INTO links VALUES (?, ?, ?, ?, ?, NULL, NULL, '', 0)",
                    [
                        (1, 1, "new", "downloaded", None),
                        (2, 2, "queued", "pending", audit.QUALITY_UPGRADE_INTENT),
                        (3, 3, "active", "downloading", None),
                    ],
                )
                conn.commit()
            results = [
                {"link_id": link_id, "profile_id": link_id, "aweme_id": aweme_id, "upgrade": True}
                for link_id, aweme_id in [(1, "new"), (2, "queued"), (3, "active")]
            ]
            changed, _ = audit.queue_upgrades(manager_db, results)
            self.assertEqual(changed, 1)
            with closing(sqlite3.connect(manager_db)) as conn:
                rows = {
                    row[0]: row[1:]
                    for row in conn.execute("SELECT id, status, download_intent FROM links ORDER BY id")
                }
            self.assertEqual(rows[1], ("pending", audit.QUALITY_UPGRADE_INTENT))
            self.assertEqual(rows[2], ("pending", audit.QUALITY_UPGRADE_INTENT))
            self.assertEqual(rows[3], ("downloading", None))

    def test_local_detail_only_does_not_import_downloader_runtime(self) -> None:
        audit = load_audit_module()
        with tempfile.TemporaryDirectory(prefix="fanhao-quality-local-") as temp_dir:
            root = Path(temp_dir)
            source_path = root / "sample.mp4"
            source_path.touch()
            (root / "sample_data.json").write_text(
                json.dumps(
                    {
                        "video": {
                            "bit_rate": [
                                {
                                    "bit_rate": 2_000_000,
                                    "play_addr": {"width": 1080, "height": 1920, "url_list": ["low"]},
                                },
                                {
                                    "bit_rate": 8_000_000,
                                    "play_addr": {"width": 2160, "height": 3840, "url_list": ["high"]},
                                },
                            ]
                        }
                    }
                ),
                encoding="utf-8",
            )

            results = asyncio.run(
                audit.audit_candidates(
                    [
                        {
                            "aweme_id": "local-only",
                            "source_path": str(source_path),
                            "current_width": 1080,
                            "current_height": 1920,
                            "downloaded_at": "2026-07-16T00:00:00+08:00",
                        }
                    ],
                    root / "missing-downloader-runtime",
                    root / "missing-cookie.json",
                    proxy="",
                    concurrency=1,
                    allow_api=False,
                )
            )

            self.assertEqual(len(results), 1)
            self.assertTrue(results[0]["upgrade"])
            self.assertEqual((results[0]["target_width"], results[0]["target_height"]), (2160, 3840))
            self.assertEqual(results[0]["detail_source"], "local_data_json")

    def test_like_range_includes_both_boundaries(self) -> None:
        audit = load_audit_module()
        with tempfile.TemporaryDirectory(prefix="fanhao-quality-range-") as temp_dir:
            root = Path(temp_dir)
            manager_db = root / "manager.sqlite"
            fanhao_db = root / "fanhao.sqlite"

            with closing(sqlite3.connect(manager_db)) as conn:
                conn.execute(
                    """
                    CREATE TABLE links (
                      id INTEGER PRIMARY KEY,
                      profile_id INTEGER,
                      aweme_id TEXT,
                      url TEXT,
                      downloaded_at TEXT,
                      digg_count INTEGER,
                      status TEXT,
                      media_type TEXT,
                      kind TEXT
                    )
                    """
                )
                rows = [
                    (1, "below", 199_999),
                    (2, "at-min", 200_000),
                    (3, "at-max", 500_000),
                    (4, "above", 500_001),
                    (5, "fanhao-fallback", 0),
                ]
                conn.executemany(
                    """
                    INSERT INTO links (
                      id, profile_id, aweme_id, url, downloaded_at,
                      digg_count, status, media_type, kind
                    ) VALUES (?, 1, ?, 'https://example.test/video', '2026-07-16T00:00:00+08:00',
                              ?, 'downloaded', 'video', 'video')
                    """,
                    rows,
                )
                conn.commit()

            with closing(sqlite3.connect(fanhao_db)) as conn:
                conn.execute(
                    """
                    CREATE TABLE short_videos (
                      aweme_id TEXT PRIMARY KEY,
                      digg_count INTEGER,
                      width INTEGER,
                      height INTEGER,
                      source_path TEXT,
                      size_bytes INTEGER
                    )
                    """
                )
                conn.executemany(
                    """
                    INSERT INTO short_videos (
                      aweme_id, digg_count, width, height, source_path, size_bytes
                    ) VALUES (?, ?, 1080, 1920, 'D:/Media/example.mp4', 1)
                    """,
                    [
                        (aweme_id, 300_000 if aweme_id == "fanhao-fallback" else likes)
                        for _, aweme_id, likes in rows
                    ],
                )
                conn.commit()

            candidates = audit.load_candidates(
                manager_db,
                fanhao_db,
                since=None,
                min_digg_count=200_000,
                max_digg_count=500_000,
                limit=0,
            )

            self.assertEqual(
                {item["aweme_id"] for item in candidates},
                {"at-min", "at-max", "fanhao-fallback"},
            )
            fallback = next(item for item in candidates if item["aweme_id"] == "fanhao-fallback")
            self.assertEqual(fallback["digg_count"], 300_000)


if __name__ == "__main__":
    unittest.main()
