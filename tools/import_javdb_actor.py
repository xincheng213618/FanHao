import argparse
import json
import mimetypes
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "data" / "actor-profiles.sqlite"
DEFAULT_LIBRARY_INDEX = PROJECT_ROOT / "data" / "library-index.json"
DEFAULT_SHARED_PROFILE = Path(r"C:\Users\17917\Desktop\Tool\data\selenium_user_data")
DEFAULT_CHROME_BINARY = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
DEFAULT_WDM_CHROMEDRIVER_ROOT = Path.home() / ".wdm" / "drivers" / "chromedriver" / "win64"


def actor_id_from_url(url: str) -> str:
    match = re.search(r"/actors/([^/?#]+)", url)
    return match.group(1) if match else ""


def css_background_image_url(style: str) -> str:
    match = re.search(r"background-image\s*:\s*url\((['\"]?)(.*?)\1\)", style or "", re.IGNORECASE)
    return match.group(2).strip() if match else ""


def is_actor_avatar_url(value: str) -> bool:
    lower = str(value or "").lower()
    if not lower or "rucaptcha" in lower:
        return False
    bad_tokens = ["mc.yandex", "analytics", "counter", "favicon", "logo", "/covers/"]
    if any(token in lower for token in bad_tokens):
        return False
    return "/avatars/" in lower or "avatar" in lower


def resolve_person(library_index: Path, name: str = "", person_id: str = "") -> dict:
    data = json.loads(library_index.read_text(encoding="utf-8"))
    people = data.get("people", [])
    if person_id:
      for person in people:
          if person.get("id") == person_id:
              return person
      raise SystemExit(f"找不到 person_id: {person_id}")

    exact = [person for person in people if person.get("name") == name]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise SystemExit(f"人物名不唯一: {name}")

    fuzzy = [person for person in people if name and name in person.get("name", "")]
    if len(fuzzy) == 1:
        return fuzzy[0]
    if fuzzy:
        names = ", ".join(person.get("name", "") for person in fuzzy[:10])
        raise SystemExit(f"人物名匹配到多个结果，请用 --person-id: {names}")
    raise SystemExit(f"找不到人物: {name}")


def version_key(value: str) -> tuple:
    return tuple(int(part) for part in re.findall(r"\d+", value))


def latest_cached_chromedriver(root: Path = DEFAULT_WDM_CHROMEDRIVER_ROOT) -> Path | None:
    if not root.exists():
        return None

    drivers = sorted(root.glob("*/chromedriver-win32/chromedriver.exe"), key=lambda item: version_key(str(item)), reverse=True)
    return drivers[0] if drivers else None


def get_driver(profile_dir: Path, proxy: str = "", headless: bool = False, chrome_binary: Path = DEFAULT_CHROME_BINARY, driver_path: Path | None = None):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service

    options = Options()
    if chrome_binary.exists():
        options.binary_location = str(chrome_binary)
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    if proxy:
        options.add_argument(f"--proxy-server={proxy}")
    if headless:
        options.add_argument("--headless=new")

    resolved_driver = driver_path if driver_path and driver_path.exists() else latest_cached_chromedriver()
    if resolved_driver:
        return webdriver.Chrome(service=Service(str(resolved_driver)), options=options)
    return webdriver.Chrome(options=options)


def parse_actor_page(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    title = ""
    title_tag = soup.select_one(".actor-section-name")
    if title_tag and title_tag.get_text(strip=True):
        title = title_tag.get_text(" ", strip=True)

    for selector in [".actor-section h1", ".actor-section h2", "h1", "h2"]:
        if title:
            break
        tag = soup.select_one(selector)
        if tag and tag.get_text(strip=True):
            title = re.sub(r"\s*\d+\s*部影片.*$", "", tag.get_text(" ", strip=True)).strip()
            break

    aliases = []
    alias_container = soup.select_one(".actor-section-aliases, .actor-aliases, .section-aliases")
    if alias_container:
        alias_text = alias_container.get_text(" ", strip=True)
        aliases = [item.strip() for item in re.split(r"[,，、]", alias_text) if item.strip()]

    if not aliases and title and any(mark in title for mark in [",", "，", "、"]):
        parts = [item.strip() for item in re.split(r"[,，、]", title) if item.strip()]
        if len(parts) > 1:
            aliases = parts[1:]

    aliases = [alias for alias in aliases if alias and alias != title]

    movie_count = None
    for selector in [".section-meta", ".actor-section-meta"]:
        meta = soup.select_one(selector)
        if meta:
            count_match = re.search(r"(\d+)\s*部影片", meta.get_text(" ", strip=True))
            if count_match:
                movie_count = int(count_match.group(1))
                break

    count_match = re.search(r"(\d+)\s*部影片", soup.get_text(" ", strip=True))
    if movie_count is None and count_match:
        movie_count = int(count_match.group(1))

    avatar_url = ""
    for selector in [
        ".actor-avatar .avatar",
        ".actor-section .avatar",
        ".avatar[style*='background-image']",
    ]:
        tag = soup.select_one(selector)
        if not tag:
            continue
        style_url = css_background_image_url(tag.get("style", ""))
        if is_actor_avatar_url(style_url):
            avatar_url = style_url
            break

    selectors = [
        ".actor-avatar img",
        ".actor-section img.avatar",
        ".actor-profile img.avatar",
        ".avatar img",
        "img.avatar",
    ]
    if not avatar_url:
        for selector in selectors:
            img = soup.select_one(selector)
            if img and is_actor_avatar_url(img.get("src", "")):
                avatar_url = img["src"]
                break

    if not avatar_url:
        for img in soup.find_all("img"):
            src = img.get("src") or ""
            if is_actor_avatar_url(src):
                avatar_url = src
                break

    if avatar_url:
        avatar_url = urljoin(url, avatar_url)

    return {
        "display_name": title,
        "aliases": aliases,
        "movie_count": movie_count,
        "avatar_url": avatar_url,
        "javdb_actor_id": actor_id_from_url(url),
        "javdb_url": url,
    }


def profile_looks_ready(profile: dict) -> bool:
    avatar_url = profile.get("avatar_url") or ""
    return bool(profile.get("display_name") and is_actor_avatar_url(avatar_url))


def wait_for_actor_page(driver, url: str, wait_seconds: int) -> dict:
    deadline = time.time() + wait_seconds
    started_at = time.time()
    last_profile = {}

    while time.time() < deadline:
        last_profile = parse_actor_page(driver.page_source, url)
        if profile_looks_ready(last_profile):
            return last_profile
        page_lower = driver.page_source.lower()
        if last_profile.get("display_name") and "rucaptcha" not in page_lower and time.time() - started_at >= 5:
            return last_profile
        print("等待 JavDB 演员页通过验证或完成加载...", flush=True)
        time.sleep(5)

    if last_profile:
        return last_profile
    return parse_actor_page(driver.page_source, url)


def browser_cookies(driver) -> requests.cookies.RequestsCookieJar:
    jar = requests.cookies.RequestsCookieJar()
    for cookie in driver.get_cookies():
        jar.set(cookie["name"], cookie["value"], domain=cookie.get("domain"), path=cookie.get("path", "/"))
    return jar


def download_avatar(url: str, driver) -> tuple[bytes, str]:
    if not url:
        return b"", ""
    if not is_actor_avatar_url(url):
        raise RuntimeError(f"当前 URL 不是演员头像：{url}")

    session = requests.Session()
    session.cookies = browser_cookies(driver)
    session.headers.update({
        "User-Agent": driver.execute_script("return navigator.userAgent") or "Mozilla/5.0",
        "Referer": driver.current_url,
    })
    response = session.get(url, timeout=30)
    response.raise_for_status()
    mime = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
    if not mime:
        mime = mimetypes.guess_type(urlparse(url).path)[0] or "image/jpeg"
    return response.content, mime


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS actor_profiles (
          person_id TEXT PRIMARY KEY,
          person_name TEXT NOT NULL,
          javdb_actor_id TEXT,
          javdb_url TEXT,
          display_name TEXT,
          aliases_json TEXT,
          movie_count INTEGER,
          avatar_url TEXT,
          avatar_mime TEXT,
          avatar_blob BLOB,
          source TEXT,
          status TEXT NOT NULL DEFAULT 'ok',
          error TEXT,
          fetched_at TEXT,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_actor_profiles_name ON actor_profiles(person_name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_actor_profiles_javdb_actor_id ON actor_profiles(javdb_actor_id)")
    conn.execute(
        """
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
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_work_covers_person_id ON work_covers(person_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_work_covers_video_id ON work_covers(video_id)")


def save_profile(db_path: Path, person: dict, profile: dict, avatar_bytes: bytes, avatar_mime: str) -> None:
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'javdb', 'ok', NULL, ?, ?)
            ON CONFLICT(person_id) DO UPDATE SET
              person_name = excluded.person_name,
              javdb_actor_id = excluded.javdb_actor_id,
              javdb_url = excluded.javdb_url,
              display_name = excluded.display_name,
              aliases_json = excluded.aliases_json,
              movie_count = excluded.movie_count,
              avatar_url = excluded.avatar_url,
              avatar_mime = excluded.avatar_mime,
              avatar_blob = excluded.avatar_blob,
              source = excluded.source,
              status = excluded.status,
              error = excluded.error,
              fetched_at = excluded.fetched_at,
              updated_at = excluded.updated_at
            """,
            (
                person["id"],
                person["name"],
                profile.get("javdb_actor_id"),
                profile.get("javdb_url"),
                profile.get("display_name") or person["name"],
                json.dumps(profile.get("aliases") or [], ensure_ascii=False),
                profile.get("movie_count"),
                profile.get("avatar_url"),
                avatar_mime,
                avatar_bytes,
                now,
                now,
            ),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Import one JavDB actor profile into FanHao SQLite cache.")
    parser.add_argument("--url", required=True, help="JavDB actor URL, e.g. https://javdb.com/actors/RdEb4")
    parser.add_argument("--name", default="", help="Local person name, e.g. 彩月七緒")
    parser.add_argument("--person-id", default="", help="Local person id from data/library-index.json")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--library-index", type=Path, default=DEFAULT_LIBRARY_INDEX)
    parser.add_argument("--profile-dir", type=Path, default=DEFAULT_SHARED_PROFILE)
    parser.add_argument("--chrome-binary", type=Path, default=DEFAULT_CHROME_BINARY)
    parser.add_argument("--driver-path", type=Path, default=None)
    parser.add_argument("--proxy", default="http://127.0.0.1:10809")
    parser.add_argument("--no-proxy", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=120)
    args = parser.parse_args()

    if not args.name and not args.person_id:
        raise SystemExit("需要 --name 或 --person-id")

    person = resolve_person(args.library_index, args.name, args.person_id)
    driver = get_driver(args.profile_dir, "" if args.no_proxy else args.proxy, args.headless, args.chrome_binary, args.driver_path)
    try:
        driver.get(args.url)
        profile = wait_for_actor_page(driver, args.url, args.wait_seconds)
        if not profile_looks_ready(profile):
            raise RuntimeError(f"没有拿到演员页头像，当前解析结果：{profile}")
        avatar_bytes, avatar_mime = download_avatar(profile.get("avatar_url", ""), driver)
        save_profile(args.db, person, profile, avatar_bytes, avatar_mime)
        print(f"已写入: {person['name']} -> {profile.get('display_name') or person['name']} ({len(avatar_bytes)} bytes)")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
