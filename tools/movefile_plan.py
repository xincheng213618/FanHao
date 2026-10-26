"""Immutable, non-overwriting file plans for the Windows mover."""
import hashlib
import json
import os
import sqlite3
import stat
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def fingerprint(filename):
    size = os.path.getsize(filename)
    digest = hashlib.sha256()
    # Full content for small files; three 64 KiB windows for large videos.
    offsets = [0] if size <= 196608 else sorted({0, size // 2, size - 65536})
    with open(filename, "rb") as stream:
        for offset in offsets:
            stream.seek(offset)
            digest.update(stream.read(size if size <= 196608 else 65536))
    return digest.hexdigest()


def within(candidate, root):
    try:
        return os.path.commonpath([os.path.abspath(candidate), os.path.abspath(root)]).casefold() == os.path.abspath(root).casefold()
    except ValueError:
        return False


def checked_files(root):
    root = Path(root)
    if root.is_symlink() or getattr(root.stat(), "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024):
        raise ValueError(f"Reparse point is not a regular source: {root}")
    if root.is_file():
        return [root]
    result = []
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            item = Path(directory) / name
            attrs = getattr(item.lstat(), "st_file_attributes", 0)
            if item.is_symlink() or attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024):
                raise ValueError(f"Nested reparse point: {item}")
        result.extend(Path(directory) / name for name in names)
    return sorted(result)


def collect_consolidation_tasks(index, roots, source_only_roots, person_ids, task_type):
    source_keys = {index.path_key(p) for p in source_only_roots}
    groups = {int(pid): [] for pid in person_ids}
    physical = set()
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            folder = os.path.join(root, name)
            if name.startswith(".") or not os.path.isdir(folder):
                continue
            owners = index.owners(folder)
            if len(owners) != 1 or next(iter(owners)) not in groups:
                continue
            real_key = index.path_key(os.path.realpath(folder))
            if real_key in physical:
                continue
            physical.add(real_key)
            groups[next(iter(owners))].append((folder, index.path_key(root) in source_keys))
    tasks = []
    for person_id, candidates in groups.items():
        destinations = [folder for folder, staged in candidates if not staged]
        if not destinations:
            continue  # Never create a new formal person directory.
        target = destinations[0]  # Preserve configured target-root priority.
        for folder, _ in candidates:
            if index.path_key(folder) != index.path_key(target):
                tasks.append({"personId": person_id, "source": folder, "target": target, "kind": task_type})
    return tasks


def build_plan(tasks, db_path, index):
    plan = {"version": 1, "id": uuid.uuid4().hex, "createdAt": datetime.now(timezone.utc).isoformat(),
            "dbPath": str(Path(db_path).resolve()), "tasks": [], "totalFiles": 0, "totalBytes": 0}
    with closing(sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)) as conn:
        local_paths = [row[0] for row in conn.execute("SELECT local_path FROM local_works WHERE local_path IS NOT NULL")]
    destinations = set()
    for raw in tasks:
        source, target = map(lambda p: str(Path(p).absolute()), (raw["source"], raw["target"]))
        if not os.path.isdir(source) or not os.path.isdir(target):
            raise ValueError("Both person directories must already exist")
        if any((Path(folder) / ".fanhao-move-plan.json").exists() for folder in (source, target)):
            raise ValueError("An active recovery plan owns a source or target directory")
        source_real, target_real = os.path.realpath(source), os.path.realpath(target)
        if within(source_real, target_real) or within(target_real, source_real):
            raise ValueError("Source and target directories overlap")
        source_owners, target_owners = index.owners(source), index.owners(target)
        if source_owners != {int(raw["personId"])} or target_owners != source_owners:
            raise ValueError("Person identity is ambiguous or changed")
        task = {**raw, "source": source, "target": target, "sourcePhysical": source_real, "targetPhysical": target_real, "units": []}
        for unit_source in sorted(Path(source).iterdir()):
            if unit_source.name == ".fanhao-move-plan.json":
                raise ValueError(f"An existing recovery plan owns {source}")
            files = checked_files(unit_source)
            if not files:
                continue
            unit_target = Path(target) / unit_source.name
            collision = unit_target.exists() or index.path_key(unit_target) in destinations
            if collision:
                token = hashlib.sha256(str(unit_source).encode("utf-8")).hexdigest()[:10]
                if unit_source.is_dir():
                    unit_target = Path(target) / (unit_source.name[:210] + f" [合并保留-{token}]")
                else:
                    unit_target = Path(target) / (unit_source.stem[:200] + f".merged-{token}" + unit_source.suffix)
                if unit_target.exists():
                    raise ValueError(f"Preserved-version target already exists; resume its original plan: {unit_target}")
            destination_key = index.path_key(unit_target)
            if destination_key in destinations:
                raise ValueError(f"Two units selected the same target: {unit_target}")
            destinations.add(destination_key)
            unit = {"source": str(unit_source), "target": str(unit_target), "directory": unit_source.is_dir(),
                    "preservedVersion": collision, "indexed": any(within(p, str(unit_source)) for p in local_paths), "files": []}
            if not unit["directory"] and not unit["indexed"] and unit_source.suffix.lower() in {".mp4", ".mkv", ".avi", ".wmv", ".mov", ".webm", ".m4v", ".ts", ".iso"}:
                raise ValueError("Organize loose staged videos into work directories before moving")
            for filename in files:
                relative = filename.relative_to(unit_source) if unit_source.is_dir() else Path("")
                destination = unit_target / relative if unit_source.is_dir() else unit_target
                info = filename.stat()
                unit["files"].append({"source": str(filename), "target": str(destination), "size": info.st_size,
                                      "mtimeNs": str(info.st_mtime_ns), "fingerprint": fingerprint(filename)})
                plan["totalFiles"] += 1
                plan["totalBytes"] += info.st_size
            task["units"].append(unit)
        plan["tasks"].append(task)
    return plan


def write_plan(plan, output):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(plan, stream, ensure_ascii=False, indent=2)
    return output


def validate_plan(plan, index):
    if plan.get("version") != 1:
        raise ValueError("Unsupported move plan")
    for task in plan["tasks"]:
        for field in ("source", "target"):
            if index.path_key(os.path.realpath(task[field])) != index.path_key(task[field + "Physical"]):
                raise ValueError(f"Physical root changed: {task[field]}")
            if index.owners(task[field]) != {int(task["personId"])}:
                raise ValueError(f"Person ownership changed: {task[field]}")
        for unit in task["units"]:
            if not within(unit["source"], task["source"]) or not within(unit["target"], task["target"]):
                raise ValueError("Unit escaped its approved person roots")
            for entry in unit["files"]:
                if not within(entry["source"], unit["source"]) or not within(entry["target"], unit["target"]):
                    raise ValueError("File escaped its approved unit roots")
