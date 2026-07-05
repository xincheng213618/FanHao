from __future__ import annotations

import argparse
import base64
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from code_parser import code_key, normalize_code


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "data" / "fanhao-core-v2.sqlite"

ROOTS = [
    Path("G:/"),
    Path("F:/"),
    Path("O:/"),
    Path("O:/[珍藏]"),
    Path("O:/[珍藏1]"),
    Path("O:/[稀有]"),
    Path("O:/[动漫]"),
    Path("V:/[A]"),
    Path("V:/[A1]"),
    Path("V:/AV"),
]

EXCLUDED_DIRS = {"$RECYCLE.BIN", "System Volume Information", "Recovery"}
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".m2ts", ".webm", ".iso"}
PLAYABLE_VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
INFO_EXTS = {".nfo", ".txt", ".json", ".xml", ".html", ".htm", ".csv", ".md", ".srt", ".ass", ".ssa"}


@dataclass
class MediaFile:
    file_id: str
    file_type: str
    file_path: str
    name: str
    title: str
    ext: str
    relative_path: str
    size: int
    modified_at: str
    playable: int
    sort_order: int


@dataclass
class ScannedWork:
    person_dir: Path
    person_name: str
    work_dir: Path
    title: str
    code: str
    code_search: str
    videos: list[MediaFile]
    images: list[MediaFile]
    infos: list[MediaFile]

    @property
    def files(self) -> list[MediaFile]:
        return [*self.videos, *self.images, *self.infos]


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def normalize_person_search(value: str) -> str:
    return " ".join(str(value or "").strip().lower().split()).replace(" ", "")


def clean_path(value: str | Path) -> str:
    return os.path.abspath(os.path.normpath(str(value)))


def path_key(value: str | Path) -> str:
    return clean_path(value).replace("\\", "/").rstrip("/").lower()


def is_child_or_same(path: Path, root: Path) -> bool:
    target = os.path.normcase(clean_path(path))
    base = os.path.normcase(clean_path(root))
    try:
        relative = os.path.relpath(target, base)
    except ValueError:
        return False
    return relative == "." or not relative.startswith("..")


def root_label(root: Path) -> str:
    return clean_path(root).rstrip("\\/").replace("\\", "/")


def relative_from_root(full_path: str | Path, roots: list[Path]) -> str:
    path = clean_path(full_path)
    for root in sorted(roots, key=lambda item: len(clean_path(item)), reverse=True):
        base = clean_path(root)
        try:
            relative = os.path.relpath(path, base)
        except ValueError:
            continue
        if relative == "." or not relative.startswith(".."):
            label = root_label(root)
            rel = "" if relative == "." else relative.replace("\\", "/")
            return f"{label}/{rel}" if rel else label
    return path.replace("\\", "/")


def create_id(prefix: str, value: str) -> str:
    encoded = base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")
    return f"{prefix}_{encoded}"


def file_base(name: str) -> str:
    return Path(name).stem


def stat_mtime_iso(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).astimezone().isoformat()
    except OSError:
        return ""


def media_file(path: Path, file_type: str, roots: list[Path], sort_order: int) -> MediaFile:
    name = path.name
    ext = path.suffix.lower()
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    full_path = clean_path(path)
    return MediaFile(
        file_id=create_id(file_type[0] or "f", full_path),
        file_type=file_type,
        file_path=full_path,
        name=name,
        title=file_base(name),
        ext=ext,
        relative_path=relative_from_root(path, roots),
        size=size,
        modified_at=stat_mtime_iso(path),
        playable=1 if file_type == "video" and ext in PLAYABLE_VIDEO_EXTS else 0,
        sort_order=sort_order,
    )


def is_excluded_dir(name: str) -> bool:
    lower = name.lower()
    return name in EXCLUDED_DIRS or name.startswith("$") or name.startswith(".") or lower.startswith("found.")


def walk_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for current, dirs, names in os.walk(root):
        dirs[:] = [name for name in dirs if not is_excluded_dir(name)]
        for name in names:
            files.append(Path(current) / name)
    return files


def direct_files(root: Path) -> list[Path]:
    try:
        return [item for item in root.iterdir() if item.is_file()]
    except OSError:
        return []


def direct_child_dirs(root: Path, nested_roots: set[str]) -> list[Path]:
    try:
        dirs = []
        for item in root.iterdir():
            if not item.is_dir() or is_excluded_dir(item.name):
                continue
            if path_key(item) in nested_roots:
                continue
            dirs.append(item)
        return sorted(dirs, key=lambda item: item.name.casefold())
    except OSError:
        return []


def collect_media(files: list[Path], roots: list[Path]) -> tuple[list[MediaFile], list[MediaFile], list[MediaFile]]:
    videos: list[MediaFile] = []
    images: list[MediaFile] = []
    infos: list[MediaFile] = []
    for file in files:
        ext = file.suffix.lower()
        if ext in VIDEO_EXTS:
            videos.append(media_file(file, "video", roots, len(videos)))
        elif ext in IMAGE_EXTS:
            images.append(media_file(file, "image", roots, len(images)))
        elif ext in INFO_EXTS:
            infos.append(media_file(file, "info", roots, len(infos)))
    videos.sort(key=lambda item: item.name.casefold())
    images.sort(key=lambda item: item.name.casefold())
    infos.sort(key=lambda item: item.name.casefold())
    for index, item in enumerate(videos):
        item.sort_order = index
    for index, item in enumerate(images):
        item.sort_order = index
    for index, item in enumerate(infos):
        item.sort_order = index
    return videos, images, infos


def scan_work(person_dir: Path, work_dir: Path, title: str, files: list[Path], roots: list[Path]) -> ScannedWork | None:
    videos, images, infos = collect_media(files, roots)
    if not videos:
        return None
    detected = normalize_code(f"{title} {work_dir}")
    return ScannedWork(
        person_dir=person_dir,
        person_name=person_dir.name,
        work_dir=work_dir,
        title=title,
        code=detected,
        code_search=code_key(detected),
        videos=videos,
        images=images,
        infos=infos,
    )


def scan_person(person_dir: Path, roots: list[Path]) -> list[ScannedWork]:
    works: list[ScannedWork] = []
    for child in direct_child_dirs(person_dir, set()):
        work = scan_work(person_dir, child, child.name, walk_files(child), roots)
        if work:
            works.append(work)

    root_files = direct_files(person_dir)
    videos, _, _ = collect_media(root_files, roots)
    for video in videos:
        video_base = file_base(video.name)
        matching = []
        for file in root_files:
            ext = file.suffix.lower()
            if clean_path(file) == video.file_path or (file_base(file.name) == video_base and (ext in IMAGE_EXTS or ext in INFO_EXTS)):
                matching.append(file)
        work = scan_work(person_dir, person_dir, video.name, matching, roots)
        if work:
            works.append(work)
    return works


def path_exists(value: str) -> bool:
    try:
        return bool(value) and Path(value).exists()
    except OSError:
        return False


def load_people(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    rows = conn.execute("SELECT id, name, display_name, folder_path FROM people").fetchall()
    people: dict[str, sqlite3.Row] = {}
    for row in rows:
        for name in {row["name"] or "", row["display_name"] or ""}:
            key = normalize_person_search(name)
            if key and key not in people:
                people[key] = row
    return people


def upsert_person(conn: sqlite3.Connection, people: dict[str, sqlite3.Row], name: str, folder_path: str, write: bool, stats: dict) -> int:
    key = normalize_person_search(name)
    existing = people.get(key)
    if existing:
        if write and folder_path and (not existing["folder_path"] or not path_exists(existing["folder_path"])):
            conn.execute("UPDATE people SET folder_path = ?, updated_at = ? WHERE id = ?", (folder_path, now_iso(), existing["id"]))
        return int(existing["id"])
    stats["people_created"] += 1
    if not write:
        return -stats["people_created"]
    now = now_iso()
    cur = conn.execute(
        """
        INSERT INTO people (name, name_search, display_name, folder_path, movie_count, status, error, source, created_at, updated_at, gender)
        VALUES (?, ?, ?, ?, 0, 'ok', NULL, 'local_full_scan', ?, ?, 'unknown')
        """,
        (name, key, name, folder_path, now, now),
    )
    person_id = int(cur.lastrowid)
    people[key] = conn.execute("SELECT id, name, display_name, folder_path FROM people WHERE id = ?", (person_id,)).fetchone()
    return person_id


def load_local_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT lw.id, lw.work_id, lw.local_path, lw.detected_code_search, w.code_search, w.code, w.title
        FROM local_works lw
        JOIN works w ON w.id = lw.work_id
        WHERE lw.local_path IS NOT NULL AND lw.local_path <> ''
        """
    ).fetchall()


def build_indexes(conn: sqlite3.Connection) -> dict:
    local_rows = load_local_rows(conn)
    by_path = {path_key(row["local_path"]): row for row in local_rows}
    by_person_code: dict[tuple[int, str], list[sqlite3.Row]] = {}
    by_person_title: dict[tuple[int, str], list[sqlite3.Row]] = {}
    for row in conn.execute(
        """
        SELECT lw.id, lw.work_id, lw.local_path, lw.detected_code_search, w.code_search, w.code, w.title, wp.person_id
        FROM local_works lw
        JOIN works w ON w.id = lw.work_id
        JOIN work_people wp ON wp.work_id = lw.work_id AND wp.role = 'actor'
        WHERE lw.local_path IS NOT NULL AND lw.local_path <> ''
        """
    ):
        keys = {row["detected_code_search"] or "", row["code_search"] or "", code_key(row["code"] or ""), code_key(row["title"] or "")}
        for key in keys:
            if key:
                by_person_code.setdefault((int(row["person_id"]), key), []).append(row)
        title_key = Path(str(row["local_path"] or "")).name.casefold()
        if title_key:
            by_person_title.setdefault((int(row["person_id"]), title_key), []).append(row)

    work_by_person_code: dict[tuple[int, str], list[sqlite3.Row]] = {}
    for row in conn.execute(
        """
        SELECT w.id AS work_id, w.code_search, w.code, w.title, wp.person_id,
               (SELECT COUNT(*) FROM local_works lw WHERE lw.work_id = w.id) AS local_count
        FROM works w
        JOIN work_people wp ON wp.work_id = w.id AND wp.role = 'actor'
        """
    ):
        keys = {row["code_search"] or "", code_key(row["code"] or ""), code_key(row["title"] or "")}
        for key in keys:
            if key:
                work_by_person_code.setdefault((int(row["person_id"]), key), []).append(row)

    return {
        "local_rows": local_rows,
        "by_path": by_path,
        "by_person_code": by_person_code,
        "by_person_title": by_person_title,
        "work_by_person_code": work_by_person_code,
    }


def choose_local_candidate(candidates: list[sqlite3.Row], work: ScannedWork) -> sqlite3.Row | None:
    if not candidates:
        return None
    title = work.work_dir.name.casefold()

    def score(row: sqlite3.Row) -> tuple[int, float, int]:
        local_path = str(row["local_path"] or "")
        missing = 1 if not path_exists(local_path) else 0
        old_root = 1 if local_path.replace("\\", "/").lower().startswith(("f:/", "g:/", "d:/organized/")) else 0
        ratio = SequenceMatcher(None, Path(local_path).name.casefold(), title).ratio()
        return (missing + old_root, ratio, -int(row["id"]))

    best = sorted(candidates, key=score, reverse=True)[0]
    best_score = score(best)
    if best_score[0] > 0 or best_score[1] >= 0.72:
        return best
    return None


def create_work(conn: sqlite3.Connection, work: ScannedWork, write: bool, stats: dict) -> int:
    stats["works_created"] += 1
    if not write:
        return -stats["works_created"]
    now = now_iso()
    cur = conn.execute(
        """
        INSERT INTO works (code, code_search, title, fields_json, status, error, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ok', NULL, 'local_full_scan', ?, ?)
        """,
        (work.code or "", work.code_search or "", work.title, f'[{{"label":"演员","value":"{work.person_name}"}}]', now, now),
    )
    return int(cur.lastrowid)


def create_or_update_local_work(
    conn: sqlite3.Connection,
    work_id: int,
    local_work_id: int | None,
    old_path: str,
    work: ScannedWork,
    roots: list[Path],
    write: bool,
    stats: dict,
) -> int | None:
    local_path = clean_path(work.work_dir)
    source_info = work.infos[0] if work.infos else None
    source_video = work.videos[0] if work.videos else None
    source_size = source_video.size if source_video else 0
    source_mtime = source_video.modified_at if source_video else ""
    source_info_path = source_info.file_path if source_info else ""
    source_info_id = source_info.file_id if source_info else ""
    now = now_iso()
    if local_work_id:
        if path_key(old_path) != path_key(local_path):
            stats["local_paths_updated"] += 1
        else:
            stats["local_paths_refreshed"] += 1
        if not write:
            return local_work_id
        conn.execute(
            """
            UPDATE local_works
            SET local_path = ?, source_info_path = ?, source_info_id = ?, source_name = 'local_full_scan',
                source_size = ?, source_mtime = ?, detected_code = ?, detected_code_search = ?,
                matched_by = 'local_full_scan', confidence = 1, updated_at = ?
            WHERE id = ?
            """,
            (local_path, source_info_path, source_info_id, source_size, source_mtime, work.code or "", work.code_search or "", now, local_work_id),
        )
        if old_path and path_key(old_path) != path_key(local_path):
            conn.execute(
                "UPDATE images SET local_path = ?, updated_at = ? WHERE owner_type = 'work' AND owner_id = ? AND local_path = ?",
                (local_path, now, work_id, old_path),
            )
        return local_work_id

    stats["local_works_created"] += 1
    if not write:
        return None
    cur = conn.execute(
        """
        INSERT INTO local_works (
            work_id, local_path, source_info_path, source_info_id, source_name,
            source_size, source_mtime, detected_code, detected_code_search,
            matched_by, confidence, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'local_full_scan', ?, ?, ?, ?, 'local_full_scan', 1, ?, ?)
        """,
        (work_id, local_path, source_info_path, source_info_id, source_size, source_mtime, work.code or "", work.code_search or "", now, now),
    )
    return int(cur.lastrowid)


def replace_local_files(conn: sqlite3.Connection, work_id: int, local_work_id: int, work: ScannedWork, write: bool, stats: dict) -> None:
    stats["files_seen"] += len(work.files)
    if not write:
        return
    now = now_iso()
    conn.execute("DELETE FROM local_files WHERE local_work_id = ?", (local_work_id,))
    for file in work.files:
        conn.execute(
            """
            INSERT INTO local_files (
                work_id, local_work_id, file_id, file_type, file_path, name, title, ext,
                relative_path, size, modified_at, playable, sort_order, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_id) DO UPDATE SET
                work_id = excluded.work_id,
                local_work_id = excluded.local_work_id,
                file_type = excluded.file_type,
                file_path = excluded.file_path,
                name = excluded.name,
                title = excluded.title,
                ext = excluded.ext,
                relative_path = excluded.relative_path,
                size = excluded.size,
                modified_at = excluded.modified_at,
                playable = excluded.playable,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at
            """,
            (
                work_id,
                local_work_id,
                file.file_id,
                file.file_type,
                file.file_path,
                file.name,
                file.title,
                file.ext,
                file.relative_path,
                file.size,
                file.modified_at or None,
                file.playable,
                file.sort_order,
                now,
                now,
            ),
        )


def ensure_work_person(conn: sqlite3.Connection, work_id: int, person_id: int, write: bool, stats: dict) -> None:
    exists = conn.execute(
        "SELECT 1 FROM work_people WHERE work_id = ? AND person_id = ? AND role = 'actor'",
        (work_id, person_id),
    ).fetchone()
    if exists:
        return
    stats["work_people_created"] += 1
    if not write:
        return
    now = now_iso()
    conn.execute(
        """
        INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
        VALUES (?, ?, 'actor', 0, 'local_full_scan', ?, ?)
        ON CONFLICT(work_id, person_id, role) DO NOTHING
        """,
        (work_id, person_id, now, now),
    )


def choose_existing_work(indexes: dict, person_id: int, work: ScannedWork) -> tuple[int | None, int | None, str]:
    same_path = indexes["by_path"].get(path_key(work.work_dir))
    if same_path:
        return int(same_path["work_id"]), int(same_path["id"]), str(same_path["local_path"] or "")

    candidate = None
    if work.code_search:
        candidate = choose_local_candidate(indexes["by_person_code"].get((person_id, work.code_search), []), work)
    if not candidate:
        candidate = choose_local_candidate(indexes["by_person_title"].get((person_id, work.work_dir.name.casefold()), []), work)
    if candidate:
        return int(candidate["work_id"]), int(candidate["id"]), str(candidate["local_path"] or "")

    if work.code_search:
        rows = indexes["work_by_person_code"].get((person_id, work.code_search), [])
        no_local = [row for row in rows if int(row["local_count"] or 0) == 0]
        if len(no_local) == 1:
            return int(no_local[0]["work_id"]), None, ""

    return None, None, ""


def stale_local_work_ids(conn: sqlite3.Connection, scanned_paths: set[str], roots: list[Path]) -> list[int]:
    root_keys = tuple(path_key(root) for root in roots)
    stale = []
    for row in conn.execute("SELECT id, local_path FROM local_works WHERE local_path IS NOT NULL AND local_path <> ''"):
        local_path = str(row["local_path"] or "")
        key = path_key(local_path)
        if key in scanned_paths:
            continue
        if not key.startswith(root_keys):
            continue
        if not path_exists(local_path):
            stale.append(int(row["id"]))
    return stale


def delete_stale_local_works(conn: sqlite3.Connection, ids: list[int], write: bool, stats: dict) -> None:
    stats["stale_local_works_deleted"] = len(ids)
    if not write:
        return
    for local_work_id in ids:
        conn.execute("DELETE FROM local_files WHERE local_work_id = ?", (local_work_id,))
        conn.execute("DELETE FROM local_works WHERE id = ?", (local_work_id,))


def scan_all(conn: sqlite3.Connection, roots: list[Path], write: bool, delete_stale: bool, limit_people: int = 0) -> dict:
    available_roots = [root for root in roots if root.exists()]
    nested_roots = {path_key(root) for root in available_roots}
    people = load_people(conn)
    indexes = build_indexes(conn)
    scanned_paths: set[str] = set()
    stats = {
        "roots": len(available_roots),
        "candidate_person_dirs": 0,
        "person_dirs_seen": 0,
        "works_seen": 0,
        "files_seen": 0,
        "people_created": 0,
        "works_created": 0,
        "local_works_created": 0,
        "local_paths_updated": 0,
        "local_paths_refreshed": 0,
        "work_people_created": 0,
        "stale_local_works_deleted": 0,
    }

    conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
    try:
        processed_people = 0
        for root in available_roots:
            root_nested = nested_roots - {path_key(root)}
            for person_dir in direct_child_dirs(root, root_nested):
                processed_people += 1
                if limit_people and processed_people > limit_people:
                    break
                stats["person_dirs_seen"] += 1
                person_source = clean_path(person_dir)
                person_id = upsert_person(conn, people, person_dir.name, person_source, write, stats)
                works = scan_person(person_dir, available_roots)
                for work in works:
                    stats["works_seen"] += 1
                    scanned_paths.add(path_key(work.work_dir))
                    work_id, local_work_id, old_path = choose_existing_work(indexes, person_id, work)
                    if not work_id:
                        work_id = create_work(conn, work, write, stats)
                    if write and work_id < 0:
                        raise RuntimeError("unexpected dry-run work id while writing")
                    next_local_work_id = create_or_update_local_work(conn, work_id, local_work_id, old_path, work, available_roots, write, stats)
                    if write and next_local_work_id:
                        replace_local_files(conn, work_id, next_local_work_id, work, write, stats)
                    else:
                        replace_local_files(conn, work_id, next_local_work_id or -1, work, write, stats)
                    ensure_work_person(conn, work_id, person_id, write, stats)
                if stats["person_dirs_seen"] % 50 == 0:
                    print(
                        f"[scan] people={stats['person_dirs_seen']} works={stats['works_seen']} "
                        f"newPeople={stats['people_created']} pathUpdates={stats['local_paths_updated']}",
                        flush=True,
                    )
            if limit_people and processed_people > limit_people:
                break

        if delete_stale:
            stale_ids = stale_local_work_ids(conn, scanned_paths, available_roots)
            delete_stale_local_works(conn, stale_ids, write, stats)

        if write:
            conn.commit()
        else:
            conn.rollback()
    except Exception:
        conn.rollback()
        raise
    return stats


def person_name_from_local_path(local_path: str, roots: list[Path]) -> str:
    path = clean_path(local_path)
    for root in sorted(roots, key=lambda item: len(clean_path(item)), reverse=True):
        base = clean_path(root)
        try:
            relative_text = os.path.relpath(path, base)
        except ValueError:
            continue
        if relative_text.startswith(".."):
            continue
        parts = Path(relative_text).parts
        return parts[0] if parts else ""
    return Path(path).parent.name or Path(path).name


def person_dirs_by_name(roots: list[Path]) -> dict[str, list[Path]]:
    available_roots = [root for root in roots if root.exists()]
    nested_roots = {path_key(root) for root in available_roots}
    result: dict[str, list[Path]] = {}
    for root in available_roots:
        root_nested = nested_roots - {path_key(root)}
        for person_dir in direct_child_dirs(root, root_nested):
            result.setdefault(normalize_person_search(person_dir.name), []).append(person_dir)
    return result


def has_root_video(person_dir: Path) -> bool:
    return any(file.suffix.lower() in VIDEO_EXTS for file in direct_files(person_dir))


def parse_local_date(value: str) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        try:
            return datetime.strptime(text, "%Y-%m-%d").timestamp()
        except ValueError:
            return None


def dir_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0


def candidate_person_dirs(
    conn: sqlite3.Connection,
    roots: list[Path],
    recent_hours: float,
    modified_since: float | None = None,
) -> list[Path]:
    available_roots = [root for root in roots if root.exists()]
    nested_roots = {path_key(root) for root in available_roots}
    people = load_people(conn)
    indexes = build_indexes(conn)
    known_paths = set(indexes["by_path"].keys())
    candidates: dict[str, Path] = {}
    recent_cutoff = None
    if recent_hours and recent_hours > 0:
        recent_cutoff = datetime.now().timestamp() - recent_hours * 3600

    def add(path: Path) -> None:
        if modified_since is not None and dir_mtime(path) < modified_since:
            return
        candidates[path_key(path)] = path

    dirs_by_name: dict[str, list[Path]] = {}
    for root in available_roots:
        root_nested = nested_roots - {path_key(root)}
        for person_dir in direct_child_dirs(root, root_nested):
            dirs_by_name.setdefault(normalize_person_search(person_dir.name), []).append(person_dir)
            person_key = normalize_person_search(person_dir.name)
            if person_key not in people:
                add(person_dir)
                continue
            if recent_cutoff and dir_mtime(person_dir) >= recent_cutoff:
                add(person_dir)
                continue
            child_dirs = direct_child_dirs(person_dir, set())
            if any(path_key(child) not in known_paths for child in child_dirs):
                add(person_dir)
                continue
            if has_root_video(person_dir) and path_key(person_dir) not in known_paths:
                add(person_dir)

    for row in indexes["local_rows"]:
        local_path = str(row["local_path"] or "")
        if not local_path or path_exists(local_path):
            continue
        person_key = normalize_person_search(person_name_from_local_path(local_path, available_roots))
        for person_dir in dirs_by_name.get(person_key, []):
            add(person_dir)

    return sorted(candidates.values(), key=lambda item: clean_path(item).casefold())


def scan_candidates(
    conn: sqlite3.Connection,
    roots: list[Path],
    person_dirs: list[Path],
    write: bool,
    delete_stale: bool,
    limit_people: int = 0,
) -> dict:
    available_roots = [root for root in roots if root.exists()]
    people = load_people(conn)
    indexes = build_indexes(conn)
    scanned_paths: set[str] = set()
    stats = {
        "roots": len(available_roots),
        "candidate_person_dirs": len(person_dirs),
        "person_dirs_seen": 0,
        "works_seen": 0,
        "files_seen": 0,
        "people_created": 0,
        "works_created": 0,
        "local_works_created": 0,
        "local_paths_updated": 0,
        "local_paths_refreshed": 0,
        "work_people_created": 0,
        "stale_local_works_deleted": 0,
    }

    conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
    try:
        for person_dir in person_dirs[: limit_people or None]:
            stats["person_dirs_seen"] += 1
            person_source = clean_path(person_dir)
            person_id = upsert_person(conn, people, person_dir.name, person_source, write, stats)
            works = scan_person(person_dir, available_roots)
            for work in works:
                stats["works_seen"] += 1
                scanned_paths.add(path_key(work.work_dir))
                work_id, local_work_id, old_path = choose_existing_work(indexes, person_id, work)
                if not work_id:
                    work_id = create_work(conn, work, write, stats)
                if write and work_id < 0:
                    raise RuntimeError("unexpected dry-run work id while writing")
                next_local_work_id = create_or_update_local_work(conn, work_id, local_work_id, old_path, work, available_roots, write, stats)
                replace_local_files(conn, work_id, next_local_work_id or -1, work, write, stats)
                ensure_work_person(conn, work_id, person_id, write, stats)
            print(
                f"[scan] {stats['person_dirs_seen']}/{stats['candidate_person_dirs']} "
                f"works={stats['works_seen']} newPeople={stats['people_created']} "
                f"pathUpdates={stats['local_paths_updated']}",
                flush=True,
            )

        if delete_stale:
            stale_ids = stale_local_work_ids(conn, scanned_paths, available_roots)
            delete_stale_local_works(conn, stale_ids, write, stats)

        if write:
            conn.commit()
        else:
            conn.rollback()
    except Exception:
        conn.rollback()
        raise
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Full scan local library roots into fanhao-core-v2.sqlite.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--delete-stale", action="store_true")
    parser.add_argument("--changed-only", action="store_true", help="Inventory all roots, then recursively scan only new/moved/recent person dirs.")
    parser.add_argument("--recent-hours", type=float, default=48)
    parser.add_argument("--modified-since", default="", help="Only scan person folders modified on/after this local date, e.g. 2026-07-01.")
    parser.add_argument("--limit-people", type=int, default=0)
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    conn = sqlite3.connect(args.db, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    modified_since = parse_local_date(args.modified_since)
    if args.modified_since and modified_since is None:
        raise SystemExit(f"invalid --modified-since date: {args.modified_since}")
    if args.changed_only:
        candidates = candidate_person_dirs(conn, ROOTS, args.recent_hours, modified_since)
        print(f"[inventory] candidate person dirs={len(candidates)}", flush=True)
        for path in candidates[:30]:
            print(f"  {clean_path(path)}", flush=True)
        if len(candidates) > 30:
            print(f"  ... +{len(candidates) - 30} more", flush=True)
        stats = scan_candidates(conn, ROOTS, candidates, args.write, args.delete_stale, args.limit_people)
    else:
        stats = scan_all(conn, ROOTS, args.write, args.delete_stale, args.limit_people)
    conn.close()
    mode = "write" if args.write else "dry-run"
    print(f"[done] mode={mode} stats={stats}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
