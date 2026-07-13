from __future__ import annotations

import json
import hashlib
import mimetypes
import os
import random
import re
import shutil
import signal
import socket
import sqlite3
import string
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


FROZEN_BUILD = bool(getattr(sys, "frozen", False))
INSTALL_DIR = Path(sys.executable).resolve().parent if FROZEN_BUILD else Path(__file__).resolve().parent
BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)).resolve()
STATIC_DIR = BASE_DIR / "static"
APP_STATE_DIR = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    / "DouyinDownloadManager"
)
DEFAULT_PROJECT_ROOT = APP_STATE_DIR if FROZEN_BUILD else BASE_DIR.parents[3]
DEFAULT_DATA_DIR = APP_STATE_DIR / "data" if FROZEN_BUILD else BASE_DIR / "data"
DEFAULT_LOG_DIR = APP_STATE_DIR / "logs" if FROZEN_BUILD else BASE_DIR / "logs"
PROJECT_ROOT = Path(os.environ.get("FANHAO_PROJECT_ROOT", str(DEFAULT_PROJECT_ROOT))).resolve()
DATA_DIR = Path(os.environ.get("DOUYIN_MANAGER_DATA_DIR", str(DEFAULT_DATA_DIR))).resolve()
LOG_DIR = Path(os.environ.get("DOUYIN_MANAGER_LOG_DIR", str(DEFAULT_LOG_DIR))).resolve()
CONFIG_DIR = DATA_DIR / "configs"
DB_PATH = DATA_DIR / "douyin_downloads.sqlite"
FANHAO_DB_PATH = Path(
    os.environ.get(
        "FANHAO_SHORT_VIDEO_DB",
        str(PROJECT_ROOT / "data" / "short-videos.sqlite"),
    )
).resolve()
FANHAO_DIRECT_IMPORT = os.environ.get("FANHAO_DIRECT_IMPORT", "0" if FROZEN_BUILD else "1").lower() not in {
    "0",
    "false",
    "no",
    "off",
}

TEST_PROFILE_URL = (
    "https://www.douyin.com/user/MS4wLjABAAAA88rdHdXo8m0mJQ-FfcZnOvz73URJIwyHaAhS8KNhXj4"
    "?from_tab_name=main&vid=7646737901396451654"
)
DOWNLOADER_ROOT = Path(
    os.environ.get(
        "DOUYIN_DOWNLOADER_ROOT",
        str(INSTALL_DIR / "downloader" if FROZEN_BUILD else PROJECT_ROOT.parent / "Tool" / "douyin-downloader"),
    )
).resolve()
DOWNLOADER_EXE = DOWNLOADER_ROOT / "douyin-downloader.exe"
DOWNLOADER_PYTHON = DOWNLOADER_ROOT / ".venv" / "Scripts" / "python.exe"
DOWNLOADER_RUN = DOWNLOADER_ROOT / "run.py"
DEFAULT_COOKIE_FILE = (
    Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming")))
    / "douyin-downloader-desktop"
    / "custom-batch-douyin-cookies.txt"
)
NODE_EXECUTABLE = os.environ.get(
    "DOUYIN_MANAGER_NODE",
    str(INSTALL_DIR / "runtime" / "node.exe") if FROZEN_BUILD else "node",
)
DEFAULT_STORAGE_ROOT = Path(
    os.environ.get("FANHAO_SHORT_VIDEO_STORAGE_ROOT", r"D:\Media")
)
DEFAULT_OUTPUT_DIR = DEFAULT_STORAGE_ROOT
DEFAULT_LIBRARY_OUTPUT_DIR = DEFAULT_STORAGE_ROOT / "ShortVideos"
LIBRARY_SEC_UID = os.environ.get(
    "DOUYIN_LIBRARY_SEC_UID",
    "MS4wLjABAAAAqiW-0GYj4wFCXymqQZsgY3mF5z4cZWUopJqTUkmYx20",
)

MAX_CONCURRENCY = 24
DEFAULT_FAILURE_GUARD_THRESHOLD = 10
FAILURE_GUARD_COOLDOWN_SECONDS = 3600
DOWNLOAD_QUEUE_ORDER = """
CASE WHEN create_time IS NULL THEN 1 ELSE 0 END,
create_time DESC,
last_seen_at DESC,
id DESC
"""

extract_lock = threading.Lock()
fanhao_import_lock = threading.Lock()
extract_thread: threading.Thread | None = None
extract_job_id: int | None = None
extract_process: subprocess.Popen[Any] | None = None
extract_stop_event = threading.Event()
cookie_login_lock = threading.Lock()
cookie_login_process: subprocess.Popen[Any] | None = None
cookie_login_state: dict[str, Any] = {
    "status": "idle",
    "message": "",
    "started_at": "",
    "finished_at": "",
}
download_timing_lock = threading.Lock()
GALLERY_MUSIC_INTENT = "gallery_music"
DOWNLOAD_GUARD_STATE_SETTING = "download_guard_state"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def downloader_command(args: list[str]) -> tuple[list[str], Path]:
    if DOWNLOADER_EXE.exists():
        return [str(DOWNLOADER_EXE), *args], DOWNLOADER_ROOT
    python_exe = Path(setting("downloader_python", str(DOWNLOADER_PYTHON)))
    run_py = Path(setting("downloader_run", str(DOWNLOADER_RUN)))
    repo_root = Path(setting("downloader_root", str(DOWNLOADER_ROOT)))
    if not python_exe.exists() or not run_py.exists():
        raise RuntimeError("下载器路径不存在，请检查设置")
    return [str(python_exe), str(run_py), *args], repo_root


def iso_from_timestamp(value: float | None) -> str:
    if not value:
        return ""
    return datetime.fromtimestamp(value, timezone.utc).astimezone().isoformat(timespec="seconds")


def elapsed_ms(started: float | None) -> int | None:
    if started is None:
        return None
    return int((time.monotonic() - started) * 1000)


def download_timing(event: str, **fields: Any) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        record = {"ts": now_iso(), "event": event, **fields}
        path = LOG_DIR / f"download-timing-{datetime.now().strftime('%Y%m%d')}.jsonl"
        with download_timing_lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, default=str))
                handle.write("\n")
    except Exception:
        pass


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS profiles (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              url TEXT NOT NULL UNIQUE,
              sec_uid TEXT,
              tab TEXT NOT NULL DEFAULT 'post',
              title TEXT,
              uid TEXT,
              nickname TEXT,
              avatar_url TEXT,
              unique_id TEXT,
              short_id TEXT,
              signature TEXT,
              ip_location TEXT,
              following_count INTEGER,
              follower_count INTEGER,
              total_favorited INTEGER,
              aweme_count INTEGER,
              favoriting_count INTEGER,
              gender INTEGER,
              age INTEGER,
              verification TEXT,
              profile_raw_json TEXT NOT NULL DEFAULT '{}',
              profile_collected_at TEXT,
              is_following INTEGER NOT NULL DEFAULT 0,
              following_discovered_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              last_extracted_at TEXT,
              UNIQUE(sec_uid, tab)
            );
            CREATE TABLE IF NOT EXISTS links (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
              aweme_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              url TEXT NOT NULL,
              author_uid TEXT,
              author_sec_uid TEXT,
              author_nickname TEXT,
              author_avatar_url TEXT,
              author_url TEXT,
              desc TEXT,
              cover_url TEXT,
              create_time INTEGER,
              duration_ms INTEGER,
              digg_count INTEGER,
              comment_count INTEGER,
              share_count INTEGER,
              collect_count INTEGER,
              media_type TEXT,
              local_file_names TEXT,
              local_file_paths TEXT,
              preview_path TEXT,
              metadata_json TEXT,
              download_intent TEXT,
              gallery_music_status TEXT,
              gallery_music_checked_at TEXT,
              music_id TEXT,
              music_title TEXT,
              music_author TEXT,
              music_cover_url TEXT,
              music_play_url TEXT,
              local_music_path TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0,
              discovered_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              last_started_at TEXT,
              downloaded_at TEXT,
              failed_at TEXT,
              output_dir TEXT,
              last_error TEXT,
              UNIQUE(profile_id, aweme_id)
            );
            CREATE INDEX IF NOT EXISTS idx_links_status ON links(status, id);
            CREATE INDEX IF NOT EXISTS idx_links_profile ON links(profile_id, id);
            CREATE INDEX IF NOT EXISTS idx_links_aweme ON links(aweme_id);
            CREATE TABLE IF NOT EXISTS jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL,
              status TEXT NOT NULL,
              profile_id INTEGER,
              total INTEGER NOT NULL DEFAULT 0,
              processed INTEGER NOT NULL DEFAULT 0,
              success INTEGER NOT NULL DEFAULT 0,
              failed INTEGER NOT NULL DEFAULT 0,
              message TEXT,
              started_at TEXT NOT NULL,
              finished_at TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TEXT NOT NULL,
              level TEXT NOT NULL,
              message TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS profile_download_queue (
              profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
              sort_order INTEGER NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_profile_download_queue_order
              ON profile_download_queue(enabled, sort_order, profile_id);
            """
        )
        migrate_links_profile_scope(conn)
        migrate_profiles_tabs(conn)
        migrate_profile_metadata_columns(conn)
        migrate_link_author_columns(conn)
        migrate_link_preview_columns(conn)
        migrate_link_files(conn)
        defaults = {
            "profile_url": TEST_PROFILE_URL,
            "profile_tab": "auto",
            "output_dir": str(DEFAULT_OUTPUT_DIR),
            "library_output_dir": str(DEFAULT_LIBRARY_OUTPUT_DIR),
            "concurrency": "8",
            "scrolls": "12000",
            "idle_rounds": "160",
            "incremental_stop_existing": "12",
            "profile_refresh_recent_days": "30",
            "download_cycle_limit": "350",
            "download_cycle_cooldown_minutes": "30",
            "failure_guard_threshold": str(DEFAULT_FAILURE_GUARD_THRESHOLD),
            "cookie_file": str(DEFAULT_COOKIE_FILE),
            "download_proxy": "",
            "downloader_root": str(DOWNLOADER_ROOT),
            "downloader_python": str(DOWNLOADER_PYTHON),
            "downloader_run": str(DOWNLOADER_RUN),
        }
        for key, value in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
                (key, value),
            )
        conn.execute(
            "UPDATE links SET status='pending', last_error='上次程序退出时仍在下载，已重置为待下载' "
            "WHERE status='downloading'"
        )
        conn.execute(
            "UPDATE jobs SET status='stopped', finished_at=?, message='服务重启，任务已停止' "
            "WHERE status='running'",
            (now_iso(),),
        )
        seed_download_queue(conn)


def migrate_profiles_tabs(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(profiles)").fetchall()}
    if "sec_uid" not in columns:
        conn.execute("ALTER TABLE profiles ADD COLUMN sec_uid TEXT")
    if "tab" not in columns:
        conn.execute("ALTER TABLE profiles ADD COLUMN tab TEXT NOT NULL DEFAULT 'post'")
    rows = conn.execute("SELECT id, url FROM profiles").fetchall()
    for row in rows:
        parsed = parse_profile_url(row["url"])
        conn.execute(
            "UPDATE profiles SET sec_uid=COALESCE(sec_uid, ?), tab=COALESCE(NULLIF(tab, ''), ?) WHERE id=?",
            (parsed["sec_uid"], parsed["tab"], row["id"]),
        )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_sec_tab ON profiles(sec_uid, tab)")


def migrate_profile_metadata_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(profiles)").fetchall()}
    specs = {
        "uid": "TEXT",
        "nickname": "TEXT",
        "avatar_url": "TEXT",
        "unique_id": "TEXT",
        "short_id": "TEXT",
        "signature": "TEXT",
        "ip_location": "TEXT",
        "following_count": "INTEGER",
        "follower_count": "INTEGER",
        "total_favorited": "INTEGER",
        "aweme_count": "INTEGER",
        "favoriting_count": "INTEGER",
        "gender": "INTEGER",
        "age": "INTEGER",
        "verification": "TEXT",
        "profile_raw_json": "TEXT NOT NULL DEFAULT '{}'",
        "profile_collected_at": "TEXT",
        "is_following": "INTEGER NOT NULL DEFAULT 0",
        "following_discovered_at": "TEXT",
    }
    for name, definition in specs.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE profiles ADD COLUMN {name} {definition}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_profiles_uid ON profiles(uid)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_profiles_unique_id ON profiles(unique_id)")


def migrate_link_author_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(links)").fetchall()}
    for name in ("author_uid", "author_sec_uid", "author_nickname", "author_avatar_url", "author_url"):
        if name not in columns:
            conn.execute(f"ALTER TABLE links ADD COLUMN {name} TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_links_author_sec_uid ON links(author_sec_uid)")


def migrate_link_preview_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(links)").fetchall()}
    specs = {
        "desc": "TEXT",
        "cover_url": "TEXT",
        "create_time": "INTEGER",
        "duration_ms": "INTEGER",
        "digg_count": "INTEGER",
        "comment_count": "INTEGER",
        "share_count": "INTEGER",
        "collect_count": "INTEGER",
        "media_type": "TEXT",
        "local_file_names": "TEXT",
        "local_file_paths": "TEXT",
        "local_cover_path": "TEXT",
        "preview_path": "TEXT",
        "metadata_json": "TEXT",
        "failed_at": "TEXT",
        "download_intent": "TEXT",
        "gallery_music_status": "TEXT",
        "gallery_music_checked_at": "TEXT",
        "music_id": "TEXT",
        "music_title": "TEXT",
        "music_author": "TEXT",
        "music_cover_url": "TEXT",
        "music_play_url": "TEXT",
        "local_music_path": "TEXT",
    }
    for name, column_type in specs.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE links ADD COLUMN {name} {column_type}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_links_create_time ON links(create_time)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_links_media_type ON links(media_type)")


def migrate_link_files(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS link_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
          profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
          aweme_id TEXT NOT NULL,
          role TEXT NOT NULL,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          absolute_path TEXT,
          size_bytes INTEGER,
          exists_on_disk INTEGER NOT NULL DEFAULT 0,
          recorded_at TEXT NOT NULL,
          UNIQUE(profile_id, aweme_id, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_link_files_link ON link_files(link_id);
        CREATE INDEX IF NOT EXISTS idx_link_files_aweme ON link_files(profile_id, aweme_id);
        CREATE INDEX IF NOT EXISTS idx_link_files_role ON link_files(role);
        """
    )


def migrate_links_profile_scope(conn: sqlite3.Connection) -> None:
    create_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='links'"
    ).fetchone()
    links_sql = (create_sql["sql"] if create_sql else "") or ""
    if "UNIQUE(profile_id, aweme_id)" in links_sql:
        return
    if "aweme_id TEXT NOT NULL UNIQUE" not in links_sql and "url TEXT NOT NULL UNIQUE" not in links_sql:
        return

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS links_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
          aweme_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          url TEXT NOT NULL,
          author_uid TEXT,
          author_sec_uid TEXT,
          author_nickname TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          discovered_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          last_started_at TEXT,
          downloaded_at TEXT,
          failed_at TEXT,
          output_dir TEXT,
          last_error TEXT,
          UNIQUE(profile_id, aweme_id)
        );
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO links_new(
          id, profile_id, aweme_id, kind, url, status, attempts, discovered_at,
          last_seen_at, last_started_at, downloaded_at, failed_at, output_dir, last_error
        )
        SELECT
          id, profile_id, aweme_id, kind, url, status, attempts, discovered_at,
          last_seen_at, last_started_at, downloaded_at, NULL, output_dir, last_error
        FROM links
        """
    )
    conn.executescript(
        """
        DROP TABLE links;
        ALTER TABLE links_new RENAME TO links;
        CREATE INDEX IF NOT EXISTS idx_links_status ON links(status, id);
        CREATE INDEX IF NOT EXISTS idx_links_profile ON links(profile_id, id);
        CREATE INDEX IF NOT EXISTS idx_links_aweme ON links(aweme_id);
        """
    )
    conn.execute(
        "INSERT INTO events(ts, level, message) VALUES(?, 'info', '数据库已迁移为按主页分组的链接表')",
        (now_iso(),),
    )


def setting(key: str, default: str = "") -> str:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def failure_guard_threshold() -> int:
    return normalize_int(
        setting("failure_guard_threshold", str(DEFAULT_FAILURE_GUARD_THRESHOLD)),
        DEFAULT_FAILURE_GUARD_THRESHOLD,
        0,
        1000,
    )


def download_cycle_limit() -> int:
    return normalize_int(setting("download_cycle_limit", "350"), 350, 0, 1000000)


def download_cycle_cooldown_seconds() -> int:
    minutes = normalize_int(setting("download_cycle_cooldown_minutes", "30"), 30, 1, 1440)
    return minutes * 60


def is_antibot_error(error: str) -> bool:
    text = str(error or "").lower()
    return any(
        marker in text
        for marker in (
            "anti-bot",
            "empty 200",
            "风控",
            "平台保护",
        )
    )


def add_event(level: str, message: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO events(ts, level, message) VALUES(?, ?, ?)",
            (now_iso(), level, message),
        )
        conn.execute(
            "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 1000)"
        )


def create_job(kind: str, message: str = "", profile_id: int | None = None) -> int:
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO jobs(type, status, profile_id, message, started_at) VALUES(?, 'running', ?, ?, ?)",
            (kind, profile_id, message, now_iso()),
        )
        return int(cur.lastrowid)


def update_job(job_id: int, **fields: Any) -> None:
    if not fields:
        return
    names = []
    values = []
    for key, value in fields.items():
        names.append(f"{key}=?")
        values.append(value)
    values.append(job_id)
    with db() as conn:
        conn.execute(f"UPDATE jobs SET {', '.join(names)} WHERE id=?", values)


def normalize_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(min_value, min(max_value, parsed))


def normalize_proxy(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if "://" not in text:
        text = f"http://{text}"
    return text


def normalize_profile_tab(value: Any) -> str:
    tab = str(value or "auto").strip().lower()
    return tab if tab in {"auto", "like", "post"} else "auto"


def parse_profile_url(url: str, profile_tab: Any = "auto") -> dict[str, str]:
    raw = (url or "").strip()
    selected_tab = normalize_profile_tab(profile_tab)
    try:
        parsed = urlparse(raw)
        path_match = re.search(r"/user/([^/?#]+)", parsed.path)
        sec_uid = path_match.group(1) if path_match else raw
        query = parse_qs(parsed.query)
        show_tab = (query.get("showTab") or [""])[0].lower()
        tab = selected_tab if selected_tab in {"like", "post"} else ("like" if show_tab == "like" else "post")
        canonical = f"https://www.douyin.com/user/{sec_uid}"
        if tab == "like":
            canonical += "?showTab=like"
        return {
            "sec_uid": sec_uid,
            "tab": tab,
            "url": canonical,
            "raw_url": raw,
        }
    except Exception:
        return {
            "sec_uid": raw,
            "tab": selected_tab if selected_tab in {"like", "post"} else "post",
            "url": raw,
            "raw_url": raw,
        }


def tab_label(tab: str) -> str:
    return {"like": "喜欢", "post": "作品"}.get(tab, tab or "作品")


def work_id_from_url(url: str) -> str | None:
    match = re.search(r"/(?:video|note|gallery|slides)/(\d{16,22})(?:\D|$)", url or "")
    return match.group(1) if match else None


def safe_path_segment(value: str) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", (value or "").strip())
    text = text.rstrip(" .")
    return text[:120] or "unknown"


def profile_output_dir(base_output_dir: str, profile_id: int) -> str:
    try:
        custom = setting("library_output_dir", "")
    except sqlite3.Error:
        custom = ""
    if custom.strip():
        return str(Path(custom).expanduser())
    base = Path(base_output_dir)
    # 文件只存一份；“我的喜欢 / 作者作品”是数据库关系，不再靠目录区分。
    return str(base / "likes" / safe_path_segment(LIBRARY_SEC_UID))


def manifest_has(output_dir: str, aweme_id: str) -> bool:
    return manifest_record(output_dir, aweme_id) is not None


def json_value(value: Any, fallback: Any = None) -> Any:
    if value in ("", None):
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def manifest_record(output_dir: str, aweme_id: str) -> dict[str, Any] | None:
    manifest = Path(output_dir) / "download_manifest.jsonl"
    if not manifest.exists():
        return None
    found: dict[str, Any] | None = None
    try:
        # A sidecar can be terminated while appending, leaving one partial UTF-8
        # line behind. Keep valid manifest records usable instead of blocking the
        # entire download queue on that damaged tail.
        with manifest.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if aweme_id not in line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(row.get("aweme_id")) == str(aweme_id):
                    found = row
    except OSError:
        return None
    return found


def downloaded_record_from_link(row: sqlite3.Row) -> tuple[str, dict[str, Any]] | None:
    aweme_id = row_text(row, "aweme_id")
    output_dir = row_text(row, "output_dir")
    if not aweme_id or not output_dir:
        return None
    record = manifest_record(output_dir, aweme_id)
    if record:
        return output_dir, record

    paths = flatten_strings(json_value(row_text(row, "local_file_paths"), []))
    if not paths:
        return None
    if not first_existing_manifest_file(output_dir, paths, {"video", "image"}):
        return None
    names = flatten_strings(json_value(row_text(row, "local_file_names"), []))
    metadata = json_value(row_text(row, "metadata_json"), {})
    record = metadata if isinstance(metadata, dict) else {}
    record = dict(record)
    record.setdefault("aweme_id", aweme_id)
    record.setdefault("url", row_text(row, "url"))
    record.setdefault("desc", row_text(row, "desc"))
    record.setdefault("media_type", row_text(row, "media_type"))
    create_time = row_int(row, "create_time")
    if create_time is not None:
        record.setdefault("publish_timestamp", create_time)
    record["file_names"] = names
    record["file_paths"] = paths
    return output_dir, record


def existing_downloaded_work(aweme_id: str, exclude_link_id: int | None = None) -> dict[str, Any] | None:
    aweme_id = str(aweme_id or "").strip()
    if not aweme_id:
        return None
    with db() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM links
            WHERE aweme_id=?
              AND status='downloaded'
              AND id<>?
              AND COALESCE(output_dir, '') <> ''
            ORDER BY COALESCE(downloaded_at, '') DESC, id DESC
            LIMIT 24
            """,
            (aweme_id, int(exclude_link_id or 0)),
        ).fetchall()
    for row in rows:
        resolved = downloaded_record_from_link(row)
        if not resolved:
            continue
        output_dir, record = resolved
        return {
            "output_dir": output_dir,
            "record": record,
            "source_link_id": int(row["id"]),
            "source_profile_id": int(row["profile_id"] or 0),
        }
    return None


def manifest_preview_path(record: dict[str, Any]) -> str:
    paths = record.get("file_paths")
    if not isinstance(paths, list):
        return ""
    media_type = str(record.get("media_type") or "")
    suffix_groups = (
        (".mp4", ".mov", ".webm", ".m4v"),
        (".jpg", ".jpeg", ".png", ".webp", ".gif"),
    )
    if media_type == "gallery":
        suffix_groups = (suffix_groups[1], suffix_groups[0])
    for suffixes in suffix_groups:
        for path in paths:
            text = str(path or "")
            if text.lower().endswith(suffixes):
                return text
    return str(paths[0] or "") if paths else ""


def manifest_cover_path(record: dict[str, Any]) -> str:
    paths = record.get("file_paths")
    if not isinstance(paths, list):
        return ""
    image_suffixes = (".jpg", ".jpeg", ".png", ".webp", ".gif")
    for path in paths:
        text = str(path or "")
        name = Path(text).name.lower()
        if name.endswith(image_suffixes) and ("_cover." in name or "cover" in name):
            return text
    return ""


def file_kind(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext in {".mp4", ".mov", ".webm", ".m4v"}:
        return "video"
    if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return "image"
    if ext in {".mp3", ".m4a", ".aac", ".wav", ".flac"}:
        return "audio"
    if ext == ".json":
        return "json"
    return "file"


def file_role(path: str) -> str:
    name = Path(path).name.lower()
    kind = file_kind(path)
    if kind == "json":
        return "metadata"
    if kind == "audio":
        return "music"
    if kind == "image" and ("_cover." in name or "cover" in name):
        return "cover"
    if kind == "image":
        return "image"
    if kind == "video":
        return "video"
    return "file"


def file_stat(output_dir: str | Path, path: str) -> tuple[str, int | None, int]:
    raw = Path(str(path))
    absolute = raw if raw.is_absolute() else Path(output_dir) / raw
    try:
        resolved = absolute.resolve()
        stat = resolved.stat()
        return str(resolved), int(stat.st_size), 1 if resolved.is_file() else 0
    except OSError:
        return str(absolute), None, 0


def manifest_file_rows(record: dict[str, Any], output_dir: str | Path) -> list[dict[str, Any]]:
    names = record.get("file_names")
    paths = record.get("file_paths")
    if not isinstance(paths, list):
        return []
    rows = []
    for index, raw_path in enumerate(paths):
        text = str(raw_path or "").strip()
        if not text:
            continue
        fallback_name = Path(text).name
        file_name = ""
        if isinstance(names, list) and index < len(names):
            file_name = str(names[index] or "")
        absolute_path, size_bytes, exists_on_disk = file_stat(output_dir, text)
        rows.append(
            {
                "role": file_role(text),
                "kind": file_kind(text),
                "file_name": file_name or fallback_name,
                "file_path": text,
                "absolute_path": absolute_path,
                "size_bytes": size_bytes,
                "exists_on_disk": exists_on_disk,
            }
        )
    return rows


def sync_manifest_files(
    conn: sqlite3.Connection,
    profile_id: int,
    aweme_id: str,
    output_dir: str | Path,
    record: dict[str, Any],
) -> int:
    link = conn.execute(
        "SELECT id FROM links WHERE profile_id=? AND aweme_id=?",
        (profile_id, aweme_id),
    ).fetchone()
    if not link:
        return 0
    ts = now_iso()
    link_id = int(link["id"])
    conn.execute(
        "DELETE FROM link_files WHERE profile_id=? AND aweme_id=?",
        (profile_id, aweme_id),
    )
    rows = manifest_file_rows(record, output_dir)
    for row in rows:
        conn.execute(
            """
            INSERT INTO link_files(
              link_id, profile_id, aweme_id, role, kind, file_name, file_path,
              absolute_path, size_bytes, exists_on_disk, recorded_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(profile_id, aweme_id, file_path) DO UPDATE SET
              link_id=excluded.link_id,
              role=excluded.role,
              kind=excluded.kind,
              file_name=excluded.file_name,
              absolute_path=excluded.absolute_path,
              size_bytes=excluded.size_bytes,
              exists_on_disk=excluded.exists_on_disk,
              recorded_at=excluded.recorded_at
            """,
            (
                link_id,
                profile_id,
                aweme_id,
                row["role"],
                row["kind"],
                row["file_name"],
                row["file_path"],
                row["absolute_path"],
                row["size_bytes"],
                row["exists_on_disk"],
                ts,
            ),
        )
    return len(rows)


def manifest_music_metadata(record: dict[str, Any] | None, output_dir: str | Path = "") -> dict[str, str]:
    if not isinstance(record, dict):
        return {
            "music_id": "",
            "music_title": "",
            "music_author": "",
            "music_cover_url": "",
            "music_play_url": "",
            "local_music_path": "",
        }
    music = record.get("music") if isinstance(record.get("music"), dict) else {}
    local_music_path = first_text(music.get("local_file_path"))
    if not local_music_path:
        local_music_path = next(
            (path for path in flatten_strings(record.get("file_paths")) if file_kind(path) == "audio"),
            "",
        )
    if local_music_path and output_dir:
        resolved = resolve_manifest_file(output_dir, local_music_path)
        try:
            local_music_path = str(resolved.resolve()) if resolved.is_file() else str(resolved)
        except OSError:
            local_music_path = str(resolved)
    return {
        "music_id": first_text(music.get("id_str"), music.get("mid"), music.get("id")),
        "music_title": first_text(music.get("title")),
        "music_author": first_text(music.get("author")),
        "music_cover_url": first_url_any(music.get("cover_medium"), music.get("cover_thumb")),
        "music_play_url": first_url(music.get("play_url")),
        "local_music_path": local_music_path,
    }


def manifest_has_gallery_music(record: dict[str, Any] | None) -> bool:
    return bool(manifest_music_metadata(record).get("local_music_path"))


def work_metadata_from_record(record: dict[str, Any], output_dir: str | Path = "") -> dict[str, Any]:
    publish_ts = int_or_none(record.get("publish_timestamp"))
    return {
        "desc": first_text(record.get("desc")),
        "media_type": first_text(record.get("media_type")),
        "create_time": publish_ts,
        "local_file_names": json_text(record.get("file_names")),
        "local_file_paths": json_text(record.get("file_paths")),
        "local_cover_path": manifest_cover_path(record),
        "preview_path": manifest_preview_path(record),
        "metadata_json": json_text(record),
        **manifest_music_metadata(record, output_dir),
    }


def manifest_work_metadata(output_dir: str, aweme_id: str) -> dict[str, Any]:
    record = manifest_record(output_dir, aweme_id)
    return work_metadata_from_record(record, output_dir) if record else {}


def row_text(row: sqlite3.Row | dict[str, Any], key: str) -> str:
    try:
        return first_text(row[key])
    except (KeyError, IndexError):
        return ""


def row_int(row: sqlite3.Row | dict[str, Any], key: str) -> int | None:
    try:
        return int_or_none(row[key])
    except (KeyError, IndexError):
        return None


def flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value] if value.strip() else []
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, list):
            out.extend(flatten_strings(item))
        elif isinstance(item, str) and item.strip():
            out.append(item.strip())
    return out


def resolve_manifest_file(output_dir: str | Path, file_path: str) -> Path:
    raw = Path(str(file_path))
    return raw if raw.is_absolute() else Path(output_dir) / raw


def first_existing_manifest_file(output_dir: str | Path, paths: list[str], kinds: set[str]) -> str:
    for file_path in paths:
        if file_kind(file_path) not in kinds:
            continue
        resolved = resolve_manifest_file(output_dir, file_path)
        try:
            if resolved.is_file():
                return str(resolved.resolve())
        except OSError:
            continue
    return ""


def first_manifest_cover(output_dir: str | Path, paths: list[str]) -> str:
    cover = ""
    for file_path in paths:
        if file_kind(file_path) != "image":
            continue
        name = Path(file_path).name.lower()
        if "_cover." in name or "cover" in name or "封面" in name:
            cover = file_path
            break
    if not cover:
        cover = next((p for p in paths if file_kind(p) == "image"), "")
    if not cover:
        return ""
    resolved = resolve_manifest_file(output_dir, cover)
    try:
        return str(resolved.resolve()) if resolved.is_file() else ""
    except OSError:
        return ""


def resolved_existing_manifest_image(output_dir: str | Path, file_path: str) -> str:
    if not file_path or file_kind(file_path) != "image":
        return ""
    resolved = resolve_manifest_file(output_dir, file_path)
    try:
        return str(resolved.resolve()) if resolved.is_file() else ""
    except OSError:
        return ""


def raw_metadata_object(record: dict[str, Any]) -> dict[str, Any]:
    raw = record.get("metadata")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def first_url(value: Any) -> str:
    if isinstance(value, str) and value.strip().lower().startswith(("http://", "https://")):
        return value.strip()
    if isinstance(value, dict):
        urls = value.get("url_list")
        if isinstance(urls, list):
            return first_text(*urls)
    if isinstance(value, list):
        for item in value:
            url = first_url(item)
            if url:
                return url
    return ""


def first_url_any(*values: Any) -> str:
    for value in values:
        url = first_url(value)
        if url:
            return url
    return ""


def douyin_video_url(aweme_id: Any) -> str:
    text = first_text(aweme_id)
    return f"https://www.douyin.com/video/{text}" if re.fullmatch(r"\d{8,}", text) else ""


def douyin_user_url(sec_uid: Any) -> str:
    text = first_text(sec_uid)
    return f"https://www.douyin.com/user/{text}" if text else ""


def iso_from_create_time(value: Any) -> str:
    ts = int_or_none(value)
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (OSError, OverflowError, ValueError):
        return ""


def fanhao_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", errors="replace")).hexdigest()


def fanhao_tags_from_text(text: str) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r"[#_＃]([^\s#_＃@，,。；;]+)", text or ""):
        tag = match.group(1).strip()
        key = tag.lower()
        if tag and len(tag) <= 30 and key not in seen:
            tags.append(tag)
            seen.add(key)
    return tags[:20]


def fanhao_author_id(sec_uid: str, uid: str, name: str) -> str:
    if sec_uid:
        return f"douyin:{sec_uid}"
    if uid:
        return f"douyin-uid:{uid}"
    return f"author:{fanhao_hash(name or 'unknown')[:18]}"


def fanhao_merge_sec_uid_aliases(conn: sqlite3.Connection, sec_uid: str, nickname: str) -> None:
    sec_uid = first_text(sec_uid)
    nickname = clean_profile_nickname(nickname)
    if not sec_uid or not nickname:
        return
    author_id = fanhao_author_id(sec_uid, "", nickname)
    rows = conn.execute(
        """
        SELECT id, sec_uid
        FROM short_video_users
        WHERE platform='douyin'
          AND sec_uid <> ''
          AND sec_uid <> ?
          AND ? LIKE sec_uid || '%'
          AND nickname=?
        """,
        (sec_uid, sec_uid, nickname),
    ).fetchall()
    for row in rows:
        old_sec_uid = first_text(row["sec_uid"])
        old_author_id = first_text(row["id"])
        if not old_sec_uid or len(sec_uid) - len(old_sec_uid) > 8:
            continue
        conn.execute(
            """
            UPDATE short_videos
            SET author_sec_uid=?,
                owner_user_id=CASE WHEN owner_user_id=? THEN ? ELSE owner_user_id END
            WHERE author_sec_uid=?
            """,
            (sec_uid, old_author_id, author_id, old_sec_uid),
        )
        conn.execute(
            "DELETE FROM short_video_users WHERE id=? AND sec_uid=?",
            (old_author_id, old_sec_uid),
        )


def fanhao_origin(profile_id: Any) -> str:
    try:
        pid = int(profile_id)
    except (TypeError, ValueError):
        pid = 0
    tab = ""
    if pid:
        try:
            with db() as conn:
                row = conn.execute("SELECT tab FROM profiles WHERE id=?", (pid,)).fetchone()
                tab = first_text(row["tab"]) if row else ""
        except sqlite3.Error:
            tab = ""
    return "douyin_download_manager_post" if tab == "post" else "douyin_download_manager_like"


def fanhao_upsert_source_membership(
    conn: sqlite3.Connection,
    aweme_id: str,
    profile_id: Any,
    origin: str,
    now: str,
    liked_at: str = "",
) -> None:
    source_type = "post" if origin == "douyin_download_manager_post" else "like"
    source_profile_id = str(profile_id or "")
    first_seen_at = first_text(liked_at, now) if source_type == "like" else now
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS short_video_source_memberships (
          aweme_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_profile_id TEXT NOT NULL DEFAULT '',
          first_seen_at TEXT NOT NULL DEFAULT '',
          last_seen_at TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(aweme_id, source_type, source_profile_id)
        )
        """
    )
    conn.execute(
        """
        INSERT INTO short_video_source_memberships (
          aweme_id, source_type, source_profile_id, first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(aweme_id, source_type, source_profile_id) DO UPDATE SET
          last_seen_at=excluded.last_seen_at,
          updated_at=excluded.updated_at
        """,
        (aweme_id, source_type, source_profile_id, first_seen_at, now, now),
    )
    if source_type == "like":
        conn.execute(
            """
            INSERT INTO short_video_user_actions (
              local_user_id, video_id, action_type, active, source, acted_at, updated_at
            ) VALUES ('local:self', ?, 'like', 1, 'download_manager', ?, ?)
            ON CONFLICT(local_user_id, video_id, action_type) DO UPDATE SET
              active=1,
              source=CASE
                WHEN short_video_user_actions.source='local_web' THEN short_video_user_actions.source
                ELSE 'download_manager'
              END,
              updated_at=excluded.updated_at
            """,
            (aweme_id, first_seen_at, now),
        )


def fanhao_upsert_link_placeholders(profile_id: int, works: list[dict[str, Any]]) -> None:
    if not FANHAO_DIRECT_IMPORT or not works or not FANHAO_DB_PATH.exists():
        return
    now = now_iso()
    origin = fanhao_origin(profile_id)
    default_liked_at = now if origin == "douyin_download_manager_like" else ""
    rows: list[dict[str, Any]] = []
    for work in works:
        aweme_id = first_text((work or {}).get("aweme_id"))
        if not aweme_id:
            continue
        desc = first_text(work.get("desc"), work.get("title"), work.get("caption"), aweme_id)
        title = first_text(desc.splitlines()[0] if desc else "", aweme_id)
        author_sec_uid = first_text(work.get("author_sec_uid"), work.get("authorSecUid"))
        author_uid = first_text(work.get("author_uid"), work.get("authorUid"))
        author_name = clean_profile_nickname(first_text(work.get("author_nickname"), work.get("authorNickname"), "未知作者"))
        author_avatar_url = first_text(work.get("author_avatar_url"), work.get("authorAvatarUrl"))
        author_url = first_text(work.get("author_url"), work.get("authorUrl"), douyin_user_url(author_sec_uid))
        create_time = int_or_none(work.get("create_time") or work.get("createTime"))
        cover_url = first_text(work.get("cover_url"), work.get("coverUrl"), work.get("thumbnail"), work.get("preview_url"))
        metadata = {
            "source": "douyin_download_manager_placeholder",
            "cover_url": cover_url,
            "profile_id": profile_id,
            "raw": work.get("metadata") if isinstance(work.get("metadata"), dict) else work,
        }
        rows.append(
            {
                "aweme_id": aweme_id,
                "author_sec_uid": author_sec_uid,
                "author_uid": author_uid,
                "author_name": author_name,
                "author_avatar_url": author_avatar_url,
                "author_url": author_url,
                "title": title,
                "desc": desc,
                "tags": fanhao_tags_from_text(desc),
                "create_time": create_time,
                "liked_at": first_text(work.get("_liked_at"), default_liked_at),
                "duration_ms": int_or_none(work.get("duration_ms") or work.get("duration") or work.get("durationMs")),
                "digg_count": int_or_none(work.get("digg_count") or work.get("diggCount") or work.get("like_count") or work.get("likeCount")) or 0,
                "comment_count": int_or_none(work.get("comment_count") or work.get("commentCount")) or 0,
                "collect_count": int_or_none(work.get("collect_count") or work.get("collectCount")) or 0,
                "share_count": int_or_none(work.get("share_count") or work.get("shareCount")) or 0,
                "share_url": first_text(work.get("url"), douyin_video_url(aweme_id)),
                "metadata_json": json_text(metadata) or "{}",
                "author_id": fanhao_author_id(author_sec_uid, author_uid, author_name),
            }
        )
    if not rows:
        return
    with fanhao_import_lock:
        try:
            conn = sqlite3.connect(FANHAO_DB_PATH, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA journal_mode=WAL")
            with conn:
                for row in rows:
                    fanhao_merge_sec_uid_aliases(conn, row["author_sec_uid"], row["author_name"])
                    conn.execute(
                        """
                        INSERT INTO short_video_users (
                          id, platform, sec_uid, uid, nickname, avatar_url, profile_url,
                          raw_json, created_at, updated_at
                        )
                        VALUES (?, 'douyin', ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                          sec_uid=COALESCE(NULLIF(excluded.sec_uid, ''), short_video_users.sec_uid),
                          uid=COALESCE(NULLIF(excluded.uid, ''), short_video_users.uid),
                          nickname=COALESCE(NULLIF(excluded.nickname, ''), short_video_users.nickname),
                          avatar_url=COALESCE(NULLIF(excluded.avatar_url, ''), short_video_users.avatar_url),
                          profile_url=COALESCE(NULLIF(excluded.profile_url, ''), short_video_users.profile_url),
                          raw_json=CASE WHEN excluded.raw_json <> '{}' THEN excluded.raw_json ELSE short_video_users.raw_json END,
                          updated_at=excluded.updated_at
                        """,
                        (
                            row["author_id"],
                            row["author_sec_uid"],
                            row["author_uid"],
                            row["author_name"],
                            row["author_avatar_url"],
                            row["author_url"],
                            json_text({"profileUrl": row["author_url"]}) or "{}",
                            now,
                            now,
                        ),
                    )
                    conn.execute(
                        """
                        INSERT INTO short_videos (
                          id, aweme_id, author_sec_uid, author_uid, author_name, author_avatar_url,
                          title, description, tags_json, tags_text, create_time, published_at, liked_at,
                          duration_ms, width, height, digg_count, comment_count, collect_count,
                          share_count, play_count, share_url, metadata_json, source_path, cover_path,
                          cover_source, music_path, data_path, relative_path, file_name, size_bytes,
                          mtime_ms, imported_at, updated_at, owner_user_id, origin, status, visibility
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0, ?, ?, '', '', '', '', '', '', '', 0, 0, ?, ?, ?, ?, 'pending', 'remote_pending')
                        ON CONFLICT(id) DO UPDATE SET
                          author_sec_uid=COALESCE(NULLIF(excluded.author_sec_uid, ''), short_videos.author_sec_uid),
                          author_uid=COALESCE(NULLIF(excluded.author_uid, ''), short_videos.author_uid),
                          author_name=COALESCE(NULLIF(excluded.author_name, ''), short_videos.author_name),
                          author_avatar_url=COALESCE(NULLIF(excluded.author_avatar_url, ''), short_videos.author_avatar_url),
                          title=COALESCE(NULLIF(excluded.title, ''), short_videos.title),
                          description=COALESCE(NULLIF(excluded.description, ''), short_videos.description),
                          tags_json=CASE WHEN excluded.tags_json <> '[]' THEN excluded.tags_json ELSE short_videos.tags_json END,
                          tags_text=COALESCE(NULLIF(excluded.tags_text, ''), short_videos.tags_text),
                          create_time=COALESCE(excluded.create_time, short_videos.create_time),
                          published_at=COALESCE(NULLIF(excluded.published_at, ''), short_videos.published_at),
                          liked_at=COALESCE(
                            NULLIF(short_videos.liked_at, ''),
                            (
                              SELECT MIN(NULLIF(action.acted_at, ''))
                              FROM short_video_user_actions action
                              WHERE action.video_id=short_videos.id
                                AND action.local_user_id='local:self'
                                AND action.action_type='like'
                                AND action.active=1
                            ),
                            (
                              SELECT MIN(NULLIF(membership.first_seen_at, ''))
                              FROM short_video_source_memberships membership
                              WHERE membership.aweme_id=short_videos.aweme_id
                                AND membership.source_type='like'
                            ),
                            NULLIF(excluded.liked_at, '')
                          ),
                          duration_ms=COALESCE(excluded.duration_ms, short_videos.duration_ms),
                          digg_count=COALESCE(excluded.digg_count, short_videos.digg_count),
                          comment_count=COALESCE(excluded.comment_count, short_videos.comment_count),
                          collect_count=COALESCE(excluded.collect_count, short_videos.collect_count),
                          share_count=COALESCE(excluded.share_count, short_videos.share_count),
                          share_url=COALESCE(NULLIF(excluded.share_url, ''), short_videos.share_url),
                          metadata_json=CASE
                            WHEN COALESCE(NULLIF(short_videos.source_path, ''), '') = '' THEN excluded.metadata_json
                            ELSE short_videos.metadata_json
                          END,
                          owner_user_id=COALESCE(NULLIF(excluded.owner_user_id, ''), short_videos.owner_user_id),
                          origin=CASE
                            WHEN short_videos.origin = 'douyin_download_manager_like'
                              AND excluded.origin = 'douyin_download_manager_post'
                              THEN short_videos.origin
                            WHEN excluded.origin = 'douyin_download_manager_like'
                              THEN excluded.origin
                            ELSE short_videos.origin
                          END,
                          status=CASE WHEN COALESCE(NULLIF(short_videos.source_path, ''), '') = '' THEN 'pending' ELSE short_videos.status END,
                          visibility=CASE WHEN COALESCE(NULLIF(short_videos.source_path, ''), '') = '' THEN 'remote_pending' ELSE short_videos.visibility END,
                          updated_at=excluded.updated_at
                        """,
                        (
                            row["aweme_id"],
                            row["aweme_id"],
                            row["author_sec_uid"],
                            row["author_uid"],
                            row["author_name"],
                            row["author_avatar_url"],
                            row["title"],
                            row["desc"],
                            json_text(row["tags"]) or "[]",
                            " ".join(row["tags"]),
                            row["create_time"],
                            iso_from_create_time(row["create_time"]),
                            row["liked_at"],
                            row["duration_ms"],
                            row["digg_count"],
                            row["comment_count"],
                            row["collect_count"],
                            row["share_count"],
                            row["share_url"],
                            row["metadata_json"],
                            now,
                            now,
                            row["author_id"],
                            origin,
                        ),
                    )
                    conn.execute(
                        """
                        INSERT INTO short_video_stats (
                          video_id, digg_count, comment_count, collect_count, share_count,
                          play_count, snapshot_at, updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                        ON CONFLICT(video_id) DO UPDATE SET
                          digg_count=excluded.digg_count,
                          comment_count=excluded.comment_count,
                          collect_count=excluded.collect_count,
                          share_count=excluded.share_count,
                          snapshot_at=excluded.snapshot_at,
                          updated_at=excluded.updated_at
                        """,
                        (
                            row["aweme_id"],
                            row["digg_count"],
                            row["comment_count"],
                            row["collect_count"],
                            row["share_count"],
                            now,
                            now,
                        ),
                    )
                    fanhao_upsert_source_membership(
                        conn, row["aweme_id"], profile_id, origin, now, row["liked_at"]
                    )
                if origin == "douyin_download_manager_like":
                    backfilled = conn.execute(
                        "SELECT value FROM short_video_meta WHERE key='download_manager_like_timestamp_backfilled_v1'"
                    ).fetchone()
                    if not backfilled:
                        conn.execute(
                            """
                            UPDATE short_videos AS video
                            SET liked_at=COALESCE(
                              (
                                SELECT MIN(NULLIF(action.acted_at, ''))
                                FROM short_video_user_actions action
                                WHERE action.video_id=video.id
                                  AND action.local_user_id='local:self'
                                  AND action.action_type='like'
                                  AND action.active=1
                              ),
                              (
                                SELECT MIN(NULLIF(membership.first_seen_at, ''))
                                FROM short_video_source_memberships membership
                                WHERE membership.aweme_id=video.aweme_id
                                  AND membership.source_type='like'
                              ),
                              liked_at
                            )
                            WHERE COALESCE(liked_at, '')=''
                              AND (
                                EXISTS (
                                  SELECT 1 FROM short_video_user_actions action
                                  WHERE action.video_id=video.id
                                    AND action.local_user_id='local:self'
                                    AND action.action_type='like'
                                    AND action.active=1
                                )
                                OR EXISTS (
                                  SELECT 1 FROM short_video_source_memberships membership
                                  WHERE membership.aweme_id=video.aweme_id
                                    AND membership.source_type='like'
                                )
                              )
                            """
                        )
                        conn.execute(
                            "INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_like_timestamp_backfilled_v1', ?)",
                            (now,),
                        )
                conn.execute(
                    "INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_placeholder_synced_at', ?)",
                    (now,),
                )
            conn.close()
        except sqlite3.Error as exc:
            add_event("warn", f"FanHao 占位入库失败: {str(exc)[:180]}")


def fanhao_upsert_asset(
    conn: sqlite3.Connection,
    video_id: str,
    asset_type: str,
    file_path: str,
    now: str,
) -> None:
    if not video_id or not asset_type or not file_path:
        return
    path_obj = Path(file_path)
    try:
        stat = path_obj.stat()
    except OSError:
        stat = None
    conn.execute(
        """
        INSERT INTO short_video_assets (
          id, video_id, asset_type, local_path, remote_url, file_name, file_hash,
          size_bytes, mime_type, codec, mtime_ms, imported_at, updated_at
        )
        VALUES (?, ?, ?, ?, '', ?, '', ?, ?, '', ?, ?, ?)
        ON CONFLICT(video_id, asset_type) DO UPDATE SET
          local_path=excluded.local_path,
          file_name=excluded.file_name,
          size_bytes=excluded.size_bytes,
          mime_type=excluded.mime_type,
          mtime_ms=excluded.mtime_ms,
          updated_at=excluded.updated_at
        """,
        (
            f"{video_id}:{asset_type}",
            video_id,
            asset_type,
            file_path,
            path_obj.name,
            int(stat.st_size) if stat else 0,
            mimetypes.guess_type(file_path)[0] or "",
            int(stat.st_mtime * 1000) if stat else 0,
            now,
            now,
        ),
    )


def fanhao_remove_generated_cover(file_path: str) -> None:
    if not file_path:
        return
    try:
        cache_dir = (FANHAO_DB_PATH.parent / "short-video-covers").resolve()
        target = Path(file_path).resolve()
        target.relative_to(cache_dir)
        target.unlink(missing_ok=True)
    except OSError:
        return
    except ValueError:
        return


def fanhao_cleanup_superseded_ffmpeg_cover(conn: sqlite3.Connection, video_id: str) -> None:
    if not video_id:
        return
    rows = conn.execute(
        """
        SELECT local_path
        FROM short_video_assets
        WHERE video_id=?
          AND asset_type='ffmpeg_cover'
          AND COALESCE(TRIM(local_path), '') <> ''
        """,
        (video_id,),
    ).fetchall()
    conn.execute(
        "DELETE FROM short_video_assets WHERE video_id=? AND asset_type='ffmpeg_cover'",
        (video_id,),
    )
    for row in rows:
        fanhao_remove_generated_cover(first_text(row["local_path"]))


def fanhao_row_value(row: sqlite3.Row, key: str, default: Any = None) -> Any:
    try:
        value = row[key]
    except (IndexError, KeyError):
        return default
    return default if value is None else value


def fanhao_safe_same_video_id(existing_id: str, incoming_id: str) -> bool:
    old_id = str(existing_id or "").strip()
    new_id = str(incoming_id or "").strip()
    if not old_id or not new_id:
        return True
    if not re.fullmatch(r"\d{8,}", old_id) or not re.fullmatch(r"\d{8,}", new_id):
        return True
    return old_id == new_id or old_id.startswith(new_id) or new_id.startswith(old_id)


def fanhao_merge_origin(keep_origin: str, duplicate_origin: str) -> str:
    keep = str(keep_origin or "").strip()
    duplicate = str(duplicate_origin or "").strip()
    if keep == "douyin_download_manager_like":
        return keep
    if duplicate == "douyin_download_manager_like":
        return duplicate
    return keep or duplicate or "local_import"


def fanhao_prune_source_path_duplicates(conn: sqlite3.Connection, source_path: str, keep_id: str) -> None:
    if not source_path or not keep_id:
        return
    rows = conn.execute(
        """
        SELECT id, aweme_id
        FROM short_videos
        WHERE source_path = ?
          AND id <> ?
        """,
        (source_path, keep_id),
    ).fetchall()
    for row in rows:
        existing_id = str(fanhao_row_value(row, "aweme_id") or fanhao_row_value(row, "id") or "").strip()
        if fanhao_safe_same_video_id(existing_id, keep_id):
            fanhao_merge_duplicate_video_row(conn, str(row["id"]), keep_id)


def fanhao_merge_duplicate_video_row(conn: sqlite3.Connection, duplicate_id: str, keep_id: str) -> None:
    if not duplicate_id or not keep_id or duplicate_id == keep_id:
        return
    duplicate = conn.execute("SELECT * FROM short_videos WHERE id=?", (duplicate_id,)).fetchone()
    keep = conn.execute("SELECT * FROM short_videos WHERE id=?", (keep_id,)).fetchone()
    if not duplicate or not keep:
        return
    now = now_iso()
    conn.execute(
        """
        UPDATE short_videos
        SET author_sec_uid=COALESCE(NULLIF(author_sec_uid, ''), ?),
            author_uid=COALESCE(NULLIF(author_uid, ''), ?),
            author_name=COALESCE(NULLIF(author_name, ''), ?),
            author_avatar_url=COALESCE(NULLIF(author_avatar_url, ''), ?),
            title=COALESCE(NULLIF(title, ''), ?),
            description=COALESCE(NULLIF(description, ''), ?),
            tags_json=CASE
              WHEN COALESCE(tags_json, '[]') IN ('', '[]') AND COALESCE(?, '[]') NOT IN ('', '[]') THEN ?
              ELSE tags_json
            END,
            tags_text=COALESCE(NULLIF(tags_text, ''), ?),
            create_time=COALESCE(create_time, ?),
            published_at=COALESCE(NULLIF(published_at, ''), ?),
            liked_at=CASE
              WHEN COALESCE(liked_at, '') = '' THEN ?
              WHEN COALESCE(?, '') <> '' AND ? > liked_at THEN ?
              ELSE liked_at
            END,
            duration_ms=COALESCE(duration_ms, ?),
            width=COALESCE(width, ?),
            height=COALESCE(height, ?),
            digg_count=MAX(COALESCE(digg_count, 0), ?),
            comment_count=MAX(COALESCE(comment_count, 0), ?),
            collect_count=MAX(COALESCE(collect_count, 0), ?),
            share_count=MAX(COALESCE(share_count, 0), ?),
            play_count=MAX(COALESCE(play_count, 0), ?),
            share_url=COALESCE(NULLIF(share_url, ''), ?),
            metadata_json=CASE
              WHEN COALESCE(metadata_json, '{}') IN ('', '{}') AND COALESCE(?, '{}') NOT IN ('', '{}') THEN ?
              ELSE metadata_json
            END,
            cover_path=CASE
              WHEN COALESCE(NULLIF(cover_path, ''), '') = '' AND COALESCE(?, '') <> '' THEN ?
              WHEN cover_source <> 'native' AND ? = 'native' AND COALESCE(?, '') <> '' THEN ?
              ELSE cover_path
            END,
            cover_source=CASE
              WHEN COALESCE(NULLIF(cover_source, ''), '') = '' AND COALESCE(?, '') <> '' THEN ?
              WHEN cover_source <> 'native' AND ? = 'native' THEN 'native'
              ELSE cover_source
            END,
            music_path=COALESCE(NULLIF(music_path, ''), ?),
            data_path=COALESCE(NULLIF(data_path, ''), ?),
            relative_path=COALESCE(NULLIF(relative_path, ''), ?),
            file_name=COALESCE(NULLIF(file_name, ''), ?),
            size_bytes=MAX(COALESCE(size_bytes, 0), ?),
            mtime_ms=MAX(COALESCE(mtime_ms, 0), ?),
            owner_user_id=COALESCE(NULLIF(owner_user_id, ''), ?),
            origin=?,
            status=CASE WHEN COALESCE(status, '') = '' THEN ? ELSE status END,
            visibility=CASE WHEN COALESCE(visibility, '') = '' THEN ? ELSE visibility END,
            updated_at=?
        WHERE id=?
        """,
        (
            fanhao_row_value(duplicate, "author_sec_uid", ""),
            fanhao_row_value(duplicate, "author_uid", ""),
            fanhao_row_value(duplicate, "author_name", ""),
            fanhao_row_value(duplicate, "author_avatar_url", ""),
            fanhao_row_value(duplicate, "title", ""),
            fanhao_row_value(duplicate, "description", ""),
            fanhao_row_value(duplicate, "tags_json", "[]"),
            fanhao_row_value(duplicate, "tags_json", "[]"),
            fanhao_row_value(duplicate, "tags_text", ""),
            fanhao_row_value(duplicate, "create_time"),
            fanhao_row_value(duplicate, "published_at", ""),
            fanhao_row_value(duplicate, "liked_at", ""),
            fanhao_row_value(duplicate, "liked_at", ""),
            fanhao_row_value(duplicate, "liked_at", ""),
            fanhao_row_value(duplicate, "liked_at", ""),
            fanhao_row_value(duplicate, "duration_ms"),
            fanhao_row_value(duplicate, "width"),
            fanhao_row_value(duplicate, "height"),
            int(fanhao_row_value(duplicate, "digg_count", 0) or 0),
            int(fanhao_row_value(duplicate, "comment_count", 0) or 0),
            int(fanhao_row_value(duplicate, "collect_count", 0) or 0),
            int(fanhao_row_value(duplicate, "share_count", 0) or 0),
            int(fanhao_row_value(duplicate, "play_count", 0) or 0),
            fanhao_row_value(duplicate, "share_url", ""),
            fanhao_row_value(duplicate, "metadata_json", "{}"),
            fanhao_row_value(duplicate, "metadata_json", "{}"),
            fanhao_row_value(duplicate, "cover_path", ""),
            fanhao_row_value(duplicate, "cover_path", ""),
            fanhao_row_value(duplicate, "cover_source", ""),
            fanhao_row_value(duplicate, "cover_path", ""),
            fanhao_row_value(duplicate, "cover_path", ""),
            fanhao_row_value(duplicate, "cover_source", ""),
            fanhao_row_value(duplicate, "cover_source", ""),
            fanhao_row_value(duplicate, "cover_source", ""),
            fanhao_row_value(duplicate, "music_path", ""),
            fanhao_row_value(duplicate, "data_path", ""),
            fanhao_row_value(duplicate, "relative_path", ""),
            fanhao_row_value(duplicate, "file_name", ""),
            int(fanhao_row_value(duplicate, "size_bytes", 0) or 0),
            int(fanhao_row_value(duplicate, "mtime_ms", 0) or 0),
            fanhao_row_value(duplicate, "owner_user_id", ""),
            fanhao_merge_origin(fanhao_row_value(keep, "origin", ""), fanhao_row_value(duplicate, "origin", "")),
            fanhao_row_value(duplicate, "status", "normal"),
            fanhao_row_value(duplicate, "visibility", "local_only"),
            now,
            keep_id,
        ),
    )
    fanhao_merge_duplicate_stats(conn, duplicate_id, keep_id, now)
    fanhao_merge_duplicate_assets(conn, duplicate_id, keep_id, now)
    fanhao_merge_duplicate_actions(conn, duplicate_id, keep_id, now)
    fanhao_merge_duplicate_collection_items(conn, duplicate_id, keep_id)
    fanhao_merge_duplicate_watch_history(conn, duplicate_id, keep_id)
    fanhao_merge_duplicate_import_items(conn, duplicate_id, keep_id)
    conn.execute("DELETE FROM short_videos WHERE id=?", (duplicate_id,))


def fanhao_merge_duplicate_stats(conn: sqlite3.Connection, duplicate_id: str, keep_id: str, now: str) -> None:
    duplicate = conn.execute("SELECT * FROM short_video_stats WHERE video_id=?", (duplicate_id,)).fetchone()
    if not duplicate:
        return
    keep = conn.execute("SELECT 1 FROM short_video_stats WHERE video_id=?", (keep_id,)).fetchone()
    if not keep:
        conn.execute("UPDATE short_video_stats SET video_id=?, updated_at=? WHERE video_id=?", (keep_id, now, duplicate_id))
        return
    conn.execute(
        """
        UPDATE short_video_stats
        SET digg_count=MAX(COALESCE(digg_count, 0), ?),
            comment_count=MAX(COALESCE(comment_count, 0), ?),
            collect_count=MAX(COALESCE(collect_count, 0), ?),
            share_count=MAX(COALESCE(share_count, 0), ?),
            play_count=MAX(COALESCE(play_count, 0), ?),
            snapshot_at=CASE WHEN COALESCE(?, '') > COALESCE(snapshot_at, '') THEN ? ELSE snapshot_at END,
            updated_at=?
        WHERE video_id=?
        """,
        (
            int(fanhao_row_value(duplicate, "digg_count", 0) or 0),
            int(fanhao_row_value(duplicate, "comment_count", 0) or 0),
            int(fanhao_row_value(duplicate, "collect_count", 0) or 0),
            int(fanhao_row_value(duplicate, "share_count", 0) or 0),
            int(fanhao_row_value(duplicate, "play_count", 0) or 0),
            fanhao_row_value(duplicate, "snapshot_at", ""),
            fanhao_row_value(duplicate, "snapshot_at", ""),
            now,
            keep_id,
        ),
    )
    conn.execute("DELETE FROM short_video_stats WHERE video_id=?", (duplicate_id,))


def fanhao_merge_duplicate_assets(conn: sqlite3.Connection, duplicate_id: str, keep_id: str, now: str) -> None:
    assets = conn.execute("SELECT * FROM short_video_assets WHERE video_id=?", (duplicate_id,)).fetchall()
    for asset in assets:
        asset_type = fanhao_row_value(asset, "asset_type", "")
        keep = conn.execute(
            "SELECT 1 FROM short_video_assets WHERE video_id=? AND asset_type=?",
            (keep_id, asset_type),
        ).fetchone()
        if not keep:
            conn.execute(
                "UPDATE short_video_assets SET id=?, video_id=?, updated_at=? WHERE id=?",
                (f"{keep_id}:{asset_type}", keep_id, now, fanhao_row_value(asset, "id", "")),
            )
            continue
        conn.execute(
            """
            UPDATE short_video_assets
            SET local_path=COALESCE(NULLIF(local_path, ''), ?),
                remote_url=COALESCE(NULLIF(remote_url, ''), ?),
                file_name=COALESCE(NULLIF(file_name, ''), ?),
                file_hash=COALESCE(NULLIF(file_hash, ''), ?),
                size_bytes=MAX(COALESCE(size_bytes, 0), ?),
                mime_type=COALESCE(NULLIF(mime_type, ''), ?),
                codec=COALESCE(NULLIF(codec, ''), ?),
                mtime_ms=MAX(COALESCE(mtime_ms, 0), ?),
                updated_at=?
            WHERE video_id=?
              AND asset_type=?
            """,
            (
                fanhao_row_value(asset, "local_path", ""),
                fanhao_row_value(asset, "remote_url", ""),
                fanhao_row_value(asset, "file_name", ""),
                fanhao_row_value(asset, "file_hash", ""),
                int(fanhao_row_value(asset, "size_bytes", 0) or 0),
                fanhao_row_value(asset, "mime_type", ""),
                fanhao_row_value(asset, "codec", ""),
                int(fanhao_row_value(asset, "mtime_ms", 0) or 0),
                now,
                keep_id,
                asset_type,
            ),
        )
        conn.execute("DELETE FROM short_video_assets WHERE id=?", (fanhao_row_value(asset, "id", ""),))


def fanhao_merge_duplicate_actions(conn: sqlite3.Connection, duplicate_id: str, keep_id: str, now: str) -> None:
    rows = conn.execute("SELECT * FROM short_video_user_actions WHERE video_id=?", (duplicate_id,)).fetchall()
    for row in rows:
        local_user_id = fanhao_row_value(row, "local_user_id", "")
        action_type = fanhao_row_value(row, "action_type", "")
        keep = conn.execute(
            """
            SELECT 1 FROM short_video_user_actions
            WHERE local_user_id=? AND video_id=? AND action_type=?
            """,
            (local_user_id, keep_id, action_type),
        ).fetchone()
        if not keep:
            conn.execute(
                """
                UPDATE short_video_user_actions
                SET video_id=?, updated_at=?
                WHERE local_user_id=? AND video_id=? AND action_type=?
                """,
                (keep_id, now, local_user_id, duplicate_id, action_type),
            )
            continue
        conn.execute(
            """
            UPDATE short_video_user_actions
            SET active=MAX(COALESCE(active, 0), ?),
                source=COALESCE(NULLIF(source, ''), ?),
                acted_at=CASE WHEN COALESCE(?, '') > COALESCE(acted_at, '') THEN ? ELSE acted_at END,
                updated_at=?
            WHERE local_user_id=?
              AND video_id=?
              AND action_type=?
            """,
            (
                int(fanhao_row_value(row, "active", 0) or 0),
                fanhao_row_value(row, "source", ""),
                fanhao_row_value(row, "acted_at", ""),
                fanhao_row_value(row, "acted_at", ""),
                now,
                local_user_id,
                keep_id,
                action_type,
            ),
        )
        conn.execute(
            """
            DELETE FROM short_video_user_actions
            WHERE local_user_id=? AND video_id=? AND action_type=?
            """,
            (local_user_id, duplicate_id, action_type),
        )


def fanhao_merge_duplicate_collection_items(conn: sqlite3.Connection, duplicate_id: str, keep_id: str) -> None:
    rows = conn.execute("SELECT * FROM short_video_collection_items WHERE video_id=?", (duplicate_id,)).fetchall()
    for row in rows:
        conn.execute(
            """
            INSERT OR IGNORE INTO short_video_collection_items (collection_id, video_id, added_at)
            VALUES (?, ?, ?)
            """,
            (fanhao_row_value(row, "collection_id", ""), keep_id, fanhao_row_value(row, "added_at", "")),
        )
        conn.execute(
            "DELETE FROM short_video_collection_items WHERE collection_id=? AND video_id=?",
            (fanhao_row_value(row, "collection_id", ""), duplicate_id),
        )


def fanhao_merge_duplicate_watch_history(conn: sqlite3.Connection, duplicate_id: str, keep_id: str) -> None:
    rows = conn.execute("SELECT * FROM short_video_watch_history WHERE video_id=?", (duplicate_id,)).fetchall()
    for row in rows:
        local_user_id = fanhao_row_value(row, "local_user_id", "")
        keep = conn.execute(
            "SELECT 1 FROM short_video_watch_history WHERE local_user_id=? AND video_id=?",
            (local_user_id, keep_id),
        ).fetchone()
        if not keep:
            conn.execute(
                "UPDATE short_video_watch_history SET video_id=? WHERE local_user_id=? AND video_id=?",
                (keep_id, local_user_id, duplicate_id),
            )
            continue
        conn.execute(
            """
            UPDATE short_video_watch_history
            SET progress_ms=MAX(COALESCE(progress_ms, 0), ?),
                completed_count=MAX(COALESCE(completed_count, 0), ?),
                last_watched_at=CASE WHEN COALESCE(?, '') > COALESCE(last_watched_at, '') THEN ? ELSE last_watched_at END
            WHERE local_user_id=?
              AND video_id=?
            """,
            (
                int(fanhao_row_value(row, "progress_ms", 0) or 0),
                int(fanhao_row_value(row, "completed_count", 0) or 0),
                fanhao_row_value(row, "last_watched_at", ""),
                fanhao_row_value(row, "last_watched_at", ""),
                local_user_id,
                keep_id,
            ),
        )
        conn.execute("DELETE FROM short_video_watch_history WHERE local_user_id=? AND video_id=?", (local_user_id, duplicate_id))


def fanhao_merge_duplicate_import_items(conn: sqlite3.Connection, duplicate_id: str, keep_id: str) -> None:
    rows = conn.execute("SELECT * FROM short_video_import_items WHERE video_id=?", (duplicate_id,)).fetchall()
    for row in rows:
        conn.execute(
            """
            INSERT OR IGNORE INTO short_video_import_items (batch_id, video_id, source_path, data_path, imported_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                fanhao_row_value(row, "batch_id", ""),
                keep_id,
                fanhao_row_value(row, "source_path", ""),
                fanhao_row_value(row, "data_path", ""),
                fanhao_row_value(row, "imported_at", ""),
            ),
        )
        conn.execute(
            "DELETE FROM short_video_import_items WHERE batch_id=? AND video_id=?",
            (fanhao_row_value(row, "batch_id", ""), duplicate_id),
        )


def fanhao_upsert_downloaded(link: sqlite3.Row, output_dir: str, record: dict[str, Any] | None) -> None:
    if not FANHAO_DIRECT_IMPORT or not record or not FANHAO_DB_PATH.exists():
        return
    paths = flatten_strings(record.get("file_paths"))
    media_type = first_text(row_text(link, "media_type"), record.get("media_type")).lower()
    is_gallery = media_type in {"gallery", "note", "image", "images"} or row_text(link, "kind").lower() == "note"
    source_path = first_existing_manifest_file(output_dir, paths, {"image"} if is_gallery else {"video"})
    if not source_path and is_gallery:
        source_path = first_existing_manifest_file(output_dir, paths, {"video"})
    if not source_path:
        return
    try:
        source_stat = Path(source_path).stat()
    except OSError:
        return

    raw = raw_metadata_object(record)
    raw_author = raw.get("author") if isinstance(raw.get("author"), dict) else {}
    raw_video = raw.get("video") if isinstance(raw.get("video"), dict) else {}
    raw_stats = raw.get("statistics") if isinstance(raw.get("statistics"), dict) else {}
    aweme_id = first_text(row_text(link, "aweme_id"), record.get("aweme_id"))
    if not aweme_id:
        return
    desc = first_text(row_text(link, "desc"), record.get("desc"), Path(source_path).stem)
    title = first_text(desc.splitlines()[0] if desc else "", aweme_id)
    create_time = row_int(link, "create_time") or int_or_none(record.get("publish_timestamp") or record.get("create_time"))
    author_sec_uid = first_text(row_text(link, "author_sec_uid"), record.get("author_sec_uid"), raw_author.get("sec_uid"), author_sec_uid_from_manifest(record))
    author_uid = first_text(row_text(link, "author_uid"), raw_author.get("uid"))
    author_name = first_text(row_text(link, "author_nickname"), record.get("author_name"), raw_author.get("nickname"), "未知作者")
    author_avatar_url = first_url_any(
        row_text(link, "author_avatar_url"),
        record.get("author_avatar_url"),
        raw_author.get("avatar_thumb"),
        raw_author.get("avatar_medium"),
        raw_author.get("avatar_larger"),
    )
    author_profile_url = first_text(row_text(link, "author_url"), record.get("author_url"), douyin_user_url(author_sec_uid))
    author_id = fanhao_author_id(author_sec_uid, author_uid, author_name)
    cover_path = resolved_existing_manifest_image(output_dir, row_text(link, "local_cover_path")) or first_manifest_cover(output_dir, paths)
    music_path = first_existing_manifest_file(output_dir, paths, {"audio"})
    data_path = first_existing_manifest_file(output_dir, paths, {"json"})
    now = now_iso()
    tags = fanhao_tags_from_text(desc)
    liked_at = first_text(row_text(link, "last_seen_at"), row_text(link, "downloaded_at"), now)
    relative_path = str(Path(source_path).relative_to(output_dir)) if str(source_path).startswith(str(Path(output_dir))) else source_path
    metadata_json = json_text(record) or "{}"

    with fanhao_import_lock:
        try:
            conn = sqlite3.connect(FANHAO_DB_PATH, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA journal_mode=WAL")
            with conn:
                fanhao_merge_sec_uid_aliases(conn, author_sec_uid, author_name)
                conn.execute(
                    """
                    INSERT INTO short_video_users (
                      id, platform, sec_uid, uid, nickname, avatar_url, profile_url, signature,
                      follower_count, following_count, raw_json, created_at, updated_at
                    )
                    VALUES (?, 'douyin', ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                      sec_uid=COALESCE(NULLIF(excluded.sec_uid, ''), short_video_users.sec_uid),
                      uid=COALESCE(NULLIF(excluded.uid, ''), short_video_users.uid),
                      nickname=COALESCE(NULLIF(excluded.nickname, ''), short_video_users.nickname),
                      avatar_url=COALESCE(NULLIF(excluded.avatar_url, ''), short_video_users.avatar_url),
                      profile_url=COALESCE(NULLIF(excluded.profile_url, ''), short_video_users.profile_url),
                      raw_json=CASE WHEN excluded.raw_json <> '{}' THEN excluded.raw_json ELSE short_video_users.raw_json END,
                      updated_at=excluded.updated_at
                    """,
                    (
                        author_id,
                        author_sec_uid,
                        author_uid,
                        author_name,
                        author_avatar_url,
                        author_profile_url,
                        json_text({"profileUrl": author_profile_url, "metadata": raw or record}) or "{}",
                        now,
                        now,
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO short_videos (
                      id, aweme_id, author_sec_uid, author_uid, author_name, author_avatar_url,
                      title, description, tags_json, tags_text, create_time, published_at, liked_at,
                      duration_ms, width, height, digg_count, comment_count, collect_count,
                      share_count, play_count, share_url, metadata_json, source_path, cover_path,
                      cover_source, music_path, data_path, relative_path, file_name, size_bytes,
                      mtime_ms, imported_at, updated_at, owner_user_id, origin, status, visibility
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 'local_only')
                    ON CONFLICT(id) DO UPDATE SET
                      aweme_id=excluded.aweme_id,
                      author_sec_uid=COALESCE(NULLIF(excluded.author_sec_uid, ''), short_videos.author_sec_uid),
                      author_uid=COALESCE(NULLIF(excluded.author_uid, ''), short_videos.author_uid),
                      author_name=COALESCE(NULLIF(excluded.author_name, ''), short_videos.author_name),
                      author_avatar_url=COALESCE(NULLIF(excluded.author_avatar_url, ''), short_videos.author_avatar_url),
                      title=excluded.title,
                      description=excluded.description,
                      tags_json=excluded.tags_json,
                      tags_text=excluded.tags_text,
                      create_time=COALESCE(excluded.create_time, short_videos.create_time),
                      published_at=COALESCE(NULLIF(excluded.published_at, ''), short_videos.published_at),
                      liked_at=COALESCE(NULLIF(excluded.liked_at, ''), short_videos.liked_at),
                      duration_ms=COALESCE(excluded.duration_ms, short_videos.duration_ms),
                      width=COALESCE(excluded.width, short_videos.width),
                      height=COALESCE(excluded.height, short_videos.height),
                      digg_count=MAX(COALESCE(short_videos.digg_count, 0), COALESCE(excluded.digg_count, 0)),
                      comment_count=MAX(COALESCE(short_videos.comment_count, 0), COALESCE(excluded.comment_count, 0)),
                      collect_count=MAX(COALESCE(short_videos.collect_count, 0), COALESCE(excluded.collect_count, 0)),
                      share_count=MAX(COALESCE(short_videos.share_count, 0), COALESCE(excluded.share_count, 0)),
                      play_count=MAX(COALESCE(short_videos.play_count, 0), COALESCE(excluded.play_count, 0)),
                      share_url=COALESCE(NULLIF(excluded.share_url, ''), short_videos.share_url),
                      metadata_json=excluded.metadata_json,
                      source_path=excluded.source_path,
                      cover_path=CASE
                        WHEN excluded.cover_source = 'native' AND NULLIF(excluded.cover_path, '') IS NOT NULL THEN excluded.cover_path
                        WHEN short_videos.cover_source = 'native' AND NULLIF(short_videos.cover_path, '') IS NOT NULL THEN short_videos.cover_path
                        WHEN NULLIF(excluded.cover_path, '') IS NOT NULL THEN excluded.cover_path
                        ELSE short_videos.cover_path
                      END,
                      cover_source=CASE
                        WHEN excluded.cover_source = 'native' AND NULLIF(excluded.cover_path, '') IS NOT NULL THEN 'native'
                        WHEN short_videos.cover_source = 'native' AND NULLIF(short_videos.cover_path, '') IS NOT NULL THEN 'native'
                        WHEN NULLIF(excluded.cover_source, '') IS NOT NULL THEN excluded.cover_source
                        ELSE short_videos.cover_source
                      END,
                      music_path=COALESCE(NULLIF(excluded.music_path, ''), short_videos.music_path),
                      data_path=COALESCE(NULLIF(excluded.data_path, ''), short_videos.data_path),
                      relative_path=excluded.relative_path,
                      file_name=excluded.file_name,
                      size_bytes=excluded.size_bytes,
                      mtime_ms=excluded.mtime_ms,
                      owner_user_id=COALESCE(NULLIF(excluded.owner_user_id, ''), short_videos.owner_user_id),
                      origin=CASE
                        WHEN short_videos.origin = 'douyin_download_manager_like'
                          AND excluded.origin = 'douyin_download_manager_post'
                          THEN short_videos.origin
                        WHEN excluded.origin = 'douyin_download_manager_like'
                          THEN excluded.origin
                        ELSE excluded.origin
                      END,
                      status='normal',
                      visibility='local_only',
                      updated_at=excluded.updated_at
                    """,
                    (
                        aweme_id,
                        aweme_id,
                        author_sec_uid,
                        author_uid,
                        author_name,
                        author_avatar_url,
                        title,
                        desc,
                        json_text(tags) or "[]",
                        " ".join(tags),
                        create_time,
                        iso_from_create_time(create_time),
                        liked_at,
                        row_int(link, "duration_ms") or int_or_none(record.get("duration") or raw_video.get("duration")),
                        int_or_none(raw_video.get("width")),
                        int_or_none(raw_video.get("height")),
                        row_int(link, "digg_count") or int_or_none(raw_stats.get("digg_count")) or 0,
                        row_int(link, "comment_count") or int_or_none(raw_stats.get("comment_count")) or 0,
                        row_int(link, "collect_count") or int_or_none(raw_stats.get("collect_count")) or 0,
                        row_int(link, "share_count") or int_or_none(raw_stats.get("share_count")) or 0,
                        int_or_none(raw_stats.get("play_count")) or 0,
                        first_text(row_text(link, "url"), douyin_video_url(aweme_id)),
                        metadata_json,
                        source_path,
                        cover_path,
                        "native" if cover_path else "",
                        music_path,
                        data_path,
                        relative_path,
                        Path(source_path).name,
                        int(source_stat.st_size),
                        int(source_stat.st_mtime * 1000),
                        now,
                        now,
                        author_id,
                        fanhao_origin(row_text(link, "profile_id")),
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO short_video_stats (
                      video_id, digg_count, comment_count, collect_count, share_count,
                      play_count, snapshot_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(video_id) DO UPDATE SET
                      digg_count=MAX(COALESCE(short_video_stats.digg_count, 0), COALESCE(excluded.digg_count, 0)),
                      comment_count=MAX(COALESCE(short_video_stats.comment_count, 0), COALESCE(excluded.comment_count, 0)),
                      collect_count=MAX(COALESCE(short_video_stats.collect_count, 0), COALESCE(excluded.collect_count, 0)),
                      share_count=MAX(COALESCE(short_video_stats.share_count, 0), COALESCE(excluded.share_count, 0)),
                      play_count=MAX(COALESCE(short_video_stats.play_count, 0), COALESCE(excluded.play_count, 0)),
                      snapshot_at=excluded.snapshot_at,
                      updated_at=excluded.updated_at
                    """,
                    (
                        aweme_id,
                        row_int(link, "digg_count") or int_or_none(raw_stats.get("digg_count")) or 0,
                        row_int(link, "comment_count") or int_or_none(raw_stats.get("comment_count")) or 0,
                        row_int(link, "collect_count") or int_or_none(raw_stats.get("collect_count")) or 0,
                        row_int(link, "share_count") or int_or_none(raw_stats.get("share_count")) or 0,
                        int_or_none(raw_stats.get("play_count")) or 0,
                        now,
                        now,
                    ),
                )
                if is_gallery:
                    conn.execute(
                        "DELETE FROM short_video_assets WHERE video_id=? AND asset_type LIKE 'gallery_%:%'",
                        (aweme_id,),
                    )
                    image_paths = [
                        file_path
                        for file_path in paths
                        if file_kind(file_path) == "image" and "_avatar." not in Path(file_path).name.lower()
                    ]
                    video_paths = [file_path for file_path in paths if file_kind(file_path) == "video"]
                    fanhao_media = record.get("fanhaoMedia") if isinstance(record.get("fanhaoMedia"), dict) else {}
                    gallery_items = fanhao_media.get("galleryItems") if isinstance(fanhao_media.get("galleryItems"), list) else []
                    image_cursor = 0
                    video_cursor = 0
                    indexed_assets: list[tuple[int, str, str]] = []
                    if gallery_items:
                        for index, item_type in enumerate(gallery_items):
                            image_path = image_paths[image_cursor] if image_cursor < len(image_paths) else ""
                            image_cursor += 1
                            if item_type == "video" and video_cursor < len(video_paths):
                                indexed_assets.append((index, "video", video_paths[video_cursor]))
                                video_cursor += 1
                            elif image_path:
                                indexed_assets.append((index, "image", image_path))
                    else:
                        indexed_assets.extend((index, "image", file_path) for index, file_path in enumerate(image_paths))
                        indexed_assets.extend((index, "video", file_path) for index, file_path in enumerate(video_paths))

                    for index, kind, file_path in indexed_assets:
                        absolute_path = resolve_manifest_file(output_dir, file_path)
                        try:
                            if not absolute_path.is_file():
                                continue
                        except OSError:
                            continue
                        fanhao_upsert_asset(
                            conn,
                            aweme_id,
                            f"gallery_{kind}:{index:04d}",
                            str(absolute_path.resolve()),
                            now,
                        )
                else:
                    fanhao_upsert_asset(conn, aweme_id, "video", source_path, now)
                if cover_path:
                    fanhao_upsert_asset(conn, aweme_id, "native_cover", cover_path, now)
                    fanhao_cleanup_superseded_ffmpeg_cover(conn, aweme_id)
                if music_path:
                    fanhao_upsert_asset(conn, aweme_id, "music", music_path, now)
                origin = fanhao_origin(row_text(link, "profile_id"))
                fanhao_upsert_source_membership(
                    conn, aweme_id, row_text(link, "profile_id"), origin, now
                )
                fanhao_prune_source_path_duplicates(conn, source_path, aweme_id)
                conn.execute(
                    "INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_imported_at', ?)",
                    (now,),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_db_path', ?)",
                    (str(DB_PATH),),
                )
            conn.close()
        except sqlite3.Error as exc:
            add_event("warn", f"FanHao 直写入库失败 {aweme_id}: {str(exc)[:180]}")


def kind_from_manifest(record: dict[str, Any]) -> str:
    media_type = str(record.get("media_type") or "").lower()
    return "note" if media_type in {"gallery", "note", "image"} else "video"


def author_sec_uid_from_manifest(record: dict[str, Any]) -> str:
    for path in record.get("file_paths") or []:
        head = str(path or "").replace("/", "\\").split("\\", 1)[0]
        match = re.search(r"(MS4w[^\\/_\s]+)", head)
        if match:
            return match.group(1)
    return ""


def manifest_import_row(record: dict[str, Any]) -> dict[str, Any] | None:
    aweme_id = str(record.get("aweme_id") or "").strip()
    if not aweme_id:
        return None
    kind = kind_from_manifest(record)
    preview_path = manifest_preview_path(record)
    return {
        "aweme_id": aweme_id,
        "kind": kind,
        "url": f"https://www.douyin.com/{'note' if kind == 'note' else 'video'}/{aweme_id}",
        "author_nickname": first_text(record.get("author_name")),
        "author_sec_uid": author_sec_uid_from_manifest(record),
        "author_avatar_url": first_text(record.get("author_avatar_url")),
        "author_url": first_text(record.get("author_url")),
        "desc": first_text(record.get("desc")),
        "cover_url": first_text(record.get("cover_url"), record.get("cover")),
        "create_time": int_or_none(record.get("publish_timestamp") or record.get("create_time")),
        "media_type": first_text(record.get("media_type"), "gallery" if kind == "note" else "video"),
        "local_file_names": json_text(record.get("file_names")),
        "local_file_paths": json_text(record.get("file_paths")),
        "local_cover_path": manifest_cover_path(record),
        "preview_path": preview_path,
        "metadata_json": json_text(record),
        **manifest_music_metadata(record),
        "downloaded_at": first_text(record.get("recorded_at")),
        "manifest_record": record,
    }


def import_manifest_to_db(
    profile_id: int,
    manifest_path: str | Path,
    output_dir: str | Path | None = None,
) -> dict[str, int | str]:
    path = Path(manifest_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"manifest 不存在：{path}")
    resolved_output_dir = Path(output_dir).expanduser().resolve() if output_dir else path.parent
    records: dict[str, dict[str, Any]] = {}
    total = bad = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            total += 1
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            row = manifest_import_row(record)
            if row is None:
                bad += 1
                continue
            records[row["aweme_id"]] = row

    ts = now_iso()
    inserted = updated = files_imported = 0
    with db() as conn:
        for row in records.values():
            before = conn.execute(
                "SELECT id FROM links WHERE profile_id=? AND aweme_id=?",
                (profile_id, row["aweme_id"]),
            ).fetchone()
            if before:
                updated += 1
            else:
                inserted += 1
            conn.execute(
                """
                INSERT INTO links(
                  profile_id, aweme_id, kind, url,
                  author_sec_uid, author_nickname, author_avatar_url, author_url,
                  desc, cover_url, create_time, media_type,
                  local_file_names, local_file_paths, local_cover_path, preview_path, metadata_json,
                  music_id, music_title, music_author, music_cover_url, music_play_url, local_music_path,
                  status, discovered_at, last_seen_at, downloaded_at, output_dir, last_error
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'downloaded', ?, ?, ?, ?, NULL)
                ON CONFLICT(profile_id, aweme_id) DO UPDATE SET
                  kind=excluded.kind,
                  url=excluded.url,
                  author_sec_uid=COALESCE(NULLIF(excluded.author_sec_uid, ''), links.author_sec_uid),
                  author_nickname=COALESCE(NULLIF(excluded.author_nickname, ''), links.author_nickname),
                  author_avatar_url=COALESCE(NULLIF(excluded.author_avatar_url, ''), links.author_avatar_url),
                  author_url=COALESCE(NULLIF(excluded.author_url, ''), links.author_url),
                  desc=COALESCE(NULLIF(excluded.desc, ''), links.desc),
                  cover_url=COALESCE(NULLIF(excluded.cover_url, ''), links.cover_url),
                  create_time=COALESCE(excluded.create_time, links.create_time),
                  media_type=COALESCE(NULLIF(excluded.media_type, ''), links.media_type),
                  local_file_names=COALESCE(NULLIF(excluded.local_file_names, ''), links.local_file_names),
                  local_file_paths=COALESCE(NULLIF(excluded.local_file_paths, ''), links.local_file_paths),
                  local_cover_path=COALESCE(NULLIF(excluded.local_cover_path, ''), links.local_cover_path),
                  preview_path=COALESCE(NULLIF(excluded.preview_path, ''), links.preview_path),
                  metadata_json=COALESCE(NULLIF(excluded.metadata_json, ''), links.metadata_json),
                  music_id=COALESCE(NULLIF(excluded.music_id, ''), links.music_id),
                  music_title=COALESCE(NULLIF(excluded.music_title, ''), links.music_title),
                  music_author=COALESCE(NULLIF(excluded.music_author, ''), links.music_author),
                  music_cover_url=COALESCE(NULLIF(excluded.music_cover_url, ''), links.music_cover_url),
                  music_play_url=COALESCE(NULLIF(excluded.music_play_url, ''), links.music_play_url),
                  local_music_path=COALESCE(NULLIF(excluded.local_music_path, ''), links.local_music_path),
                  status='downloaded',
                  downloaded_at=COALESCE(NULLIF(excluded.downloaded_at, ''), links.downloaded_at, ?),
                  output_dir=excluded.output_dir,
                  last_error=NULL,
                  last_seen_at=excluded.last_seen_at
                """,
                (
                    profile_id,
                    row["aweme_id"],
                    row["kind"],
                    row["url"],
                    row["author_sec_uid"],
                    row["author_nickname"],
                    row["author_avatar_url"],
                    row["author_url"],
                    row["desc"],
                    row["cover_url"],
                    row["create_time"],
                    row["media_type"],
                    row["local_file_names"],
                    row["local_file_paths"],
                    row["local_cover_path"],
                    row["preview_path"],
                    row["metadata_json"],
                    row["music_id"],
                    row["music_title"],
                    row["music_author"],
                    row["music_cover_url"],
                    row["music_play_url"],
                    row["local_music_path"],
                    ts,
                    ts,
                    row["downloaded_at"] or ts,
                    str(resolved_output_dir),
                    ts,
                ),
            )
            files_imported += sync_manifest_files(
                conn,
                profile_id,
                row["aweme_id"],
                resolved_output_dir,
                row["manifest_record"],
            )
        conn.execute("UPDATE profiles SET updated_at=? WHERE id=?", (ts, profile_id))
        conn.execute(
            "INSERT INTO events(ts, level, message) VALUES(?, 'info', ?)",
            (
                ts,
                f"manifest 同步完成：{len(records)} 条，新 {inserted}，更新 {updated}，文件 {files_imported}",
            ),
        )
    return {
        "total_lines": total,
        "unique": len(records),
        "inserted": inserted,
        "updated": updated,
        "files": files_imported,
        "duplicates": max(0, total - bad - len(records)),
        "bad": bad,
        "manifest": str(path),
        "output_dir": str(resolved_output_dir),
    }


def upsert_profile(url: str, profile_tab: Any | None = None) -> int:
    parsed = parse_profile_url(url, setting("profile_tab", "auto") if profile_tab is None else profile_tab)
    ts = now_iso()
    with db() as conn:
        row = conn.execute("SELECT id FROM profiles WHERE url=?", (parsed["url"],)).fetchone()
        if row:
            conn.execute(
                """
                UPDATE profiles
                SET sec_uid=?, tab=?, updated_at=?
                WHERE id=?
                """,
                (parsed["sec_uid"], parsed["tab"], ts, row["id"]),
            )
            return int(row["id"])
        conn.execute(
            """
            INSERT INTO profiles(url, sec_uid, tab, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(sec_uid, tab) DO UPDATE SET
              url=excluded.url,
              updated_at=excluded.updated_at
            """,
            (parsed["url"], parsed["sec_uid"], parsed["tab"], ts, ts),
        )
        row = conn.execute(
            "SELECT id FROM profiles WHERE sec_uid=? AND tab=?",
            (parsed["sec_uid"], parsed["tab"]),
        ).fetchone()
        return int(row["id"])


def current_profile_id(create: bool = False) -> int | None:
    url = setting("profile_url", TEST_PROFILE_URL).strip()
    if not url:
        return None
    parsed = parse_profile_url(url, setting("profile_tab", "auto"))
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM profiles WHERE sec_uid=? AND tab=?",
            (parsed["sec_uid"], parsed["tab"]),
        ).fetchone()
    if row:
        return int(row["id"])
    return upsert_profile(url, setting("profile_tab", "auto")) if create else None


def first_text(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def int_or_none(value: Any) -> int | None:
    try:
        if value in ("", None):
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def json_text(value: Any) -> str:
    if value in ("", None):
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return ""


def clean_profile_nickname(*values: Any) -> str:
    text = first_text(*values)
    if not text or len(text) > 32:
        return ""
    lowered = text.lower()
    if "captcha" in lowered or lowered.endswith((".zip", ".rar", ".7z")):
        return ""
    if text in {"搜索", "推荐", "关注", "粉丝", "获赞", "作品"}:
        return ""
    return text


def normalize_profile_metadata(profile: dict[str, Any] | None, fallback_sec_uid: str = "") -> dict[str, Any]:
    profile = profile or {}
    raw = profile.get("raw_json") if isinstance(profile.get("raw_json"), (dict, list, str)) else profile
    sec_uid = first_text(fallback_sec_uid, profile.get("sec_uid"), profile.get("secUid"))
    uid = first_text(profile.get("uid"), profile.get("user_id"), profile.get("userId"))
    nickname = clean_profile_nickname(profile.get("nickname"), profile.get("name"))
    unique_id = first_text(profile.get("unique_id"), profile.get("uniqueId"))
    short_id = first_text(profile.get("short_id"), profile.get("shortId"))
    if unique_id == "0":
        unique_id = ""
    if short_id == "0":
        short_id = ""
    douyin_id = first_text(unique_id, short_id)
    if douyin_id and douyin_id.isdigit() and not short_id:
        short_id = douyin_id
    profile_url = first_text(profile.get("profile_url"), profile.get("profileUrl"), douyin_user_url(sec_uid))
    raw_json = raw if isinstance(raw, str) else json_text(raw)
    return {
        "uid": uid,
        "sec_uid": sec_uid,
        "nickname": nickname,
        "avatar_url": first_url_any(profile.get("avatar_url"), profile.get("avatarUrl"), profile.get("avatar")),
        "unique_id": unique_id,
        "short_id": short_id,
        "signature": first_text(profile.get("signature"), profile.get("bio"), profile.get("description")),
        "ip_location": first_text(profile.get("ip_location"), profile.get("ipLocation")).replace("IP属地：", "").replace("IP属地:", ""),
        "following_count": int_or_none(profile.get("following_count") or profile.get("followingCount")),
        "follower_count": int_or_none(profile.get("follower_count") or profile.get("followerCount")),
        "total_favorited": int_or_none(profile.get("total_favorited") or profile.get("totalFavorited")),
        "aweme_count": int_or_none(profile.get("aweme_count") or profile.get("awemeCount")),
        "favoriting_count": int_or_none(profile.get("favoriting_count") or profile.get("favoritingCount")),
        "gender": int_or_none(profile.get("gender")),
        "age": int_or_none(profile.get("age")),
        "verification": first_text(profile.get("verification"), profile.get("custom_verify"), profile.get("customVerify")),
        "profile_url": profile_url,
        "profile_raw_json": raw_json if raw_json else "{}",
    }


def fanhao_ensure_user_profile_columns(conn: sqlite3.Connection) -> None:
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(short_video_users)").fetchall()}
    specs = {
        "profile_url": "TEXT NOT NULL DEFAULT ''",
        "unique_id": "TEXT NOT NULL DEFAULT ''",
        "short_id": "TEXT NOT NULL DEFAULT ''",
        "ip_location": "TEXT NOT NULL DEFAULT ''",
        "total_favorited": "INTEGER",
        "aweme_count": "INTEGER",
        "favoriting_count": "INTEGER",
        "gender": "INTEGER",
        "age": "INTEGER",
        "verification": "TEXT NOT NULL DEFAULT ''",
        "profile_collected_at": "TEXT NOT NULL DEFAULT ''",
    }
    for name, definition in specs.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE short_video_users ADD COLUMN {name} {definition}")


def fanhao_upsert_profile_metadata(meta: dict[str, Any]) -> None:
    if not FANHAO_DIRECT_IMPORT or not FANHAO_DB_PATH.exists():
        return
    sec_uid = first_text(meta.get("sec_uid"))
    uid = first_text(meta.get("uid"))
    nickname = first_text(meta.get("nickname"), "未知作者")
    if not (sec_uid or uid or nickname):
        return
    now = now_iso()
    author_id = fanhao_author_id(sec_uid, uid, nickname)
    with fanhao_import_lock:
        try:
            conn = sqlite3.connect(FANHAO_DB_PATH, timeout=30)
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA journal_mode=WAL")
            fanhao_ensure_user_profile_columns(conn)
            with conn:
                conn.execute(
                    """
                    INSERT INTO short_video_users (
                      id, platform, sec_uid, uid, nickname, avatar_url, profile_url, signature,
                      follower_count, following_count, raw_json, created_at, updated_at,
                      unique_id, short_id, ip_location, total_favorited, aweme_count,
                      favoriting_count, gender, age, verification, profile_collected_at
                    )
                    VALUES (?, 'douyin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                      sec_uid=COALESCE(NULLIF(excluded.sec_uid, ''), short_video_users.sec_uid),
                      uid=COALESCE(NULLIF(excluded.uid, ''), short_video_users.uid),
                      nickname=COALESCE(NULLIF(excluded.nickname, ''), short_video_users.nickname),
                      avatar_url=COALESCE(NULLIF(excluded.avatar_url, ''), short_video_users.avatar_url),
                      profile_url=COALESCE(NULLIF(excluded.profile_url, ''), short_video_users.profile_url),
                      signature=COALESCE(NULLIF(excluded.signature, ''), short_video_users.signature),
                      follower_count=COALESCE(excluded.follower_count, short_video_users.follower_count),
                      following_count=COALESCE(excluded.following_count, short_video_users.following_count),
                      raw_json=CASE WHEN excluded.raw_json <> '{}' THEN excluded.raw_json ELSE short_video_users.raw_json END,
                      unique_id=COALESCE(NULLIF(excluded.unique_id, ''), short_video_users.unique_id),
                      short_id=COALESCE(NULLIF(excluded.short_id, ''), short_video_users.short_id),
                      ip_location=COALESCE(NULLIF(excluded.ip_location, ''), short_video_users.ip_location),
                      total_favorited=COALESCE(excluded.total_favorited, short_video_users.total_favorited),
                      aweme_count=COALESCE(excluded.aweme_count, short_video_users.aweme_count),
                      favoriting_count=COALESCE(excluded.favoriting_count, short_video_users.favoriting_count),
                      gender=COALESCE(excluded.gender, short_video_users.gender),
                      age=COALESCE(excluded.age, short_video_users.age),
                      verification=COALESCE(NULLIF(excluded.verification, ''), short_video_users.verification),
                      profile_collected_at=COALESCE(NULLIF(excluded.profile_collected_at, ''), short_video_users.profile_collected_at),
                      updated_at=excluded.updated_at
                    """,
                    (
                        author_id,
                        sec_uid,
                        uid,
                        nickname,
                        first_text(meta.get("avatar_url")),
                        first_text(meta.get("profile_url"), douyin_user_url(sec_uid)),
                        first_text(meta.get("signature")),
                        meta.get("follower_count"),
                        meta.get("following_count"),
                        first_text(meta.get("profile_raw_json"), "{}"),
                        now,
                        now,
                        first_text(meta.get("unique_id")),
                        first_text(meta.get("short_id")),
                        first_text(meta.get("ip_location")),
                        meta.get("total_favorited"),
                        meta.get("aweme_count"),
                        meta.get("favoriting_count"),
                        meta.get("gender"),
                        meta.get("age"),
                        first_text(meta.get("verification")),
                        first_text(meta.get("profile_collected_at"), now),
                    ),
                )
            conn.close()
        except sqlite3.Error as exc:
            add_event("warn", f"FanHao 作者资料写入失败 {sec_uid or uid}: {str(exc)[:180]}")


def upsert_profile_metadata(profile_id: int, profile: dict[str, Any] | None) -> None:
    if not profile_id or not profile:
        return
    with db() as conn:
        row = conn.execute("SELECT sec_uid FROM profiles WHERE id=?", (profile_id,)).fetchone()
        fallback_sec_uid = first_text(row["sec_uid"]) if row else ""
        meta = normalize_profile_metadata(profile, fallback_sec_uid)
        if not any(meta.get(key) not in ("", None, "{}") for key in meta):
            return
        now = now_iso()
        meta["profile_collected_at"] = now
        conn.execute(
            """
            UPDATE profiles SET
              title=COALESCE(NULLIF(?, ''), title),
              uid=COALESCE(NULLIF(?, ''), uid),
              sec_uid=COALESCE(NULLIF(?, ''), sec_uid),
              nickname=COALESCE(NULLIF(?, ''), nickname),
              avatar_url=COALESCE(NULLIF(?, ''), avatar_url),
              unique_id=COALESCE(NULLIF(?, ''), unique_id),
              short_id=COALESCE(NULLIF(?, ''), short_id),
              signature=COALESCE(NULLIF(?, ''), signature),
              ip_location=COALESCE(NULLIF(?, ''), ip_location),
              following_count=COALESCE(?, following_count),
              follower_count=COALESCE(?, follower_count),
              total_favorited=COALESCE(?, total_favorited),
              aweme_count=COALESCE(?, aweme_count),
              favoriting_count=COALESCE(?, favoriting_count),
              gender=COALESCE(?, gender),
              age=COALESCE(?, age),
              verification=COALESCE(NULLIF(?, ''), verification),
              profile_raw_json=CASE WHEN ? <> '{}' THEN ? ELSE profile_raw_json END,
              profile_collected_at=?,
              updated_at=?
            WHERE id=?
            """,
            (
                meta["nickname"],
                meta["uid"],
                meta["sec_uid"],
                meta["nickname"],
                meta["avatar_url"],
                meta["unique_id"],
                meta["short_id"],
                meta["signature"],
                meta["ip_location"],
                meta["following_count"],
                meta["follower_count"],
                meta["total_favorited"],
                meta["aweme_count"],
                meta["favoriting_count"],
                meta["gender"],
                meta["age"],
                meta["verification"],
                meta["profile_raw_json"],
                meta["profile_raw_json"],
                now,
                now,
                profile_id,
            ),
        )
    fanhao_upsert_profile_metadata(meta)


def upsert_following_profiles(users: list[dict[str, Any]]) -> tuple[int, int]:
    inserted = 0
    updated = 0
    ts = now_iso()
    with db() as conn:
        for user in users:
            if not isinstance(user, dict):
                continue
            meta = normalize_profile_metadata(user)
            sec_uid = first_text(meta.get("sec_uid"))
            if not sec_uid:
                continue
            existing = conn.execute(
                "SELECT id FROM profiles WHERE sec_uid=? AND tab='post'",
                (sec_uid,),
            ).fetchone()
            profile_url = first_text(meta.get("profile_url"), douyin_user_url(sec_uid))
            conn.execute(
                """
                INSERT INTO profiles (
                  url, sec_uid, tab, title, uid, nickname, avatar_url, unique_id, short_id,
                  signature, ip_location, following_count, follower_count, total_favorited,
                  aweme_count, favoriting_count, gender, age, verification, profile_raw_json,
                  profile_collected_at, is_following, following_discovered_at, created_at, updated_at
                ) VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                ON CONFLICT(sec_uid, tab) DO UPDATE SET
                  url=excluded.url,
                  title=COALESCE(NULLIF(excluded.title, ''), profiles.title),
                  uid=COALESCE(NULLIF(excluded.uid, ''), profiles.uid),
                  nickname=COALESCE(NULLIF(excluded.nickname, ''), profiles.nickname),
                  avatar_url=COALESCE(NULLIF(excluded.avatar_url, ''), profiles.avatar_url),
                  unique_id=COALESCE(NULLIF(excluded.unique_id, ''), profiles.unique_id),
                  short_id=COALESCE(NULLIF(excluded.short_id, ''), profiles.short_id),
                  signature=COALESCE(NULLIF(excluded.signature, ''), profiles.signature),
                  ip_location=COALESCE(NULLIF(excluded.ip_location, ''), profiles.ip_location),
                  following_count=COALESCE(excluded.following_count, profiles.following_count),
                  follower_count=COALESCE(excluded.follower_count, profiles.follower_count),
                  total_favorited=COALESCE(excluded.total_favorited, profiles.total_favorited),
                  aweme_count=COALESCE(excluded.aweme_count, profiles.aweme_count),
                  favoriting_count=COALESCE(excluded.favoriting_count, profiles.favoriting_count),
                  gender=COALESCE(excluded.gender, profiles.gender),
                  age=COALESCE(excluded.age, profiles.age),
                  verification=COALESCE(NULLIF(excluded.verification, ''), profiles.verification),
                  profile_raw_json=CASE WHEN excluded.profile_raw_json <> '{}' THEN excluded.profile_raw_json ELSE profiles.profile_raw_json END,
                  profile_collected_at=COALESCE(excluded.profile_collected_at, profiles.profile_collected_at),
                  is_following=1,
                  following_discovered_at=COALESCE(profiles.following_discovered_at, excluded.following_discovered_at),
                  updated_at=excluded.updated_at
                """,
                (
                    profile_url,
                    sec_uid,
                    meta["nickname"],
                    meta["uid"],
                    meta["nickname"],
                    meta["avatar_url"],
                    meta["unique_id"],
                    meta["short_id"],
                    meta["signature"],
                    meta["ip_location"],
                    meta["following_count"],
                    meta["follower_count"],
                    meta["total_favorited"],
                    meta["aweme_count"],
                    meta["favoriting_count"],
                    meta["gender"],
                    meta["age"],
                    meta["verification"],
                    meta["profile_raw_json"],
                    ts,
                    ts,
                    ts,
                    ts,
                ),
            )
            if existing:
                updated += 1
            else:
                inserted += 1
    return inserted, updated


def upsert_links(profile_id: int, works: list[dict[str, Any]]) -> tuple[int, int]:
    ts = now_iso()
    inserted = 0
    updated = 0
    profile_author_meta: dict[str, Any] | None = None
    with db() as conn:
        profile_row = conn.execute("SELECT sec_uid, tab FROM profiles WHERE id=?", (profile_id,)).fetchone()
        profile_sec_uid = first_text(profile_row["sec_uid"]) if profile_row else ""
        profile_tab = first_text(profile_row["tab"]) if profile_row else ""
        for work in works:
            aweme_id = str(work.get("aweme_id") or "")
            url = str(work.get("url") or "")
            kind = str(work.get("kind") or "video")
            author_uid = str(work.get("author_uid") or work.get("authorUid") or "")
            author_sec_uid = str(work.get("author_sec_uid") or work.get("authorSecUid") or "")
            author_nickname = str(work.get("author_nickname") or work.get("authorNickname") or "")
            if profile_tab == "post" and profile_sec_uid and author_sec_uid != profile_sec_uid:
                continue
            author_avatar_url = first_text(work.get("author_avatar_url"), work.get("authorAvatarUrl"))
            author_url = first_text(work.get("author_url"), work.get("authorUrl"))
            if not author_url and author_sec_uid:
                author_url = f"https://www.douyin.com/user/{author_sec_uid}"
            desc = first_text(work.get("desc"), work.get("title"), work.get("caption"))
            cover_url = first_text(work.get("cover_url"), work.get("coverUrl"), work.get("thumbnail"), work.get("preview_url"))
            create_time = int_or_none(work.get("create_time") or work.get("createTime"))
            duration_ms = int_or_none(work.get("duration_ms") or work.get("duration") or work.get("durationMs"))
            digg_count = int_or_none(work.get("digg_count") or work.get("diggCount") or work.get("like_count") or work.get("likeCount"))
            comment_count = int_or_none(work.get("comment_count") or work.get("commentCount"))
            share_count = int_or_none(work.get("share_count") or work.get("shareCount"))
            collect_count = int_or_none(work.get("collect_count") or work.get("collectCount"))
            media_type = first_text(work.get("media_type"), work.get("mediaType"), "gallery" if kind == "note" else "video")
            local_file_names = json_text(work.get("local_file_names") or work.get("localFileNames"))
            local_file_paths = json_text(work.get("local_file_paths") or work.get("localFilePaths"))
            preview_path = first_text(work.get("preview_path"), work.get("previewPath"))
            metadata_json = json_text(work.get("metadata"))
            if not aweme_id or not url:
                continue
            before = conn.execute(
                "SELECT id FROM links WHERE profile_id=? AND aweme_id=?",
                (profile_id, aweme_id),
            ).fetchone()
            if before:
                updated += 1
            else:
                inserted += 1
            conn.execute(
                """
                INSERT INTO links(
                  profile_id, aweme_id, kind, url,
                  author_uid, author_sec_uid, author_nickname, author_avatar_url, author_url,
                  desc, cover_url, create_time, duration_ms,
                  digg_count, comment_count, share_count, collect_count,
                  media_type, local_file_names, local_file_paths, preview_path, metadata_json,
                  status, discovered_at, last_seen_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(profile_id, aweme_id) DO UPDATE SET
                  kind=excluded.kind,
                  url=excluded.url,
                  author_uid=COALESCE(NULLIF(excluded.author_uid, ''), links.author_uid),
                  author_sec_uid=COALESCE(NULLIF(excluded.author_sec_uid, ''), links.author_sec_uid),
                  author_nickname=COALESCE(NULLIF(excluded.author_nickname, ''), links.author_nickname),
                  author_avatar_url=COALESCE(NULLIF(excluded.author_avatar_url, ''), links.author_avatar_url),
                  author_url=COALESCE(NULLIF(excluded.author_url, ''), links.author_url),
                  desc=COALESCE(NULLIF(excluded.desc, ''), links.desc),
                  cover_url=COALESCE(NULLIF(excluded.cover_url, ''), links.cover_url),
                  create_time=COALESCE(excluded.create_time, links.create_time),
                  duration_ms=COALESCE(excluded.duration_ms, links.duration_ms),
                  digg_count=COALESCE(excluded.digg_count, links.digg_count),
                  comment_count=COALESCE(excluded.comment_count, links.comment_count),
                  share_count=COALESCE(excluded.share_count, links.share_count),
                  collect_count=COALESCE(excluded.collect_count, links.collect_count),
                  media_type=COALESCE(NULLIF(excluded.media_type, ''), links.media_type),
                  local_file_names=COALESCE(NULLIF(excluded.local_file_names, ''), links.local_file_names),
                  local_file_paths=COALESCE(NULLIF(excluded.local_file_paths, ''), links.local_file_paths),
                  preview_path=COALESCE(NULLIF(excluded.preview_path, ''), links.preview_path),
                  metadata_json=COALESCE(NULLIF(excluded.metadata_json, ''), links.metadata_json),
                  last_seen_at=excluded.last_seen_at
                """,
                (
                    profile_id,
                    aweme_id,
                    kind,
                    url,
                    author_uid,
                    author_sec_uid,
                    author_nickname,
                    author_avatar_url,
                    author_url,
                    desc,
                    cover_url,
                    create_time,
                    duration_ms,
                    digg_count,
                    comment_count,
                    share_count,
                    collect_count,
                    media_type,
                    local_file_names,
                    local_file_paths,
                    preview_path,
                    metadata_json,
                    ts,
                    ts,
                ),
            )
        conn.execute(
            "UPDATE profiles SET last_extracted_at=?, updated_at=? WHERE id=?",
            (ts, ts, profile_id),
        )
        ensure_profile_in_download_queue(conn, profile_id)
        if profile_tab == "post" and profile_sec_uid:
            conn.execute(
                """
                DELETE FROM links
                WHERE profile_id=?
                  AND COALESCE(author_sec_uid, '') <> ?
                """,
                (profile_id, profile_sec_uid),
            )
            row = conn.execute(
                """
                SELECT author_uid, author_sec_uid, author_nickname, author_avatar_url, author_url, COUNT(*) c
                FROM links
                WHERE profile_id=?
                  AND author_sec_uid=?
                GROUP BY author_uid, author_sec_uid, author_nickname, author_avatar_url, author_url
                ORDER BY c DESC
                LIMIT 1
                """,
                (profile_id, profile_sec_uid),
            ).fetchone()
            if row:
                profile_author_meta = {
                    "uid": first_text(row["author_uid"]),
                    "sec_uid": profile_sec_uid,
                    "nickname": clean_profile_nickname(row["author_nickname"]),
                    "avatar_url": first_text(row["author_avatar_url"]),
                    "profile_url": first_text(row["author_url"], douyin_user_url(profile_sec_uid)),
                }
                conn.execute(
                    """
                    UPDATE profiles
                    SET uid=COALESCE(NULLIF(?, ''), uid),
                        nickname=COALESCE(NULLIF(?, ''), nickname),
                        avatar_url=COALESCE(NULLIF(?, ''), avatar_url),
                        updated_at=?
                    WHERE id=?
                    """,
                    (
                        profile_author_meta["uid"],
                        profile_author_meta["nickname"],
                        profile_author_meta["avatar_url"],
                        ts,
                        profile_id,
                    ),
                )
    if profile_author_meta:
        fanhao_upsert_profile_metadata(profile_author_meta)
    fanhao_upsert_link_placeholders(profile_id, works)
    return inserted, updated


def parse_netscape_cookie_text(text: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_") :]
        elif line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        name = parts[5].strip()
        value = "\t".join(parts[6:]).strip()
        if name:
            cookies[name] = value
    return cookies


def parse_netscape_cookie_dict(file: str) -> dict[str, str]:
    path = Path(file)
    if not path.exists():
        return {}
    try:
        return parse_netscape_cookie_text(path.read_text(encoding="utf-8-sig"))
    except OSError:
        return {}


def cookie_file_path() -> Path:
    return Path(setting("cookie_file", str(DEFAULT_COOKIE_FILE))).expanduser().resolve()


def cookie_login_snapshot() -> dict[str, Any]:
    with cookie_login_lock:
        state = dict(cookie_login_state)
        process = cookie_login_process
        state["active"] = process is not None and process.poll() is None
    return state


def cookie_auth_status() -> dict[str, Any]:
    path = cookie_file_path()
    cookies = parse_netscape_cookie_dict(str(path))
    session_names = sorted(
        name for name in ("sessionid", "sessionid_ss", "sid_guard", "sid_tt") if cookies.get(name)
    )
    exists = path.is_file()
    modified_at = ""
    size = 0
    if exists:
        try:
            stat = path.stat()
            size = stat.st_size
            modified_at = iso_from_timestamp(stat.st_mtime)
        except OSError:
            pass
    if session_names:
        status = "ready"
        message = "已读取抖音登录信息"
    elif cookies:
        status = "incomplete"
        message = "Cookie 已存在，但没有检测到登录凭证"
    else:
        status = "missing"
        message = "尚未设置抖音登录信息"
    return {
        "status": status,
        "message": message,
        "path": str(path),
        "exists": exists,
        "modified_at": modified_at,
        "size": size,
        "cookie_count": len(cookies),
        "has_session": bool(session_names),
        "has_ms_token": bool(cookies.get("msToken")),
        "session_cookie_names": session_names,
        "login": cookie_login_snapshot(),
    }


def invalidate_generated_cookies() -> None:
    try:
        (CONFIG_DIR / ".cookies.json").unlink(missing_ok=True)
    except OSError:
        pass


def import_cookie_text(content: str) -> dict[str, Any]:
    if not isinstance(content, str) or not content.strip():
        return {"ok": False, "message": "Cookie 文件内容为空"}
    if len(content.encode("utf-8")) > 2 * 1024 * 1024:
        return {"ok": False, "message": "Cookie 文件不能超过 2 MB"}
    cookies = parse_netscape_cookie_text(content)
    if not cookies:
        return {"ok": False, "message": "没有识别到 Netscape 格式 Cookie"}
    path = cookie_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.endswith("\n"):
        normalized += "\n"
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(normalized, encoding="utf-8")
    temp_path.replace(path)
    invalidate_generated_cookies()
    status = cookie_auth_status()
    add_event("info", f"已导入抖音 Cookie：{status['cookie_count']} 项")
    return {"ok": True, "message": status["message"], "auth": status}


def clear_cookie_auth() -> dict[str, Any]:
    login = cookie_login_snapshot()
    if login.get("active"):
        return {"ok": False, "message": "Edge 登录正在进行，请先完成或关闭登录窗口"}
    path = cookie_file_path()
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        return {"ok": False, "message": f"无法删除 Cookie 文件：{exc}"}
    invalidate_generated_cookies()
    profile_dir = (DATA_DIR / "browser-login-profile").resolve()
    try:
        if profile_dir.exists() and str(profile_dir).startswith(str(DATA_DIR.resolve())):
            shutil.rmtree(profile_dir)
    except OSError:
        pass
    add_event("warn", "抖音登录信息已清除")
    return {"ok": True, "message": "抖音登录信息已清除", "auth": cookie_auth_status()}


def open_cookie_folder() -> dict[str, Any]:
    path = cookie_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name != "nt" or not hasattr(os, "startfile"):
        return {"ok": False, "message": f"Cookie 目录：{path.parent}"}
    os.startfile(str(path.parent))
    return {"ok": True, "message": "已打开 Cookie 目录", "path": str(path.parent)}


def monitor_cookie_login(process: subprocess.Popen[Any], log_path: Path) -> None:
    global cookie_login_process
    code = process.wait()
    status = cookie_auth_status()
    success = code == 0 and status.get("has_session")
    message = "登录成功，Cookie 已自动保存" if success else "登录未完成"
    if not success and log_path.exists():
        tail = tail_text(log_path, 800).strip().splitlines()
        if tail:
            message = tail[-1][:300]
    with cookie_login_lock:
        if cookie_login_process is process:
            cookie_login_process = None
        cookie_login_state.update(
            {
                "status": "success" if success else "failed",
                "message": message,
                "finished_at": now_iso(),
            }
        )
    add_event("info" if success else "warn", message)


def start_cookie_login() -> dict[str, Any]:
    global cookie_login_process
    with cookie_login_lock:
        already_running = cookie_login_process is not None and cookie_login_process.poll() is None
    if already_running:
        return {"ok": True, "message": "Edge 登录窗口已经打开", "auth": cookie_auth_status()}
    node = NODE_EXECUTABLE
    if not Path(node).exists() and shutil.which(node) is None:
        return {"ok": False, "message": "未找到内置 Node.js，无法打开 Edge 登录"}
    script = BASE_DIR / "cookie-login.mjs"
    if not script.exists():
        return {"ok": False, "message": "登录助手文件不存在"}
    path = cookie_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    profile_dir = DATA_DIR / "browser-login-profile"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / "cookie-login.log"
    env = os.environ.copy()
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8:replace"})
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with log_path.open("w", encoding="utf-8", errors="replace") as log:
        process = subprocess.Popen(
            [
                node,
                str(script),
                "--out",
                str(path),
                "--profile-dir",
                str(profile_dir),
                "--timeout-seconds",
                "300",
            ],
            cwd=str(BASE_DIR),
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            creationflags=creationflags,
        )
    with cookie_login_lock:
        cookie_login_process = process
        cookie_login_state.update(
            {
                "status": "running",
                "message": "请在 Edge 中完成抖音登录，成功后窗口会自动关闭",
                "started_at": now_iso(),
                "finished_at": "",
            }
        )
    thread = threading.Thread(target=monitor_cookie_login, args=(process, log_path), daemon=True)
    thread.start()
    add_event("info", "已打开 Edge，请完成抖音登录")
    return {"ok": True, "message": "已打开 Edge，请完成抖音登录", "auth": cookie_auth_status()}


def fallback_ms_token() -> str:
    return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(182)) + "=="


def write_sidecar_config(output_dir: str, concurrency: int) -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    api_rate_limit = max(8, concurrency * 4)
    proxy = normalize_proxy(setting("download_proxy", ""))
    cookies = parse_netscape_cookie_dict(setting("cookie_file", str(DEFAULT_COOKIE_FILE)))
    if cookies and not str(cookies.get("msToken") or "").strip():
        cookies["msToken"] = fallback_ms_token()
    if cookies:
        (CONFIG_DIR / ".cookies.json").write_text(
            json.dumps(cookies, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    config_path = CONFIG_DIR / "sidecar.yml"
    body = "\n".join(
        [
            f"path: {json.dumps(output_dir, ensure_ascii=False)}",
            "auto_cookie: true",
            "music: false",
            "gallery_music: true",
            "gallery_music_required: true",
            "cover: true",
            "avatar: true",
            "json: true",
            "download_pinned: false",
            "folderstyle: true",
            'filename_template: "{date}_{title}_{id}"',
            'folder_template: "{date}_{title}_{id}"',
            'author_dir: "nickname_uid"',
            "mode:",
            "  - post",
            "number:",
            "  post: 0",
            "  like: 0",
            "  allmix: 0",
            "  mix: 0",
            "  music: 0",
            "  collect: 0",
            "  collectmix: 0",
            "increase:",
            "  post: false",
            "  like: false",
            "  allmix: false",
            "  mix: false",
            "  music: false",
            f"thread: {concurrency}",
            f"rate_limit: {api_rate_limit}",
            "rate_jitter: 0.03",
            "local_dedupe: false",
            "retry_times: 3",
            f"proxy: {json.dumps(proxy, ensure_ascii=False)}",
            "database: false",
            "progress:",
            "  quiet_logs: true",
            "comments:",
            "  enabled: false",
            "transcript:",
            "  enabled: false",
            "server:",
            "  max_jobs: 2000",
            "  job_ttl_seconds: 86400",
            "",
        ]
    )
    config_path.write_text(body, encoding="utf-8")
    return config_path


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def sidecar_json(port: int, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = Request(f"http://127.0.0.1:{port}{path}", data=body, headers=headers, method=method)
    with urlopen(req, timeout=10) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    return json.loads(text) if text else {}


def write_config(link: sqlite3.Row, output_dir: str, worker_id: int) -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    config_path = CONFIG_DIR / f"link-{link['id']}-worker-{worker_id}.yml"
    proxy = normalize_proxy(setting("download_proxy", ""))
    body = "\n".join(
        [
            "link:",
            f"  - {json.dumps(link['url'], ensure_ascii=False)}",
            f"path: {json.dumps(output_dir, ensure_ascii=False)}",
            "auto_cookie: true",
            "music: true",
            "cover: true",
            "avatar: true",
            "json: true",
            "download_pinned: false",
            "folderstyle: true",
            'filename_template: "{date}_{title}_{id}"',
            'folder_template: "{date}_{title}_{id}"',
            'author_dir: "nickname_uid"',
            "mode:",
            "  - post",
            "number:",
            "  post: 0",
            "  like: 0",
            "  allmix: 0",
            "  mix: 0",
            "  music: 0",
            "  collect: 0",
            "  collectmix: 0",
            "increase:",
            "  post: false",
            "  like: false",
            "  allmix: false",
            "  mix: false",
            "  music: false",
            "thread: 4",
            "retry_times: 3",
            f"proxy: {json.dumps(proxy, ensure_ascii=False)}",
            "database: false",
            "progress:",
            "  quiet_logs: true",
            "comments:",
            "  enabled: false",
            "transcript:",
            "  enabled: false",
            "",
        ]
    )
    config_path.write_text(body, encoding="utf-8")
    return config_path


class DownloadManager:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.active = False
        self.job_id: int | None = None
        self.supervisor: threading.Thread | None = None
        self.sidecar_proc: subprocess.Popen[Any] | None = None
        self.sidecar_port: int | None = None
        self.active_jobs: dict[str, sqlite3.Row] = {}
        self.limit = 0
        self.profile_id: int | None = None
        self.failure_guard_until: float | None = None
        self.failure_guard_reason = ""
        self.failure_guard_kind = ""
        self.failure_guard_consecutive = 0
        self.cycle_sidecar_success = 0
        self.auto_resume_config: tuple[int, int, int | None, bool] | None = None
        self.auto_resume_timer: threading.Timer | None = None

    def start(
        self,
        concurrency: int,
        retry_failed: bool = False,
        limit: int = 0,
        profile_id: int | None = None,
    ) -> dict[str, Any]:
        concurrency = normalize_int(concurrency, 8, 1, MAX_CONCURRENCY)
        limit = normalize_int(limit, 0, 0, 1000000)
        if profile_id is None:
            return {"ok": False, "message": "当前主页还没有入库，请先采集链接"}
        with self.lock:
            if self.active:
                return {"ok": False, "message": "下载任务已经在运行"}
            if retry_failed:
                with db() as conn:
                    conn.execute(
                        "UPDATE links SET status='pending', last_error=NULL WHERE status='failed' AND profile_id=?",
                        (profile_id,),
                    )
            with db() as conn:
                conn.execute(
                    "UPDATE links SET status='pending' WHERE status='downloading' AND profile_id=?",
                    (profile_id,),
                )
                pending = conn.execute(
                    "SELECT COUNT(*) c FROM links WHERE status='pending' AND profile_id=?",
                    (profile_id,),
                ).fetchone()["c"]
            if pending <= 0:
                return {"ok": False, "message": "没有待下载链接"}
            run_total = min(pending, limit) if limit > 0 else pending
            self.limit = limit
            self.profile_id = profile_id
            self.stop_event.clear()
            self.job_id = create_job(
                "download",
                f"并发 {concurrency}，本次 {run_total} 条，待下载 {pending} 条",
                profile_id,
            )
            self.active = True
            self.supervisor = threading.Thread(
                target=self._run_supervisor,
                args=(self.job_id, concurrency),
                daemon=True,
            )
            self.supervisor.start()
            add_event("info", f"下载启动：并发 {concurrency}，本次 {run_total} 条，待下载 {pending} 条")
            return {"ok": True, "job_id": self.job_id, "pending": pending, "run_total": run_total}

    def stop(self) -> dict[str, Any]:
        with self.lock:
            if not self.active:
                return {"ok": False, "message": "当前没有下载任务"}
            self.stop_event.set()
            if self.sidecar_proc is not None:
                try:
                    self.sidecar_proc.terminate()
                except OSError:
                    pass
            add_event("warn", "正在停止下载任务")
            return {"ok": True}

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "active": self.active,
                "job_id": self.job_id,
                "profile_id": self.profile_id,
                "processes": len(self.active_jobs),
                "inflight": len(self.active_jobs),
                "sidecar_port": self.sidecar_port,
                "proxy": normalize_proxy(setting("download_proxy", "")),
                "watch_new": getattr(self, "watch_new", False),
                "failure_guard": {
                    "active": bool(self.failure_guard_until and time.time() < self.failure_guard_until),
                    "until": iso_from_timestamp(self.failure_guard_until),
                    "remaining_seconds": max(0, int((self.failure_guard_until or 0) - time.time())),
                    "reason": self.failure_guard_reason,
                    "kind": self.failure_guard_kind,
                    "consecutive": self.failure_guard_consecutive,
                    "threshold": failure_guard_threshold(),
                },
                "cycle": {
                    "completed": self.cycle_sidecar_success,
                    "limit": download_cycle_limit(),
                    "cooldown_minutes": download_cycle_cooldown_seconds() // 60,
                },
            }

    def _run_supervisor(self, job_id: int, concurrency: int) -> None:
        workers = [
            threading.Thread(target=self._worker, args=(job_id, i + 1), daemon=True)
            for i in range(concurrency)
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        with self.lock:
            stopped = self.stop_event.is_set()
            profile_id = self.profile_id
            self.active = False
            self.processes.clear()
        with db() as conn:
            stats = link_stats(conn, profile_id)
        update_job(
            job_id,
            status="stopped" if stopped else "complete",
            finished_at=now_iso(),
            total=stats["total"],
            processed=stats["downloaded"] + stats["failed"],
            success=stats["downloaded"],
            failed=stats["failed"],
            message="已停止" if stopped else "下载队列处理完成",
        )
        add_event("info", "下载任务已停止" if stopped else "下载任务完成")

    def _claim_next(self) -> sqlite3.Row | None:
        with self.lock:
            if self.limit > 0 and self.claimed >= self.limit:
                return None
            profile_id = self.profile_id
        if profile_id is None:
            return None
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                f"SELECT * FROM links WHERE status='pending' AND profile_id=? ORDER BY {DOWNLOAD_QUEUE_ORDER} LIMIT 1",
                (profile_id,),
            ).fetchone()
            if not row:
                conn.execute("COMMIT")
                return None
            conn.execute(
                "UPDATE links SET status='downloading', attempts=attempts+1, last_started_at=?, failed_at=NULL, last_error=NULL "
                "WHERE id=?",
                (now_iso(), row["id"]),
            )
            conn.execute("COMMIT")
            with self.lock:
                self.claimed += 1
            return row

    def _worker(self, job_id: int, worker_id: int) -> None:
        while not self.stop_event.is_set():
            link = self._claim_next()
            if not link:
                return
            self._run_one(job_id, worker_id, link)

    def _run_one(self, job_id: int, worker_id: int, link: sqlite3.Row) -> None:
        output_dir = profile_output_dir(setting("output_dir", str(DEFAULT_OUTPUT_DIR)), int(link["profile_id"] or 0))
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        music_backfill = row_text(link, "download_intent") == GALLERY_MUSIC_INTENT
        if not music_backfill and manifest_has(output_dir, link["aweme_id"]):
            self._mark_downloaded(link, output_dir, "manifest 已存在，跳过")
            return
        existing = None if music_backfill else existing_downloaded_work(link["aweme_id"], link["id"])
        if existing:
            self._mark_downloaded(
                link,
                existing["output_dir"],
                f"复用已下载文件 #{existing['source_link_id']}",
                existing["record"],
            )
            return

        try:
            command, downloader_cwd = downloader_command(
                ["--config", str(write_config(link, output_dir, worker_id)), "--path", output_dir]
            )
        except RuntimeError as exc:
            self._mark_failed(link, str(exc))
            return

        log_path = LOG_DIR / f"download-link-{link['id']}-w{worker_id}.log"
        err_path = LOG_DIR / f"download-link-{link['id']}-w{worker_id}.err.log"
        env = os.environ.copy()
        env.update(
            {
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8:replace",
                "PYTHONLEGACYWINDOWSSTDIO": "0",
            }
        )
        with log_path.open("ab") as stdout, err_path.open("ab") as stderr:
            proc = subprocess.Popen(
                command,
                cwd=str(downloader_cwd),
                stdout=stdout,
                stderr=stderr,
                env=env,
            )
            with self.lock:
                self.processes[link["id"]] = proc
            code = proc.wait()
            with self.lock:
                self.processes.pop(link["id"], None)

        if self.stop_event.is_set():
            self._mark_pending(link, "下载被停止，等待下次继续")
            return
        if code == 0 and manifest_has(output_dir, link["aweme_id"]):
            self._mark_downloaded(link, output_dir, "")
        elif code == 0:
            self._mark_failed(link, "下载器退出 0，但 manifest 里没有该作品记录")
        else:
            err_tail = tail_text(err_path, 1200)
            self._mark_failed(link, f"下载器退出码 {code}: {err_tail}".strip())

    def _mark_downloaded(
        self,
        link: sqlite3.Row,
        output_dir: str,
        note: str,
        record: dict[str, Any] | None = None,
    ) -> None:
        record = record or manifest_record(output_dir, link["aweme_id"])
        metadata = work_metadata_from_record(record, output_dir) if record else {}
        music_backfill = row_text(link, "download_intent") == GALLERY_MUSIC_INTENT
        music_status = None
        music_checked_at = None
        if music_backfill:
            music_status = "downloaded" if manifest_has_gallery_music(record) else "unavailable"
            music_checked_at = now_iso()
        with db() as conn:
            conn.execute(
                """
                UPDATE links SET
                  status='downloaded',
                  downloaded_at=?,
                  failed_at=NULL,
                  output_dir=?,
                  last_error=?,
                  desc=COALESCE(?, desc),
                  media_type=COALESCE(?, media_type),
                  create_time=COALESCE(?, create_time),
                  local_file_names=COALESCE(?, local_file_names),
                  local_file_paths=COALESCE(?, local_file_paths),
                  local_cover_path=COALESCE(?, local_cover_path),
                  preview_path=COALESCE(?, preview_path),
                  metadata_json=COALESCE(?, metadata_json),
                  music_id=COALESCE(?, music_id),
                  music_title=COALESCE(?, music_title),
                  music_author=COALESCE(?, music_author),
                  music_cover_url=COALESCE(?, music_cover_url),
                  music_play_url=COALESCE(?, music_play_url),
                  local_music_path=COALESCE(?, local_music_path),
                  gallery_music_status=COALESCE(?, gallery_music_status),
                  gallery_music_checked_at=COALESCE(?, gallery_music_checked_at),
                  download_intent=CASE WHEN ? THEN NULL ELSE download_intent END
                WHERE id=?
                """,
                (
                    now_iso(),
                    output_dir,
                    note or None,
                    metadata.get("desc") or None,
                    metadata.get("media_type") or None,
                    metadata.get("create_time"),
                    metadata.get("local_file_names") or None,
                    metadata.get("local_file_paths") or None,
                    metadata.get("local_cover_path") or None,
                    metadata.get("preview_path") or None,
                    metadata.get("metadata_json") or None,
                    metadata.get("music_id") or None,
                    metadata.get("music_title") or None,
                    metadata.get("music_author") or None,
                    metadata.get("music_cover_url") or None,
                    metadata.get("music_play_url") or None,
                    metadata.get("local_music_path") or None,
                    music_status,
                    music_checked_at,
                    1 if music_backfill else 0,
                    link["id"],
                ),
            )
            if music_backfill:
                conn.execute(
                    """
                    UPDATE links SET
                      local_file_names=COALESCE(?, local_file_names),
                      local_file_paths=COALESCE(?, local_file_paths),
                      local_cover_path=COALESCE(?, local_cover_path),
                      preview_path=COALESCE(?, preview_path),
                      metadata_json=COALESCE(?, metadata_json),
                      music_id=COALESCE(?, music_id),
                      music_title=COALESCE(?, music_title),
                      music_author=COALESCE(?, music_author),
                      music_cover_url=COALESCE(?, music_cover_url),
                      music_play_url=COALESCE(?, music_play_url),
                      local_music_path=COALESCE(?, local_music_path),
                      gallery_music_status=?,
                      gallery_music_checked_at=?
                    WHERE aweme_id=? AND id<>? AND status='downloaded'
                    """,
                    (
                        metadata.get("local_file_names") or None,
                        metadata.get("local_file_paths") or None,
                        metadata.get("local_cover_path") or None,
                        metadata.get("preview_path") or None,
                        metadata.get("metadata_json") or None,
                        metadata.get("music_id") or None,
                        metadata.get("music_title") or None,
                        metadata.get("music_author") or None,
                        metadata.get("music_cover_url") or None,
                        metadata.get("music_play_url") or None,
                        metadata.get("local_music_path") or None,
                        music_status,
                        music_checked_at,
                        link["aweme_id"],
                        link["id"],
                    ),
                )
            if record:
                profile_ids = [int(link["profile_id"])] if link["profile_id"] is not None else []
                if music_backfill:
                    profile_ids = [
                        int(row["profile_id"])
                        for row in conn.execute(
                            "SELECT DISTINCT profile_id FROM links WHERE aweme_id=? AND profile_id IS NOT NULL",
                            (link["aweme_id"],),
                        ).fetchall()
                    ]
                for profile_id in profile_ids:
                    sync_manifest_files(
                        conn,
                        profile_id,
                        str(link["aweme_id"]),
                        output_dir,
                        record,
                    )
        try:
            with db() as conn:
                fresh_link = conn.execute("SELECT * FROM links WHERE id=?", (link["id"],)).fetchone() or link
            fanhao_upsert_downloaded(fresh_link, output_dir, record)
        except Exception as exc:
            add_event("warn", f"FanHao 直写入库异常 {link['aweme_id']}: {str(exc)[:180]}")

    def _mark_failed(self, link: sqlite3.Row, error: str) -> None:
        music_backfill = row_text(link, "download_intent") == GALLERY_MUSIC_INTENT
        with db() as conn:
            conn.execute(
                "UPDATE links SET status='failed', failed_at=?, last_error=?, "
                "gallery_music_status=CASE WHEN ? THEN 'failed' ELSE gallery_music_status END WHERE id=?",
                (now_iso(), error[:2000], 1 if music_backfill else 0, link["id"]),
            )
        add_event("error", f"{link['aweme_id']} 下载失败：{error[:180]}")

    def _mark_pending(self, link: sqlite3.Row, error: str) -> None:
        with db() as conn:
            conn.execute(
                "UPDATE links SET status='pending', failed_at=NULL, last_error=? WHERE id=?",
                (error, link["id"]),
            )


class SidecarDownloadManager(DownloadManager):
    def __init__(self) -> None:
        super().__init__()
        self.sidecar_signature: tuple[str, int, str] | None = None
        self.watch_new = True
        self.active_job_started: dict[str, float] = {}

    def start(
        self,
        concurrency: int,
        retry_failed: bool = False,
        limit: int = 0,
        profile_id: int | None = None,
        watch_new: bool = True,
        manual: bool = True,
    ) -> dict[str, Any]:
        concurrency = normalize_int(concurrency, 8, 1, MAX_CONCURRENCY)
        limit = normalize_int(limit, 0, 0, 1000000)
        if profile_id is None:
            return {"ok": False, "message": "当前主页还没有入库，请先采集链接"}
        with self.lock:
            if self.active:
                return {"ok": False, "message": "下载任务已经在运行"}
            if self.failure_guard_until and time.time() < self.failure_guard_until and not manual:
                return {
                    "ok": False,
                    "message": f"下载保护暂停中，预计 {iso_from_timestamp(self.failure_guard_until)} 后自动重试",
                }
            if manual or not self.failure_guard_until or time.time() >= self.failure_guard_until:
                self._clear_failure_guard_locked()
            if retry_failed:
                with db() as conn:
                    conn.execute(
                        "UPDATE links SET status='pending', last_error=NULL WHERE status='failed' AND profile_id=?",
                        (profile_id,),
                    )
            with db() as conn:
                conn.execute(
                    "UPDATE links SET status='pending' WHERE status='downloading' AND profile_id=?",
                    (profile_id,),
                )
                pending = conn.execute(
                    "SELECT COUNT(*) c FROM links WHERE status='pending' AND profile_id=?",
                    (profile_id,),
                ).fetchone()["c"]
                queue_pending = queue_pending_count(conn)
            if pending <= 0 and queue_pending > 0:
                pending = queue_pending
            if pending <= 0 and not watch_new:
                return {"ok": False, "message": "没有待下载链接"}
            run_total = min(pending, limit) if limit > 0 else pending
            mode = "动态监听" if watch_new and limit <= 0 else f"本次 {run_total} 条"
            self.limit = limit
            self.profile_id = profile_id
            self.watch_new = bool(watch_new)
            self.cycle_sidecar_success = 0
            self.stop_event.clear()
            self.job_id = create_job(
                "download",
                f"并发 {concurrency}，{mode}，当前待下载 {pending} 条",
                profile_id,
            )
            download_timing(
                "manager_start",
                job_id=self.job_id,
                profile_id=profile_id,
                concurrency=concurrency,
                pending=pending,
                limit=limit,
                watch_new=self.watch_new,
            )
            self.active = True
            self.supervisor = threading.Thread(
                target=self._run_supervisor,
                args=(self.job_id, concurrency),
                daemon=True,
            )
            self.supervisor.start()
            add_event("info", f"下载启动：并发 {concurrency}，{mode}，当前待下载 {pending} 条")
            return {
                "ok": True,
                "job_id": self.job_id,
                "pending": pending,
                "run_total": run_total,
                "watch_new": self.watch_new,
            }

    def stop(self) -> dict[str, Any]:
        with self.lock:
            had_pause = bool(self.failure_guard_until and time.time() < self.failure_guard_until)
            had_work = self.active or self.sidecar_proc is not None or had_pause
            if had_pause:
                self._clear_failure_guard_locked()
            self.stop_event.set()
            proc = self.sidecar_proc
            self.sidecar_proc = None
            self.sidecar_port = None
            self.sidecar_signature = None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=8)
            except Exception:
                try:
                    proc.kill()
                except OSError:
                    pass
        if had_work:
            self._reset_active_jobs("下载被停止，等待下次继续")
            add_event("warn", "下载自动恢复已取消" if had_pause and proc is None else "sidecar 已停止")
            return {"ok": True}
        return {"ok": False, "message": "当前没有下载任务"}

    def _clear_failure_guard_locked(self) -> None:
        timer = self.auto_resume_timer
        if timer is not None:
            timer.cancel()
        self.failure_guard_until = None
        self.failure_guard_reason = ""
        self.failure_guard_kind = ""
        self.failure_guard_consecutive = 0
        self.auto_resume_config = None
        self.auto_resume_timer = None
        set_setting(DOWNLOAD_GUARD_STATE_SETTING, "{}")

    def restore_failure_guard(self) -> bool:
        try:
            state = json.loads(setting(DOWNLOAD_GUARD_STATE_SETTING, "{}") or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            state = {}
        until = float(state.get("until") or 0)
        if until <= time.time():
            set_setting(DOWNLOAD_GUARD_STATE_SETTING, "{}")
            return False
        concurrency = normalize_int(state.get("concurrency", setting("concurrency", "8")), 8, 1, MAX_CONCURRENCY)
        limit = normalize_int(state.get("limit", 0), 0, 0, 1000000)
        profile_id = normalize_int(state.get("profile_id", 0), 0, 0, 1000000) or None
        watch_new = bool(state.get("watch_new", True))
        remaining = max(0.1, until - time.time())
        with self.lock:
            self.failure_guard_until = until
            self.failure_guard_reason = first_text(state.get("reason"))
            self.failure_guard_kind = first_text(state.get("kind"), "failure_guard")
            self.failure_guard_consecutive = normalize_int(state.get("consecutive", 0), 0, 0, 1000000)
            self.auto_resume_config = (concurrency, limit, profile_id, watch_new)
            timer = threading.Timer(remaining, self._auto_resume_after_guard)
            timer.daemon = True
            self.auto_resume_timer = timer
            timer.start()
        add_event("info", f"已恢复下载保护暂停，{iso_from_timestamp(until)} 后自动重试")
        return True

    def _record_failure_guard_outcome(self, ok: int, bad: int) -> bool:
        if ok > 0:
            with self.lock:
                self.failure_guard_consecutive = 0
            return False
        if bad <= 0:
            return False
        threshold = failure_guard_threshold()
        if threshold <= 0:
            return False
        with self.lock:
            self.failure_guard_consecutive += bad
            return self.failure_guard_consecutive >= threshold

    def _enter_failure_guard(
        self,
        job_id: int,
        concurrency: int,
        limit: int,
        profile_id: int | None,
        watch_new: bool,
    ) -> None:
        consecutive = self.failure_guard_consecutive
        reason = f"连续 {consecutive} 次下载失败，疑似触发平台保护"
        until = self._schedule_auto_resume(
            concurrency,
            limit,
            profile_id,
            watch_new,
            FAILURE_GUARD_COOLDOWN_SECONDS,
            "failure_guard",
            reason,
        )
        message = f"连续 {consecutive} 次下载失败，已暂停下载；{iso_from_timestamp(until)} 后自动重试"
        add_event("warn", message)
        update_job(job_id, message=message)
        download_timing(
            "failure_guard_enter",
            job_id=job_id,
            profile_id=profile_id,
            concurrency=concurrency,
            consecutive=consecutive,
            cooldown_seconds=FAILURE_GUARD_COOLDOWN_SECONDS,
            resume_at=iso_from_timestamp(until),
        )

    def _enter_cycle_cooldown(
        self,
        job_id: int,
        concurrency: int,
        limit: int,
        profile_id: int | None,
        watch_new: bool,
        completed: int,
    ) -> None:
        cooldown_seconds = download_cycle_cooldown_seconds()
        cooldown_minutes = cooldown_seconds // 60
        reason = f"本轮已完成 {completed} 个实际下载，主动休息 {cooldown_minutes} 分钟"
        until = self._schedule_auto_resume(
            concurrency,
            limit,
            profile_id,
            watch_new,
            cooldown_seconds,
            "cycle_limit",
            reason,
        )
        message = f"{reason}；{iso_from_timestamp(until)} 后自动继续"
        add_event("info", message)
        update_job(job_id, message=message)
        download_timing(
            "cycle_cooldown_enter",
            job_id=job_id,
            profile_id=profile_id,
            concurrency=concurrency,
            completed=completed,
            cycle_limit=download_cycle_limit(),
            cooldown_seconds=cooldown_seconds,
            resume_at=iso_from_timestamp(until),
        )

    def _schedule_auto_resume(
        self,
        concurrency: int,
        limit: int,
        profile_id: int | None,
        watch_new: bool,
        cooldown_seconds: int,
        kind: str,
        reason: str,
    ) -> float:
        until = time.time() + cooldown_seconds
        with self.lock:
            self.failure_guard_until = until
            self.failure_guard_reason = reason
            self.failure_guard_kind = kind
            self.auto_resume_config = (concurrency, limit, profile_id, watch_new)
            if self.auto_resume_timer is not None:
                self.auto_resume_timer.cancel()
            timer = threading.Timer(cooldown_seconds, self._auto_resume_after_guard)
            timer.daemon = True
            self.auto_resume_timer = timer
            timer.start()
        set_setting(
            DOWNLOAD_GUARD_STATE_SETTING,
            json.dumps(
                {
                    "until": until,
                    "reason": reason,
                    "kind": kind,
                    "consecutive": self.failure_guard_consecutive,
                    "concurrency": concurrency,
                    "limit": limit,
                    "profile_id": profile_id,
                    "watch_new": watch_new,
                },
                ensure_ascii=False,
            ),
        )
        return until

    def _auto_resume_after_guard(self) -> None:
        with self.lock:
            config = self.auto_resume_config
            pause_kind = self.failure_guard_kind
            if self.active or not config:
                return
            concurrency, limit, profile_id, watch_new = config
            if self.failure_guard_until and time.time() < self.failure_guard_until:
                remaining = max(0.1, self.failure_guard_until - time.time())
                timer = threading.Timer(remaining, self._auto_resume_after_guard)
                timer.daemon = True
                self.auto_resume_timer = timer
                timer.start()
                return
            self.failure_guard_until = None
            self.failure_guard_reason = ""
            self.failure_guard_kind = ""
            self.failure_guard_consecutive = 0
            self.auto_resume_config = None
            self.auto_resume_timer = None
        set_setting(DOWNLOAD_GUARD_STATE_SETTING, "{}")
        add_event("info", "主动休息结束，自动恢复下载" if pause_kind == "cycle_limit" else "下载保护冷却结束，自动恢复下载")
        self.start(
            concurrency,
            retry_failed=False,
            limit=limit,
            profile_id=profile_id or current_profile_id(create=False),
            watch_new=watch_new,
            manual=False,
        )

    def _run_supervisor(self, job_id: int, concurrency: int) -> None:
        profile_id = self.profile_id
        if profile_id is None:
            update_job(job_id, status="failed", finished_at=now_iso(), message="当前主页不存在")
            return
        output_dir = profile_output_dir(setting("output_dir", str(DEFAULT_OUTPUT_DIR)), profile_id)
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        download_timing(
            "supervisor_start",
            job_id=job_id,
            profile_id=profile_id,
            concurrency=concurrency,
            output_dir=output_dir,
        )

        total = processed = success = failed = 0
        sidecar_success = 0
        active: dict[str, sqlite3.Row] = {}
        target_limit = self.limit
        watch_new = self.watch_new
        max_active = max(1, concurrency)
        cycle_limit = download_cycle_limit()
        stopped = False
        guard_triggered = False
        cycle_pause_triggered = False
        try:
            update_job(job_id, total=total, processed=0, success=0, failed=0)
            port = self._ensure_sidecar(output_dir, concurrency)
            wait_message_at = 0.0
            while not self.stop_event.is_set():
                self._raise_if_sidecar_exited()
                if cycle_limit > 0 and sidecar_success >= cycle_limit:
                    self._enter_cycle_cooldown(
                        job_id,
                        concurrency,
                        target_limit,
                        profile_id,
                        watch_new,
                        sidecar_success,
                    )
                    cycle_pause_triggered = True
                    self.stop_event.set()
                    break
                remaining = None
                if target_limit > 0:
                    remaining = target_limit - (processed + len(active))
                    claim_allowed = max(0, remaining)
                else:
                    claim_allowed = max_active
                if cycle_limit > 0:
                    cycle_remaining = max(0, cycle_limit - sidecar_success - len(active))
                    claim_allowed = min(claim_allowed, cycle_remaining)

                capacity = min(max_active - len(active), claim_allowed)
                if capacity > 0:
                    links = self._claim_queue_batch(profile_id, capacity)
                    if links:
                        first_profile_id = int(links[0]["profile_id"] or profile_id)
                        if first_profile_id != profile_id:
                            profile_id = first_profile_id
                            with self.lock:
                                self.profile_id = profile_id
                        total += len(links)
                        update_job(job_id, total=total, message=f"下载中：已入队 {total} 条，处理中 {len(active)} 条")
                        done, ok, bad = self._submit_links(job_id, port, links, output_dir, active)
                        processed += done
                        success += ok
                        failed += bad
                        update_job(job_id, processed=processed, success=success, failed=failed)
                        if self._record_failure_guard_outcome(ok, bad):
                            self._enter_failure_guard(job_id, concurrency, target_limit, profile_id, watch_new)
                            guard_triggered = True
                            self.stop_event.set()
                            break

                done, ok, bad = self._poll_active_sidecar_jobs(job_id, port, active, output_dir)
                if done:
                    processed += done
                    success += ok
                    failed += bad
                    sidecar_success += ok
                    with self.lock:
                        self.cycle_sidecar_success = sidecar_success
                    update_job(job_id, processed=processed, success=success, failed=failed)
                    if self._record_failure_guard_outcome(ok, bad):
                        self._enter_failure_guard(job_id, concurrency, target_limit, profile_id, watch_new)
                        guard_triggered = True
                        self.stop_event.set()
                        break

                if active:
                    time.sleep(0.8)
                    continue
                if target_limit > 0 and processed >= target_limit:
                    break
                pending = self._queue_pending_count()
                if pending > 0:
                    continue
                if not watch_new:
                    break
                if time.time() - wait_message_at > 5:
                    update_job(
                        job_id,
                        message=f"等待新链接：已处理 {processed} 条，sidecar 端口 {port}",
                    )
                    wait_message_at = time.time()
                time.sleep(1.0)
        except Exception as exc:
            download_timing("supervisor_error", job_id=job_id, profile_id=profile_id, error=str(exc)[:1000])
            add_event("error", f"sidecar 下载任务异常：{exc}")
            update_job(job_id, status="failed", finished_at=now_iso(), message=str(exc)[:2000])
            self._reset_active_jobs("sidecar 异常，已重置为待下载")
            return
        finally:
            if self.stop_event.is_set():
                stopped = True
                self._stop_sidecar_process()
                for link in active.values():
                    self._mark_pending(link, "下载被停止，等待下次继续")
                active.clear()
            with self.lock:
                self.active = False
                self.active_jobs.clear()
                self.active_job_started.clear()

        if self._job_status(job_id) == "running":
            update_job(
                job_id,
                status="stopped" if stopped else "complete",
                finished_at=now_iso(),
                total=total,
                processed=processed,
                success=success,
                failed=failed,
                message=(
                    "主动分段暂停，等待自动恢复"
                    if cycle_pause_triggered
                    else "保护暂停，等待换 IP 或自动恢复"
                    if guard_triggered
                    else "已停止"
                    if stopped
                    else "下载队列处理完成"
                ),
            )
        add_event(
            "warn" if guard_triggered else "info",
            "下载主动休息" if cycle_pause_triggered else "下载保护暂停" if guard_triggered else ("下载任务已停止" if stopped else "下载任务完成"),
        )
        download_timing(
            "supervisor_done",
            job_id=job_id,
            profile_id=profile_id,
            stopped=stopped,
            guard_triggered=guard_triggered,
            cycle_pause_triggered=cycle_pause_triggered,
            sidecar_success=sidecar_success,
            cycle_limit=cycle_limit,
            total=total,
            processed=processed,
            success=success,
            failed=failed,
        )

    def _claim_batch(self, profile_id: int, limit: int) -> list[sqlite3.Row]:
        if limit <= 0:
            return []
        sql_limit = "LIMIT ?"
        params: list[Any] = [profile_id]
        params.append(limit)
        with db() as conn:
            rows = conn.execute(
                f"SELECT * FROM links WHERE status='pending' AND profile_id=? ORDER BY {DOWNLOAD_QUEUE_ORDER} {sql_limit}",
                params,
            ).fetchall()
            ids = [row["id"] for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                conn.execute(
                    f"UPDATE links SET status='downloading', attempts=attempts+1, last_started_at=?, failed_at=NULL, last_error=NULL "
                    f"WHERE id IN ({placeholders})",
                    [now_iso(), *ids],
                )
        if rows:
            download_timing(
                "claim_batch",
                profile_id=profile_id,
                count=len(rows),
                first_link_id=rows[0]["id"],
                first_aweme_id=rows[0]["aweme_id"],
                last_link_id=rows[-1]["id"],
                last_aweme_id=rows[-1]["aweme_id"],
            )
        return rows

    def _claim_queue_batch(self, preferred_profile_id: int | None, limit: int) -> list[sqlite3.Row]:
        if limit <= 0:
            return []
        profile_ids: list[int] = []
        with db() as conn:
            sync_download_queue(conn)
            rows = conn.execute(
                """
                SELECT q.profile_id
                FROM profile_download_queue q
                WHERE q.enabled=1
                  AND EXISTS (
                    SELECT 1 FROM links
                    WHERE links.profile_id=q.profile_id AND links.status='pending'
                  )
                ORDER BY q.sort_order, q.profile_id
                """,
            ).fetchall()
            profile_ids.extend(int(row["profile_id"]) for row in rows if int(row["profile_id"]) not in profile_ids)

        claimed: list[sqlite3.Row] = []
        for profile_id in profile_ids:
            remaining = limit - len(claimed)
            if remaining <= 0:
                break
            claimed.extend(self._claim_batch(profile_id, remaining))
        if claimed:
            profile_counts: dict[str, int] = {}
            for link in claimed:
                key = str(link["profile_id"] or "")
                profile_counts[key] = profile_counts.get(key, 0) + 1
            download_timing(
                "claim_queue_batch",
                preferred_profile_id=preferred_profile_id,
                count=len(claimed),
                profiles=profile_counts,
            )
        return claimed

    def _pending_count(self, profile_id: int) -> int:
        with db() as conn:
            return int(
                conn.execute(
                    "SELECT COUNT(*) c FROM links WHERE status='pending' AND profile_id=?",
                    (profile_id,),
                ).fetchone()["c"]
            )

    def _queue_pending_count(self) -> int:
        with db() as conn:
            return queue_pending_count(conn)

    def _ensure_sidecar(self, output_dir: str, concurrency: int) -> int:
        proxy = normalize_proxy(setting("download_proxy", ""))
        signature = (str(Path(output_dir).resolve()), concurrency, proxy)
        with self.lock:
            proc = self.sidecar_proc
            port = self.sidecar_port
            if proc is not None and proc.poll() is None and port and self.sidecar_signature == signature:
                download_timing("sidecar_reuse", port=port, concurrency=concurrency, output_dir=output_dir, proxy=proxy)
                return port

        download_timing("sidecar_restart_needed", concurrency=concurrency, output_dir=output_dir, proxy=proxy)
        self._stop_sidecar_process()
        port = self._start_sidecar(output_dir, concurrency)
        with self.lock:
            self.sidecar_signature = signature
        return port

    def _start_sidecar(self, output_dir: str, concurrency: int) -> int:
        config_path = write_sidecar_config(output_dir, concurrency)
        port = free_port()
        command, downloader_cwd = downloader_command(
            [
                "--serve",
                "--config",
                str(config_path),
                "--serve-host",
                "127.0.0.1",
                "--serve-port",
                str(port),
            ]
        )
        stamp = int(time.time())
        started = time.monotonic()
        log_path = LOG_DIR / f"sidecar-{stamp}.log"
        err_path = LOG_DIR / f"sidecar-{stamp}.err.log"
        env = os.environ.copy()
        env.update(
            {
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8:replace",
                "PYTHONLEGACYWINDOWSSTDIO": "0",
                "DOUYIN_TIMING_DIR": str(LOG_DIR),
            }
        )
        download_timing(
            "sidecar_start_begin",
            port=port,
            concurrency=concurrency,
            output_dir=output_dir,
            config_path=str(config_path),
        )
        stdout = log_path.open("ab")
        stderr = err_path.open("ab")
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(downloader_cwd),
                stdout=stdout,
                stderr=stderr,
                env=env,
            )
        finally:
            stdout.close()
            stderr.close()

        with self.lock:
            self.sidecar_proc = proc
            self.sidecar_port = port
        deadline = time.time() + 30
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"sidecar 启动失败，退出码 {proc.returncode}: {tail_text(err_path, 1200)}")
            try:
                sidecar_json(port, "GET", "/api/v1/health")
                proxy_text = f"，代理 {normalize_proxy(setting('download_proxy', ''))}" if normalize_proxy(setting("download_proxy", "")) else ""
                add_event("info", f"sidecar 已启动：端口 {port}，并发 {concurrency}{proxy_text}")
                download_timing(
                    "sidecar_start_ready",
                    port=port,
                    concurrency=concurrency,
                    output_dir=output_dir,
                    startup_ms=elapsed_ms(started),
                )
                return port
            except Exception:
                time.sleep(0.5)
        raise RuntimeError(f"sidecar 启动超时: {tail_text(err_path, 1200)}")

    def _submit_links(
        self,
        job_id: int,
        port: int,
        links: list[sqlite3.Row],
        output_dir: str,
        active: dict[str, sqlite3.Row],
    ) -> tuple[int, int, int]:
        processed = success = failed = 0
        for link in links:
            music_backfill = row_text(link, "download_intent") == GALLERY_MUSIC_INTENT
            submit_started = time.monotonic()
            download_timing(
                "submit_begin",
                job_id=job_id,
                link_id=link["id"],
                profile_id=link["profile_id"],
                aweme_id=link["aweme_id"],
                url=link["url"],
                active_before=len(active),
            )
            if self.stop_event.is_set():
                self._mark_pending(link, "下载被停止，等待下次继续")
                download_timing(
                    "submit_cancelled",
                    job_id=job_id,
                    link_id=link["id"],
                    aweme_id=link["aweme_id"],
                    elapsed_ms=elapsed_ms(submit_started),
                )
                continue
            if not music_backfill and manifest_has(output_dir, link["aweme_id"]):
                self._mark_downloaded(link, output_dir, "manifest 已存在，跳过")
                download_timing(
                    "skip_manifest",
                    job_id=job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    elapsed_ms=elapsed_ms(submit_started),
                )
                processed += 1
                success += 1
                continue
            existing = None if music_backfill else existing_downloaded_work(link["aweme_id"], link["id"])
            if existing:
                self._mark_downloaded(
                    link,
                    existing["output_dir"],
                    f"复用已下载文件 #{existing['source_link_id']}",
                    existing["record"],
                )
                download_timing(
                    "reuse_downloaded",
                    job_id=job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    source_link_id=existing["source_link_id"],
                    source_profile_id=existing["source_profile_id"],
                    elapsed_ms=elapsed_ms(submit_started),
                )
                processed += 1
                success += 1
                continue
            try:
                resp = sidecar_json(port, "POST", "/api/v1/download", {"url": link["url"]})
                sidecar_job_id = str(resp["job_id"])
                active[sidecar_job_id] = link
                with self.lock:
                    self.active_jobs[sidecar_job_id] = link
                    self.active_job_started[sidecar_job_id] = time.monotonic()
                download_timing(
                    "submit_ok",
                    job_id=job_id,
                    sidecar_job_id=sidecar_job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    submit_ms=elapsed_ms(submit_started),
                    active_after=len(active),
                )
            except Exception as exc:
                if not music_backfill and manifest_has(output_dir, link["aweme_id"]):
                    self._mark_downloaded(link, output_dir, "sidecar 提交超时后 manifest 已存在")
                    download_timing(
                        "submit_timeout_manifest_found",
                        job_id=job_id,
                        link_id=link["id"],
                        profile_id=link["profile_id"],
                        aweme_id=link["aweme_id"],
                        error=str(exc)[:500],
                        elapsed_ms=elapsed_ms(submit_started),
                    )
                    processed += 1
                    success += 1
                    continue
                existing = None if music_backfill else existing_downloaded_work(link["aweme_id"], link["id"])
                if existing:
                    self._mark_downloaded(
                        link,
                        existing["output_dir"],
                        f"提交超时后复用已下载文件 #{existing['source_link_id']}",
                        existing["record"],
                    )
                    download_timing(
                        "submit_timeout_reuse_downloaded",
                        job_id=job_id,
                        link_id=link["id"],
                        profile_id=link["profile_id"],
                        aweme_id=link["aweme_id"],
                        source_link_id=existing["source_link_id"],
                        source_profile_id=existing["source_profile_id"],
                        error=str(exc)[:500],
                        elapsed_ms=elapsed_ms(submit_started),
                    )
                    processed += 1
                    success += 1
                    continue
                if self._recover_sidecar_submission(port, link, active):
                    add_event("warn", f"{link['aweme_id']} 提交 sidecar 超时，但已找回运行中的 sidecar 任务")
                    download_timing(
                        "submit_recovered",
                        job_id=job_id,
                        link_id=link["id"],
                        profile_id=link["profile_id"],
                        aweme_id=link["aweme_id"],
                        error=str(exc)[:500],
                        elapsed_ms=elapsed_ms(submit_started),
                    )
                    continue
                self._mark_failed(link, f"提交 sidecar 任务失败：{exc}")
                download_timing(
                    "submit_failed",
                    job_id=job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    error=str(exc)[:1000],
                    elapsed_ms=elapsed_ms(submit_started),
                )
                processed += 1
                failed += 1
        return processed, success, failed

    def _recover_sidecar_submission(
        self,
        port: int,
        link: sqlite3.Row,
        active: dict[str, sqlite3.Row],
    ) -> bool:
        try:
            payload = sidecar_json(port, "GET", "/api/v1/jobs")
        except Exception:
            return False
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            return False
        matches = [
            job
            for job in jobs
            if str(job.get("url") or "") == str(link["url"])
            and str(job.get("status") or "") in {"running", "success", "failed"}
            and job.get("job_id")
        ]
        if not matches:
            return False
        matches.sort(key=lambda job: str(job.get("created_at") or ""))
        sidecar_job_id = str(matches[-1]["job_id"])
        active[sidecar_job_id] = link
        with self.lock:
            self.active_jobs[sidecar_job_id] = link
            self.active_job_started[sidecar_job_id] = time.monotonic()
        return True

    def _poll_active_sidecar_jobs(
        self,
        job_id: int,
        port: int,
        active: dict[str, sqlite3.Row],
        output_dir: str,
    ) -> tuple[int, int, int]:
        processed = success = failed = 0
        for sidecar_job_id, link in list(active.items()):
            try:
                state = sidecar_json(port, "GET", f"/api/v1/jobs/{sidecar_job_id}")
            except Exception:
                continue
            status = str(state.get("status") or "")
            if status not in {"success", "failed"}:
                continue
            active.pop(sidecar_job_id, None)
            with self.lock:
                self.active_jobs.pop(sidecar_job_id, None)
                started = self.active_job_started.pop(sidecar_job_id, None)
            sidecar_elapsed = elapsed_ms(started)
            if status == "success" and (int(state.get("success") or 0) > 0 or manifest_has(output_dir, link["aweme_id"])):
                mark_started = time.monotonic()
                self._mark_downloaded(link, output_dir, "")
                download_timing(
                    "sidecar_job_done",
                    job_id=job_id,
                    sidecar_job_id=sidecar_job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    status=status,
                    sidecar_total=state.get("total"),
                    sidecar_success=state.get("success"),
                    sidecar_failed=state.get("failed"),
                    sidecar_skipped=state.get("skipped"),
                    sidecar_elapsed_ms=sidecar_elapsed,
                    mark_ms=elapsed_ms(mark_started),
                )
                success += 1
            else:
                error = state.get("error") or f"sidecar job {status}: {state}"
                error_text = str(error)
                anti_bot = is_antibot_error(error_text)
                if anti_bot:
                    self._mark_pending(link, f"详情接口疑似风控，等待换 IP 或冷却后重试：{error_text[:500]}")
                    with self.lock:
                        self.failure_guard_consecutive = max(
                            self.failure_guard_consecutive,
                            max(0, failure_guard_threshold() - 1),
                        )
                    add_event("warn", f"{link['aweme_id']} 详情接口疑似风控，已转回待下载")
                else:
                    self._mark_failed(link, error_text)
                download_timing(
                    "sidecar_job_done",
                    job_id=job_id,
                    sidecar_job_id=sidecar_job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    status=status,
                    sidecar_total=state.get("total"),
                    sidecar_success=state.get("success"),
                    sidecar_failed=state.get("failed"),
                    sidecar_skipped=state.get("skipped"),
                    sidecar_elapsed_ms=sidecar_elapsed,
                    error=error_text[:1000],
                    anti_bot=anti_bot,
                )
                failed += 1
            processed += 1
        return processed, success, failed

    def _job_status(self, job_id: int) -> str | None:
        with db() as conn:
            row = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            return row["status"] if row else None

    def _raise_if_sidecar_exited(self) -> None:
        with self.lock:
            proc = self.sidecar_proc
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"sidecar 已退出，退出码 {proc.returncode}")

    def _reset_active_jobs(self, message: str) -> None:
        with self.lock:
            links = list(self.active_jobs.values())
            self.active_jobs.clear()
            self.active_job_started.clear()
        for link in links:
            self._mark_pending(link, message)

    def _stop_sidecar_process(self) -> None:
        with self.lock:
            proc = self.sidecar_proc
            self.sidecar_proc = None
            self.sidecar_port = None
            self.sidecar_signature = None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=8)
            except Exception:
                try:
                    proc.kill()
                except OSError:
                    pass


download_manager = SidecarDownloadManager()


def tail_text(path: Path, limit: int) -> str:
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    return data[-limit:].decode("utf-8", errors="replace")


def run_extract_job(
    job_id: int,
    url: str,
    max_items: int,
    scrolls: int,
    idle_rounds: int,
    headed: bool,
    incremental_stop_existing: int,
    clear_global: bool = True,
) -> None:
    global extract_thread, extract_job_id, extract_process
    profile_id = upsert_profile(url)
    with db() as conn:
        profile_row = conn.execute("SELECT tab, aweme_count FROM profiles WHERE id=?", (profile_id,)).fetchone()
        profile_tab_for_job = str(profile_row["tab"] or "post") if profile_row else "post"
        profile_aweme_count = int_or_none(profile_row["aweme_count"]) or 0 if profile_row else 0
    out_path = DATA_DIR / f"extract-{uuid.uuid4().hex}.json"
    stream_path = DATA_DIR / f"extract-stream-{job_id}.jsonl"
    log_path = LOG_DIR / f"extract-job-{job_id}.log"
    cookie_file = setting("cookie_file", str(DEFAULT_COOKIE_FILE))
    cmd = [
        NODE_EXECUTABLE,
        str(BASE_DIR / "extract-links.mjs"),
        url,
        "--max",
        str(max_items),
        "--scrolls",
        str(scrolls),
        "--idle-rounds",
        str(idle_rounds),
        "--cookie-file",
        cookie_file,
        "--out",
        str(out_path),
        "--stream-out",
        str(stream_path),
        "--flush-every",
        "25",
    ]
    if headed:
        cmd.append("--headed")

    update_job(job_id, profile_id=profile_id, message="正在采集链接")
    add_event("info", f"开始采集：{url}")
    total_seen = inserted_total = updated_total = 0
    collection_started_at = datetime.now().astimezone()
    like_sequence = 0
    offset = 0
    partial = ""
    incremental_stop_triggered = False
    target_count_stop_triggered = False
    consecutive_existing = 0
    recent_existing_flags: list[bool] = []
    incremental_stop_reason = ""
    existing_aweme_ids: set[str] = set()
    if incremental_stop_existing > 0:
        try:
            with db() as conn:
                existing_aweme_ids = {
                    str(row["aweme_id"] or "").strip()
                    for row in conn.execute(
                        "SELECT aweme_id FROM links WHERE profile_id=? AND COALESCE(aweme_id, '') <> ''",
                        (profile_id,),
                    ).fetchall()
                }
        except sqlite3.Error:
            existing_aweme_ids = set()
    if not existing_aweme_ids:
        incremental_stop_existing = 0

    def consume_stream() -> None:
        nonlocal offset, partial, total_seen, inserted_total, updated_total, consecutive_existing, incremental_stop_triggered, incremental_stop_reason, profile_aweme_count, target_count_stop_triggered, like_sequence
        if not stream_path.exists():
            return
        with stream_path.open("rb") as stream:
            stream.seek(offset)
            data = stream.read()
            offset = stream.tell()
        if not data:
            return
        text = partial + data.decode("utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        if lines and not lines[-1].endswith(("\n", "\r")):
            partial = lines.pop()
        else:
            partial = ""
        for raw in lines:
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            row_type = row.get("type")
            if row_type == "works":
                works = row.get("works") or []
                if profile_tab_for_job == "like":
                    for work in works:
                        if not isinstance(work, dict):
                            continue
                        work["_liked_at"] = (
                            collection_started_at - timedelta(microseconds=like_sequence)
                        ).isoformat(timespec="microseconds")
                        like_sequence += 1
                for work in works:
                    aweme_id = str((work or {}).get("aweme_id") or "").strip()
                    if not aweme_id:
                        continue
                    was_existing = aweme_id in existing_aweme_ids
                    if incremental_stop_existing > 0 and was_existing:
                        consecutive_existing += 1
                    else:
                        consecutive_existing = 0
                    if incremental_stop_existing > 0:
                        recent_existing_flags.append(was_existing)
                        if len(recent_existing_flags) > incremental_stop_existing * 4:
                            del recent_existing_flags[: len(recent_existing_flags) - incremental_stop_existing * 4]
                    existing_aweme_ids.add(aweme_id)
                inserted, updated = upsert_links(profile_id, works)
                inserted_total += inserted
                updated_total += updated
                total_seen = max(total_seen, int(row.get("count") or 0), inserted_total + updated_total)
                update_job(
                    job_id,
                    total=total_seen,
                    processed=total_seen,
                    success=inserted_total,
                    failed=0,
                    message=f"采集中：累计 {total_seen} 条，新 {inserted_total}，已存在 {updated_total}",
                )
                if (
                    profile_tab_for_job == "post"
                    and profile_aweme_count > 0
                    and total_seen >= profile_aweme_count
                    and not target_count_stop_triggered
                    and not incremental_stop_triggered
                ):
                    target_count_stop_triggered = True
                    extract_stop_event.set()
                    proc = extract_process
                    if proc is not None and proc.poll() is None:
                        try:
                            proc.terminate()
                        except OSError:
                            pass
                if (
                    incremental_stop_existing > 0
                    and (
                        consecutive_existing >= incremental_stop_existing
                        or (
                            len(recent_existing_flags) >= incremental_stop_existing * 2
                            and sum(1 for flag in recent_existing_flags if flag)
                            >= max(incremental_stop_existing, int(len(recent_existing_flags) * 0.75))
                        )
                    )
                    and not incremental_stop_triggered
                ):
                    incremental_stop_triggered = True
                    if consecutive_existing >= incremental_stop_existing:
                        incremental_stop_reason = f"连续 {consecutive_existing} 条已存在"
                    else:
                        existing_recent = sum(1 for flag in recent_existing_flags if flag)
                        incremental_stop_reason = f"最近 {len(recent_existing_flags)} 条中 {existing_recent} 条已存在"
                    extract_stop_event.set()
                    proc = extract_process
                    if proc is not None and proc.poll() is None:
                        try:
                            proc.terminate()
                        except OSError:
                            pass
            elif row_type == "profile":
                profile_payload = row.get("profile") or {}
                upsert_profile_metadata(profile_id, profile_payload)
                profile_aweme_count = int_or_none(profile_payload.get("aweme_count") or profile_payload.get("awemeCount")) or profile_aweme_count
            elif row_type == "progress":
                total_seen = max(total_seen, int(row.get("count") or 0))
                update_job(
                    job_id,
                    total=total_seen,
                    processed=total_seen,
                    success=inserted_total,
                    failed=0,
                    message=f"采集中：第 {row.get('round')} 轮，累计 {total_seen} 条",
                )
                if (
                    profile_tab_for_job == "post"
                    and profile_aweme_count > 0
                    and total_seen >= profile_aweme_count
                    and not target_count_stop_triggered
                    and not incremental_stop_triggered
                ):
                    target_count_stop_triggered = True
                    extract_stop_event.set()
                    proc = extract_process
                    if proc is not None and proc.poll() is None:
                        try:
                            proc.terminate()
                        except OSError:
                            pass
            elif row_type == "done":
                total_seen = max(total_seen, int(row.get("count") or 0))
                upsert_profile_metadata(profile_id, row.get("profile") or {})

    try:
        try:
            stream_path.unlink()
        except FileNotFoundError:
            pass
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            proc = subprocess.Popen(
                cmd,
                cwd=str(BASE_DIR),
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            with extract_lock:
                extract_process = proc
            while proc.poll() is None:
                consume_stream()
                time.sleep(1.0)
            consume_stream()
        if extract_stop_event.is_set():
            if target_count_stop_triggered:
                update_job(
                    job_id,
                    status="complete",
                    total=total_seen,
                    processed=total_seen,
                    success=inserted_total,
                    failed=0,
                    finished_at=now_iso(),
                    message=(
                        f"采集完成：已达到主页作品数 {profile_aweme_count}，"
                        f"已入库 {total_seen} 条，新 {inserted_total}，已存在 {updated_total}"
                    ),
                )
                add_event(
                    "info",
                    f"采集完成：已达到主页作品数 {profile_aweme_count}，新 {inserted_total}，已存在 {updated_total}",
                )
                return
            if incremental_stop_triggered:
                update_job(
                    job_id,
                    status="complete",
                    total=total_seen,
                    processed=total_seen,
                    success=inserted_total,
                    failed=0,
                    finished_at=now_iso(),
                    message=(
                        f"增量采集完成：{incremental_stop_reason or f'连续 {consecutive_existing} 条已存在'}，"
                        f"已入库 {total_seen} 条，新 {inserted_total}，已存在 {updated_total}"
                    ),
                )
                add_event(
                    "info",
                    f"增量采集完成：{incremental_stop_reason or f'连续 {consecutive_existing} 条已存在'}，新 {inserted_total}，已存在 {updated_total}",
                )
                return
            update_job(
                job_id,
                status="stopped",
                total=total_seen,
                processed=total_seen,
                success=inserted_total,
                failed=0,
                finished_at=now_iso(),
                message=f"采集已停止：已入库 {total_seen} 条，新 {inserted_total}，已存在 {updated_total}",
            )
            add_event("warn", f"采集已停止：已入库 {total_seen} 条")
            return
        if proc.returncode != 0:
            message = f"采集失败，退出码 {proc.returncode}: {tail_text(log_path, 1200)}"
            update_job(job_id, status="failed", finished_at=now_iso(), message=message)
            add_event("error", message[:260])
            return
        if total_seen == 0 and out_path.exists():
            payload = json.loads(out_path.read_text(encoding="utf-8"))
            upsert_profile_metadata(profile_id, payload.get("profile") or {})
            works = payload.get("works") or []
            inserted, updated = upsert_links(profile_id, works)
            inserted_total += inserted
            updated_total += updated
            total_seen = len(works)
        update_job(
            job_id,
            status="complete",
            total=total_seen,
            processed=total_seen,
            success=inserted_total,
            failed=0,
            finished_at=now_iso(),
            message=f"采集完成：{total_seen} 条，新 {inserted_total}，已存在 {updated_total}",
        )
        add_event("info", f"采集完成：{total_seen} 条，新 {inserted_total}，已存在 {updated_total}")
    except Exception as exc:
        update_job(job_id, status="failed", finished_at=now_iso(), message=str(exc))
        add_event("error", f"采集异常：{exc}")
    finally:
        with extract_lock:
            extract_process = None
            if clear_global:
                extract_thread = None
                extract_job_id = None


def start_extract(payload: dict[str, Any]) -> dict[str, Any]:
    global extract_thread, extract_job_id
    url = str(payload.get("url") or setting("profile_url", TEST_PROFILE_URL)).strip()
    if not url:
        return {"ok": False, "message": "需要主页链接"}
    profile_tab = normalize_profile_tab(payload.get("profile_tab") or setting("profile_tab", "auto"))
    parsed_profile = parse_profile_url(url, profile_tab)
    set_setting("profile_url", parsed_profile["url"])
    set_setting("profile_tab", profile_tab)
    url = parsed_profile["url"]
    max_items = normalize_int(payload.get("max", 0), 0, 0, 100000)
    scrolls = normalize_int(payload.get("scrolls", setting("scrolls", "12000")), 12000, 1, 30000)
    idle_rounds = normalize_int(payload.get("idle_rounds", setting("idle_rounds", "160")), 160, 1, 1000)
    incremental_stop_existing = normalize_int(
        payload.get("incremental_stop_existing", setting("incremental_stop_existing", "12")),
        12,
        0,
        1000,
    )
    headed = bool(payload.get("headed", False))

    with extract_lock:
        if extract_thread is not None and extract_thread.is_alive():
            return {"ok": False, "message": "采集任务已经在运行"}
        extract_stop_event.clear()
        job_id = create_job("extract", "准备采集")
        extract_job_id = job_id
        extract_thread = threading.Thread(
            target=run_extract_job,
            args=(job_id, url, max_items, scrolls, idle_rounds, headed, incremental_stop_existing),
            daemon=True,
        )
        extract_thread.start()
    return {"ok": True, "job_id": job_id}


def run_refresh_profiles_job(
    job_id: int,
    max_profiles: int,
    profile_ids: list[int],
    since_timestamp: int | None,
    max_items: int,
    scrolls: int,
    idle_rounds: int,
    headed: bool,
    incremental_stop_existing: int,
) -> None:
    global extract_thread, extract_job_id, extract_process
    success_profiles = 0
    failed_profiles = 0
    stopped = False
    try:
        with db() as conn:
            rows = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT
                      profiles.id,
                      profiles.url,
                      profiles.tab,
                      profiles.title,
                      profiles.nickname,
                      profiles.unique_id,
                      profiles.short_id,
                      profiles.updated_at,
                      profiles.last_extracted_at,
                      profiles.sec_uid,
                      q.sort_order,
                      COUNT(links.id) link_total,
                      MAX(links.create_time) latest_work_create_time
                    FROM profiles
                    LEFT JOIN profile_download_queue q ON q.profile_id=profiles.id AND q.enabled=1
                    LEFT JOIN links ON links.profile_id=profiles.id
                    WHERE COALESCE(profiles.url, '') <> ''
                    GROUP BY profiles.id
                    ORDER BY
                      CASE WHEN q.profile_id IS NULL THEN 1 ELSE 0 END,
                      COALESCE(q.sort_order, 999999999),
                      COALESCE(profiles.last_extracted_at, profiles.updated_at, profiles.created_at),
                      profiles.id
                    """
                ).fetchall()
            ]
        if profile_ids:
            selected_ids = set(profile_ids)
            rows = [row for row in rows if int(row["id"]) in selected_ids]
        else:
            rows = [
                row
                for row in rows
                if int(row.get("link_total") or 0) > 0
                or (
                    first_text(row.get("sec_uid")) == LIBRARY_SEC_UID
                    and str(row.get("tab") or "post") == "like"
                )
            ]
        if since_timestamp is not None:
            rows = [
                row
                for row in rows
                if str(row.get("tab") or "post") == "like"
                or int_or_none(row.get("latest_work_create_time")) is None
                or int(row["latest_work_create_time"]) >= since_timestamp
            ]
        if max_profiles > 0:
            rows = rows[:max_profiles]
        total_profiles = len(rows)
        update_job(job_id, total=total_profiles, processed=0, success=0, failed=0, message=f"准备刷新 {total_profiles} 个主页")
        if not rows:
            update_job(job_id, status="complete", finished_at=now_iso(), message="没有可刷新的已入库主页")
            return
        add_event("info", f"开始批量刷新现有主页：{total_profiles} 个")
        for index, profile in enumerate(rows, start=1):
            if extract_stop_event.is_set():
                stopped = True
                break
            extract_stop_event.clear()
            label = clean_profile_nickname(profile.get("nickname") or profile.get("title")) or f"主页 #{profile['id']}"
            update_job(
                job_id,
                processed=index - 1,
                success=success_profiles,
                failed=failed_profiles,
                message=f"刷新中：{index}/{total_profiles} {label}",
            )
            sub_job_id = create_job("extract", f"批量刷新 {index}/{total_profiles}: {label}", int(profile["id"]))
            run_extract_job(
                sub_job_id,
                str(profile["url"]),
                max_items,
                scrolls,
                idle_rounds,
                headed,
                incremental_stop_existing,
                clear_global=False,
            )
            with db() as conn:
                sub = conn.execute("SELECT status FROM jobs WHERE id=?", (sub_job_id,)).fetchone()
            sub_status = str(sub["status"] if sub else "")
            if sub_status == "failed":
                failed_profiles += 1
            else:
                success_profiles += 1
            if sub_status == "stopped":
                stopped = True
                break
            update_job(
                job_id,
                processed=index,
                success=success_profiles,
                failed=failed_profiles,
                message=f"刷新进度：{index}/{total_profiles}，成功 {success_profiles}，失败 {failed_profiles}",
            )
        status = "stopped" if stopped else "complete"
        message = (
            f"批量刷新已停止：成功 {success_profiles}，失败 {failed_profiles}"
            if stopped
            else f"批量刷新完成：成功 {success_profiles}，失败 {failed_profiles}"
        )
        update_job(
            job_id,
            status=status,
            processed=success_profiles + failed_profiles,
            success=success_profiles,
            failed=failed_profiles,
            finished_at=now_iso(),
            message=message,
        )
        add_event("warn" if stopped else "info", message)
    except Exception as exc:
        update_job(job_id, status="failed", finished_at=now_iso(), message=str(exc)[:2000])
        add_event("error", f"批量刷新异常：{exc}")
    finally:
        with extract_lock:
            extract_process = None
            extract_thread = None
            extract_job_id = None
        extract_stop_event.clear()


def start_refresh_profiles(payload: dict[str, Any]) -> dict[str, Any]:
    global extract_thread, extract_job_id
    max_profiles = normalize_int(payload.get("max_profiles", 0), 0, 0, 100000)
    raw_profile_ids = payload.get("profile_ids")
    profile_ids: list[int] = []
    if isinstance(raw_profile_ids, list):
        for value in raw_profile_ids:
            profile_id = normalize_int(value, 0, 0, 1000000)
            if profile_id > 0 and profile_id not in profile_ids:
                profile_ids.append(profile_id)
    since_date = str(payload.get("since_date") or "").strip()
    since_timestamp: int | None = None
    if since_date:
        try:
            local_tz = datetime.now().astimezone().tzinfo
            since_timestamp = int(datetime.strptime(since_date, "%Y-%m-%d").replace(tzinfo=local_tz).timestamp())
        except ValueError as exc:
            raise ValueError("主页刷新起始日期格式应为 YYYY-MM-DD") from exc
    max_items = normalize_int(payload.get("max", 0), 0, 0, 100000)
    scrolls = normalize_int(payload.get("scrolls", setting("scrolls", "12000")), 12000, 1, 30000)
    idle_rounds = normalize_int(payload.get("idle_rounds", setting("idle_rounds", "160")), 160, 1, 1000)
    incremental_stop_existing = normalize_int(
        payload.get("incremental_stop_existing", setting("incremental_stop_existing", "12")),
        12,
        0,
        1000,
    )
    headed = bool(payload.get("headed", False))
    with extract_lock:
        if extract_thread is not None and extract_thread.is_alive():
            return {"ok": False, "message": "采集任务已经在运行"}
        extract_stop_event.clear()
        job_id = create_job("refresh", "准备批量刷新现有主页")
        extract_job_id = job_id
        extract_thread = threading.Thread(
            target=run_refresh_profiles_job,
            args=(
                job_id,
                max_profiles,
                profile_ids,
                since_timestamp,
                max_items,
                scrolls,
                idle_rounds,
                headed,
                incremental_stop_existing,
            ),
            daemon=True,
        )
        extract_thread.start()
    return {"ok": True, "job_id": job_id}


def run_following_import_job(
    job_id: int,
    url: str,
    max_users: int,
    scrolls: int,
    idle_rounds: int,
    headed: bool,
) -> None:
    global extract_thread, extract_job_id, extract_process
    out_path = DATA_DIR / f"following-{uuid.uuid4().hex}.json"
    log_path = LOG_DIR / f"following-job-{job_id}.log"
    cmd = [
        NODE_EXECUTABLE,
        str(BASE_DIR / "extract-following.mjs"),
        url,
        "--max",
        str(max_users),
        "--scrolls",
        str(scrolls),
        "--idle-rounds",
        str(idle_rounds),
        "--cookie-file",
        setting("cookie_file", str(DEFAULT_COOKIE_FILE)),
        "--out",
        str(out_path),
    ]
    if headed:
        cmd.append("--headed")
    update_job(job_id, message="正在打开本人关注列表")
    add_event("info", "开始同步本人关注列表")
    seen_sec_uids: set[str] = set()
    inserted_total = 0
    updated_total = 0

    def consume_checkpoint() -> None:
        nonlocal inserted_total, updated_total
        if not out_path.exists():
            return
        try:
            payload = json.loads(out_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        fresh_users = []
        for user in payload.get("users") or []:
            if not isinstance(user, dict):
                continue
            sec_uid = first_text(user.get("sec_uid"), user.get("secUid"))
            if not sec_uid or sec_uid in seen_sec_uids:
                continue
            seen_sec_uids.add(sec_uid)
            fresh_users.append(user)
        if not fresh_users:
            return
        inserted, updated = upsert_following_profiles(fresh_users)
        inserted_total += inserted
        updated_total += updated
        total = len(seen_sec_uids)
        update_job(
            job_id,
            total=total,
            processed=total,
            success=inserted_total,
            failed=0,
            message=f"关注列表同步中：已入库 {total} 人，新 {inserted_total}，更新 {updated_total}",
        )
    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            proc = subprocess.Popen(
                cmd,
                cwd=str(BASE_DIR),
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            with extract_lock:
                extract_process = proc
            while proc.poll() is None:
                consume_checkpoint()
                if extract_stop_event.is_set():
                    try:
                        proc.terminate()
                    except OSError:
                        pass
                time.sleep(1.0)
        consume_checkpoint()
        if extract_stop_event.is_set():
            update_job(job_id, status="stopped", finished_at=now_iso(), message="关注列表同步已停止")
            add_event("warn", "关注列表同步已停止")
            return
        if proc.returncode != 0:
            message = f"关注列表同步失败，退出码 {proc.returncode}: {tail_text(log_path, 1200)}"
            update_job(job_id, status="failed", finished_at=now_iso(), message=message)
            add_event("error", message[:260])
            return
        total = len(seen_sec_uids)
        message = f"关注列表同步完成：{total} 人，新 {inserted_total}，更新 {updated_total}"
        update_job(
            job_id,
            status="complete",
            total=total,
            processed=total,
            success=inserted_total,
            failed=0,
            finished_at=now_iso(),
            message=message,
        )
        add_event("info", message)
    except Exception as exc:
        update_job(job_id, status="failed", finished_at=now_iso(), message=str(exc)[:2000])
        add_event("error", f"关注列表同步异常：{exc}")
    finally:
        try:
            out_path.unlink()
        except FileNotFoundError:
            pass
        with extract_lock:
            extract_process = None
            extract_thread = None
            extract_job_id = None
        extract_stop_event.clear()


def start_following_import(payload: dict[str, Any]) -> dict[str, Any]:
    global extract_thread, extract_job_id
    max_users = normalize_int(payload.get("max", 0), 0, 0, 100000)
    scrolls = normalize_int(payload.get("scrolls", 1200), 1200, 1, 30000)
    idle_rounds = normalize_int(payload.get("idle_rounds", 16), 16, 1, 1000)
    headed = bool(payload.get("headed", False))
    url = f"https://www.douyin.com/user/{LIBRARY_SEC_UID}"
    with extract_lock:
        if extract_thread is not None and extract_thread.is_alive():
            return {"ok": False, "message": "采集任务已经在运行"}
        extract_stop_event.clear()
        job_id = create_job("following", "准备同步本人关注列表")
        extract_job_id = job_id
        extract_thread = threading.Thread(
            target=run_following_import_job,
            args=(job_id, url, max_users, scrolls, idle_rounds, headed),
            daemon=True,
        )
        extract_thread.start()
    return {"ok": True, "job_id": job_id}


def stop_extract() -> dict[str, Any]:
    with extract_lock:
        running = extract_thread is not None and extract_thread.is_alive()
        proc = extract_process
        if not running:
            return {"ok": False, "message": "当前没有采集任务"}
        extract_stop_event.set()
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
    add_event("warn", "正在停止采集任务")
    return {"ok": True}


def link_stats(conn: sqlite3.Connection, profile_id: int | None = None) -> dict[str, int]:
    if profile_id is None:
        rows = []
    else:
        rows = conn.execute(
            "SELECT status, COUNT(*) c FROM links WHERE profile_id=? GROUP BY status",
            (profile_id,),
        ).fetchall()
    stats = {"total": 0, "pending": 0, "downloading": 0, "downloaded": 0, "failed": 0}
    for row in rows:
        status = row["status"]
        count = int(row["c"])
        stats["total"] += count
        if status in stats:
            stats[status] = count
    return stats


def ensure_profile_in_download_queue(conn: sqlite3.Connection, profile_id: int) -> None:
    if profile_id <= 0:
        return
    row = conn.execute("SELECT tab FROM profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return
    has_pending = conn.execute(
        "SELECT 1 FROM links WHERE profile_id=? AND status='pending' LIMIT 1",
        (profile_id,),
    ).fetchone()
    if not has_pending:
        return
    ts = now_iso()
    next_order = int(
        conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 100 v FROM profile_download_queue").fetchone()["v"]
    )
    conn.execute(
        """
        INSERT INTO profile_download_queue(profile_id, sort_order, enabled, created_at, updated_at)
        VALUES(?, ?, 1, ?, ?)
        ON CONFLICT(profile_id) DO NOTHING
        """,
        (profile_id, next_order, ts, ts),
    )


def seed_download_queue(conn: sqlite3.Connection) -> None:
    for row in conn.execute(
        """
        SELECT profiles.id
        FROM profiles
        WHERE EXISTS (
            SELECT 1 FROM links
            WHERE links.profile_id=profiles.id
          )
        ORDER BY profiles.updated_at, profiles.id
        """
    ).fetchall():
        ensure_profile_in_download_queue(conn, int(row["id"]))


def sync_download_queue(conn: sqlite3.Connection) -> None:
    seed_download_queue(conn)


def queue_pending_count(conn: sqlite3.Connection) -> int:
    sync_download_queue(conn)
    row = conn.execute(
        """
        SELECT COUNT(*) c
        FROM links
        JOIN profile_download_queue q ON q.profile_id=links.profile_id
        WHERE q.enabled=1 AND links.status='pending'
        """
    ).fetchone()
    return int(row["c"] if row else 0)


def list_download_queue(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    sync_download_queue(conn)
    rows = conn.execute(
        """
        SELECT
          q.profile_id,
          q.sort_order,
          q.enabled,
          profiles.url,
          profiles.tab,
          profiles.title,
          profiles.nickname,
          profiles.short_id,
          profiles.unique_id,
          profiles.aweme_count,
          COUNT(links.id) total,
          SUM(CASE WHEN links.status='pending' THEN 1 ELSE 0 END) pending,
          SUM(CASE WHEN links.status='downloading' THEN 1 ELSE 0 END) downloading,
          SUM(CASE WHEN links.status='downloaded' THEN 1 ELSE 0 END) downloaded,
          SUM(CASE WHEN links.status='failed' THEN 1 ELSE 0 END) failed
        FROM profile_download_queue q
        JOIN profiles ON profiles.id=q.profile_id
        LEFT JOIN links ON links.profile_id=profiles.id
        WHERE q.enabled=1
        GROUP BY q.profile_id
        HAVING pending > 0 OR downloading > 0
        ORDER BY q.sort_order, q.profile_id
        """
    ).fetchall()
    return [dict(row) for row in rows]


def next_download_queue_profile(conn: sqlite3.Connection, current_profile_id: int | None = None) -> int | None:
    params: list[Any] = []
    extra = ""
    if current_profile_id is not None:
        extra = "AND q.profile_id<>?"
        params.append(current_profile_id)
    row = conn.execute(
        f"""
        SELECT q.profile_id
        FROM profile_download_queue q
        JOIN profiles ON profiles.id=q.profile_id
        WHERE q.enabled=1
          {extra}
          AND EXISTS (
            SELECT 1 FROM links
            WHERE links.profile_id=q.profile_id AND links.status='pending'
          )
        ORDER BY q.sort_order, q.profile_id
        LIMIT 1
        """,
        params,
    ).fetchone()
    return int(row["profile_id"]) if row else None


def move_download_queue_item(profile_id: int, direction: str) -> bool:
    with db() as conn:
        sync_download_queue(conn)
        current = conn.execute(
            """
            SELECT q.profile_id, q.sort_order
            FROM profile_download_queue q
            WHERE q.profile_id=? AND q.enabled=1
              AND EXISTS (
                SELECT 1 FROM links
                WHERE links.profile_id=q.profile_id
                  AND links.status IN ('pending', 'downloading')
              )
            """,
            (profile_id,),
        ).fetchone()
        if not current:
            return False
        if direction == "top":
            other = conn.execute(
                """
                SELECT q.profile_id, q.sort_order
                FROM profile_download_queue q
                WHERE q.enabled=1
                  AND EXISTS (
                    SELECT 1 FROM links
                    WHERE links.profile_id=q.profile_id
                      AND links.status IN ('pending', 'downloading')
                  )
                ORDER BY q.sort_order ASC, q.profile_id ASC
                LIMIT 1
                """
            ).fetchone()
            if not other or int(other["profile_id"]) == int(current["profile_id"]):
                return False
            conn.execute(
                "UPDATE profile_download_queue SET sort_order=?, updated_at=? WHERE profile_id=?",
                (int(other["sort_order"]) - 100, now_iso(), current["profile_id"]),
            )
            return True
        if direction == "up":
            other = conn.execute(
                """
                SELECT q.profile_id, q.sort_order
                FROM profile_download_queue q
                WHERE q.enabled=1
                  AND (q.sort_order < ? OR (q.sort_order = ? AND q.profile_id < ?))
                  AND EXISTS (
                    SELECT 1 FROM links
                    WHERE links.profile_id=q.profile_id
                      AND links.status IN ('pending', 'downloading')
                  )
                ORDER BY q.sort_order DESC, q.profile_id DESC
                LIMIT 1
                """,
                (current["sort_order"], current["sort_order"], current["profile_id"]),
            ).fetchone()
        elif direction == "down":
            other = conn.execute(
                """
                SELECT q.profile_id, q.sort_order
                FROM profile_download_queue q
                WHERE q.enabled=1
                  AND (q.sort_order > ? OR (q.sort_order = ? AND q.profile_id > ?))
                  AND EXISTS (
                    SELECT 1 FROM links
                    WHERE links.profile_id=q.profile_id
                      AND links.status IN ('pending', 'downloading')
                  )
                ORDER BY q.sort_order ASC, q.profile_id ASC
                LIMIT 1
                """,
                (current["sort_order"], current["sort_order"], current["profile_id"]),
            ).fetchone()
        else:
            return False
        if not other:
            return False
        ts = now_iso()
        conn.execute(
            "UPDATE profile_download_queue SET sort_order=?, updated_at=? WHERE profile_id=?",
            (other["sort_order"], ts, current["profile_id"]),
        )
        conn.execute(
            "UPDATE profile_download_queue SET sort_order=?, updated_at=? WHERE profile_id=?",
            (current["sort_order"], ts, other["profile_id"]),
        )
    return True


def sort_download_queue_by_pending() -> int:
    with db() as conn:
        sync_download_queue(conn)
        rows = conn.execute(
            """
            SELECT
              q.profile_id,
              SUM(CASE WHEN links.status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN links.status='downloading' THEN 1 ELSE 0 END) downloading,
              COUNT(links.id) total
            FROM profile_download_queue q
            JOIN links ON links.profile_id=q.profile_id
            WHERE q.enabled=1
            GROUP BY q.profile_id
            HAVING pending > 0 OR downloading > 0
            ORDER BY pending ASC, downloading DESC, total ASC, q.sort_order ASC, q.profile_id ASC
            """
        ).fetchall()
        ts = now_iso()
        for index, row in enumerate(rows, start=1):
            conn.execute(
                "UPDATE profile_download_queue SET sort_order=?, updated_at=? WHERE profile_id=?",
                (index * 100, ts, row["profile_id"]),
            )
    return len(rows)


def get_state() -> dict[str, Any]:
    profile_id = current_profile_id(create=False)
    with db() as conn:
        stats = link_stats(conn, profile_id)
        settings = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM settings")}
        profiles = [
            dict(row)
            for row in conn.execute(
                """
                SELECT
                  profiles.id,
                  profiles.url,
                  profiles.title,
                  profiles.created_at,
                  profiles.updated_at,
                  profiles.last_extracted_at,
                  profiles.sec_uid,
                  profiles.tab,
                  profiles.uid,
                  profiles.nickname,
                  profiles.avatar_url,
                  profiles.unique_id,
                  profiles.short_id,
                  profiles.signature,
                  profiles.ip_location,
                  profiles.following_count,
                  profiles.follower_count,
                  profiles.total_favorited,
                  profiles.aweme_count,
                  profiles.favoriting_count,
                  profiles.gender,
                  profiles.age,
                  profiles.verification,
                  profiles.profile_collected_at,
                  profiles.is_following,
                  profiles.following_discovered_at,
                  COUNT(links.id) total,
                  SUM(CASE WHEN links.status='pending' THEN 1 ELSE 0 END) pending,
                  SUM(CASE WHEN links.status='downloading' THEN 1 ELSE 0 END) downloading,
                  SUM(CASE WHEN links.status='downloaded' THEN 1 ELSE 0 END) downloaded,
                  SUM(CASE WHEN links.status='failed' THEN 1 ELSE 0 END) failed,
                  MAX(links.create_time) latest_work_create_time
                FROM profiles
                LEFT JOIN links ON links.profile_id=profiles.id
                WHERE EXISTS (SELECT 1 FROM links state_links WHERE state_links.profile_id=profiles.id)
                   OR (profiles.sec_uid=? AND profiles.tab='like')
                GROUP BY profiles.id
                ORDER BY profiles.updated_at DESC
                """
                ,
                (LIBRARY_SEC_UID,),
            ).fetchall()
        ]
        for profile in profiles:
            profile["is_self"] = int(
                first_text(profile.get("sec_uid")) == LIBRARY_SEC_UID
                and str(profile.get("tab") or "post") == "like"
            )
        current_profile = None
        if profile_id is not None:
            row = conn.execute("SELECT * FROM profiles WHERE id=?", (profile_id,)).fetchone()
            current_profile = dict(row) if row else None
        jobs = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM jobs ORDER BY id DESC LIMIT 8"
            ).fetchall()
        ]
        download_queue = list_download_queue(conn)
        events = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT 20"
            ).fetchall()
        ]
    return {
        "settings": settings,
        "current_profile": current_profile,
        "profiles": profiles,
        "download_queue": download_queue,
        "stats": stats,
        "extract": {
            "active": extract_thread is not None and extract_thread.is_alive(),
            "job_id": extract_job_id,
        },
        "download": download_manager.snapshot(),
        "auth": cookie_auth_status(),
        "jobs": jobs,
        "events": events,
        "paths": {
            "base": str(BASE_DIR),
            "database": str(DB_PATH),
            "logs": str(LOG_DIR),
            "library": str(Path(profile_output_dir(settings.get("output_dir", str(DEFAULT_OUTPUT_DIR)), profile_id or 0))),
            "manifest": str(Path(profile_output_dir(settings.get("output_dir", str(DEFAULT_OUTPUT_DIR)), profile_id)) / "download_manifest.jsonl")
            if profile_id is not None
            else "",
        },
    }


def list_profiles(query: dict[str, list[str]]) -> dict[str, Any]:
    scope = (query.get("scope") or ["collected"])[0].strip().lower()
    search = (query.get("q") or [""])[0].strip()
    sort_mode = (query.get("sort") or ["latest_desc"])[0].strip().lower()
    limit = normalize_int((query.get("limit") or ["200"])[0], 200, 1, 500)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    since_timestamp = normalize_int((query.get("since") or ["0"])[0], 0, 0, 9999999999)
    where: list[str] = []
    params: list[Any] = []
    if scope == "following":
        where.append("(profiles.is_following=1 OR (profiles.sec_uid=? AND profiles.tab='like'))")
        params.append(LIBRARY_SEC_UID)
    elif scope == "collected":
        where.append("(COALESCE(stats.total, 0)>0 OR (profiles.sec_uid=? AND profiles.tab='like'))")
        params.append(LIBRARY_SEC_UID)
    elif scope != "all":
        raise ValueError("主页范围只能是 collected/following/all")
    if search:
        where.append(
            "(profiles.nickname LIKE ? OR profiles.title LIKE ? OR profiles.unique_id LIKE ? "
            "OR profiles.short_id LIKE ? OR profiles.sec_uid LIKE ?)"
        )
        like = f"%{search}%"
        params.extend([like, like, like, like, like])
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    order_map = {
        "latest_desc": "COALESCE(stats.latest_work_create_time, 0) DESC, profiles.id DESC",
        "works_desc": "COALESCE(profiles.aweme_count, stats.total, 0) DESC, profiles.id DESC",
        "likes_desc": "COALESCE(profiles.total_favorited, 0) DESC, profiles.id DESC",
        "followers_desc": "COALESCE(profiles.follower_count, 0) DESC, profiles.id DESC",
        "last_refresh_asc": "COALESCE(profiles.last_extracted_at, '') ASC, profiles.id ASC",
    }
    order_sql = order_map.get(sort_mode, order_map["latest_desc"])
    stats_sql = """
      SELECT
        profile_id,
        COUNT(*) total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
        SUM(CASE WHEN status='downloading' THEN 1 ELSE 0 END) downloading,
        SUM(CASE WHEN status='downloaded' THEN 1 ELSE 0 END) downloaded,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
        MAX(create_time) latest_work_create_time
      FROM links
      WHERE profile_id IS NOT NULL
      GROUP BY profile_id
    """
    with db() as conn:
        total = int(
            conn.execute(
                f"SELECT COUNT(*) c FROM profiles LEFT JOIN ({stats_sql}) stats ON stats.profile_id=profiles.id {where_sql}",
                params,
            ).fetchone()["c"]
        )
        rows = [
            dict(row)
            for row in conn.execute(
                f"""
                SELECT profiles.*, COALESCE(stats.total, 0) total,
                  COALESCE(stats.pending, 0) pending,
                  COALESCE(stats.downloading, 0) downloading,
                  COALESCE(stats.downloaded, 0) downloaded,
                  COALESCE(stats.failed, 0) failed,
                  stats.latest_work_create_time
                FROM profiles
                LEFT JOIN ({stats_sql}) stats ON stats.profile_id=profiles.id
                {where_sql}
                ORDER BY CASE WHEN profiles.sec_uid=? AND profiles.tab='like' THEN 0 ELSE 1 END, {order_sql}
                LIMIT ? OFFSET ?
                """,
                [*params, LIBRARY_SEC_UID, limit, offset],
            ).fetchall()
        ]
        eligible_params: list[Any] = [LIBRARY_SEC_UID]
        eligible_where = "(COALESCE(stats.total, 0)>0 OR (profiles.sec_uid=? AND profiles.tab='like'))"
        if since_timestamp > 0:
            eligible_where += " AND (profiles.tab='like' OR stats.latest_work_create_time IS NULL OR stats.latest_work_create_time>=?)"
            eligible_params.append(since_timestamp)
        eligible_count = int(
            conn.execute(
                f"SELECT COUNT(*) c FROM profiles LEFT JOIN ({stats_sql}) stats ON stats.profile_id=profiles.id WHERE {eligible_where}",
                eligible_params,
            ).fetchone()["c"]
        )
    for profile in rows:
        profile["is_self"] = int(
            first_text(profile.get("sec_uid")) == LIBRARY_SEC_UID
            and str(profile.get("tab") or "post") == "like"
        )
    return {"total": total, "eligible_count": eligible_count, "profiles": rows}


def list_links(query: dict[str, list[str]]) -> dict[str, Any]:
    status = (query.get("status") or [""])[0]
    search = (query.get("q") or [""])[0]
    scope = (query.get("scope") or ["global"])[0].strip().lower()
    limit = normalize_int((query.get("limit") or ["100"])[0], 100, 1, 500)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    profile_id = normalize_int((query.get("profile_id") or ["0"])[0], 0, 0, 1000000)
    if profile_id <= 0 and scope in {"current", "profile"}:
        profile_id = current_profile_id(create=False) or 0
    where = []
    params: list[Any] = []
    if profile_id > 0:
        where.append("links.profile_id=?")
        params.append(profile_id)
    if status:
        where.append("links.status=?")
        params.append(status)
    if search:
        where.append(
            "(links.url LIKE ? OR links.aweme_id LIKE ? OR links.last_error LIKE ? "
            "OR links.author_uid LIKE ? OR links.author_sec_uid LIKE ? OR links.author_nickname LIKE ? "
            "OR links.desc LIKE ?)"
        )
        like = f"%{search}%"
        params.extend([like, like, like, like, like, like, like])
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    with db() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) c FROM links {where_sql}",
            params,
        ).fetchone()["c"]
        order_sql = "ORDER BY links.id DESC"
        if status == "downloaded":
            order_sql = (
                "ORDER BY COALESCE(links.downloaded_at, links.last_started_at, "
                "links.last_seen_at, links.discovered_at) DESC, links.id DESC"
            )
        rows = conn.execute(
            f"""
            SELECT links.*, profiles.url profile_url
            FROM links
            LEFT JOIN profiles ON profiles.id=links.profile_id
            {where_sql}
            {order_sql}
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()
    return {"total": total, "links": [dict(row) for row in rows]}


def reset_failed_links(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope") or "current").strip().lower()
    profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
    params: list[Any] = []
    where = "status='failed'"
    scope_label = "全部主页"

    if profile_id > 0:
        where += " AND profile_id=?"
        params.append(profile_id)
        scope_label = f"主页 #{profile_id}"
    elif scope not in {"all", "global"}:
        current_id = current_profile_id(create=False)
        if current_id is None:
            return {"ok": False, "message": "当前主页还没有入库"}
        where += " AND profile_id=?"
        params.append(current_id)
        scope_label = "当前主页"

    with db() as conn:
        cur = conn.execute(
            f"""
            UPDATE links
            SET status='pending',
                last_error=NULL,
                failed_at=NULL,
                last_started_at=NULL
            WHERE {where}
            """,
            params,
        )
        sync_download_queue(conn)
        changed = cur.rowcount if cur.rowcount is not None else 0
    add_event("info", f"{scope_label}失败链接已转为待下载：{changed} 条")
    return {"ok": True, "changed": changed, "scope": scope, "state": get_state()}


def queue_gallery_music_backfill(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope") or "all").strip().lower()
    params: list[Any] = []
    where = """
      links.status='downloaded'
      AND (LOWER(COALESCE(links.media_type, ''))='gallery' OR LOWER(COALESCE(links.kind, ''))='note')
      AND COALESCE(links.gallery_music_status, '') NOT IN ('downloaded', 'unavailable')
      AND COALESCE(NULLIF(TRIM(links.local_music_path), ''), '') = ''
      AND COALESCE(links.local_file_names, '') NOT LIKE '%_music.%'
      AND COALESCE(links.local_file_paths, '') NOT LIKE '%_music.%'
      AND NOT EXISTS (
        SELECT 1 FROM links AS music_copy
        WHERE music_copy.aweme_id=links.aweme_id
          AND (
            COALESCE(NULLIF(TRIM(music_copy.local_music_path), ''), '') <> ''
            OR COALESCE(music_copy.local_file_names, '') LIKE '%_music.%'
            OR COALESCE(music_copy.local_file_paths, '') LIKE '%_music.%'
            OR COALESCE(music_copy.gallery_music_status, '') IN ('downloaded', 'unavailable')
          )
      )
    """
    scope_label = "全部主页"
    if scope not in {"all", "global"}:
        profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
        if profile_id <= 0:
            profile_id = current_profile_id(create=False) or 0
        if profile_id <= 0:
            return {"ok": False, "message": "当前主页还没有入库"}
        where += " AND links.profile_id=?"
        params.append(profile_id)
        scope_label = f"主页 #{profile_id}"

    with db() as conn:
        candidates = conn.execute(
            f"SELECT MIN(links.id) AS id FROM links WHERE {where} GROUP BY links.aweme_id ORDER BY MIN(links.id)",
            params,
        ).fetchall()
        ids = [int(row["id"]) for row in candidates]
        dry_run = str(payload.get("dry_run") or "").strip().lower() in {"1", "true", "yes", "on"}
        if ids and not dry_run:
            placeholders = ",".join("?" for _ in ids)
            conn.execute(
                f"""
                UPDATE links SET
                  status='pending',
                  download_intent=?,
                  gallery_music_status='pending',
                  gallery_music_checked_at=NULL,
                  failed_at=NULL,
                  last_error='等待重新下载图集并补齐背景音乐'
                WHERE id IN ({placeholders})
                """,
                [GALLERY_MUSIC_INTENT, *ids],
            )
            sync_download_queue(conn)
    changed = 0 if dry_run else len(ids)
    if dry_run:
        return {"ok": True, "eligible": len(ids), "changed": 0, "scope": scope}
    add_event("info", f"{scope_label}图集音乐补齐任务已加入队列：{changed} 条")
    return {"ok": True, "eligible": len(ids), "changed": changed, "scope": scope, "state": get_state()}


EMPTY_FAILED_LINK_SQL = """
status='failed'
AND COALESCE(NULLIF(TRIM(desc), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_nickname), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_uid), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_sec_uid), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_avatar_url), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_url), ''), '') = ''
AND COALESCE(NULLIF(TRIM(cover_url), ''), '') = ''
AND COALESCE(NULLIF(TRIM(local_cover_path), ''), '') = ''
AND COALESCE(NULLIF(TRIM(preview_path), ''), '') = ''
AND COALESCE(NULLIF(TRIM(local_file_names), ''), '') = ''
AND COALESCE(NULLIF(TRIM(local_file_paths), ''), '') = ''
AND COALESCE(NULLIF(TRIM(metadata_json), ''), '{}') = '{}'
"""


def delete_empty_failed_links(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope") or "current").strip().lower()
    params: list[Any] = []
    where = EMPTY_FAILED_LINK_SQL
    scope_label = "全部主页"
    if scope not in {"all", "global"}:
        profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
        if profile_id <= 0:
            profile_id = current_profile_id(create=False) or 0
        if profile_id <= 0:
            return {"ok": False, "message": "当前主页还没有入库"}
        where += " AND profile_id=?"
        params.append(profile_id)
        scope_label = f"主页 #{profile_id}"
    with db() as conn:
        before = int(conn.execute(f"SELECT COUNT(*) c FROM links WHERE {where}", params).fetchone()["c"])
        cur = conn.execute(f"DELETE FROM links WHERE {where}", params)
        sync_download_queue(conn)
    changed = cur.rowcount if cur.rowcount is not None else before
    add_event("info", f"{scope_label}空壳失败链接已删除：{changed} 条")
    return {"ok": True, "changed": changed, "scope": scope, "state": get_state()}


def delete_failed_links(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope") or "all").strip().lower()
    if scope not in {"all", "global", "current", "profile"}:
        return {"ok": False, "message": "删除范围只能是 all/global/current/profile"}
    params: list[Any] = []
    where = "status='failed'"
    scope_label = "全部主页"
    if scope not in {"all", "global"}:
        profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
        if profile_id <= 0:
            profile_id = current_profile_id(create=False) or 0
        if profile_id <= 0:
            return {"ok": False, "message": "当前主页还没有入库"}
        where += " AND profile_id=?"
        params.append(profile_id)
        scope_label = f"主页 #{profile_id}"
    with db() as conn:
        before = int(conn.execute(f"SELECT COUNT(*) c FROM links WHERE {where}", params).fetchone()["c"])
        cur = conn.execute(f"DELETE FROM links WHERE {where}", params)
        sync_download_queue(conn)
    changed = cur.rowcount if cur.rowcount is not None else before
    add_event("warn", f"{scope_label}失败链接已删除：{changed} 条")
    return {"ok": True, "changed": changed, "scope": scope, "state": get_state()}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            return self.send_json(get_state())
        if parsed.path == "/api/auth/status":
            return self.send_json({"ok": True, "auth": cookie_auth_status()})
        if parsed.path == "/api/profiles":
            return self.send_json(list_profiles(parse_qs(parsed.query)))
        if parsed.path == "/api/links":
            return self.send_json(list_links(parse_qs(parsed.query)))
        if parsed.path == "/api/export/links.txt":
            profile_id = current_profile_id(create=False)
            if profile_id is None:
                return self.send_text("", "text/plain; charset=utf-8")
            with db() as conn:
                urls = [
                    row["url"]
                    for row in conn.execute(
                        "SELECT url FROM links WHERE profile_id=? ORDER BY id",
                        (profile_id,),
                    )
                ]
            return self.send_text("\n".join(urls) + ("\n" if urls else ""), "text/plain; charset=utf-8")
        if parsed.path == "/" or parsed.path == "/index.html":
            return self.serve_file(STATIC_DIR / "index.html")
        static_path = (STATIC_DIR / parsed.path.lstrip("/")).resolve()
        if str(static_path).startswith(str(STATIC_DIR.resolve())) and static_path.exists():
            return self.serve_file(static_path)
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            if parsed.path == "/api/settings":
                return self.handle_settings(payload)
            if parsed.path == "/api/auth/cookie/import":
                return self.send_json(import_cookie_text(str(payload.get("content") or "")))
            if parsed.path == "/api/auth/cookie/clear":
                return self.send_json(clear_cookie_auth())
            if parsed.path == "/api/auth/cookie/open-folder":
                return self.send_json(open_cookie_folder())
            if parsed.path == "/api/auth/login/start":
                return self.send_json(start_cookie_login())
            if parsed.path == "/api/extract/start":
                return self.send_json(start_extract(payload))
            if parsed.path == "/api/profiles/refresh":
                return self.send_json(start_refresh_profiles(payload))
            if parsed.path == "/api/profiles/following/import":
                return self.send_json(start_following_import(payload))
            if parsed.path == "/api/extract/stop":
                return self.send_json(stop_extract())
            if parsed.path == "/api/download/start":
                concurrency = normalize_int(payload.get("concurrency", setting("concurrency", "8")), 8, 1, MAX_CONCURRENCY)
                set_setting("concurrency", str(concurrency))
                limit = normalize_int(payload.get("limit", 0), 0, 0, 1000000)
                watch_raw = payload.get("watch_new", True)
                watch_new = str(watch_raw).lower() not in {"0", "false", "no", "off"}
                return self.send_json(
                    download_manager.start(
                        concurrency,
                        bool(payload.get("retry_failed")),
                        limit,
                        current_profile_id(create=False),
                        watch_new,
                    )
                )
            if parsed.path == "/api/download/stop":
                return self.send_json(download_manager.stop())
            if parsed.path == "/api/download-queue/add":
                profile_id = normalize_int(payload.get("profile_id", current_profile_id(create=False) or 0), 0, 0, 1000000)
                if profile_id <= 0:
                    return self.send_json({"ok": False, "message": "当前主页还没有入库"})
                with db() as conn:
                    ensure_profile_in_download_queue(conn, profile_id)
                return self.send_json({"ok": True, "state": get_state()})
            if parsed.path == "/api/download-queue/remove":
                profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
                with db() as conn:
                    conn.execute(
                        "UPDATE profile_download_queue SET enabled=0, updated_at=? WHERE profile_id=?",
                        (now_iso(), profile_id),
                    )
                return self.send_json({"ok": True, "state": get_state()})
            if parsed.path == "/api/download-queue/move":
                profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
                direction = str(payload.get("direction") or "").strip()
                if direction not in {"up", "down", "top"}:
                    return self.send_json({"ok": False, "message": "方向只能是 up/down/top"})
                changed = move_download_queue_item(profile_id, direction)
                return self.send_json({"ok": True, "changed": changed, "state": get_state()})
            if parsed.path == "/api/download-queue/sort":
                mode = str(payload.get("mode") or "pending_asc").strip()
                if mode != "pending_asc":
                    return self.send_json({"ok": False, "message": "目前只支持 pending_asc"})
                changed = sort_download_queue_by_pending()
                return self.send_json({"ok": True, "changed": changed, "state": get_state()})
            if parsed.path == "/api/manifest/import":
                return self.handle_manifest_import(payload)
            if parsed.path == "/api/links/reset-failed":
                return self.send_json(reset_failed_links(payload))
            if parsed.path == "/api/links/backfill-gallery-music":
                return self.send_json(queue_gallery_music_backfill(payload))
            if parsed.path == "/api/links/delete-empty-failed":
                return self.send_json(delete_empty_failed_links(payload))
            if parsed.path == "/api/links/delete-failed":
                return self.send_json(delete_failed_links(payload))
            if parsed.path == "/api/links/import":
                return self.handle_import(payload)
        except Exception as exc:
            return self.send_json({"ok": False, "message": str(exc)}, status=500)
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def handle_settings(self, payload: dict[str, Any]) -> None:
        allowed = {
            "profile_url",
            "profile_tab",
            "output_dir",
            "concurrency",
            "scrolls",
            "idle_rounds",
            "incremental_stop_existing",
            "profile_refresh_recent_days",
            "download_cycle_limit",
            "download_cycle_cooldown_minutes",
            "failure_guard_threshold",
            "library_output_dir",
            "cookie_file",
            "download_proxy",
            "downloader_root",
            "downloader_python",
            "downloader_run",
        }
        if "profile_url" in payload or "profile_tab" in payload:
            profile_tab = normalize_profile_tab(payload.get("profile_tab", setting("profile_tab", "auto")))
            raw_profile_url = str(payload.get("profile_url") if "profile_url" in payload else setting("profile_url", TEST_PROFILE_URL)).strip()
            if raw_profile_url:
                parsed_profile = parse_profile_url(raw_profile_url, profile_tab)
                set_setting("profile_url", parsed_profile["url"])
            set_setting("profile_tab", profile_tab)
        for key, value in payload.items():
            if key not in allowed:
                continue
            if key in {"profile_url", "profile_tab"}:
                continue
            if key == "concurrency":
                value = str(normalize_int(value, 8, 1, MAX_CONCURRENCY))
            if key == "incremental_stop_existing":
                value = str(normalize_int(value, 12, 0, 1000))
            if key == "profile_refresh_recent_days":
                value = str(normalize_int(value, 30, 0, 3650))
            if key == "download_cycle_limit":
                value = str(normalize_int(value, 350, 0, 1000000))
            if key == "download_cycle_cooldown_minutes":
                value = str(normalize_int(value, 30, 1, 1440))
            if key == "failure_guard_threshold":
                value = str(normalize_int(value, DEFAULT_FAILURE_GUARD_THRESHOLD, 0, 1000))
            if key == "download_proxy":
                value = normalize_proxy(value)
            set_setting(key, str(value))
        add_event("info", "设置已保存")
        return self.send_json({"ok": True, "state": get_state()})

    def handle_manifest_import(self, payload: dict[str, Any]) -> None:
        profile_id = current_profile_id(create=True)
        if profile_id is None:
            return self.send_json({"ok": False, "message": "当前主页还没有入库"})
        default_output_dir = profile_output_dir(setting("output_dir", str(DEFAULT_OUTPUT_DIR)), profile_id)
        manifest_path = str(payload.get("manifest_path") or "").strip()
        if not manifest_path:
            manifest_path = str(Path(default_output_dir) / "download_manifest.jsonl")
        output_dir = str(payload.get("output_dir") or "").strip() or str(Path(manifest_path).parent)
        result = import_manifest_to_db(profile_id, manifest_path, output_dir)
        return self.send_json({"ok": True, **result, "state": get_state()})

    def handle_import(self, payload: dict[str, Any]) -> None:
        profile_url = str(payload.get("profile_url") or "manual").strip()
        profile_tab = normalize_profile_tab(payload.get("profile_tab") or setting("profile_tab", "auto"))
        profile_id = upsert_profile(profile_url, profile_tab)
        raw_works = payload.get("works")
        works = []
        if isinstance(raw_works, list):
            for work in raw_works:
                if not isinstance(work, dict):
                    continue
                url = str(work.get("url") or "")
                aweme_id = str(work.get("aweme_id") or work.get("awemeId") or work_id_from_url(url) or "")
                if not aweme_id:
                    continue
                kind = str(work.get("kind") or ("note" if "/note/" in url or "/gallery/" in url or "/slides/" in url else "video"))
                if not url:
                    url = f"https://www.douyin.com/{'note' if kind == 'note' else 'video'}/{aweme_id}"
                works.append(
                    {
                        "aweme_id": aweme_id,
                        "kind": kind,
                        "url": url,
                        "author_uid": str(work.get("author_uid") or work.get("authorUid") or ""),
                        "author_sec_uid": str(work.get("author_sec_uid") or work.get("authorSecUid") or ""),
                        "author_nickname": str(work.get("author_nickname") or work.get("authorNickname") or ""),
                        "author_avatar_url": first_text(work.get("author_avatar_url"), work.get("authorAvatarUrl")),
                        "author_url": first_text(work.get("author_url"), work.get("authorUrl")),
                        "desc": first_text(work.get("desc"), work.get("title"), work.get("caption")),
                        "cover_url": first_text(work.get("cover_url"), work.get("coverUrl"), work.get("thumbnail")),
                        "create_time": int_or_none(work.get("create_time") or work.get("createTime")),
                        "duration_ms": int_or_none(work.get("duration_ms") or work.get("duration") or work.get("durationMs")),
                        "digg_count": int_or_none(work.get("digg_count") or work.get("diggCount") or work.get("like_count") or work.get("likeCount")),
                        "comment_count": int_or_none(work.get("comment_count") or work.get("commentCount")),
                        "share_count": int_or_none(work.get("share_count") or work.get("shareCount")),
                        "collect_count": int_or_none(work.get("collect_count") or work.get("collectCount")),
                        "media_type": first_text(work.get("media_type"), work.get("mediaType"), "gallery" if kind == "note" else "video"),
                    }
                )
        else:
            text = str(payload.get("text") or "")
            for line in text.splitlines():
                url = line.strip()
                if not url:
                    continue
                aweme_id = work_id_from_url(url)
                if not aweme_id:
                    continue
                kind = "note" if "/note/" in url or "/gallery/" in url or "/slides/" in url else "video"
                works.append({"aweme_id": aweme_id, "kind": kind, "url": url})
        inserted, updated = upsert_links(profile_id, works)
        add_event("info", f"手动导入 {len(works)} 条，新 {inserted}，已存在 {updated}")
        return self.send_json({"ok": True, "count": len(works), "inserted": inserted, "updated": updated})

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text: str, content_type: str) -> None:
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, path: Path) -> None:
        if path.is_dir():
            path = path / "index.html"
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if content_type.startswith("text/") or path.suffix in {".js", ".css"}:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    init_db()
    add_event("info", "服务启动")
    download_manager.restore_failure_guard()
    host = os.environ.get("DOUYIN_MANAGER_HOST", "127.0.0.1")
    port = int(os.environ.get("DOUYIN_MANAGER_PORT", "8765"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Douyin Download Manager: http://localhost:{port}")
    print(f"Database: {DB_PATH}")
    if FROZEN_BUILD and os.environ.get("DOUYIN_MANAGER_OPEN", "1").lower() not in {"0", "false", "no", "off"}:
        opener = threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}/#home"))
        opener.daemon = True
        opener.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        download_manager.stop()
        server.server_close()


if __name__ == "__main__":
    main()
