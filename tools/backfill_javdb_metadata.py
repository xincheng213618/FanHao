import argparse
import base64
import hashlib
import json
import mimetypes
import random
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from code_parser import loose_code_key, normalize_code
from javdb_card_facts import parse_javdb_rating_facts
from remote_image_cache import cache_remote_images, ensure_remote_image_schema, upsert_remote_image


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "data" / "actor-profiles.sqlite"
DEFAULT_LIBRARY_INDEX = PROJECT_ROOT / "data" / "library-index.json"
DEFAULT_LOG_DIR = PROJECT_ROOT / "data"
DEFAULT_SCRAPER_CONFIG_PATH = PROJECT_ROOT / "tools" / "scrapers" / "javdb.json"
DEFAULT_SHARED_PROFILE = Path(r"C:\Users\17917\Desktop\Tool\data\selenium_user_data")
DEFAULT_CHROME_BINARY = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
DEFAULT_WDM_CHROMEDRIVER_ROOT = Path.home() / ".wdm" / "drivers" / "chromedriver" / "win64"
JAVDB_PERSISTENT_COOKIES = [
    {"domain": "javdb.com", "name": "over18", "value": "1", "path": "/", "secure": False, "http_only": False, "expires": 2147483647},
    {"domain": "javdb.com", "name": "comment_warning", "value": "1", "path": "/", "secure": False, "http_only": False, "expires": 2147483647},
    {"domain": "javdb.com", "name": "locale", "value": "zh", "path": "/", "secure": False, "http_only": False, "expires": 2147483647},
]
JAVDB_SEARCH_URL = "https://javdb.com/search?q={query}&f=all"
SOURCE_NAME = "javdb-backfill"
BAD_CODE_PREFIXES = {"DIR", "FILE", "IMG", "IMAGE", "VIDEO"}
DEFAULT_SOURCE_PREFIXES = ["G:/"]
DEFAULT_SCRAPER_CONFIG = {
    "searchItemSelectors": [".movie-list .item", ".movie-panel", ".item"],
    "searchLinkSelectors": ["a.box[href]", "a[href*='/v/']"],
    "searchCodeSelectors": ["strong"],
    "searchTitleSelectors": [".video-title", ".title"],
    "detailReadySelectors": ["h2.title", "img.video-cover", "img.cover", ".cover img"],
    "titleSelectors": ["h2.title"],
    "coverSelectors": ["img.video-cover", "img.cover", ".cover img"],
    "labels": {
        "actors": ["演員:", "演员:"],
        "tags": ["類別:", "类别:"],
        "rating": ["評分:", "评分:"],
        "duration": ["時長:", "时长:"],
        "releaseDate": ["日期:", "發行日期:", "发行日期:"],
        "director": ["導演:", "导演:"],
        "maker": ["片商:", "製作商:", "制作商:"],
        "label": ["發行商:", "发行商:"],
        "series": ["系列:"],
    },
    "previewImageSelectors": [
        ".preview-images img",
        ".sample-images img",
        ".tile-images img",
        ".screenshots img",
        ".preview-panel img",
        ".video-samples img",
        ".preview img",
        "a[href*='/samples/'] img",
        "a[href*='/thumbs/'] img",
        "img[src*='/samples/']",
        "img[src*='/thumbs/']",
    ],
    "previewImageAttributes": ["data-src", "data-original", "src"],
    "previewImageSkipContains": ["/avatars/", "logo"],
    "previewVideoSelectors": ["video source[src]", "video[src]", "a[href*='.mp4']", "a[href*='.webm']", "a[href*='.m3u8']"],
    "previewVideoAttributes": ["src", "href"],
}


@dataclass
class WorkTarget:
    work: dict
    person: dict | None
    code: str
    needs_info: bool
    needs_cover: bool
    detail_url: str = ""


@dataclass
class JavDbMeta:
    code: str
    title: str
    detail_url: str
    release_date: str = ""
    duration_text: str = ""
    duration_minutes: int | None = None
    rating_text: str = ""
    rating: float | None = None
    rating_count: int | None = None
    director: str = ""
    maker: str = ""
    label: str = ""
    series: str = ""
    image_url: str = ""
    preview_images: list[str] | None = None
    preview_video_url: str = ""
    actors: list[str] | None = None
    tags: list[str] | None = None
    actor_links: list[dict] | None = None
    tag_links: list[dict] | None = None
    maker_url: str = ""
    label_url: str = ""
    series_url: str = ""


class AccessBlockedError(RuntimeError):
    pass


def main() -> None:
    configure_stdout()
    args = parse_args()
    args.scraper_config_data = load_scraper_config(args.scraper_config)
    library = load_library(args.library_index)
    people_by_id = {person.get("id"): person for person in library.get("people", [])}
    works = library.get("works", [])

    with sqlite3.connect(args.db) as conn:
        ensure_schema(conn)
        targets = build_targets(conn, works, people_by_id, args)

    if args.list_missing:
        print_target_summary(targets)
        return

    if args.limit:
        targets = targets[: args.limit]

    log_path = args.log or DEFAULT_LOG_DIR / f"javdb-backfill-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    print(
        f"补全开始: targets={len(targets)} write={args.write} "
        f"info={sum(1 for t in targets if t.needs_info)} cover={sum(1 for t in targets if t.needs_cover)} log={log_path}",
        flush=True,
    )
    if not args.write:
        print("当前是 dry-run：会访问 JavDB 验证解析，但不会写入数据库。真正写入请加 --write。", flush=True)

    client = JavDbClient(args)
    stats = {
        "ok": 0,
        "skip": 0,
        "miss": 0,
        "error": 0,
        "blocked": 0,
        "written_info": 0,
        "written_cover": 0,
        "images_cached": 0,
        "images_skipped": 0,
        "images_failed": 0,
    }
    try:
        with sqlite3.connect(args.db, timeout=30) as conn:
            ensure_schema(conn)
            ensure_remote_image_schema(conn)
            for index, target in enumerate(targets, 1):
                try:
                    meta = client.fetch_by_code(target.code, target.detail_url)
                    if not meta:
                        stats["miss"] += 1
                        write_jsonl(log_path, result_payload("miss", target, {"reason": "no exact JavDB match"}))
                        print(f"[{index}/{len(targets)}] MISS {target.code} {target.work.get('title')}", flush=True)
                        pause(args)
                        continue

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
                        conn.commit()

                    stats["ok"] += 1
                    write_jsonl(
                        log_path,
                        result_payload(
                            "ok",
                            target,
                            {
                                "javdbUrl": meta.detail_url,
                                "title": meta.title,
                                "imageUrl": meta.image_url,
                                "coverBytes": len(cover_bytes),
                                "write": args.write,
                            },
                        ),
                    )
                    print(
                        f"[{index}/{len(targets)}] OK {target.code} "
                        f"info={'Y' if target.needs_info else '-'} cover={'Y' if target.needs_cover and cover_bytes else '-'} "
                        f"{meta.title[:80]}",
                        flush=True,
                    )
                except AccessBlockedError as error:
                    stats["blocked"] += 1
                    write_jsonl(log_path, result_payload("blocked", target, {"error": str(error)}))
                    print(f"[{index}/{len(targets)}] BLOCKED {target.code}: {error}", flush=True)
                    break
                except Exception as error:
                    stats["error"] += 1
                    write_jsonl(log_path, result_payload("error", target, {"error": str(error)}))
                    print(f"[{index}/{len(targets)}] ERROR {target.code}: {error}", flush=True)
                pause(args)
    finally:
        client.close()

    print("补全结束: " + json.dumps(stats, ensure_ascii=False), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill missing JavDB info and covers into FanHao SQLite cache.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--library-index", type=Path, default=DEFAULT_LIBRARY_INDEX)
    parser.add_argument("--profile-dir", type=Path, default=DEFAULT_SHARED_PROFILE)
    parser.add_argument("--chrome-binary", type=Path, default=DEFAULT_CHROME_BINARY)
    parser.add_argument("--driver-path", type=Path, default=None)
    parser.add_argument("--cookie-profile-dir", type=Path, default=None, help="从 Chromium/115Chrome User Data 读取 Cookie 并注入当前 Selenium。")
    parser.add_argument("--cookie-profile-name", default="Default", help="Cookie 所在的 Chromium profile，默认 Default。")
    parser.add_argument("--cookie-domain", action="append", default=[], help="只注入这些域名的 Cookie；默认 javdb.com。可重复。")
    parser.add_argument("--cookie-cache", type=Path, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--proxy", default="http://127.0.0.1:10809")
    parser.add_argument("--no-proxy", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--write", action="store_true", help="实际写入数据库；不加时为 dry-run")
    parser.add_argument("--refresh", action="store_true", help="忽略现有数据库缓存，重新抓取并覆盖")
    parser.add_argument("--mode", choices=["missing", "info", "cover", "both"], default="missing")
    parser.add_argument("--list-missing", action="store_true", help="只统计缺失项，不访问网络")
    parser.add_argument("--no-cache-images", action="store_true", help="只写 work_info/work_covers，不同步封面/预览图到 remote_image_cache。")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--code", action="append", default=[], help="只处理指定番号，可重复")
    parser.add_argument("--work-id", action="append", default=[], help="只处理指定 work_id，可重复")
    parser.add_argument("--person-id", action="append", default=[], help="只处理指定 person_id，可重复")
    parser.add_argument("--all-sources", action="store_true", help="处理所有来源；默认只处理 --source-prefix 指定来源。")
    parser.add_argument("--source-prefix", action="append", default=[], help="只处理这些本机路径前缀；可重复。默认 G:/。例：F:/ 或 O:/[珍藏]")
    parser.add_argument("--sleep", type=float, default=8.0, help="每次访问后的基础等待秒数；默认偏慢，避免触发风控。")
    parser.add_argument("--jitter", type=float, default=4.0, help="额外随机等待秒数上限。")
    parser.add_argument("--fast", action="store_true", help="允许低于 5 秒的等待间隔；一般不建议。")
    parser.add_argument("--search-wait-seconds", type=int, default=25)
    parser.add_argument("--detail-wait-seconds", type=int, default=35)
    parser.add_argument("--scraper-config", type=Path, default=DEFAULT_SCRAPER_CONFIG_PATH, help="JavDB selector/label 配置 JSON")
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


def load_scraper_config(config_path: Path) -> dict:
    config = merge_scraper_config(DEFAULT_SCRAPER_CONFIG, {})
    if not config_path:
        return config
    if not config_path.exists():
        return config
    try:
        loaded = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise SystemExit(f"JavDB scraper 配置无效: {config_path} ({error})")
    if not isinstance(loaded, dict):
        raise SystemExit(f"JavDB scraper 配置必须是 JSON object: {config_path}")
    return merge_scraper_config(config, loaded)


def merge_scraper_config(base: dict, override: dict) -> dict:
    merged = {}
    for key, value in base.items():
        if isinstance(value, dict):
            merged[key] = merge_scraper_config(value, {})
        elif isinstance(value, list):
            merged[key] = [*value]
        else:
            merged[key] = value
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge_scraper_config(merged[key], value)
        elif isinstance(value, list):
            merged[key] = [str(item) for item in value if str(item).strip()]
        else:
            merged[key] = value
    return merged


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS work_covers (
          work_id TEXT PRIMARY KEY,
          person_id TEXT NOT NULL,
          person_name TEXT NOT NULL,
          video_id TEXT,
          title TEXT,
          cover_url TEXT,
          cover_mime TEXT,
          cover_blob BLOB,
          source TEXT,
          fetched_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_work_covers_person_id ON work_covers(person_id);
        CREATE INDEX IF NOT EXISTS idx_work_covers_video_id ON work_covers(video_id);
        CREATE TABLE IF NOT EXISTS work_info (
          work_id TEXT PRIMARY KEY,
          person_id TEXT NOT NULL,
          person_name TEXT NOT NULL,
          source_info_id TEXT,
          source_name TEXT,
          source_path TEXT,
          source_size INTEGER,
          source_mtime TEXT,
          code TEXT,
          title TEXT,
          release_date TEXT,
          duration_minutes INTEGER,
          rating REAL,
          rating_count INTEGER,
          director TEXT,
          maker TEXT,
          label TEXT,
          series TEXT,
          javdb_url TEXT,
          image_url TEXT,
          preview_images_json TEXT,
          preview_video_url TEXT,
          actors_json TEXT,
          actor_links_json TEXT,
          tags_json TEXT,
          tag_links_json TEXT,
          maker_url TEXT,
          label_url TEXT,
          series_url TEXT,
          fields_json TEXT,
          raw_text TEXT,
          raw_truncated INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'ok',
          error TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_work_info_person_id ON work_info(person_id);
        CREATE INDEX IF NOT EXISTS idx_work_info_code ON work_info(code);
        CREATE INDEX IF NOT EXISTS idx_work_info_release_date ON work_info(release_date);
        CREATE INDEX IF NOT EXISTS idx_work_info_status ON work_info(status);
        """
    )
    ensure_column(conn, "work_info", "javdb_url", "TEXT")
    ensure_column(conn, "work_info", "preview_images_json", "TEXT")
    ensure_column(conn, "work_info", "preview_video_url", "TEXT")
    ensure_column(conn, "work_info", "actor_links_json", "TEXT")
    ensure_column(conn, "work_info", "tag_links_json", "TEXT")
    ensure_column(conn, "work_info", "maker_url", "TEXT")
    ensure_column(conn, "work_info", "label_url", "TEXT")
    ensure_column(conn, "work_info", "series_url", "TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_work_info_javdb_url ON work_info(javdb_url)")


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def build_targets(conn: sqlite3.Connection, works: list[dict], people_by_id: dict, args: argparse.Namespace) -> list[WorkTarget]:
    cover_ids = {
        row[0]
        for row in conn.execute("SELECT work_id FROM work_covers WHERE cover_blob IS NOT NULL").fetchall()
    }
    info_ids = {
        row[0]
        for row in conn.execute("SELECT work_id FROM work_info WHERE status = 'ok'").fetchall()
    }
    code_filter = {normalize_code(value) for value in args.code}
    work_id_filter = set(args.work_id)
    person_id_filter = set(args.person_id)
    prefixes = source_prefixes(args)

    targets = []
    for work in works:
        if not args.all_sources and not work_matches_source(work, prefixes):
            continue
        if work_id_filter and work.get("id") not in work_id_filter:
            continue
        if person_id_filter and work.get("personId") not in person_id_filter:
            continue

        code = extract_work_code(work)
        if not code or suspicious_code(code, work):
            continue
        if code_filter and code not in code_filter:
            continue

        has_local_info = bool(work.get("infos"))
        has_local_cover = bool(work.get("coverId"))
        has_db_info = work.get("id") in info_ids
        has_db_cover = work.get("id") in cover_ids
        needs_info = args.refresh or (not has_local_info and not has_db_info)
        needs_cover = args.refresh or (not has_local_cover and not has_db_cover)

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

        if keep:
            targets.append(
                WorkTarget(
                    work=work,
                    person=people_by_id.get(work.get("personId")),
                    code=code,
                    needs_info=needs_info,
                    needs_cover=needs_cover,
                    detail_url=cached_detail_url(conn, code),
                )
            )

    targets.sort(key=lambda item: (source_priority(item.work.get("relativePath")), item.code, item.work.get("title") or ""))
    return targets


def cached_detail_url(conn: sqlite3.Connection, code: str) -> str:
    code_key = loose_code_key(code)
    if not code_key:
        return ""

    queries = [
        ("SELECT javdb_url FROM work_info WHERE code = ? AND javdb_url IS NOT NULL AND javdb_url <> '' LIMIT 1", (code,)),
        ("SELECT detail_url FROM actor_movies WHERE code_key = ? AND detail_url IS NOT NULL AND detail_url <> '' LIMIT 1", (code_key,)),
        ("SELECT detail_url FROM javdb_rankings WHERE code_key = ? AND detail_url IS NOT NULL AND detail_url <> '' LIMIT 1", (code_key,)),
    ]
    for sql, params in queries:
        try:
            row = conn.execute(sql, params).fetchone()
        except sqlite3.Error:
            continue
        if row and row[0]:
            return str(row[0]).strip()
    return ""


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


def work_matches_source(work: dict, prefixes: list[str]) -> bool:
    return any(source_path_matches(work.get("relativePath") or "", prefix) for prefix in prefixes)


def print_target_summary(targets: list[WorkTarget]) -> None:
    print(f"待补作品: {len(targets)}")
    print(f"缺 info: {sum(1 for target in targets if target.needs_info)}")
    print(f"缺封面: {sum(1 for target in targets if target.needs_cover)}")
    print(f"二者都缺: {sum(1 for target in targets if target.needs_info and target.needs_cover)}")
    for target in targets[:30]:
        flags = []
        if target.needs_info:
            flags.append("info")
        if target.needs_cover:
            flags.append("cover")
        person_name = target.person.get("name") if target.person else target.work.get("personId")
        print(f"{target.code:14} {'+'.join(flags):10} {person_name} · {target.work.get('title')}")


def source_priority(value: str) -> int:
    path = str(value or "").replace("\\", "/").lower()
    if path.startswith("g:/"):
        return 0
    if path.startswith("f:/"):
        return 1
    if path == "o:/[珍藏]" or path.startswith("o:/[珍藏]/"):
        return 2
    if path == "o:/[珍藏1]" or path.startswith("o:/[珍藏1]/"):
        return 3
    if path.startswith("o:/"):
        return 4
    if path.startswith("v:/"):
        return 5
    return 9


def extract_work_code(work: dict) -> str:
    values = [work.get("directoryName"), work.get("title"), work.get("relativePath")]
    for value in values:
        code = normalize_code(value)
        if code:
            return code
    return ""


def suspicious_code(code: str, work: dict) -> bool:
    prefix = code.split("-", 1)[0]
    title = str(work.get("title") or work.get("directoryName") or "").lower()
    if prefix in BAD_CODE_PREFIXES:
        return True
    return ".chk" in title or title.endswith(".tmp")


class JavDbClient:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.scraper_config = args.scraper_config_data
        self.driver = None

    def fetch_by_code(self, code: str, detail_url: str = "") -> JavDbMeta | None:
        driver = self.get_driver()
        if detail_url:
            driver.get(detail_url)
            detail_html = self.wait_for_detail_page()
            return parse_detail_page(detail_html, driver.current_url, driver.title or "", fallback_code=code, config=self.scraper_config)

        search_url = JAVDB_SEARCH_URL.format(query=quote(code))
        driver.get(search_url)
        html = self.wait_for_search_page()
        candidates = parse_search_candidates(html, driver.current_url, config=self.scraper_config)
        candidate = choose_search_candidate(code, candidates)
        if not candidate:
            return None

        driver.get(candidate["url"])
        detail_html = self.wait_for_detail_page()
        return parse_detail_page(detail_html, driver.current_url, driver.title or "", fallback_code=code, config=self.scraper_config)

    def download_image(self, url: str, referer: str) -> tuple[bytes, str]:
        if not url:
            return b"", ""
        session = requests.Session()
        session.cookies = self.browser_cookies()
        session.headers.update(
            {
                "User-Agent": self.user_agent(),
                "Referer": referer,
            }
        )
        response = session.get(url, timeout=30)
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
        mime = content_type or mimetypes.guess_type(urlparse(url).path)[0] or "image/jpeg"
        if not mime.startswith("image/"):
            raise RuntimeError(f"封面响应不是图片: {mime}")
        return response.content, mime

    def wait_for_search_page(self) -> str:
        return self.wait_for(
            lambda html: parse_search_candidates(html, self.driver.current_url, config=self.scraper_config),
            self.args.search_wait_seconds,
        )

    def wait_for_detail_page(self) -> str:
        selectors = config_list(self.scraper_config, "detailReadySelectors")
        return self.wait_for(lambda html: first_select(BeautifulSoup(html, "html.parser"), selectors), self.args.detail_wait_seconds)

    def wait_for(self, ready, wait_seconds: int) -> str:
        deadline = time.time() + wait_seconds
        last_html = ""
        while time.time() < deadline:
            last_html = self.driver.page_source or ""
            reason = blocked_reason(last_html, self.driver.current_url)
            if reason:
                raise AccessBlockedError(reason)
            if ready(last_html):
                return last_html
            time.sleep(1.0)
        return last_html

    def get_driver(self):
        if self.driver is not None:
            return self.driver

        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service

        options = Options()
        if self.args.chrome_binary and self.args.chrome_binary.exists():
            options.binary_location = str(self.args.chrome_binary)
        options.add_argument(f"--user-data-dir={self.args.profile_dir}")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--no-sandbox")
        options.add_argument("--window-size=1280,900")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option("useAutomationExtension", False)
        if self.args.proxy and not self.args.no_proxy:
            options.add_argument(f"--proxy-server={self.args.proxy}")
        if self.args.headless:
            options.add_argument("--headless=new")

        driver_path = self.args.driver_path if self.args.driver_path and self.args.driver_path.exists() else latest_cached_chromedriver()
        if driver_path:
            self.driver = webdriver.Chrome(service=Service(str(driver_path)), options=options)
        else:
            self.driver = webdriver.Chrome(options=options)

        try:
            from selenium_stealth import stealth

            stealth(
                self.driver,
                languages=["zh-CN", "zh"],
                vendor="Google Inc.",
                platform="Win32",
                webgl_vendor="Intel Inc.",
                renderer="Intel Iris OpenGL Engine",
                fix_hairline=True,
            )
        except Exception:
            pass

        self.inject_external_cookies()
        return self.driver

    def inject_external_cookies(self) -> None:
        profile_dir = getattr(self.args, "cookie_profile_dir", None)
        cookies = []
        source_count = 0
        try:
            if profile_dir:
                cookies = load_chromium_cookies(
                    Path(profile_dir),
                    getattr(self.args, "cookie_profile_name", "Default") or "Default",
                    getattr(self.args, "cookie_domain", None) or ["javdb.com"],
                )
                source_count = len(cookies)
                if not cookies:
                    print(f"JavDB Cookie 注入: {profile_dir} 没有找到匹配 Cookie。", flush=True)
        except Exception as error:
            print(f"JavDB Cookie 读取跳过: {error}", flush=True)

        cookies = merge_javdb_persistent_cookies(cookies)
        persistent_count = max(0, len(cookies) - source_count)
        try:
            driver = self.driver
            driver.get("https://javdb.com/")
            added = 0
            for cookie in cookies:
                selenium_cookie = {
                    "name": cookie["name"],
                    "value": cookie["value"],
                    "domain": cookie["domain"],
                    "path": cookie["path"] or "/",
                    "secure": bool(cookie["secure"]),
                    "httpOnly": bool(cookie["http_only"]),
                }
                if cookie.get("expires"):
                    selenium_cookie["expiry"] = int(cookie["expires"])
                try:
                    driver.add_cookie(selenium_cookie)
                    added += 1
                except Exception:
                    pass
            print(f"JavDB Cookie 注入: 准备 {len(cookies)} 条，成功注入 {added} 条。", flush=True)
            print(f"JavDB Cookie 注入详情: 115读取 {source_count} 条，固定确认 {persistent_count} 条。", flush=True)
        except Exception as error:
            print(f"JavDB Cookie 注入跳过: {error}", flush=True)

    def browser_cookies(self) -> requests.cookies.RequestsCookieJar:
        jar = requests.cookies.RequestsCookieJar()
        if not self.driver:
            return jar
        for cookie in self.driver.get_cookies():
            jar.set(cookie["name"], cookie["value"], domain=cookie.get("domain"), path=cookie.get("path", "/"))
        return jar

    def user_agent(self) -> str:
        if not self.driver:
            return "Mozilla/5.0"
        try:
            return self.driver.execute_script("return navigator.userAgent") or "Mozilla/5.0"
        except Exception:
            return "Mozilla/5.0"

    def close(self) -> None:
        if self.driver:
            self.driver.quit()
            self.driver = None


def latest_cached_chromedriver(root: Path = DEFAULT_WDM_CHROMEDRIVER_ROOT) -> Path | None:
    if not root.exists():
        return None
    drivers = sorted(root.glob("*/chromedriver-win32/chromedriver.exe"), key=lambda item: version_key(str(item)), reverse=True)
    return drivers[0] if drivers else None


def version_key(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", value))


def merge_javdb_persistent_cookies(cookies: list[dict]) -> list[dict]:
    merged = list(cookies or [])
    existing = {(normalize_cookie_domain(cookie.get("domain", "")), cookie.get("name")) for cookie in merged if cookie.get("name")}
    for cookie in JAVDB_PERSISTENT_COOKIES:
        key = (normalize_cookie_domain(cookie["domain"]), cookie["name"])
        if key not in existing:
            merged.append(dict(cookie))
            existing.add(key)
    return merged


def load_chromium_cookies(user_data_dir: Path, profile_name: str, domains: list[str]) -> list[dict]:
    profile_dir = user_data_dir / profile_name
    cookie_db = profile_dir / "Network" / "Cookies"
    if not cookie_db.exists():
        cookie_db = profile_dir / "Cookies"
    local_state = user_data_dir / "Local State"
    if not cookie_db.exists():
        raise RuntimeError(f"找不到 Cookies 数据库: {cookie_db}")
    if not local_state.exists():
        raise RuntimeError(f"找不到 Local State: {local_state}")

    domain_filters = [normalize_cookie_domain(item) for item in domains if str(item or "").strip()] or ["javdb.com"]
    key = chromium_cookie_key(local_state)
    rows = read_cookie_rows(cookie_db, domain_filters)
    cookies = []
    for row in rows:
        value = row["value"] or decrypt_chromium_cookie(row["encrypted_value"], key, row["host_key"])
        if not value:
            continue
        cookies.append(
            {
                "domain": row["host_key"],
                "name": row["name"],
                "value": value,
                "path": row["path"] or "/",
                "secure": bool(row["is_secure"]),
                "http_only": bool(row["is_httponly"]),
                "expires": chrome_time_to_unix(row["expires_utc"]),
            }
        )
    return cookies


def read_cookie_rows(cookie_db: Path, domains: list[str]) -> list[sqlite3.Row]:
    clauses = []
    params = []
    for domain in domains:
        clauses.append("host_key = ? OR host_key = ? OR host_key LIKE ?")
        params.extend([domain, f".{domain}", f"%.{domain}"])
    sql = (
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly "
        f"FROM cookies WHERE {' OR '.join(f'({clause})' for clause in clauses)} ORDER BY host_key, name"
    )
    try:
        conn = sqlite3.connect(f"file:{cookie_db.as_posix()}?mode=ro", uri=True, timeout=1)
    except sqlite3.OperationalError as error:
        raise RuntimeError(f"Cookies 数据库正在被浏览器锁定，请关闭 115Chrome 后同步一次: {cookie_db}") from error
    try:
        conn.row_factory = sqlite3.Row
        return list(conn.execute(sql, params).fetchall())
    finally:
        conn.close()


def chromium_cookie_key(local_state: Path) -> bytes:
    state = json.loads(local_state.read_text(encoding="utf-8"))
    encrypted_key = state.get("os_crypt", {}).get("encrypted_key")
    if not encrypted_key:
        raise RuntimeError("Local State 里没有 os_crypt.encrypted_key")
    blob = base64.b64decode(encrypted_key)
    if blob.startswith(b"DPAPI"):
        blob = blob[5:]
    import win32crypt

    return win32crypt.CryptUnprotectData(blob, None, None, None, 0)[1]


def decrypt_chromium_cookie(encrypted_value: bytes, key: bytes, host_key: str) -> str:
    if not encrypted_value:
        return ""
    import win32crypt

    try:
        if encrypted_value.startswith((b"v10", b"v11", b"v20")):
            nonce = encrypted_value[3:15]
            payload = encrypted_value[15:]
            plain = AESGCM(key).decrypt(nonce, payload, None)
            host_hash = hashlib.sha256(host_key.encode("utf-8")).digest()
            if plain.startswith(host_hash):
                plain = plain[len(host_hash) :]
            return plain.decode("utf-8", errors="ignore")
        return win32crypt.CryptUnprotectData(encrypted_value, None, None, None, 0)[1].decode("utf-8", errors="ignore")
    except Exception:
        return ""


def chrome_time_to_unix(value: int | None) -> int | None:
    try:
        ticks = int(value or 0)
    except (TypeError, ValueError):
        return None
    if ticks <= 0:
        return None
    return max(0, int(ticks / 1_000_000 - 11644473600))


def normalize_cookie_domain(value: str) -> str:
    host = urlparse(value if "://" in value else f"https://{value}").hostname or value
    return host.lstrip(".").lower()


def blocked_reason(html: str, current_url: str = "") -> str:
    text = BeautifulSoup(html or "", "html.parser").get_text(" ", strip=True)
    lower = text.lower()
    path = urlparse(current_url or "").path.lower()
    if path.startswith("/login"):
        return "JavDB 重定向到登录页，请先在共享 Chrome profile 登录后重试。"
    if "此內容需要登入才能查看或操作" in text or "此内容需要登入才能查看或操作" in text:
        return "JavDB 提示该内容需要登录后才能查看或操作。"
    if "attention required! | cloudflare" in lower or "please enable cookies" in lower or "sorry, you have been blocked" in lower:
        return "JavDB Cloudflare 阻断了本次访问，请先用共享 Chrome profile 手动打开并通过验证。"
    if "banned your access" in lower or "禁止了你的訪問" in text or "禁止了你的访问" in text:
        return text[:500]
    if "rucaptcha" in lower:
        return "JavDB 需要人机验证，请先用共享 Chrome profile 手动通过验证。"
    return ""


def parse_search_candidates(html: str, base_url: str, config: dict | None = None) -> list[dict]:
    config = config or DEFAULT_SCRAPER_CONFIG
    soup = BeautifulSoup(html or "", "html.parser")
    candidates = []
    for item in select_all(soup, config_list(config, "searchItemSelectors")):
        link = first_select(item, config_list(config, "searchLinkSelectors"))
        if not link:
            continue
        href = link.get("href") or ""
        strong = first_select(item, config_list(config, "searchCodeSelectors"))
        title_tag = first_select(item, config_list(config, "searchTitleSelectors"))
        code = strong.get_text(" ", strip=True) if strong else ""
        title = title_tag.get_text(" ", strip=True) if title_tag else item.get_text(" ", strip=True)
        if not href or not code:
            continue
        candidates.append({"code": normalize_code(code) or code.strip(), "title": title.strip(), "url": urljoin(base_url, href)})
    return candidates


def choose_search_candidate(query_code: str, candidates: list[dict]) -> dict | None:
    query_key = loose_code_key(query_code)
    exact = [candidate for candidate in candidates if loose_code_key(candidate.get("code")) == query_key]
    if len(exact) == 1:
        return exact[0]
    if exact:
        return exact[0]

    fuzzy = [
        candidate
        for candidate in candidates
        if query_key and (query_key in loose_code_key(candidate.get("code")) or loose_code_key(candidate.get("code")) in query_key)
    ]
    if len(fuzzy) == 1:
        return fuzzy[0]
    return None


def config_list(config: dict, *path: str) -> list[str]:
    current = config
    for key in path:
        if not isinstance(current, dict):
            return []
        current = current.get(key)
    if isinstance(current, list):
        return [str(item).strip() for item in current if str(item).strip()]
    if isinstance(current, str) and current.strip():
        return [current.strip()]
    return []


def label_config(config: dict, name: str) -> list[str]:
    return config_list(config, "labels", name)


def first_select(soup: BeautifulSoup, selectors: list[str]):
    for selector in selectors:
        match = soup.select_one(selector)
        if match:
            return match
    return None


def select_all(soup: BeautifulSoup, selectors: list[str]) -> list:
    if not selectors:
        return []
    try:
        matches = soup.select(", ".join(selectors))
    except Exception:
        matches = []
        for selector in selectors:
            matches.extend(soup.select(selector))

    result = []
    seen = set()
    for match in matches:
        marker = id(match)
        if marker in seen:
            continue
        seen.add(marker)
        result.append(match)
    return result


def parse_detail_page(html: str, url: str, browser_title: str, fallback_code: str, config: dict | None = None) -> JavDbMeta:
    config = config or DEFAULT_SCRAPER_CONFIG
    soup = BeautifulSoup(html or "", "html.parser")
    h2 = first_select(soup, config_list(config, "titleSelectors"))
    h2_text = h2.get_text(" ", strip=True) if h2 else ""
    strong_values = [tag.get_text(" ", strip=True) for tag in (h2.select("strong") if h2 else []) if tag.get_text(strip=True)]
    code = normalize_code(strong_values[0] if strong_values else h2_text) or fallback_code

    title = clean_browser_title(browser_title)
    if not title or loose_code_key(title.split(maxsplit=1)[0] if title.split() else "") != loose_code_key(code):
        title = h2_text or code

    actor_links = label_link_items(soup, url, *label_config(config, "actors"))
    tag_links = label_link_items(soup, url, *label_config(config, "tags"))
    maker_links = label_link_items(soup, url, *label_config(config, "maker"))
    label_links_data = label_link_items(soup, url, *label_config(config, "label"))
    series_links = label_link_items(soup, url, *label_config(config, "series"))
    actors = [item["name"] for item in actor_links] or label_links(soup, *label_config(config, "actors"))
    tags = [item["name"] for item in tag_links] or label_links(soup, *label_config(config, "tags"))
    image_url = ""
    image = first_select(soup, config_list(config, "coverSelectors"))
    if image and image.get("src"):
        image_url = urljoin(url, image.get("src"))
    preview_images = parse_preview_images(soup, url, image_url, config=config)
    preview_video_url = parse_preview_video_url(soup, url, config=config)

    rating_text = label_value(soup, *label_config(config, "rating"))
    rating, rating_count = parse_rating(rating_text)
    duration_text = label_value(soup, *label_config(config, "duration"))

    return JavDbMeta(
        code=code,
        title=title,
        detail_url=url,
        release_date=parse_date(label_value(soup, *label_config(config, "releaseDate"))),
        duration_text=duration_text,
        duration_minutes=parse_duration(duration_text),
        rating_text=rating_text,
        rating=rating,
        rating_count=rating_count,
        director=label_text_or_links(soup, *label_config(config, "director")),
        maker=label_text_or_links(soup, *label_config(config, "maker")),
        label=label_text_or_links(soup, *label_config(config, "label")),
        series=label_text_or_links(soup, *label_config(config, "series")),
        image_url=image_url,
        preview_images=preview_images,
        preview_video_url=preview_video_url,
        actors=actors,
        tags=tags,
        actor_links=actor_links,
        tag_links=tag_links,
        maker_url=maker_links[0]["url"] if maker_links else "",
        label_url=label_links_data[0]["url"] if label_links_data else "",
        series_url=series_links[0]["url"] if series_links else "",
    )


def parse_preview_images(soup: BeautifulSoup, base_url: str, cover_url: str = "", config: dict | None = None) -> list[str]:
    config = config or DEFAULT_SCRAPER_CONFIG
    urls = []
    seen = set()
    selectors = config_list(config, "previewImageSelectors")
    attributes = config_list(config, "previewImageAttributes")
    skip_fragments = [item.lower() for item in config_list(config, "previewImageSkipContains")]
    for selector in selectors:
        for img in soup.select(selector):
            raw = first_attr(img, attributes)
            if not raw:
                continue
            image_url = http_url(raw, base_url)
            if not image_url:
                continue
            if image_url == cover_url or image_url in seen:
                continue
            lower_url = image_url.lower()
            if any(fragment in lower_url for fragment in skip_fragments):
                continue
            seen.add(image_url)
            urls.append(image_url)
    return urls


def parse_preview_video_url(soup: BeautifulSoup, base_url: str, config: dict | None = None) -> str:
    config = config or DEFAULT_SCRAPER_CONFIG
    attributes = config_list(config, "previewVideoAttributes")
    for selector in config_list(config, "previewVideoSelectors"):
        for tag in soup.select(selector):
            raw = first_attr(tag, attributes)
            url = http_url(raw, base_url)
            if url:
                return url
    return ""


def first_attr(tag, attributes: list[str]) -> str:
    for attribute in attributes:
        value = tag.get(attribute)
        if value:
            return str(value)
    return ""


def http_url(raw: str, base_url: str) -> str:
    value = str(raw or "").strip()
    if not value or value.startswith(("blob:", "magnet:", "data:", "javascript:")):
        return ""
    url = urljoin(base_url, value)
    return url if url.lower().startswith(("http://", "https://")) else ""


def clean_browser_title(value: str) -> str:
    return re.sub(r"\s*\|\s*JavDB.*$", "", value or "").strip()


def label_container(soup: BeautifulSoup, *labels: str):
    labels_set = {label.strip() for label in labels}
    for strong in soup.find_all("strong"):
        text = strong.get_text(" ", strip=True)
        if text in labels_set:
            return strong.find_next_sibling("span") or strong.parent
    return None


def label_value(soup: BeautifulSoup, *labels: str) -> str:
    container = label_container(soup, *labels)
    return container.get_text(" ", strip=True) if container else ""


def label_links(soup: BeautifulSoup, *labels: str) -> list[str]:
    container = label_container(soup, *labels)
    if not container:
        return []
    links = [link.get_text(" ", strip=True) for link in container.select("a") if link.get_text(strip=True)]
    if links:
        return unique_texts(links)
    text = container.get_text(" ", strip=True)
    return unique_texts(item.strip() for item in re.split(r"[,，、/|]", text) if item.strip())


def label_link_items(soup: BeautifulSoup, base_url: str, *labels: str) -> list[dict]:
    container = label_container(soup, *labels)
    if not container:
        return []
    result = []
    seen = set()
    for link in container.select("a[href]"):
        name = re.sub(r"\s+", " ", link.get_text(" ", strip=True)).strip()
        url = http_url(link.get("href"), base_url)
        key = (name.casefold(), url)
        if not name or not url or key in seen:
            continue
        seen.add(key)
        result.append({"name": name, "url": url})
    return result


def label_text_or_links(soup: BeautifulSoup, *labels: str) -> str:
    links = label_links(soup, *labels)
    return ", ".join(links) if links else label_value(soup, *labels)


def unique_texts(values) -> list[str]:
    result = []
    seen = set()
    for value in values:
        text = re.sub(r"\s+", " ", str(value or "")).strip()
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def parse_date(value: str) -> str:
    match = re.search(r"(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})", value or "")
    if not match:
        return ""
    return f"{match.group(1)}-{match.group(2).zfill(2)}-{match.group(3).zfill(2)}"


def parse_duration(value: str) -> int | None:
    match = re.search(r"(\d{1,4})", value or "")
    return int(match.group(1)) if match else None


def parse_rating(value: str) -> tuple[float | None, int | None]:
    return parse_javdb_rating_facts(value)


def upsert_work_info(conn: sqlite3.Connection, target: WorkTarget, meta: JavDbMeta) -> None:
    now = iso_now()
    raw_text = render_raw_text(meta)
    fields = public_fields(meta)
    conn.execute(
        """
        INSERT INTO work_info (
          work_id, person_id, person_name, source_info_id, source_name, source_path,
          source_size, source_mtime, code, title, release_date, duration_minutes,
          rating, rating_count, director, maker, label, series, javdb_url, image_url,
          preview_images_json, preview_video_url, actors_json, actor_links_json, tags_json, tag_links_json,
          maker_url, label_url, series_url, fields_json, raw_text, raw_truncated,
          status, error, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ok', NULL, ?)
        ON CONFLICT(work_id) DO UPDATE SET
          person_id = excluded.person_id,
          person_name = excluded.person_name,
          source_info_id = excluded.source_info_id,
          source_name = excluded.source_name,
          source_path = excluded.source_path,
          source_size = excluded.source_size,
          source_mtime = excluded.source_mtime,
          code = excluded.code,
          title = excluded.title,
          release_date = excluded.release_date,
          duration_minutes = excluded.duration_minutes,
          rating = excluded.rating,
          rating_count = excluded.rating_count,
          director = excluded.director,
          maker = excluded.maker,
          label = excluded.label,
          series = excluded.series,
          javdb_url = excluded.javdb_url,
          image_url = excluded.image_url,
          preview_images_json = excluded.preview_images_json,
          preview_video_url = excluded.preview_video_url,
          actors_json = excluded.actors_json,
          actor_links_json = excluded.actor_links_json,
          tags_json = excluded.tags_json,
          tag_links_json = excluded.tag_links_json,
          maker_url = excluded.maker_url,
          label_url = excluded.label_url,
          series_url = excluded.series_url,
          fields_json = excluded.fields_json,
          raw_text = excluded.raw_text,
          raw_truncated = excluded.raw_truncated,
          status = excluded.status,
          error = excluded.error,
          updated_at = excluded.updated_at
        """,
        (
            target.work["id"],
            target.work.get("personId") or "",
            target.person.get("name") if target.person else "",
            f"javdb:{meta.code}",
            SOURCE_NAME,
            meta.detail_url,
            len(raw_text.encode("utf-8")),
            now,
            meta.code,
            meta.title,
            meta.release_date or None,
            meta.duration_minutes,
            meta.rating,
            meta.rating_count,
            meta.director or None,
            meta.maker or None,
            meta.label or None,
            meta.series or None,
            meta.detail_url or None,
            meta.image_url or None,
            json.dumps(meta.preview_images or [], ensure_ascii=False),
            meta.preview_video_url or None,
            json.dumps(meta.actors or [], ensure_ascii=False),
            json.dumps(meta.actor_links or [], ensure_ascii=False),
            json.dumps(meta.tags or [], ensure_ascii=False),
            json.dumps(meta.tag_links or [], ensure_ascii=False),
            meta.maker_url or None,
            meta.label_url or None,
            meta.series_url or None,
            json.dumps(fields, ensure_ascii=False),
            raw_text,
            now,
        ),
    )


def upsert_work_cover(conn: sqlite3.Connection, target: WorkTarget, meta: JavDbMeta, cover_bytes: bytes, cover_mime: str) -> None:
    now = iso_now()
    conn.execute(
        """
        INSERT INTO work_covers (
          work_id, person_id, person_name, video_id, title, cover_url, cover_mime,
          cover_blob, source, fetched_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id) DO UPDATE SET
          person_id = excluded.person_id,
          person_name = excluded.person_name,
          video_id = excluded.video_id,
          title = excluded.title,
          cover_url = excluded.cover_url,
          cover_mime = excluded.cover_mime,
          cover_blob = excluded.cover_blob,
          source = excluded.source,
          fetched_at = excluded.fetched_at,
          updated_at = excluded.updated_at
        """,
        (
            target.work["id"],
            target.work.get("personId") or "",
            target.person.get("name") if target.person else "",
            meta.code,
            meta.title,
            meta.image_url,
            cover_mime,
            cover_bytes,
            SOURCE_NAME,
            now,
            now,
        ),
    )


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


def public_fields(meta: JavDbMeta) -> list[dict]:
    fields = []

    def push(label: str, value) -> None:
        if isinstance(value, list):
            text = ", ".join(str(item) for item in value if item)
        else:
            text = str(value or "").strip()
        if text:
            fields.append({"label": label, "value": text})

    push("番号", meta.code)
    push("标题", meta.title)
    push("日期", meta.release_date)
    push("时长", f"{meta.duration_minutes} 分钟" if meta.duration_minutes else meta.duration_text)
    push("导演", meta.director)
    push("片商", meta.maker)
    push("发行商", meta.label)
    push("系列", meta.series)
    push("评分", rating_text(meta))
    push("类别", meta.tags or [])
    push("演员", meta.actors or [])
    push("预览图", meta.preview_images or [])
    push("预览视频", meta.preview_video_url)
    return fields


def render_raw_text(meta: JavDbMeta) -> str:
    lines = [
        f"metadata_source: {SOURCE_NAME}",
        f"javdb_url: {meta.detail_url}",
        f"video_id: {meta.code}",
        f"video_title: {meta.title}",
    ]
    optional = [
        ("发行日期", meta.release_date),
        ("长度", f"{meta.duration_minutes}分钟" if meta.duration_minutes else meta.duration_text),
        ("rating", meta.rating_text or rating_text(meta)),
        ("导演", meta.director),
        ("制作商", meta.maker),
        ("制作商URL", meta.maker_url),
        ("发行商", meta.label),
        ("发行商URL", meta.label_url),
        ("系列", meta.series),
        ("系列URL", meta.series_url),
        ("actor_names", meta.actors or []),
        ("actor_links", [f"{item.get('name')} {item.get('url')}" for item in meta.actor_links or []]),
        ("tags", meta.tags or []),
        ("tag_links", [f"{item.get('name')} {item.get('url')}" for item in meta.tag_links or []]),
        ("image_url", meta.image_url),
        ("preview_images", meta.preview_images or []),
        ("preview_video_url", meta.preview_video_url),
    ]
    for key, value in optional:
        if isinstance(value, list):
            value = ", ".join(value)
        if value:
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def rating_text(meta: JavDbMeta) -> str:
    if meta.rating is None:
        return ""
    suffix = f" · {meta.rating_count} 人" if meta.rating_count else ""
    return f"{meta.rating}{suffix}"


def result_payload(status: str, target: WorkTarget, extra: dict) -> dict:
    return {
        "status": status,
        "workId": target.work.get("id"),
        "personId": target.work.get("personId"),
        "personName": target.person.get("name") if target.person else "",
        "code": target.code,
        "title": target.work.get("title"),
        "needsInfo": target.needs_info,
        "needsCover": target.needs_cover,
        **extra,
    }


def write_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def pause(args: argparse.Namespace) -> None:
    base_sleep = max(0.0, float(args.sleep or 0))
    if not args.fast and base_sleep < 5.0:
        base_sleep = 5.0
    total_sleep = base_sleep + random.uniform(0, max(0.0, float(args.jitter or 0)))
    if total_sleep > 0:
        time.sleep(total_sleep)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("已中断", file=sys.stderr)
