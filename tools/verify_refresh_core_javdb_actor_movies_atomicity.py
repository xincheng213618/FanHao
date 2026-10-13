from __future__ import annotations

import sqlite3
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import refresh_core_javdb_actor_movies as refresh_module
import backfill_javdb_metadata as metadata_module
import import_javdb_actor as actor_module
from backfill_javdb_actor_page import actor_page_looks_ready
from refresh_core_javdb_actor_movies import (
    PersonRefreshRollbackError,
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
            verify_browser_upgrade_uses_matching_driver(Path(temporary))
            verify_actor_names_and_avatar_sync(conn)
            verify_security_challenge_is_not_an_actor_page()
            verify_failed_first_person_does_not_leak_into_second(conn)
            verify_reservation_and_publication_guards(conn)
            verify_rollback_failure_keeps_original_error()
            verify_double_rollback_failure_is_fatal()
        finally:
            conn.close()
    print("core JavDB actor per-person atomicity verification passed")


def verify_browser_upgrade_uses_matching_driver(temporary: Path) -> None:
    args = SimpleNamespace(
        scraper_config_data={}, chrome_binary=temporary / "chrome.exe", profile_dir=temporary,
        driver_path=None, proxy="", no_proxy=True, headless=True,
    )
    for module in (metadata_module, actor_module):
        with patch.object(module, "latest_cached_chromedriver", return_value=temporary / "old-152.exe") as old_cache, \
             patch("webdriver_manager.chrome.ChromeDriverManager") as manager, \
             patch("selenium.webdriver.Chrome") as chrome, \
             patch.object(metadata_module.JavDbClient, "inject_external_cookies"):
            manager.return_value.install.side_effect = [str(temporary / "driver-154.exe"), str(temporary / "driver-155.exe")]
            for expected_version in (154, 155):
                if module is metadata_module:
                    module.JavDbClient(args).get_driver()
                else:
                    module.get_driver(temporary, headless=True, chrome_binary=args.chrome_binary)
                assert chrome.call_args.kwargs["service"].path == str(temporary / f"driver-{expected_version}.exe")
            old_cache.assert_not_called()
            assert manager.return_value.install.call_count == 2

            explicit_driver = temporary / "explicit-driver.exe"
            explicit_driver.touch()
            args.driver_path = explicit_driver
            if module is metadata_module:
                module.JavDbClient(args).get_driver()
            else:
                module.get_driver(temporary, chrome_binary=args.chrome_binary, driver_path=explicit_driver)
            assert chrome.call_args.kwargs["service"].path == str(explicit_driver)
            assert manager.return_value.install.call_count == 2
            args.driver_path = None


def verify_actor_names_and_avatar_sync(conn: sqlite3.Connection) -> None:
    html = """
    <section class="actor-section">
      <div class="actor-avatar"><div class="avatar" style="background-image: url('/avatars/example.jpg')"></div></div>
      <h1 class="actor-section-name">愛花未滿, 愛花あゆみ</h1>
      <div class="section-meta">赤崎理奈, 柏木あゆみ, 相田亜由美, 五日市芽依</div>
      <div class="section-meta">344 部影片</div>
    </section>
    """
    profile = actor_module.parse_actor_page(html, "https://javdb.test/actors/example")
    expected_aliases = {"愛花あゆみ", "赤崎理奈", "柏木あゆみ", "相田亜由美", "五日市芽依"}
    assert profile["display_name"] == "愛花未滿"
    assert set(profile["aliases"]) == expected_aliases
    assert profile["movie_count"] == 344
    assert profile["avatar_url"] == "https://javdb.test/avatars/example.jpg"
    conn.execute("CREATE UNIQUE INDEX fixture_person_alias_identity ON person_aliases(person_id, alias_search)")
    conn.execute("INSERT INTO people VALUES (13, '愛花あゆみ', '愛花あゆみ', '愛花未滿', 0, 'ok', NULL, 'manual', 'old')")
    conn.execute("INSERT INTO person_aliases(person_id, alias, alias_search, source) VALUES (13, '愛花あゆみ', '愛花あゆみ', 'manual')")
    conn.commit()
    job = {"id": 13, "name": "愛花未滿", "db_name": "愛花あゆみ", "actor_id": "example", "actor_url": "https://javdb.test/actors/example"}
    client = SimpleNamespace(get_driver=lambda: object())
    with patch.object(refresh_module, "download_avatar", return_value=(b"fixture-avatar", "image/jpeg")):
        for _ in range(2):
            result = save_person_refresh(conn, job, {"profile": profile, "movies": []}, client)
            assert result["profile"]["avatar"]
    assert {row[0] for row in conn.execute("SELECT alias FROM person_aliases WHERE person_id = 13")} == expected_aliases
    assert conn.execute("SELECT source FROM person_aliases WHERE person_id = 13 AND alias = '愛花あゆみ'").fetchone()[0] == "manual"
    assert conn.execute("SELECT movie_count FROM people WHERE id = 13").fetchone()[0] == 344
    avatars = conn.execute("SELECT remote_url, image_blob FROM fanhao_images.images WHERE owner_id = 13 AND source = 'actor_profiles'").fetchall()
    assert len(avatars) == 1
    assert tuple(avatars[0]) == (profile["avatar_url"], b"fixture-avatar")
    conn.execute("DELETE FROM person_aliases WHERE person_id = 13")
    conn.execute("DELETE FROM person_external_refs WHERE person_id = 13")
    conn.execute("DELETE FROM fanhao_images.images WHERE owner_id = 13")
    conn.execute("DELETE FROM people WHERE id = 13")
    conn.commit()


def verify_security_challenge_is_not_an_actor_page() -> None:
    challenge = """
    <html><body><h1>javdb.com</h1><h2>正在进行安全验证</h2>
    <p>请验证您是真人</p></body></html>
    """
    assert not actor_page_looks_ready(challenge, "https://javdb.com/", "9DQgV")
    assert not actor_page_looks_ready(challenge, "https://javdb.com/actors/9DQgV", "9DQgV")

    actor_page = """
    <html><body>
      <section class="actor-section">
        <h1 class="actor-section-name">ゆめ莉りか</h1>
        <div class="actor-section-meta">123 部影片</div>
      </section>
      <div class="movie-list"><div class="item">
        <a class="box" href="/v/example"><strong>TEST-123</strong></a>
      </div></div>
    </body></html>
    """
    assert actor_page_looks_ready(actor_page, "https://javdb.com/actors/9DQgV", "9DQgV")
    assert not actor_page_looks_ready(actor_page, "https://javdb.com/actors/other", "9DQgV")


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


def verify_reservation_and_publication_guards(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE cross_store_aggregate_reservations(
          aggregate_key TEXT PRIMARY KEY,
          op_id TEXT NOT NULL,
          aggregate_seq INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE actor_profile_publications(
          person_id INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          intent_sha256 TEXT NOT NULL,
          published_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO actor_profile_publications VALUES (2, 'published-two', 'digest', 'now', 'now');
        """
    )
    conn.commit()
    before_person = record(conn, "SELECT * FROM people WHERE id = 2")
    before_images = records(conn, "SELECT * FROM fanhao_images.images WHERE owner_id = 2")
    job = {
        "id": 2,
        "name": "Reserved Two",
        "db_name": "Old Two",
        "actor_id": "actor-two",
        "actor_url": "https://javdb.test/actors/actor-two",
    }
    crawl = {
        "profile": {"aliases": ["Reserved Alias"], "avatar_url": "https://images.test/reserved.jpg", "movie_count": 99},
        "movies": [],
    }
    for aggregate_key in ("person-avatar:2", "javdb-actor:actor-two"):
        conn.execute(
            "INSERT INTO cross_store_aggregate_reservations VALUES (?, ?, 1, 'now')",
            (aggregate_key, f"pending-{aggregate_key}"),
        )
        conn.commit()
        try:
            save_person_refresh(conn, job, crawl, NoDownloadClient())
        except RuntimeError as error:
            assert "可恢复任务" in str(error)
        else:
            raise AssertionError(f"Python refresh must honor {aggregate_key}")
        assert not conn.in_transaction
        assert record(conn, "SELECT * FROM people WHERE id = 2") == before_person
        assert records(conn, "SELECT * FROM fanhao_images.images WHERE owner_id = 2") == before_images
        assert record(conn, "SELECT operation_id FROM actor_profile_publications WHERE person_id = 2") == {"operation_id": "published-two"}
        conn.execute("DELETE FROM cross_store_aggregate_reservations")
        conn.commit()

    conn.execute(
        "INSERT INTO cross_store_aggregate_reservations VALUES ('person-avatar:2', 'pending-current-owner', 2, 'now')"
    )
    conn.commit()
    stealing_job = {
        "id": 1,
        "name": "Must Not Steal Actor Ref",
        "db_name": "Old One",
        "actor_id": "actor-two",
        "actor_url": "https://javdb.test/actors/actor-two",
    }
    try:
        save_person_refresh(conn, stealing_job, crawl, NoDownloadClient())
    except RuntimeError as error:
        assert "可恢复任务" in str(error)
    else:
        raise AssertionError("Python refresh must guard the JavDB key's current owner")
    assert record(conn, "SELECT person_id FROM person_external_refs WHERE external_key = 'actor-two'") == {"person_id": 2}
    conn.execute("DELETE FROM cross_store_aggregate_reservations")
    conn.commit()

    result = save_person_refresh(conn, job, crawl, NoDownloadClient())
    assert result["profile"]["avatar"] is True
    assert record(conn, "SELECT operation_id FROM actor_profile_publications WHERE person_id = 2") is None, (
        "a later Python source=actor_profiles write must retire the completed publication"
    )


def verify_rollback_failure_keeps_original_error() -> None:
    class BrokenRollbackConnection:
        def execute(self, _sql: str):
            raise sqlite3.OperationalError("savepoint rollback exploded")

        def rollback(self):
            raise sqlite3.OperationalError("connection rollback exploded")

    original = ValueError("original image write failure")
    try:
        rollback_person_refresh(BrokenRollbackConnection(), original)
    except PersonRefreshRollbackError as fatal:
        assert fatal.original_error is original
        assert str(fatal.savepoint_rollback_error) == "savepoint rollback exploded"
        assert str(fatal.connection_rollback_error) == "connection rollback exploded"
        assert fatal.errors == (original, fatal.savepoint_rollback_error, fatal.connection_rollback_error)
        assert fatal.__cause__ is original
        message = refresh_error_message(fatal)
    else:
        raise AssertionError("double rollback failure must escape as a fatal error")
    assert message.startswith("original image write failure; person savepoint rollback failed")
    assert "savepoint rollback exploded" in message
    assert "connection rollback exploded" in message


def verify_double_rollback_failure_is_fatal() -> None:
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--fatal-child"],
        capture_output=True,
        text=True,
        check=False,
    )
    output = f"{result.stdout}\n{result.stderr}"
    assert result.returncode != 0, "an unrecoverable rollback failure must make the batch exit nonzero"
    assert "crawl:1" in output
    assert "crawl:2" not in output, "the next person must not run after both rollback attempts fail"
    assert "context-exit:PersonRefreshRollbackError" in output
    assert "context-exit:normal" not in output, "the connection context must not take its normal commit path"
    assert "original image write failure" in output
    assert "savepoint rollback exploded" in output
    assert "connection rollback exploded" in output


def run_fatal_child() -> None:
    class FatalConnection:
        def __enter__(self):
            return self

        def __exit__(self, error_type, _error, _traceback):
            print(f"context-exit:{error_type.__name__ if error_type else 'normal'}", flush=True)
            return False

        def execute(self, sql: str, _params=()):
            statement = " ".join(str(sql).split())
            if statement == "BEGIN IMMEDIATE":
                return self
            if "FROM sqlite_schema" in statement:
                return self
            if "SELECT person_id FROM person_external_refs" in statement:
                return self
            if statement.startswith("SAVEPOINT "):
                return self
            if statement.startswith("DELETE FROM person_aliases"):
                return self
            if "UPDATE people" in statement:
                raise ValueError("original image write failure")
            if statement.startswith("ROLLBACK TO SAVEPOINT "):
                raise sqlite3.OperationalError("savepoint rollback exploded")
            raise AssertionError(f"unexpected SQL in fatal fixture: {statement}")

        def fetchone(self):
            return None

        def rollback(self):
            raise sqlite3.OperationalError("connection rollback exploded")

    def fake_crawl(_client, job, _args):
        print(f"crawl:{job['id']}", flush=True)
        return {"profile": {}, "movies": [], "pages": 1}

    refresh_module.crawl_actor = fake_crawl
    refresh_module.write_jsonl = lambda *_args, **_kwargs: None
    refresh_module.pause = lambda *_args, **_kwargs: None
    jobs = [
        {"id": 1, "name": "One", "db_name": "One", "actor_id": "one", "actor_url": "https://javdb.test/actors/one"},
        {"id": 2, "name": "Two", "db_name": "Two", "actor_id": "two", "actor_url": "https://javdb.test/actors/two"},
    ]
    with FatalConnection() as conn:
        refresh_module.run_refresh_jobs(conn, jobs, SimpleNamespace(write=True), NoDownloadClient(), Path("unused.jsonl"))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--fatal-child":
        run_fatal_child()
    else:
        main()
