import argparse
import json
import mimetypes
import random
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from selenium.common.exceptions import TimeoutException

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from code_parser import loose_code_key, normalize_code  # noqa: E402
from backfill_javdb_metadata import (  # noqa: E402
    DEFAULT_CHROME_BINARY,
    DEFAULT_DB,
    DEFAULT_LIBRARY_INDEX,
    DEFAULT_SCRAPER_CONFIG_PATH,
    DEFAULT_SHARED_PROFILE,
    AccessBlockedError,
    JavDbClient,
    JavDbMeta,
    WorkTarget,
    blocked_reason,
    ensure_schema as ensure_work_schema,
    extract_work_code,
    load_scraper_config,
    parse_detail_page,
    render_raw_text,
    upsert_work_cover,
    upsert_work_info,
)
from import_javdb_actor import (  # noqa: E402
    actor_id_from_url,
    download_avatar,
    ensure_schema as ensure_actor_schema,
    is_actor_avatar_url,
    parse_actor_page,
    profile_looks_ready,
    save_profile,
)
from remote_image_cache import cache_remote_images, ensure_remote_image_schema, upsert_remote_image  # noqa: E402


DEFAULT_LOG_DIR = Path(__file__).resolve().parents[1] / "data"
SKIP_PERSON_NAMES = {"noactor", "VR"}
DEFAULT_SOURCE_PREFIXES = ["G:/"]


@dataclass
class ActorSpec:
    url: str
    person_id: str = ""
    name: str = ""


@dataclass
class ActorMovie:
    code: str
    title: str
    detail_url: str
    image_url: str = ""
    release_date: str = ""
    rating: float | None = None
    rating_count: int | None = None
    has_magnet: bool | None = None
    is_streamable: bool | None = None
    has_subtitles: bool | None = None
    tags: list[str] = field(default_factory=list)
    page_index: int = 0
    position_index: int = 0


@dataclass
class ActorMovieCrawl:
    html: str
    profile: dict
    movies: list[ActorMovie]
    duplicate_count: int = 0
    scanned_pages: int = 0
    stopped_on_existing: bool = False


def main() -> None:
    configure_stdout()
    args = parse_args()
    args.scraper_config_data = load_scraper_config(args.scraper_config)
    library = load_library(args.library_index)
    people = scoped_people(library, args)
    people_by_id = {person.get("id"): person for person in library.get("people", [])}
    works_by_id = {work.get("id"): work for work in library.get("works", []) if work.get("id")}

    with sqlite3.connect(args.db, timeout=30) as conn:
        ensure_actor_schema(conn)
        ensure_work_schema(conn)
        ensure_actor_movie_schema(conn)
        ensure_remote_image_schema(conn)
        actor_specs = resolve_actor_specs(conn, people, args.actor_url)
        if not actor_specs:
            actor_specs = actor_specs_from_cache(conn, people)
        actor_jobs = build_actor_jobs(conn, actor_specs, people, works_by_id, args)

    if args.list_targets:
        print_job_summary(actor_jobs)
        return

    if args.limit_people:
        actor_jobs = actor_jobs[: args.limit_people]

    log_path = args.log or DEFAULT_LOG_DIR / f"javdb-actor-page-backfill-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    print(
        f"actor页补全开始: people={len(actor_jobs)} write={args.write} "
        f"targets={sum(len(job['targets']) for job in actor_jobs)} log={log_path}",
        flush=True,
    )
    if not args.write:
        print("当前是 dry-run：会访问 JavDB 解析页面，但不会写库。真正写入请加 --write。", flush=True)

    client = JavDbClient(args)
    stats = {
        "people": 0,
        "ok": 0,
        "miss": 0,
        "error": 0,
        "blocked": 0,
        "written_info": 0,
        "written_cover": 0,
        "written_actor": 0,
        "written_actor_movies": 0,
        "written_info_files": 0,
        "written_cover_files": 0,
        "file_errors": 0,
        "images_cached": 0,
        "images_skipped": 0,
        "images_failed": 0,
    }

    try:
        with sqlite3.connect(args.db, timeout=30) as conn:
            ensure_actor_schema(conn)
            ensure_work_schema(conn)
            ensure_actor_movie_schema(conn)
            ensure_remote_image_schema(conn)
            for person_index, job in enumerate(actor_jobs, 1):
                person = job["person"]
                actor_url = job["actor_url"]
                targets = job["targets"]
                if args.limit:
                    targets = targets[: args.limit]
                if not targets and not args.refresh_actor and not args.actor_movies_only:
                    continue

                try:
                    print(f"[{person_index}/{len(actor_jobs)}] actor {person['name']} -> {actor_url}", flush=True)
                    crawl = crawl_actor_movies(client, conn, person, actor_url, args)
                    actor_html = crawl.html
                    actor_profile = crawl.profile
                    movies = crawl.movies
                    if args.write:
                        stats["written_actor_movies"] += save_actor_movies(conn, person, actor_url, actor_profile, movies, replace=not incremental_actor_movies(args))
                        if not args.no_cache_images:
                            image_stats = cache_remote_images(
                                conn,
                                [movie.image_url for movie in movies],
                                session=image_session(client),
                                referer=actor_url,
                            )
                            stats["images_cached"] += image_stats["cached"]
                            stats["images_skipped"] += image_stats["skipped"]
                            stats["images_failed"] += image_stats["failed"]
                        conn.commit()
                    print(
                        f"  actor片单: pages={crawl.scanned_pages} new={len(movies)} "
                        f"duplicates={crawl.duplicate_count} stop={'Y' if crawl.stopped_on_existing else '-'}",
                        flush=True,
                    )
                    if args.write and not args.actor_movies_only and (args.refresh_actor or not job["actor_cached_ok"]):
                        if profile_looks_ready(actor_profile):
                            avatar_bytes, avatar_mime = download_avatar(actor_profile.get("avatar_url", ""), client.get_driver())
                            save_profile(args.db, person, actor_profile, avatar_bytes, avatar_mime)
                            stats["written_actor"] += 1
                        elif actor_profile.get("display_name") or actor_profile.get("javdb_url"):
                            save_actor_profile_without_avatar(conn, person, actor_profile)
                            conn.commit()
                            stats["written_actor"] += 1

                    movie_by_code = {movie.code: movie for movie in movies}
                    stats["people"] += 1
                    if not args.actor_movies_only:
                        process_targets(conn, client, person, targets, movie_by_code, args, stats, log_path)
                    conn.commit()
                    write_jsonl(
                        log_path,
                        {
                            "status": "person_done",
                            "personId": person.get("id"),
                            "personName": person.get("name"),
                            "javdbUrl": actor_url,
                            "targets": len(targets),
                            "matchedMovies": len(movie_by_code),
                            "scannedPages": crawl.scanned_pages,
                            "duplicates": crawl.duplicate_count,
                            "stoppedOnExisting": crawl.stopped_on_existing,
                            "actorTitle": actor_profile.get("display_name"),
                            "actorPageBytes": len(actor_html.encode("utf-8")),
                            "imagesCached": image_stats["cached"] if args.write and not args.no_cache_images else 0,
                            "imagesSkipped": image_stats["skipped"] if args.write and not args.no_cache_images else 0,
                            "imagesFailed": image_stats["failed"] if args.write and not args.no_cache_images else 0,
                        },
                    )
                except AccessBlockedError as error:
                    stats["blocked"] += 1
                    write_jsonl(log_path, {"status": "blocked", "personId": person.get("id"), "name": person.get("name"), "error": str(error)})
                    print(f"BLOCKED {person['name']}: {error}", flush=True)
                    break
                except Exception as error:
                    stats["error"] += 1
                    write_jsonl(log_path, {"status": "error", "personId": person.get("id"), "name": person.get("name"), "error": str(error)})
                    print(f"ERROR {person['name']}: {error}", flush=True)
                    if is_browser_startup_error(error):
                        print("浏览器启动失败，停止本轮任务。请清理共享 Chrome profile 后重试。", flush=True)
                        break
                pause(args)
    finally:
        client.close()

    print("actor页补全结束: " + json.dumps(stats, ensure_ascii=False), flush=True)
    if stats["blocked"] or stats["error"]:
        raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill G-drive FanHao metadata from JavDB actor pages.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--library-index", type=Path, default=DEFAULT_LIBRARY_INDEX)
    parser.add_argument("--profile-dir", type=Path, default=DEFAULT_SHARED_PROFILE)
    parser.add_argument("--chrome-binary", type=Path, default=DEFAULT_CHROME_BINARY)
    parser.add_argument("--driver-path", type=Path, default=None)
    parser.add_argument("--cookie-profile-dir", type=Path, default=None, help="从 Chromium/115Chrome User Data 读取 Cookie 并注入当前 Selenium。")
    parser.add_argument("--cookie-profile-name", default="Default", help="Cookie 所在的 Chromium profile，默认 Default。")
    parser.add_argument("--cookie-domain", action="append", default=[], help="只注入这些域名的 Cookie；默认 javdb.com。可重复。")
    parser.add_argument("--proxy", default="http://127.0.0.1:10809")
    parser.add_argument("--no-proxy", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--actor-url", action="append", default=[], help="JavDB actor URL. Also supports NAME=URL or PERSON_ID=URL.")
    parser.add_argument("--person-id", action="append", default=[], help="Only process these local person ids.")
    parser.add_argument("--name", action="append", default=[], help="Only process local people whose names contain this text.")
    parser.add_argument("--all-sources", action="store_true", help="处理所有来源；默认只处理 --source-prefix 指定来源。")
    parser.add_argument("--source-prefix", action="append", default=[], help="只处理这些本机路径前缀；可重复。默认 G:/。例：F:/ 或 O:/[珍藏]")
    parser.add_argument("--include-special", action="store_true", help="包含 [A] 这类特殊目录。")
    parser.add_argument("--mode", choices=["missing", "info", "cover", "both"], default="missing")
    parser.add_argument("--refresh", action="store_true", help="忽略已有作品信息/封面缓存。")
    parser.add_argument("--refresh-actor", action="store_true", help="刷新 actor_profiles 头像和资料页映射。")
    parser.add_argument("--actor-movies-only", action="store_true", help="只缓存 actor 页作品列表，用于统计/网站灰色未下载卡片；不进详情页。")
    parser.add_argument("--incremental-actor-movies", action="store_true", help="增量刷新 actor 片单：页内去重，遇到已有番号停止翻页，保存时不删除旧缓存。")
    parser.add_argument("--write", action="store_true", help="实际写入 SQLite；不加时为 dry-run。")
    parser.add_argument("--no-cache-images", action="store_true", help="只写 URL，不下载 actor 页/详情页图片到 remote_image_cache。")
    parser.add_argument("--no-write-files", action="store_true", help="只写 SQLite，不回写 info.txt 和 cover.* 到作品目录。")
    parser.add_argument("--overwrite-files", action="store_true", help="允许覆盖作品目录里的 info.txt / cover.*。默认不覆盖。")
    parser.add_argument("--list-targets", action="store_true", help="只列出待补项目，不访问 JavDB。")
    parser.add_argument("--limit", type=int, default=0, help="每个人最多处理多少作品；0 不限制。")
    parser.add_argument("--limit-people", type=int, default=0, help="最多处理多少个人物；0 不限制。")
    parser.add_argument("--max-pages", type=int, default=0, help="每个 actor 页最多翻多少页；0 表示一直翻到没有下一页。")
    parser.add_argument("--actor-wait-seconds", type=int, default=35)
    parser.add_argument("--search-wait-seconds", type=int, default=25)
    parser.add_argument("--detail-wait-seconds", type=int, default=35)
    parser.add_argument("--scraper-config", type=Path, default=DEFAULT_SCRAPER_CONFIG_PATH, help="JavDB selector/label 配置 JSON")
    parser.add_argument("--sleep", type=float, default=8.0, help="每次页面访问/作品处理后的基础等待秒数；默认偏慢，避免触发风控。")
    parser.add_argument("--jitter", type=float, default=4.0, help="额外随机等待秒数上限；默认 0-4 秒随机抖动。")
    parser.add_argument("--fast", action="store_true", help="允许低于 5 秒的等待间隔；一般不建议。")
    parser.add_argument("--log", type=Path, default=None)
    return parser.parse_args()


def configure_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")


def load_library(index_path: Path) -> dict:
    if not index_path.exists():
        raise SystemExit(f"找不到资料库索引: {index_path}")
    return json.loads(index_path.read_text(encoding="utf-8"))


def ensure_actor_movie_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS actor_movies (
          person_id TEXT NOT NULL,
          person_name TEXT NOT NULL,
          javdb_actor_id TEXT,
          actor_url TEXT NOT NULL,
          code TEXT NOT NULL,
          code_key TEXT NOT NULL,
          title TEXT,
          detail_url TEXT,
          image_url TEXT,
          release_date TEXT,
          rating REAL,
          rating_count INTEGER,
          page_index INTEGER,
          position_index INTEGER,
          fetched_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(person_id, code_key)
        )
        """
    )
    for column, definition in (
        ("code_key", "TEXT"),
        ("release_date", "TEXT"),
        ("rating", "REAL"),
        ("rating_count", "INTEGER"),
        ("has_magnet", "INTEGER"),
        ("is_streamable", "INTEGER"),
        ("has_subtitles", "INTEGER"),
        ("javdb_tags_json", "TEXT"),
        ("page_index", "INTEGER"),
        ("position_index", "INTEGER"),
    ):
        ensure_column(conn, "actor_movies", column, definition)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_actor_movies_person_id ON actor_movies(person_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_actor_movies_code_key ON actor_movies(code_key)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_actor_movies_actor_url ON actor_movies(actor_url)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_movies_person_code_key ON actor_movies(person_id, code_key)")


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    if not any(row[1] == column for row in rows):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def source_prefixes(args: argparse.Namespace) -> list[str]:
    return args.source_prefix or DEFAULT_SOURCE_PREFIXES


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


def person_matches_source(person: dict, prefixes: list[str]) -> bool:
    paths = [person.get("relativePath") or "", *(person.get("sourcePaths") or [])]
    return any(source_path_matches(path, prefix) for path in paths for prefix in prefixes)


def is_special_person(person: dict) -> bool:
    name = str(person.get("name") or "").strip()
    return not name or name in SKIP_PERSON_NAMES or bool(re.fullmatch(r"\[[^\]]*]", name))


def scoped_people(library: dict, args: argparse.Namespace) -> list[dict]:
    person_ids = set(args.person_id or [])
    names = [normalize_name(name) for name in (args.name or []) if name]
    prefixes = source_prefixes(args)
    people = []
    for person in library.get("people", []):
        if not args.all_sources and not person_matches_source(person, prefixes):
            continue
        if not args.include_special and is_special_person(person):
            continue
        if person_ids and person.get("id") not in person_ids:
            continue
        if names and not any(name in normalize_name(person.get("name")) for name in names):
            continue
        people.append(person)
    people.sort(key=lambda item: (-int(item.get("workCount") or 0), str(item.get("name") or "")))
    return people


def parse_actor_spec(value: str) -> ActorSpec:
    if "=" not in value:
        return ActorSpec(url=value.strip())
    left, url = value.split("=", 1)
    left = left.strip()
    url = url.strip()
    if left.startswith("p_"):
        return ActorSpec(url=url, person_id=left)
    return ActorSpec(url=url, name=left)


def resolve_actor_specs(conn: sqlite3.Connection, people: list[dict], raw_specs: list[str]) -> list[dict]:
    specs = [parse_actor_spec(value) for value in raw_specs]
    if not specs:
        return []

    people_by_id = {person.get("id"): person for person in people}
    people_by_name = {normalize_name(person.get("name")): person for person in people}
    jobs = []
    for spec in specs:
        actor_id = actor_id_from_url(spec.url)
        person = None
        if spec.person_id:
            person = people_by_id.get(spec.person_id)
        if not person and spec.name:
            person = people_by_name.get(normalize_name(spec.name)) or find_unique_name(people, spec.name)
        if not person:
            row = conn.execute(
                """
                SELECT person_id
                FROM actor_profiles
                WHERE javdb_actor_id = ? OR javdb_url = ?
                """,
                (actor_id, spec.url),
            ).fetchone()
            if row:
                person = people_by_id.get(row[0])
        if not person:
            raise SystemExit(f"无法把 actor URL 映射到 G 盘人物，请用 NAME=URL 或 PERSON_ID=URL: {spec.url}")
        jobs.append({"person": person, "actor_url": canonical_actor_url(spec.url), "actor_cached_ok": actor_cached_ok(conn, person.get("id"))})
    return dedupe_jobs(jobs)


def actor_specs_from_cache(conn: sqlite3.Connection, people: list[dict]) -> list[dict]:
    people_by_id = {person.get("id"): person for person in people}
    rows = conn.execute(
        """
        SELECT person_id, javdb_url
        FROM actor_profiles
        WHERE status = 'ok' AND javdb_url IS NOT NULL AND javdb_url != ''
        """
    ).fetchall()
    jobs = []
    for person_id, javdb_url in rows:
        person = people_by_id.get(person_id)
        if person and javdb_url:
            jobs.append({"person": person, "actor_url": canonical_actor_url(javdb_url), "actor_cached_ok": actor_cached_ok(conn, person_id)})
    return dedupe_jobs(jobs)


def dedupe_jobs(jobs: list[dict]) -> list[dict]:
    seen = set()
    output = []
    for job in jobs:
        key = job["person"].get("id")
        if key in seen:
            continue
        seen.add(key)
        output.append(job)
    return output


def actor_cached_ok(conn: sqlite3.Connection, person_id: str) -> bool:
    row = conn.execute(
        """
        SELECT status, javdb_url, avatar_url, avatar_blob
        FROM actor_profiles
        WHERE person_id = ?
        """,
        (person_id,),
    ).fetchone()
    return bool(row and row[0] == "ok" and row[1] and (row[3] or is_actor_avatar_url(row[2] or "")))


def build_actor_jobs(conn: sqlite3.Connection, jobs: list[dict], people: list[dict], works_by_id: dict[str, dict], args: argparse.Namespace) -> list[dict]:
    info_rows = {
        row[0]: {"rating": row[1], "status": row[2]}
        for row in conn.execute("SELECT work_id, rating, status FROM work_info").fetchall()
    }
    cover_ids = {
        row[0]
        for row in conn.execute("SELECT work_id FROM work_covers WHERE cover_blob IS NOT NULL").fetchall()
    }

    for job in jobs:
        person = job["person"]
        targets = []
        for work_id in person.get("works") or []:
            work = works_by_id.get(work_id)
            if not work:
                continue
            target = build_target(work, person, info_rows, cover_ids, args)
            if target:
                targets.append(target)
        targets.sort(key=lambda item: item.code)
        job["targets"] = targets

    return [job for job in jobs if job.get("targets") or args.refresh_actor or args.actor_movies_only]


def build_target(work: dict, person: dict, info_rows: dict, cover_ids: set[str], args: argparse.Namespace) -> WorkTarget | None:
    code = extract_work_code(work)
    if not code:
        return None

    info_row = info_rows.get(work.get("id"))
    has_rating = bool(info_row and info_row.get("status") == "ok" and info_row.get("rating") is not None)
    has_cover = bool(work.get("coverId") or work.get("id") in cover_ids)

    needs_info = args.refresh or not has_rating
    needs_cover = args.refresh or not has_cover

    if args.mode == "info":
        keep = needs_info
        needs_cover = False
    elif args.mode == "cover":
        keep = needs_cover
        needs_info = False
    elif args.mode == "both":
        keep = needs_info and needs_cover
    else:
        keep = needs_info or needs_cover

    if not keep:
        return None
    return WorkTarget(work=work, person=person, code=code, needs_info=needs_info, needs_cover=needs_cover)


def print_job_summary(jobs: list[dict]) -> None:
    print(f"人物: {len(jobs)}")
    print(f"待补作品: {sum(len(job.get('targets') or []) for job in jobs)}")
    print(f"缺评分/资料: {sum(1 for job in jobs for target in job.get('targets') or [] if target.needs_info)}")
    print(f"缺封面: {sum(1 for job in jobs for target in job.get('targets') or [] if target.needs_cover)}")
    for job in jobs[:30]:
        person = job["person"]
        targets = job.get("targets") or []
        print(f"\n{person.get('name')} -> {job['actor_url']} ({len(targets)} targets)")
        for target in targets[:12]:
            flags = []
            if target.needs_info:
                flags.append("rating")
            if target.needs_cover:
                flags.append("cover")
            print(f"  {target.code:14} {'+'.join(flags):13} {target.work.get('title')}")
        if len(targets) > 12:
            print(f"  ... +{len(targets) - 12}")


def crawl_actor_movies(client: JavDbClient, conn: sqlite3.Connection, person: dict, actor_url: str, args: argparse.Namespace) -> ActorMovieCrawl:
    driver = client.get_driver()
    seen_pages = set()
    seen_codes = set()
    existing_codes = existing_actor_movie_code_keys(conn, person) if incremental_actor_movies(args) else set()
    page_url = canonical_actor_url(actor_url)
    all_movies = []
    first_html = ""
    first_profile = {}
    duplicate_count = 0
    stopped_on_existing = False

    page_limit = max(0, int(args.max_pages or 0))
    page_index = 0
    while True:
        if page_limit and page_index >= page_limit:
            break
        if page_url in seen_pages:
            break
        page_index += 1
        seen_pages.add(page_url)
        safe_driver_get(driver, page_url, args.actor_wait_seconds)
        html = wait_for_actor_page(client, args.actor_wait_seconds)
        if not first_html:
            first_html = html
            first_profile = parse_actor_page(html, page_url)
            if not first_profile.get("javdb_url"):
                first_profile["javdb_url"] = canonical_actor_url(actor_url)
            if not first_profile.get("javdb_actor_id"):
                first_profile["javdb_actor_id"] = actor_id_from_url(actor_url)

        page_movies = dedupe_actor_movies(parse_actor_movies(html, driver.current_url, page_index))
        for movie in page_movies:
            key = (loose_code_key(movie.code) or "").lower()
            if not key:
                continue
            if key in existing_codes:
                duplicate_count += 1
                stopped_on_existing = True
                continue
            if key not in seen_codes:
                seen_codes.add(key)
                all_movies.append(movie)

        if stopped_on_existing and incremental_actor_movies(args):
            break

        next_url = next_actor_page_url(html, driver.current_url)
        if not next_url:
            break
        page_url = next_url
        pause(args)

    return ActorMovieCrawl(
        html=first_html,
        profile=first_profile,
        movies=all_movies,
        duplicate_count=duplicate_count,
        scanned_pages=page_index,
        stopped_on_existing=stopped_on_existing,
    )


def incremental_actor_movies(args: argparse.Namespace) -> bool:
    return bool(getattr(args, "incremental_actor_movies", False))


def existing_actor_movie_code_keys(conn: sqlite3.Connection, person: dict) -> set[str]:
    person_id = person.get("id") or ""
    if not person_id:
        return set()
    rows = conn.execute("SELECT code_key FROM actor_movies WHERE person_id = ?", (person_id,)).fetchall()
    return {str(row[0] or "").strip().lower() for row in rows if row and row[0]}


def dedupe_actor_movies(movies: list[ActorMovie]) -> list[ActorMovie]:
    seen = set()
    output = []
    for movie in movies:
        key = (loose_code_key(movie.code) or "").lower()
        if not key or key in seen:
            continue
        seen.add(key)
        output.append(movie)
    return output


def wait_for_actor_page(client: JavDbClient, wait_seconds: int) -> str:
    driver = client.get_driver()
    deadline = time.time() + wait_seconds
    last_html = ""
    while time.time() < deadline:
        last_html = driver.page_source or ""
        reason = blocked_reason(last_html, driver.current_url)
        if reason:
            raise AccessBlockedError(reason)
        if parse_actor_movies(last_html, driver.current_url) or parse_actor_page(last_html, driver.current_url).get("display_name"):
            return last_html
        time.sleep(1.0)
    return last_html


def safe_driver_get(driver, url: str, timeout_seconds: int) -> None:
    timeout = max(5, int(timeout_seconds or 5))
    driver.set_page_load_timeout(timeout)
    try:
        driver.get(url)
    except TimeoutException:
        try:
            driver.execute_script("window.stop();")
        except Exception:
            pass


def parse_actor_movies(html: str, base_url: str, page_index: int = 0) -> list[ActorMovie]:
    soup = BeautifulSoup(html or "", "html.parser")
    movies = []
    seen = set()
    for position_index, item in enumerate(soup.select(".movie-list .item, .movie-panel, .item"), 1):
        link = item.select_one("a.box[href], a[href*='/v/']")
        href = link.get("href") if link else ""
        if not href:
            continue
        strong = item.select_one("strong")
        title_tag = item.select_one(".video-title, .title")
        text = item.get_text(" ", strip=True)
        raw_code = strong.get_text(" ", strip=True) if strong else text
        code = normalize_code(raw_code)
        if not code:
            code = normalize_code(text)
        if not code:
            continue
        key = loose_code_key(code)
        if key in seen:
            continue
        seen.add(key)
        image = item.select_one("img.video-cover, img.cover, img")
        image_src = image.get("src") or image.get("data-src") or image.get("data-original") if image else ""
        image_url = urljoin(base_url, image_src) if image_src else ""
        title = title_tag.get_text(" ", strip=True) if title_tag else text
        facts = parse_actor_movie_facts(item)
        movies.append(
            ActorMovie(
                code=code,
                title=title,
                detail_url=urljoin(base_url, href),
                image_url=image_url,
                release_date=facts["release_date"],
                rating=facts["rating"],
                rating_count=facts["rating_count"],
                has_magnet=facts["has_magnet"],
                is_streamable=facts["is_streamable"],
                has_subtitles=facts["has_subtitles"],
                tags=facts["tags"],
                page_index=page_index,
                position_index=position_index,
            )
        )
    return movies


def parse_actor_movie_facts(item) -> dict:
    text = item.get_text(" ", strip=True)
    date_match = re.search(r"\b(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})\b", text)
    release_date = ""
    if date_match:
        parts = re.split(r"[-/.]", date_match.group(1))
        release_date = f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"

    rating = None
    rating_count = None
    rating_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*分", text)
    if rating_match:
        try:
            rating = float(rating_match.group(1))
        except ValueError:
            rating = None

    count_match = re.search(r"由\s*([\d,]+)\s*人", text)
    if count_match:
        try:
            rating_count = int(count_match.group(1).replace(",", ""))
        except ValueError:
            rating_count = None

    tags = parse_actor_movie_tags(item, text)
    combined = " ".join(tags)
    has_magnet = any("磁" in tag or "magnet" in tag.lower() for tag in tags)
    is_streamable = any("可播放" in tag or "播放" == tag or "stream" in tag.lower() for tag in tags)
    has_subtitles = bool(re.search(r"(?:中字|字幕|中文)", combined, flags=re.I))

    return {
        "release_date": release_date,
        "rating": rating,
        "rating_count": rating_count,
        "has_magnet": has_magnet if has_magnet or tags else None,
        "is_streamable": is_streamable if is_streamable or tags else None,
        "has_subtitles": has_subtitles if has_subtitles or tags else None,
        "tags": tags,
    }


def parse_actor_movie_tags(item, text: str) -> list[str]:
    raw_tags = []
    selectors = [
        ".tags .tag",
        ".tag",
        ".label",
        ".button",
        ".meta .tag",
        ".video-meta .tag",
        "[class*='tag']",
        "[class*='label']",
    ]
    for selector in selectors:
        for tag in item.select(selector):
            value = normalize_spaces(tag.get_text(" ", strip=True))
            if value:
                raw_tags.append(value)

    patterns = [
        r"含中文字幕磁链",
        r"含中文字幕磁鏈",
        r"含中文磁链",
        r"含中文磁鏈",
        r"中文字幕磁链",
        r"中文磁链",
        r"中文字幕磁鏈",
        r"中文磁鏈",
        r"含中字磁链",
        r"中字磁链",
        r"中字磁鏈",
        r"含磁链",
        r"含磁鏈",
        r"中字可播放",
        r"中文字幕可播放",
        r"可播放",
        r"含字幕",
        r"中文字幕",
        r"中字",
        r"字幕",
        r"无码",
        r"無碼",
        r"有码",
        r"有碼",
        r"VR",
        r"單體作品",
        r"单体作品",
    ]
    for value in re.findall("|".join(f"(?:{pattern})" for pattern in patterns), text or "", flags=re.I):
        raw_tags.append(normalize_spaces(value))

    output = []
    seen = set()
    for tag in raw_tags:
        clean = normalize_spaces(tag)
        if not clean or len(clean) > 20:
            continue
        key = clean.lower()
        if key in seen:
            continue
        seen.add(key)
        output.append(clean)
    return output[:12]


def normalize_spaces(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def next_actor_page_url(html: str, base_url: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    base_actor_id = actor_id_from_url(base_url)
    candidates = []
    selectors = [
        "a[rel='next'][href]",
        "a.pagination-next[href]",
        ".pagination-next a[href]",
        "a[aria-label*='Next'][href]",
        "a[aria-label*='下一'][href]",
    ]
    for selector in selectors:
        candidates.extend(soup.select(selector))
    for link in soup.select("a[href]"):
        text = link.get_text(" ", strip=True)
        classes = " ".join(link.get("class") or [])
        if text in {"下一頁", "下一页", "›", "»", "Next"} or "pagination-next" in classes:
            candidates.append(link)
    for link in candidates:
        href = link.get("href")
        if href and not link.has_attr("disabled") and "disabled" not in (link.get("class") or []):
            next_url = urljoin(base_url, href)
            if base_actor_id and actor_id_from_url(next_url) != base_actor_id:
                continue
            return next_url
    return ""


def save_actor_movies(
    conn: sqlite3.Connection,
    person: dict,
    actor_url: str,
    actor_profile: dict,
    movies: list[ActorMovie],
    replace: bool = True,
) -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    person_id = person.get("id") or ""
    actor_id = actor_profile.get("javdb_actor_id") or actor_id_from_url(actor_url)
    saved = 0

    if replace:
        conn.execute("DELETE FROM actor_movies WHERE person_id = ?", (person_id,))

    for movie in movies:
        code = normalize_code(movie.code) or movie.code
        code_key = loose_code_key(code).lower()
        if not code_key:
            continue
        conn.execute(
            """
            INSERT INTO actor_movies (
              person_id, person_name, javdb_actor_id, actor_url, code, code_key, title,
              detail_url, image_url, release_date, rating, rating_count,
              has_magnet, is_streamable, has_subtitles, javdb_tags_json,
              page_index, position_index,
              fetched_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(person_id, code_key) DO UPDATE SET
              person_name = excluded.person_name,
              javdb_actor_id = excluded.javdb_actor_id,
              actor_url = excluded.actor_url,
              code = excluded.code,
              title = excluded.title,
              detail_url = excluded.detail_url,
              image_url = excluded.image_url,
              release_date = excluded.release_date,
              rating = excluded.rating,
              rating_count = excluded.rating_count,
              has_magnet = excluded.has_magnet,
              is_streamable = excluded.is_streamable,
              has_subtitles = excluded.has_subtitles,
              javdb_tags_json = excluded.javdb_tags_json,
              page_index = excluded.page_index,
              position_index = excluded.position_index,
              updated_at = excluded.updated_at
            """,
            (
                person_id,
                person.get("name") or "",
                actor_id,
                canonical_actor_url(actor_url),
                code,
                code_key,
                movie.title,
                movie.detail_url,
                movie.image_url,
                movie.release_date or None,
                movie.rating,
                movie.rating_count,
                db_bool(movie.has_magnet),
                db_bool(movie.is_streamable),
                db_bool(movie.has_subtitles),
                tags_json(movie.tags),
                movie.page_index or None,
                movie.position_index or None,
                now,
                now,
            ),
        )
        saved += 1

    return saved


def db_bool(value: bool | None) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def tags_json(tags: list[str]) -> str | None:
    clean = [normalize_spaces(tag) for tag in tags or [] if normalize_spaces(tag)]
    return json.dumps(clean, ensure_ascii=False) if clean else None


def process_targets(
    conn: sqlite3.Connection,
    client: JavDbClient,
    person: dict,
    targets: list[WorkTarget],
    movie_by_code: dict[str, ActorMovie],
    args: argparse.Namespace,
    stats: dict,
    log_path: Path,
) -> None:
    for index, target in enumerate(targets, 1):
        movie = find_movie(target.code, movie_by_code)
        if not movie:
            stats["miss"] += 1
            write_jsonl(log_path, result_payload("miss", target, {"reason": "not found on actor page"}))
            print(f"  [{index}/{len(targets)}] MISS {target.code} actor页没找到", flush=True)
            continue

        try:
            meta = metadata_from_movie(client, movie, target, args)
            cover_bytes = b""
            cover_mime = ""
            if target.needs_cover and meta.image_url:
                cover_bytes, cover_mime = client.download_image(meta.image_url, meta.detail_url)

            if args.write:
                if not args.no_cache_images:
                    cache_meta_image(conn, client, meta, cover_bytes, cover_mime, stats)
                if target.needs_info:
                    upsert_work_info(conn, target, meta)
                    stats["written_info"] += 1
                if target.needs_cover and cover_bytes:
                    upsert_work_cover(conn, target, meta, cover_bytes, cover_mime)
                    stats["written_cover"] += 1
                file_result = write_sidecar_files(target, meta, cover_bytes, cover_mime, args)
                stats["written_info_files"] += int(bool(file_result.get("infoPath")))
                stats["written_cover_files"] += int(bool(file_result.get("coverPath")))
                stats["file_errors"] += int(bool(file_result.get("error")))
                conn.commit()
            else:
                file_result = {}

            write_jsonl(
                log_path,
                result_payload(
                    "ok",
                    target,
                    {
                        "javdbUrl": meta.detail_url,
                        "rating": meta.rating,
                        "ratingCount": meta.rating_count,
                        "imageUrl": meta.image_url,
                        "coverBytes": len(cover_bytes),
                        "infoPath": file_result.get("infoPath", ""),
                        "coverPath": file_result.get("coverPath", ""),
                        "fileError": file_result.get("error", ""),
                        "write": args.write,
                    },
                ),
            )
            stats["ok"] += 1
            print(
                f"  [{index}/{len(targets)}] OK {target.code} "
                f"rating={meta.rating if meta.rating is not None else '-'} "
                f"cover={'Y' if cover_bytes else '-'} {meta.title[:70]}",
                flush=True,
            )
        except Exception as error:
            stats["error"] += 1
            write_jsonl(log_path, result_payload("error", target, {"error": str(error), "javdbUrl": movie.detail_url}))
            print(f"  [{index}/{len(targets)}] ERROR {target.code}: {error}", flush=True)
        pause(args)


def image_session(client: JavDbClient) -> requests.Session:
    session = requests.Session()
    session.cookies = client.browser_cookies()
    session.headers.update({"User-Agent": client.user_agent()})
    return session


def cache_meta_image(
    conn: sqlite3.Connection,
    client: JavDbClient,
    meta: JavDbMeta,
    cover_bytes: bytes,
    cover_mime: str,
    stats: dict,
) -> None:
    urls = []
    if meta.image_url:
        if cover_bytes:
            if upsert_remote_image(conn, meta.image_url, cover_bytes, cover_mime):
                stats["images_cached"] += 1
        else:
            urls.append(meta.image_url)
    urls.extend((meta.preview_images or [])[:12])
    if not urls:
        return

    image_stats = cache_remote_images(conn, urls, session=image_session(client), referer=meta.detail_url)
    stats["images_cached"] += image_stats["cached"]
    stats["images_skipped"] += image_stats["skipped"]
    stats["images_failed"] += image_stats["failed"]


def metadata_from_movie(client: JavDbClient, movie: ActorMovie, target: WorkTarget, args: argparse.Namespace) -> JavDbMeta:
    if target.needs_info or not movie.image_url:
        driver = client.get_driver()
        safe_driver_get(driver, movie.detail_url, args.detail_wait_seconds)
        detail_html = client.wait_for(
            lambda html: BeautifulSoup(html, "html.parser").select_one("h2.title, img.video-cover"),
            args.detail_wait_seconds,
        )
        return parse_detail_page(detail_html, driver.current_url, driver.title or "", fallback_code=target.code)

    return JavDbMeta(
        code=target.code,
        title=movie.title or target.work.get("title") or target.code,
        detail_url=movie.detail_url,
        image_url=movie.image_url,
        actors=[target.person.get("name")] if target.person else [],
    )


def write_sidecar_files(target: WorkTarget, meta: JavDbMeta, cover_bytes: bytes, cover_mime: str, args: argparse.Namespace) -> dict:
    if args.no_write_files:
        return {}

    folder = work_folder_path(target.work)
    if not folder:
        return {"error": "作品路径不是本机绝对路径"}
    if not folder.exists() or not folder.is_dir():
        return {"error": f"作品文件夹不存在: {folder}"}

    result = {}
    try:
        if target.needs_info:
            info_path = choose_info_path(folder, args.overwrite_files)
            if info_path:
                info_path.write_text(render_raw_text(meta) + "\n", encoding="utf-8")
                result["infoPath"] = str(info_path)

        if target.needs_cover and cover_bytes:
            cover_path = choose_cover_path(folder, cover_mime, meta.image_url, args.overwrite_files)
            if cover_path:
                cover_path.write_bytes(cover_bytes)
                result["coverPath"] = str(cover_path)
    except OSError as error:
        result["error"] = str(error)
    return result


def is_browser_startup_error(error: Exception) -> bool:
    text = str(error).lower()
    return "session not created" in text or "chrome instance exited" in text or "user data directory is already in use" in text


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


def find_movie(code: str, movie_by_code: dict[str, ActorMovie]) -> ActorMovie | None:
    key = loose_code_key(code)
    for movie_code, movie in movie_by_code.items():
        movie_key = loose_code_key(movie_code)
        if movie_key == key or (key and (key in movie_key or movie_key in key)):
            return movie
    return None


def result_payload(status: str, target: WorkTarget, extra: dict) -> dict:
    return {
        "status": status,
        "personId": target.person.get("id") if target.person else "",
        "personName": target.person.get("name") if target.person else "",
        "workId": target.work.get("id"),
        "code": target.code,
        "title": target.work.get("title"),
        "needsInfo": target.needs_info,
        "needsCover": target.needs_cover,
        **extra,
    }


def save_actor_profile_without_avatar(conn: sqlite3.Connection, person: dict, profile: dict) -> None:
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    conn.execute(
        """
        INSERT INTO actor_profiles (
          person_id, person_name, javdb_actor_id, javdb_url, display_name, aliases_json,
          movie_count, avatar_url, avatar_mime, avatar_blob, source, status, error, fetched_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'javdb', 'ok', NULL, ?, ?)
        ON CONFLICT(person_id) DO UPDATE SET
          person_name = excluded.person_name,
          javdb_actor_id = excluded.javdb_actor_id,
          javdb_url = excluded.javdb_url,
          display_name = excluded.display_name,
          aliases_json = excluded.aliases_json,
          movie_count = excluded.movie_count,
          avatar_url = COALESCE(excluded.avatar_url, actor_profiles.avatar_url),
          source = excluded.source,
          status = excluded.status,
          error = excluded.error,
          fetched_at = excluded.fetched_at,
          updated_at = excluded.updated_at
        """,
        (
            person["id"],
            person["name"],
            profile.get("javdb_actor_id") or actor_id_from_url(profile.get("javdb_url", "")),
            profile.get("javdb_url"),
            profile.get("display_name") or person["name"],
            json.dumps(profile.get("aliases") or [], ensure_ascii=False),
            profile.get("movie_count"),
            profile.get("avatar_url") or None,
            now,
            now,
        ),
    )


def normalize_name(value: str | None) -> str:
    return re.sub(r"[\s\[\]【】()（）._-]+", "", str(value or "")).lower()


def find_unique_name(people: list[dict], value: str) -> dict | None:
    target = normalize_name(value)
    matches = [person for person in people if target and target in normalize_name(person.get("name"))]
    return matches[0] if len(matches) == 1 else None


def canonical_actor_url(value: str) -> str:
    actor_id = actor_id_from_url(value)
    return f"https://javdb.com/actors/{actor_id}" if actor_id else value


def write_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def pause(args: argparse.Namespace) -> None:
    base_sleep = max(0.0, float(args.sleep or 0))
    if not args.fast and base_sleep < 5.0:
        base_sleep = 5.0
    jitter = random.uniform(0, max(0.0, float(args.jitter or 0)))
    total_sleep = base_sleep + jitter
    if total_sleep > 0:
        time.sleep(total_sleep)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("已中断", file=sys.stderr)
