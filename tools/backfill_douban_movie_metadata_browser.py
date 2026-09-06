import argparse
import json
import math
import random
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from bs4 import BeautifulSoup
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from douban_movie_match import (
    canonical_douban_subject_url,
    choose_movie_metadata,
    clean_movie_search_title,
    validate_manual_movie_metadata,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
INDEX_PATH = DATA_DIR / "image-library-index.json"
DB_PATH = DATA_DIR / "image-gallery.sqlite"
DEFAULT_COOKIE_FILE = DATA_DIR / "douban-cookie.txt"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)
MAX_COVER_BYTES = 2 * 1024 * 1024
MAX_MOVIE_CANDIDATES = 5


class DoubanBlockedError(RuntimeError):
    pass


class DoubanRateLimitedError(DoubanBlockedError):
    pass


class DoubanNoResultError(RuntimeError):
    pass


@dataclass
class MovieTarget:
    key: str
    category: str
    movie_title: str
    search_title: str
    samples: list[str]


def normalize_spaces(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def json_dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill Douban movie metadata with a visible Playwright browser.")
    parser.add_argument("--write", action="store_true", help="Write results to data/image-gallery.sqlite.")
    parser.add_argument("--refresh", action="store_true", help="Refresh existing ok rows.")
    parser.add_argument("--limit", type=int, default=0, help="0 means all targets.")
    parser.add_argument("--sleep", type=float, default=5.0, help="Minimum delay between consecutive collector requests.")
    parser.add_argument("--jitter", type=float, default=2.0, help="Extra random delay between collector requests.")
    parser.add_argument("--category", default="", help="Filter by movie category.")
    parser.add_argument("--title", default="", help="Filter by movie title keyword.")
    parser.add_argument("--series", default="", help="Alias of --title for compatibility.")
    parser.add_argument("--media-id", default="", help="Only process this media id.")
    parser.add_argument("--douban-url", default="", help="Manual Douban subject URL for --media-id.")
    parser.add_argument("--douban-id", default="", help="Manual Douban subject id for --media-id.")
    parser.add_argument("--cookie-file", default=str(DEFAULT_COOKIE_FILE), help="Douban cookie file.")
    parser.add_argument("--browser-channel", default="chrome", help="Playwright Chromium channel, e.g. chrome or msedge.")
    parser.add_argument("--headless", action="store_true", help="Run without a visible browser window.")
    parser.add_argument("--headed", dest="headless", action="store_false", help=argparse.SUPPRESS)
    parser.add_argument("--rate-limit-wait", type=float, default=60.0, help="Compatibility option only; rate-limit pages now stop the run without retry.")
    parser.add_argument("--rate-limit-retries", type=int, default=5, help="Compatibility option only; rate-limit pages now stop the run without retry.")
    parser.add_argument("--search-timeout-ms", type=int, default=15000)
    parser.add_argument("--detail-timeout-ms", type=int, default=45000)
    return parser.parse_args(argv)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def clean_movie_query_title(value: str) -> str:
    return clean_movie_search_title(value)


def movie_targets(index: dict) -> list[MovieTarget]:
    targets = []
    for item in index.get("mediaItems") or []:
        if item.get("mediaKind") != "movie":
            continue
        title = normalize_spaces(item.get("title") or item.get("seriesName") or item.get("subCategory") or item.get("category"))
        if not item.get("id") or not title:
            continue
        folder_title = normalize_spaces(item.get("subCategory"))
        targets.append(
            MovieTarget(
                key=normalize_spaces(item.get("id")),
                category=normalize_spaces(item.get("category")),
                movie_title=title,
                search_title=clean_movie_query_title(title) or clean_movie_query_title(folder_title) or title,
                samples=[value for value in [item.get("relativePath"), item.get("title")] if value],
            )
        )
    return sorted(targets, key=lambda item: item.movie_title, reverse=True)


def category_summary(targets: list[MovieTarget], limit: int = 8) -> str:
    counts: dict[str, int] = {}
    for target in targets:
        key = target.category or "未归类"
        counts[key] = counts.get(key, 0) + 1
    items = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    visible = [f"{name} {count}" for name, count in items[:limit]]
    hidden = sum(count for _, count in items[limit:])
    if hidden:
        visible.append(f"其他 {hidden}")
    return " / ".join(visible)


def normalize_cookie_text(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if text.startswith("[") or text.startswith("{"):
        try:
            parsed = json.loads(text)
            items = parsed if isinstance(parsed, list) else parsed.get("cookies", [])
            return "; ".join(
                f"{item.get('name', '').strip()}={item.get('value', '').strip()}"
                for item in items
                if str(item.get("domain", "")).lstrip(".").endswith("douban.com") and item.get("name")
            )
        except Exception:
            pass
    lines = [line.strip() for line in re.sub(r"^Cookie:\s*", "", text, flags=re.I).splitlines() if line.strip() and not line.strip().startswith("#")]
    netscape = []
    for line in lines:
        parts = line.split("\t")
        if len(parts) >= 7 and parts[0].lstrip(".").endswith("douban.com"):
            netscape.append(f"{parts[5].strip()}={parts[6].strip()}")
    return "; ".join(netscape or lines)


def cookie_header_to_playwright_cookies(header: str) -> list[dict]:
    cookies = []
    for part in header.split(";"):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        if not name:
            continue
        cookies.append({"name": name, "value": value.strip(), "domain": ".douban.com", "path": "/"})
    return cookies


def read_cookie_state(cookie_file: str) -> tuple[str, str, list[dict]]:
    path = Path(cookie_file)
    if not path.is_absolute():
        path = REPO_ROOT / path
    if not path.exists():
        return "", "", []
    header = normalize_cookie_text(path.read_text(encoding="utf-8", errors="ignore"))
    return header, str(path), cookie_header_to_playwright_cookies(header)


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    if not any(row[1] == column for row in rows):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def ensure_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS movie_metadata (
          media_id TEXT PRIMARY KEY,
          category TEXT,
          movie_title TEXT NOT NULL,
          douban_id TEXT,
          douban_url TEXT,
          douban_title TEXT,
          original_title TEXT,
          aka_json TEXT,
          official_site TEXT,
          year TEXT,
          rating REAL,
          rating_count INTEGER,
          rating_stars_json TEXT,
          rating_better_than_json TEXT,
          directors_json TEXT,
          writers_json TEXT,
          genres_json TEXT,
          actors_json TEXT,
          countries_json TEXT,
          languages_json TEXT,
          pubdate TEXT,
          release_dates_json TEXT,
          season_count INTEGER,
          episode_count INTEGER,
          episode_duration TEXT,
          durations_json TEXT,
          imdb_id TEXT,
          info_json TEXT,
          json_ld_json TEXT,
          summary TEXT,
          cover_url TEXT,
          cover_mime TEXT,
          cover_blob BLOB,
          cover_bytes INTEGER,
          source TEXT,
          detail_source TEXT,
          status TEXT NOT NULL DEFAULT 'ok',
          error TEXT,
          fetched_at TEXT,
          updated_at TEXT NOT NULL
        )
        """
    )
    for column, definition in [
        ("category", "TEXT"),
        ("movie_title", "TEXT NOT NULL DEFAULT ''"),
        ("detail_source", "TEXT"),
        ("status", "TEXT NOT NULL DEFAULT 'ok'"),
        ("updated_at", "TEXT NOT NULL DEFAULT ''"),
    ]:
        ensure_column(conn, "movie_metadata", column, definition)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_movie_metadata_category ON movie_metadata(category)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_movie_metadata_status ON movie_metadata(status)")
    conn.commit()


def existing_rows(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    rows = conn.execute("SELECT media_id, status, cover_bytes FROM movie_metadata").fetchall()
    return {row["media_id"]: row for row in rows}


def split_slash_list(value: str | None) -> list[str]:
    return [normalize_spaces(item) for item in re.split(r"\s*/\s*", str(value or "")) if normalize_spaces(item)]


def unique(values, limit: int = 80) -> list[str]:
    seen = set()
    result = []
    for value in values or []:
        text = normalize_spaces(value)
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
        if len(result) >= limit:
            break
    return result


def json_ld_names(value) -> list[str]:
    items = value if isinstance(value, list) else [value] if value else []
    result = []
    for item in items:
        if isinstance(item, dict):
            result.append(item.get("name", ""))
        else:
            result.append(str(item or ""))
    return unique(result)


def parse_json_ld(soup: BeautifulSoup) -> dict:
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            parsed = json.loads(script.string or script.get_text("", strip=True))
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


def parse_info_fields(soup: BeautifulSoup) -> dict[str, str]:
    info = soup.select_one("#info")
    if not info:
        return {}
    fields = {}
    for label_node in info.select("span.pl"):
        label = normalize_spaces(label_node.get_text(" ", strip=True)).rstrip(":：")
        pieces = []
        for sibling in label_node.next_siblings:
            if getattr(sibling, "name", None) == "br":
                break
            if hasattr(sibling, "get_text"):
                pieces.append(sibling.get_text(" ", strip=True))
            else:
                pieces.append(str(sibling))
        value = normalize_spaces(" ".join(pieces)).lstrip(":：").strip()
        if label and value:
            fields[label] = value
    return fields


def parse_rating_stars(soup: BeautifulSoup) -> dict:
    stars = {}
    for item in soup.select(".ratings-on-weight .item"):
        class_text = " ".join(item.get("class", [])) + " " + str(item)
        star_match = re.search(r"stars([1-5])", class_text)
        percent = normalize_spaces(item.select_one(".rating_per").get_text(" ", strip=True) if item.select_one(".rating_per") else "")
        if star_match and percent.endswith("%"):
            try:
                stars[star_match.group(1)] = float(percent.rstrip("%"))
            except ValueError:
                pass
    return stars


def parse_better_than(soup: BeautifulSoup) -> list[dict]:
    text = normalize_spaces(soup.select_one(".rating_betterthan").get_text(" ", strip=True) if soup.select_one(".rating_betterthan") else "")
    result = []
    for percent, type_name in re.findall(r"(\d+(?:\.\d+)?)%\s*([^%]+?)(?=\s*\d+(?:\.\d+)?%|$)", text):
        result.append({"percent": float(percent), "type": normalize_spaces(type_name)})
    return result


def parse_subject_page(html: str, url: str) -> dict:
    soup = BeautifulSoup(html or "", "html.parser")
    info = parse_info_fields(soup)
    json_ld = parse_json_ld(soup)
    title = normalize_spaces(
        (soup.select_one('[property="v:itemreviewed"]') or soup.select_one("h1 span")).get_text(" ", strip=True)
        if (soup.select_one('[property="v:itemreviewed"]') or soup.select_one("h1 span"))
        else json_ld.get("name", "")
    )
    year = normalize_spaces((soup.select_one(".year") or {}).get_text("", strip=True) if soup.select_one(".year") else "").strip("()")
    rating_text = normalize_spaces(soup.select_one('[property="v:average"]').get_text("", strip=True) if soup.select_one('[property="v:average"]') else "")
    votes_text = normalize_spaces(soup.select_one('[property="v:votes"]').get_text("", strip=True) if soup.select_one('[property="v:votes"]') else "")
    summary = normalize_spaces(soup.select_one('[property="v:summary"]').get_text(" ", strip=True) if soup.select_one('[property="v:summary"]') else "")
    cover_node = soup.select_one("a.nbgnbg img") or soup.select_one('img[rel="v:image"]')
    cover_url = normalize_spaces(json_ld.get("image") or (cover_node.get("src") if cover_node else ""))
    douban_id = re.search(r"subject/(\d+)", url)
    genres = unique(split_slash_list(info.get("类型")) or [node.get_text(" ", strip=True) for node in soup.select('[property="v:genre"]')])
    actors = unique(split_slash_list(info.get("主演")) or json_ld_names(json_ld.get("actor")) or [node.get_text(" ", strip=True) for node in soup.select('[rel="v:starring"]')])
    directors = unique(split_slash_list(info.get("导演")) or json_ld_names(json_ld.get("director")))
    writers = unique(split_slash_list(info.get("编剧")) or json_ld_names(json_ld.get("author")))
    pubdate = info.get("首播") or info.get("上映日期") or ""
    durations = unique(split_slash_list(info.get("单集片长")) + split_slash_list(info.get("片长")))
    imdb_match = re.search(r"(tt\d+)", info.get("IMDb", ""), flags=re.I)
    return {
        "doubanId": douban_id.group(1) if douban_id else "",
        "doubanUrl": url,
        "title": title,
        "originalTitle": info.get("原名") or info.get("原片名") or "",
        "aliases": unique(split_slash_list(info.get("又名"))),
        "officialSite": info.get("官方网站") or "",
        "year": year,
        "rating": float(rating_text) if re.fullmatch(r"\d+(?:\.\d+)?", rating_text) else None,
        "ratingCount": int(votes_text) if votes_text.isdigit() else 0,
        "ratingStars": parse_rating_stars(soup),
        "ratingBetterThan": parse_better_than(soup),
        "directors": directors,
        "writers": writers,
        "genres": genres,
        "actors": actors,
        "countries": unique(split_slash_list(info.get("制片国家/地区"))),
        "languages": unique(split_slash_list(info.get("语言"))),
        "pubdate": pubdate,
        "releaseDates": unique(split_slash_list(pubdate)),
        "seasonCount": None,
        "episodeCount": None,
        "episodeDuration": "",
        "durations": durations,
        "imdbId": imdb_match.group(1) if imdb_match else "",
        "info": info,
        "jsonLd": json_ld,
        "summary": summary,
        "coverUrl": cover_url,
        "detailSource": "subject",
    }


def douban_blocked_reason(status: int | None, url: str, html: str) -> str:
    if status in {403, 418, 429}:
        return f"HTTP {status}"
    if "sec.douban.com" in (url or ""):
        return f"安全验证页 {url}"
    text = html or ""
    markers = [
        "检测到有异常请求",
        "请输入验证码",
        "有异常请求从你的 IP 发出",
        "Please verify you are a human",
        "搜索访问太频繁",
        "访问过于频繁",
        "Too Many Requests",
    ]
    for marker in markers:
        if marker in text:
            return marker
    if re.search(r"<title>\s*Forbidden\s*</title>", text, flags=re.I) or re.search(r"<h1[^>]*>\s*Forbidden\s*</h1>", text, flags=re.I):
        return "Forbidden"
    return ""


def is_blocked(status: int | None, url: str, html: str) -> bool:
    return bool(douban_blocked_reason(status, url, html))


def is_search_rate_limited(status: int | None, url: str, html: str) -> bool:
    if status == 429:
        return True
    text = html or ""
    return any(marker in text for marker in ["搜索访问太频繁", "访问过于频繁", "Too Many Requests"])


def subject_url_from_value(value: str) -> str:
    return canonical_douban_subject_url(value)


class RequestPacer:
    """One run-wide boundary for explicit collector requests (not browser subresources)."""

    def __init__(self, args, sleep_fn=None, log=None):
        self.base = float(args.sleep)
        self.jitter = float(args.jitter)
        if not all(math.isfinite(value) and value >= 0 for value in [self.base, self.jitter]):
            raise ValueError("sleep/jitter 必须是有限非负数")
        self.sleep_fn = sleep_fn or time.sleep
        self.log = log or print
        self.started = False

    def before_request(self):
        if self.started:
            seconds = self.base + random.uniform(0, self.jitter)
            if seconds:
                self.log(f"  wait {seconds:.1f}s")
                self.sleep_fn(seconds)
        self.started = True


def check_response(status, url, text):
    reason = douban_blocked_reason(status, url, text)
    if reason:
        raise DoubanBlockedError(f"{reason} {url}")
    if status is None or not 200 <= status < 300:
        raise RuntimeError(f"资料请求失败 HTTP {status} {url}")


def suggest_subject_urls(context, query: str, pace=None) -> list[str]:
    url = f"https://movie.douban.com/j/subject_suggest?q={quote(query)}"
    if pace:
        pace.before_request()
    response = context.request.get(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/plain,*/*",
            "Referer": "https://movie.douban.com/",
        },
        timeout=15000,
    )
    check_response(response.status, response.url, "")
    check_response(response.status, response.url, response.text())
    try:
        items = response.json()
    except Exception as error:
        raise RuntimeError("subject_suggest 返回无效 JSON，待核对") from error
    if not isinstance(items, list):
        raise RuntimeError("subject_suggest 返回无效候选列表，待核对")
    result = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        url = subject_url_from_value(item.get("url", ""))
        if url and url not in result:
            result.append(url)
        if len(result) == MAX_MOVIE_CANDIDATES:
            break
    return result


def extract_subject_urls_from_page(page, html: str) -> list[str]:
    try:
        links = page.eval_on_selector_all(
            'a[href*="movie.douban.com/subject/"]',
            """els => els.map(a => ({href: a.href || "", text: (a.textContent || a.title || "").trim()}))""",
        )
    except Exception:
        links = []
    # Parse actual href attributes, never search arbitrary text for a URL.
    links += [{"href": node.get("href", "")} for node in BeautifulSoup(html or "", "html.parser").select("a[href]")]
    result = []
    for item in links:
        url = subject_url_from_value(item.get("href", ""))
        if url and url not in result:
            result.append(url)
        if len(result) == MAX_MOVIE_CANDIDATES:
            break
    return result


def search_subject_urls(page, query: str, args: argparse.Namespace, pace=None) -> list[str]:
    search_urls = [
        f"https://search.douban.com/movie/subject_search?search_text={quote(query)}&cat=1002",
        f"https://www.douban.com/search?cat=1002&q={quote(query)}",
    ]
    for url in search_urls:
        if pace:
            pace.before_request()
        response = page.goto(url, wait_until="domcontentloaded", timeout=args.detail_timeout_ms)
        check_response(response.status if response else None, page.url, "")
        page.wait_for_timeout(1200)
        try:
            page.wait_for_selector('a[href*="movie.douban.com/subject/"]', timeout=args.search_timeout_ms)
        except PlaywrightTimeoutError:
            pass
        html = page.content()
        check_response(response.status if response else None, page.url, html)
        subject_urls = extract_subject_urls_from_page(page, html)
        if subject_urls:
            return subject_urls
    raise DoubanNoResultError(f"豆瓣没有搜索结果：{query}")


def fetch_subject_page_meta(page, subject_url: str, args: argparse.Namespace, pace=None) -> dict:
    canonical = subject_url_from_value(subject_url)
    if not canonical:
        raise RuntimeError("无效豆瓣详情地址，待核对")
    if pace:
        pace.before_request()
    response = page.goto(canonical, wait_until="domcontentloaded", timeout=args.detail_timeout_ms)
    check_response(response.status if response else None, page.url, "")
    page.wait_for_timeout(1200)
    html = page.content()
    check_response(response.status if response else None, page.url, html)
    if subject_url_from_value(page.url) != canonical:
        raise RuntimeError("豆瓣详情跳转至其它条目/未知页面，待核对")
    meta = parse_subject_page(html, canonical)
    if not meta.get("title"):
        raise RuntimeError("豆瓣详情缺少标题，待核对")
    return meta


def fetch_movie_meta(context, page, target: MovieTarget, args: argparse.Namespace, pace=None) -> dict:
    pace = pace or RequestPacer(args)
    queries = unique([target.search_title, re.sub(r"\b(19\d{2}|20\d{2})\b", "", target.search_title).strip(), target.movie_title], 3)
    last_no_result = None
    subject_urls = []
    for query in queries:
        if not query:
            continue
        found = suggest_subject_urls(context, query, pace)
        if not found:
            try:
                found = search_subject_urls(page, query, args, pace)
            except DoubanNoResultError as error:
                last_no_result = error
                continue
        for url in found:
            if url not in subject_urls:
                subject_urls.append(url)
            if len(subject_urls) >= MAX_MOVIE_CANDIDATES:
                break
        if subject_urls:
            break
    if not subject_urls:
        raise last_no_result or DoubanNoResultError(f"豆瓣没有搜索结果：{target.search_title}")
    # A failed listed detail invalidates the whole decision: never choose using
    # only the successfully fetched subset, or fall back to search snippets.
    candidates = [fetch_subject_page_meta(page, url, args, pace) for url in subject_urls]
    return choose_movie_metadata({"movieTitle": target.movie_title, "searchTitle": target.search_title, "samples": target.samples}, candidates)


def fetch_cover(context, url: str, pace=None) -> tuple[bytes | None, str]:
    if not url:
        return None, ""
    if pace:
        pace.before_request()
    response = context.request.get(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": "https://movie.douban.com/",
        },
        timeout=30000,
    )
    check_response(response.status, response.url, "")
    body = response.body()
    reason = douban_blocked_reason(response.status, response.url, body.decode("utf-8", errors="replace"))
    if reason:
        raise DoubanBlockedError(f"{reason} {response.url}")
    if "text" in (response.headers.get("content-type") or "").lower():
        check_response(response.status, response.url, body.decode("utf-8", errors="replace"))
        raise RuntimeError("封面返回非图片内容")
    if not body or len(body) > MAX_COVER_BYTES:
        raise RuntimeError(f"封面大小异常 {len(body) if body else 0}")
    mime = (response.headers.get("content-type") or "image/jpeg").split(";")[0]
    return body, mime


def upsert_ok(conn: sqlite3.Connection, target: MovieTarget, meta: dict, cover_blob: bytes | None, cover_mime: str) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    has_cover = cover_blob is not None
    record = {
        "media_id": target.key,
        "category": target.category,
        "movie_title": target.movie_title,
        "douban_id": meta.get("doubanId", ""),
        "douban_url": meta.get("doubanUrl", ""),
        "douban_title": meta.get("title", ""),
        "original_title": meta.get("originalTitle", ""),
        "aka_json": json_dumps(meta.get("aliases", [])),
        "official_site": meta.get("officialSite", ""),
        "year": meta.get("year", ""),
        "rating": meta.get("rating"),
        "rating_count": meta.get("ratingCount", 0),
        "rating_stars_json": json_dumps(meta.get("ratingStars", {})),
        "rating_better_than_json": json_dumps(meta.get("ratingBetterThan", [])),
        "directors_json": json_dumps(meta.get("directors", [])),
        "writers_json": json_dumps(meta.get("writers", [])),
        "genres_json": json_dumps(meta.get("genres", [])),
        "actors_json": json_dumps(meta.get("actors", [])),
        "countries_json": json_dumps(meta.get("countries", [])),
        "languages_json": json_dumps(meta.get("languages", [])),
        "pubdate": meta.get("pubdate", ""),
        "release_dates_json": json_dumps(meta.get("releaseDates", [])),
        "season_count": meta.get("seasonCount"),
        "episode_count": meta.get("episodeCount"),
        "episode_duration": meta.get("episodeDuration", ""),
        "durations_json": json_dumps(meta.get("durations", [])),
        "imdb_id": meta.get("imdbId", ""),
        "info_json": json_dumps(meta.get("info", {})),
        "json_ld_json": json_dumps(meta.get("jsonLd", {})),
        "summary": meta.get("summary", ""),
        "cover_url": meta.get("coverUrl", ""),
        "cover_mime": cover_mime if has_cover else None,
        "cover_blob": cover_blob,
        "cover_bytes": len(cover_blob) if has_cover else None,
        "source": "douban-browser",
        "detail_source": meta.get("detailSource", ""),
        "status": "ok",
        "error": "",
        "fetched_at": now,
        "updated_at": now,
    }
    columns = list(record.keys())
    updates = []
    for column in columns:
        if column == "media_id":
            continue
        if column in {"cover_mime", "cover_blob", "cover_bytes"}:
            updates.append(f"{column}=CASE WHEN excluded.douban_id <> '' AND excluded.douban_id = movie_metadata.douban_id "
                           f"THEN COALESCE(excluded.{column}, movie_metadata.{column}) ELSE excluded.{column} END")
        else:
            updates.append(f"{column}=excluded.{column}")
    updates_sql = ", ".join(updates)
    conn.execute(
        f"""
        INSERT INTO movie_metadata ({", ".join(columns)})
        VALUES ({", ".join("?" for _ in columns)})
        ON CONFLICT(media_id) DO UPDATE SET {updates_sql}
        """,
        [record[column] for column in columns],
    )
    conn.commit()


def upsert_error(conn: sqlite3.Connection, target: MovieTarget, error: Exception) -> None:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    conn.execute(
        """
        INSERT INTO movie_metadata (media_id, category, movie_title, source, status, error, fetched_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
          category=excluded.category,
          movie_title=excluded.movie_title,
          source=excluded.source,
          status=excluded.status,
          error=excluded.error,
          fetched_at=excluded.fetched_at,
          updated_at=excluded.updated_at
        WHERE movie_metadata.status <> 'ok'
        """,
        (target.key, target.category, target.movie_title, "douban-browser", "error", str(error)[:1000], now, now),
    )
    conn.commit()


def pause(args: argparse.Namespace, index_in_run: int, total: int) -> None:
    if index_in_run >= total - 1:
        return
    seconds = max(0.0, args.sleep) + random.uniform(0, max(0.0, args.jitter))
    if seconds:
        print(f"  wait {seconds:.1f}s")
        time.sleep(seconds)


def fetch_movie_meta_with_rate_limit(context, page, target: MovieTarget, args: argparse.Namespace, pace=None) -> dict:
    # Compatibility entry point only: explicit rate limiting now stops the run.
    # Do not switch queries or retry after the service requests a stop.
    return fetch_movie_meta(context, page, target, args, pace)


def run(args, *, conn=None, index=None, cookie_state=None, context=None, page=None,
        sleep_fn=None, log=None, playwright_factory=None) -> dict:
    """Run the real workflow, with complete external boundaries injectable.

    Tests must inject all five data/browser boundaries together; omission is an
    error, not permission to fall through to the user's DB, cookies or browser.
    Injected connections/context/page remain owned by the caller.
    """
    log = log or print
    injected = [conn, index, cookie_state, context, page]
    if any(value is not None for value in injected) and not all(value is not None for value in injected):
        raise ValueError("测试/嵌入运行必须同时提供 conn/index/cookie_state/context/page")
    pace = RequestPacer(args, sleep_fn, log)
    stats = {"ok": 0, "failed": 0, "blocked": False, "targets": 0, "exitCode": 0}
    keyword = normalize_spaces(args.title or args.series)
    media_id = normalize_spaces(args.media_id)
    manual_value = normalize_spaces(args.douban_url or args.douban_id)
    if re.fullmatch(r"\d{5,}", manual_value, flags=re.ASCII):
        manual_value = f"https://movie.douban.com/subject/{manual_value}/"
    manual_subject_url = subject_url_from_value(manual_value)
    if (args.douban_url or args.douban_id) and not manual_subject_url:
        log("error 手动豆瓣条目无效：请传豆瓣 subject 链接或纯数字 subject id。")
        return {**stats, "exitCode": 1}
    if manual_subject_url and not media_id:
        log("error 手动校准需要同时传 --media-id，避免误覆盖其它电影。")
        return {**stats, "exitCode": 1}
    with ExitStack() as resources:
        if conn is None:
            cookie_state = read_cookie_state(args.cookie_file)
            index = read_json(INDEX_PATH, {})
            conn = sqlite3.connect(DB_PATH, timeout=30)
            resources.callback(conn.close)
        conn.row_factory = sqlite3.Row
        ensure_db(conn)
        existing = existing_rows(conn)
        cookie_header, cookie_source, cookies = cookie_state
        targets_by_key = {}
        for target in movie_targets(index):
            targets_by_key.setdefault(target.key, target)
        targets = list(targets_by_key.values())
        if media_id:
            targets = [target for target in targets if target.key == media_id]
            if not targets:
                log(f"error 找不到 media-id={media_id} 对应的电影。请先刷新电影索引。")
                return {**stats, "exitCode": 1}
        if args.category:
            targets = [target for target in targets if target.category == args.category]
        if keyword:
            targets = [target for target in targets if any(keyword in value for value in [target.movie_title, target.search_title, *target.samples] if value)]
        if not args.refresh and not manual_subject_url:
            targets = [target for target in targets if not existing.get(target.key) or existing[target.key]["status"] != "ok" or not existing[target.key]["cover_bytes"]]
        if args.limit and args.limit > 0:
            targets = targets[:args.limit]
        stats["targets"] = len(targets)
        log(f"豆瓣电影资料目标：{len(targets)} 部电影 write={'yes' if args.write else 'no'} refresh={'yes' if args.refresh else 'no'} cookie={'yes' if cookie_header else 'no'}")
        if targets and not args.category:
            log(f"分类分布：{category_summary(targets)}")
        if cookie_source:
            log(f"Cookie 来源：{cookie_source}")
        if not targets:
            return stats
        if context is None:
            playwright = resources.enter_context((playwright_factory or sync_playwright)())
            browser = playwright.chromium.launch(channel=args.browser_channel or None, headless=args.headless)
            resources.callback(browser.close)
            context = browser.new_context(user_agent=USER_AGENT, locale="zh-CN", timezone_id="Asia/Shanghai",
                                          viewport={"width": 1365, "height": 900},
                                          extra_http_headers={"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7"})
            resources.callback(context.close)
            if cookies:
                context.add_cookies(cookies)
            page = context.new_page()
        try:
            pace.before_request()
            response = page.goto("https://movie.douban.com/", wait_until="domcontentloaded", timeout=args.detail_timeout_ms)
            check_response(response.status if response else None, page.url, "")
            check_response(response.status if response else None, page.url, page.content())
            for index_in_run, target in enumerate(targets):
                try:
                    log(f"[{index_in_run + 1}/{len(targets)}] {target.category} / {target.movie_title} -> {target.search_title}")
                    meta = validate_manual_movie_metadata(fetch_subject_page_meta(page, manual_subject_url, args, pace)) if manual_subject_url else fetch_movie_meta_with_rate_limit(context, page, target, args, pace)
                    cover_blob, cover_mime = fetch_cover(context, meta.get("coverUrl", ""), pace)
                    if args.write:
                        upsert_ok(conn, target, meta, cover_blob, cover_mime)
                    stats["ok"] += 1
                    log(f"  ok {meta.get('title') or '-'} {meta.get('year') or ''} rating={meta.get('rating') or '-'} detail={meta.get('detailSource') or '-'} cover={len(cover_blob or b'')}")
                except DoubanBlockedError:
                    raise
                except Exception as error:
                    stats["failed"] += 1
                    if args.write:
                        upsert_error(conn, target, error)
                    log(f"  error {error}；已有 ok 资料保持不变")
        except DoubanBlockedError as error:
            stats["blocked"] = True
            stats["exitCode"] = 2
            log(f"  blocked {error}")
            log("  已停止：豆瓣返回限流/拦截/验证页；不自动重试或切换查询，不覆盖已有 ok 资料，未把剩余作品写成 error。")
    log(f"完成 ok={stats['ok']} failed={stats['failed']} blocked={'yes' if stats['blocked'] else 'no'}")
    return stats


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    return run(parse_args())["exitCode"]


if __name__ == "__main__":
    raise SystemExit(main())
