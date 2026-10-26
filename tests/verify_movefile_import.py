import contextlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from import_movefile_plan import import_incoming


class MoveImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fanhao-move-import-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.person = self.root / "Primary"
        self.person.mkdir()
        self.db = self.root / "catalog.sqlite"
        with self.connection() as conn:
            conn.executescript("""
                CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT,name_search TEXT,display_name TEXT,folder_path TEXT,movie_count INTEGER,status TEXT,error TEXT,source TEXT,created_at TEXT,updated_at TEXT,gender TEXT);
                CREATE TABLE person_aliases(id INTEGER PRIMARY KEY,person_id INTEGER,alias TEXT);
                CREATE TABLE person_library_locations(id INTEGER PRIMARY KEY,person_id INTEGER,path TEXT,path_key TEXT UNIQUE,source TEXT,created_at TEXT,updated_at TEXT);
                CREATE TABLE works(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT,code_search TEXT,title TEXT,fields_json TEXT,status TEXT,error TEXT,source TEXT,created_at TEXT,updated_at TEXT);
                CREATE TABLE local_works(id INTEGER PRIMARY KEY AUTOINCREMENT,work_id INTEGER REFERENCES works(id),local_path TEXT,source_info_path TEXT,source_info_id TEXT,source_name TEXT,source_size INTEGER,source_mtime TEXT,detected_code TEXT,detected_code_search TEXT,matched_by TEXT,confidence REAL,created_at TEXT,updated_at TEXT);
                CREATE TABLE local_files(id INTEGER PRIMARY KEY AUTOINCREMENT,work_id INTEGER REFERENCES works(id),local_work_id INTEGER REFERENCES local_works(id),file_id TEXT UNIQUE,file_type TEXT,file_path TEXT,name TEXT,title TEXT,ext TEXT,relative_path TEXT,size INTEGER,modified_at TEXT,playable INTEGER,sort_order INTEGER,created_at TEXT,updated_at TEXT);
                CREATE TABLE work_people(work_id INTEGER REFERENCES works(id),person_id INTEGER REFERENCES people(id),role TEXT,sort_order INTEGER,source TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(work_id,person_id,role));
                INSERT INTO people(id,name,display_name) VALUES(1,'Primary','Primary');
                INSERT INTO works(id,code,code_search,title) VALUES(1,'ABC-123','abc123','existing'),(2,'NEW-999','new999','catalog only');
                INSERT INTO work_people(work_id,person_id,role) VALUES(1,1,'actor'),(2,1,'actor');
            """)
            old = self.person / "ABC-123 old" / "original.mp4"
            old.parent.mkdir(); old.write_bytes(b"existing video")
            conn.execute("INSERT INTO local_works(id,work_id,local_path,detected_code_search) VALUES(11,1,?,'abc123')", (str(old.parent),))
            conn.execute("INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path) VALUES(21,1,11,'keep-existing-id','video',?)", (str(old),))
        self.units = []
        for name in ("ABC-123 [合并保留-fixture]", "NEW-999 incoming"):
            target = self.person / name
            target.mkdir(); file = target / "video.mp4"; file.write_bytes(b"incoming video")
            self.units.append({"directory": True, "indexed": False, "target": str(target), "files": [{"target": str(file)}]})
        self.plan = {"dbPath": str(self.db), "tasks": [{"personId": 1, "target": str(self.person), "units": self.units}]}

    @contextlib.contextmanager
    def connection(self):
        with contextlib.closing(sqlite3.connect(self.db)) as conn:
            conn.row_factory = sqlite3.Row
            with conn:
                yield conn

    def test_existing_live_variant_and_ids_are_preserved(self):
        result = import_incoming(self.plan)
        with self.connection() as conn:
            self.assertEqual(conn.execute("SELECT file_id FROM local_files WHERE id=21").fetchone()[0], "keep-existing-id")
            self.assertEqual(conn.execute("SELECT local_path FROM local_works WHERE id=11").fetchone()[0], str(self.person / "ABC-123 old"))
        self.assertNotEqual(result["units"][0]["workId"], 1)
        self.assertEqual(result["units"][1]["workId"], 2, "reuse an unambiguous catalog-only work")

    def test_retry_keeps_every_row_id(self):
        import_incoming(self.plan)
        with self.connection() as conn:
            before = {table: [tuple(row) for row in conn.execute("SELECT * FROM " + table + " ORDER BY id")] for table in ("local_files", "local_works")}
        again = import_incoming(self.plan)
        self.assertTrue(all(unit["alreadyImported"] for unit in again["units"]))
        with self.connection() as conn:
            after = {table: [tuple(row) for row in conn.execute("SELECT * FROM " + table + " ORDER BY id")] for table in before}
        self.assertEqual(before, after)

    def test_changed_person_identity_rolls_back(self):
        self.plan["tasks"][0]["personId"] = 9
        with self.assertRaisesRegex(ValueError, "different person"):
            import_incoming(self.plan)
        with self.connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM local_works").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
