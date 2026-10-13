"""Transactional, coalesced changes for the Node library's read-only consumer.

The slim membership projection avoids reading large metadata_json overflow pages
when extraction only updates last_seen_at. Rows in the journal are retained per
entity, including deletion tombstones; polling never depends on wall-clock time.
"""

from __future__ import annotations

import sqlite3
import uuid

VERSION = 1
MEMBERSHIP_COLUMNS = (
    "id", "aweme_id", "profile_id", "last_seen_at", "is_missing_from_profile", "missing_from_profile_at",
)
VOLATILE_LINK_COLUMNS = {
    "id", "attempts", "last_error", "last_error_kind", "last_started_at", "failed_at",
    "last_seen_at", "is_missing_from_profile", "missing_from_profile_at",
}
VOLATILE_PROFILE_COLUMNS = {
    "id", "updated_at", "last_extracted_at", "auto_collect_enabled",
    "created_at", "last_full_scan_at", "last_full_scan_count",
}


def migrate_library_sync(conn: sqlite3.Connection) -> None:
    """Install once, within the caller's transaction; never open a runtime DB here."""
    conn.execute("SAVEPOINT library_sync_install")
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS library_sync_state (
            id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, generation TEXT NOT NULL
        )""")
        current = conn.execute("SELECT version FROM library_sync_state WHERE id=1").fetchone()
        triggers = conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN "
            "('library_sync_link_insert','library_sync_link_delete','library_sync_link_membership','library_sync_link_work',"
            "'library_sync_profile_insert','library_sync_profile_delete','library_sync_profile_metadata','library_sync_profile_identity')").fetchone()[0]
        if current and current[0] == VERSION and triggers == 8:
            conn.execute("RELEASE library_sync_install")
            return
        conn.execute("""CREATE TABLE IF NOT EXISTS library_sync_changes (
            revision INTEGER PRIMARY KEY AUTOINCREMENT,
            entity TEXT NOT NULL, entity_key TEXT NOT NULL,
            UNIQUE(entity, entity_key)
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS library_sync_memberships (
            link_id INTEGER PRIMARY KEY, aweme_id TEXT NOT NULL, profile_id INTEGER,
            last_seen_at TEXT NOT NULL, is_missing_from_profile INTEGER NOT NULL,
            missing_from_profile_at TEXT NOT NULL
        )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_library_sync_memberships_aweme ON library_sync_memberships(aweme_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_library_sync_memberships_profile ON library_sync_memberships(profile_id,aweme_id)")
        # These already exist on production databases, but are also part of the
        # consumer contract for older databases upgraded through this migration.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_links_aweme ON links(aweme_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_profiles_sec_tab ON profiles(sec_uid,tab)")
        link_columns = {row[1] for row in conn.execute("PRAGMA table_info(links)")}
        profile_columns = {row[1] for row in conn.execute("PRAGMA table_info(profiles)")}

        def value(prefix: str, column: str, fallback: str = "''") -> str:
            return f"COALESCE({prefix}.{column},{fallback})" if column in link_columns else fallback

        def changed(columns: set[str]) -> str:
            return " OR ".join(f'OLD."{name}" IS NOT NEW."{name}"' for name in sorted(columns)) or "0"

        def emit(entity: str, key: str, condition: str = "1") -> str:
            return f"""INSERT INTO library_sync_changes(entity,entity_key)
                SELECT '{entity}', {key} WHERE {condition} AND COALESCE({key},'')<>''
                ON CONFLICT(entity,entity_key) DO UPDATE SET revision=excluded.revision;"""

        def emit_profile_works(profile: str, entity: str = "membership") -> str:
            return f"""INSERT INTO library_sync_changes(entity,entity_key)
                SELECT '{entity}', aweme_id FROM library_sync_memberships
                WHERE profile_id={profile}.id AND aweme_id<>'' GROUP BY aweme_id
                ON CONFLICT(entity,entity_key) DO UPDATE SET revision=excluded.revision;"""

        projection = f"""INSERT INTO library_sync_memberships
            (link_id,aweme_id,profile_id,last_seen_at,is_missing_from_profile,missing_from_profile_at)
            VALUES(NEW.id,NEW.aweme_id,NEW.profile_id,{value('NEW','last_seen_at')},
                   {value('NEW','is_missing_from_profile','0')},{value('NEW','missing_from_profile_at')})
            ON CONFLICT(link_id) DO UPDATE SET aweme_id=excluded.aweme_id,profile_id=excluded.profile_id,
                last_seen_at=excluded.last_seen_at,is_missing_from_profile=excluded.is_missing_from_profile,
                missing_from_profile_at=excluded.missing_from_profile_at;"""

        def trigger(name: str, event: str, table: str, body: str, when: str = "1") -> None:
            conn.execute(f"DROP TRIGGER IF EXISTS library_sync_{name}")
            conn.execute(f"CREATE TRIGGER library_sync_{name} AFTER {event} ON {table} WHEN {when} BEGIN {body} END")

        trigger("link_insert", "INSERT", "links", projection + emit("membership", "NEW.aweme_id")
                + emit("work", "NEW.aweme_id", "NEW.status='downloaded'"))
        trigger("link_delete", "DELETE", "links", emit("membership", "OLD.aweme_id")
                + emit("work", "OLD.aweme_id", "OLD.status='downloaded'")
                + "DELETE FROM library_sync_memberships WHERE link_id=OLD.id;")
        trigger("link_membership", "UPDATE", "links",
                "DELETE FROM library_sync_memberships WHERE link_id=OLD.id AND OLD.id IS NOT NEW.id;"
                + projection + emit("membership", "OLD.aweme_id")
                + emit("membership", "NEW.aweme_id", "OLD.aweme_id IS NOT NEW.aweme_id"),
                changed(set(MEMBERSHIP_COLUMNS) & link_columns))
        trigger("link_work", "UPDATE", "links", emit("work", "OLD.aweme_id")
                + emit("work", "NEW.aweme_id", "OLD.aweme_id IS NOT NEW.aweme_id"),
                f"(OLD.status='downloaded' OR NEW.status='downloaded') AND ({changed(link_columns - VOLATILE_LINK_COLUMNS)})")
        trigger("profile_insert", "INSERT", "profiles", emit("author", "NEW.sec_uid") + emit_profile_works("NEW"))
        trigger("profile_delete", "DELETE", "profiles", emit("author", "OLD.sec_uid") + emit_profile_works("OLD")
                + emit_profile_works("OLD", "work"))
        trigger("profile_metadata", "UPDATE", "profiles", emit("author", "OLD.sec_uid")
                + emit("author", "NEW.sec_uid", "OLD.sec_uid IS NOT NEW.sec_uid"),
                changed(profile_columns - VOLATILE_PROFILE_COLUMNS))
        trigger("profile_identity", "UPDATE", "profiles", emit_profile_works("OLD") + emit_profile_works("NEW")
                + emit_profile_works("OLD", "work") + emit_profile_works("NEW", "work"),
                changed({"id", "tab", "sec_uid"}))

        conn.execute("DELETE FROM library_sync_memberships")
        conn.execute(f"""INSERT INTO library_sync_memberships
            SELECT l.id,l.aweme_id,l.profile_id,{value('l','last_seen_at')},
                   {value('l','is_missing_from_profile','0')},{value('l','missing_from_profile_at')}
            FROM links l""")
        conn.execute("DELETE FROM library_sync_changes")
        conn.execute("""INSERT INTO library_sync_changes(entity,entity_key)
            SELECT 'membership',aweme_id FROM library_sync_memberships WHERE aweme_id<>'' GROUP BY aweme_id""")
        conn.execute("""INSERT INTO library_sync_changes(entity,entity_key)
            SELECT 'work',aweme_id FROM links WHERE status='downloaded' AND aweme_id<>'' GROUP BY aweme_id""")
        conn.execute("""INSERT INTO library_sync_changes(entity,entity_key)
            SELECT 'author',sec_uid FROM profiles WHERE COALESCE(sec_uid,'')<>'' GROUP BY sec_uid""")
        conn.execute("INSERT OR REPLACE INTO library_sync_state VALUES(1,?,?)", (VERSION, uuid.uuid4().hex))
        conn.execute("RELEASE library_sync_install")
    except BaseException:
        conn.execute("ROLLBACK TO library_sync_install")
        conn.execute("RELEASE library_sync_install")
        raise
