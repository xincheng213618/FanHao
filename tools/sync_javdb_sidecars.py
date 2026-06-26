import argparse
import mimetypes
import re
import sqlite3
from pathlib import Path
from urllib.parse import urlparse
import json


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "data" / "actor-profiles.sqlite"
DEFAULT_LIBRARY_INDEX = PROJECT_ROOT / "data" / "library-index.json"
DEFAULT_SOURCE_PREFIXES = ["G:/"]


def main() -> None:
    args = parse_args()
    library = json.loads(args.library_index.read_text(encoding="utf-8"))
    works = scoped_works(library, args)

    stats = {
        "mode": "write" if args.write else "dry-run",
        "works": len(works),
        "info_pending": 0,
        "cover_pending": 0,
        "info_written": 0,
        "cover_written": 0,
        "skipped": 0,
        "info_error_rows_ignored": 0,
        "errors": 0,
    }
    with sqlite3.connect(args.db) as conn:
        stats["info_error_rows_ignored"] = conn.execute(
            "SELECT COUNT(*) FROM work_info WHERE lower(coalesce(status, '')) = 'error'"
        ).fetchone()[0]
        info_rows = {
            row[0]: {"raw_text": row[1] or "", "fields_json": row[2] or "[]"}
            for row in conn.execute("SELECT work_id, raw_text, fields_json FROM work_info WHERE status = 'ok'").fetchall()
        }
        cover_rows = {
            row[0]: {"blob": row[1], "mime": row[2] or "", "url": row[3] or ""}
            for row in conn.execute("SELECT work_id, cover_blob, cover_mime, cover_url FROM work_covers WHERE cover_blob IS NOT NULL").fetchall()
        }

    for work in works:
        folder = work_folder_path(work)
        if not folder or not folder.exists() or not folder.is_dir():
            stats["skipped"] += 1
            continue

        try:
            info = info_rows.get(work.get("id"))
            if info:
                info_path = choose_info_path(folder, args.overwrite)
                if info_path:
                    stats["info_pending"] += 1
                    if args.write:
                        info_path.write_text(render_info_text(info) + "\n", encoding="utf-8")
                        stats["info_written"] += 1

            cover = cover_rows.get(work.get("id"))
            if cover:
                cover_path = choose_cover_path(folder, cover["mime"], cover["url"], args.overwrite)
                if cover_path:
                    stats["cover_pending"] += 1
                    if args.write:
                        cover_path.write_bytes(cover["blob"])
                        stats["cover_written"] += 1
        except OSError:
            stats["errors"] += 1

    print(json.dumps(stats, ensure_ascii=False))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Write cached JavDB info/covers back to local work folders.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--library-index", type=Path, default=DEFAULT_LIBRARY_INDEX)
    parser.add_argument("--write", action="store_true", help="实际写入 info/cover sidecar；默认只 dry-run 统计。")
    parser.add_argument("--all-sources", action="store_true", help="处理所有来源；默认只同步 --source-prefix 指定来源。")
    parser.add_argument("--source-prefix", action="append", default=[], help="只同步这些本机路径前缀；可重复。默认 G:/。例：F:/ 或 O:/[珍藏]")
    parser.add_argument("--person-id", action="append", default=[])
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def scoped_works(library: dict, args: argparse.Namespace) -> list[dict]:
    person_ids = set(args.person_id or [])
    prefixes = args.source_prefix or DEFAULT_SOURCE_PREFIXES
    works = []
    for work in library.get("works", []):
        if person_ids and work.get("personId") not in person_ids:
            continue
        if not args.all_sources and not work_matches_source(work, prefixes):
            continue
        works.append(work)
    return works


def normalize_source_path(value: str) -> str:
    path = str(value or "").strip().replace("\\", "/").lower()
    path = re.sub(r"/+$", "", path)
    if re.fullmatch(r"[a-z]", path):
        path = f"{path}:"
    return path


def source_path_matches(path: str, prefix: str) -> bool:
    normalized_path = normalize_source_path(path)
    normalized_prefix = normalize_source_path(prefix)
    if not normalized_path or not normalized_prefix:
        return False
    return normalized_path == normalized_prefix or normalized_path.startswith(normalized_prefix + "/")


def work_matches_source(work: dict, prefixes: list[str]) -> bool:
    return any(source_path_matches(work.get("relativePath") or "", prefix) for prefix in prefixes)


def work_folder_path(work: dict) -> Path | None:
    raw = str(work.get("relativePath") or "").strip()
    if not raw:
        return None
    normalized = raw.replace("/", "\\")
    if not re.match(r"^[A-Za-z]:\\", normalized):
        return None
    return Path(normalized)


def choose_info_path(folder: Path, overwrite: bool) -> Path | None:
    info_path = folder / "info.txt"
    if overwrite or not info_path.exists():
        return info_path
    fallback = folder / "javdb-info.txt"
    if overwrite or not fallback.exists():
        return fallback
    return None


def choose_cover_path(folder: Path, cover_mime: str, image_url: str, overwrite: bool) -> Path | None:
    ext = cover_extension(cover_mime, image_url)
    primary = folder / f"cover{ext}"
    existing = list_existing_covers(folder)
    if overwrite or not existing:
        return primary
    return None


def cover_extension(cover_mime: str, image_url: str) -> str:
    ext = mimetypes.guess_extension((cover_mime or "").split(";", 1)[0].strip()) or Path(urlparse(image_url or "").path).suffix
    ext = (ext or ".jpg").lower()
    if ext == ".jpe":
        ext = ".jpg"
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}:
        ext = ".jpg"
    return ext


def list_existing_covers(folder: Path) -> list[Path]:
    covers = []
    stems = ("cover", "poster", "folder", "front", "fanart", "thumb", "thumbnail")
    for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"):
        for stem in stems:
            candidate = folder / f"{stem}{ext}"
            if candidate.exists():
                covers.append(candidate)
    return covers


def render_info_text(info: dict) -> str:
    raw_text = str(info.get("raw_text") or "").strip()
    if raw_text:
        return raw_text
    try:
        fields = json.loads(info.get("fields_json") or "[]")
    except json.JSONDecodeError:
        fields = []
    lines = []
    for field in fields:
        label = str(field.get("label") or "").strip()
        value = str(field.get("value") or "").strip()
        if label and value:
            lines.append(f"{label}: {value}")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
