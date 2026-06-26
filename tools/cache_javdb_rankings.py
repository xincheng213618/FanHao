import argparse
import json
import os
import random
import re
import shutil
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlparse

from bs4 import BeautifulSoup
from selenium.common.exceptions import TimeoutException

from code_parser import loose_code_key, normalize_code
from backfill_javdb_metadata import (  # noqa: E402
    AccessBlockedError,
    DEFAULT_CHROME_BINARY,
    DEFAULT_DB,
    DEFAULT_SHARED_PROFILE,
    JavDbClient,
    blocked_reason,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RANKING_BASE_URL = "https://javdb.com/rankings/top?t={key}"
DEFAULT_LISTS = ["y2025"]
DEFAULT_ALL_LISTS = [
    "",
    "censored",
    "uncensored",
    "western",
    "fc2",
    "y2026",
    "y2025",
    "y2024",
    "y2023",
    "y2022",
    "y2021",
    "y2020",
    "y2019",
    "y2018",
    "y2017",
    "y2016",
    "y2015",
    "y2014",
    "y2013",
    "y2012",
    "y2011",
]
LIST_LABELS = {
    "": "TOP250 全部",
    "all": "TOP250 全部",
    "censored": "TOP250 有码",
    "uncensored": "TOP250 无码",
    "western": "TOP250 欧美",
    "fc2": "TOP250 FC2",
}


@dataclass
class RankingEntry:
    list_type: str
    list_key: str
    list_label: str
    rank_no: int
    code: str
    code_key: str
    title: str
    detail_url: str
    image_url: str
    release_date: str = ""
    rating: float | None = None
    rating_count: int | None = None
    page_url: str = ""


def main() -> None:
    configure_stdout()
    args = parse_args()
    list_keys = normalize_list_keys(args)
    log_path = args.log or Path("data") / f"javdb-rankings-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    print(f"排行榜缓存开始: lists={list_keys} write={args.write} log={log_path}", flush=True)
    if not args.write:
        print("当前是 dry-run：会访问页面和解析，但不会写入数据库。真正写入请加 --write。", flush=True)

    runtime_profile = prepare_runtime_profile(args)
    client = JavDbClient(args)
    stats = {"ok": 0, "error": 0, "blocked": 0, "written": 0}
    try:
        with sqlite3.connect(args.db, timeout=30) as conn:
            ensure_schema(conn)
            prepared_pages = {}
            if args.discover_lists:
                try:
                    html, current_url = fetch_ranking_page(client, ranking_url(""), args.wait_seconds, 40)
                    discovered = discover_ranking_list_keys(html, current_url)
                    if discovered:
                        list_keys = discovered
                        prepared_pages[""] = (html, current_url)
                        print(f"发现榜单: {list_keys}", flush=True)
                    else:
                        print("没有从页面发现榜单，使用传入列表。", flush=True)
                except Exception as error:
                    print(f"发现榜单失败，使用传入列表: {error}", flush=True)

            for index, list_key in enumerate(list_keys, 1):
                try:
                    page_url = ranking_url(list_key)
                    prepared = prepared_pages.pop(canonical_list_key(list_key), None)
                    entries, current_url, page_count = fetch_ranking_entries(
                        client,
                        page_url,
                        args.wait_seconds,
                        args.target_count,
                        list_key,
                        prepared=prepared,
                    )
                    if args.write:
                        saved = save_rankings(conn, "top", canonical_list_key(list_key), entries)
                        conn.commit()
                        stats["written"] += saved
                    else:
                        saved = 0
                    stats["ok"] += 1
                    write_jsonl(
                        log_path,
                        {
                            "status": "ok",
                            "listKey": canonical_list_key(list_key),
                            "url": current_url,
                            "count": len(entries),
                            "pages": page_count,
                            "written": saved,
                        },
                    )
                    print(
                        f"[{index}/{len(list_keys)}] OK {ranking_label(list_key)} pages={page_count} entries={len(entries)} written={saved}",
                        flush=True,
                    )
                except AccessBlockedError as error:
                    stats["blocked"] += 1
                    write_jsonl(log_path, {"status": "blocked", "listKey": canonical_list_key(list_key), "error": str(error)})
                    print(f"[{index}/{len(list_keys)}] BLOCKED {ranking_label(list_key)}: {error}", flush=True)
                    break
                except Exception as error:
                    stats["error"] += 1
                    write_jsonl(log_path, {"status": "error", "listKey": canonical_list_key(list_key), "error": str(error)})
                    print(f"[{index}/{len(list_keys)}] ERROR {ranking_label(list_key)}: {error}", flush=True)
                pause(args)
    finally:
        client.close()
        cleanup_runtime_profile(runtime_profile)

    print("排行榜缓存结束: " + json.dumps(stats, ensure_ascii=False), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cache JavDB TOP250 ranking pages into FanHao SQLite cache.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--profile-dir", type=Path, default=DEFAULT_SHARED_PROFILE)
    parser.add_argument("--chrome-binary", type=Path, default=DEFAULT_CHROME_BINARY)
    parser.add_argument("--driver-path", type=Path, default=None)
    parser.add_argument("--proxy", default="http://127.0.0.1:10809")
    parser.add_argument("--no-proxy", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--no-profile-copy", action="store_true", help="直接使用 --profile-dir，不复制临时 profile。")
    parser.add_argument("--write", action="store_true", help="实际写入数据库；不加时为 dry-run")
    parser.add_argument("--list", action="append", default=[], help="榜单 key，可重复。例：y2025、all、censored、fc2")
    parser.add_argument("--all-defaults", action="store_true", help="缓存常用全部榜单：全部、有码、无码、欧美、FC2、近几年")
    parser.add_argument("--discover-lists", action="store_true", help="先访问排行榜首页，自动读取下拉框中的全部榜单 key。")
    parser.add_argument("--sleep", type=float, default=8.0, help="每个榜单后的基础等待秒数。")
    parser.add_argument("--jitter", type=float, default=4.0, help="额外随机等待秒数上限。")
    parser.add_argument("--fast", action="store_true", help="允许低于 5 秒的等待间隔；一般不建议。")
    parser.add_argument("--wait-seconds", type=int, default=35)
    parser.add_argument("--search-wait-seconds", type=int, default=25)
    parser.add_argument("--detail-wait-seconds", type=int, default=35)
    parser.add_argument("--target-count", type=int, default=250, help="每个 TOP 榜单期望抓到的条数；数量稳定后会提前结束。")
    parser.add_argument("--log", type=Path, default=None)
    return parser.parse_args()


def configure_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")


def prepare_runtime_profile(args: argparse.Namespace) -> Path | None:
    source = Path(args.profile_dir)
    if args.no_profile_copy or not source.exists():
        return None

    target_root = PROJECT_ROOT / "data" / "selenium-profile-runs"
    target = target_root / f"rankings-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
    target_root.mkdir(parents=True, exist_ok=True)
    print(f"复制浏览器 profile: {source} -> {target}", flush=True)
    shutil.copytree(source, target, ignore=ignore_profile_cache, copy_function=safe_copy2)
    args.profile_dir = target
    return target


def ignore_profile_cache(directory: str, names: list[str]) -> set[str]:
    ignored = set()
    cache_names = {
        "Cache",
        "Code Cache",
        "GPUCache",
        "GrShaderCache",
        "ShaderCache",
        "Crashpad",
        "BrowserMetrics",
        "Sessions",
        "Safe Browsing Network",
        "GPUPersistentCache",
    }
    for name in names:
        if name.startswith("Singleton"):
            ignored.add(name)
            continue
        if name in cache_names:
            ignored.add(name)
            continue
        lower = name.lower()
        if lower.endswith((".lock", ".tmp")):
            ignored.add(name)
    return ignored


def safe_copy2(src: str, dst: str) -> str:
    try:
        return shutil.copy2(src, dst)
    except OSError:
        return dst


def cleanup_runtime_profile(path: Path | None) -> None:
    if not path:
        return
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception as error:
        print(f"临时 profile 清理失败: {error}", flush=True)


def normalize_list_keys(args: argparse.Namespace) -> list[str]:
    raw = DEFAULT_ALL_LISTS if args.all_defaults else args.list or DEFAULT_LISTS
    result = []
    for key in raw:
        canonical = canonical_list_key(key)
        if canonical not in result:
            result.append(canonical)
    return result


def canonical_list_key(value: str | None) -> str:
    key = str(value or "").strip().lower()
    if key.lower() == "all":
        return ""
    year = re.fullmatch(r"y?(\d{4})", key, flags=re.I)
    if year:
        return f"y{year.group(1)}"
    return key


def ranking_label(list_key: str) -> str:
    key = canonical_list_key(list_key)
    if key in LIST_LABELS:
        return LIST_LABELS[key]
    year = re.fullmatch(r"y?(\d{4})", key, flags=re.I)
    if year:
        return f"TOP250 {year.group(1)}"
    return f"TOP250 {key}"


def ranking_url(list_key: str) -> str:
    return RANKING_BASE_URL.format(key=quote(canonical_list_key(list_key)))


def discover_ranking_list_keys(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html or "", "html.parser")
    discovered = []

    for option in soup.select("select option[value]"):
        key = ranking_key_from_value(option.get("value"), base_url)
        if is_ranking_list_key(key) and key not in discovered:
            discovered.append(key)

    for link in soup.select("a[href*='/rankings/top'], a[href*='rankings/top']"):
        key = ranking_key_from_value(link.get("href"), base_url)
        if is_ranking_list_key(key) and key not in discovered:
            discovered.append(key)

    if "" in discovered:
        discovered.remove("")
        discovered.insert(0, "")

    fixed_order = ["", "censored", "uncensored", "western", "fc2"]
    ordered = [key for key in fixed_order if key in discovered]
    years = sorted([key for key in discovered if re.fullmatch(r"y\d{4}", key)], reverse=True)
    rest = [key for key in discovered if key not in set(ordered + years)]
    return ordered + years + rest


def ranking_key_from_value(value: str | None, base_url: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""

    if raw in {"all", "censored", "uncensored", "western", "fc2"} or re.fullmatch(r"y?\d{4}", raw, flags=re.I):
        return canonical_list_key(raw)

    joined = urljoin(base_url, raw)
    parsed = urlparse(joined)
    params = parse_qs(parsed.query)
    if "t" in params:
        return canonical_list_key(params.get("t", [""])[0])
    return ""


def is_ranking_list_key(key: str) -> bool:
    if key in {"", "censored", "uncensored", "western", "fc2"}:
        return True
    return bool(re.fullmatch(r"y\d{4}", key))


def fetch_ranking_page(client: JavDbClient, url: str, wait_seconds: int, target_count: int = 250) -> tuple[str, str]:
    driver = client.get_driver()
    safe_driver_get(driver, url, wait_seconds)
    deadline = time.time() + max(5, wait_seconds)
    last_html = ""
    while time.time() < deadline:
        last_html = driver.page_source or ""
        reason = blocked_reason(last_html)
        if reason:
            raise AccessBlockedError(reason)
        if parse_ranking_page(last_html, driver.current_url, ""):
            return scroll_ranking_page(driver, wait_seconds, target_count)
        time.sleep(1.0)
    return last_html, driver.current_url


def scroll_ranking_page(driver, wait_seconds: int, target_count: int = 250) -> tuple[str, str]:
    target_count = max(1, int(target_count or 250))
    deadline = time.time() + max(20, int(wait_seconds or 20) * 3)
    last_count = -1
    last_height = -1
    stable_rounds = 0
    best_html = driver.page_source or ""
    best_count = len(parse_ranking_page(best_html, driver.current_url, ""))

    while time.time() < deadline:
        html = driver.page_source or ""
        reason = blocked_reason(html)
        if reason:
            raise AccessBlockedError(reason)

        count = len(parse_ranking_page(html, driver.current_url, ""))
        height, viewport, y = page_scroll_state(driver)
        if count > best_count:
            best_html = html
            best_count = count
        if count >= target_count:
            return html, driver.current_url

        if count == last_count and height == last_height:
            stable_rounds += 1
        else:
            stable_rounds = 0
        if count > 0 and stable_rounds >= 5:
            return best_html, driver.current_url

        last_count = count
        last_height = height
        scroll_step = max(700, int(viewport * 0.9))
        next_y = min(max(height - viewport, 0), int(y + scroll_step))
        if next_y <= y + 8:
            driver.execute_script("window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);")
        else:
            driver.execute_script("window.scrollTo(0, arguments[0]);", next_y)
        time.sleep(1.0)

    return best_html, driver.current_url


def page_scroll_state(driver) -> tuple[int, int, int]:
    try:
        return tuple(
            int(value or 0)
            for value in driver.execute_script(
                """
                return [
                  Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
                  window.innerHeight || document.documentElement.clientHeight || 900,
                  window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0
                ];
                """
            )
        )
    except Exception:
        return 0, 900, 0


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


def fetch_ranking_entries(
    client: JavDbClient,
    first_url: str,
    wait_seconds: int,
    target_count: int,
    list_key: str,
    prepared: tuple[str, str] | None = None,
) -> tuple[list[RankingEntry], str, int]:
    target_count = max(1, int(target_count or 250))
    entries: list[RankingEntry] = []
    seen = set()
    page_url = first_url
    current_url = first_url
    page_count = 0

    while page_url and len(entries) < target_count and page_count < 20:
        page_count += 1
        if page_count == 1 and prepared:
            html, current_url = prepared
        else:
            html, current_url = fetch_ranking_page(client, page_url, wait_seconds, min(target_count, 40))

        page_entries = parse_ranking_page(html, current_url, list_key)
        if not page_entries:
            break

        for entry in page_entries:
            if entry.code_key in seen:
                continue
            seen.add(entry.code_key)
            entry.rank_no = len(entries) + 1
            entries.append(entry)
            if len(entries) >= target_count:
                break

        if len(entries) >= target_count:
            break

        next_url = next_ranking_page_url(html, current_url)
        if not next_url or next_url == page_url:
            break
        page_url = next_url
        time.sleep(1.2)

    return entries, current_url, page_count


def next_ranking_page_url(html: str, base_url: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    next_link = soup.select_one("a.pagination-next[href], a[rel='next'][href]")
    if next_link:
        href = next_link.get("href") or ""
        if href and "disabled" not in (next_link.get("class") or []):
            return urljoin(base_url, href)

    current_page = current_pagination_page(soup)
    candidates = []
    for link in soup.select(".pagination a[href], a.pagination-link[href]"):
        text = link.get_text(" ", strip=True)
        if not text.isdigit():
            continue
        page_no = int(text)
        if page_no > current_page:
            candidates.append((page_no, urljoin(base_url, link.get("href") or "")))
    if candidates:
        candidates.sort(key=lambda item: item[0])
        return candidates[0][1]
    return ""


def current_pagination_page(soup: BeautifulSoup) -> int:
    current = soup.select_one(".pagination-link.is-current, .pagination .is-current")
    if current:
        text = current.get_text(" ", strip=True)
        if text.isdigit():
            return int(text)
    return 1


def parse_ranking_page(html: str, base_url: str, list_key: str) -> list[RankingEntry]:
    soup = BeautifulSoup(html or "", "html.parser")
    entries = []
    seen = set()
    for position, item in enumerate(ranking_items(soup), 1):
        link = item.select_one("a.box[href*='/v/'], a[href*='/v/']")
        href = link.get("href") if link else ""
        if not href:
            continue

        strong = item.select_one("strong")
        title_tag = item.select_one(".video-title, .title")
        text = item.get_text(" ", strip=True)
        raw_code = strong.get_text(" ", strip=True) if strong else text
        code = normalize_code(raw_code) or normalize_code(text)
        if not code:
            continue

        code_key = loose_code_key(code).lower()
        if not code_key or code_key in seen:
            continue
        seen.add(code_key)

        image = item.select_one("img.video-cover, img.cover, img")
        image_src = ""
        if image:
            image_src = image.get("src") or image.get("data-src") or image.get("data-original") or ""

        facts = parse_card_facts(item)
        title = title_tag.get_text(" ", strip=True) if title_tag else text
        rank_no = parse_rank_no(item, text) or position
        entries.append(
            RankingEntry(
                list_type="top",
                list_key=canonical_list_key(list_key),
                list_label=ranking_label(list_key),
                rank_no=rank_no,
                code=code,
                code_key=code_key,
                title=clean_title(title, code),
                detail_url=urljoin(base_url, href),
                image_url=urljoin(base_url, image_src) if image_src else "",
                release_date=facts["release_date"],
                rating=facts["rating"],
                rating_count=facts["rating_count"],
                page_url=base_url,
            )
        )

    entries.sort(key=lambda item: (item.rank_no, item.code))
    return entries


def ranking_items(soup: BeautifulSoup) -> list:
    items = []
    for selector in (".movie-list .item", ".grid .item", ".movie-panel", ".item"):
        for item in soup.select(selector):
            if item.select_one("a[href*='/v/']") and item not in items:
                items.append(item)
    return items


def parse_rank_no(item, text: str) -> int | None:
    for selector in (".rank", ".ranking", ".rank-no", ".rank-number", ".number"):
        node = item.select_one(selector)
        if not node:
            continue
        match = re.search(r"\b(\d{1,3})\b", node.get_text(" ", strip=True))
        if match:
            return int(match.group(1))
    match = re.match(r"\s*(\d{1,3})\b", text or "")
    if match:
        return int(match.group(1))
    return None


def clean_title(value: str, code: str) -> str:
    title = re.sub(r"\s+", " ", str(value or "")).strip()
    if code and title.upper().startswith(code.upper()):
        title = title[len(code) :].strip(" -_　")
    return title or code


def parse_card_facts(item) -> dict:
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

    return {"release_date": release_date, "rating": rating, "rating_count": rating_count}


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS javdb_rankings (
          list_type TEXT NOT NULL,
          list_key TEXT NOT NULL DEFAULT '',
          list_label TEXT,
          rank_no INTEGER NOT NULL,
          code TEXT NOT NULL,
          code_key TEXT NOT NULL,
          title TEXT,
          detail_url TEXT,
          image_url TEXT,
          release_date TEXT,
          rating REAL,
          rating_count INTEGER,
          page_url TEXT,
          fetched_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(list_type, list_key, code_key)
        );
        CREATE INDEX IF NOT EXISTS idx_javdb_rankings_list ON javdb_rankings(list_type, list_key, rank_no);
        CREATE INDEX IF NOT EXISTS idx_javdb_rankings_code_key ON javdb_rankings(code_key);
        """
    )


def save_rankings(conn: sqlite3.Connection, list_type: str, list_key: str, entries: list[RankingEntry]) -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    conn.execute("DELETE FROM javdb_rankings WHERE list_type = ? AND list_key = ?", (list_type, list_key))
    saved = 0
    for entry in entries:
        conn.execute(
            """
            INSERT INTO javdb_rankings (
              list_type, list_key, list_label, rank_no, code, code_key, title, detail_url, image_url,
              release_date, rating, rating_count, page_url, fetched_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(list_type, list_key, code_key) DO UPDATE SET
              list_label = excluded.list_label,
              rank_no = excluded.rank_no,
              code = excluded.code,
              title = excluded.title,
              detail_url = excluded.detail_url,
              image_url = excluded.image_url,
              release_date = excluded.release_date,
              rating = excluded.rating,
              rating_count = excluded.rating_count,
              page_url = excluded.page_url,
              updated_at = excluded.updated_at
            """,
            (
                list_type,
                list_key,
                entry.list_label,
                entry.rank_no,
                entry.code,
                entry.code_key,
                entry.title,
                entry.detail_url,
                entry.image_url,
                entry.release_date or None,
                entry.rating,
                entry.rating_count,
                entry.page_url,
                now,
                now,
            ),
        )
        saved += 1
    return saved


def pause(args: argparse.Namespace) -> None:
    base = max(0.0, float(args.sleep or 0))
    jitter = max(0.0, float(args.jitter or 0))
    if not args.fast:
        base = max(base, 5.0)
    delay = base + (random.random() * jitter if jitter else 0)
    if delay:
        time.sleep(delay)


def write_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
