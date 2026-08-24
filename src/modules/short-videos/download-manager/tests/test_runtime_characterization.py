from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MODULE_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = Path(__file__).resolve().parents[5]
APP_ENTRY = MODULE_DIR / "app.py"

REQUIRED_STATE_KEYS = {
    "app",
    "settings",
    "current_profile",
    "profiles",
    "download_queue",
    "stats",
    "extract",
    "download",
    "auth",
    "jobs",
    "events",
    "paths",
}
REQUIRED_SETTINGS = {
    "profile_url",
    "profile_tab",
    "output_dir",
    "library_output_dir",
    "concurrency",
    "scrolls",
    "idle_rounds",
    "incremental_stop_existing",
    "profile_refresh_recent_days",
    "download_cycle_limit",
    "download_cycle_cooldown_minutes",
    "failure_guard_threshold",
    "cookie_file",
    "download_proxy",
    "downloader_root",
    "downloader_python",
    "downloader_run",
}
REQUIRED_TABLES = {
    "settings",
    "profiles",
    "links",
    "jobs",
    "events",
    "profile_download_queue",
    "profile_collection_history",
    "link_files",
    "download_records",
    "download_files",
    "manifest_import_state",
    "download_attempts",
    "video_quality_audit_runs",
    "video_quality_audit_items",
}


def reserve_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class IsolatedManager:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.data_dir = root / "data"
        self.log_dir = root / "logs"
        self.db_path = self.data_dir / "douyin_downloads.sqlite"
        self.forbidden_fanhao_db_path = root / "fanhao" / "short-videos.sqlite"
        self.port = reserve_loopback_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.process: subprocess.Popen[str] | None = None
        self.environment: dict[str, str] = {}
        self.stdout = ""
        self.stderr = ""

    def start(self) -> "IsolatedManager":
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        environment = os.environ.copy()
        environment.update(
            {
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
                "PYTHONDONTWRITEBYTECODE": "1",
                "DOUYIN_MANAGER_HOST": "127.0.0.1",
                "DOUYIN_MANAGER_PORT": str(self.port),
                "DOUYIN_MANAGER_DATA_DIR": str(self.data_dir),
                "DOUYIN_MANAGER_LOG_DIR": str(self.log_dir),
                "DOUYIN_MANAGER_OPEN": "0",
                "DOUYIN_MANAGER_SINGLE_INSTANCE": "0",
                "DOUYIN_DOWNLOADER_ROOT": str(self.root / "missing-downloader"),
                "FANHAO_PROJECT_ROOT": str(PROJECT_ROOT),
                "FANHAO_SHORT_VIDEO_DB": str(self.forbidden_fanhao_db_path),
                "FANHAO_SHORT_VIDEO_STORAGE_ROOT": str(self.root / "media"),
                "LOCALAPPDATA": str(self.root / "local-app-data"),
                "APPDATA": str(self.root / "roaming-app-data"),
            }
        )
        self.environment = environment
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.process = subprocess.Popen(
            [sys.executable, "-u", str(APP_ENTRY)],
            cwd=MODULE_DIR,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creation_flags,
        )
        deadline = time.monotonic() + 15
        last_error = ""
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self._collect_output()
                raise AssertionError(
                    "isolated download manager exited before becoming ready\n"
                    f"stdout:\n{self.stdout}\nstderr:\n{self.stderr}"
                )
            try:
                state = self.json_request("/api/state", timeout=0.8)
                if isinstance(state, dict):
                    return self
            except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
                last_error = str(exc)
            time.sleep(0.1)
        self.close()
        raise AssertionError(
            f"isolated download manager did not become ready on {self.base_url}: {last_error}\n"
            f"stdout:\n{self.stdout}\nstderr:\n{self.stderr}"
        )

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        timeout: float = 3,
    ) -> tuple[int, dict[str, str], bytes]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                return int(response.status), dict(response.headers.items()), response.read()
        except HTTPError as error:
            error.read()
            error.close()
            raise

    def json_request(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        timeout: float = 3,
    ) -> dict[str, Any]:
        _, _, body = self.request(path, method=method, payload=payload, timeout=timeout)
        result = json.loads(body.decode("utf-8"))
        if not isinstance(result, dict):
            raise AssertionError(f"expected JSON object from {path}, got {type(result).__name__}")
        return result

    def quit(self) -> dict[str, Any]:
        result = self.json_request("/api/app/quit", method="POST", payload={})
        self.wait_for_exit()
        return result

    def wait_for_exit(self, timeout: float = 10) -> None:
        if self.process is None:
            return
        try:
            self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise AssertionError("isolated download manager did not exit after /api/app/quit") from exc
        finally:
            self._collect_output()

    def _collect_output(self) -> None:
        if self.process is None or self.process.poll() is None:
            return
        stdout, stderr = self.process.communicate()
        self.stdout += stdout or ""
        self.stderr += stderr or ""

    def close(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            try:
                self.json_request("/api/app/quit", method="POST", payload={}, timeout=1)
                self.process.wait(timeout=5)
            except Exception:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        self._collect_output()


def database_snapshot(db_path: Path) -> dict[str, Any]:
    with closing(sqlite3.connect(db_path)) as connection:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        settings = dict(connection.execute("SELECT key, value FROM settings"))
        schema = {
            str(row[0]): str(row[1] or "")
            for row in connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL"
            )
        }
    return {
        "integrity": integrity,
        "quick_check": quick_check,
        "tables": tables,
        "settings": settings,
        "schema": schema,
    }


class RuntimeCharacterizationTests(unittest.TestCase):
    def test_manifest_is_migrated_incrementally_into_download_records(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-record-migration-") as temp:
            root = Path(temp)
            library = root / "media" / "ShortVideos"
            library.mkdir(parents=True)
            media_path = library / "works" / "first.mp4"
            media_path.parent.mkdir(parents=True)
            media_path.write_bytes(b"test-video")
            manifest = library / "download_manifest.jsonl"
            first_record = {
                "recorded_at": "2026-07-26T08:00:00",
                "aweme_id": "7666425128226856563",
                "desc": "旧标题",
                "media_type": "video",
                "file_names": ["first.mp4"],
                "file_paths": ["works/first.mp4"],
            }
            latest_record = {
                **first_record,
                "recorded_at": "2026-07-26T08:01:00",
                "desc": "新标题",
            }
            tail_record = {
                "recorded_at": "2026-07-26T08:02:00",
                "aweme_id": "7665317108750712678",
                "desc": "稍后完成的尾行",
                "media_type": "gallery",
                "file_names": ["second.jpg"],
                "file_paths": ["works/second.jpg"],
            }
            manifest.write_text(
                "\n".join(
                    [
                        json.dumps(first_record, ensure_ascii=False),
                        "{broken-json",
                        json.dumps(latest_record, ensure_ascii=False),
                    ]
                )
                + "\n"
                + json.dumps(tail_record, ensure_ascii=False),
                encoding="utf-8",
            )

            runtime = IsolatedManager(root)
            try:
                runtime.start()
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    connection.row_factory = sqlite3.Row
                    records = connection.execute(
                        "SELECT * FROM download_records ORDER BY aweme_id"
                    ).fetchall()
                    self.assertEqual(len(records), 1)
                    self.assertEqual(
                        json.loads(records[0]["record_json"])["desc"],
                        "新标题",
                    )
                    files = connection.execute(
                        "SELECT * FROM download_files WHERE aweme_id=?",
                        ("7666425128226856563",),
                    ).fetchall()
                    self.assertEqual(len(files), 1)
                    self.assertEqual(files[0]["exists_on_disk"], 1)
                    import_state = connection.execute(
                        "SELECT * FROM manifest_import_state"
                    ).fetchone()
                    self.assertEqual(import_state["bad_lines"], 1)
                    self.assertLess(import_state["byte_offset"], manifest.stat().st_size)
                    db_only_record = {
                        "aweme_id": "7664000000000000001",
                        "desc": "仅存在于旧 links 表",
                        "media_type": "video",
                        "file_names": ["db-only.mp4"],
                        "file_paths": ["works/db-only.mp4"],
                    }
                    connection.execute(
                        """
                        INSERT INTO links(
                          profile_id, aweme_id, kind, url, desc, media_type,
                          local_file_names, local_file_paths, metadata_json,
                          status, discovered_at, last_seen_at, downloaded_at, output_dir
                        )
                        VALUES(
                          NULL, ?, 'video', ?, ?, 'video', ?, ?, ?,
                          'downloaded', ?, ?, ?, ?
                        )
                        """,
                        (
                            db_only_record["aweme_id"],
                            f"https://www.douyin.com/video/{db_only_record['aweme_id']}",
                            db_only_record["desc"],
                            json.dumps(db_only_record["file_names"]),
                            json.dumps(db_only_record["file_paths"]),
                            json.dumps(db_only_record, ensure_ascii=False),
                            "2026-07-26T08:03:00+08:00",
                            "2026-07-26T08:03:00+08:00",
                            "2026-07-26T08:03:00+08:00",
                            str(library),
                        ),
                    )
                    connection.commit()

                runtime.quit()
                with manifest.open("a", encoding="utf-8") as handle:
                    handle.write("\n")

                runtime = IsolatedManager(root)
                runtime.start()
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    connection.row_factory = sqlite3.Row
                    records = connection.execute(
                        "SELECT aweme_id, record_json FROM download_records ORDER BY aweme_id"
                    ).fetchall()
                    self.assertEqual(
                        [row["aweme_id"] for row in records],
                        [
                            "7664000000000000001",
                            "7665317108750712678",
                            "7666425128226856563",
                        ],
                    )
                    tail = json.loads(records[1]["record_json"])
                    self.assertEqual(tail["desc"], "稍后完成的尾行")
                    import_state = connection.execute(
                        "SELECT * FROM manifest_import_state"
                    ).fetchone()
                    self.assertEqual(import_state["byte_offset"], manifest.stat().st_size)
            finally:
                runtime.close()

    def test_isolated_http_contract_and_static_assets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-http-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                health = runtime.json_request("/api/health")
                self.assertTrue(health.get("ok"))
                self.assertEqual(Path(health["paths"]["base"]).resolve(), MODULE_DIR.resolve())
                state = runtime.json_request("/api/state")
                self.assertTrue(REQUIRED_STATE_KEYS.issubset(state), state.keys())
                self.assertTrue(REQUIRED_SETTINGS.issubset(state["settings"]), state["settings"].keys())
                self.assertFalse(state["extract"]["active"])
                self.assertFalse(state["download"]["active"])
                self.assertEqual(Path(state["paths"]["database"]).resolve(), runtime.db_path.resolve())
                self.assertEqual(Path(state["paths"]["logs"]).resolve(), runtime.log_dir.resolve())
                runtime_status = runtime.json_request("/api/status")
                self.assertEqual(set(runtime_status), {"app", "extract", "download"})
                self.assertNotIn("profiles", runtime_status)
                self.assertFalse(runtime_status["download"]["active"])
                activity = runtime.json_request("/api/activity")
                self.assertEqual(set(activity), {"jobs", "events", "extract"})
                self.assertFalse(activity["extract"]["active"])
                self.assertIsNone(activity["extract"]["current"])
                self.assertEqual(activity["extract"]["queue"], [])

                now = "2026-07-26T08:00:00+08:00"
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    for index in range(12):
                        connection.execute(
                            """
                            INSERT INTO jobs(type, status, message, started_at, finished_at)
                            VALUES('extract', 'complete', ?, ?, ?)
                            """,
                            (f"activity-{index}", now, now),
                        )
                    connection.commit()
                activity = runtime.json_request("/api/activity")
                activity_jobs = [
                    job
                    for job in activity["jobs"]
                    if str(job.get("message") or "").startswith("activity-")
                ]
                self.assertEqual(len(activity_jobs), 12)
                self.assertEqual(activity_jobs[0]["message"], "activity-11")

                index_html = runtime.request("/")[2].decode("utf-8")
                activity_js = runtime.request("/features/activity.js")[2].decode("utf-8")
                for heading in ("正在执行", "接下来", "历史任务", "事件日志"):
                    self.assertIn(heading, index_html)
                self.assertIn("state.extract", activity_js)
                self.assertIn("执行中", activity_js)
                self.assertIn("formatDateTime", activity_js)

                profiles = runtime.json_request("/api/profiles")
                self.assertEqual(profiles.get("profiles"), [])
                self.assertEqual(profiles.get("total"), 0)
                links = runtime.json_request("/api/links")
                self.assertEqual(links.get("links"), [])
                self.assertEqual(links.get("total"), 0)

                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    first_profile_id = int(
                        connection.execute(
                            """
                            INSERT INTO profiles(url, sec_uid, tab, title, nickname, created_at, updated_at)
                            VALUES(?, 'profile-one', 'like', '测试喜欢', '测试喜欢', ?, ?)
                            """,
                            ("https://www.douyin.com/user/profile-one?showTab=like", now, now),
                        ).lastrowid
                    )
                    second_profile_id = int(
                        connection.execute(
                            """
                            INSERT INTO profiles(url, sec_uid, tab, title, nickname, created_at, updated_at)
                            VALUES(?, 'profile-two', 'post', '测试作者', '测试作者', ?, ?)
                            """,
                            ("https://www.douyin.com/user/profile-two", now, now),
                        ).lastrowid
                    )
                    connection.execute(
                        """
                        INSERT INTO links(
                          profile_id, aweme_id, kind, url, status, discovered_at, last_seen_at
                        )
                        VALUES(?, '7666425128226856563', 'video', ?, 'failed', ?, ?)
                        """,
                        (
                            first_profile_id,
                            "https://www.douyin.com/video/7666425128226856563",
                            now,
                            now,
                        ),
                    )
                    connection.execute(
                        """
                        INSERT INTO links(
                          profile_id, aweme_id, kind, url, status, discovered_at, last_seen_at
                        )
                        VALUES(?, '7665317108750712678', 'video', ?, 'failed', ?, ?)
                        """,
                        (
                            second_profile_id,
                            "https://www.douyin.com/video/7665317108750712678",
                            now,
                            now,
                        ),
                    )
                    connection.commit()

                global_failed = runtime.json_request("/api/links?status=failed")
                self.assertEqual(global_failed.get("total"), 2)
                by_aweme_id = {
                    str(row["aweme_id"]): row for row in global_failed.get("links", [])
                }
                like_row = by_aweme_id["7666425128226856563"]
                self.assertEqual(like_row.get("profile_id"), first_profile_id)
                self.assertEqual(like_row.get("profile_nickname"), "测试喜欢")
                self.assertEqual(like_row.get("profile_tab"), "like")
                self.assertIn("showTab=like", like_row.get("profile_url", ""))

                manager_failed = runtime.json_request(
                    "/api/links?status=failed&view=manager&include_summary=1&limit=100"
                )
                self.assertEqual(manager_failed.get("view"), "manager")
                self.assertEqual(manager_failed.get("total"), 2)
                self.assertEqual(
                    manager_failed.get("summary"),
                    {
                        "all": 2,
                        "pending": 0,
                        "downloading": 0,
                        "downloaded": 0,
                        "failed": 2,
                    },
                )
                manager_row = manager_failed.get("links", [])[0]
                self.assertIn("aweme_id", manager_row)
                self.assertIn("profile_nickname", manager_row)
                self.assertNotIn("metadata_json", manager_row)
                self.assertNotIn("local_file_paths", manager_row)

                retry_result = runtime.json_request(
                    "/api/links/retry",
                    method="POST",
                    payload={"id": like_row["id"]},
                )
                self.assertTrue(retry_result.get("ok"), retry_result)
                self.assertEqual(retry_result.get("status"), "pending")
                summary_after_retry = runtime.json_request(
                    "/api/links?view=manager&include_summary=1&limit=1"
                ).get("summary")
                self.assertEqual(summary_after_retry.get("all"), 2)
                self.assertEqual(summary_after_retry.get("pending"), 1)
                self.assertEqual(summary_after_retry.get("failed"), 1)

                scoped_failed = runtime.json_request(
                    f"/api/links?status=failed&profile_id={second_profile_id}"
                )
                self.assertEqual(scoped_failed.get("total"), 1)
                self.assertEqual(
                    scoped_failed.get("links", [])[0].get("profile_nickname"),
                    "测试作者",
                )

                status, headers, home = runtime.request("/")
                self.assertEqual(status, 200)
                self.assertIn("text/html", headers.get("Content-Type", ""))
                self.assertIn("app.js", home.decode("utf-8"))
                status, _, app_js = runtime.request("/app.js")
                self.assertEqual(status, 200)
                self.assertGreater(len(app_js), 100)

                status, _, player = runtime.request("/short-videos/1")
                self.assertEqual(status, 200)
                self.assertIn("/fanhao/short-video-app.js", player.decode("utf-8"))
                status, _, shared_player = runtime.request(
                    "/fanhao/modules/short-videos/short-video-page.js"
                )
                self.assertEqual(status, 200)
                self.assertIn("createShortVideoPage", shared_player.decode("utf-8"))

                quit_result = runtime.quit()
                self.assertTrue(quit_result.get("ok"), quit_result)
                self.assertEqual(runtime.process.returncode, 0)
                self.assertFalse(
                    runtime.forbidden_fanhao_db_path.exists(),
                    "the download manager must never write the FanHao catalog database",
                )
            finally:
                runtime.close()

    def test_profile_delete_removes_database_records_and_preserves_sibling_profile(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-profile-delete-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                sec_uid = "test-profile-sec-uid"
                post_url = f"https://www.douyin.com/user/{sec_uid}"
                like_url = f"{post_url}?showTab=like"
                now = "2026-07-16T20:00:00+08:00"
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    connection.execute("PRAGMA foreign_keys=ON")
                    post_profile_id = int(
                        connection.execute(
                            """
                            INSERT INTO profiles(url, sec_uid, tab, title, nickname, created_at, updated_at)
                            VALUES(?, ?, 'post', '测试主页', '测试主页', ?, ?)
                            """,
                            (post_url, sec_uid, now, now),
                        ).lastrowid
                    )
                    like_profile_id = int(
                        connection.execute(
                            """
                            INSERT INTO profiles(url, sec_uid, tab, title, nickname, created_at, updated_at)
                            VALUES(?, ?, 'like', '测试主页', '测试主页', ?, ?)
                            """,
                            (like_url, sec_uid, now, now),
                        ).lastrowid
                    )
                    owner_like_profile_id = int(
                        connection.execute(
                            """
                            INSERT INTO profiles(url, sec_uid, tab, title, nickname, created_at, updated_at)
                            VALUES(?, 'owner-self-sec-uid', 'like', '我的喜欢', '我的喜欢', ?, ?)
                            """,
                            ("https://www.douyin.com/user/owner-self-sec-uid?showTab=like", now, now),
                        ).lastrowid
                    )
                    link_id = int(
                        connection.execute(
                            """
                            INSERT INTO links(profile_id, aweme_id, kind, url, status, discovered_at, last_seen_at)
                            VALUES(?, '7657753714518250752', 'video', ?, 'pending', ?, ?)
                            """,
                            (like_profile_id, "https://www.douyin.com/video/7657753714518250752", now, now),
                        ).lastrowid
                    )
                    owner_link_id = int(
                        connection.execute(
                            """
                            INSERT INTO links(profile_id, aweme_id, kind, url, status, discovered_at, last_seen_at)
                            VALUES(?, '7657753714518250752', 'video', ?, 'downloaded', ?, ?)
                            """,
                            (owner_like_profile_id, "https://www.douyin.com/video/7657753714518250752", now, now),
                        ).lastrowid
                    )
                    connection.execute(
                        """
                        INSERT INTO link_files(
                          link_id, profile_id, aweme_id, role, kind, file_name, file_path,
                          absolute_path, size_bytes, exists_on_disk, recorded_at
                        )
                        VALUES(?, ?, '7657753714518250752', 'primary', 'video', 'test.mp4',
                               'test/test.mp4', 'D:/Media/test.mp4', 123, 1, ?)
                        """,
                        (link_id, like_profile_id, now),
                    )
                    connection.execute(
                        """
                        INSERT INTO link_files(
                          link_id, profile_id, aweme_id, role, kind, file_name, file_path,
                          absolute_path, size_bytes, exists_on_disk, recorded_at
                        )
                        VALUES(?, ?, '7657753714518250752', 'primary', 'video', 'shared.mp4',
                               'owner/shared.mp4', 'D:/Media/shared.mp4', 456, 1, ?)
                        """,
                        (owner_link_id, owner_like_profile_id, now),
                    )
                    connection.execute(
                        """
                        INSERT INTO profile_download_queue(profile_id, sort_order, enabled, created_at, updated_at)
                        VALUES(?, 1, 1, ?, ?)
                        """,
                        (like_profile_id, now, now),
                    )
                    connection.execute(
                        """
                        INSERT INTO jobs(type, status, profile_id, total, processed, success, failed, message, started_at, finished_at)
                        VALUES('extract', 'complete', ?, 1, 1, 1, 0, 'done', ?, ?)
                        """,
                        (like_profile_id, now, now),
                    )
                    connection.execute(
                        "UPDATE settings SET value=? WHERE key='profile_url'",
                        (like_url,),
                    )
                    connection.commit()

                result = runtime.json_request(
                    "/api/profiles/delete",
                    method="POST",
                    payload={"profile_id": like_profile_id},
                )
                self.assertTrue(result.get("ok"), result)
                self.assertEqual(result.get("links_deleted"), 1)
                self.assertEqual(result.get("file_records_deleted"), 1)
                self.assertFalse(result.get("disk_files_deleted"))

                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    self.assertIsNone(
                        connection.execute("SELECT id FROM profiles WHERE id=?", (like_profile_id,)).fetchone()
                    )
                    self.assertIsNotNone(
                        connection.execute("SELECT id FROM profiles WHERE id=?", (post_profile_id,)).fetchone()
                    )
                    self.assertEqual(
                        connection.execute("SELECT COUNT(*) FROM links WHERE profile_id=?", (like_profile_id,)).fetchone()[0],
                        0,
                    )
                    self.assertEqual(
                        connection.execute(
                            "SELECT COUNT(*) FROM links WHERE profile_id=? AND aweme_id='7657753714518250752'",
                            (owner_like_profile_id,),
                        ).fetchone()[0],
                        1,
                    )
                    self.assertEqual(
                        connection.execute("SELECT COUNT(*) FROM link_files WHERE profile_id=?", (like_profile_id,)).fetchone()[0],
                        0,
                    )
                    self.assertEqual(
                        connection.execute("SELECT COUNT(*) FROM link_files WHERE profile_id=?", (owner_like_profile_id,)).fetchone()[0],
                        1,
                    )
                    self.assertEqual(
                        connection.execute("SELECT COUNT(*) FROM profile_download_queue WHERE profile_id=?", (like_profile_id,)).fetchone()[0],
                        0,
                    )
                    self.assertIsNone(
                        connection.execute("SELECT profile_id FROM jobs WHERE message='done'").fetchone()[0]
                    )
                    self.assertEqual(
                        connection.execute("SELECT value FROM settings WHERE key='profile_url'").fetchone()[0],
                        post_url,
                    )

                state = runtime.json_request("/api/state")
                self.assertEqual(state.get("current_profile", {}).get("id"), post_profile_id)
                profiles_js = runtime.request("/features/profiles.js")[2].decode("utf-8")
                self.assertIn("data-profile-delete", profiles_js)
            finally:
                runtime.close()

    def test_deleted_works_flag_can_filter_profiles(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-deleted-works-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                now = "2026-07-20T12:00:00+08:00"
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    link_columns = {
                        row[1] for row in connection.execute("PRAGMA table_info(links)").fetchall()
                    }
                    self.assertIn("is_missing_from_profile", link_columns)
                    self.assertIn("missing_from_profile_at", link_columns)
                    connection.execute(
                        """
                        INSERT INTO profiles(
                          url, sec_uid, tab, title, nickname, aweme_count,
                          has_deleted_works, created_at, updated_at
                        )
                        VALUES(?, 'flagged-author', 'post', '疑似删除作者', '疑似删除作者', 3, 1, ?, ?)
                        """,
                        ("https://www.douyin.com/user/flagged-author", now, now),
                    )
                    connection.execute(
                        """
                        INSERT INTO profiles(
                          url, sec_uid, tab, title, nickname, aweme_count,
                          has_deleted_works, created_at, updated_at
                        )
                        VALUES(?, 'clean-author', 'post', '普通作者', '普通作者', 2, 0, ?, ?)
                        """,
                        ("https://www.douyin.com/user/clean-author", now, now),
                    )
                    flagged_profile_id = connection.execute(
                        "SELECT id FROM profiles WHERE sec_uid='flagged-author'"
                    ).fetchone()[0]
                    for aweme_id in ["seen-a", "seen-b", "seen-c", "missing-d", "missing-e"]:
                        connection.execute(
                            """
                            INSERT INTO links(
                              profile_id, aweme_id, kind, url, status, discovered_at, last_seen_at
                            ) VALUES(?, ?, 'video', ?, 'downloaded', ?, ?)
                            """,
                            (flagged_profile_id, aweme_id, f"https://www.douyin.com/video/{aweme_id}", now, now),
                        )
                    connection.commit()

                reconcile = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        (
                            "import json; "
                            "from manager_core.profiles_links import update_profile_deleted_works_flag; "
                            f"print(json.dumps(update_profile_deleted_works_flag({flagged_profile_id}, "
                            "{'seen-a', 'seen-b', 'seen-c'}), ensure_ascii=False))"
                        ),
                    ],
                    cwd=MODULE_DIR,
                    env=runtime.environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                )
                reconcile_result = json.loads(reconcile.stdout.strip())
                self.assertEqual(reconcile_result["marked"], 2)
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    missing_ids = {
                        row[0]
                        for row in connection.execute(
                            """
                            SELECT aweme_id FROM links
                            WHERE profile_id=? AND is_missing_from_profile=1
                            """,
                            (flagged_profile_id,),
                        ).fetchall()
                    }
                self.assertEqual(missing_ids, {"missing-d", "missing-e"})

                result = runtime.json_request("/api/profiles?scope=all&deleted_works=flagged")
                self.assertEqual(result.get("total"), 1)
                self.assertEqual([row.get("sec_uid") for row in result.get("profiles", [])], ["flagged-author"])
                self.assertEqual(result["profiles"][0].get("has_deleted_works"), 1)

                manager_html = runtime.request("/")[2].decode("utf-8")
                profiles_js = runtime.request("/features/profiles.js")[2].decode("utf-8")
                self.assertIn('id="profileManagerDeletedWorks"', manager_html)
                self.assertIn("待全量确认", manager_html)
                self.assertIn("已确认主页少作品", manager_html)
                self.assertIn("deleted_works", profiles_js)
                self.assertIn("has_deleted_works", profiles_js)
                self.assertIn("full_scan_required", profiles_js)
                self.assertIn("一键智能采集", manager_html)
                self.assertIn("data-profile-full-refresh", profiles_js)
                self.assertIn("full_scan: fullScan", profiles_js)
            finally:
                runtime.close()

    def test_banned_profile_status_preserves_works_and_supports_dedicated_search(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-banned-profile-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                now = "2026-08-10T00:30:00+08:00"
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    profile_columns = {
                        row[1] for row in connection.execute("PRAGMA table_info(profiles)").fetchall()
                    }
                    self.assertTrue(
                        {"account_status", "account_status_reason", "account_status_detected_at"}
                        .issubset(profile_columns)
                    )
                    cursor = connection.execute(
                        """
                        INSERT INTO profiles(
                          url, sec_uid, tab, title, nickname, aweme_count,
                          has_deleted_works, full_scan_required, full_scan_reason,
                          full_scan_required_at, created_at, updated_at
                        )
                        VALUES(?, 'restricted-author', 'post', '受限作者', '受限作者', 3, 1, 1, ?, ?, ?, ?)
                        """,
                        (
                            "https://www.douyin.com/user/restricted-author",
                            "主页作品数明显减少",
                            now,
                            now,
                            now,
                        ),
                    )
                    profile_id = int(cursor.lastrowid)
                    for aweme_id in ["kept-a", "kept-b", "kept-c"]:
                        connection.execute(
                            """
                            INSERT INTO links(
                              profile_id, aweme_id, kind, url, status,
                              is_missing_from_profile, missing_from_profile_at,
                              discovered_at, last_seen_at
                            ) VALUES(?, ?, 'video', ?, 'downloaded', 1, ?, ?, ?)
                            """,
                            (
                                profile_id,
                                aweme_id,
                                f"https://www.douyin.com/video/{aweme_id}",
                                now,
                                now,
                                now,
                            ),
                        )
                    connection.commit()

                probe_script = f"""
import json
from manager_core.profiles_links import upsert_profile_metadata, update_profile_deleted_works_flag
upsert_profile_metadata({profile_id}, {{
    "account_status": "banned",
    "account_status_reason": "该用户被禁言",
    "aweme_count": 0,
}})
print(json.dumps(update_profile_deleted_works_flag({profile_id}, set()), ensure_ascii=False))
"""
                probe = subprocess.run(
                    [sys.executable, "-c", probe_script],
                    cwd=MODULE_DIR,
                    env=runtime.environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                )
                reconcile_result = json.loads(probe.stdout.strip())
                self.assertTrue(reconcile_result["skipped"])
                self.assertEqual(reconcile_result["account_status"], "banned")
                self.assertEqual(reconcile_result["marked"], 0)

                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    profile = connection.execute(
                        """
                        SELECT account_status, account_status_reason, account_status_detected_at,
                               has_deleted_works, full_scan_required
                        FROM profiles WHERE id=?
                        """,
                        (profile_id,),
                    ).fetchone()
                    missing_count = int(
                        connection.execute(
                            "SELECT COUNT(*) FROM links WHERE profile_id=? AND is_missing_from_profile=1",
                            (profile_id,),
                        ).fetchone()[0]
                    )
                self.assertEqual(profile[0], "banned")
                self.assertEqual(profile[1], "该用户被禁言")
                self.assertTrue(profile[2])
                self.assertEqual(profile[3], 0)
                self.assertEqual(profile[4], 0)
                self.assertEqual(missing_count, 0)

                result = runtime.json_request("/api/profiles?scope=banned&q=restricted-author")
                self.assertEqual(result["total"], 1)
                self.assertEqual(result["banned_count"], 1)
                self.assertEqual(result["profiles"][0]["account_status"], "banned")
                self.assertEqual(result["profiles"][0]["refresh_due"], 0)
                self.assertEqual(result["profiles"][0]["refresh_basis"], "account_banned")

                manager_html = runtime.request("/")[2].decode("utf-8")
                profiles_js = runtime.request("/features/profiles.js")[2].decode("utf-8")
                self.assertIn('<option value="banned">已封禁主页</option>', manager_html)
                self.assertIn("is-account-banned", profiles_js)
                self.assertIn("手动确认", profiles_js)
                self.assertIn('scope === "banned"', profiles_js)

                restore = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        (
                            "from manager_core.profiles_links import restore_profile_account_if_active; "
                            f"print(int(restore_profile_account_if_active({profile_id})))"
                        ),
                    ],
                    cwd=MODULE_DIR,
                    env=runtime.environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                )
                self.assertEqual(restore.stdout.strip(), "1")
                restored_result = runtime.json_request("/api/profiles?scope=banned&q=restricted-author")
                self.assertEqual(restored_result["total"], 0)
            finally:
                runtime.close()

    def test_collection_count_history_arms_and_rearms_one_full_scan(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-count-history-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                now = "2026-08-01T12:00:00+08:00"
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    profile_id = int(
                        connection.execute(
                            """
                            INSERT INTO profiles(
                              url, sec_uid, tab, title, nickname, aweme_count,
                              created_at, updated_at, last_extracted_at
                            ) VALUES(?, 'count-history-author', 'post', '计数历史作者',
                              '计数历史作者', 100, ?, ?, ?)
                            """,
                            ("https://www.douyin.com/user/count-history-author", now, now, now),
                        ).lastrowid
                    )
                    for index in range(100):
                        connection.execute(
                            """
                            INSERT INTO links(
                              profile_id, aweme_id, kind, url, status, discovered_at, last_seen_at
                            ) VALUES(?, ?, 'video', ?, 'downloaded', ?, ?)
                            """,
                            (profile_id, f"history-{index}", f"https://www.douyin.com/video/history-{index}", now, now),
                        )
                    connection.commit()

                probe_script = f"""
import json
from manager_core.database import db
from manager_core.profile_collection_history import record_profile_collection

profile_id = {profile_id}
results = []
results.append(record_profile_collection(
    profile_id, job_id=None, full_scan=False, full_scan_confirmed=False,
    seen_count=100, inserted_count=0, existing_count=100,
    started_at={now!r}, message="baseline"
))
with db() as connection:
    connection.execute("UPDATE profiles SET aweme_count=72 WHERE id=?", (profile_id,))
results.append(record_profile_collection(
    profile_id, job_id=None, full_scan=False, full_scan_confirmed=False,
    seen_count=72, inserted_count=0, existing_count=72,
    started_at={now!r}, message="drop"
))
results.append(record_profile_collection(
    profile_id, job_id=None, full_scan=True, full_scan_confirmed=True,
    seen_count=72, inserted_count=0, existing_count=72,
    started_at={now!r}, message="reconciled"
))
results.append(record_profile_collection(
    profile_id, job_id=None, full_scan=False, full_scan_confirmed=False,
    seen_count=72, inserted_count=0, existing_count=72,
    started_at={now!r}, message="same count"
))
with db() as connection:
    connection.execute("UPDATE profiles SET aweme_count=60 WHERE id=?", (profile_id,))
results.append(record_profile_collection(
    profile_id, job_id=None, full_scan=False, full_scan_confirmed=False,
    seen_count=60, inserted_count=0, existing_count=60,
    started_at={now!r}, message="new drop"
))
with db() as connection:
    profile = dict(connection.execute(
        "SELECT full_scan_required, full_scan_reason, last_full_scan_aweme_count FROM profiles WHERE id=?",
        (profile_id,),
    ).fetchone())
    history_count = connection.execute(
        "SELECT COUNT(*) c FROM profile_collection_history WHERE profile_id=?",
        (profile_id,),
    ).fetchone()["c"]
print(json.dumps({{"results": results, "profile": profile, "history_count": history_count}}, ensure_ascii=False))
"""
                probe = subprocess.run(
                    [sys.executable, "-c", probe_script],
                    cwd=MODULE_DIR,
                    env=runtime.environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                )
                result = json.loads(probe.stdout.strip())
                self.assertEqual(result["results"][0]["full_scan_required"], 0)
                self.assertEqual(result["results"][1]["previous_aweme_count"], 100)
                self.assertEqual(result["results"][1]["count_drop"], 28)
                self.assertEqual(result["results"][1]["full_scan_required"], 1)
                self.assertEqual(result["results"][2]["full_scan_required"], 0)
                self.assertEqual(result["results"][3]["full_scan_required"], 0)
                self.assertEqual(result["results"][4]["previous_aweme_count"], 72)
                self.assertEqual(result["results"][4]["full_scan_required"], 1)
                self.assertEqual(result["profile"]["last_full_scan_aweme_count"], 72)
                self.assertIn("从上次采集 72 降到 60", result["profile"]["full_scan_reason"])
                self.assertEqual(result["history_count"], 5)

                profiles = runtime.json_request("/api/profiles?scope=all&q=count-history-author")
                self.assertEqual(profiles["profiles"][0]["full_scan_required"], 1)
                self.assertEqual(profiles["profiles"][0]["refresh_basis"], "full_scan_required")
                self.assertEqual(profiles["profiles"][0]["refresh_mode"], "full")
            finally:
                runtime.close()

    def test_smart_refresh_runs_pending_reconciliation_as_full_scan(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-pending-full-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                now = datetime.now(timezone.utc).isoformat(timespec="seconds")
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    profile_id = int(
                        connection.execute(
                            """
                            INSERT INTO profiles(
                              url, sec_uid, tab, title, aweme_count, full_scan_required,
                              full_scan_reason, full_scan_required_at,
                              created_at, updated_at, last_extracted_at
                            ) VALUES(?, 'pending-full-author', 'post', '待全量作者', 50, 1,
                              '测试骤降', ?, ?, ?, ?)
                            """,
                            ("https://www.douyin.com/user/pending-full-author", now, now, now, now),
                        ).lastrowid
                    )
                    connection.execute(
                        """
                        INSERT INTO links(
                          profile_id, aweme_id, kind, url, status, discovered_at, last_seen_at
                        ) VALUES(?, 'pending-full-work', 'video',
                          'https://www.douyin.com/video/pending-full-work', 'downloaded', ?, ?)
                        """,
                        (profile_id, now, now),
                    )
                    connection.commit()

                probe_script = """
import json
from manager_core import extraction
from manager_core.database import create_job, db, update_job

calls = []
def fake(job_id, url, max_items, scrolls, idle_rounds, headed, incremental_stop_existing, **kwargs):
    calls.append({
        "url": url,
        "max_items": max_items,
        "incremental_stop_existing": incremental_stop_existing,
        "full_scan": bool(kwargs.get("full_scan")),
    })
    update_job(job_id, status="complete", total=1, processed=1, success=1, failed=0, message="done")

extraction.run_extract_job = fake
job_id = create_job("refresh", "pending full test")
extraction.run_refresh_profiles_job(job_id, 0, [], 123, 10, 2, False, 12, False)
with db() as connection:
    row = dict(connection.execute("SELECT status, success FROM jobs WHERE id=?", (job_id,)).fetchone())
print(json.dumps({"calls": calls, "job": row}))
"""
                probe = subprocess.run(
                    [sys.executable, "-c", probe_script],
                    cwd=MODULE_DIR,
                    env=runtime.environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                )
                result = json.loads(probe.stdout.strip())
                self.assertEqual(result["calls"], [{
                    "url": "https://www.douyin.com/user/pending-full-author",
                    "max_items": 0,
                    "incremental_stop_existing": 0,
                    "full_scan": True,
                }])
                self.assertEqual(result["job"], {"status": "complete", "success": 1})
            finally:
                runtime.close()

    def test_batch_refresh_uses_full_scan_for_profiles_with_at_most_100_works(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-small-full-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                now = datetime.now(timezone.utc).isoformat(timespec="seconds")
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    profile_ids = []
                    for sec_uid, aweme_count in (("small-full-author", 100), ("large-quick-author", 101)):
                        profile_ids.append(
                            int(
                                connection.execute(
                                    """
                                    INSERT INTO profiles(
                                      url, sec_uid, tab, title, aweme_count,
                                      created_at, updated_at, last_extracted_at
                                    ) VALUES(?, ?, 'post', ?, ?, ?, ?, ?)
                                    """,
                                    (
                                        f"https://www.douyin.com/user/{sec_uid}",
                                        sec_uid,
                                        sec_uid,
                                        aweme_count,
                                        now,
                                        now,
                                        now,
                                    ),
                                ).lastrowid
                            )
                        )
                    connection.commit()

                probe_script = f"""
import json
from manager_core import extraction
from manager_core.database import create_job, update_job

calls = []
def fake(job_id, url, max_items, scrolls, idle_rounds, headed, incremental_stop_existing, **kwargs):
    calls.append({{
        "url": url,
        "max_items": max_items,
        "incremental_stop_existing": incremental_stop_existing,
        "full_scan": bool(kwargs.get("full_scan")),
    }})
    update_job(job_id, status="complete", total=1, processed=1, success=1, failed=0, message="done")

extraction.run_extract_job = fake
job_id = create_job("refresh", "small profile mode test")
extraction.run_refresh_profiles_job(job_id, 0, {profile_ids!r}, 123, 10, 2, False, 12, False)
print(json.dumps(calls))
"""
                probe = subprocess.run(
                    [sys.executable, "-c", probe_script],
                    cwd=MODULE_DIR,
                    env=runtime.environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                )
                result = json.loads(probe.stdout.strip())
                self.assertEqual(
                    result,
                    [
                        {
                            "url": "https://www.douyin.com/user/small-full-author",
                            "max_items": 0,
                            "incremental_stop_existing": 0,
                            "full_scan": True,
                        },
                        {
                            "url": "https://www.douyin.com/user/large-quick-author",
                            "max_items": 123,
                            "incremental_stop_existing": 12,
                            "full_scan": False,
                        },
                    ],
                )
            finally:
                runtime.close()

    def test_batch_refresh_continues_after_incremental_child_stop_signal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-refresh-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                now = "2026-07-20T12:00:00+08:00"
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    for sec_uid in ("batch-author-a", "batch-author-b"):
                        connection.execute(
                            """
                            INSERT INTO profiles(url, sec_uid, tab, title, created_at, updated_at)
                            VALUES(?, ?, 'post', ?, ?, ?)
                            """,
                            (f"https://www.douyin.com/user/{sec_uid}", sec_uid, sec_uid, now, now),
                        )
                    profile_ids = [
                        row[0]
                        for row in connection.execute(
                            "SELECT id FROM profiles WHERE sec_uid LIKE 'batch-author-%' ORDER BY id"
                        ).fetchall()
                    ]
                    connection.commit()

                probe_script = f"""
import json
from manager_core import extraction
from manager_core.database import create_job, db, update_job

calls = []

def fake(job_id, url, *args, **kwargs):
    calls.append(url)
    update_job(
        job_id,
        status="complete",
        total=1,
        processed=1,
        success=1,
        failed=0,
        message="incremental done",
    )
    extraction.extract_stop_event.set()

extraction.run_extract_job = fake
job_id = create_job("refresh", "test batch")
extraction.run_refresh_profiles_job(
    job_id,
    0,
    {profile_ids!r},
    0,
    10,
    2,
    False,
    12,
    False,
)
with db() as connection:
    row = connection.execute(
        "SELECT status, processed, success FROM jobs WHERE id=?",
        (job_id,),
    ).fetchone()
print(json.dumps({{
    "calls": len(calls),
    "status": row["status"],
    "processed": row["processed"],
    "success": row["success"],
}}))
"""
                probe = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        probe_script,
                    ],
                    cwd=MODULE_DIR,
                    env=runtime.environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                )
                result = json.loads(probe.stdout.strip())
                self.assertEqual(result, {"calls": 2, "status": "complete", "processed": 2, "success": 2})
            finally:
                runtime.close()

    def test_batch_refresh_only_runs_profiles_due_by_posting_frequency(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-smart-refresh-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                now_timestamp = int(time.time())
                now = datetime.fromtimestamp(now_timestamp, timezone.utc).isoformat(timespec="seconds")
                due_last_extracted = datetime.fromtimestamp(
                    now_timestamp - 2 * 24 * 60 * 60,
                    timezone.utc,
                ).isoformat(timespec="seconds")
                waiting_last_extracted = datetime.fromtimestamp(
                    now_timestamp - 60 * 60,
                    timezone.utc,
                ).isoformat(timespec="seconds")
                with closing(sqlite3.connect(runtime.db_path)) as connection:
                    profile_ids: dict[str, int] = {}
                    for name, last_extracted_at, account_status in (
                        ("smart-due", due_last_extracted, "active"),
                        ("smart-waiting", waiting_last_extracted, "active"),
                        ("smart-banned", due_last_extracted, "banned"),
                    ):
                        cursor = connection.execute(
                            """
                            INSERT INTO profiles(
                              url, sec_uid, tab, title, account_status,
                              created_at, updated_at, last_extracted_at
                            )
                            VALUES(?, ?, 'post', ?, ?, ?, ?, ?)
                            """,
                            (
                                f"https://www.douyin.com/user/{name}",
                                name,
                                name,
                                account_status,
                                now,
                                now,
                                last_extracted_at,
                            ),
                        )
                        profile_ids[name] = int(cursor.lastrowid)
                    work_times = {
                        "smart-due": [now_timestamp - 3 * 24 * 60 * 60, now_timestamp - 4 * 24 * 60 * 60],
                        "smart-waiting": [now_timestamp - 2 * 60 * 60, now_timestamp - 26 * 60 * 60],
                        "smart-banned": [now_timestamp - 3 * 24 * 60 * 60, now_timestamp - 4 * 24 * 60 * 60],
                    }
                    for name, timestamps in work_times.items():
                        for index, create_time in enumerate(timestamps, start=1):
                            connection.execute(
                                """
                                INSERT INTO links(
                                  profile_id, aweme_id, kind, url, create_time,
                                  status, discovered_at, last_seen_at
                                )
                                VALUES(?, ?, 'video', ?, ?, 'downloaded', ?, ?)
                                """,
                                (
                                    profile_ids[name],
                                    f"{name}-{index}",
                                    f"https://www.douyin.com/video/{name}-{index}",
                                    create_time,
                                    now,
                                    now,
                                ),
                            )
                    connection.commit()

                probe_script = """
import json
from manager_core import extraction
from manager_core.database import create_job, db, update_job

calls = []

def fake(job_id, url, *args, **kwargs):
    calls.append(url)
    update_job(
        job_id,
        status="complete",
        total=1,
        processed=1,
        success=1,
        failed=0,
        message="smart refresh done",
    )

extraction.run_extract_job = fake
job_id = create_job("refresh", "test smart batch")
extraction.run_refresh_profiles_job(
    job_id,
    0,
    [],
    0,
    10,
    2,
    False,
    12,
    False,
)
with db() as connection:
    row = connection.execute(
        "SELECT status, total, processed, success, message FROM jobs WHERE id=?",
        (job_id,),
    ).fetchone()
print(json.dumps({
    "calls": calls,
    "status": row["status"],
    "total": row["total"],
    "processed": row["processed"],
    "success": row["success"],
    "message": row["message"],
}))
"""
                probe = subprocess.run(
                    [sys.executable, "-c", probe_script],
                    cwd=MODULE_DIR,
                    env=runtime.environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                )
                result = json.loads(probe.stdout.strip())
                self.assertEqual(
                    result["calls"],
                    ["https://www.douyin.com/user/smart-due"],
                )
                self.assertEqual(result["status"], "complete")
                self.assertEqual(result["total"], 1)
                self.assertEqual(result["processed"], 1)
                self.assertEqual(result["success"], 1)
                self.assertIn("智能跳过 2 个", result["message"])
            finally:
                runtime.close()

    def test_database_initialization_is_idempotent_and_healthy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-db-") as temp:
            root = Path(temp)
            first = IsolatedManager(root)
            try:
                first.start()
                first.quit()
            finally:
                first.close()

            before = database_snapshot(first.db_path)
            self.assertEqual(before["integrity"], "ok")
            self.assertEqual(before["quick_check"], "ok")
            self.assertTrue(REQUIRED_TABLES.issubset(before["tables"]), before["tables"])
            self.assertTrue(REQUIRED_SETTINGS.issubset(before["settings"]), before["settings"].keys())
            with closing(sqlite3.connect(first.db_path)) as connection:
                connection.execute(
                    "INSERT INTO settings(key, value) VALUES(?, ?)",
                    ("characterization_sentinel", "preserve-me"),
                )
                connection.commit()

            second = IsolatedManager(root)
            try:
                second.start()
                state = second.json_request("/api/state")
                self.assertEqual(state["settings"].get("characterization_sentinel"), "preserve-me")
                second.quit()
            finally:
                second.close()

            after = database_snapshot(second.db_path)
            self.assertEqual(after["integrity"], "ok")
            self.assertEqual(after["quick_check"], "ok")
            self.assertEqual(after["tables"], before["tables"])
            self.assertEqual(after["schema"], before["schema"])
            self.assertEqual(after["settings"].get("characterization_sentinel"), "preserve-me")
            self.assertFalse(
                second.forbidden_fanhao_db_path.exists(),
                "manager initialization must stay isolated from the FanHao catalog database",
            )


if __name__ == "__main__":
    unittest.main()
