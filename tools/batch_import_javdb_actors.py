import argparse
import json
import mimetypes
import random
import re
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from code_parser import normalize_code
from import_javdb_actor import (
    DEFAULT_CHROME_BINARY,
    DEFAULT_DB,
    DEFAULT_LIBRARY_INDEX,
    DEFAULT_SHARED_PROFILE,
    actor_id_from_url,
    browser_cookies,
    download_avatar,
    ensure_schema,
    get_driver,
    is_actor_avatar_url,
    parse_actor_page,
    profile_looks_ready,
    save_profile,
    wait_for_actor_page,
)


SKIP_PERSON_NAMES = {"noactor", "VR"}
SKIP_ACTOR_IDS = {"censored", "uncensored", "western"}
SEARCH_URL = "https://javdb.com/search?q={query}&f=actor"
class AccessBlockedError(RuntimeError):
    pass


def blocked_reason(html: str) -> str:
    text = BeautifulSoup(html or "", "html.parser").get_text(" ", strip=True)
    lower = text.lower()
    if "banned your access" in lower or "禁止了你的訪問" in text or "禁止了你的访问" in text:
        return text[:500]
    return ""


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
    if path == "v:/[a]" or path.startswith("v:/[a]/"):
        return 5
    if path == "v:/[a1]" or path.startswith("v:/[a1]/"):
        return 6
    if path == "v:/av" or path.startswith("v:/av/"):
        return 7
    if path.startswith("v:/"):
        return 8
    return 9


def person_source_priority(person: dict) -> int:
    paths = [*(person.get("sourcePaths") or []), person.get("relativePath") or ""]
    return min((source_priority(path) for path in paths if path), default=9)


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
    if not prefixes:
        return True
    paths = [*(person.get("sourcePaths") or []), person.get("relativePath") or ""]
    return any(source_path_matches(path, prefix) for path in paths for prefix in prefixes)


def is_special_person(person: dict) -> bool:
    name = str(person.get("name") or "").strip()
    if not name or name in SKIP_PERSON_NAMES:
        return True
    return bool(re.fullmatch(r"\[[^\]]*]", name))


def work_code(work: dict) -> str:
    return normalize_code(f"{work.get('directoryName') or ''} {work.get('title') or ''}")


def load_people(library_index: Path, include_special: bool, min_work_count: int, source_prefixes: list[str]) -> list[dict]:
    data = json.loads(library_index.read_text(encoding="utf-8"))
    people = [
        person
        for person in data.get("people", [])
        if int(person.get("workCount") or 0) >= min_work_count and (include_special or not is_special_person(person))
        and person_matches_source(person, source_prefixes)
    ]
    return sorted(
        people,
        key=lambda person: (
            person_source_priority(person),
            -int(person.get("workCount") or 0),
            str(person.get("name") or ""),
        ),
    )


def load_works_by_id(library_index: Path) -> dict[str, dict]:
    data = json.loads(library_index.read_text(encoding="utf-8"))
    return {work.get("id"): work for work in data.get("works", []) if work.get("id")}


def cached_ok(db_path: Path, person_id: str) -> bool:
    if not db_path.exists():
        return False
    with sqlite3.connect(db_path) as conn:
        ensure_schema(conn)
        row = conn.execute(
            """
            SELECT status, avatar_blob, avatar_url
            FROM actor_profiles
            WHERE person_id = ?
            """,
            (person_id,),
        ).fetchone()
    return bool(row and row[0] == "ok" and row[1] and is_actor_avatar_url(row[2] or ""))


def cached_work_cover_ids(db_path: Path, work_ids: list[str]) -> set[str]:
    if not work_ids or not db_path.exists():
        return set()
    with sqlite3.connect(db_path) as conn:
        ensure_schema(conn)
        placeholders = ",".join("?" for _ in work_ids)
        rows = conn.execute(
            f"""
            SELECT work_id
            FROM work_covers
            WHERE cover_blob IS NOT NULL AND work_id IN ({placeholders})
            """,
            work_ids,
        ).fetchall()
    return {row[0] for row in rows}


def missing_cover_works(person: dict, works_by_id: dict[str, dict], db_path: Path) -> list[dict]:
    works = [works_by_id.get(work_id) for work_id in person.get("works", [])]
    missing = [work for work in works if work and not work.get("coverId") and work_code(work)]
    cached_ids = cached_work_cover_ids(db_path, [work["id"] for work in missing])
    return [work for work in missing if work["id"] not in cached_ids]


def save_error(db_path: Path, person: dict, error: str, javdb_url: str = "", display_name: str = "") -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    with sqlite3.connect(db_path) as conn:
        ensure_schema(conn)
        conn.execute(
            """
            INSERT INTO actor_profiles (
              person_id, person_name, javdb_actor_id, javdb_url, display_name, aliases_json,
              movie_count, avatar_url, avatar_mime, avatar_blob, source, status, error, fetched_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, NULL, 'javdb', 'error', ?, ?, ?)
            ON CONFLICT(person_id) DO UPDATE SET
              person_name = excluded.person_name,
              javdb_actor_id = COALESCE(excluded.javdb_actor_id, actor_profiles.javdb_actor_id),
              javdb_url = COALESCE(excluded.javdb_url, actor_profiles.javdb_url),
              display_name = COALESCE(excluded.display_name, actor_profiles.display_name, excluded.person_name),
              avatar_url = CASE WHEN actor_profiles.source = 'local-avatar' OR actor_profiles.avatar_url LIKE '%/avatars/%' THEN actor_profiles.avatar_url ELSE NULL END,
              avatar_mime = CASE WHEN actor_profiles.source = 'local-avatar' OR actor_profiles.avatar_url LIKE '%/avatars/%' THEN actor_profiles.avatar_mime ELSE NULL END,
              avatar_blob = CASE WHEN actor_profiles.source = 'local-avatar' OR actor_profiles.avatar_url LIKE '%/avatars/%' THEN actor_profiles.avatar_blob ELSE NULL END,
              source = excluded.source,
              status = excluded.status,
              error = excluded.error,
              fetched_at = excluded.fetched_at,
              updated_at = excluded.updated_at
            """,
            (
                person["id"],
                person["name"],
                actor_id_from_url(javdb_url) or None,
                javdb_url or None,
                display_name or person["name"],
                error[:1000],
                now,
                now,
            ),
        )


def normalize_name(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "").strip()).lower()


def search_terms(value: str) -> list[str]:
    name = str(value or "").strip()
    terms = []

    def add(term: str) -> None:
        term = term.strip()
        if term and term not in terms:
            terms.append(term)

    add(name)
    bracket_match = re.match(r"^\[([^\]]+)]\s*(.+)?$", name)
    if bracket_match:
        inner = bracket_match.group(1).strip()
        rest = (bracket_match.group(2) or "").strip()
        if inner and not re.fullmatch(r"[A-Za-z0-9]+", inner):
            add(inner)
        add(rest)

    without_brackets = re.sub(r"\[[^\]]+]", " ", name)
    without_brackets = re.sub(r"\s+", " ", without_brackets).strip()
    add(without_brackets)
    return terms


def candidate_aliases(candidate: dict) -> list[str]:
    return [item.strip() for item in re.split(r"[,，、]", str(candidate.get("name") or "")) if item.strip()]


def actor_candidates_from_search(html: str, base_url: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    candidates = []
    seen = set()
    for link in soup.select(".actors .actor-box a[href*='/actors/'], a[href*='/actors/']"):
        href = link.get("href") or ""
        actor_id = actor_id_from_url(href)
        if not actor_id or actor_id.lower() in SKIP_ACTOR_IDS or actor_id in seen:
            continue
        seen.add(actor_id)
        strong = link.select_one("strong")
        title = (link.get("title") or (strong.get_text(" ", strip=True) if strong else link.get_text(" ", strip=True))).strip()
        img = link.select_one("img.avatar, img")
        avatar_url = img.get("src") if img and img.get("src") else ""
        candidates.append(
            {
                "actor_id": actor_id,
                "name": title,
                "url": urljoin(base_url, href),
                "avatar_url": urljoin(base_url, avatar_url) if avatar_url else "",
            }
        )
    return candidates


def actor_movie_covers_from_page(html: str, base_url: str) -> dict[str, dict]:
    soup = BeautifulSoup(html, "html.parser")
    covers = {}
    selectors = [".movie-list .item", ".item", ".movie-panel"]
    seen_nodes = []
    for selector in selectors:
        for item in soup.select(selector):
            if item in seen_nodes:
                continue
            seen_nodes.append(item)
            text = item.get_text(" ", strip=True)
            code = normalize_code(text)
            if not code:
                continue
            img = item.select_one("img.video-cover, img.cover, img")
            cover_url = img.get("src") if img and img.get("src") else ""
            if not cover_url or "/covers/" not in cover_url.lower():
                continue
            title_tag = item.select_one(".video-title, .title, strong")
            title = title_tag.get_text(" ", strip=True) if title_tag else text
            covers.setdefault(
                code,
                {
                    "video_id": code,
                    "title": title,
                    "cover_url": urljoin(base_url, cover_url),
                },
            )
    return covers


def choose_candidate(person_name: str, candidates: list[dict]) -> dict | None:
    target = normalize_name(person_name)
    if not target:
        return None

    scored = []
    for index, candidate in enumerate(candidates):
        aliases = [normalize_name(alias) for alias in candidate_aliases(candidate)]
        name = normalize_name(candidate.get("name"))
        avatar_score = 10 if is_actor_avatar_url(candidate.get("avatar_url", "")) else 0
        score = 0
        if target in aliases:
            score += 100
        elif name == target:
            score += 90
        elif target in name or name in target:
            score += 40
        else:
            continue
        scored.append((score + avatar_score, -index, candidate))

    if not scored:
        avatar_candidates = [candidate for candidate in candidates if is_actor_avatar_url(candidate.get("avatar_url", ""))]
        if len(target) >= 2 and candidates and candidates[0] in avatar_candidates and len(candidates) <= 3:
            return candidates[0]
        if len(target) >= 2 and len(avatar_candidates) == 1 and len(candidates) <= 3:
            return avatar_candidates[0]
        return None
    scored.sort(reverse=True)
    if len(scored) > 1 and scored[0][0] == scored[1][0]:
        return None
    return scored[0][2]


def wait_for_search_candidates(driver, person_name: str, wait_seconds: int) -> tuple[list[dict], str]:
    last_candidates = []
    last_url = ""
    for term in search_terms(person_name):
        url = SEARCH_URL.format(query=quote(term))
        driver.get(url)
        deadline = time.time() + wait_seconds
        candidates = []
        while time.time() < deadline:
            reason = blocked_reason(driver.page_source)
            if reason:
                raise AccessBlockedError(reason)
            candidates = actor_candidates_from_search(driver.page_source, driver.current_url)
            if candidates:
                return candidates, driver.current_url
            if "rucaptcha" not in driver.current_url.lower() and "rucaptcha" not in driver.page_source.lower():
                break
            time.sleep(3)
        last_candidates = candidates
        last_url = driver.current_url
    return last_candidates, last_url


def write_jsonl(log_path: Path, payload: dict) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def download_image(url: str, driver, referer: str) -> tuple[bytes, str]:
    if not url:
        return b"", ""
    session = requests.Session()
    session.cookies = browser_cookies(driver)
    session.headers.update({
        "User-Agent": driver.execute_script("return navigator.userAgent") or "Mozilla/5.0",
        "Referer": referer or driver.current_url,
    })
    response = session.get(url, timeout=30)
    response.raise_for_status()
    mime = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
    if not mime:
        mime = mimetypes.guess_type(urlparse(url).path)[0] or "image/jpeg"
    return response.content, mime


def save_work_cover(db_path: Path, person: dict, work: dict, cover: dict, cover_bytes: bytes, cover_mime: str) -> None:
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    with sqlite3.connect(db_path) as conn:
        ensure_schema(conn)
        conn.execute(
            """
            INSERT INTO work_covers (
              work_id, person_id, person_name, video_id, title, cover_url, cover_mime,
              cover_blob, source, fetched_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'javdb', ?, ?)
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
                work["id"],
                person["id"],
                person["name"],
                cover.get("video_id") or work_code(work),
                cover.get("title") or work.get("title") or work.get("directoryName") or "",
                cover.get("cover_url"),
                cover_mime,
                cover_bytes,
                now,
                now,
            ),
        )


def cache_missing_work_covers(db_path: Path, person: dict, works: list[dict], html: str, base_url: str, driver) -> int:
    if not works:
        return 0
    remote_covers = actor_movie_covers_from_page(html, base_url)
    if not remote_covers:
        return 0

    added = 0
    for work in works:
        code = work_code(work)
        cover = remote_covers.get(code)
        if not cover:
            continue
        cover_bytes, cover_mime = download_image(cover.get("cover_url", ""), driver, base_url)
        save_work_cover(db_path, person, work, cover, cover_bytes, cover_mime)
        added += 1
    return added


def main() -> None:
    parser = argparse.ArgumentParser(description="Batch import JavDB actor profiles into FanHao SQLite cache.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--library-index", type=Path, default=DEFAULT_LIBRARY_INDEX)
    parser.add_argument("--profile-dir", type=Path, default=DEFAULT_SHARED_PROFILE)
    parser.add_argument("--chrome-binary", type=Path, default=DEFAULT_CHROME_BINARY)
    parser.add_argument("--driver-path", type=Path, default=None)
    parser.add_argument("--proxy", default="http://127.0.0.1:10809")
    parser.add_argument("--no-proxy", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--refresh", action="store_true", help="刷新已经有头像缓存的人物")
    parser.add_argument("--include-special", action="store_true", help="包含 [A]、[]、noactor 等特殊目录")
    parser.add_argument("--source-prefix", action="append", default=[], help="只处理这些本机路径前缀；可重复。不传则所有来源。例：F:/ 或 O:/[珍藏]")
    parser.add_argument("--min-work-count", type=int, default=1)
    parser.add_argument("--max", type=int, default=0, help="最多处理多少个人物；0 表示不限制")
    parser.add_argument("--search-wait-seconds", type=int, default=20)
    parser.add_argument("--profile-wait-seconds", type=int, default=45)
    parser.add_argument("--sleep", type=float, default=8.0, help="每个人物处理后的基础等待秒数；默认偏慢，避免触发风控。")
    parser.add_argument("--jitter", type=float, default=4.0, help="额外随机等待秒数上限。")
    parser.add_argument("--fast", action="store_true", help="允许低于 5 秒的等待间隔；一般不建议。")
    parser.add_argument("--log", type=Path, default=None)
    parser.add_argument("--cache-covers", action="store_true", help="顺手缓存本地缺封面的作品封面；默认关闭")
    args = parser.parse_args()

    log_path = args.log or (args.db.parent / f"actor-profile-batch-{time.strftime('%Y%m%d-%H%M%S')}.jsonl")
    people = load_people(args.library_index, args.include_special, args.min_work_count, args.source_prefix)
    works_by_id = load_works_by_id(args.library_index) if args.cache_covers else {}
    if args.max > 0:
        people = people[: args.max]

    summary = {"total": len(people), "ok": 0, "skip": 0, "not_found": 0, "error": 0}
    print(f"批量开始: total={summary['total']} log={log_path}", flush=True)

    driver = get_driver(args.profile_dir, "" if args.no_proxy else args.proxy, args.headless, args.chrome_binary, args.driver_path)
    try:
        for index, person in enumerate(people, 1):
            name = str(person.get("name") or "")
            actor_cached = cached_ok(args.db, person["id"])
            cover_targets = missing_cover_works(person, works_by_id, args.db) if args.cache_covers else []
            if not args.refresh and actor_cached and not cover_targets:
                summary["skip"] += 1
                print(f"[{index}/{summary['total']}] SKIP {name}", flush=True)
                continue

            try:
                candidates, search_url = wait_for_search_candidates(driver, name, args.search_wait_seconds)
                candidate = choose_candidate(name, candidates)
                if not candidate:
                    message = f"未找到唯一演员页，候选={len(candidates)}"
                    summary["not_found"] += 1
                    save_error(args.db, person, message)
                    write_jsonl(log_path, {"status": "not_found", "personId": person["id"], "name": name, "searchUrl": search_url, "candidates": candidates[:5]})
                    print(f"[{index}/{summary['total']}] MISS {name} ({len(candidates)} candidates)", flush=True)
                    pause(args)
                    continue

                driver.get(candidate["url"])
                reason = blocked_reason(driver.page_source)
                if reason:
                    raise AccessBlockedError(reason)
                profile = wait_for_actor_page(driver, candidate["url"], args.profile_wait_seconds)
                reason = blocked_reason(driver.page_source)
                if reason:
                    raise AccessBlockedError(reason)
                if not profile.get("display_name"):
                    profile["display_name"] = candidate.get("name") or name
                if not is_actor_avatar_url(profile.get("avatar_url", "")) and is_actor_avatar_url(candidate.get("avatar_url", "")):
                    profile["avatar_url"] = candidate["avatar_url"]

                covers_cached = cache_missing_work_covers(args.db, person, cover_targets, driver.page_source, candidate["url"], driver)
                if not profile_looks_ready(profile):
                    if actor_cached and covers_cached:
                        summary["ok"] += 1
                        write_jsonl(
                            log_path,
                            {
                                "status": "covers",
                                "personId": person["id"],
                                "name": name,
                                "javdbActorId": profile.get("javdb_actor_id"),
                                "javdbUrl": profile.get("javdb_url"),
                                "coversCached": covers_cached,
                            },
                        )
                        print(f"[{index}/{summary['total']}] COVERS {name} ({covers_cached})", flush=True)
                        pause(args)
                        continue
                    raise RuntimeError(f"演员页资料不完整: {profile}")

                avatar_bytes = b""
                if args.refresh or not actor_cached:
                    avatar_bytes, avatar_mime = download_avatar(profile.get("avatar_url", ""), driver)
                    save_profile(args.db, person, profile, avatar_bytes, avatar_mime)
                summary["ok"] += 1
                write_jsonl(
                    log_path,
                    {
                        "status": "ok",
                        "personId": person["id"],
                        "name": name,
                        "displayName": profile.get("display_name") or name,
                        "javdbActorId": profile.get("javdb_actor_id"),
                        "javdbUrl": profile.get("javdb_url"),
                        "avatarBytes": len(avatar_bytes),
                        "coversCached": covers_cached,
                    },
                )
                print(f"[{index}/{summary['total']}] OK {name} -> {profile.get('display_name') or name} ({len(avatar_bytes)} bytes, covers={covers_cached})", flush=True)
            except AccessBlockedError as error:
                summary["error"] += 1
                write_jsonl(log_path, {"status": "blocked", "personId": person.get("id"), "name": name, "error": str(error)})
                print(f"[{index}/{summary['total']}] BLOCKED {name}: {error}", flush=True)
                break
            except Exception as error:
                summary["error"] += 1
                save_error(args.db, person, str(error))
                write_jsonl(log_path, {"status": "error", "personId": person.get("id"), "name": name, "error": str(error)})
                print(f"[{index}/{summary['total']}] ERROR {name}: {error}", flush=True)
            pause(args)
    finally:
        driver.quit()

    print("批量完成: " + json.dumps(summary, ensure_ascii=False), flush=True)


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
        print("批量中断", file=sys.stderr)
