from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import os
import re
import shutil
import sys
import tempfile
import time
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


SITE_ROOT = "https://www.tuimzz.com"
DEFAULT_CATEGORY_URL = f"{SITE_ROOT}/category/mq"
DEFAULT_LIBRARY_ROOT = Path(r"T:\微密圈")
DEFAULT_LEGACY_CSV = Path.home() / "Desktop" / "Tool" / "data" / "artfilepath.csv"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)
ARCHIVE_EXTENSIONS = {".zip", ".cbz", ".rar", ".7z"}
STATUS_ORDER = {"update": 0, "missing_local": 1, "review": 2, "current": 3}


class SyncError(RuntimeError):
    pass


@dataclass
class RemotePost:
    post_id: str
    article_url: str
    title: str
    access_tier: str
    remote_count_label: str
    remote_count: int | None
    remote_count_open_ended: bool
    category_page: int
    legacy_codes: list[str] = field(default_factory=list)
    legacy_destinations: list[str] = field(default_factory=list)
    destination_name: str = ""
    destination_key: str = ""
    status: str = "review"
    needs_download: bool = False
    review_flags: list[str] = field(default_factory=list)
    site_changed: bool = False
    local_count: int = 0
    remote_group_count: int | None = None
    count_gap: int | None = None
    local_directories: list[str] = field(default_factory=list)
    local_manifest_signature: str = ""
    protected_download_url: str = ""
    baidu_url: str = ""
    baidu_share_id: str = ""
    extraction_code: str = ""
    pan_root_name: str = ""
    link_error: str = ""


@dataclass
class LegacyRow:
    post_id: str
    article_url: str
    code: str
    title: str
    destination: str


@dataclass
class LocalGroup:
    key: str
    destination_name: str
    posts: list[RemotePost]
    directories: list[Path]
    archive_names: list[str]
    local_count: int
    remote_count: int | None
    remote_count_open_ended: bool
    manifest_signature: str
    status: str
    review_flags: list[str]


def normalize_spaces(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def post_id_from_url(value: str | None) -> str:
    match = re.search(r"/(\d+)\.html(?:[?#]|$)", str(value or ""))
    return match.group(1) if match else ""


def parse_remote_count(value: str | None) -> tuple[int | None, bool]:
    label = normalize_spaces(value)
    match = re.search(r"\d+", label)
    return (int(match.group(0)) if match else None, "+" in label)


def clean_destination_name(value: str | None) -> str:
    name = normalize_spaces(value)
    while len(name) >= 2 and ((name[0], name[-1]) in {("[", "]"), ("【", "】")}):
        name = normalize_spaces(name[1:-1])
    name = name.replace("@", "")
    name = re.sub(r"[<>:\"/\\|?*]", " ", name)
    return normalize_spaces(name).strip(" .")


def destination_name_from_title(title: str) -> str:
    source = normalize_spaces(title)
    patterns = [
        r"^(.+?)#(?:微密圈|朋友圈|微信|内购|舰长)",
        r"^(.+?)[–—-]\s*微密圈",
        r"^(.+?)\s+微密圈",
        r"^(.+?)#",
    ]
    for pattern in patterns:
        match = re.search(pattern, source, flags=re.I)
        if match:
            return clean_destination_name(match.group(1))
    return clean_destination_name(re.sub(r"\[[^\]]*(?:套|期|G|GB)[^\]]*\]\s*$", "", source, flags=re.I))


def normalized_destination_key(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", clean_destination_name(value)).casefold()
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)


def destination_alias_keys(value: str | None) -> set[str]:
    source = clean_destination_name(value)
    variants = {source}
    variants.add(re.sub(r"[（(][^）)]*[）)]", "", source).strip())
    variants.add(source.split("#", 1)[0].strip())
    expanded = set(variants)
    for variant in variants:
        expanded.add(re.sub(r"(?:微密圈|抖音|虎牙|绣人网|秀人网)$", "", variant, flags=re.I).strip())
    return {key for variant in expanded if (key := normalized_destination_key(variant))}


def build_session(cookie_header: str = "") -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": DEFAULT_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
    )
    if cookie_header:
        session.headers["Cookie"] = cookie_header
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def response_text(response: requests.Response) -> str:
    content_type = response.headers.get("content-type", "")
    if "charset" not in content_type.lower():
        response.encoding = "utf-8"
    return response.text


def fetch(session: requests.Session, url: str, timeout: float, allow_redirects: bool = True) -> requests.Response:
    response = session.get(url, timeout=timeout, allow_redirects=allow_redirects)
    if response.status_code >= 400:
        raise SyncError(f"请求失败 HTTP {response.status_code}: {url}")
    return response


def category_page_url(category_url: str, page: int) -> str:
    if page <= 1:
        return category_url.rstrip("/")
    return f"{category_url.rstrip('/')}/page/{page}"


def parse_category_page(page_html: str, page_url: str, page_number: int) -> list[RemotePost]:
    soup = BeautifulSoup(page_html, "html.parser")
    posts: list[RemotePost] = []
    for article in soup.select("article.post-item"):
        title_node = article.select_one(".entry-title")
        link_node = title_node.find_parent("a", href=True) if title_node else None
        if link_node is None:
            link_node = article.select_one("a[href*='.html']")
        article_url = urljoin(page_url, link_node.get("href", "")) if link_node else ""
        post_id = post_id_from_url(article_url)
        title = normalize_spaces(title_node.get_text(" ", strip=True) if title_node else "")
        if not post_id or not title:
            continue
        count_label = normalize_spaces(
            article.select_one(".girl-nums").get_text(" ", strip=True) if article.select_one(".girl-nums") else ""
        )
        remote_count, open_ended = parse_remote_count(count_label)
        tier_node = article.select_one(".post-viewsss")
        posts.append(
            RemotePost(
                post_id=post_id,
                article_url=article_url,
                title=title,
                access_tier=normalize_spaces(tier_node.get_text(" ", strip=True) if tier_node else ""),
                remote_count_label=count_label,
                remote_count=remote_count,
                remote_count_open_ended=open_ended,
                category_page=page_number,
                protected_download_url=urljoin(
                    page_url,
                    f"/wp-content/plugins/erphpdown/download.php?postid={post_id}&key=1&index=",
                ),
            )
        )
    return posts


def crawl_category(
    session: requests.Session,
    category_url: str,
    max_pages: int,
    timeout: float,
    delay: float,
) -> tuple[list[RemotePost], int]:
    posts_by_id: dict[str, RemotePost] = {}
    scanned_pages = 0
    for page in range(1, max_pages + 1):
        url = category_page_url(category_url, page)
        response = session.get(url, timeout=timeout)
        if response.status_code == 404 and page > 1:
            break
        if response.status_code >= 400:
            raise SyncError(f"分类页请求失败 HTTP {response.status_code}: {url}")
        page_posts = parse_category_page(response_text(response), url, page)
        if not page_posts:
            if page == 1:
                raise SyncError(f"分类页没有识别到 article.post-item，页面结构可能已经变化: {url}")
            break
        scanned_pages += 1
        new_count = 0
        for post in page_posts:
            if post.post_id not in posts_by_id:
                posts_by_id[post.post_id] = post
                new_count += 1
        if new_count == 0:
            break
        if delay > 0:
            time.sleep(delay)
    return list(posts_by_id.values()), scanned_pages


def load_legacy_rows(path: Path) -> dict[str, list[LegacyRow]]:
    rows_by_post: dict[str, list[LegacyRow]] = defaultdict(list)
    if not path.exists():
        return rows_by_post
    with path.open("r", newline="", encoding="utf-8-sig", errors="replace") as stream:
        for row in csv.DictReader(stream):
            article_url = normalize_spaces(row.get("URL"))
            post_id = post_id_from_url(article_url)
            destination = normalize_spaces(row.get("Path"))
            title = normalize_spaces(row.get("Entry Title"))
            if not post_id or ("微密圈" not in destination and "微密圈" not in title):
                continue
            rows_by_post[post_id].append(
                LegacyRow(
                    post_id=post_id,
                    article_url=article_url,
                    code=normalize_spaces(row.get("Girl Nums")),
                    title=title,
                    destination=destination,
                )
            )
    return rows_by_post


def destination_basename(value: str | None) -> str:
    text = normalize_spaces(value).rstrip("\\/")
    if not text:
        return ""
    return re.split(r"[\\/]", text)[-1]


def assign_post_destinations(posts: list[RemotePost], legacy_rows: dict[str, list[LegacyRow]]) -> None:
    for post in posts:
        rows = legacy_rows.get(post.post_id, [])
        post.legacy_codes = sorted({row.code for row in rows if row.code})
        post.legacy_destinations = sorted({row.destination for row in rows if row.destination})
        destination_names = {
            clean_destination_name(destination_basename(row.destination))
            for row in rows
            if clean_destination_name(destination_basename(row.destination))
        }
        if len(destination_names) > 1:
            post.review_flags.append("legacy_destination_conflict")
        post.destination_name = sorted(destination_names)[0] if destination_names else destination_name_from_title(post.title)
        post.destination_key = normalized_destination_key(post.destination_name) or f"post{post.post_id}"
        if not rows:
            post.review_flags.append("legacy_mapping_missing")
        if not post.legacy_codes:
            post.review_flags.append("legacy_code_missing")


def local_directories(library_root: Path) -> list[Path]:
    if not library_root.exists():
        raise SyncError(f"图库根目录不存在: {library_root}")
    return sorted(
        [path for path in library_root.iterdir() if path.is_dir() and not path.name.startswith("_") and not path.name.startswith(".")],
        key=lambda path: path.name.casefold(),
    )


def archive_manifest(directories: list[Path]) -> tuple[list[str], int, str, list[str]]:
    by_name: dict[str, list[tuple[Path, int, int]]] = defaultdict(list)
    for directory in directories:
        for path in directory.iterdir():
            if path.is_file() and path.suffix.casefold() in ARCHIVE_EXTENSIONS:
                stat = path.stat()
                by_name[path.name.casefold()].append((path, stat.st_size, stat.st_mtime_ns))
    archive_names = sorted((values[0][0].name for values in by_name.values()), key=str.casefold)
    digest_rows = []
    collisions = []
    for key, values in sorted(by_name.items()):
        variants = {(size, mtime_ns) for _, size, mtime_ns in values}
        digest_rows.append(f"{key}\t" + "|".join(f"{size}:{mtime_ns}" for size, mtime_ns in sorted(variants)))
        if len(variants) > 1:
            collisions.append(values[0][0].name)
    signature = hashlib.sha256("\n".join(digest_rows).encode("utf-8")).hexdigest() if digest_rows else ""
    return archive_names, len(by_name), signature, collisions


def build_local_groups(posts: list[RemotePost], library_root: Path) -> list[LocalGroup]:
    directories = local_directories(library_root)
    directories_by_key: dict[str, list[Path]] = defaultdict(list)
    directories_by_alias: dict[str, list[Path]] = defaultdict(list)
    for directory in directories:
        directories_by_key[normalized_destination_key(directory.name)].append(directory)
        for alias in destination_alias_keys(directory.name):
            directories_by_alias[alias].append(directory)

    posts_by_key: dict[str, list[RemotePost]] = defaultdict(list)
    for post in posts:
        posts_by_key[post.destination_key].append(post)

    groups: list[LocalGroup] = []
    for key, group_posts in posts_by_key.items():
        destination_name = next((post.destination_name for post in group_posts if post.destination_name), f"post-{group_posts[0].post_id}")
        matched_directories = list(directories_by_key.get(key, []))
        alias_match_used = False
        alias_match_ambiguous = False
        if not matched_directories:
            alias_candidates = {
                path
                for alias in destination_alias_keys(destination_name)
                for path in directories_by_alias.get(alias, [])
            }
            if len(alias_candidates) == 1:
                matched_directories = sorted(alias_candidates, key=lambda path: path.name.casefold())
                alias_match_used = True
            elif len(alias_candidates) > 1:
                alias_match_ambiguous = True
        archive_names, local_count, signature, collisions = archive_manifest(matched_directories)
        counts = [post.remote_count for post in group_posts]
        remote_count = sum(count for count in counts if count is not None) if all(count is not None for count in counts) else None
        remote_count_open_ended = any(post.remote_count_open_ended for post in group_posts)
        flags = sorted({flag for post in group_posts for flag in post.review_flags})
        if len(group_posts) > 1:
            flags.append("multiple_posts_share_destination")
        if len(matched_directories) > 1:
            flags.append("multiple_local_directories")
        if alias_match_used:
            flags.append("local_alias_match")
        if alias_match_ambiguous:
            flags.append("local_alias_ambiguous")
        if collisions:
            flags.append("same_name_different_metadata")
        flags = sorted(set(flags))

        if not matched_directories:
            status = "missing_local"
        elif remote_count is None:
            status = "review"
        elif local_count < remote_count:
            if len(group_posts) > 1:
                status = "review"
                flags.append("group_count_gap_unallocated")
            else:
                status = "update"
        elif remote_count_open_ended:
            status = "review"
            flags.append("remote_count_open_ended")
        else:
            status = "current"
        flags = sorted(set(flags))

        group = LocalGroup(
            key=key,
            destination_name=destination_name,
            posts=group_posts,
            directories=matched_directories,
            archive_names=archive_names,
            local_count=local_count,
            remote_count=remote_count,
            remote_count_open_ended=remote_count_open_ended,
            manifest_signature=signature,
            status=status,
            review_flags=flags,
        )
        groups.append(group)
        for post in group_posts:
            post.status = status
            post.needs_download = status in {"update", "missing_local"}
            post.local_count = local_count
            post.remote_group_count = remote_count
            post.count_gap = max(0, remote_count - local_count) if remote_count is not None else None
            post.local_directories = [str(path) for path in matched_directories]
            post.local_manifest_signature = signature
            post.review_flags = flags
    return sorted(groups, key=lambda group: (STATUS_ORDER.get(group.status, 9), group.destination_name.casefold()))


def load_previous_items(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {str(item.get("post_id")): item for item in payload.get("items", []) if item.get("post_id")}


def mark_site_changes(posts: list[RemotePost], previous: dict[str, dict]) -> None:
    for post in posts:
        old = previous.get(post.post_id)
        if not old:
            continue
        post.site_changed = any(
            [
                normalize_spaces(old.get("title")) != post.title,
                normalize_spaces(old.get("remote_count_label")) != post.remote_count_label,
                normalize_spaces(old.get("baidu_url")) not in {"", post.baidu_url},
            ]
        )


def apply_site_change_status(groups: list[LocalGroup]) -> None:
    for group in groups:
        if not any(post.site_changed for post in group.posts):
            continue
        group.review_flags = sorted(set([*group.review_flags, "site_metadata_changed"]))
        if group.status == "current":
            group.status = "review"
        for post in group.posts:
            post.review_flags = group.review_flags
            if post.status == "current":
                post.status = "review"
                post.needs_download = False


def normalize_cookie_text(value: str, domain: str = "tuimzz.com") -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if text.startswith("[") or text.startswith("{"):
        try:
            parsed = json.loads(text)
            items = parsed if isinstance(parsed, list) else parsed.get("cookies", [])
            pairs = []
            for item in items:
                item_domain = str(item.get("domain", "")).lstrip(".")
                if item.get("name") and (not item_domain or item_domain.endswith(domain)):
                    pairs.append(f"{str(item.get('name')).strip()}={str(item.get('value', '')).strip()}")
            return "; ".join(pairs)
        except (AttributeError, json.JSONDecodeError):
            pass
    lines = [
        line.strip()
        for line in re.sub(r"^Cookie:\s*", "", text, flags=re.I).splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    netscape = []
    for line in lines:
        parts = line.split("\t")
        if len(parts) >= 7 and parts[0].lstrip(".").endswith(domain):
            netscape.append(f"{parts[5].strip()}={parts[6].strip()}")
    return "; ".join(netscape or lines)


def load_cookie_header(cookie_file: Path | None) -> tuple[str, str]:
    environment_cookie = os.environ.get("TUIMZZ_COOKIE", "").strip()
    if environment_cookie:
        return normalize_cookie_text(environment_cookie), "TUIMZZ_COOKIE 环境变量"
    if cookie_file and cookie_file.exists():
        return normalize_cookie_text(cookie_file.read_text(encoding="utf-8", errors="ignore")), str(cookie_file)
    return "", ""


def extract_external_download_url(text: str, base_url: str) -> str:
    soup = BeautifulSoup(text, "html.parser")
    for tag in soup.select("a[href], meta[http-equiv]"):
        href = tag.get("href", "")
        if not href and tag.name == "meta":
            content = tag.get("content", "")
            match = re.search(r"url\s*=\s*(.+)$", content, flags=re.I)
            href = match.group(1).strip(" '\"") if match else ""
        candidate = html.unescape(urljoin(base_url, href))
        if "pan.baidu.com" in candidate:
            return candidate
    patterns = [
        r"https?://pan\.baidu\.com/[^\s'\"<>]+",
        r"(?:window\.)?location(?:\.href)?\s*=\s*['\"]([^'\"]+)['\"]",
    ]
    for pattern in patterns:
        match = re.search(pattern, html.unescape(text), flags=re.I)
        if match:
            candidate = match.group(1) if match.lastindex else match.group(0)
            candidate = urljoin(base_url, candidate.replace("\\/", "/"))
            if "pan.baidu.com" in candidate:
                return candidate
    return ""


def resolve_baidu_link(session: requests.Session, post: RemotePost, timeout: float) -> str:
    iframe_url = urljoin(
        post.article_url,
        f"/wp-content/plugins/erphpdown/download.php?postid={post.post_id}&iframe=1",
    )
    iframe_response = session.get(iframe_url, timeout=timeout)
    iframe_text = response_text(iframe_response)
    if "请先登录" in iframe_text or "wp-login.php" in iframe_response.url:
        raise SyncError("Cookie 无效或已经过期")
    if iframe_response.status_code >= 400:
        raise SyncError(f"下载详情请求失败 HTTP {iframe_response.status_code}")
    iframe_soup = BeautifulSoup(iframe_text, "html.parser")
    link_node = next(
        (
            node
            for node in iframe_soup.select("a[href]")
            if "download.php" in str(node.get("href", "")) and "key=" in str(node.get("href", ""))
        ),
        None,
    )
    protected_url = urljoin(iframe_response.url, link_node.get("href", "")) if link_node else post.protected_download_url
    post.protected_download_url = protected_url
    response = session.get(protected_url, timeout=timeout, allow_redirects=False)
    if response.status_code in {301, 302, 303, 307, 308}:
        location = html.unescape(response.headers.get("location", ""))
        candidate = urljoin(protected_url, location)
        if "pan.baidu.com" in candidate:
            return candidate
    text = response_text(response)
    if "请先登录" in text:
        raise SyncError("Cookie 无效或已经过期")
    candidate = extract_external_download_url(text, protected_url)
    if candidate:
        return candidate
    raise SyncError(f"没有解析到百度网盘地址（HTTP {response.status_code}）")


def baidu_link_facts(url: str) -> tuple[str, str]:
    parsed = urlparse(url)
    share_match = re.search(r"/s/([^/?#]+)", parsed.path)
    query = parse_qs(parsed.query)
    share_id = share_match.group(1) if share_match else ""
    if not share_id and parsed.path.rstrip("/") == "/share/init":
        share_id = (query.get("surl") or [""])[0]
    return (share_id, (query.get("pwd") or [""])[0])


def load_link_map(path: Path | None) -> dict[str, dict]:
    if not path or not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return {str(item.get("post_id")): item for item in payload if item.get("post_id")}
    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        return {str(item.get("post_id")): item for item in payload["items"] if item.get("post_id")}
    if isinstance(payload, dict):
        return {str(key): (value if isinstance(value, dict) else {"baidu_url": str(value)}) for key, value in payload.items()}
    raise SyncError(f"无法识别链接映射格式: {path}")


def apply_link_facts(post: RemotePost, facts: dict) -> None:
    post.baidu_url = normalize_spaces(facts.get("baidu_url") or facts.get("url"))
    post.pan_root_name = normalize_spaces(facts.get("pan_root_name") or facts.get("root_name") or facts.get("title"))
    post.link_error = normalize_spaces(facts.get("link_error"))
    if post.baidu_url:
        post.baidu_share_id, post.extraction_code = baidu_link_facts(post.baidu_url)


def resolve_links(
    posts: list[RemotePost],
    previous: dict[str, dict],
    link_map: dict[str, dict],
    cookie_header: str,
    timeout: float,
    delay: float,
    resolve_all: bool,
) -> None:
    auth_session = build_session(cookie_header) if cookie_header else None
    for post in posts:
        old = previous.get(post.post_id, {})
        if old.get("baidu_url"):
            apply_link_facts(post, old)
        if post.post_id in link_map:
            apply_link_facts(post, link_map[post.post_id])
            continue
        if not (post.needs_download or resolve_all):
            continue
        if not auth_session:
            continue
        try:
            apply_link_facts(post, {"baidu_url": resolve_baidu_link(auth_session, post, timeout)})
        except (requests.RequestException, SyncError) as exc:
            post.link_error = normalize_spaces(str(exc))
        if delay > 0:
            time.sleep(delay)


def report_item(post: RemotePost, library_root: Path) -> dict:
    proposed = library_root / f"[{post.destination_name}]"
    return {
        "post_id": post.post_id,
        "status": post.status,
        "needs_download": post.needs_download,
        "site_changed": post.site_changed,
        "title": post.title,
        "article_url": post.article_url,
        "category_page": post.category_page,
        "access_tier": post.access_tier,
        "remote_count_label": post.remote_count_label,
        "remote_count": post.remote_count,
        "remote_count_open_ended": post.remote_count_open_ended,
        "remote_group_count": post.remote_group_count,
        "local_count": post.local_count,
        "count_gap": post.count_gap,
        "destination_name": post.destination_name,
        "proposed_destination": str(proposed),
        "local_directories": post.local_directories,
        "local_manifest_signature": post.local_manifest_signature,
        "legacy_codes": post.legacy_codes,
        "legacy_destinations": post.legacy_destinations,
        "review_flags": post.review_flags,
        "protected_download_url": post.protected_download_url,
        "baidu_url": post.baidu_url,
        "baidu_share_id": post.baidu_share_id,
        "extraction_code": post.extraction_code,
        "pan_root_name": post.pan_root_name,
        "link_error": post.link_error,
    }


def report_group(group: LocalGroup, library_root: Path) -> dict:
    return {
        "key": group.key,
        "status": group.status,
        "destination_name": group.destination_name,
        "proposed_destination": str(library_root / f"[{group.destination_name}]"),
        "post_ids": [post.post_id for post in group.posts],
        "article_urls": [post.article_url for post in group.posts],
        "local_directories": [str(path) for path in group.directories],
        "local_count": group.local_count,
        "remote_count": group.remote_count,
        "remote_count_open_ended": group.remote_count_open_ended,
        "count_gap": max(0, group.remote_count - group.local_count) if group.remote_count is not None else None,
        "local_manifest_signature": group.manifest_signature,
        "review_flags": group.review_flags,
    }


def build_report(
    posts: list[RemotePost],
    groups: list[LocalGroup],
    library_root: Path,
    category_url: str,
    pages: int,
    legacy_csv: Path,
) -> dict:
    items = [report_item(post, library_root) for post in posts]
    status_counts = Counter(group.status for group in groups)
    item_status_counts = Counter(post.status for post in posts)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "category_url": category_url,
        "pages_scanned": pages,
        "library_root": str(library_root),
        "legacy_csv": str(legacy_csv),
        "comparison_policy": {
            "canonical_directory": r"T:\微密圈\[人物名]",
            "local_count": "同一规范人物名下直接放置的唯一压缩包文件名数量",
            "remote_count": "分类卡片期数；同一人物对应多个文章时求和",
            "update": "本地压缩包数量小于远端期数下限",
            "missing_local": "网站条目没有匹配到本地人物目录",
            "review": "N+ 开放期数、同人物多文章无法分配缺口，或上次快照后站点元数据变化",
            "warning": "数量比较只能确认明确缺口；同数量替换要等下载后用远端清单和本地哈希最终确认",
        },
        "totals": {
            "remote_posts": len(posts),
            "destination_groups": len(groups),
            "groups_by_status": dict(sorted(status_counts.items())),
            "posts_by_status": dict(sorted(item_status_counts.items())),
            "needs_download_posts": sum(1 for post in posts if post.needs_download),
            "update_posts": sum(1 for post in posts if post.status == "update"),
            "missing_local_posts": sum(1 for post in posts if post.status == "missing_local"),
            "current_posts": sum(1 for post in posts if post.status == "current"),
            "resolved_baidu_links": sum(1 for post in posts if post.baidu_url),
            "link_errors": sum(1 for post in posts if post.link_error),
        },
        "groups": [report_group(group, library_root) for group in groups],
        "items": sorted(items, key=lambda item: (STATUS_ORDER.get(item["status"], 9), item["destination_name"].casefold(), item["post_id"])),
    }


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent, delete=False) as stream:
        stream.write(text)
        temp_path = Path(stream.name)
    try:
        temp_path.replace(path)
    except PermissionError:
        # Some Windows SMB shares allow updating a file but deny the DELETE
        # permission that ReplaceFile/MoveFile needs to overwrite it.  Keep the
        # atomic path for normal disks and fall back to a direct copy only for
        # that specific share-permission failure.
        try:
            with temp_path.open("rb") as source, path.open("wb") as destination:
                shutil.copyfileobj(source, destination)
                destination.flush()
                os.fsync(destination.fileno())
        finally:
            temp_path.unlink(missing_ok=True)


def json_text(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def csv_text(items: list[dict]) -> str:
    from io import StringIO

    fields = [
        "status",
        "needs_download",
        "site_changed",
        "post_id",
        "destination_name",
        "remote_count_label",
        "remote_group_count",
        "local_count",
        "count_gap",
        "title",
        "article_url",
        "baidu_url",
        "pan_root_name",
        "extraction_code",
        "legacy_codes",
        "local_directories",
        "proposed_destination",
        "review_flags",
        "link_error",
    ]
    stream = StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for item in items:
        row = dict(item)
        for field_name in ("legacy_codes", "local_directories", "review_flags"):
            row[field_name] = " | ".join(row.get(field_name) or [])
        writer.writerow(row)
    return "\ufeff" + stream.getvalue()


def html_report(payload: dict) -> str:
    totals = payload["totals"]
    rows = []
    labels = {"update": "需要更新", "missing_local": "本地缺失", "review": "人工确认", "current": "已达到期数"}
    for item in payload["items"]:
        status = item["status"]
        article_link = f'<a href="{html.escape(item["article_url"], quote=True)}">文章</a>'
        baidu_link = (
            f'<a href="{html.escape(item["baidu_url"], quote=True)}">百度云</a>' if item["baidu_url"] else "未解析"
        )
        local_paths = "<br>".join(html.escape(value) for value in item["local_directories"]) or html.escape(item["proposed_destination"])
        flags = "、".join(item["review_flags"])
        rows.append(
            "<tr class=\"status-{}\"><td>{}</td><td>{}</td><td>{}</td><td>{}/{}</td>"
            "<td>{}</td><td>{} · {}</td><td>{}</td><td>{}</td></tr>".format(
                html.escape(status),
                html.escape(labels.get(status, status)),
                html.escape(item["destination_name"]),
                html.escape(item["title"]),
                item["local_count"],
                item["remote_group_count"] if item["remote_group_count"] is not None else "?",
                local_paths,
                article_link,
                baidu_link,
                html.escape(item["pan_root_name"] or ""),
                html.escape(flags or item["link_error"] or ""),
            )
        )
    generated = html.escape(payload["generated_at"])
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>微密圈更新清单</title>
<style>
body{{font-family:"Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#202124;background:#f7f8fa}}
h1{{margin:0 0 8px}} .meta{{color:#5f6368;margin-bottom:18px}} .summary{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}}
.card{{background:#fff;border:1px solid #dfe3e8;border-radius:10px;padding:12px 16px;min-width:150px}} .card b{{font-size:24px;display:block}}
table{{border-collapse:collapse;width:100%;background:#fff;font-size:14px}} th,td{{border:1px solid #dfe3e8;padding:8px;text-align:left;vertical-align:top}}
th{{position:sticky;top:0;background:#eef2f7}} .status-update td:first-child{{color:#b3261e;font-weight:700}}
.status-missing_local td:first-child{{color:#8a3ffc;font-weight:700}} .status-current{{color:#5f6368}} a{{color:#0b57d0}}
</style></head><body>
<h1>微密圈更新清单</h1><div class="meta">生成时间：{generated} · 网站条目：{totals['remote_posts']} · 本地根目录：{html.escape(payload['library_root'])}</div>
<div class="summary"><div class="card"><b>{totals['update_posts']}</b>现有目录需更新</div>
<div class="card"><b>{totals['missing_local_posts']}</b>网站有但本地没有</div>
<div class="card"><b>{totals['resolved_baidu_links']}</b>已解析百度云</div><div class="card"><b>{totals['destination_groups']}</b>人物/合集</div></div>
<p>判断规则：同一规范人物目录下的唯一压缩包数量，与网站卡片期数比较；多文章映射同一人物时远端期数求和。首次运行仅建立数量基线，下载后还要校验远端文件清单。</p>
<table><thead><tr><th>状态</th><th>人物/合集</th><th>网站标题</th><th>本地/远端</th><th>本地路径</th><th>链接</th><th>网盘根目录</th><th>提醒</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></body></html>"""


def write_reports(payload: dict, catalog_dir: Path) -> dict[str, Path]:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    snapshot_path = catalog_dir / "snapshots" / f"tuimzz-{stamp}.json"
    latest_json = catalog_dir / "latest.json"
    latest_csv = catalog_dir / "latest.csv"
    latest_html = catalog_dir / "latest.html"
    serialized = json_text(payload)
    atomic_write_text(snapshot_path, serialized)
    atomic_write_text(latest_json, serialized)
    atomic_write_text(latest_html, html_report(payload))
    csv_path = latest_csv
    try:
        atomic_write_text(latest_csv, csv_text(payload["items"]))
    except PermissionError:
        csv_path = catalog_dir / "latest.pending.csv"
        atomic_write_text(csv_path, csv_text(payload["items"]))
    return {"json": latest_json, "csv": csv_path, "html": latest_html, "snapshot": snapshot_path}


def print_summary(payload: dict, paths: dict[str, Path] | None) -> None:
    totals = payload["totals"]
    groups = totals["groups_by_status"]
    print(
        "扫描完成: "
        f"网站文章={totals['remote_posts']} 人物/合集={totals['destination_groups']} "
        f"需要更新={groups.get('update', 0)} 本地缺失={groups.get('missing_local', 0)} "
        f"人工确认={groups.get('review', 0)} 已达到期数={groups.get('current', 0)}"
    )
    print(
        f"现有目录需更新文章={totals['update_posts']}，本地缺失文章={totals['missing_local_posts']}，"
        f"已解析百度云={totals['resolved_baidu_links']}"
    )
    for item in payload["items"]:
        if item["status"] != "update":
            continue
        remote = item["remote_group_count"] if item["remote_group_count"] is not None else "?"
        print(f"[{item['status']}] {item['destination_name']}: 本地 {item['local_count']} / 远端 {remote}  ({item['post_id']})")
        print(f"  文章: {item['article_url']}")
        print(f"  百度: {item['baidu_url'] or '未解析（需要有效 Cookie 或 --link-map）'}")
    if totals["missing_local_posts"]:
        print(f"另有 {totals['missing_local_posts']} 个网站文章在 T 盘无对应目录，详情见 HTML/CSV；未混入上面的更新链接。")
    if paths:
        print(f"HTML 报告: {paths['html']}")
        print(f"CSV 清单: {paths['csv']}")
        if paths["csv"].name != "latest.csv":
            print("警告: latest.csv 正被其他程序占用，新内容已写入 latest.pending.csv。")
        print(f"JSON 状态: {paths['json']}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="对照 tuimzz 微密圈分类和 T 盘套图，生成需要下载的百度云链接清单。")
    parser.add_argument("--category-url", default=DEFAULT_CATEGORY_URL)
    parser.add_argument("--library-root", type=Path, default=DEFAULT_LIBRARY_ROOT)
    parser.add_argument("--legacy-csv", type=Path, default=DEFAULT_LEGACY_CSV)
    parser.add_argument("--catalog-dir", type=Path, help=r"默认 T:\微密圈\_catalog")
    parser.add_argument("--cookie-file", type=Path, help="只读取 Cookie 文件；也可使用 TUIMZZ_COOKIE 环境变量。")
    parser.add_argument("--link-map", type=Path, help="可选 JSON：浏览器人工解析的 post_id -> 百度链接。")
    parser.add_argument("--resolve-links", action="store_true", help="用 Cookie 解析需要下载条目的百度云链接。")
    parser.add_argument("--resolve-all", action="store_true", help="连已达到期数的条目也刷新百度云链接。")
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--delay", type=float, default=0.2)
    parser.add_argument("--no-write", action="store_true", help="只打印，不写 T 盘报告。")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.max_pages < 1:
        raise SyncError("--max-pages 必须大于 0")
    library_root = args.library_root.resolve()
    catalog_dir = (args.catalog_dir or library_root / "_catalog").resolve()
    cookie_file = args.cookie_file or catalog_dir / "tuimzz-cookie.txt"
    latest_json = catalog_dir / "latest.json"

    public_session = build_session()
    posts, pages = crawl_category(
        public_session,
        args.category_url,
        args.max_pages,
        args.timeout,
        args.delay,
    )
    previous = load_previous_items(latest_json)
    legacy_rows = load_legacy_rows(args.legacy_csv)
    assign_post_destinations(posts, legacy_rows)
    groups = build_local_groups(posts, library_root)
    link_map = load_link_map(args.link_map)
    cookie_header, cookie_source = load_cookie_header(cookie_file)
    if args.resolve_links and not cookie_header and not link_map:
        raise SyncError(
            f"需要有效 Cookie：保存到 {cookie_file}，或设置 TUIMZZ_COOKIE；Cookie 值不会写入报告。"
        )
    resolve_links(
        posts,
        previous,
        link_map,
        cookie_header if args.resolve_links else "",
        args.timeout,
        args.delay,
        args.resolve_all,
    )
    mark_site_changes(posts, previous)
    apply_site_change_status(groups)
    if args.resolve_links and cookie_source:
        print(f"已使用 Cookie 来源: {cookie_source}（内容未输出）")

    payload = build_report(posts, groups, library_root, args.category_url, pages, args.legacy_csv)
    paths = None if args.no_write else write_reports(payload, catalog_dir)
    print_summary(payload, paths)
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    try:
        raise SystemExit(main())
    except (OSError, requests.RequestException, SyncError) as exc:
        print(f"错误: {normalize_spaces(str(exc))}", file=sys.stderr)
        raise SystemExit(1)
