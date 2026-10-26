"""Offline matching checks; all directories and SQLite data are temporary."""
import contextlib
import io
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import movefile


class MoveIdentityTests(unittest.TestCase):
    @contextlib.contextmanager
    def connection(self):
        with contextlib.closing(sqlite3.connect(self.db)) as conn:
            with conn:
                yield conn

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fanhao-move-identity-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.incoming = self.root / "incoming" / "VR"
        self.destination = self.root / "library" / "VR"
        self.source = self.incoming / "持野蓬"
        self.target = self.destination / "設楽ゆうひ"
        self.source.mkdir(parents=True)
        self.target.mkdir(parents=True)
        self.db = self.root / "identity.sqlite"
        with self.connection() as conn:
            conn.executescript("""
                CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT,display_name TEXT,folder_path TEXT);
                CREATE TABLE person_aliases(person_id INTEGER,alias TEXT);
                CREATE TABLE person_redirects(source_id INTEGER PRIMARY KEY,target_id INTEGER);
                CREATE TABLE person_library_locations(person_id INTEGER,path TEXT);
                CREATE TABLE local_works(local_path TEXT);
                INSERT INTO people VALUES(324,'栗宮ふたば','栗宮ふたば',NULL);
                INSERT INTO people VALUES(504,'設楽ゆうひ','設楽ゆうひ',NULL);
                INSERT INTO person_aliases VALUES(324,'持野蓬'),(324,'設楽ゆうひ');
            """)
            conn.execute("INSERT INTO person_library_locations VALUES(504,?)", (str(self.target),))

    def merge(self):
        with self.connection() as conn:
            conn.execute("INSERT INTO person_redirects VALUES(504,324)")

    def tasks(self, roots=None, index=None):
        mover = movefile.FileMover(
            [str(root) for root in (roots or [self.destination, self.incoming])],
            [str(self.incoming)],
            index or movefile.PersonDirectoryIndex(self.db),
        )
        with contextlib.redirect_stdout(io.StringIO()):
            return mover.collect_tasks()

    def test_alias_routes_to_confirmed_canonical_person(self):
        self.merge()
        tasks = self.tasks()
        self.assertEqual([(task.src_folder, task.dst_folder) for task in tasks], [(str(self.source), str(self.target))])

    def test_alias_does_not_merge_separate_people(self):
        self.assertEqual(self.tasks(), [])

    def test_ambiguous_source_name_is_skipped_even_with_exact_folder(self):
        with self.connection() as conn:
            conn.execute("INSERT INTO person_aliases VALUES(504,'持野蓬')")
        (self.destination / "持野蓬").mkdir()
        self.assertEqual(self.tasks(), [])

    def test_multiple_alias_destinations_are_skipped(self):
        self.merge()
        (self.destination / "栗宮ふたば").mkdir()
        self.assertEqual(self.tasks(), [])

    def test_exact_name_keeps_root_priority(self):
        self.merge()
        first = self.root / "first"
        (first / "持野蓬").mkdir(parents=True)
        (self.destination / "持野蓬").mkdir()
        tasks = self.tasks([first, self.destination, self.incoming])
        self.assertEqual(tasks[0].dst_folder, str(first / "持野蓬"))

    def test_exact_name_cannot_override_registered_owner(self):
        self.merge()
        exact = self.destination / "持野蓬"
        exact.mkdir()
        with self.connection() as conn:
            conn.execute("INSERT INTO people VALUES(999,'Other','Other',?)", (str(exact),))
        self.assertEqual(self.tasks(), [])

    def test_vr_stays_within_vr_destination_roots(self):
        self.merge()
        normal = self.root / "normal" / "栗宮ふたば"
        normal.mkdir(parents=True)
        self.target.rmdir()
        self.assertEqual(self.tasks(), [])

    def test_unavailable_destination_does_not_hide_valid_alias(self):
        self.merge()
        self.assertEqual(len(self.tasks([self.root / "missing", self.destination, self.incoming])), 1)

    def test_unknown_names_retain_exact_matching(self):
        (self.incoming / "Unknown").mkdir()
        (self.destination / "Unknown").mkdir()
        tasks = self.tasks()
        self.assertEqual([Path(task.src_folder).name for task in tasks], ["Unknown"])

    def test_legacy_constructor_retains_exact_matching(self):
        (self.destination / "持野蓬").mkdir()
        tasks = self.tasks(index=movefile.PersonDirectoryIndex())
        self.assertEqual(tasks[0].dst_folder, str(self.destination / "持野蓬"))

    def test_recovery_plan_is_preserved(self):
        self.merge()
        (self.source / ".fanhao-move-plan.json").write_text("{}", encoding="utf-8")
        self.assertEqual(self.tasks(), [])

    def test_redirect_chain_resolves_and_cycle_fails(self):
        with self.connection() as conn:
            conn.executescript("INSERT INTO person_redirects VALUES(504,600),(600,324)")
        self.assertEqual(len(self.tasks()), 1)
        with self.connection() as conn:
            conn.execute("INSERT INTO person_redirects VALUES(324,504)")
        with self.assertRaisesRegex(ValueError, "PERSON_REDIRECT_CYCLE"):
            movefile.PersonDirectoryIndex(self.db)

    def test_dry_run_does_not_move_or_change_database(self):
        self.merge()
        before = self.db.read_bytes()
        with patch.object(movefile, "DEFAULT_ROOTS_NORMAL", []), \
             patch.object(movefile, "DEFAULT_ROOTS_VR", [str(self.destination), str(self.incoming)]), \
             patch.object(movefile, "SOURCE_ONLY_ROOTS_VR", [str(self.incoming)]), \
             patch.object(movefile.FileMover, "run_tasks", side_effect=AssertionError("must not move")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            movefile.main(["--db", str(self.db), "--dry-run"])
        self.assertIn("[DRY RUN]", output.getvalue())
        self.assertTrue(self.source.is_dir())
        self.assertEqual(self.db.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
