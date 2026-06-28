import argparse
import json
import sqlite3
from pathlib import Path

import requests

from remote_image_cache import cache_remote_images, cached_remote_image_urls, ensure_remote_image_schema, unique_remote_image_urls, upsert_remote_image


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "data" / "actor-profiles.sqlite"
DEFAULT_SOURCES = ["rankings", "actor-movies", "work-info", "preview-images"]


def main() -> None:
    args = parse_args()
    with sqlite3.connect(args.db, timeout=30) as conn:
        ensure_remote_image_schema(conn)
        imported = import_work_cover_blobs(conn) if args.write and args.import_work_covers else 0
        if imported:
            conn.commit()
        urls = collect_urls(conn, args.sources)
        cached = cached_remote_image_urls(conn, urls)
        missing = [url for url in urls if url not in cached]
        if args.limit:
            missing = missing[: max(0, int(args.limit))]

        summary = {
            "mode": "write" if args.write else "dry-run",
            "sources": args.sources,
            "urls": len(urls),
            "cached": len(cached),
            "missing": len(missing),
            "importedWorkCovers": imported,
        }
        if not args.write:
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return

        session = requests.Session()
        session.headers.update({"User-Agent": args.user_agent})
        stats = {"checked": 0, "cached": 0, "skipped": 0, "failed": 0}
        batch_size = max(1, int(args.batch_size or 100))
        for index in range(0, len(missing), batch_size):
            chunk = missing[index : index + batch_size]
            chunk_stats = cache_remote_images(
                conn,
                chunk,
                session=session,
                referer=args.referer,
                timeout=args.timeout,
                concurrency=args.concurrency,
            )
            conn.commit()
            for key in stats:
                stats[key] += chunk_stats.get(key, 0)
            print(
                json.dumps(
                    {
                        "batch": index // batch_size + 1,
                        "done": min(index + batch_size, len(missing)),
                        "total": len(missing),
                        **chunk_stats,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        print(json.dumps({**summary, **stats}, ensure_ascii=False, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download known JavDB image URLs into FanHao remote_image_cache.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--source", action="append", choices=["rankings", "actor-movies", "work-info", "preview-images"], default=[])
    parser.add_argument("--write", action="store_true", help="实际下载并写入 remote_image_cache；默认只统计。")
    parser.add_argument("--limit", type=int, default=0, help="最多下载多少张；0 表示不限制。")
    parser.add_argument("--batch-size", type=int, default=100, help="每批下载后提交一次，便于中断后续跑。")
    parser.add_argument("--concurrency", type=int, default=8, help="Node fetch 并发数。")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--referer", default="https://javdb.com/")
    parser.add_argument(
        "--user-agent",
        default="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    )
    parser.add_argument("--no-import-work-covers", dest="import_work_covers", action="store_false")
    parser.set_defaults(import_work_covers=True)
    args = parser.parse_args()
    args.sources = args.source or DEFAULT_SOURCES
    return args


def collect_urls(conn: sqlite3.Connection, sources: list[str]) -> list[str]:
    urls = []
    if "rankings" in sources and table_exists(conn, "javdb_rankings"):
        urls.extend(row[0] for row in conn.execute("SELECT DISTINCT image_url FROM javdb_rankings WHERE image_url IS NOT NULL AND image_url <> ''"))
    if "actor-movies" in sources and table_exists(conn, "actor_movies"):
        urls.extend(row[0] for row in conn.execute("SELECT DISTINCT image_url FROM actor_movies WHERE image_url IS NOT NULL AND image_url <> ''"))
    if "work-info" in sources and table_exists(conn, "work_info"):
        urls.extend(row[0] for row in conn.execute("SELECT DISTINCT image_url FROM work_info WHERE image_url IS NOT NULL AND image_url <> ''"))
    if "preview-images" in sources and table_exists(conn, "work_info"):
        for (raw_json,) in conn.execute("SELECT preview_images_json FROM work_info WHERE preview_images_json IS NOT NULL AND preview_images_json <> ''"):
            urls.extend(parse_preview_image_urls(raw_json))
    return unique_remote_image_urls(urls)


def parse_preview_image_urls(raw_json: str) -> list[str]:
    try:
        values = json.loads(raw_json)
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(values, list):
        return []
    return [str(value).strip() for value in values if str(value or "").strip()]


def import_work_cover_blobs(conn: sqlite3.Connection) -> int:
    if not table_exists(conn, "work_covers"):
        return 0
    imported = 0
    for url, content_type, blob in conn.execute(
        """
        SELECT cover_url, cover_mime, cover_blob
        FROM work_covers
        WHERE cover_url IS NOT NULL AND cover_url <> '' AND cover_blob IS NOT NULL AND length(cover_blob) > 0
        """
    ):
        if upsert_remote_image(conn, url, blob, content_type):
            imported += 1
    return imported


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
    return bool(row)


if __name__ == "__main__":
    main()
