import argparse
import json
import random
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from bs4 import BeautifulSoup
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill Douban movie metadata with a visible Playwright browser.")
    parser.add_argument("--write", action="store_true", help="Write results to data/image-gallery.sqlite.")
    parser.add_argument("--refresh", action="store_true", help="Refresh existing ok rows.")
    parser.add_argument("--limit", type=int, default=0, help="0 means all targets.")
    parser.add_argument("--sleep", type=float, default=5.0, help="Base delay between movies.")
    parser.add_argument("--jitter", type=float, default=2.0, help="Extra random delay between movies.")
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
    parser.add_argument("--rate-limit-wait", type=float, default=60.0, help="Seconds to wait when Douban says search is too frequent.")
    parser.add_argument("--rate-limit-retries", type=int, default=5, help="Retries for the current movie after search rate limiting.")
    parser.add_argument("--search-timeout-ms", type=int, default=15000)
    parser.add_argument("--detail-timeout-ms", type=int, default=45000)
    return parser.parse_args()


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def clean_movie_query_title(value: str) -> str:
    source = str(value or "")
    year_match = re.search(r"\b(19\d{2}|20\d{2})\b", source)
    year = year_match.group(1) if year_match else ""
    text = re.sub(r"\[[^\]]+\]", " ", source)
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(
        r"\b(?:2160p|1080p|720p|480p|4k|8k|uhd|remux|bluray|blu[-_. ]?ray|web[-_. ]?dl|"
        r"hdtv|hdr|dv|p7|hevc|x265|x264|h\.264|h\.265|aac|dts|truehd|atmos|multi|proper|repack)\b",
        " ",
        text,
        flags=re.I,
    )
    text = re.sub(r"\b(?:cd\d+|part\d+|disc\d+)\b", " ", text, flags=re.I)
    text = re.sub(r"\b\d{1,3}(?:\.\d+)?\s*(?:gb|mb)\b", " ", text, flags=re.I)
    text = re.sub(r"\.(?:mkv|mp4|m2ts|ts|avi|mov|wmv)$", " ", text, flags=re.I)
    text = re.sub(r"[._-]+", " ", text)
    text = normalize_spaces(text)
    year_index = text.find(year) if year else -1
    before_year = text[:year_index].strip() if year_index >= 0 else text
    chinese = re.search(r"[\u4e00-\u9fff][\u4e00-\u9fff\s·：:]+", before_year or text)
    title = normalize_spaces(chinese.group(0) if chinese else before_year or text)
    return normalize_spaces(" ".join(part for part in [title, year] if part))


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
    text = normalize_spaces(value)
    match = re.search(r"(?:https?:)?//(?:movie\.)?douban\.com/subject/(\d+)/?", text)
    if match:
        return f"https://movie.douban.com/subject/{match.group(1)}/"
    match = re.search(r"\bsubject/(\d+)/?", text)
    if match:
        return f"https://movie.douban.com/subject/{match.group(1)}/"
    if re.fullmatch(r"\d{5,}", text):
        return f"https://movie.douban.com/subject/{text}/"
    return ""


def suggest_subject_url(context, query: str) -> str:
    url = f"https://movie.douban.com/j/subject_suggest?q={quote(query)}"
    response = context.request.get(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/plain,*/*",
            "Referer": "https://movie.douban.com/",
        },
        timeout=15000,
    )
    if response.status == 429:
        raise DoubanRateLimitedError(f"subject_suggest HTTP {response.status}")
    if response.status in {403, 418}:
        raise DoubanBlockedError(f"subject_suggest HTTP {response.status}")
    try:
        items = response.json()
    except Exception:
        items = []
    for item in items if isinstance(items, list) else []:
        url = subject_url_from_value(item.get("url", ""))
        if url:
            return url
    return ""


def extract_subject_url_from_page(page, html: str) -> str:
    try:
        links = page.eval_on_selector_all(
            'a[href*="movie.douban.com/subject/"]',
            """els => els.map(a => ({href: a.href || "", text: (a.textContent || a.title || "").trim()}))""",
        )
    except Exception:
        links = []
    for item in links:
        url = subject_url_from_value(item.get("href", ""))
        if url:
            return url
    return subject_url_from_value(html)


def search_subject_url(page, query: str, args: argparse.Namespace) -> str:
    search_urls = [
        f"https://search.douban.com/movie/subject_search?search_text={quote(query)}&cat=1002",
        f"https://www.douban.com/search?cat=1002&q={quote(query)}",
    ]
    for url in search_urls:
        response = page.goto(url, wait_until="domcontentloaded", timeout=args.detail_timeout_ms)
        page.wait_for_timeout(1200)
        try:
            page.wait_for_selector('a[href*="movie.douban.com/subject/"]', timeout=args.search_timeout_ms)
        except PlaywrightTimeoutError:
            pass
        html = page.content()
        if is_search_rate_limited(response.status if response else None, page.url, html):
            raise DoubanRateLimitedError(f"搜索访问太频繁：{page.url}")
        blocked_reason = douban_blocked_reason(response.status if response else None, page.url, html)
        if blocked_reason:
            raise DoubanBlockedError(f"{blocked_reason} {page.url}")
        subject_url = extract_subject_url_from_page(page, html)
        if subject_url:
            return subject_url
    raise DoubanNoResultError(f"豆瓣没有搜索结果：{query}")


def fetch_subject_page_meta(page, subject_url: str, args: argparse.Namespace) -> dict:
    response = page.goto(subject_url, wait_until="domcontentloaded", timeout=args.detail_timeout_ms)
    page.wait_for_timeout(1200)
    html = page.content()
    if is_search_rate_limited(response.status if response else None, page.url, html):
        raise DoubanRateLimitedError(f"访问太频繁：{page.url}")
    blocked_reason = douban_blocked_reason(response.status if response else None, page.url, html)
    if blocked_reason:
        raise DoubanBlockedError(f"{blocked_reason} {page.url}")
    return parse_subject_page(html, subject_url_from_value(page.url) or subject_url)


def fetch_movie_meta(context, page, target: MovieTarget, args: argparse.Namespace) -> dict:
    queries = unique([target.search_title, re.sub(r"\b(19\d{2}|20\d{2})\b", "", target.search_title).strip(), target.movie_title], 3)
    last_no_result = None
    for query in queries:
        if not query:
            continue
        subject_url = suggest_subject_url(context, query)
        if not subject_url:
            try:
                subject_url = search_subject_url(page, query, args)
            except DoubanNoResultError as error:
                last_no_result = error
                continue
        return fetch_subject_page_meta(page, subject_url, args)
    raise last_no_result or DoubanNoResultError(f"豆瓣没有搜索结果：{target.search_title}")


def fetch_cover(context, url: str) -> tuple[bytes | None, str]:
    if not url:
        return None, ""
    response = context.request.get(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": "https://movie.douban.com/",
        },
        timeout=30000,
    )
    if not response.ok:
        raise RuntimeError(f"封面下载失败 HTTP {response.status}")
    body = response.body()
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
            updates.append(f"{column}=COALESCE(excluded.{column}, {column})")
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


def fetch_movie_meta_with_rate_limit(context, page, target: MovieTarget, args: argparse.Namespace) -> dict:
    retries = max(0, args.rate_limit_retries)
    wait_seconds = max(0.0, args.rate_limit_wait)
    for attempt in range(retries + 1):
        try:
            return fetch_movie_meta(context, page, target, args)
        except DoubanRateLimitedError as error:
            if attempt >= retries:
                raise DoubanBlockedError(f"{error}；已等待重试 {retries} 次仍被限速") from error
            print(f"  rate-limit {error}")
            print(f"  搜索访问太频繁，等待 {wait_seconds:.0f}s 后重试当前影片 ({attempt + 1}/{retries})")
            time.sleep(wait_seconds)
    raise DoubanBlockedError("搜索访问太频繁")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    args = parse_args()
    keyword = normalize_spaces(args.title or args.series)
    media_id = normalize_spaces(args.media_id)
    manual_subject_url = subject_url_from_value(args.douban_url or args.douban_id)
    if (args.douban_url or args.douban_id) and not manual_subject_url:
        print("error 手动豆瓣条目无效：请传豆瓣 subject 链接或纯数字 subject id。")
        return 1
    if manual_subject_url and not media_id:
        print("error 手动校准需要同时传 --media-id，避免误覆盖其它电影。")
        return 1
    cookie_header, cookie_source, cookies = read_cookie_state(args.cookie_file)
    index = read_json(INDEX_PATH, {})

    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    ensure_db(conn)
    existing = existing_rows(conn)

    targets = movie_targets(index)
    if media_id:
        targets = [target for target in targets if target.key == media_id]
        if not targets:
            print(f"error 找不到 media-id={media_id} 对应的电影。请先刷新电影索引。")
            return 1
    if args.category:
        targets = [target for target in targets if target.category == args.category]
    if keyword:
        targets = [
            target
            for target in targets
            if any(keyword in value for value in [target.movie_title, target.search_title, *target.samples] if value)
        ]
    if not args.refresh and not manual_subject_url:
        targets = [target for target in targets if not existing.get(target.key) or existing[target.key]["status"] != "ok" or not existing[target.key]["cover_bytes"]]
    if args.limit and args.limit > 0:
        targets = targets[: args.limit]

    scope = [
        f"分类={args.category}" if args.category else "全部分类",
        f"关键词={keyword}" if keyword else "",
        "刷新已有资料" if args.refresh else "只补缺失/无封面",
        f"上限={args.limit}" if args.limit and args.limit > 0 else "全量",
        f"media-id={media_id}" if media_id else "",
        f"手动豆瓣={manual_subject_url}" if manual_subject_url else "",
    ]
    print(f"豆瓣电影资料目标：{len(targets)} 部电影 ({'，'.join(item for item in scope if item)}) write={'yes' if args.write else 'no'} cookie={'yes' if cookie_header else 'no'} browser={args.browser_channel} headless={'yes' if args.headless else 'no'}")
    if targets and not args.category:
        print(f"分类分布：{category_summary(targets)}")
    if cookie_source:
        print(f"Cookie 来源：{cookie_source}")

    ok = 0
    failed = 0
    blocked = False
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=args.browser_channel or None, headless=args.headless)
        context = browser.new_context(
            user_agent=USER_AGENT,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            viewport={"width": 1365, "height": 900},
            extra_http_headers={
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
            },
        )
        if cookies:
            context.add_cookies(cookies)
        page = context.new_page()
        page.goto("https://movie.douban.com/", wait_until="domcontentloaded", timeout=args.detail_timeout_ms)

        for index_in_run, target in enumerate(targets):
            try:
                print(f"[{index_in_run + 1}/{len(targets)}] {target.category} / {target.movie_title} -> {target.search_title}")
                meta = fetch_subject_page_meta(page, manual_subject_url, args) if manual_subject_url else fetch_movie_meta_with_rate_limit(context, page, target, args)
                cover_blob, cover_mime = None, ""
                try:
                    cover_blob, cover_mime = fetch_cover(context, meta.get("coverUrl", ""))
                except Exception as cover_error:
                    print(f"  warn 封面未更新：{cover_error}")
                if args.write:
                    upsert_ok(conn, target, meta, cover_blob, cover_mime)
                ok += 1
                print(
                    f"  ok {meta.get('title') or '-'} {meta.get('year') or ''} "
                    f"rating={meta.get('rating') or '-'} detail={meta.get('detailSource') or '-'} cover={len(cover_blob or b'')}"
                )
            except DoubanBlockedError as error:
                blocked = True
                print(f"  blocked {error}")
                print("  已停止：豆瓣返回拦截/验证页，未把剩余作品写成 error。默认会弹出浏览器，完成验证后再继续；后台静默运行才加 --headless。")
                break
            except Exception as error:
                failed += 1
                if args.write:
                    upsert_error(conn, target, error)
                print(f"  error {error}")
            pause(args, index_in_run, len(targets))

        context.close()
        browser.close()
    conn.close()
    print(f"完成 ok={ok} failed={failed} blocked={'yes' if blocked else 'no'}")
    return 2 if blocked else 0


if __name__ == "__main__":
    raise SystemExit(main())
