"""Shorten indexed FanHao videos that exceed the legacy Windows path limit."""

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
from uuid import uuid4

from core_image_store import DEFAULT_IMAGE_DB_NAME, attach_core_image_store
from full_scan_core_library import DEFAULT_DB, ROOTS, VIDEO_EXTS, is_excluded_dir, relative_from_root


PREFIX = "\\\\?\\"
MAX_PATH = 260  # Includes the terminating NUL, counted in UTF-16 code units.
SUBTITLE_EXTS = {".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx", ".sup", ".smi"}
MEDIA_EXTS = VIDEO_EXTS | {".3gp", ".asf", ".mpeg", ".mpg", ".rmvb", ".vob"}
PATH_COLUMNS = {
    "local_works": ("local_path", "source_info_path"),
    "local_files": ("file_path",),
    "video_probe_cache": ("file_path",),
    "fanhao_images.images": ("local_path", "storage_path"),
    "fanhao_images.local_image_cache": ("file_path",),
    "fanhao_images.actor_profile_image_staging": ("local_path",),
}


def absolute(value):
    value = os.path.normpath(value.removeprefix(PREFIX))
    if not re.match(r"^[a-z]:\\", value, re.I) or ":" in value[2:]:
        raise ValueError(f"Expected an absolute local drive path: {value}")
    return value


def key(value):
    return os.path.normcase(os.path.normpath(value or ""))


def within(value, directory):
    return key(value) == key(directory) or key(value).startswith(key(directory).rstrip("\\") + "\\")


def too_long(value):
    return len(value.encode("utf-16-le", "surrogatepass")) // 2 >= MAX_PATH


def entry(value):
    try:
        return os.lstat(PREFIX + value)
    except FileNotFoundError:
        return None


def identity(item):
    return [item.st_dev, item.st_ino]


def link_identity(value, item):
    if not item or item.st_reparse_tag not in (stat.IO_REPARSE_TAG_MOUNT_POINT, stat.IO_REPARSE_TAG_SYMLINK):
        return None
    return {"identity": identity(item), "target": key(os.path.realpath(PREFIX + value, strict=True))}


def scan_links(scopes):
    links = {}
    for scope in scopes:
        item = entry(scope)
        if item and item.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            plain_path(os.path.dirname(scope), {})
            target = link_identity(scope, item)
            if not target or not os.path.isdir(PREFIX + scope):
                raise ValueError(f"Expected an explicitly named directory link: {scope}")
            links[key(scope)] = target
    return links


def plain_path(value, links):
    for part in [Path(value), *Path(value).parents]:
        item = os.lstat(PREFIX + str(part))
        allowed = links.get(key(str(part)))
        if allowed:
            if link_identity(str(part), item) != allowed:
                raise ValueError(f"Scan root link changed: {part}")
        elif item.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f"Reparse point: {part}")


def walk(root, errors):
    def onerror(error):
        errors.append(str(error))

    for parent, dirs, files in os.walk(PREFIX + root, onerror=onerror):
        for name in dirs[:]:
            try:
                item = os.lstat(os.path.join(parent, name)) if not is_excluded_dir(name) else None
                if not item or item.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    dirs.remove(name)
            except OSError as error:
                dirs.remove(name)
                onerror(error)
        for name in files:
            yield os.path.join(parent.removeprefix(PREFIX), name)


def plan_video(video, rows, parts, links):
    if len(rows) != 1:
        raise ValueError("Expected one exact FanHao video record")
    row = rows[0]
    code = (row["code"] or "").strip().upper()
    if not re.fullmatch(r"(?=[A-Z0-9.-]*\d)[A-Z0-9]+(?:[.-][A-Z0-9]+)+", code):
        raise ValueError("Missing or unsafe FanHao work code")
    plain_path(video, links)
    item = entry(video)
    if not item or not stat.S_ISREG(item.st_mode) or item.st_size != row["size"]:
        raise ValueError("Video no longer matches the indexed size or type")

    folder, name = os.path.split(video)
    stem, ext = os.path.splitext(name)
    part = parts.get(row["id"], "")
    if part is None:
        raise ValueError("Shortening would change the work's playback order")
    short_stem = code + part
    short_name = short_stem + ext
    new_folder = folder
    folder_id = None
    if too_long(os.path.join(folder, short_name)):
        if key(folder) != key(row["local_path"]) or folder == Path(folder).anchor or key(folder) in links:
            raise ValueError("Parent is not the indexed work directory")
        # Preserve the library's folder-based A marker when a directory must move.
        short_folder = "[A]." + code if os.path.basename(folder).upper().startswith("[A]") else code
        new_folder = os.path.join(os.path.dirname(folder), short_folder)
        if key(new_folder) == key(folder) or entry(new_folder):
            raise ValueError("Short directory name is already in use")
        scan_errors = []
        others = [p for p in walk(folder, scan_errors) if key(p) != key(video) and Path(p).suffix.lower() in MEDIA_EXTS]
        if others or scan_errors:
            raise ValueError("Directory has another video or could not be fully inspected")
        folder_id = identity(entry(folder))

    files = [{"name": name, "target": short_name, "identity": identity(item)}]
    with os.scandir(PREFIX + folder) as siblings:
        for sibling in siblings:
            suffix = sibling.name[len(stem):]
            if (sibling.name.lower().startswith(stem.lower() + ".")
                    and Path(sibling.name).suffix.lower() in SUBTITLE_EXTS):
                sidecar = os.path.join(folder, sibling.name)
                plain_path(sidecar, links)
                info = entry(sidecar)
                if stat.S_ISREG(info.st_mode):
                    files.append({"name": sibling.name, "target": short_stem + suffix, "identity": identity(info)})
    for file in files:
        before = os.path.join(folder, file["name"])
        after = os.path.join(folder, file["target"])
        if too_long(os.path.join(new_folder, file["target"])):
            raise ValueError("Path remains over the limit after shortening")
        if key(before) != key(after) and entry(after):
            raise ValueError("Short filename is already in use")
    return {"code": code, "row_id": row["id"], "file_id": row["file_id"], "folder": folder,
            "new_folder": new_folder, "folder_id": folder_id, "files": files}


def numbered_parts(versions, selected):
    groups = [
        [{"id": row["id"], "name": row["name"], "selected": row["id"] in selected,
          "code": (row["code"] or "").strip().upper(), "ext": Path(row["file_path"]).suffix}
         for row in rows]
        for rows in versions.values()
        if len(rows) > 1 and any(row["id"] in selected for row in rows)
    ]
    if not groups:
        return {}
    # Match the server's natural filename ordering, which defines public video IDs.
    # Rename last-to-first and check every intermediate order so retries are safe.
    result = subprocess.run(["node", "-e", """
        const groups = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
        const compare = (a, b) => a.name.localeCompare(b.name, undefined, {numeric:true, sensitivity:'base'});
        const parts = [];
        for (const group of groups) {
          const ordered = group.toSorted(compare);
          let safe = null;
          for (const separator of ['-', ' ']) {
            const current = [...ordered];
            const candidates = [];
            let stable = true;
            for (let i = ordered.length - 1; i >= 0; i--) {
              const video = ordered[i];
              if (!video.selected) continue;
              const suffix = separator + String(i + 1).padStart(2, '0');
              current[i] = {...video, name: video.code + suffix + video.ext};
              candidates.push([video.id, suffix]);
              if (!current.toSorted(compare).every((row, index) => row.id === ordered[index].id)) {
                stable = false;
                break;
              }
            }
            if (stable) {
              safe = candidates;
              break;
            }
          }
          parts.push(...(safe || group.filter(video => video.selected).map(video => [video.id, null])));
        }
        process.stdout.write(JSON.stringify(parts));
    """], input=json.dumps(groups), text=True, capture_output=True, check=True)
    return dict(json.loads(result.stdout))


def make_plan(db, paths, links=None):
    links = links if links is not None else scan_links(paths)
    index, versions = {}, {}
    for row in db.execute("""
        SELECT f.id, f.file_id, f.file_path, f.name, f.size, f.local_work_id, w.code, l.local_path
        FROM local_files f JOIN works w ON w.id=f.work_id
        LEFT JOIN local_works l ON l.id=f.local_work_id WHERE f.file_type='video'
        ORDER BY f.local_work_id, f.sort_order, f.name
    """):
        index.setdefault(key(row["file_path"]), []).append(row)
        if row["local_work_id"] is not None:
            versions.setdefault(row["local_work_id"], []).append(row)
    units, errors, seen = [], [], set()
    long_videos = []
    videos = 0
    for scope in paths:
        plain_path(scope, links)
        candidates = walk(scope, errors) if key(scope) in links or stat.S_ISDIR(entry(scope).st_mode) else [scope]
        for video in candidates:
            if key(video) in seen or (key(video) not in index and Path(video).suffix.lower() not in MEDIA_EXTS):
                continue
            seen.add(key(video))
            videos += 1
            if too_long(video):
                long_videos.append(video)
    matches = {video: index.get(key(video), []) for video in long_videos}
    selected = {rows[0]["id"] for rows in matches.values() if len(rows) == 1}
    parts = numbered_parts(versions, selected)
    for video, rows in matches.items():
        try:
            units.append(plan_video(video, rows, parts, links))
        except (ValueError, OSError) as error:
            errors.append({"video": video, "reason": str(error)})

    targets = Counter(key(paths_for(unit, file)[1]) for unit in units for file in unit["files"])
    safe_units = []
    for unit in units:
        if any(targets[key(paths_for(unit, file)[1])] > 1 for file in unit["files"]):
            errors.append({"video": paths_for(unit, unit["files"][0])[0], "reason": "Planned target is shared"})
        else:
            safe_units.append(unit)

    safe_ids = {unit["row_id"] for unit in safe_units}
    incomplete_groups = set()
    for rows in versions.values():
        group = {row["id"] for row in rows if row["id"] in parts}
        if group - safe_ids:
            incomplete_groups.update(group)
    units = []
    for unit in safe_units:
        if unit["row_id"] in incomplete_groups:
            errors.append({"video": paths_for(unit, unit["files"][0])[0], "reason": "Another part of this work could not be planned"})
        else:
            units.append(unit)
    def execution_order(unit):
        part = parts.get(unit["row_id"])
        return (-int(part[1:]) if part else 0, key(unit["folder"]))

    return sorted(units, key=execution_order), errors, videos


def paths_for(unit, file):
    return os.path.join(unit["folder"], file["name"]), os.path.join(unit["new_folder"], file["target"])


def path_updates(db, unit):
    folder, new_folder = unit["folder"], unit["new_folder"]
    exact = {key(old): new for old, new in (paths_for(unit, file) for file in unit["files"])}

    def rewrite(value):
        if not value:
            return value
        if key(value) in exact:
            return exact[key(value)]
        if unit["folder_id"] and within(value, folder):
            return new_folder + os.path.normpath(value)[len(folder):]
        return value

    for table, columns in PATH_COLUMNS.items():
        schema, _, name = table.rpartition(".")
        if not db.execute(f"SELECT 1 FROM {schema or 'main'}.sqlite_schema WHERE type='table' AND name=?", (name,)).fetchone():
            continue
        if not unit["folder_id"] and table.startswith("fanhao_images."):
            continue  # A video or subtitle name does not change a cover path.
        predicate = []
        parameters = []
        for column in columns:
            normalized = f"lower(replace({column}, char(92), '/'))"
            source = folder.replace("\\", "/")
            predicate.append(f"({normalized}=lower(?) OR substr({normalized},1,length(?))=lower(?))")
            parameters.extend((source, source + "/", source + "/"))
        for row in db.execute(f"SELECT rowid AS rid, {', '.join(columns)} FROM {table} WHERE {' OR '.join(predicate)}", parameters).fetchall():
            changes = {column: rewrite(row[column]) for column in columns}
            changes = {column: value for column, value in changes.items() if row[column] != value}
            if not changes:
                continue
            if table in ("local_files", "fanhao_images.local_image_cache"):
                changes["relative_path"] = relative_from_root(changes["file_path"], ROOTS)
            if table == "local_files":
                changes["name"] = os.path.basename(changes["file_path"])
            changes["updated_at"] = datetime.now(timezone.utc).isoformat()
            setters = ", ".join(f"{column}=?" for column in changes)
            db.execute(f"UPDATE {table} SET {setters} WHERE rowid=?", (*changes.values(), row["rid"]))


def same_entry(value, expected):
    item = entry(value)
    return bool(item and identity(item) == expected and not item.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def rename_once(source, target, expected, performed):
    if key(source) == key(target):
        if not same_entry(source, expected):
            raise ValueError("Source identity changed")
        return
    if same_entry(target, expected) and not entry(source):
        return  # A previous attempt completed this step before the DB commit.
    if not same_entry(source, expected) or entry(target):
        raise ValueError("Source identity changed or destination is occupied")
    # Windows os.rename is a same-volume rename which fails if target exists.
    os.rename(PREFIX + source, PREFIX + target)
    performed.append((source, target, expected))


def apply_unit(db, unit, scopes, links):
    folder, new_folder = (absolute(unit[name]) for name in ("folder", "new_folder"))
    old_video, new_video = paths_for(unit, unit["files"][0])
    if (not any(within(old_video, scope) for scope in scopes) or not too_long(old_video)
            or os.path.dirname(folder) != os.path.dirname(new_folder)
            or (folder != new_folder) != bool(unit["folder_id"])
            or (unit["folder_id"] and key(folder) in links)):
        raise ValueError("Repair is outside the scanned directory or not a sibling rename")
    for file in unit["files"]:
        if any(not re.fullmatch(r'[^\\/:*?"<>|]+', file[field]) or file[field] in (".", "..") for field in ("name", "target")):
            raise ValueError("Invalid filename in repair plan")
    current_folder = new_folder if unit["folder_id"] and same_entry(new_folder, unit["folder_id"]) and not entry(folder) else folder
    plain_path(current_folder, links)
    performed = []
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT file_id,file_path FROM local_files WHERE id=? AND file_type='video'", (unit["row_id"],)).fetchone()
        if not row or row["file_id"] != unit["file_id"] or key(row["file_path"]) not in {key(old_video), key(new_video)}:
            raise ValueError("Indexed video changed since planning")
        for table, columns, condition in (
            ("work_move_path_reservations", "old_path,new_path", "released_at=''"),
            ("person_folder_operations", "source_path,target_path", "status NOT IN ('completed','failed','rolled_back')"),
        ):
            if db.execute("SELECT 1 FROM sqlite_schema WHERE name=?", (table,)).fetchone():
                for pair in db.execute(f"SELECT {columns} FROM {table} WHERE {condition}"):
                    if any(path and (within(folder, path) or within(path, folder) or within(new_folder, path) or within(path, new_folder)) for path in pair):
                        raise ValueError("An active library operation overlaps this work")
        if unit["folder_id"] and current_folder == folder:
            for table, column in (("local_works", "local_path"), ("people", "folder_path"), ("person_library_locations", "path")):
                if not db.execute("SELECT 1 FROM sqlite_schema WHERE name=?", (table,)).fetchone():
                    continue
                rows = db.execute(f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL")
                if any(within(row[0], new_folder) or (table != "local_works" and within(row[0], folder)) for row in rows):
                    raise ValueError("Directory conflicts with a registered path")
        if key(row["file_path"]) == key(old_video):
            other = db.execute("SELECT id FROM local_files WHERE lower(replace(file_path,char(92),'/'))=lower(?) AND id<>?", (new_video.replace("\\", "/"), unit["row_id"])).fetchone()
            if other:
                raise ValueError("Short video path already has a database owner")
        path_updates(db, unit)
        indexed_path = db.execute("SELECT file_path FROM local_files WHERE id=?", (unit["row_id"],)).fetchone()[0]
        if key(indexed_path) != key(new_video):
            raise ValueError("Database path could not be updated")
        for file in unit["files"]:
            rename_once(os.path.join(current_folder, file["name"]), os.path.join(current_folder, file["target"]), file["identity"], performed)
        if unit["folder_id"]:
            rename_once(folder, new_folder, unit["folder_id"], performed)
        plain_path(new_video, links)
        if not same_entry(new_video, unit["files"][0]["identity"]):
            raise ValueError("Renamed video could not be verified")
        db.commit()
    except Exception:
        if db.in_transaction:
            try:
                for source, target, expected in reversed(performed):
                    rename_once(target, source, expected, [])
            finally:
                db.rollback()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scan", action="append", help="Absolute Windows drive, directory or video to inspect (repeatable)")
    parser.add_argument("--db", type=Path, default=os.environ.get("FANHAO_CORE_DB", DEFAULT_DB))
    parser.add_argument("--apply", action="store_true", help="Rename and update SQLite (default: preview only)")
    parser.add_argument("--resume", type=Path, help="Reconcile an interrupted repair using its saved plan")
    args = parser.parse_args()
    if os.name != "nt" or bool(args.scan) == bool(args.resume) or (args.resume and not args.apply):
        parser.error("On Windows, specify --scan or --resume with --apply")
    if args.resume:
        plan = json.loads(args.resume.read_text(encoding="utf-8"))
        db_path = Path(plan["db"])
        scopes = [absolute(scope) for scope in plan["scopes"]]
        links = plan.get("links", {})
        if scan_links(scopes) != links:
            raise ValueError("Saved scan root links have changed")
        units = plan["units"]
        errors, videos = [], None
    else:
        db_path = args.db.resolve(strict=True)
        scopes = [absolute(scope) for scope in args.scan]
        links = scan_links(scopes)
        with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            units, errors, videos = make_plan(db, scopes, links)
    print(json.dumps({"videos_scanned": videos, "planned": len(units), "skipped": len(errors),
                      "folder_renames": [u["code"] for u in units if u["folder_id"]]}), flush=True)
    for error in errors:
        print(json.dumps(error, ensure_ascii=False), file=sys.stderr)
    if not args.apply or not units:
        return int(bool(errors))

    image_db = Path(plan["image_db"] if args.resume else
                    os.environ.get("FANHAO_CORE_IMAGE_DB") or db_path.with_name(DEFAULT_IMAGE_DB_NAME)).resolve(strict=True)
    if not args.resume:
        journal_dir = db_path.parent / "migration-logs"
        journal_dir.mkdir(exist_ok=True)
        journal = journal_dir / f"long-path-{uuid4().hex}.json"
        with journal.open("x", encoding="utf-8") as out:
            json.dump({"db": str(db_path), "image_db": str(image_db), "scopes": scopes, "links": links, "units": units},
                      out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        print(f"Plan: {journal}", flush=True)
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=rw", uri=True, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        attach_core_image_store(db, db_path, image_db)
        for unit in units:
            apply_unit(db, unit, scopes, links)
            _, target = paths_for(unit, unit["files"][0])
            print(f"{unit['code']}: {len(target.encode('utf-16-le')) // 2} UTF-16 units", flush=True)
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
