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
    "link_files",
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
    def test_isolated_http_contract_and_static_assets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-download-manager-http-") as temp:
            runtime = IsolatedManager(Path(temp))
            try:
                runtime.start()
                state = runtime.json_request("/api/state")
                self.assertTrue(REQUIRED_STATE_KEYS.issubset(state), state.keys())
                self.assertTrue(REQUIRED_SETTINGS.issubset(state["settings"]), state["settings"].keys())
                self.assertFalse(state["extract"]["active"])
                self.assertFalse(state["download"]["active"])
                self.assertEqual(Path(state["paths"]["database"]).resolve(), runtime.db_path.resolve())
                self.assertEqual(Path(state["paths"]["logs"]).resolve(), runtime.log_dir.resolve())

                profiles = runtime.json_request("/api/profiles")
                self.assertEqual(profiles.get("profiles"), [])
                self.assertEqual(profiles.get("total"), 0)
                links = runtime.json_request("/api/links")
                self.assertEqual(links.get("links"), [])
                self.assertEqual(links.get("total"), 0)

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
