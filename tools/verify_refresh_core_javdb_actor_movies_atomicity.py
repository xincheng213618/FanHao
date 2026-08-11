from __future__ import annotations

import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory

from refresh_core_javdb_actor_movies import (
    refresh_error_message,
    rollback_person_refresh,
    save_person_refresh,
)


class NoDownloadClient:
    def get_driver(self):
        raise AssertionError("the ordinary-failure fixture must not download avatars")


def main() -> None:
    with TemporaryDirectory(prefix="fanhao-actor-refresh-") as temporary:
        conn = sqlite3.connect(Path(temporary) / "core.sqlite")
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("ATTACH DATABASE ? AS fanhao_images", (str(Path(temporary) / "images.sqlite"),))
            conn.execute("PRAGMA fanhao_images.journal_mode = WAL")
            assert conn.execute("PRAGMA main.journal_mode").fetchone()[0] == "wal"
            assert conn.execute("PRAGMA fanhao_images.journal_mode").fetchone()[0] == "wal"
            create_schema(conn)
            verify_failed_first_person_does_not_leak_into_second(conn)
            verify_rollback_failure_keeps_original_error()
        finally:
            conn.close()
    print("core JavDB actor per-person atomicity verification passed")


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE people (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          name_search TEXT,
          display_name TEXT,
          movie_count INTEGER,
          status TEXT NOT NULL,
          error TEXT,
          source TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE person_external_refs (
          id INTEGER PRIMARY KEY,
          person_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          external_key TEXT NOT NULL,
          url TEXT,
          source TEXT,
          created_at TEXT,
          updated_at TEXT,
          UNIQUE(provider, external_key)
        );
        CREATE TABLE person_aliases (
          id INTEGER PRIMARY KEY,
          person_id INTEGER NOT NULL,
          alias TEXT NOT NULL,
          alias_search TEXT NOT NULL,
          source TEXT NOT NULL,
          UNIQUE(person_id, alias_search, source)
        );
        CREATE TABLE fanhao_images.images (
          id INTEGER PRIMARY KEY,
          owner_type TEXT NOT NULL,
          owner_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          source_type TEXT,
          remote_url TEXT,
          mime TEXT,
          image_blob BLOB,
          byte_size INTEGER,
          sort_order INTEGER,
          status TEXT,
          source TEXT NOT NULL,
          legacy_table TEXT,
          legacy_key TEXT,
          created_at TEXT,
          updated_at TEXT,
          UNIQUE(owner_type, owner_id, kind, source)
        );
        INSERT INTO people VALUES (1, 'Old One', 'oldone', '', 1, 'error', 'old one error', 'migration', '2026-08-10T00:00:00Z');
        INSERT INTO people VALUES (2, 'Old Two', 'oldtwo', '', 2, 'error', 'old two error', 'migration', '2026-08-10T01:00:00Z');
        CREATE TRIGGER fanhao_images.fail_first_person_avatar
        BEFORE INSERT ON images
        WHEN NEW.owner_id = 1
        BEGIN
          SELECT RAISE(ABORT, 'forced first-person image failure');
        END;
        """
    )


def record(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> dict | None:
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def records(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def verify_failed_first_person_does_not_leak_into_second(conn: sqlite3.Connection) -> None:
    before_first = record(conn, "SELECT * FROM people WHERE id = 1")
    jobs = [
        {
            "id": 1,
            "name": "New One",
            "db_name": "Old One",
            "actor_id": "actor-one",
            "actor_url": "https://javdb.test/actors/actor-one",
        },
        {
            "id": 2,
            "name": "New Two",
            "db_name": "Old Two",
            "actor_id": "actor-two",
            "actor_url": "https://javdb.test/actors/actor-two",
        },
    ]
    crawls = [
        {
            "profile": {"aliases": ["Alias One"], "avatar_url": "https://images.test/one.jpg", "movie_count": 11},
            "movies": [],
        },
        {
            "profile": {"aliases": ["Alias Two"], "avatar_url": "https://images.test/two.jpg", "movie_count": 22},
            "movies": [],
        },
    ]
    failures = []
    successes = []
    for job, crawl in zip(jobs, crawls):
        try:
            successes.append((job["id"], save_person_refresh(conn, job, crawl, NoDownloadClient())))
        except sqlite3.DatabaseError as error:
            failures.append((job["id"], str(error)))
        assert not conn.in_transaction, f"person {job['id']} must leave no open transaction"

    assert failures == [(1, "forced first-person image failure")]
    assert [person_id for person_id, _ in successes] == [2]
    assert record(conn, "SELECT * FROM people WHERE id = 1") == before_first
    assert records(conn, "SELECT * FROM person_external_refs WHERE person_id = 1") == []
    assert records(conn, "SELECT * FROM person_aliases WHERE person_id = 1") == []
    assert record(conn, "SELECT COUNT(*) AS count FROM fanhao_images.images WHERE owner_id = 1") == {"count": 0}

    second = record(conn, "SELECT * FROM people WHERE id = 2")
    assert second is not None
    assert second["display_name"] == "New Two"
    assert second["movie_count"] == 22
    assert second["status"] == "ok"
    assert second["error"] is None
    assert second["source"] == "actor_movies"
    assert second["updated_at"] != "2026-08-10T01:00:00Z"
    assert records(conn, "SELECT provider, external_key FROM person_external_refs ORDER BY person_id") == [
        {"provider": "javdb-actor", "external_key": "actor-two"}
    ]
    assert {row["alias"] for row in records(conn, "SELECT alias FROM person_aliases WHERE person_id = 2")} == {"Alias Two", "Old Two"}
    assert record(conn, "SELECT owner_id, remote_url FROM fanhao_images.images") == {
        "owner_id": 2,
        "remote_url": "https://images.test/two.jpg",
    }


def verify_rollback_failure_keeps_original_error() -> None:
    class BrokenRollbackConnection:
        def execute(self, _sql: str):
            raise sqlite3.OperationalError("savepoint rollback exploded")

        def rollback(self):
            raise sqlite3.OperationalError("connection rollback exploded")

    original = ValueError("original image write failure")
    rollback_person_refresh(BrokenRollbackConnection(), original)
    message = refresh_error_message(original)
    assert message.startswith("original image write failure; person savepoint rollback failed")
    assert "savepoint rollback exploded" in message
    assert "connection rollback exploded" in message


if __name__ == "__main__":
    main()
