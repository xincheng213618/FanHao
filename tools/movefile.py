import os
import stat
import subprocess
import argparse
import sqlite3
import json
import sys
from datetime import datetime
from pathlib import Path
from contextlib import closing
from dataclasses import dataclass
from collections import defaultdict
from typing import List


class PersonDirectoryIndex:
    """Read-only identity snapshot; aliases never merge separate people."""

    def __init__(self, db_path=None):
        self.names = defaultdict(set)
        self.locations = defaultdict(set)
        self.person_ids = {}
        if db_path is None:
            return
        with closing(sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)) as conn:
            conn.execute("BEGIN")
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
            redirects = dict(conn.execute("SELECT source_id, target_id FROM person_redirects")) if "person_redirects" in tables else {}

            def canonical(person_id):
                seen = set()
                while person_id in redirects:
                    if person_id in seen:
                        raise ValueError("PERSON_REDIRECT_CYCLE")
                    seen.add(person_id)
                    person_id = redirects[person_id]
                return person_id

            for person_id, name, display_name, folder in conn.execute("SELECT id, name, display_name, folder_path FROM people"):
                owner = canonical(person_id)
                self.person_ids[person_id] = owner
                for value in (name, display_name):
                    if value:
                        self.names[self.name_key(value)].add(owner)
                if folder:
                    self.locations[self.path_key(folder)].add(owner)
            if "person_aliases" in tables:
                for person_id, alias in conn.execute("SELECT person_id, alias FROM person_aliases"):
                    self.names[self.name_key(alias)].add(canonical(person_id))
            if "person_library_locations" in tables:
                for person_id, folder in conn.execute("SELECT person_id, path FROM person_library_locations"):
                    self.locations[self.path_key(folder)].add(canonical(person_id))
            conn.rollback()

    @staticmethod
    def name_key(value):
        return str(value or "").strip().casefold()

    @staticmethod
    def path_key(value):
        return os.path.normcase(os.path.abspath(value)).casefold()

    def owners(self, folder):
        return self.locations.get(self.path_key(folder)) or self.names.get(self.name_key(os.path.basename(folder)), set())


class FileMover:
    def __init__(self, root_dirs, source_only_roots=None, identity_index=None):
        self.root_dirs = root_dirs
        self.source_only_roots = {
            self.normalize_root(path)
            for path in (source_only_roots or [])
        }
        self.system_hidden_names = ['system volume information', '$recycle.bin']
        self.identity_index = identity_index or PersonDirectoryIndex()
        self._destination_names = {}

    @staticmethod
    def normalize_root(path):
        return os.path.normcase(os.path.abspath(path))

    def is_hidden(self, filepath):
        base = os.path.basename(filepath).lower()
        # 过滤以 . 开头的隐藏文件、系统目录
        if base.startswith('.'):
            return True
        if base in self.system_hidden_names:
            return True
        # 检查路径中是否包含系统隐藏目录
        path_lower = filepath.lower()
        for sys_name in self.system_hidden_names:
            if sys_name in path_lower:
                return True
        # Windows 下检查文件属性是否为隐藏
        try:
            attrs = os.stat(filepath).st_file_attributes
            if attrs & stat.FILE_ATTRIBUTE_HIDDEN:
                return True
            if attrs & stat.FILE_ATTRIBUTE_SYSTEM:
                return True
        except Exception:
            pass
        return False

    # 只从暂存区收集任务，正式库根目录只作为目标。
    def find_destination(self, src_folder, destination_roots):
        owners = self.identity_index.owners(src_folder)
        if len(owners) > 1:
            print(f"[SKIP] Ambiguous person name: {src_folder}")
            return None
        folder_name = os.path.basename(src_folder)
        for root in destination_roots:
            exact = os.path.join(root, folder_name)
            if not os.path.isdir(exact):
                continue
            if owners and self.identity_index.owners(exact) != owners:
                print(f"[SKIP] Directory belongs to a different person: {exact}")
                return None
            return exact
        if not owners:
            return None
        candidates = {}
        for root in destination_roots:
            if root not in self._destination_names:
                try:
                    self._destination_names[root] = os.listdir(root)
                except OSError as error:
                    print(f"[WARN] Cannot list destination {root}: {error}")
                    self._destination_names[root] = []
            for name in self._destination_names[root]:
                folder = os.path.join(root, name)
                if self.identity_index.owners(folder) == owners and os.path.isdir(folder) and not self.is_hidden(folder):
                    candidates.setdefault(self.normalize_root(os.path.realpath(folder)), folder)
        if len(candidates) != 1:
            if candidates:
                print(f"[SKIP] Multiple alias destinations for {src_folder}: {list(candidates.values())}")
            return None
        target = next(iter(candidates.values()))
        print(f"[MATCH] Canonical person alias: {src_folder} => {target}")
        return target

    def collect_tasks(self) -> List["MoveTask"]:
        tasks: List["MoveTask"] = []
        destination_roots = [
            root for root in self.root_dirs
            if self.normalize_root(root) not in self.source_only_roots
            and os.path.isdir(root)
        ]
        for src_root in self.root_dirs:
            if self.normalize_root(src_root) not in self.source_only_roots:
                continue
            if not os.path.isdir(src_root):
                print(f"[WARN] Source root not found: {src_root}")
                continue
            try:
                folder_names = os.listdir(src_root)
            except Exception as e:
                print(f"[ERROR] Failed to list {src_root}: {e}")
                continue
            for folder_name in folder_names:
                if folder_name.casefold() in {"vr", "noactor"}:
                    continue
                src_folder = os.path.join(src_root, folder_name)
                if not os.path.isdir(src_folder) or self.is_hidden(src_folder):
                    continue
                if os.path.isfile(os.path.join(src_folder, ".fanhao-move-plan.json")):
                    print(f"[SKIP] Existing FanHao recovery plan: {src_folder}")
                    continue
                dst_folder = self.find_destination(src_folder, destination_roots)
                if dst_folder:
                    dest_drive = os.path.splitdrive(dst_folder)[0].upper()
                    tasks.append(MoveTask(src_folder, dst_folder, dest_drive))
        # 去重
        seen = set()
        uniq = []
        for t in tasks:
            key = (t.src_folder, t.dst_folder)
            if key not in seen:
                seen.add(key)
                uniq.append(t)
        print(f"[INFO] Collected {len(uniq)} tasks from roots: {self.root_dirs}")
        return uniq

    def run_tasks(self, tasks, parallel=True):
        raise RuntimeError("Unplanned execution is disabled; use --plan and --execute for recoverable moves")


@dataclass
class MoveTask:
    src_folder: str
    dst_folder: str
    dest_drive: str

    def label(self):
        return f"{self.src_folder} => {self.dst_folder}"

    def is_vr(self):
        up = self.src_folder.upper()
        return '\\VR\\' in up or up.endswith('\\VR')

DEFAULT_ROOTS_NORMAL = ["G:\\", "F:\\", "O:\\[珍藏1]", "O:\\[珍藏]", "O:\\", "D:\\Organized"]
DEFAULT_ROOTS_VR = ["V:\\[A1]", "V:\\[A]", "V:\\AV\\VR", "V:\\AV", "D:\\Organized\\VR"]
SOURCE_ONLY_ROOTS_NORMAL = ["D:\\Organized"]
SOURCE_ONLY_ROOTS_VR = ["D:\\Organized\\VR"]
PARALLEL_BY_DRIVE = True


def main(argv=None):
    from movefile_plan import build_plan, collect_consolidation_tasks, validate_plan, write_plan
    parser = argparse.ArgumentParser(description="Move staged folders into existing libraries, resolving confirmed person identities.")
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "fanhao-core-v2.sqlite", help="FanHao core database; matching is read-only, execution updates local paths")
    parser.add_argument("--dry-run", action="store_true", help="Print the matching plan without moving files")
    parser.add_argument("--plan", type=Path, help="Save an immutable plan and stop before moving files")
    parser.add_argument("--execute", type=Path, help="Execute or resume a previously saved plan")
    parser.add_argument("--consolidate", action="store_true", help="Also merge formal alias directories for explicitly selected people")
    parser.add_argument("--person-id", type=int, action="append", default=[], help="Limit matching to this canonical person ID; repeatable")
    parser.add_argument("--serial", action="store_true", help="Process target drives serially")
    args = parser.parse_args(argv)
    if args.execute and args.plan:
        parser.error("--execute and --plan cannot be combined")
    if args.consolidate and not args.person_id:
        parser.error("--consolidate requires explicit --person-id values")
    if args.execute:
        with args.execute.open(encoding="utf-8-sig") as stream:
            plan = json.load(stream)
        validate_plan(plan, PersonDirectoryIndex(plan["dbPath"]))
        if args.dry_run:
            print(f"[DRY RUN] Approved plan: {plan['totalFiles']} files; no files moved")
            return
        execute_plan(args.execute, serial=args.serial)
        return
    if args.db.is_file():
        identity_index = PersonDirectoryIndex(args.db)
    else:
        parser.error(f"Identity database does not exist: {args.db}")
    args.person_id = list({identity_index.person_ids.get(person_id, person_id) for person_id in args.person_id})
    roots_normal = DEFAULT_ROOTS_NORMAL
    roots_vr = DEFAULT_ROOTS_VR
    print("[MODE] Project move mode: parallel by target drive")

    if args.consolidate:
        tasks = collect_consolidation_tasks(identity_index, roots_normal, SOURCE_ONLY_ROOTS_NORMAL, args.person_id, "normal")
        tasks += collect_consolidation_tasks(identity_index, roots_vr, SOURCE_ONLY_ROOTS_VR, args.person_id, "vr")
        finish_plan(tasks, args, identity_index)
        return

    # 常规任务
    mover_normal = FileMover(roots_normal, SOURCE_ONLY_ROOTS_NORMAL, identity_index)
    tasks_normal = mover_normal.collect_tasks()
    print(f"[INFO] Collected {len(tasks_normal)} normal tasks")

    # VR 任务
    mover_vr = FileMover(roots_vr, SOURCE_ONLY_ROOTS_VR, identity_index)
    tasks_vr = mover_vr.collect_tasks()
    print(f"[INFO] Collected {len(tasks_vr)} VR tasks")

    if len(tasks_vr) == 0:
        print("[WARN] No VR tasks found! Check if VR directories exist and contain valid folders")
        for dir in roots_vr:
            if os.path.exists(dir):
                print(f"  - {dir}: exists")
            else:
                print(f"  - {dir}: MISSING")

    combined = tasks_normal + tasks_vr
    tasks = []
    for task in combined:
        owners = identity_index.owners(task.src_folder)
        if len(owners) != 1:
            print(f"[SKIP] No unique database identity: {task.src_folder}")
            continue
        person_id = next(iter(owners))
        if args.person_id and person_id not in args.person_id:
            continue
        tasks.append({"personId": person_id, "source": task.src_folder, "target": task.dst_folder, "kind": "vr" if task.is_vr() else "normal"})
    finish_plan(tasks, args, identity_index)


def finish_plan(tasks, args, index):
    from movefile_plan import build_plan, write_plan
    plan = build_plan(tasks, args.db, index)
    for task in plan["tasks"]:
        preserved = sum(unit["preservedVersion"] for unit in task["units"])
        print(f"[PLAN] {task['source']} => {task['target']} ({len(task['units'])} units; {preserved} preserved versions)")
    print(f"[PLAN] {plan['totalFiles']} files, {plan['totalBytes'] / 1024**3:.2f} GiB")
    if not plan["totalFiles"]:
        print("[DRY RUN] No files to move")
        return
    if args.dry_run and not args.plan:
        print("[DRY RUN] No files moved")
        return
    output = args.plan or Path(__file__).resolve().parents[1] / "data" / "migration-logs" / ("movefile-" + datetime.now().strftime("%Y%m%d-%H%M%S")) / "plan.json"
    output = write_plan(plan, output)
    print(f"[PLAN FILE] {output}")
    if not args.plan:
        execute_plan(output, serial=args.serial)


def execute_plan(plan_path, serial=False):
    from movefile_plan import validate_plan
    plan_path = Path(plan_path).resolve()
    plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    validate_plan(plan, PersonDirectoryIndex(plan["dbPath"]))
    indexed = [task for task in plan["tasks"] if any(unit["indexed"] for unit in task["units"])]
    incoming = [task for task in plan["tasks"] if task not in indexed]
    if indexed and incoming:
        # Commit existing indexed paths before a potentially long inbox import.
        # Each phase is itself immutable and independently resumable.
        for label, tasks in (("indexed", indexed), ("incoming", incoming)):
            phase = {**plan, "id": plan["id"] + "-" + label, "tasks": tasks,
                     "totalFiles": sum(len(unit["files"]) for task in tasks for unit in task["units"]),
                     "totalBytes": sum(entry["size"] for task in tasks for unit in task["units"] for entry in unit["files"])}
            phase_path = plan_path.with_name(plan_path.stem + "." + label + ".json")
            if phase_path.exists():
                if json.loads(phase_path.read_text(encoding="utf-8-sig")) != phase:
                    raise ValueError("Existing recovery phase differs from the approved plan")
            else:
                phase_path.write_text(json.dumps(phase, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[PHASE] {label}", flush=True)
            run_plan_phase(phase_path, serial=serial)
        state = plan_path.parent / (plan["id"] + ".state")
        state.mkdir(exist_ok=True)
        (state / "completed.json").write_text(json.dumps({"state": "completed", "planId": plan["id"], "totalFiles": plan["totalFiles"], "totalBytes": plan["totalBytes"], "phases": ["indexed", "incoming"]}, indent=2), encoding="utf-8")
        return
    run_plan_phase(plan_path, serial=serial)


def run_plan_phase(plan_path, serial=False):
    from movefile_plan import validate_plan
    script = Path(__file__).with_name("execute_movefile_plan.ps1")
    command = ["pwsh", "-NoProfile", "-File", str(script), "-Plan", str(Path(plan_path).resolve())]
    if serial:
        command.append("-Serial")
    subprocess.run(command, check=True)
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8-sig"))
    validate_plan(plan, PersonDirectoryIndex(plan["dbPath"]))
    subprocess.run(["node", str(Path(__file__).with_name("relink_movefile_plan.mjs")), "--plan", str(Path(plan_path).resolve())], check=True)


if __name__ == "__main__":
    main()
