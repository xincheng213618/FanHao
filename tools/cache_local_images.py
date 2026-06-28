import argparse
import json
import mimetypes
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "data" / "actor-profiles.sqlite"
DEFAULT_INDEX = PROJECT_ROOT / "data" / "library-index.json"


def main() -> None:
    args = parse_args()
    library = json.loads(args.index.read_text(encoding="utf-8"))
    images = collect_images(library)
    if args.limit:
        images = images[: max(0, int(args.limit))]

    with sqlite3.connect(args.db, timeout=60) as conn:
        ensure_schema(conn)
        cached = cached_image_ids(conn, images)
        pending = [image for image in images if args.force or image["id"] not in cached]
        summary = {
            "mode": "write" if args.write else "dry-run",
            "images": len(images),
            "cached": 0 if args.force else len(cached),
            "pending": len(pending),
            "pendingBytes": sum(int(image.get("size") or 0) for image in pending),
            "force": bool(args.force),
        }
        if not args.write:
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return

        stats = {"checked": 0, "cached": 0, "missing": 0, "zeroBytes": 0, "deleted": 0, "failed": 0, "bytes": 0}
        batch_size = max(1, int(args.batch_size or 100))
        for index in range(0, len(pending), batch_size):
            chunk = pending[index : index + batch_size]
            chunk_stats = cache_images(conn, chunk, delete_zero_byte=args.delete_zero_byte)
            conn.commit()
            for key in stats:
                stats[key] += chunk_stats.get(key, 0)
            print(
                json.dumps(
                    {
                        "batch": index // batch_size + 1,
                        "done": min(index + batch_size, len(pending)),
                        "total": len(pending),
                        **chunk_stats,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        print(json.dumps({**summary, **stats}, ensure_ascii=False, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cache local library images into FanHao local_image_cache.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--write", action="store_true", help="实际读取本地图片并写入 SQLite；默认只统计。")
    parser.add_argument("--force", action="store_true", help="即使命中当前缓存也重新写入。")
    parser.add_argument("--delete-zero-byte", action="store_true", help="删除 0 字节本地图片，并清理对应缓存行。")
    parser.add_argument("--limit", type=int, default=0, help="最多处理多少张；0 表示不限制。")
    parser.add_argument("--batch-size", type=int, default=100, help="每批写入后提交一次。")
    return parser.parse_args()


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 10000;
        CREATE TABLE IF NOT EXISTS local_image_cache (
          file_id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          relative_path TEXT,
          content_type TEXT,
          image_blob BLOB,
          byte_length INTEGER,
          source_size INTEGER,
          source_mtime TEXT,
          status TEXT NOT NULL DEFAULT 'ok',
          error TEXT,
          cached_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_local_image_cache_path ON local_image_cache(file_path);
        CREATE INDEX IF NOT EXISTS idx_local_image_cache_status ON local_image_cache(status);
        """
    )


def collect_images(library: dict) -> list[dict]:
    images_by_id = {}
    for work in library.get("works") or []:
        for image in work.get("images") or []:
            image_id = str(image.get("id") or "").strip()
            image_path = str(image.get("path") or "").strip()
            if not image_id or not image_path:
                continue
            images_by_id[image_id] = image
    return list(images_by_id.values())


def cached_image_ids(conn: sqlite3.Connection, images: list[dict]) -> set[str]:
    by_id = {image["id"]: image for image in images}
    cached = set()
    ids = list(by_id)
    for index in range(0, len(ids), 500):
        chunk = ids[index : index + 500]
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"""
            SELECT file_id, source_size, source_mtime
            FROM local_image_cache
            WHERE image_blob IS NOT NULL AND length(image_blob) > 0 AND file_id IN ({placeholders})
            """,
            chunk,
        ).fetchall()
        for file_id, source_size, source_mtime in rows:
            image = by_id.get(file_id)
            if not image:
                continue
            if int(source_size or 0) == int(image.get("size") or 0) and str(source_mtime or "") == str(image.get("modifiedAt") or ""):
                cached.add(file_id)
    return cached


def cache_images(conn: sqlite3.Connection, images: list[dict], delete_zero_byte: bool = False) -> dict:
    stats = {"checked": 0, "cached": 0, "missing": 0, "zeroBytes": 0, "deleted": 0, "failed": 0, "bytes": 0}
    for image in images:
        stats["checked"] += 1
        image_path = Path(image.get("path") or "")
        if not image_path.is_file():
            upsert_error(conn, image, "file not found")
            stats["missing"] += 1
            continue
        try:
            size = image_path.stat().st_size
        except OSError as error:
            upsert_error(conn, image, str(error))
            stats["failed"] += 1
            continue
        if size <= 0:
            if delete_zero_byte:
                try:
                    image_path.unlink()
                    delete_cache_row(conn, image)
                    stats["deleted"] += 1
                except OSError as error:
                    upsert_error(conn, image, str(error))
                    stats["failed"] += 1
            else:
                upsert_error(conn, image, "zero-byte image")
                stats["zeroBytes"] += 1
            continue
        try:
            blob = image_path.read_bytes()
            upsert_image(conn, image, blob)
            stats["cached"] += 1
            stats["bytes"] += len(blob)
        except Exception as error:
            upsert_error(conn, image, str(error))
            stats["failed"] += 1
    return stats


def delete_cache_row(conn: sqlite3.Connection, image: dict) -> None:
    conn.execute("DELETE FROM local_image_cache WHERE file_id = ?", (image.get("id") or "",))


def upsert_image(conn: sqlite3.Connection, image: dict, blob: bytes) -> None:
    now = iso_now()
    source_size = int(image.get("size") or len(blob))
    source_mtime = str(image.get("modifiedAt") or mtime_iso(Path(image.get("path") or "")))
    conn.execute(
        """
        INSERT INTO local_image_cache (
          file_id, file_path, relative_path, content_type, image_blob, byte_length,
          source_size, source_mtime, status, error, cached_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', '', ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET
          file_path = excluded.file_path,
          relative_path = excluded.relative_path,
          content_type = excluded.content_type,
          image_blob = excluded.image_blob,
          byte_length = excluded.byte_length,
          source_size = excluded.source_size,
          source_mtime = excluded.source_mtime,
          status = 'ok',
          error = '',
          cached_at = COALESCE(local_image_cache.cached_at, excluded.cached_at),
          updated_at = excluded.updated_at
        """,
        (
            image["id"],
            image.get("path") or "",
            image.get("relativePath") or "",
            image_mime(image),
            blob,
            len(blob),
            source_size,
            source_mtime,
            now,
            now,
        ),
    )


def upsert_error(conn: sqlite3.Connection, image: dict, error: str) -> None:
    now = iso_now()
    conn.execute(
        """
        INSERT INTO local_image_cache (
          file_id, file_path, relative_path, content_type, image_blob, byte_length,
          source_size, source_mtime, status, error, cached_at, updated_at
        )
        VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 'error', ?, NULL, ?)
        ON CONFLICT(file_id) DO UPDATE SET
          file_path = excluded.file_path,
          relative_path = excluded.relative_path,
          status = 'error',
          error = excluded.error,
          updated_at = excluded.updated_at
        """,
        (
            image.get("id") or "",
            image.get("path") or "",
            image.get("relativePath") or "",
            image_mime(image),
            int(image.get("size") or 0),
            str(image.get("modifiedAt") or ""),
            str(error or "")[:1000],
            now,
        ),
    )


def image_mime(image: dict) -> str:
    guessed = mimetypes.guess_type(str(image.get("name") or image.get("path") or ""))[0]
    return guessed or "application/octet-stream"


def mtime_iso(path: Path) -> str:
    try:
        stat = path.stat()
    except OSError:
        return ""
    return datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


if __name__ == "__main__":
    main()
