from __future__ import annotations

import argparse
import json
import mimetypes
import sqlite3
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "douyin_downloads.sqlite"
DEFAULT_PROFILE_ID = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill local cover files from links.cover_url into SQLite."
    )
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite database path.")
    parser.add_argument("--profile-id", type=int, default=DEFAULT_PROFILE_ID)
    parser.add_argument("--output-dir", default="", help="Fallback output directory.")
    parser.add_argument("--proxy", default="", help="Optional HTTP proxy, e.g. http://127.0.0.1:10808")
    parser.add_argument("--limit", type=int, default=0, help="Maximum rows to process; 0 means no limit.")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--apply", action="store_true", help="Actually download and update SQLite.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing cover files.")
    return parser.parse_args()


def first_url(value: str) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        for item in parsed:
            candidate = str(item or "").strip()
            if candidate.startswith(("http://", "https://")):
                return candidate
    if text.startswith(("http://", "https://")):
        return text
    for token in text.replace("\\/", "/").split():
        if token.startswith(("http://", "https://")):
            return token
    return ""


def row_paths(row: sqlite3.Row, fallback_output_dir: str) -> tuple[Path, Path]:
    output_dir = Path(row["output_dir"] or fallback_output_dir).expanduser()
    preview_path = str(row["preview_path"] or "").strip()
    if preview_path:
        raw_preview = Path(preview_path)
        preview = raw_preview if raw_preview.is_absolute() else output_dir / raw_preview
        return output_dir, preview.parent

    local_file_paths = str(row["local_file_paths"] or "")
    try:
        paths = json.loads(local_file_paths)
    except json.JSONDecodeError:
        paths = []
    if isinstance(paths, list):
        for item in paths:
            text = str(item or "").strip()
            if not text:
                continue
            raw = Path(text)
            absolute = raw if raw.is_absolute() else output_dir / raw
            return output_dir, absolute.parent

    return output_dir, output_dir / "_covers" / str(row["aweme_id"])


def extension_from_response(url: str, content_type: str) -> str:
    guessed = mimetypes.guess_extension((content_type or "").split(";", 1)[0].strip())
    if guessed in {".jpe", ".jpeg"}:
        return ".jpg"
    if guessed:
        return guessed
    suffix = Path(url.split("?", 1)[0]).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".jpg"


def safe_cover_name(row: sqlite3.Row, ext: str) -> str:
    preview_path = str(row["preview_path"] or "").strip()
    if preview_path:
        stem = Path(preview_path).stem
        if stem:
            return f"{stem}_cover{ext}"
    return f"{row['aweme_id']}_cover{ext}"


def relative_or_absolute(output_dir: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(output_dir.resolve()))
    except ValueError:
        return str(path.resolve())


def update_local_file_paths(current: str, cover_path: str) -> str:
    try:
        paths = json.loads(current or "[]")
    except json.JSONDecodeError:
        paths = []
    if not isinstance(paths, list):
        paths = []
    if cover_path not in paths:
        paths.append(cover_path)
    return json.dumps(paths, ensure_ascii=False, separators=(",", ":"))


def download_cover(url: str, target_dir: Path, row: sqlite3.Row, opener: Any, timeout: int, force: bool) -> tuple[Path, int]:
    req = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
            ),
            "Referer": "https://www.douyin.com/",
        },
    )
    with opener.open(req, timeout=timeout) as resp:
        data = resp.read()
        ext = extension_from_response(url, resp.headers.get("Content-Type", ""))
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe_cover_name(row, ext)
    if target.exists() and not force:
        return target, target.stat().st_size
    target.write_bytes(data)
    return target, len(data)


def main() -> int:
    args = parse_args()
    db_path = Path(args.db)
    if not db_path.exists():
        print(f"DB not found: {db_path}", file=sys.stderr)
        return 2

    handlers = []
    if args.proxy:
        handlers.append(ProxyHandler({"http": args.proxy, "https": args.proxy}))
    opener = build_opener(*handlers)

    query = """
        SELECT id, profile_id, aweme_id, cover_url, output_dir, preview_path,
               local_file_paths, local_cover_path
        FROM links
        WHERE profile_id=?
          AND status='downloaded'
          AND COALESCE(cover_url, '') <> ''
          AND COALESCE(local_cover_path, '') = ''
        ORDER BY downloaded_at DESC
    """
    if args.limit > 0:
        query += " LIMIT ?"
        params: tuple[Any, ...] = (args.profile_id, args.limit)
    else:
        params = (args.profile_id,)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(query, params).fetchall()
    print(f"matched={len(rows)} apply={args.apply}")

    done = failed = 0
    for row in rows:
        url = first_url(str(row["cover_url"] or ""))
        if not url:
            failed += 1
            print(f"skip no-cover-url aweme={row['aweme_id']}")
            continue

        output_dir, target_dir = row_paths(row, args.output_dir)
        if not args.apply:
            print(f"dry-run aweme={row['aweme_id']} target_dir={target_dir}")
            continue

        try:
            target, size = download_cover(url, target_dir, row, opener, args.timeout, args.force)
            cover_path = relative_or_absolute(output_dir, target)
            local_file_paths = update_local_file_paths(str(row["local_file_paths"] or ""), cover_path)
            conn.execute(
                """
                UPDATE links
                SET local_cover_path=?, local_file_paths=?
                WHERE id=?
                """,
                (cover_path, local_file_paths, row["id"]),
            )
            conn.execute(
                """
                INSERT INTO link_files(
                  link_id, profile_id, aweme_id, role, kind, file_name, file_path,
                  absolute_path, size_bytes, exists_on_disk, recorded_at
                )
                VALUES(?, ?, ?, 'cover', 'image', ?, ?, ?, ?, 1, datetime('now'))
                ON CONFLICT(profile_id, aweme_id, file_path) DO UPDATE SET
                  link_id=excluded.link_id,
                  role=excluded.role,
                  kind=excluded.kind,
                  file_name=excluded.file_name,
                  absolute_path=excluded.absolute_path,
                  size_bytes=excluded.size_bytes,
                  exists_on_disk=excluded.exists_on_disk,
                  recorded_at=excluded.recorded_at
                """,
                (
                    row["id"],
                    row["profile_id"],
                    row["aweme_id"],
                    target.name,
                    cover_path,
                    str(target.resolve()),
                    size,
                ),
            )
            conn.commit()
            done += 1
            print(f"ok aweme={row['aweme_id']} cover={cover_path}")
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            failed += 1
            conn.rollback()
            print(f"fail aweme={row['aweme_id']} error={exc}", file=sys.stderr)

    conn.close()
    print(f"done={done} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
