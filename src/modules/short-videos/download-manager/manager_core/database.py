"""Internal database responsibilities for the download manager."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Callable

from .common import clean_profile_nickname, normalize_int, now_iso, parse_profile_url
from .config import (
    CONFIG_DIR,
    DATA_DIR,
    DB_PATH,
    DEFAULT_COOKIE_FILE,
    DEFAULT_FAILURE_GUARD_THRESHOLD,
    DEFAULT_LIBRARY_OUTPUT_DIR,
    DEFAULT_OUTPUT_DIR,
    DOWNLOADER_PYTHON,
    DOWNLOADER_ROOT,
    DOWNLOADER_RUN,
    LEGACY_DOWNLOADER_PYTHON,
    LEGACY_DOWNLOADER_ROOT,
    LEGACY_DOWNLOADER_RUN,
    LIBRARY_SEC_UID,
    LOG_DIR,
    TEST_PROFILE_URL,
    downloader_root_env_value,
)


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
              has_deleted_works INTEGER NOT NULL DEFAULT 0,
              account_status TEXT NOT NULL DEFAULT 'active',
              account_status_reason TEXT,
              account_status_detected_at TEXT,
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
              actual_width INTEGER,
              actual_height INTEGER,
              actual_bit_rate INTEGER,
              actual_codec TEXT,
              actual_frame_rate REAL,
              actual_pixels INTEGER,
              actual_long_edge INTEGER,
              actual_probed_at TEXT,
              actual_probe_error TEXT,
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
              is_missing_from_profile INTEGER NOT NULL DEFAULT 0,
              missing_from_profile_at TEXT,
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
        migrate_profile_collection_history(conn)
        migrate_link_author_columns(conn)
        migrate_link_preview_columns(conn)
        migrate_link_profile_presence_columns(conn)
        migrate_profile_observation_history(conn)
        migrate_link_files(conn)
        migrate_download_records(conn)
        migrate_video_quality_audits(conn)
        migrate_self_profile_aliases(conn)
        conn.execute(
            """
            UPDATE profiles
            SET nickname=(
              SELECT NULLIF(TRIM(links.author_nickname), '')
              FROM links
              WHERE links.profile_id=profiles.id
                AND TRIM(COALESCE(links.author_nickname, '')) <> ''
                AND TRIM(links.author_nickname) NOT IN ('读屏标签已关闭', '读屏标签已开启')
              ORDER BY links.last_seen_at DESC, links.id DESC
              LIMIT 1
            )
            WHERE TRIM(COALESCE(nickname, '')) IN ('读屏标签已关闭', '读屏标签已开启')
            """
        )
        conn.execute(
            "UPDATE profiles SET title=NULLIF(TRIM(COALESCE(nickname, '')), '') "
            "WHERE TRIM(COALESCE(title, '')) IN ('读屏标签已关闭', '读屏标签已开启')"
        )
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
            "automatic_collection_enabled": "0",
            "automatic_collection_interval_hours": "24",
            "automatic_collection_last_started_at": "",
            "automatic_collection_next_run_at": "",
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
        migrate_downloader_settings(conn)
        conn.execute(
            "UPDATE links SET status='pending', last_error='上次程序退出时仍在下载，已重置为待下载' "
            "WHERE status='downloading'"
        )
        conn.execute(
            "UPDATE jobs SET status='stopped', finished_at=?, message='服务重启，任务已停止' "
            "WHERE status IN ('running', 'queued')",
            (now_iso(),),
        )
        from .queue import seed_download_queue

        seed_download_queue(conn)


def _same_path(left: str, right: str) -> bool:
    if not str(left).strip() or not str(right).strip():
        return False
    try:
        return Path(left).expanduser().resolve() == Path(right).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return False


def _downloader_setting_path_is_valid(key: str, value: str) -> bool:
    if not str(value).strip():
        return False
    try:
        path = Path(value).expanduser()
        return path.is_dir() if key == "downloader_root" else path.is_file()
    except (OSError, RuntimeError, ValueError):
        return False


def migrate_downloader_settings(
    conn: sqlite3.Connection,
    *,
    environment_override: bool | None = None,
    path_is_valid: Callable[[str, str], bool] | None = None,
) -> tuple[str, ...]:
    """Move stale legacy downloader paths to the colocated runtime.

    Existing custom paths remain authoritative while they still point to the
    expected file or directory. An explicit environment override is also
    authoritative and deliberately leaves the persisted settings untouched.
    """

    if environment_override is None:
        environment_override = bool(downloader_root_env_value())
    if environment_override:
        return ()

    validator = path_is_valid or _downloader_setting_path_is_valid
    targets = {
        "downloader_root": str(DOWNLOADER_ROOT),
        "downloader_python": str(DOWNLOADER_PYTHON),
        "downloader_run": str(DOWNLOADER_RUN),
    }
    legacy = {
        "downloader_root": str(LEGACY_DOWNLOADER_ROOT),
        "downloader_python": str(LEGACY_DOWNLOADER_PYTHON),
        "downloader_run": str(LEGACY_DOWNLOADER_RUN),
    }
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN (?, ?, ?)",
        tuple(targets),
    ).fetchall()
    current = {str(row["key"]): str(row["value"]) for row in rows}
    if all(_same_path(current.get(key, ""), target) for key, target in targets.items()):
        return ()

    contains_legacy_path = any(
        _same_path(current.get(key, ""), legacy[key]) for key in targets
    )
    valid_custom_triplet = not contains_legacy_path and all(
        validator(key, current.get(key, "")) for key in targets
    )
    if valid_custom_triplet:
        return ()

    for key, target in targets.items():
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, target),
        )
    return tuple(targets)


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
        "has_deleted_works": "INTEGER NOT NULL DEFAULT 0",
        "account_status": "TEXT NOT NULL DEFAULT 'active'",
        "account_status_reason": "TEXT",
        "account_status_detected_at": "TEXT",
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
    conn.execute("CREATE INDEX IF NOT EXISTS idx_profiles_account_status ON profiles(account_status, id)")


def parse_profile_history(value: Any, *, numeric: bool = False) -> list[dict[str, Any]]:
    try:
        source = json.loads(str(value or "[]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        source = []
    result: list[dict[str, Any]] = []
    for item in source if isinstance(source, list) else []:
        raw_value = item.get("value") if isinstance(item, dict) else item
        if numeric:
            try:
                normalized: Any = int(float(raw_value))
            except (TypeError, ValueError):
                continue
        else:
            normalized = clean_profile_nickname(raw_value)
            if not normalized:
                continue
        first_seen = str(item.get("first_seen_at") or "") if isinstance(item, dict) else ""
        last_seen = str(item.get("last_seen_at") or first_seen) if isinstance(item, dict) else first_seen
        result.append({"value": normalized, "first_seen_at": first_seen, "last_seen_at": last_seen})
    return result


def merge_profile_history_value(
    history: list[dict[str, Any]],
    value: Any,
    observed_at: str,
    *,
    numeric: bool = False,
    limit: int = 64,
) -> list[dict[str, Any]]:
    if numeric:
        try:
            normalized: Any = int(float(value))
        except (TypeError, ValueError):
            return history
    else:
        normalized = clean_profile_nickname(value)
        if not normalized:
            return history
    seen_at = str(observed_at or now_iso())
    match = next((item for item in history if item.get("value") == normalized), None)
    if match:
        match["first_seen_at"] = min(filter(None, [str(match.get("first_seen_at") or ""), seen_at]), default=seen_at)
        match["last_seen_at"] = max(str(match.get("last_seen_at") or ""), seen_at)
    else:
        history.append({"value": normalized, "first_seen_at": seen_at, "last_seen_at": seen_at})
    history.sort(key=lambda item: (str(item.get("last_seen_at") or ""), str(item.get("value") or "")))
    return history[-max(1, int(limit)) :]


def migrate_profile_observation_history(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(profiles)").fetchall()}
    for name in ["nickname_history_json", "total_favorited_history_json"]:
        if name not in columns:
            conn.execute(f"ALTER TABLE profiles ADD COLUMN {name} TEXT NOT NULL DEFAULT '[]'")
    migration_key = "profile_observation_history_backfill_version"
    migration_row = conn.execute("SELECT value FROM settings WHERE key=?", (migration_key,)).fetchone()
    rebuild_names = not migration_row or migration_row["value"] != "2"
    for profile in conn.execute(
        "SELECT id, sec_uid, nickname, total_favorited, profile_collected_at, updated_at, "
        "nickname_history_json, total_favorited_history_json FROM profiles"
    ).fetchall():
        observed_at = str(profile["profile_collected_at"] or profile["updated_at"] or now_iso())
        names = [] if rebuild_names else parse_profile_history(profile["nickname_history_json"])
        likes = parse_profile_history(profile["total_favorited_history_json"], numeric=True)
        names = merge_profile_history_value(names, profile["nickname"], observed_at)
        likes = merge_profile_history_value(likes, profile["total_favorited"], observed_at, numeric=True)
        link_names = conn.execute(
            """
            SELECT TRIM(author_nickname) nickname,
                   MIN(COALESCE(NULLIF(discovered_at, ''), NULLIF(last_seen_at, ''), ?)) first_seen_at,
                   MAX(COALESCE(NULLIF(last_seen_at, ''), NULLIF(discovered_at, ''), ?)) last_seen_at
            FROM links
            WHERE author_sec_uid=? AND TRIM(COALESCE(author_nickname, '')) <> ''
            GROUP BY TRIM(author_nickname)
            """,
            (observed_at, observed_at, str(profile["sec_uid"] or "")),
        ).fetchall() if rebuild_names and str(profile["sec_uid"] or "").strip() else []
        for link_name in link_names:
            names = merge_profile_history_value(names, link_name["nickname"], link_name["first_seen_at"] or observed_at)
            names = merge_profile_history_value(names, link_name["nickname"], link_name["last_seen_at"] or observed_at)
        conn.execute(
            "UPDATE profiles SET nickname_history_json=?, total_favorited_history_json=? WHERE id=?",
            (
                json.dumps(names, ensure_ascii=False, separators=(",", ":")),
                json.dumps(likes, ensure_ascii=False, separators=(",", ":")),
                profile["id"],
            ),
        )
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, '2') "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (migration_key,),
    )


def migrate_profile_collection_history(conn: sqlite3.Connection) -> None:
    """Persist collection counts and the one-shot full-scan reconciliation state."""

    profile_columns = {row["name"] for row in conn.execute("PRAGMA table_info(profiles)").fetchall()}
    specs = {
        "full_scan_required": "INTEGER NOT NULL DEFAULT 0",
        "full_scan_reason": "TEXT",
        "full_scan_required_at": "TEXT",
        "last_full_scan_at": "TEXT",
        "last_full_scan_aweme_count": "INTEGER",
        "last_full_scan_link_total": "INTEGER",
    }
    for name, definition in specs.items():
        if name not in profile_columns:
            conn.execute(f"ALTER TABLE profiles ADD COLUMN {name} {definition}")

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS profile_collection_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          observed_aweme_count INTEGER,
          previous_aweme_count INTEGER,
          local_link_count INTEGER NOT NULL DEFAULT 0,
          seen_count INTEGER NOT NULL DEFAULT 0,
          inserted_count INTEGER NOT NULL DEFAULT 0,
          existing_count INTEGER NOT NULL DEFAULT 0,
          count_drop INTEGER NOT NULL DEFAULT 0,
          count_drop_ratio REAL,
          full_scan_required INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_profile_collection_history_profile
          ON profile_collection_history(profile_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_profile_collection_history_job
          ON profile_collection_history(job_id);
        CREATE INDEX IF NOT EXISTS idx_profiles_full_scan_required
          ON profiles(full_scan_required, id);
        """
    )

    # Existing installations have no structured history yet. Seed only clear,
    # unconfirmed count gaps. Profiles already reconciled by a full scan keep
    # their confirmed deleted-work flag and are not scheduled again.
    ts = now_iso()
    conn.execute(
        """
        UPDATE profiles
        SET full_scan_required=1,
            full_scan_reason=(
              '主页作品数 ' || aweme_count || '，比本地入库少 ' ||
              ((SELECT COUNT(*) FROM links WHERE links.profile_id=profiles.id) - aweme_count) ||
              ' 条，待一次全量确认'
            ),
            full_scan_required_at=COALESCE(full_scan_required_at, ?)
        WHERE tab='post'
          AND COALESCE(full_scan_required, 0)=0
          AND COALESCE(has_deleted_works, 0)=0
          AND COALESCE(account_status, 'active')<>'banned'
          AND aweme_count IS NOT NULL
          AND last_full_scan_at IS NULL
          AND (SELECT COUNT(*) FROM links WHERE links.profile_id=profiles.id) - aweme_count >= 10
          AND aweme_count <= (SELECT COUNT(*) FROM links WHERE links.profile_id=profiles.id) * 0.9
        """,
        (ts,),
    )
    conn.execute(
        """
        INSERT INTO profile_collection_history (
          profile_id, job_id, mode, status,
          observed_aweme_count, previous_aweme_count, local_link_count,
          seen_count, inserted_count, existing_count,
          count_drop, count_drop_ratio, full_scan_required,
          message, started_at, finished_at
        )
        SELECT
          profiles.id, NULL, 'baseline', 'complete',
          profiles.aweme_count, NULL,
          (SELECT COUNT(*) FROM links WHERE links.profile_id=profiles.id),
          0, 0, 0, 0, NULL, COALESCE(profiles.full_scan_required, 0),
          '启用采集计数历史时记录的初始基线',
          COALESCE(NULLIF(profiles.profile_collected_at, ''), NULLIF(profiles.updated_at, ''), ?),
          ?
        FROM profiles
        WHERE profiles.aweme_count IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM profile_collection_history history
            WHERE history.profile_id=profiles.id
          )
        """,
        (ts, ts),
    )


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
        "actual_width": "INTEGER",
        "actual_height": "INTEGER",
        "actual_bit_rate": "INTEGER",
        "actual_codec": "TEXT",
        "actual_frame_rate": "REAL",
        "actual_pixels": "INTEGER",
        "actual_long_edge": "INTEGER",
        "actual_probed_at": "TEXT",
        "actual_probe_error": "TEXT",
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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_links_profile_create_time "
        "ON links(profile_id, create_time DESC)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_links_media_type ON links(media_type)")


def migrate_link_profile_presence_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(links)").fetchall()}
    specs = {
        "is_missing_from_profile": "INTEGER NOT NULL DEFAULT 0",
        "missing_from_profile_at": "TEXT",
    }
    for name, definition in specs.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE links ADD COLUMN {name} {definition}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_links_profile_missing "
        "ON links(profile_id, is_missing_from_profile, id)"
    )


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


def migrate_download_records(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS download_records (
          aweme_id TEXT PRIMARY KEY,
          output_dir TEXT NOT NULL DEFAULT '',
          media_type TEXT,
          record_json TEXT NOT NULL,
          recorded_at TEXT,
          content_hash TEXT,
          source TEXT NOT NULL DEFAULT 'manager',
          manifest_path TEXT,
          manifest_offset INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_download_records_recorded
          ON download_records(recorded_at DESC, aweme_id);
        CREATE INDEX IF NOT EXISTS idx_download_records_output
          ON download_records(output_dir, aweme_id);

        CREATE TABLE IF NOT EXISTS download_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          aweme_id TEXT NOT NULL REFERENCES download_records(aweme_id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          absolute_path TEXT,
          size_bytes INTEGER,
          exists_on_disk INTEGER NOT NULL DEFAULT 0,
          recorded_at TEXT NOT NULL,
          UNIQUE(aweme_id, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_download_files_aweme
          ON download_files(aweme_id, id);
        CREATE INDEX IF NOT EXISTS idx_download_files_role
          ON download_files(role, aweme_id);

        CREATE TABLE IF NOT EXISTS manifest_import_state (
          manifest_path TEXT PRIMARY KEY,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          file_size INTEGER NOT NULL DEFAULT 0,
          file_mtime_ns INTEGER NOT NULL DEFAULT 0,
          imported_records INTEGER NOT NULL DEFAULT 0,
          bad_lines INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS download_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          aweme_id TEXT NOT NULL,
          link_id INTEGER REFERENCES links(id) ON DELETE SET NULL,
          profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          sidecar_job_id TEXT,
          status TEXT NOT NULL,
          error TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          record_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_download_attempts_aweme
          ON download_attempts(aweme_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_download_attempts_sidecar
          ON download_attempts(sidecar_job_id);
        """
    )


def migrate_video_quality_audits(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS video_quality_audit_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          generated_at TEXT NOT NULL,
          since_at TEXT,
          min_digg_count INTEGER NOT NULL DEFAULT 0,
          max_digg_count INTEGER NOT NULL DEFAULT 0,
          max_current_long_edge INTEGER NOT NULL DEFAULT 0,
          downloaded_count INTEGER NOT NULL DEFAULT 0,
          probe_error_count INTEGER NOT NULL DEFAULT 0,
          candidate_count INTEGER NOT NULL DEFAULT 0,
          checked_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          upgrade_count INTEGER NOT NULL DEFAULT 0,
          applied_count INTEGER NOT NULL DEFAULT 0,
          report_path TEXT,
          backup_path TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_video_quality_audit_runs_generated
          ON video_quality_audit_runs(generated_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS video_quality_audit_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES video_quality_audit_runs(id) ON DELETE CASCADE,
          link_id INTEGER,
          profile_id INTEGER,
          aweme_id TEXT NOT NULL,
          digg_count INTEGER NOT NULL DEFAULT 0,
          source_path TEXT,
          downloaded_at TEXT,
          metadata_width INTEGER NOT NULL DEFAULT 0,
          metadata_height INTEGER NOT NULL DEFAULT 0,
          local_width INTEGER NOT NULL DEFAULT 0,
          local_height INTEGER NOT NULL DEFAULT 0,
          local_bit_rate INTEGER NOT NULL DEFAULT 0,
          local_size_bytes INTEGER NOT NULL DEFAULT 0,
          best_width INTEGER NOT NULL DEFAULT 0,
          best_height INTEGER NOT NULL DEFAULT 0,
          best_bit_rate INTEGER NOT NULL DEFAULT 0,
          local_pixels INTEGER NOT NULL DEFAULT 0,
          best_pixels INTEGER NOT NULL DEFAULT 0,
          audit_status TEXT NOT NULL,
          upgrade_available INTEGER NOT NULL DEFAULT 0,
          probe_error TEXT,
          api_error TEXT,
          redownload_status TEXT NOT NULL DEFAULT 'not_requested',
          queued_at TEXT,
          completed_at TEXT,
          verified_width INTEGER NOT NULL DEFAULT 0,
          verified_height INTEGER NOT NULL DEFAULT 0,
          verified_at TEXT,
          verification_status TEXT NOT NULL DEFAULT 'not_checked',
          verification_error TEXT,
          raw_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, aweme_id)
        );
        CREATE INDEX IF NOT EXISTS idx_video_quality_audit_items_aweme
          ON video_quality_audit_items(aweme_id, run_id DESC);
        CREATE INDEX IF NOT EXISTS idx_video_quality_audit_items_status
          ON video_quality_audit_items(audit_status, redownload_status, run_id DESC);
        CREATE INDEX IF NOT EXISTS idx_video_quality_audit_items_digg
          ON video_quality_audit_items(digg_count DESC, run_id DESC);
        """
    )
    item_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(video_quality_audit_items)").fetchall()
    }
    verification_columns = {
        "verified_width": "INTEGER NOT NULL DEFAULT 0",
        "verified_height": "INTEGER NOT NULL DEFAULT 0",
        "verified_at": "TEXT",
        "verification_status": "TEXT NOT NULL DEFAULT 'not_checked'",
        "verification_error": "TEXT",
    }
    for name, definition in verification_columns.items():
        if name not in item_columns:
            conn.execute(f"ALTER TABLE video_quality_audit_items ADD COLUMN {name} {definition}")


def merge_profile_alias(conn: sqlite3.Connection, target_id: int, source_id: int) -> dict[str, int]:
    if target_id == source_id:
        return {"links": 0, "duplicates": 0, "files": 0}
    target = conn.execute("SELECT * FROM profiles WHERE id=?", (target_id,)).fetchone()
    source = conn.execute("SELECT * FROM profiles WHERE id=?", (source_id,)).fetchone()
    if target is None or source is None:
        return {"links": 0, "duplicates": 0, "files": 0}
    nickname_history = parse_profile_history(target["nickname_history_json"])
    for observation in parse_profile_history(source["nickname_history_json"]):
        nickname_history = merge_profile_history_value(
            nickname_history, observation["value"], observation["first_seen_at"] or observation["last_seen_at"]
        )
        nickname_history = merge_profile_history_value(
            nickname_history, observation["value"], observation["last_seen_at"] or observation["first_seen_at"]
        )
    favorited_history = parse_profile_history(target["total_favorited_history_json"], numeric=True)
    for observation in parse_profile_history(source["total_favorited_history_json"], numeric=True):
        favorited_history = merge_profile_history_value(
            favorited_history, observation["value"], observation["first_seen_at"] or observation["last_seen_at"], numeric=True
        )
        favorited_history = merge_profile_history_value(
            favorited_history, observation["value"], observation["last_seen_at"] or observation["first_seen_at"], numeric=True
        )

    conn.execute(
        """
        UPDATE profiles SET
          title=COALESCE(NULLIF(title, ''), NULLIF(?, '')),
          uid=COALESCE(NULLIF(uid, ''), NULLIF(?, '')),
          nickname=COALESCE(NULLIF(nickname, ''), NULLIF(?, '')),
          avatar_url=COALESCE(NULLIF(avatar_url, ''), NULLIF(?, '')),
          unique_id=COALESCE(NULLIF(unique_id, ''), NULLIF(?, '')),
          short_id=COALESCE(NULLIF(short_id, ''), NULLIF(?, '')),
          signature=COALESCE(NULLIF(signature, ''), NULLIF(?, '')),
          ip_location=COALESCE(NULLIF(ip_location, ''), NULLIF(?, '')),
          following_count=COALESCE(following_count, ?),
          follower_count=COALESCE(follower_count, ?),
          total_favorited=COALESCE(total_favorited, ?),
          aweme_count=COALESCE(aweme_count, ?),
          has_deleted_works=MAX(COALESCE(has_deleted_works, 0), ?),
          favoriting_count=COALESCE(favoriting_count, ?),
          gender=COALESCE(gender, ?),
          age=COALESCE(age, ?),
          verification=COALESCE(NULLIF(verification, ''), NULLIF(?, '')),
          nickname_history_json=?,
          total_favorited_history_json=?,
          profile_raw_json=CASE
            WHEN COALESCE(profile_raw_json, '{}')='{}' THEN COALESCE(NULLIF(?, ''), '{}')
            ELSE profile_raw_json
          END,
          profile_collected_at=CASE
            WHEN COALESCE(profile_collected_at, '') >= COALESCE(?, '') THEN profile_collected_at ELSE ?
          END,
          is_following=MAX(COALESCE(is_following, 0), ?),
          following_discovered_at=COALESCE(following_discovered_at, ?),
          created_at=CASE WHEN created_at <= ? THEN created_at ELSE ? END,
          updated_at=CASE WHEN updated_at >= ? THEN updated_at ELSE ? END,
          last_extracted_at=CASE
            WHEN COALESCE(last_extracted_at, '') >= COALESCE(?, '') THEN last_extracted_at ELSE ?
          END
        WHERE id=?
        """,
        (
            source["title"],
            source["uid"],
            source["nickname"],
            source["avatar_url"],
            source["unique_id"],
            source["short_id"],
            source["signature"],
            source["ip_location"],
            source["following_count"],
            source["follower_count"],
            source["total_favorited"],
            source["aweme_count"],
            int(source["has_deleted_works"] or 0),
            source["favoriting_count"],
            source["gender"],
            source["age"],
            source["verification"],
            json.dumps(nickname_history, ensure_ascii=False, separators=(",", ":")),
            json.dumps(favorited_history, ensure_ascii=False, separators=(",", ":")),
            source["profile_raw_json"],
            source["profile_collected_at"],
            source["profile_collected_at"],
            int(source["is_following"] or 0),
            source["following_discovered_at"],
            source["created_at"],
            source["created_at"],
            source["updated_at"],
            source["updated_at"],
            source["last_extracted_at"],
            source["last_extracted_at"],
            target_id,
        ),
    )

    status_rank = {"failed": 0, "pending": 1, "downloading": 2, "downloaded": 3}
    duplicates = conn.execute(
        """
        SELECT source_links.*, target_links.id target_link_id,
          target_links.status target_status, target_links.attempts target_attempts,
          target_links.downloaded_at target_downloaded_at,
          target_links.local_file_names target_local_file_names,
          target_links.local_file_paths target_local_file_paths,
          target_links.preview_path target_preview_path,
          target_links.local_cover_path target_local_cover_path,
          target_links.output_dir target_output_dir
        FROM links source_links
        JOIN links target_links
          ON target_links.profile_id=? AND target_links.aweme_id=source_links.aweme_id
        WHERE source_links.profile_id=?
        """,
        (target_id, source_id),
    ).fetchall()
    files_merged = 0
    for link in duplicates:
        source_status = str(link["status"] or "pending")
        target_status = str(link["target_status"] or "pending")
        merged_status = source_status if status_rank.get(source_status, 0) > status_rank.get(target_status, 0) else target_status
        prefer_source_files = status_rank.get(source_status, 0) > status_rank.get(target_status, 0)
        conn.execute(
            """
            UPDATE links SET
              status=?,
              attempts=MAX(COALESCE(attempts, 0), ?),
              downloaded_at=COALESCE(downloaded_at, ?),
              local_file_names=COALESCE(NULLIF(?, ''), NULLIF(local_file_names, '')),
              local_file_paths=COALESCE(NULLIF(?, ''), NULLIF(local_file_paths, '')),
              preview_path=COALESCE(NULLIF(?, ''), NULLIF(preview_path, '')),
              local_cover_path=COALESCE(NULLIF(?, ''), NULLIF(local_cover_path, '')),
              output_dir=COALESCE(NULLIF(?, ''), NULLIF(output_dir, '')),
              last_error=CASE WHEN ?='downloaded' THEN NULL ELSE last_error END
            WHERE id=?
            """,
            (
                merged_status,
                int(link["attempts"] or 0),
                link["downloaded_at"],
                link["local_file_names"] if prefer_source_files else link["target_local_file_names"],
                link["local_file_paths"] if prefer_source_files else link["target_local_file_paths"],
                link["preview_path"] if prefer_source_files else link["target_preview_path"],
                link["local_cover_path"] if prefer_source_files else link["target_local_cover_path"],
                link["output_dir"] if prefer_source_files else link["target_output_dir"],
                merged_status,
                int(link["target_link_id"]),
            ),
        )
        before = conn.total_changes
        conn.execute(
            """
            INSERT INTO link_files(
              link_id, profile_id, aweme_id, role, kind, file_name, file_path,
              absolute_path, size_bytes, exists_on_disk, recorded_at
            )
            SELECT ?, ?, aweme_id, role, kind, file_name, file_path,
              absolute_path, size_bytes, exists_on_disk, recorded_at
            FROM link_files
            WHERE link_id=?
            ON CONFLICT(profile_id, aweme_id, file_path) DO UPDATE SET
              link_id=excluded.link_id,
              absolute_path=COALESCE(NULLIF(link_files.absolute_path, ''), excluded.absolute_path),
              size_bytes=COALESCE(link_files.size_bytes, excluded.size_bytes),
              exists_on_disk=MAX(link_files.exists_on_disk, excluded.exists_on_disk),
              recorded_at=CASE
                WHEN link_files.recorded_at >= excluded.recorded_at THEN link_files.recorded_at
                ELSE excluded.recorded_at
              END
            """,
            (int(link["target_link_id"]), target_id, int(link["id"])),
        )
        files_merged += conn.total_changes - before
        conn.execute("DELETE FROM links WHERE id=?", (int(link["id"]),))

    moved_links = int(
        conn.execute("SELECT COUNT(*) c FROM links WHERE profile_id=?", (source_id,)).fetchone()["c"]
    )
    conn.execute("UPDATE links SET profile_id=? WHERE profile_id=?", (target_id, source_id))
    conn.execute("UPDATE link_files SET profile_id=? WHERE profile_id=?", (target_id, source_id))
    conn.execute("UPDATE jobs SET profile_id=? WHERE profile_id=?", (target_id, source_id))
    source_queue = conn.execute(
        "SELECT * FROM profile_download_queue WHERE profile_id=?", (source_id,)
    ).fetchone()
    if source_queue:
        conn.execute(
            """
            INSERT INTO profile_download_queue(profile_id, sort_order, enabled, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(profile_id) DO UPDATE SET
              sort_order=MIN(profile_download_queue.sort_order, excluded.sort_order),
              enabled=MAX(profile_download_queue.enabled, excluded.enabled),
              updated_at=CASE
                WHEN profile_download_queue.updated_at >= excluded.updated_at THEN profile_download_queue.updated_at
                ELSE excluded.updated_at
              END
            """,
            (
                target_id,
                source_queue["sort_order"],
                source_queue["enabled"],
                source_queue["created_at"],
                source_queue["updated_at"],
            ),
        )
    conn.execute(
        """
        UPDATE profiles
        SET full_scan_required=MAX(COALESCE(full_scan_required, 0), ?),
            full_scan_reason=COALESCE(NULLIF(full_scan_reason, ''), NULLIF(?, '')),
            full_scan_required_at=COALESCE(full_scan_required_at, ?),
            last_full_scan_at=CASE
              WHEN COALESCE(last_full_scan_at, '') >= COALESCE(?, '') THEN last_full_scan_at ELSE ?
            END,
            last_full_scan_aweme_count=COALESCE(last_full_scan_aweme_count, ?),
            last_full_scan_link_total=COALESCE(last_full_scan_link_total, ?)
        WHERE id=?
        """,
        (
            int(source["full_scan_required"] or 0),
            source["full_scan_reason"],
            source["full_scan_required_at"],
            source["last_full_scan_at"],
            source["last_full_scan_at"],
            source["last_full_scan_aweme_count"],
            source["last_full_scan_link_total"],
            target_id,
        ),
    )
    conn.execute(
        "UPDATE profile_collection_history SET profile_id=? WHERE profile_id=?",
        (target_id, source_id),
    )
    target_status = str(target["account_status"] or "active").strip().lower()
    source_status = str(source["account_status"] or "active").strip().lower()
    if "banned" in {target_status, source_status}:
        banned_row = source if source_status == "banned" else target
        conn.execute(
            """
            UPDATE profiles
            SET account_status='banned',
                account_status_reason=COALESCE(NULLIF(?, ''), account_status_reason),
                account_status_detected_at=COALESCE(?, account_status_detected_at),
                has_deleted_works=0,
                full_scan_required=0,
                full_scan_reason=NULL,
                full_scan_required_at=NULL
            WHERE id=?
            """,
            (
                banned_row["account_status_reason"],
                banned_row["account_status_detected_at"],
                target_id,
            ),
        )
        conn.execute(
            "UPDATE links SET is_missing_from_profile=0, missing_from_profile_at=NULL WHERE profile_id=?",
            (target_id,),
        )
    conn.execute("DELETE FROM profile_download_queue WHERE profile_id=?", (source_id,))
    conn.execute("DELETE FROM profiles WHERE id=?", (source_id,))
    return {"links": moved_links, "duplicates": len(duplicates), "files": files_merged}


def migrate_self_profile_aliases(conn: sqlite3.Connection) -> None:
    aliases = conn.execute(
        """
        SELECT id FROM profiles
        WHERE tab='like'
          AND (LOWER(TRIM(COALESCE(sec_uid, '')))='self' OR LOWER(url) LIKE '%/user/self%')
        ORDER BY id
        """
    ).fetchall()
    if not aliases:
        return
    canonical_url = f"https://www.douyin.com/user/{LIBRARY_SEC_UID}?showTab=like"
    target = conn.execute(
        "SELECT id FROM profiles WHERE sec_uid=? AND tab='like' ORDER BY id LIMIT 1",
        (LIBRARY_SEC_UID,),
    ).fetchone()
    target_id = int(target["id"]) if target else 0
    merged_links = merged_duplicates = merged_files = 0
    for alias in aliases:
        source_id = int(alias["id"])
        if not target_id:
            conn.execute(
                "UPDATE profiles SET sec_uid=?, url=?, updated_at=? WHERE id=?",
                (LIBRARY_SEC_UID, canonical_url, now_iso(), source_id),
            )
            target_id = source_id
            continue
        result = merge_profile_alias(conn, target_id, source_id)
        merged_links += result["links"]
        merged_duplicates += result["duplicates"]
        merged_files += result["files"]
    conn.execute(
        "UPDATE settings SET value=? WHERE key='profile_url' AND LOWER(value) LIKE '%/user/self%'",
        (canonical_url,),
    )
    conn.execute(
        """
        INSERT INTO events(ts, level, message)
        VALUES(?, 'info', ?)
        """,
        (
            now_iso(),
            f"本人喜欢主页已归并：新增 {merged_links}，去重 {merged_duplicates}，文件记录 {merged_files}",
        ),
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


def create_job(
    kind: str,
    message: str = "",
    profile_id: int | None = None,
    *,
    status: str = "running",
) -> int:
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO jobs(type, status, profile_id, message, started_at) VALUES(?, ?, ?, ?, ?)",
            (kind, status, profile_id, message, now_iso()),
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
