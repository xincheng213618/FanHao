from __future__ import annotations

import argparse
import json
import mimetypes
import random
import re
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from backfill_javdb_actor_page import (  # noqa: E402
    canonical_actor_url,
    dedupe_actor_movies,
    next_actor_page_url,
    parse_actor_movies,
    safe_driver_get,
    wait_for_actor_page,
)
from backfill_javdb_metadata import (  # noqa: E402
    DEFAULT_CHROME_BINARY,
    DEFAULT_SCRAPER_CONFIG_PATH,
    DEFAULT_SHARED_PROFILE,
    AccessBlockedError,
    JavDbClient,
    load_scraper_config,
)
from code_parser import loose_code_key, normalize_code  # noqa: E402
from import_javdb_actor import actor_id_from_url, download_avatar, parse_actor_page, profile_looks_ready  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORE_DB = PROJECT_ROOT / "data" / "fanhao-core-v2.sqlite"
DEFAULT_LOG_DIR = PROJECT_ROOT / "data"
SOURCE = "actor_movies"
DEFAULT_COOKIE_CACHE = None


def main() -> None:
    configure_stdout()
    args = parse_args()
    args.scraper_config_data = load_scraper_config(args.scraper_config)
    jobs = actor_jobs(args)
    if args.limit_people:
        jobs = jobs[: args.limit_people]

    log_path = args.log or DEFAULT_LOG_DIR / f"core-javdb-actor-refresh-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    print(f"core actor 刷新开始: people={len(jobs)} write={args.write} log={log_path}", flush=True)
    if not args.write:
        print("当前是 dry-run：会访问 JavDB，但不会写入 core DB。", flush=True)

    client = JavDbClient(args)
    stats = {"people": 0, "movies": 0, "profiles": 0, "avatars": 0, "blocked": 0, "error": 0}
    try:
        with sqlite3.connect(args.db, timeout=30) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA busy_timeout = 5000")
            for index, job in enumerate(jobs, 1):
                try:
                    print(f"[{index}/{len(jobs)}] {job['name']} -> {job['actor_url']}", flush=True)
                    crawl = crawl_actor(client, job, args)
                    if args.write:
                        profile_result = save_profile(conn, job, crawl["profile"], client)
                        movie_count = save_movies(conn, job, crawl["movies"])
                        conn.commit()
                        stats["profiles"] += int(profile_result["profile"])
                        stats["avatars"] += int(profile_result["avatar"])
                        stats["movies"] += movie_count
                    else:
                        movie_count = len(crawl["movies"])
                    stats["people"] += 1
                    write_jsonl(
                        log_path,
                        {
                            "status": "person_done",
                            "personId": job["id"],
                            "name": job["name"],
                            "javdbUrl": job["actor_url"],
                            "displayName": crawl["profile"].get("display_name", ""),
                            "movies": movie_count,
                            "pages": crawl["pages"],
                            "write": args.write,
                        },
                    )
                    print(f"  pages={crawl['pages']} movies={movie_count} display={crawl['profile'].get('display_name') or '-'}", flush=True)
                    pause(args)
                except AccessBlockedError as error:
                    stats["blocked"] += 1
                    write_jsonl(log_path, {"status": "blocked", "personId": job["id"], "name": job["name"], "error": str(error)})
                    print(f"BLOCKED {job['name']}: {error}", flush=True)
                    break
                except Exception as error:
                    stats["error"] += 1
                    write_jsonl(log_path, {"status": "error", "personId": job["id"], "name": job["name"], "error": str(error)})
                    print(f"ERROR {job['name']}: {error}", flush=True)
    finally:
        client.close()

    print("core actor 刷新结束: " + json.dumps(stats, ensure_ascii=False), flush=True)
    if stats["blocked"] or stats["error"]:
        raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh JavDB actor pages into FanHao core DB.")
    parser.add_argument("--db", type=Path, default=DEFAULT_CORE_DB)
    parser.add_argument("--person-id", action="append", default=[], help="只刷新这些 core people.id。")
    parser.add_argument("--all-linked-people", action="store_true", help="刷新所有已经配置 JavDB actor 链接的人物。")
    parser.add_argument("--write", action="store_true", help="写入 core DB；不加则 dry-run。")
    parser.add_argument("--limit-people", type=int, default=0)
    parser.add_argument("--max-pages", type=int, default=1, help="每个人最多抓几页；0 表示一直到没有下一页。")
    parser.add_argument("--profile-dir", type=Path, default=DEFAULT_SHARED_PROFILE)
    parser.add_argument("--chrome-binary", type=Path, default=DEFAULT_CHROME_BINARY)
    parser.add_argument("--driver-path", type=Path, default=None)
    parser.add_argument("--cookie-profile-dir", type=Path, default=None)
    parser.add_argument("--cookie-profile-name", default="Default")
    parser.add_argument("--cookie-domain", action="append", default=[])
    parser.add_argument("--cookie-cache", type=Path, default=DEFAULT_COOKIE_CACHE)
    parser.add_argument("--proxy", default="http://127.0.0.1:10809")
    parser.add_argument("--no-proxy", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--scraper-config", type=Path, default=DEFAULT_SCRAPER_CONFIG_PATH)
    parser.add_argument("--actor-wait-seconds", type=int, default=35)
    parser.add_argument("--search-wait-seconds", type=int, default=25)
    parser.add_argument("--detail-wait-seconds", type=int, default=35)
    parser.add_argument("--sleep", type=float, default=2.0)
    parser.add_argument("--jitter", type=float, default=0.5)
    parser.add_argument("--fast", action="store_true")
    parser.add_argument("--log", type=Path, default=None)
    return parser.parse_args()


def actor_jobs(args: argparse.Namespace) -> list[dict]:
    ids = [int(item) for item in args.person_id if str(item).strip().isdigit()]
    if not ids and not args.all_linked_people:
        raise SystemExit("请传 --person-id，或使用 --all-linked-people。")

    with sqlite3.connect(args.db, timeout=30) as conn:
        conn.row_factory = sqlite3.Row
        params: list[object] = []
        where = ["ref.provider = 'javdb-actor'", "COALESCE(ref.url, '') <> ''"]
        if ids:
            placeholders = ",".join("?" for _ in ids)
            where.append(f"p.id IN ({placeholders})")
            params.extend(ids)
        rows = conn.execute(
            f"""
            SELECT p.id, p.name, p.display_name, ref.external_key, ref.url
            FROM people p
            JOIN person_external_refs ref ON ref.person_id = p.id
            WHERE {" AND ".join(where)}
            ORDER BY p.id, ref.id
            """,
            params,
        ).fetchall()

    jobs = []
    seen = set()
    for row in rows:
        actor_url = canonical_actor_url(row["url"] or row["external_key"] or "")
        actor_id = actor_id_from_url(actor_url)
        job_key = (int(row["id"]), actor_id)
        if not actor_url or not actor_id or job_key in seen:
            continue
        seen.add(job_key)
        jobs.append(
            {
                "id": int(row["id"]),
                "name": row["display_name"] or row["name"] or str(row["id"]),
                "db_name": row["name"] or "",
                "actor_id": actor_id,
                "actor_url": actor_url,
            }
        )
    return jobs


def crawl_actor(client: JavDbClient, job: dict, args: argparse.Namespace) -> dict:
    driver = client.get_driver()
    page_url = job["actor_url"]
    seen_pages = set()
    seen_codes = set()
    movies = []
    profile = {}
    pages = 0
    page_limit = max(0, int(args.max_pages or 0))

    while page_url:
        if page_url in seen_pages:
            break
        if page_limit and pages >= page_limit:
            break
        seen_pages.add(page_url)
        pages += 1
        safe_driver_get(driver, page_url, args.actor_wait_seconds)
        html = wait_for_actor_page(client, args.actor_wait_seconds)
        if not profile:
            profile = parse_actor_page(html, driver.current_url)
            profile["javdb_url"] = job["actor_url"]
            profile["javdb_actor_id"] = job["actor_id"]
        for movie in dedupe_actor_movies(parse_actor_movies(html, driver.current_url, pages)):
            code = normalize_code(movie.code) or movie.code
            key = code_key(code)
            if not key or key in seen_codes:
                continue
            seen_codes.add(key)
            movie.code = code
            movies.append(movie)
        page_url = next_actor_page_url(html, driver.current_url)
        if page_url:
            pause(args)

    return {"profile": profile, "movies": movies, "pages": pages}


def save_profile(conn: sqlite3.Connection, job: dict, profile: dict, client: JavDbClient) -> dict:
    now = timestamp()
    display_name = clean_text(profile.get("display_name")) or job["name"]
    aliases = unique_names([display_name, *(profile.get("aliases") or []), job["db_name"]])
    movie_count = profile.get("movie_count")
    conn.execute(
        """
        UPDATE people
        SET display_name = COALESCE(NULLIF(display_name, ''), NULLIF(?, ''), display_name),
            name_search = COALESCE(NULLIF(name_search, ''), NULLIF(?, ''), name_search),
            movie_count = COALESCE(?, movie_count),
            status = 'ok',
            error = NULL,
            source = CASE WHEN source = 'migration' THEN ? ELSE source END,
            updated_at = ?
        WHERE id = ?
        """,
        (display_name, normalize_person_search(display_name), movie_count, SOURCE, now, job["id"]),
    )
    conn.execute(
        """
        INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
        VALUES (?, 'javdb-actor', ?, ?, ?, ?, ?)
        ON CONFLICT(provider, external_key) DO UPDATE SET
          person_id = excluded.person_id,
          url = excluded.url,
          updated_at = excluded.updated_at
        """,
        (job["id"], job["actor_id"], job["actor_url"], SOURCE, now, now),
    )
    for alias in aliases:
        if normalize_person_search(alias) == normalize_person_search(job["name"]):
            continue
        conn.execute(
            """
            INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source)
            VALUES (?, ?, ?, ?)
            """,
            (job["id"], alias, normalize_person_search(alias), SOURCE),
        )

    avatar_written = False
    avatar_url = clean_text(profile.get("avatar_url"))
    if avatar_url:
        avatar_blob = b""
        avatar_mime = mimetypes.guess_type(urlparse(avatar_url).path)[0] or "image/jpeg"
        if profile_looks_ready(profile):
            try:
                avatar_blob, avatar_mime = download_avatar(avatar_url, client.get_driver())
            except Exception as error:
                print(f"  avatar skip: {error}", flush=True)
        conn.execute(
            """
            INSERT INTO images (
              owner_type, owner_id, kind, source_type, remote_url, mime, image_blob, byte_size,
              sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
            )
            VALUES ('person', ?, 'avatar', 'remote', ?, ?, ?, ?, 0, 'ok', ?, 'person_external_refs', ?, ?, ?)
            ON CONFLICT DO UPDATE SET
              remote_url = excluded.remote_url,
              mime = COALESCE(excluded.mime, images.mime),
              image_blob = COALESCE(excluded.image_blob, images.image_blob),
              byte_size = COALESCE(excluded.byte_size, images.byte_size),
              status = 'ok',
              source = excluded.source,
              updated_at = excluded.updated_at
            """,
            (job["id"], avatar_url, avatar_mime, avatar_blob or None, len(avatar_blob) or None, "actor_profiles", job["actor_id"], now, now),
        )
        avatar_written = True
    return {"profile": True, "avatar": avatar_written}


def save_movies(conn: sqlite3.Connection, job: dict, movies: list) -> int:
    now = timestamp()
    saved = 0
    for index, movie in enumerate(movies, 1):
        code = normalize_code(movie.code) or movie.code
        key = code_key(code)
        if not key:
            continue
        detail_key = javdb_video_key(movie.detail_url)
        work_id = find_work_id(conn, key, detail_key)
        if work_id:
            conn.execute(
                """
                UPDATE works
                SET code = COALESCE(NULLIF(?, ''), code),
                    code_search = COALESCE(NULLIF(?, ''), code_search),
                    title = COALESCE(NULLIF(?, ''), title),
                    release_date = COALESCE(NULLIF(?, ''), release_date),
                    rating = COALESCE(?, rating),
                    rating_count = COALESCE(?, rating_count),
                    has_magnet = COALESCE(?, has_magnet),
                    is_streamable = COALESCE(?, is_streamable),
                    has_subtitles = COALESCE(?, has_subtitles),
                    javdb_tags_json = COALESCE(?, javdb_tags_json),
                    status = 'ok',
                    source = CASE WHEN source = 'migration' THEN ? ELSE source END,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    code,
                    key,
                    clean_text(movie.title),
                    movie.release_date or "",
                    movie.rating,
                    movie.rating_count,
                    db_bool(movie.has_magnet),
                    db_bool(movie.is_streamable),
                    db_bool(movie.has_subtitles),
                    tags_json(movie.tags),
                    SOURCE,
                    now,
                    work_id,
                ),
            )
        else:
            cursor = conn.execute(
                """
                INSERT INTO works(
                  code, code_search, title, release_date, rating, rating_count,
                  has_magnet, is_streamable, has_subtitles, javdb_tags_json,
                  status, source, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)
                """,
                (
                    code,
                    key,
                    clean_text(movie.title),
                    movie.release_date or None,
                    movie.rating,
                    movie.rating_count,
                    db_bool(movie.has_magnet),
                    db_bool(movie.is_streamable),
                    db_bool(movie.has_subtitles),
                    tags_json(movie.tags),
                    SOURCE,
                    now,
                    now,
                ),
            )
            work_id = int(cursor.lastrowid)
        if detail_key:
            conn.execute(
                """
                INSERT INTO work_external_refs(work_id, provider, external_key, url, source, created_at, updated_at)
                VALUES (?, 'javdb-video', ?, ?, ?, ?, ?)
                ON CONFLICT(provider, external_key) DO UPDATE SET
                  work_id = excluded.work_id,
                  url = excluded.url,
                  updated_at = excluded.updated_at
                """,
                (work_id, detail_key, movie.detail_url, SOURCE, now, now),
            )
        conn.execute(
            """
            INSERT INTO work_people(work_id, person_id, role, sort_order, source, created_at, updated_at)
            VALUES (?, ?, 'actor', ?, ?, ?, ?)
            ON CONFLICT(work_id, person_id, role) DO UPDATE SET
              sort_order = excluded.sort_order,
              source = excluded.source,
              updated_at = excluded.updated_at
            """,
            (work_id, job["id"], int(movie.page_index or 0) * 1000 + int(movie.position_index or index), SOURCE, now, now),
        )
        if movie.image_url:
            conn.execute(
                """
                INSERT INTO images (
                  owner_type, owner_id, kind, source_type, remote_url, mime, sort_order,
                  status, source, legacy_table, legacy_key, created_at, updated_at
                )
                VALUES ('work', ?, 'cover', 'remote', ?, ?, 0, 'ok', ?, 'work_external_refs', ?, ?, ?)
                ON CONFLICT DO UPDATE SET
                  remote_url = excluded.remote_url,
                  mime = COALESCE(excluded.mime, images.mime),
                  status = 'ok',
                  source = excluded.source,
                  updated_at = excluded.updated_at
                """,
                (work_id, movie.image_url, mimetypes.guess_type(urlparse(movie.image_url).path)[0] or "image/jpeg", SOURCE, detail_key or key, now, now),
            )
        saved += 1
    return saved


def db_bool(value: bool | None) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def tags_json(tags: list[str]) -> str | None:
    clean = [clean_text(tag) for tag in tags or [] if clean_text(tag)]
    return json.dumps(clean, ensure_ascii=False) if clean else None


def find_work_id(conn: sqlite3.Connection, code_search: str, detail_key: str) -> int | None:
    if detail_key:
        row = conn.execute(
            "SELECT work_id FROM work_external_refs WHERE provider = 'javdb-video' AND external_key = ?",
            (detail_key,),
        ).fetchone()
        if row:
            return int(row["work_id"])
    row = conn.execute("SELECT id FROM works WHERE code_search = ? ORDER BY id LIMIT 1", (code_search,)).fetchone()
    return int(row["id"]) if row else None


def javdb_video_key(value: str) -> str:
    try:
        match = re.search(r"/v/([^/?#]+)", urlparse(value or "").path)
        return match.group(1) if match else ""
    except Exception:
        match = re.search(r"/v/([^/?#\s]+)", value or "")
        return match.group(1) if match else ""


def code_key(value: str) -> str:
    return (loose_code_key(value) or "").lower()


def normalize_person_search(value: str) -> str:
    return clean_text(value).lower().replace(" ", "")


def clean_text(value: object) -> str:
    return str(value or "").strip()


def unique_names(values: list[object]) -> list[str]:
    output = []
    seen = set()
    for value in values:
        name = clean_text(value)
        key = normalize_person_search(name)
        if not key or key in seen:
            continue
        seen.add(key)
        output.append(name)
    return output


def timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def pause(args: argparse.Namespace) -> None:
    base_sleep = max(0.0, float(args.sleep or 0))
    if not args.fast and base_sleep < 5.0:
        base_sleep = 5.0
    total_sleep = base_sleep + random.uniform(0, max(0.0, float(args.jitter or 0)))
    if total_sleep:
        time.sleep(total_sleep)


def write_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def configure_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("已中断", file=sys.stderr)
