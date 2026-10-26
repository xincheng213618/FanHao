"""Index only newly imported plan units, retaining all existing local IDs."""
import argparse
from collections import defaultdict
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from core_image_store import attach_core_image_store
from full_scan_core_library import (
    ROOTS, build_indexes, choose_existing_work, clean_path, create_or_update_local_work,
    create_work, ensure_work_person, load_people, replace_local_files, scan_work, upsert_person,
)
from person_identity import canonical_person_id


def import_incoming(plan):
    stats = defaultdict(int)
    imported = []
    with closing(sqlite3.connect(plan["dbPath"], timeout=30)) as conn:
        conn.row_factory = sqlite3.Row
        attach_core_image_store(conn, plan["dbPath"])
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("BEGIN IMMEDIATE")
        try:
            people = load_people(conn)
            indexes = build_indexes(conn)
            # Existing live directories are never candidates for a new import.
            # Only an unambiguous catalog-only work may be reused by number.
            indexes["by_person_code"] = {}
            indexes["by_person_title"] = {}
            for task in plan["tasks"]:
                units = [unit for unit in task["units"] if not unit["indexed"] and unit["directory"]]
                if not units:
                    continue
                person_dir = Path(task["target"])
                person_id = upsert_person(conn, people, person_dir.name, clean_path(person_dir), True, stats)
                if canonical_person_id(conn, person_id) != int(task["personId"]):
                    raise ValueError("Imported directory resolved to a different person")
                for unit in units:
                    directory = clean_path(unit["target"])
                    existing = conn.execute("SELECT id,work_id FROM local_works WHERE lower(replace(local_path,char(92),'/'))=?", (directory.replace("\\", "/").lower(),)).fetchall()
                    if existing:
                        if len(existing) != 1 or not conn.execute("SELECT 1 FROM work_people WHERE work_id=? AND person_id=? AND role='actor'", (existing[0]["work_id"], person_id)).fetchone():
                            raise ValueError("Imported unit has an ambiguous prior binding")
                        known = {str(row[0]).replace("\\", "/").lower() for row in conn.execute("SELECT file_path FROM local_files WHERE local_work_id=?", (existing[0]["id"],))}
                        work = scan_work(person_dir, Path(directory), Path(directory).name, [Path(entry["target"]) for entry in unit["files"]], ROOTS)
                        if work and not all(file.file_path.replace("\\", "/").lower() in known for file in work.files):
                            raise ValueError("An existing import receipt is incomplete; preserve its IDs for review")
                        imported.append({"directory": directory, "workId": existing[0]["work_id"], "localWorkId": existing[0]["id"], "alreadyImported": True})
                        continue
                    work = scan_work(person_dir, Path(directory), Path(directory).name, [Path(entry["target"]) for entry in unit["files"]], ROOTS)
                    if not work:
                        continue
                    for file in work.files:
                        if conn.execute("SELECT 1 FROM local_files WHERE file_id=?", (file.file_id,)).fetchone():
                            raise ValueError("A planned new file is already bound outside this unit")
                    work_id, local_id, old_path = choose_existing_work(indexes, person_id, work, distinct_work=True)
                    if local_id is not None:
                        raise ValueError("A new import cannot replace an existing local-work row")
                    if not work_id:
                        work_id = create_work(conn, work, True, stats)
                    indexes["claimed_work_ids"].add(int(work_id))
                    local_id = create_or_update_local_work(conn, work_id, None, "", work, ROOTS, True, stats)
                    replace_local_files(conn, work_id, local_id, work, True, stats)
                    ensure_work_person(conn, work_id, person_id, True, stats)
                    imported.append({"directory": directory, "workId": work_id, "localWorkId": local_id, "files": len(work.files)})
            if conn.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Import foreign-key verification failed")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {"stats": dict(stats), "units": imported}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding="utf-8-sig"))
    receipt = args.plan.parent / (plan["id"] + ".state") / "status.json"
    if json.loads(receipt.read_text(encoding="utf-8-sig")).get("state") != "completed":
        raise SystemExit("The file phase has not completed; no index updates were applied")
    print(json.dumps(import_incoming(plan), ensure_ascii=False))
