import contextlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from movefile import PersonDirectoryIndex
from movefile_plan import build_plan, collect_consolidation_tasks, fingerprint, validate_plan, write_plan


class MovePlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fanhao-move-plan-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "incoming" / "Alias"
        self.target = self.root / "library" / "Primary"
        self.source.mkdir(parents=True)
        self.target.mkdir(parents=True)
        self.db = self.root / "identity.sqlite"
        with contextlib.closing(sqlite3.connect(self.db)) as conn:
            conn.executescript("CREATE TABLE people(id INTEGER,name TEXT,display_name TEXT,folder_path TEXT); CREATE TABLE person_aliases(person_id INTEGER,alias TEXT); CREATE TABLE local_works(local_path TEXT); INSERT INTO people VALUES(1,'Primary','Primary',NULL); INSERT INTO person_aliases VALUES(1,'Alias');")
            conn.commit()
        self.index = PersonDirectoryIndex(self.db)

    def make_file(self, name="ABC-123/video[1].mp4", content=b"synthetic video" * 30000):
        file = self.source / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content)
        return file

    def plan(self):
        return build_plan([{"personId": 1, "source": str(self.source), "target": str(self.target), "kind": "normal"}], self.db, self.index)

    def execute(self, plan, name="plan.json"):
        output = write_plan(plan, self.root / name)
        return subprocess.run(["pwsh", "-NoProfile", "-File", str(Path(__file__).resolve().parents[1] / "tools" / "execute_movefile_plan.ps1"), "-Plan", str(output), "-Serial"], capture_output=True, encoding="utf-8")

    def test_plan_is_read_only_and_freezes_sample_content(self):
        file = self.make_file()
        before = self.db.read_bytes()
        plan = self.plan()
        self.assertEqual(plan["totalFiles"], 1)
        self.assertEqual(plan["tasks"][0]["units"][0]["files"][0]["fingerprint"], fingerprint(file))
        self.assertTrue(file.exists())
        self.assertEqual(self.db.read_bytes(), before)

    def test_conflicting_work_is_kept_as_a_distinct_version(self):
        self.make_file(content=b"source-version")
        existing = self.target / "ABC-123" / "video[1].mp4"
        existing.parent.mkdir(); existing.write_bytes(b"target-version")
        plan = self.plan()
        self.assertTrue(plan["tasks"][0]["units"][0]["preservedVersion"])
        result = self.execute(plan)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(existing.read_bytes(), b"target-version")
        self.assertEqual(Path(plan["tasks"][0]["units"][0]["files"][0]["target"]).read_bytes(), b"source-version")

    def test_literal_paths_sample_hash_and_idempotent_resume(self):
        original = self.make_file().read_bytes()
        plan = self.plan()
        result = self.execute(plan)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.source.exists())
        target = Path(plan["tasks"][0]["units"][0]["files"][0]["target"])
        self.assertEqual(target.read_bytes(), original)
        again = subprocess.run(["pwsh", "-NoProfile", "-File", str(Path(__file__).resolve().parents[1] / "tools" / "execute_movefile_plan.ps1"), "-Plan", str(self.root / "plan.json"), "-Serial"], capture_output=True, encoding="utf-8")
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)

    def test_modified_source_is_preserved_and_rejected(self):
        file = self.make_file()
        plan = self.plan()
        file.write_bytes(b"changed")
        result = self.execute(plan)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(file.exists())

    def test_new_conflicting_target_is_not_overwritten(self):
        self.make_file(content=b"source")
        plan = self.plan()
        target = Path(plan["tasks"][0]["units"][0]["files"][0]["target"])
        target.parent.mkdir(parents=True); target.write_bytes(b"foreign-target")
        result = self.execute(plan)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_bytes(), b"foreign-target")
        self.assertTrue(self.source.exists())

    def test_foreign_directory_plan_blocks_execution(self):
        self.make_file()
        plan = self.plan()
        (self.target / ".fanhao-move-plan.json").write_text(json.dumps({"planId": "another-operation"}), encoding="utf-8")
        result = self.execute(plan)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.source.exists())
        self.assertFalse((self.target / "ABC-123").exists())

    @unittest.skipUnless(os.name == "nt" and Path("D:/").exists(), "Windows second volume required")
    def test_cross_volume_copy_and_parallel_worker(self):
        original = self.make_file().read_bytes()
        with tempfile.TemporaryDirectory(prefix="fanhao-move-fixture-", dir="D:/") as folder:
            self.target = Path(folder) / "Primary"
            self.target.mkdir()
            plan = self.plan()
            output = write_plan(plan, self.root / "cross-volume.json")
            result = subprocess.run(["pwsh", "-NoProfile", "-File", str(Path(__file__).resolve().parents[1] / "tools" / "execute_movefile_plan.ps1"), "-Plan", str(output)], capture_output=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            target = Path(plan["tasks"][0]["units"][0]["files"][0]["target"])
            self.assertEqual(target.read_bytes(), original)
            self.assertFalse(self.source.exists())
            self.assertEqual(list(self.target.rglob("*.partial")), [])

    def test_plan_cannot_escape_person_roots(self):
        self.make_file()
        plan = self.plan()
        plan["tasks"][0]["units"][0]["files"][0]["target"] = str(self.root / "outside.mp4")
        with self.assertRaisesRegex(ValueError, "escaped"):
            validate_plan(plan, self.index)

    def test_changed_physical_root_is_rejected(self):
        self.make_file()
        plan = self.plan()
        plan["tasks"][0]["targetPhysical"] = str(self.root / "other")
        with self.assertRaisesRegex(ValueError, "Physical root"):
            validate_plan(plan, self.index)

    def test_consolidation_requires_existing_formal_destination(self):
        roots = [str(self.target.parent), str(self.source.parent)]
        tasks = collect_consolidation_tasks(self.index, roots, [str(self.source.parent)], [1], "normal")
        self.assertEqual(tasks[0]["target"], str(self.target))
        self.target.rmdir()
        self.assertEqual(collect_consolidation_tasks(self.index, roots, [str(self.source.parent)], [1], "normal"), [])


if __name__ == "__main__":
    unittest.main()
