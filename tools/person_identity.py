"""Canonical person identity shared by core-library writers; no schema writes."""
from __future__ import annotations

import os
import re
import sqlite3


def has_table(conn: sqlite3.Connection, table: str) -> bool:
    return bool(conn.execute("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", (table,)).fetchone())


def canonical_person_id(conn: sqlite3.Connection, person_id: int) -> int:
    current = int(person_id)
    if not has_table(conn, "person_redirects"):
        return current
    seen: set[int] = set()
    while current not in seen:
        seen.add(current)
        row = conn.execute("SELECT target_id FROM person_redirects WHERE source_id = ?", (current,)).fetchone()
        if not row:
            return current
        current = int(row[0])
    raise RuntimeError("PERSON_REDIRECT_CYCLE")


def location_key(value: str) -> str:
    text = str(value or "").strip()
    windows = bool(re.match(r"^[a-zA-Z]:[\\/]|^\\\\", text))
    import ntpath
    normalized = (ntpath.abspath(text) if windows else os.path.abspath(text)).replace("\\", "/").rstrip("/")
    return normalized.lower() if windows or os.name == "nt" else normalized


def bind_location(conn: sqlite3.Connection, person_id: int, value: str, now: str) -> None:
    if not value or not has_table(conn, "person_library_locations"):
        return
    person_id = canonical_person_id(conn, person_id)
    key = location_key(value)
    owner = conn.execute("SELECT person_id FROM person_library_locations WHERE path_key = ?", (key,)).fetchone()
    if owner and int(owner[0]) != person_id:
        raise RuntimeError("PERSON_LOCATION_OWNED: merge people or select the registered directory")
    conn.execute("""INSERT INTO person_library_locations(person_id,path,path_key,source,created_at,updated_at)
        VALUES (?,?,?,'local_full_scan',?,?) ON CONFLICT(path_key) DO NOTHING""", (person_id, value, key, now, now))


def assert_external_owner(conn: sqlite3.Connection, person_id: int, actor_key: str) -> None:
    if not actor_key:
        return
    owner = conn.execute("SELECT person_id FROM person_external_refs WHERE provider='javdb-actor' AND external_key=?", (actor_key,)).fetchone()
    if owner and canonical_person_id(conn, owner[0]) != canonical_person_id(conn, person_id):
        raise RuntimeError("PERSON_EXTERNAL_IDENTITY_OWNED: merge people before changing the external owner")
