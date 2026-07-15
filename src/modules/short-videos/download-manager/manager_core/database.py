"""Internal database responsibilities for the download manager."""

from __future__ import annotations

import sqlite3
from typing import Any

from .common import normalize_int, now_iso, parse_profile_url
from .config import CONFIG_DIR, DATA_DIR, DB_PATH, DEFAULT_COOKIE_FILE, DEFAULT_FAILURE_GUARD_THRESHOLD, DEFAULT_LIBRARY_OUTPUT_DIR, DEFAULT_OUTPUT_DIR, DOWNLOADER_PYTHON, DOWNLOADER_ROOT, DOWNLOADER_RUN, LIBRARY_SEC_UID, LOG_DIR, TEST_PROFILE_URL


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
        migrate_video_quality_audits(conn)
        migrate_self_profile_aliases(conn)
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
        from .queue import seed_download_queue

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
          favoriting_count=COALESCE(favoriting_count, ?),
          gender=COALESCE(gender, ?),
          age=COALESCE(age, ?),
          verification=COALESCE(NULLIF(verification, ''), NULLIF(?, '')),
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
            source["favoriting_count"],
            source["gender"],
            source["age"],
            source["verification"],
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
