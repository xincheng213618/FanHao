#!/usr/bin/env python3
"""
Cache smtt6, jmd9, and 55comic reader pages and their manga images locally.

The crawler starts from a catalog URL such as:
https://smtt6.com/man-hua-yue-du/12348563.html

It extracts chapter reader pages under the same comic id, saves each chapter's
HTML, downloads image assets, and writes JSON/CSV manifests plus a local viewer.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html as html_lib
import http.server
import io
import json
import mimetypes
import os
import re
import sqlite3
import shutil
import sys
import threading
import time
import webbrowser
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser


DEFAULT_START_URL = "https://smtt6.com/man-hua-yue-du/12348563.html"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0 Safari/537.36 CodexLocalCache/1.0"
)
HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}
DEFAULT_SOURCES_FILE = "smtt6_sources.txt"
DEFAULT_DATABASE_FILE = "manga.sqlite"
DEFAULT_LIBRARY_ROOT = Path(os.environ.get("FANHAO_MANGA_ROOT") or r"E:\https-smtt6-com-man-hua-yue")
JMD_HOSTS = {"jmd9.com", "www.jmd9.com", "91jmd.com", "www.91jmd.com"}
DEFAULT_SERVE_HOST = "127.0.0.1"
DEFAULT_SERVE_PORT = 8765
ZIP_COMPRESSION_METHODS = {
    "stored": zipfile.ZIP_STORED,
    "deflated": zipfile.ZIP_DEFLATED,
}
IMAGE_ATTRS = (
    "src",
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-url",
    "data-img",
)
IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I)
CROPPED_DIV_RE = re.compile(
    r"<div\b(?=[^>]*\bclass\s*=\s*([\"'])[^\"']*\bcropped\b[^\"']*\1)[^>]*>\s*</div>",
    re.I | re.S,
)
LOCALIZABLE_IMAGE_RE = re.compile(
    rf"(?:{IMG_TAG_RE.pattern})|(?:{CROPPED_DIV_RE.pattern})",
    re.I | re.S,
)
ATTR_RE_TEMPLATE = r"({attr}\s*=\s*)([\"'])(.*?)(\2)"
PROGRESS_PREFIX = "MANGA_PROGRESS "


def emit_progress(event: str, **payload) -> None:
    print(
        PROGRESS_PREFIX + json.dumps({"event": event, **payload}, ensure_ascii=False),
        flush=True,
    )


class ParsedPage(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchors: list[tuple[str, str, str]] = []
        self.image_refs: list[str] = []
        self.title_parts: list[str] = []
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {k.lower(): v for k, v in attrs if v is not None}
        tag = tag.lower()
        if tag == "a":
            href = attr.get("href")
            if href:
                self.anchors.append((href, attr.get("title", ""), ""))
        is_55comic_cropped = tag == "div" and "cropped" in (attr.get("class") or "").split()
        if tag in {"img", "source"} or is_55comic_cropped:
            for name in IMAGE_ATTRS:
                value = attr.get(name)
                if value:
                    self.image_refs.append(value)
            srcset = attr.get("srcset") or attr.get("data-srcset")
            if srcset:
                self.image_refs.extend(split_srcset(srcset))
        if tag == "title":
            self._in_title = True

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False

    @property
    def title(self) -> str:
        return clean_text(" ".join(self.title_parts))


@dataclass
class ImageRecord:
    index: int
    source_url: str
    downloaded_url: str | None = None
    final_url: str | None = None
    local_path: str | None = None
    content_type: str | None = None
    bytes: int = 0
    status: str = "pending"
    error: str | None = None


@dataclass
class ChapterRecord:
    index: int
    url: str
    slug: str
    title: str = ""
    html_path: str | None = None
    image_count: int = 0
    downloaded_count: int = 0
    skipped_count: int = 0
    failed_count: int = 0
    images: list[ImageRecord] = field(default_factory=list)
    status: str = "pending"
    error: str | None = None


def image_record_from_dict(data: dict) -> ImageRecord:
    return ImageRecord(
        index=int(data.get("index", 0)),
        source_url=str(data.get("source_url") or ""),
        downloaded_url=data.get("downloaded_url"),
        final_url=data.get("final_url"),
        local_path=data.get("local_path"),
        content_type=data.get("content_type"),
        bytes=int(data.get("bytes") or 0),
        status=str(data.get("status") or "pending"),
        error=data.get("error"),
    )


def chapter_record_to_dict(chapter: ChapterRecord) -> dict:
    return {
        "index": chapter.index,
        "url": chapter.url,
        "slug": chapter.slug,
        "title": chapter.title,
        "html_path": chapter.html_path,
        "image_count": chapter.image_count,
        "downloaded_count": chapter.downloaded_count,
        "skipped_count": chapter.skipped_count,
        "failed_count": chapter.failed_count,
        "status": chapter.status,
        "error": chapter.error,
        "images": [image.__dict__ for image in chapter.images],
    }


def chapter_record_from_dict(data: dict) -> ChapterRecord:
    return ChapterRecord(
        index=int(data.get("index", 0)),
        url=str(data.get("url") or ""),
        slug=str(data.get("slug") or ""),
        title=str(data.get("title") or ""),
        html_path=data.get("html_path"),
        image_count=int(data.get("image_count") or 0),
        downloaded_count=int(data.get("downloaded_count") or 0),
        skipped_count=int(data.get("skipped_count") or 0),
        failed_count=int(data.get("failed_count") or 0),
        images=[image_record_from_dict(item) for item in data.get("images", [])],
        status=str(data.get("status") or "pending"),
        error=data.get("error"),
    )


def is_chapter_complete(chapter: ChapterRecord) -> bool:
    return (
        chapter.status in {"done", "repaired"}
        and chapter.image_count >= 0
        and chapter.downloaded_count == chapter.image_count
        and chapter.failed_count == 0
        and chapter.skipped_count == 0
    )


class RobotsCache:
    def __init__(self, timeout: int, user_agent: str = USER_AGENT) -> None:
        self.timeout = timeout
        self.user_agent = user_agent
        self._cache: dict[str, RobotFileParser | None] = {}
        self._lock = threading.Lock()

    def allowed(self, url: str) -> bool:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return False
        origin = f"{parsed.scheme}://{parsed.netloc}"
        with self._lock:
            if origin not in self._cache:
                self._cache[origin] = self._load(origin)
            parser = self._cache[origin]
        if parser is None:
            return True
        return parser.can_fetch(self.user_agent, url)

    def _load(self, origin: str) -> RobotFileParser | None:
        robots_url = origin.rstrip("/") + "/robots.txt"
        parser = RobotFileParser()
        parser.set_url(robots_url)
        try:
            data, _final_url, _content_type, _headers = fetch_bytes(
                robots_url,
                referer=None,
                accept="text/plain,*/*;q=0.8",
                timeout=self.timeout,
                retries=1,
            )
        except Exception:
            return None
        text = decode_text(data, _headers.get("content-type", ""))
        parser.parse(text.splitlines())
        return parser


def clean_text(value: str) -> str:
    value = html_lib.unescape(value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def clean_display_title(value: str) -> str:
    value = clean_text(value)
    for suffix in (
        " - 色漫天堂 - 韩漫日漫18岁禁漫",
        " - 色漫天堂",
        " - 禁漫岛 - 韩漫日漫3D漫画的禁漫天堂",
        " - 禁漫岛",
        " - 污污漫畫",
        " - 汙汙漫畫",
    ):
        if value.endswith(suffix):
            value = value[: -len(suffix)].strip()
    value = re.sub(r"\s+-\s*《[^》]+》未删减(?:版)?全集(?:免費|免费)?在线阅读$", "", value).strip()
    value = re.sub(
        r"^《([^》]+)》未删减(?:版)?全集(?:免費|免费)?在线阅读$",
        r"\1",
        value,
    ).strip()
    value = re.sub(r"^《([^》]+)》$", r"\1", value).strip()
    return value


def clean_chapter_title(raw_title: str, title_hint: str = "") -> str:
    title = clean_display_title(raw_title)
    hint = clean_text(title_hint)
    if title and hint and title.endswith(f" - {hint}"):
        return hint
    if title and "开始阅读" not in title:
        return title
    if hint:
        hint = re.sub(r"^[^-]+-", "", hint, count=1).strip()
        if hint and "开始阅读" not in hint:
            return hint
    return title


def clean_catalog_title(raw_title: str, comic_id: str = "") -> str:
    title = clean_display_title(raw_title)
    if not title and comic_id:
        title = f"smtt6 {comic_id}"
    return title or "smtt6 local image cache"


def split_srcset(value: str) -> list[str]:
    refs: list[str] = []
    for item in value.split(","):
        parts = item.strip().split()
        if parts:
            refs.append(parts[0])
    return refs


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", parsed.query, ""))


def chapter_identity(url: str) -> str:
    """Return the stable identity of a chapter URL.

    Reader links, especially 55comic links, append cache-busting query values such
    as ``?t=20260415``. Those values may change without the chapter changing, so
    update detection must key chapters by origin and path rather than the full URL.
    """
    parsed = urlparse(normalize_url(url))
    path = parsed.path.rstrip("/") or "/"
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    if is_jmd_host(parsed.hostname or ""):
        # jmd9.com and 91jmd.com are two public names for the same catalog.
        # A user may update an existing cache through either alias, so the host
        # must not turn every stored chapter into a false cache miss.
        scheme = "https"
        netloc = "jmd9.com"
    return urlunparse((scheme, netloc, path, "", "", ""))


def fetch_bytes(
    url: str,
    *,
    referer: str | None,
    accept: str,
    timeout: int,
    retries: int,
) -> tuple[bytes, str, str, dict[str, str]]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": accept,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Connection": "close",
    }
    if referer:
        headers["Referer"] = referer

    last_error: Exception | None = None
    for attempt in range(max(1, retries)):
        try:
            req = Request(url, headers=headers)
            with urlopen(req, timeout=timeout) as response:
                data = response.read()
                final_url = response.geturl()
                header_map = {k.lower(): v for k, v in response.headers.items()}
                raw_content_type = header_map.get("content-type", "")
                content_type = raw_content_type.split(";")[0].lower()
                return data, final_url, content_type, header_map
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt + 1 < max(1, retries):
                time.sleep(1.0 + attempt)
    assert last_error is not None
    raise last_error


def decode_text(data: bytes, content_type_header: str) -> str:
    match = re.search(r"charset=([^\s;]+)", content_type_header, re.I)
    encodings = []
    if match:
        encodings.append(match.group(1).strip("\"'"))
    encodings.extend(["utf-8", "gb18030"])
    for encoding in encodings:
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_page(html: str) -> ParsedPage:
    parser = ParsedPage()
    parser.feed(html)
    return parser


def is_jmd_host(host: str) -> bool:
    return str(host or "").lower() in JMD_HOSTS


def comic_id_from_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.rstrip("/")
    if "smtt6.com" in host:
        match = re.match(r"^/man-hua-yue-du/([^/.]+)(?:\.html|/[^/]+\.html)$", path)
    elif is_jmd_host(host):
        match = re.match(r"^/manga/([^/]+)(?:/[^/]+)?$", path)
    elif "55comic.com" in host:
        match = re.match(r"^/book/([^/]+)$", path)
    else:
        match = None
    if not match:
        raise ValueError(f"Unsupported comic URL: {url}")
    return match.group(1)


def catalog_url_for(url: str, comic_id: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if "smtt6.com" in host:
        path = f"/man-hua-yue-du/{comic_id}.html"
    elif is_jmd_host(host):
        path = f"/manga/{comic_id}"
    elif "55comic.com" in host:
        path = f"/book/{comic_id}"
    else:
        raise ValueError(f"Unsupported comic URL: {url}")
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def chapter_url_for(catalog_url: str, comic_id: str, slug: str) -> str:
    parsed = urlparse(catalog_url)
    host = parsed.netloc.lower()
    if "smtt6.com" in host:
        path = f"/man-hua-yue-du/{comic_id}/{slug}.html"
    elif is_jmd_host(host):
        path = f"/manga/{comic_id}/{slug}"
    elif "55comic.com" in host:
        path = f"/free-chapter/{slug}"
    else:
        raise ValueError(f"Unsupported comic URL: {catalog_url}")
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def default_out_dir_for(url: str, comic_id: str) -> str:
    host = urlparse(url).netloc.lower()
    if is_jmd_host(host):
        prefix = "jmd9_cache"
    elif "55comic.com" in host:
        prefix = "55comic_cache"
    else:
        prefix = "smtt6_cache"
    return f"{prefix}_{comic_id}"


def is_chapter_url(catalog_url: str, url: str, comic_id: str) -> bool:
    catalog_host = urlparse(catalog_url).netloc.lower()
    parsed = urlparse(url)
    if parsed.netloc and parsed.netloc.lower() != catalog_host:
        return False
    path = parsed.path.rstrip("/")
    if "smtt6.com" in catalog_host:
        return bool(re.match(rf"^/man-hua-yue-du/{re.escape(comic_id)}/[^/]+\.html$", path))
    if is_jmd_host(catalog_host):
        return bool(re.match(rf"^/manga/{re.escape(comic_id)}/[^/]+$", path))
    if "55comic.com" in catalog_host:
        return bool(re.match(r"^/free-chapter/[^/]+$", path))
    return False


def chapter_slug(url: str) -> str:
    name = Path(urlparse(url).path).stem
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:80] or "chapter"


def extract_chapter_urls(
    catalog_url: str,
    catalog_html: str,
    comic_id: str,
) -> list[tuple[str, str]]:
    parsed = parse_page(catalog_html)
    seen: set[str] = set()
    chapters: list[tuple[str, str]] = []
    for href, title, _text in parsed.anchors:
        url = normalize_url(urljoin(catalog_url, href))
        if is_chapter_url(catalog_url, url, comic_id):
            identity = chapter_identity(url)
            title = clean_text(title)
            if "开始阅读" in title:
                title = ""
            if identity not in seen:
                seen.add(identity)
                chapters.append((url, title))
            elif title:
                chapters = [
                    (
                        item_url,
                        title
                        if chapter_identity(item_url) == identity and not item_title
                        else item_title,
                    )
                    for item_url, item_title in chapters
                ]
    return chapters


def is_image_candidate(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    path = parsed.path.lower()
    suffix = Path(path).suffix
    if any(marker in path for marker in ("/manga_pics/", "/upload_s/")):
        return True
    if parsed.netloc.lower() in {
        "smtt6.com",
        "www.smtt6.com",
        "jmd9.com",
        "www.jmd9.com",
        "91jmd.com",
        "www.91jmd.com",
        "55comic.com",
        "www.55comic.com",
    }:
        return False
    return suffix in IMAGE_EXTS


def extract_image_urls(page_url: str, page_html: str) -> list[str]:
    parsed = parse_page(page_html)
    seen: set[str] = set()
    images: list[str] = []
    for ref in parsed.image_refs:
        if ref.startswith("data:"):
            continue
        url = normalize_url(urljoin(page_url, html_lib.unescape(ref)))
        if is_image_candidate(url) and url not in seen:
            seen.add(url)
            images.append(url)
    return images


def image_download_candidates(url: str, prefer_webp: bool) -> Iterable[str]:
    parsed = urlparse(url)
    suffix = Path(parsed.path).suffix.lower()
    if prefer_webp and suffix in {".jpg", ".jpeg", ".png"}:
        webp_path = parsed.path[: -len(suffix)] + ".webp"
        yield urlunparse((parsed.scheme, parsed.netloc, webp_path, "", parsed.query, ""))
    yield url


def is_55comic_encrypted_image(url: str) -> bool:
    parsed = urlparse(url)
    return bool(
        parsed.scheme in {"http", "https"}
        and "/break" in parsed.path
        and "/static/upload/book/" in parsed.path
        and Path(parsed.path).suffix.lower() in IMAGE_EXTS
    )


def decrypt_55comic_part(data: bytes) -> bytes:
    key = b"aaaaaaaaaaaaaaaa"
    iv = b"0123456789aaaaaa"
    if not data or len(data) % 16:
        raise ValueError("Invalid 55comic encrypted image part")

    try:
        from Crypto.Cipher import AES  # type: ignore[import-not-found]

        decrypted = AES.new(key, AES.MODE_CBC, iv).decrypt(data)
    except ImportError:
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        except ImportError as exc:
            raise RuntimeError(
                "55comic image recovery requires pycryptodome or cryptography"
            ) from exc
        decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        decrypted = decryptor.update(data) + decryptor.finalize()

    padding = decrypted[-1]
    if padding < 1 or padding > 16 or decrypted[-padding:] != bytes([padding]) * padding:
        raise ValueError("Invalid 55comic AES-CBC padding")
    return decrypted[:-padding]


def inject_55comic_image_header(data: bytes) -> tuple[bytes, str, int, int]:
    if len(data) < 12:
        raise ValueError("55comic image payload is too short")
    file_type = data[0]
    image_type = data[1]
    headers = {
        0: (b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01", "image/jpeg"),
        1: (b"\x89PNG\r\n\x1a\n", "image/png"),
        3: (b"GIF89a", "image/gif"),
        4: (b"\x00\x00\x00 ftypavif", "image/avif"),
    }
    if file_type not in headers:
        raise ValueError(f"Unsupported 55comic image type: {file_type}")
    if image_type != 0:
        raise ValueError(f"Unsupported 55comic image layout: {image_type}")

    book_id = int.from_bytes(data[2:4], "big")
    page_number = int.from_bytes(data[4:8], "big")
    header, content_type = headers[file_type]
    restored = bytearray(data)
    restored[: len(header)] = header
    return bytes(restored), content_type, book_id, page_number


def reorder_55comic_image(data: bytes, book_id: int, page_number: int, content_type: str) -> bytes:
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("55comic image recovery requires Pillow") from exc

    digest = hashlib.md5(f"{book_id}{page_number}".encode("ascii")).hexdigest()
    block_count = 44 + (ord(digest[-1]) % 10) * 4
    with Image.open(io.BytesIO(data)) as source:
        source.load()
        width, height = source.size
        if height < block_count:
            # This matches the site's canvas algorithm when floor(height / blocks) is 0:
            # the whole short image is drawn unchanged by the first iteration.
            restored = source.copy()
        else:
            restored = Image.new(source.mode, source.size)
            block_height = height // block_count
            remainder = height % block_count
            for block_index in range(block_count):
                crop_height = block_height + (remainder if block_index == 0 else 0)
                source_y = height - block_height * (block_index + 1) - remainder
                target_y = block_height * block_index + (remainder if block_index else 0)
                strip = source.crop((0, source_y, width, source_y + crop_height))
                restored.paste(strip, (0, target_y))

        output = io.BytesIO()
        if content_type == "image/jpeg":
            if restored.mode not in {"RGB", "L"}:
                restored = restored.convert("RGB")
            restored.save(output, format="JPEG", quality=95, subsampling=0)
        elif content_type == "image/png":
            restored.save(output, format="PNG")
        elif content_type == "image/gif":
            restored.save(output, format="GIF")
        elif content_type == "image/avif":
            restored.save(output, format="AVIF", quality=95)
        else:
            raise ValueError(f"Unsupported recovered image content type: {content_type}")
        return output.getvalue()


def recover_55comic_image(
    url: str,
    *,
    referer: str,
    timeout: int,
    retries: int,
    robots: RobotsCache | None,
) -> tuple[bytes, str, str, dict[str, str]]:
    parsed = urlparse(url)
    clean_path = re.sub(r"/break[^/]*/", "/", parsed.path, count=1)
    split_path = re.sub(r"\.(?:jpe?g|png|gif|avif|webp)$", ".b_{index}", clean_path, flags=re.I)
    if split_path == clean_path:
        raise ValueError(f"Unsupported 55comic image URL: {url}")

    primary_host = parsed.netloc
    alternate_host = primary_host.replace("bmigmij-", "bmigmih-", 1)
    hosts = [primary_host, alternate_host]
    decrypted_parts: list[bytes] = []
    split_urls: list[str] = []
    for index, host in enumerate(hosts):
        part_url = urlunparse(
            (parsed.scheme, host, f"/break_2{split_path.format(index=index)}", "", "", "")
        )
        if robots and not robots.allowed(part_url):
            raise PermissionError(f"Blocked by robots.txt: {part_url}")
        encrypted, final_url, _content_type, _headers = fetch_bytes(
            part_url,
            referer=referer,
            accept="application/octet-stream,*/*;q=0.8",
            timeout=timeout,
            retries=retries,
        )
        decrypted_parts.append(decrypt_55comic_part(encrypted))
        split_urls.append(final_url)

    restored, content_type, book_id, page_number = inject_55comic_image_header(
        b"".join(decrypted_parts)
    )
    image_data = reorder_55comic_image(restored, book_id, page_number, content_type)
    return image_data, split_urls[-1], content_type, {"x-55comic-parts": ",".join(split_urls)}


def extension_for(content_type: str, final_url: str, fallback_url: str) -> str:
    content_type = content_type.split(";")[0].lower()
    mapping = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/avif": ".avif",
        "image/bmp": ".bmp",
    }
    if content_type in mapping:
        return mapping[content_type]
    for candidate in (final_url, fallback_url):
        suffix = Path(urlparse(candidate).path).suffix.lower()
        if suffix:
            return suffix
    guessed = mimetypes.guess_extension(content_type)
    return guessed or ".bin"


def content_type_for_url(url: str) -> str | None:
    suffix = Path(urlparse(url).path).suffix.lower()
    mapping = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".avif": "image/avif",
        ".bmp": "image/bmp",
    }
    return mapping.get(suffix) or mimetypes.guess_type(url)[0]


def safe_relpath(path: Path, base: Path) -> str:
    return path.resolve().relative_to(base.resolve()).as_posix()


def find_cached_image(image_dir: Path, image_index: int) -> Path | None:
    for suffix in sorted(IMAGE_EXTS):
        path = image_dir / f"{image_index:03d}{suffix}"
        if path.exists() and path.is_file():
            return path
    return None


def html_attr_escape(value: str) -> str:
    return html_lib.escape(value, quote=True)


def set_img_attr(tag: str, attr: str, value: str) -> str:
    escaped = html_attr_escape(value)
    pattern = re.compile(ATTR_RE_TEMPLATE.format(attr=re.escape(attr)), re.I | re.S)
    if pattern.search(tag):
        return pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}{escaped}{m.group(2)}", tag)
    return re.sub(r"\s*/?>$", f' {attr}="{escaped}">', tag, count=1)


def rewrite_html_title(page_html: str, title: str) -> str:
    escaped = html_lib.escape(title, quote=False)
    if re.search(r"<title\b[^>]*>.*?</title>", page_html, flags=re.I | re.S):
        return re.sub(
            r"<title\b[^>]*>.*?</title>",
            f"<title>{escaped}</title>",
            page_html,
            count=1,
            flags=re.I | re.S,
        )
    return re.sub(
        r"</head>",
        f"<title>{escaped}</title></head>",
        page_html,
        count=1,
        flags=re.I,
    )


def first_image_url_in_tag(tag: str, page_url: str) -> str | None:
    for attr in IMAGE_ATTRS:
        pattern = re.compile(ATTR_RE_TEMPLATE.format(attr=re.escape(attr)), re.I | re.S)
        match = pattern.search(tag)
        if not match:
            continue
        url = normalize_url(urljoin(page_url, html_lib.unescape(match.group(3))))
        if is_image_candidate(url):
            return url
    return None


def localize_page_html(
    page_html: str,
    page_url: str,
    chapter: ChapterRecord,
    chapter_dir: Path,
    out_dir: Path,
) -> str:
    if chapter.title:
        page_html = rewrite_html_title(page_html, chapter.title)

    image_iter = iter(chapter.images)

    def replace_img(match: re.Match[str]) -> str:
        tag = match.group(0)
        source_url = first_image_url_in_tag(tag, page_url)
        if not source_url:
            return tag
        try:
            image = next(image_iter)
        except StopIteration:
            return tag
        if not image.local_path or image.status not in {"downloaded", "exists"}:
            return tag
        local_abs = out_dir / image.local_path
        try:
            local_src = local_abs.resolve().relative_to(chapter_dir.resolve()).as_posix()
        except ValueError:
            local_src = local_abs.resolve().as_posix()
        if tag.lstrip().lower().startswith("<div"):
            return f'<img src="{html_attr_escape(local_src)}" loading="lazy">'
        tag = set_img_attr(tag, "src", local_src)
        tag = set_img_attr(tag, "data-original", local_src)
        tag = set_img_attr(tag, "data-src", local_src)
        tag = re.sub(r"\s(?:data-srcset|srcset)\s*=\s*([\"']).*?\1", "", tag, flags=re.I | re.S)
        return tag

    localized = LOCALIZABLE_IMAGE_RE.sub(replace_img, page_html)
    localized = re.sub(
        r"</head>",
        (
            "<style>"
            "img{max-width:100%;height:auto;}"
            ".lazy{display:block;}"
            "</style></head>"
        ),
        localized,
        count=1,
        flags=re.I,
    )
    return localized


def download_image(
    source_url: str,
    image_dir: Path,
    image_index: int,
    page_url: str,
    base_dir: Path,
    *,
    timeout: int,
    retries: int,
    prefer_webp: bool,
    overwrite: bool,
    robots: RobotsCache | None,
) -> ImageRecord:
    record = ImageRecord(index=image_index, source_url=source_url)
    if not overwrite:
        cached_path = find_cached_image(image_dir, image_index)
        if cached_path:
            record.status = "exists"
            record.bytes = cached_path.stat().st_size
            record.local_path = safe_relpath(cached_path, base_dir)
            record.content_type = content_type_for_url(cached_path.name)
            return record

    encrypted_55comic = is_55comic_encrypted_image(source_url)
    candidates: Iterable[str] = (
        [source_url] if encrypted_55comic else image_download_candidates(source_url, prefer_webp)
    )
    for candidate_url in candidates:
        if robots and not robots.allowed(candidate_url):
            record.status = "skipped_robots"
            record.error = f"Blocked by robots.txt: {candidate_url}"
            continue
        try:
            if encrypted_55comic:
                data, final_url, content_type, _headers = recover_55comic_image(
                    candidate_url,
                    referer=page_url,
                    timeout=timeout,
                    retries=retries,
                    robots=robots,
                )
            else:
                data, final_url, content_type, _headers = fetch_bytes(
                    candidate_url,
                    referer=page_url,
                    accept=IMAGE_ACCEPT,
                    timeout=timeout,
                    retries=retries,
                )
            if content_type and not content_type.startswith("image/"):
                raise ValueError(f"Unexpected content type: {content_type}")
            ext = extension_for(content_type, final_url, candidate_url)
            filename = f"{image_index:03d}{ext}"
            image_path = image_dir / filename
            if image_path.exists() and not overwrite:
                record.status = "exists"
                record.bytes = image_path.stat().st_size
            else:
                tmp_path = image_path.with_suffix(image_path.suffix + ".part")
                tmp_path.write_bytes(data)
                tmp_path.replace(image_path)
                record.status = "downloaded"
                record.bytes = len(data)
            record.downloaded_url = candidate_url
            record.final_url = final_url
            record.local_path = safe_relpath(image_path, base_dir)
            record.content_type = (
                content_type
                or content_type_for_url(final_url)
                or content_type_for_url(candidate_url)
            )
            record.error = None
            return record
        except Exception as exc:
            record.status = "failed"
            record.downloaded_url = candidate_url
            record.error = str(exc)
            continue
    return record


def download_chapter_images(
    image_urls: list[str],
    image_dir: Path,
    page_url: str,
    out_dir: Path,
    *,
    timeout: int,
    retries: int,
    prefer_webp: bool,
    overwrite: bool,
    robots: RobotsCache | None,
    image_workers: int,
    image_delay: float,
    progress_callback=None,
) -> list[ImageRecord]:
    total = len(image_urls)
    if total == 0:
        return []

    workers = max(1, min(image_workers, total))

    def run_one(item: tuple[int, str]) -> ImageRecord:
        image_index, image_url = item
        record = download_image(
            image_url,
            image_dir,
            image_index,
            page_url,
            out_dir,
            timeout=timeout,
            retries=retries,
            prefer_webp=prefer_webp,
            overwrite=overwrite,
            robots=robots,
        )
        if image_delay and record.status in {"downloaded", "failed"}:
            time.sleep(image_delay)
        return record

    items = list(enumerate(image_urls, start=1))
    results: dict[int, ImageRecord] = {}
    if workers == 1:
        for item in items:
            record = run_one(item)
            results[record.index] = record
            print(
                f"    [{record.index:03d}/{total:03d}] "
                f"{record.status} {record.local_path or record.source_url}"
            )
            if progress_callback:
                progress_callback(len(results), total, record)
    else:
        print(f"    image workers: {workers}")
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {executor.submit(run_one, item): item for item in items}
            for future in as_completed(future_map):
                image_index, image_url = future_map[future]
                try:
                    record = future.result()
                except Exception as exc:
                    record = ImageRecord(
                        index=image_index,
                        source_url=image_url,
                        status="failed",
                        error=str(exc),
                    )
                results[record.index] = record
                print(
                    f"    [{record.index:03d}/{total:03d}] "
                    f"{record.status} {record.local_path or record.source_url}"
                )
                if progress_callback:
                    progress_callback(len(results), total, record)

    return [results[index] for index in range(1, total + 1) if index in results]


def chapter_viewer_href(
    current_chapter_dir: Path,
    target: ChapterRecord | None,
    out_dir: Path,
) -> str | None:
    if not target or not target.html_path:
        return None
    target_dir = out_dir / Path(target.html_path).parent
    return os.path.relpath(target_dir / "index.html", current_chapter_dir).replace("\\", "/")


def chapter_nav_html(
    current_chapter_dir: Path,
    prev_chapter: ChapterRecord | None,
    next_chapter: ChapterRecord | None,
    out_dir: Path,
) -> tuple[str, str | None, str | None]:
    prev_href = chapter_viewer_href(current_chapter_dir, prev_chapter, out_dir)
    next_href = chapter_viewer_href(current_chapter_dir, next_chapter, out_dir)
    catalog_href = os.path.relpath(out_dir / "index.html", current_chapter_dir).replace("\\", "/")
    prev_label = "上一章" if prev_href else "上一章"
    next_label = "下一章" if next_href else "下一章"
    prev_item = (
        f'<a href="{html_attr_escape(prev_href)}">{prev_label}</a>'
        if prev_href
        else f'<span class="disabled">{prev_label}</span>'
    )
    next_item = (
        f'<a href="{html_attr_escape(next_href)}">{next_label}</a>'
        if next_href
        else f'<span class="disabled">{next_label}</span>'
    )
    nav = (
        '<nav class="chapter-nav">'
        f"{prev_item}"
        f'<a href="{html_attr_escape(catalog_href)}">目录</a>'
        f"{next_item}"
        "</nav>"
    )
    return nav, prev_href, next_href


def write_chapter_viewer(
    chapter: ChapterRecord,
    chapter_dir: Path,
    out_dir: Path,
    prev_chapter: ChapterRecord | None = None,
    next_chapter: ChapterRecord | None = None,
) -> None:
    nav_html, prev_href, next_href = chapter_nav_html(
        chapter_dir,
        prev_chapter,
        next_chapter,
        out_dir,
    )
    lines = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{html_lib.escape(chapter.title or chapter.slug)}</title>",
        "<style>",
        "body{margin:0;background:#f5f5f5;color:#111;font-family:system-ui,sans-serif;}",
        "header{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid #ddd;padding:12px 16px;}",
        "main{max-width:980px;margin:0 auto;background:#fff;}",
        "img{display:block;width:100%;height:auto;}",
        "a{color:#06c;text-decoration:none;}",
        "a:hover{text-decoration:underline;}",
        ".chapter-title{font-weight:700;margin-bottom:8px;}",
        ".chapter-nav{display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;}",
        ".chapter-nav a,.chapter-nav .disabled{padding:6px 10px;border:1px solid #ddd;border-radius:6px;background:#fafafa;}",
        ".chapter-nav .disabled{color:#999;background:#f2f2f2;}",
        "footer{padding:16px;background:#fff;border-top:1px solid #ddd;}",
        "</style>",
        "</head>",
        "<body>",
        "<header>",
        f'<div class="chapter-title">{html_lib.escape(chapter.title or chapter.slug)}</div>',
        nav_html,
        "</header>",
        "<main>",
    ]
    for image in chapter.images:
        if image.local_path and image.status in {"downloaded", "exists"}:
            rel = Path(image.local_path)
            try:
                src = rel.relative_to(Path(chapter.html_path or ".").parent.parent.parent)
            except Exception:
                src = Path("images") / Path(image.local_path).name
            src = Path(image.local_path).name
            lines.append(f'<img src="images/{html_lib.escape(src)}" loading="lazy">')
    lines.extend(
        [
            "</main>",
            f"<footer>{nav_html}</footer>",
            "<script>",
            f"const prevHref = {json.dumps(prev_href)};",
            f"const nextHref = {json.dumps(next_href)};",
            "document.addEventListener('keydown', (event) => {",
            "  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;",
            "  if (event.key === 'ArrowLeft' && prevHref) location.href = prevHref;",
            "  if (event.key === 'ArrowRight' && nextHref) location.href = nextHref;",
            "});",
            "</script>",
            "</body>",
            "</html>",
        ]
    )
    (chapter_dir / "index.html").write_text("\n".join(lines), encoding="utf-8")


def write_chapter_viewers(chapters: list[ChapterRecord], out_dir: Path) -> None:
    viewable = [chapter for chapter in sorted(chapters, key=lambda item: item.index) if chapter.html_path]
    for position, chapter in enumerate(viewable):
        chapter_dir = out_dir / Path(chapter.html_path).parent
        if not chapter_dir.exists() and chapter_archive_path(chapter_dir).exists():
            continue
        prev_chapter = viewable[position - 1] if position > 0 else None
        next_chapter = viewable[position + 1] if position + 1 < len(viewable) else None
        write_chapter_viewer(chapter, chapter_dir, out_dir, prev_chapter, next_chapter)


def catalog_meta_path(out_dir: Path) -> Path:
    return out_dir / "catalog.json"


def html_text(value: str) -> str:
    return clean_text(html_lib.unescape(re.sub(r"<[^>]+>", " ", value or "")))


def first_catalog_match(catalog_html: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, catalog_html, re.I | re.S)
        value = html_text(match.group(1)) if match else ""
        if value:
            return value
    return ""


def extract_catalog_metadata(catalog_html: str, catalog_url: str, title: str) -> dict:
    description = first_catalog_match(
        catalog_html,
        [
            r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']*)["\']',
            r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+name=["\']description["\']',
            r'(?:简介|簡介|剧情|劇情)\s*[：:]\s*([\s\S]{1,800}?)(?:</li>|</div>)',
        ],
    )
    description = re.sub(r"^《[^》]+》(?:在线|在線)阅读，(?:剧情|劇情)(?:介绍|介紹)：?", "", description).strip()
    author = first_catalog_match(
        catalog_html,
        [
            r'<[^>]+class=["\'][^"\']*sp-book-author[^"\']*["\'][^>]*>\s*作者\s*[：:]\s*([\s\S]*?)</[^>]+>',
            r'作者\s*[：:]\s*[\s\S]{0,180}?<a[^>]*>([\s\S]*?)</a>',
            r'video-info-itemtitle[^>]*>\s*作者\s*[：:]\s*</span>[\s\S]{0,160}?<div[^>]*>([\s\S]*?)</div>',
            r'作者\s*[：:]\s*([^<\r\n]{1,100})',
        ],
    )
    status = first_catalog_match(
        catalog_html,
        [
            r'(?:状态|狀態)\s*[：:]\s*<span[^>]*>([\s\S]*?)</span>',
            r'(?:状态|狀態)\s*[：:]\s*</em>\s*<span[^>]*>([\s\S]*?)</span>',
            r'video-info-itemtitle[^>]*>\s*更新\s*[：:]\s*</span>[\s\S]{0,120}?<div[^>]*>([\s\S]*?)</div>',
        ],
    )
    region = first_catalog_match(
        catalog_html,
        [
            r'(?:地区|地區)\s*[：:]\s*<span[^>]*>([\s\S]*?)</span>',
            r'(?:地区|地區)\s*[：:]\s*([^<\r\n]{1,80})',
        ],
    )
    source_updated_at = first_catalog_match(
        catalog_html,
        [
            r'更新\s*[：:]\s*<span[^>]*>([\s\S]*?)</span>',
            r'(?:更新时间|更新時間)\s*[：:]\s*([^<\r\n]{1,80})',
        ],
    )
    cover_url = first_catalog_match(
        catalog_html,
        [
            r'sp-book-cover[\s\S]{0,500}?data-src=["\']([^"\']+)["\']',
            r'hl-dc-pic[\s\S]{0,500}?data-original=["\']([^"\']+)["\']',
            r'module-item-cover[\s\S]{0,500}?data-original=["\']([^"\']+)["\']',
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        ],
    )
    if cover_url:
        cover_url = normalize_url(urljoin(catalog_url, html_lib.unescape(cover_url)))

    tag_blocks = [
        match.group(1)
        for pattern in (
            r'<div[^>]+class=["\'][^"\']*sp-book-tags[^"\']*["\'][^>]*>([\s\S]*?)</div>',
            r'(?:TAG|分类|分類)\s*[：:]([\s\S]{0,800}?)(?:</li>|</div>\s*<div)',
        )
        for match in [re.search(pattern, catalog_html, re.I | re.S)]
        if match
    ]
    tags: list[str] = []
    for tag_block in tag_blocks:
        tags.extend(
            html_text(match.group(1))
            for match in re.finditer(r'<a[^>]*>([\s\S]*?)</a>', tag_block, re.I)
        )
    tags = list(dict.fromkeys(tag for tag in tags if tag))
    if not region:
        region = "韩国" if any(tag in {"韩漫", "韓漫"} for tag in tags) else ""

    return {
        "url": catalog_url,
        "title": title,
        "author": author,
        "description": description,
        "status": status,
        "region": region,
        "source_updated_at": source_updated_at,
        "tags": tags,
        "cover_url": cover_url,
    }


def load_catalog_metadata(out_dir: Path) -> dict:
    return read_json_file(catalog_meta_path(out_dir))


def cache_catalog_cover(
    meta: dict,
    out_dir: Path,
    *,
    timeout: int,
    retries: int,
    robots: RobotsCache | None = None,
) -> None:
    existing_path = str(meta.get("cover_path") or "").strip()
    if existing_path:
        existing_file = out_dir / existing_path
        if existing_file.is_file() and existing_file.stat().st_size > 0:
            return
    cover_url = str(meta.get("cover_url") or "").strip()
    if not cover_url:
        return
    try:
        if is_55comic_encrypted_image(cover_url):
            data, final_url, content_type, _headers = recover_55comic_image(
                cover_url,
                referer=str(meta.get("url") or "") or cover_url,
                timeout=timeout,
                retries=retries,
                robots=robots,
            )
        else:
            if robots and not robots.allowed(cover_url):
                raise PermissionError(f"Blocked by robots.txt: {cover_url}")
            data, final_url, content_type, _headers = fetch_bytes(
                cover_url,
                referer=str(meta.get("url") or "") or None,
                accept=IMAGE_ACCEPT,
                timeout=timeout,
                retries=retries,
            )
        if content_type and not content_type.startswith("image/"):
            raise ValueError(f"Unexpected cover content type: {content_type}")
        ext = extension_for(content_type, final_url, cover_url)
        cover_path = out_dir / f"cover{ext}"
        temporary = cover_path.with_suffix(cover_path.suffix + ".part")
        temporary.write_bytes(data)
        temporary.replace(cover_path)
        meta["cover_path"] = cover_path.name
        meta["cover_bytes"] = len(data)
        meta["cover_content_type"] = content_type or content_type_for_url(cover_path.name) or ""
        print(f"Cover: {cover_path}")
    except Exception as exc:
        meta["cover_error"] = str(exc)
        print(f"Cover warning: {exc}", file=sys.stderr)


def write_catalog_meta(
    out_dir: Path,
    catalog_url: str,
    title: str,
    metadata: dict | None = None,
) -> None:
    meta = {
        "url": catalog_url,
        "title": title,
        **(metadata or {}),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    catalog_meta_path(out_dir).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_catalog_title(out_dir: Path) -> str:
    meta_path = catalog_meta_path(out_dir)
    if meta_path.exists():
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            title = clean_text(str(data.get("title") or ""))
            if title:
                return title
        except (OSError, json.JSONDecodeError):
            pass
    catalog_html = out_dir / "catalog.html"
    if catalog_html.exists():
        page = parse_page(catalog_html.read_text(encoding="utf-8", errors="replace"))
        title = clean_catalog_title(page.title)
        if title:
            return title
    return "smtt6 local image cache"


def write_main_viewer(chapters: list[ChapterRecord], out_dir: Path, catalog_title: str | None = None) -> None:
    display_title = catalog_title or load_catalog_title(out_dir)
    library_href = "../index.html"
    lines = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{html_lib.escape(display_title)}</title>",
        "<style>",
        "body{margin:0;background:#f7f7f7;color:#111;font-family:system-ui,sans-serif;}",
        "main{max-width:980px;margin:0 auto;padding:24px 16px;}",
        "ol{padding-left:24px;}",
        "li{margin:8px 0;}",
        "a{color:#06c;text-decoration:none;}",
        "a:hover{text-decoration:underline;}",
        ".topbar{margin-bottom:12px;}",
        ".meta{color:#666;font-size:14px;margin-left:8px;}",
        "</style>",
        "</head>",
        "<body><main>",
        f'<div class="topbar"><a href="{library_href}">返回书架</a></div>',
        f"<h1>{html_lib.escape(display_title)}</h1>",
        "<ol>",
    ]
    for chapter in chapters:
        if not chapter.html_path:
            continue
        chapter_dir = Path(chapter.html_path).parent
        href = chapter_dir.joinpath("index.html").as_posix()
        label = html_lib.escape(chapter.title or chapter.slug)
        meta = f"{chapter.downloaded_count} downloaded, {chapter.failed_count} failed"
        lines.append(f'<li><a href="{href}">{label}</a><span class="meta">{meta}</span></li>')
    lines.extend(["</ol>", "</main></body>", "</html>"])
    (out_dir / "index.html").write_text("\n".join(lines), encoding="utf-8")


def read_json_file(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def library_entries(root_dir: Path) -> list[dict]:
    entries: list[dict] = []
    for cache_dir in sorted(root_dir.iterdir(), key=lambda item: item.name.lower()):
        if not cache_dir.is_dir() or not re.match(r"^(smtt6|jmd9|55comic)_cache_", cache_dir.name):
            continue
        index_path = cache_dir / "index.html"
        if not index_path.exists():
            continue
        catalog = read_json_file(cache_dir / "catalog.json")
        manifest = read_json_file(cache_dir / "manifest.json")
        chapters = manifest.get("chapters", [])
        if not isinstance(chapters, list):
            chapters = []
        chapter_count = len(chapters)
        complete_count = sum(
            1
            for item in chapters
            if isinstance(item, dict)
            and int(item.get("image_count") or 0) == int(item.get("downloaded_count") or 0)
            and int(item.get("failed_count") or 0) == 0
            and int(item.get("skipped_count") or 0) == 0
        )
        image_count = sum(int(item.get("downloaded_count") or 0) for item in chapters if isinstance(item, dict))
        failed_count = sum(int(item.get("failed_count") or 0) for item in chapters if isinstance(item, dict))
        title = clean_text(str(catalog.get("title") or "")) or load_catalog_title(cache_dir)
        url = clean_text(str(catalog.get("url") or ""))
        updated_at = clean_text(str(catalog.get("updated_at") or ""))
        if cache_dir.name.startswith("jmd9_"):
            site = "jmd9"
        elif cache_dir.name.startswith("55comic_"):
            site = "55comic"
        else:
            site = "smtt6"
        entries.append(
            {
                "name": cache_dir.name,
                "site": site,
                "title": title,
                "url": url,
                "updated_at": updated_at,
                "href": os.path.relpath(index_path, root_dir).replace("\\", "/"),
                "chapter_count": chapter_count,
                "complete_count": complete_count,
                "image_count": image_count,
                "failed_count": failed_count,
            }
        )
    return entries


def write_library_index(root_dir: Path) -> None:
    entries = library_entries(root_dir)
    lines = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>漫画缓存书架</title>",
        "<style>",
        "body{margin:0;background:#f7f7f7;color:#111;font-family:system-ui,sans-serif;}",
        "main{max-width:1100px;margin:0 auto;padding:24px 16px;}",
        "h1{margin:0 0 16px;font-size:28px;}",
        ".summary{color:#666;margin-bottom:18px;}",
        ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;}",
        ".item{border:1px solid #ddd;background:#fff;border-radius:8px;padding:14px;}",
        ".title{font-weight:700;line-height:1.35;margin-bottom:8px;}",
        ".meta{color:#666;font-size:13px;line-height:1.6;}",
        ".site{display:inline-block;margin-right:8px;padding:2px 6px;border:1px solid #ddd;border-radius:999px;background:#fafafa;color:#444;font-size:12px;}",
        "a{color:#06c;text-decoration:none;}",
        "a:hover{text-decoration:underline;}",
        "</style>",
        "</head>",
        "<body><main>",
        "<h1>漫画缓存书架</h1>",
        f'<div class="summary">共 {len(entries)} 个缓存目录</div>',
        '<div class="grid">',
    ]
    for entry in entries:
        status = f"{entry['complete_count']}/{entry['chapter_count']} 章完成"
        image_meta = f"{entry['image_count']} 张图"
        if entry["failed_count"]:
            image_meta += f"，{entry['failed_count']} 失败"
        updated = f"更新：{html_lib.escape(entry['updated_at'])}" if entry["updated_at"] else ""
        source = f'<div class="meta">源：{html_lib.escape(entry["url"])}</div>' if entry["url"] else ""
        lines.extend(
            [
                '<section class="item">',
                f'<div><span class="site">{html_lib.escape(entry["site"])}</span><span class="meta">{html_lib.escape(entry["name"])}</span></div>',
                f'<div class="title"><a href="{html_attr_escape(entry["href"])}">{html_lib.escape(entry["title"])}</a></div>',
                f'<div class="meta">{html_lib.escape(status)}，{html_lib.escape(image_meta)}</div>',
                f'<div class="meta">{updated}</div>' if updated else "",
                source,
                "</section>",
            ]
        )
    lines.extend(["</div>", "</main></body>", "</html>"])
    (root_dir / "index.html").write_text("\n".join(line for line in lines if line), encoding="utf-8")


def is_cache_dir(path: Path) -> bool:
    return path.is_dir() and (path / "chapters").is_dir() and (
        bool(re.match(r"^(smtt6|jmd9|55comic)_cache_", path.name))
        or (path / "manifest.json").exists()
    )


def chapter_archive_path(chapter_dir: Path) -> Path:
    return chapter_dir.with_name(f"{chapter_dir.name}.zip")


def chapter_dir_from_archive(zip_path: Path) -> Path:
    if zip_path.name.lower().endswith(".zip"):
        return zip_path.with_name(zip_path.name[:-4])
    return zip_path.with_suffix("")


def cache_dirs_for_operation(root_dir: Path, out_arg: str | None = None) -> list[Path]:
    if out_arg:
        return [Path(out_arg).resolve()]
    if is_cache_dir(root_dir):
        return [root_dir]
    return [path for path in sorted(root_dir.iterdir(), key=lambda item: item.name.lower()) if is_cache_dir(path)]


def zip_chapter_dir(
    chapter_dir: Path,
    *,
    remove_source: bool,
    overwrite: bool,
    compression: int,
) -> tuple[str, int]:
    zip_path = chapter_archive_path(chapter_dir)
    if zip_path.exists() and not overwrite:
        return "skipped_exists", 0

    tmp_path = zip_path.with_name(f"{zip_path.name}.part")
    if tmp_path.exists():
        tmp_path.unlink()

    bytes_written = 0
    compresslevel = 9 if compression == zipfile.ZIP_DEFLATED else None
    with zipfile.ZipFile(
        tmp_path,
        "w",
        compression=compression,
        compresslevel=compresslevel,
        allowZip64=True,
    ) as archive:
        for path in sorted(chapter_dir.rglob("*"), key=lambda item: item.as_posix().lower()):
            if not path.is_file():
                continue
            archive.write(path, path.relative_to(chapter_dir).as_posix())
            bytes_written += path.stat().st_size

    with zipfile.ZipFile(tmp_path, "r") as archive:
        bad_member = archive.testzip()
        if bad_member:
            raise RuntimeError(f"zip verification failed at {bad_member}")

    tmp_path.replace(zip_path)
    if remove_source:
        shutil.rmtree(chapter_dir)
    return "packed", bytes_written


def pack_cache_chapters(
    cache_dir: Path,
    *,
    remove_source: bool,
    overwrite: bool,
    compression: int,
) -> dict[str, int]:
    chapters_dir = cache_dir / "chapters"
    summary = {
        "packed": 0,
        "skipped": 0,
        "failed": 0,
        "deleted_dirs": 0,
        "source_bytes": 0,
    }
    if not chapters_dir.is_dir():
        print(f"[WARN] no chapters directory: {chapters_dir}", file=sys.stderr)
        return summary

    chapter_dirs = [
        path
        for path in sorted(chapters_dir.iterdir(), key=lambda item: item.name.lower())
        if path.is_dir() and not path.name.startswith(".")
    ]
    for chapter_dir in chapter_dirs:
        try:
            status, source_bytes = zip_chapter_dir(
                chapter_dir,
                remove_source=remove_source,
                overwrite=overwrite,
                compression=compression,
            )
            if status == "packed":
                summary["packed"] += 1
                summary["source_bytes"] += source_bytes
                if remove_source:
                    summary["deleted_dirs"] += 1
                print(f"[PACK] {chapter_archive_path(chapter_dir)}")
            else:
                summary["skipped"] += 1
                print(f"[SKIP] zip exists: {chapter_archive_path(chapter_dir)}")
        except Exception as exc:
            summary["failed"] += 1
            print(f"[WARN] failed to pack {chapter_dir}: {exc}", file=sys.stderr)
    return summary


def pack_chapters(args: argparse.Namespace) -> int:
    root_dir = Path.cwd().resolve()
    cache_dirs = cache_dirs_for_operation(root_dir, args.out)
    if not cache_dirs:
        print(f"No cache directories found under: {root_dir}", file=sys.stderr)
        return 1

    compression = ZIP_COMPRESSION_METHODS[args.zip_compression]
    totals = {
        "packed": 0,
        "skipped": 0,
        "failed": 0,
        "deleted_dirs": 0,
        "source_bytes": 0,
    }
    for cache_dir in cache_dirs:
        print(f"[CACHE] {cache_dir}")
        summary = pack_cache_chapters(
            cache_dir,
            remove_source=not args.keep_unpacked,
            overwrite=args.overwrite_zip,
            compression=compression,
        )
        for key in totals:
            totals[key] += summary[key]

    print(f"[SUMMARY] packed chapters : {totals['packed']}")
    print(f"[SUMMARY] skipped existing: {totals['skipped']}")
    print(f"[SUMMARY] failed          : {totals['failed']}")
    print(f"[SUMMARY] deleted dirs     : {totals['deleted_dirs']}")
    return 0 if totals["failed"] == 0 else 2


def clear_unpacked_cache(args: argparse.Namespace) -> int:
    root_dir = Path.cwd().resolve()
    cache_dirs = cache_dirs_for_operation(root_dir, args.out)
    if not cache_dirs:
        print(f"No cache directories found under: {root_dir}", file=sys.stderr)
        return 1

    deleted = 0
    skipped = 0
    failed = 0
    for cache_dir in cache_dirs:
        chapters_dir = cache_dir / "chapters"
        if not chapters_dir.is_dir():
            continue
        print(f"[CACHE] {cache_dir}")
        for chapter_dir in sorted(chapters_dir.iterdir(), key=lambda item: item.name.lower()):
            if not chapter_dir.is_dir() or chapter_dir.name.startswith("."):
                continue
            zip_path = chapter_archive_path(chapter_dir)
            if not zip_path.exists():
                skipped += 1
                print(f"[SKIP] no zip, keep: {chapter_dir}")
                continue
            try:
                shutil.rmtree(chapter_dir)
                deleted += 1
                print(f"[DEL] {chapter_dir}")
            except Exception as exc:
                failed += 1
                print(f"[WARN] failed to delete {chapter_dir}: {exc}", file=sys.stderr)

    print(f"[SUMMARY] deleted unpacked chapters: {deleted}")
    print(f"[SUMMARY] skipped without zip      : {skipped}")
    print(f"[SUMMARY] failed                  : {failed}")
    return 0 if failed == 0 else 2


def safe_extract_zip(zip_path: Path, target_dir: Path) -> None:
    target_root = target_dir.resolve()
    with zipfile.ZipFile(zip_path, "r") as archive:
        bad_member = archive.testzip()
        if bad_member:
            raise RuntimeError(f"zip verification failed at {bad_member}")
        for member in archive.infolist():
            if "\\" in member.filename:
                raise RuntimeError(f"unsafe zip member path: {member.filename}")
            member_path = PurePosixPath(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise RuntimeError(f"unsafe zip member path: {member.filename}")
            destination = (target_dir / Path(*member_path.parts)).resolve()
            if destination != target_root and target_root not in destination.parents:
                raise RuntimeError(f"unsafe zip member path: {member.filename}")
        archive.extractall(target_dir)


def unpack_chapter_archive(zip_path: Path) -> Path:
    target_dir = chapter_dir_from_archive(zip_path)
    if target_dir.exists():
        return target_dir

    temp_dir = target_dir.with_name(f".{target_dir.name}.extracting")
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True)
    try:
        safe_extract_zip(zip_path, temp_dir)
        temp_dir.replace(target_dir)
    except Exception:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        raise
    return target_dir


def unpack_chapter_for_request(root_dir: Path, request_target: str) -> None:
    request_path = unquote(urlparse(request_target).path).lstrip("/")
    parts = [part for part in PurePosixPath(request_path).parts if part not in {"", "."}]
    for index, part in enumerate(parts):
        if part != "chapters" or index + 1 >= len(parts):
            continue
        chapter_dir = root_dir / Path(*parts[: index + 2])
        zip_path = chapter_archive_path(chapter_dir)
        if zip_path.exists() and not chapter_dir.exists():
            print(f"[UNPACK] {zip_path}")
            unpack_chapter_archive(zip_path)
        return


def make_lazy_unpack_handler(root_dir: Path) -> type[http.server.SimpleHTTPRequestHandler]:
    class LazyUnpackHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *handler_args: object, **handler_kwargs: object) -> None:
            super().__init__(*handler_args, directory=str(root_dir), **handler_kwargs)

        def do_GET(self) -> None:
            unpack_chapter_for_request(root_dir, self.path)
            super().do_GET()

        def do_HEAD(self) -> None:
            unpack_chapter_for_request(root_dir, self.path)
            super().do_HEAD()

    return LazyUnpackHandler


def serve_library(args: argparse.Namespace) -> int:
    serve_root = Path(args.out).resolve() if args.out else Path.cwd().resolve()
    if not serve_root.exists() or not serve_root.is_dir():
        print(f"Invalid serve directory: {serve_root}", file=sys.stderr)
        return 1

    handler = make_lazy_unpack_handler(serve_root)
    server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
    actual_host, actual_port = server.server_address[:2]
    url_host = "127.0.0.1" if actual_host in {"", "0.0.0.0"} else actual_host
    url = f"http://{url_host}:{actual_port}/index.html"
    print(f"Serving: {serve_root}")
    print(f"Open: {url}")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


def chapter_dir_for_record(chapter: ChapterRecord, out_dir: Path) -> Path | None:
    if chapter.html_path:
        return out_dir / Path(chapter.html_path).parent
    if chapter.slug:
        return out_dir / "chapters" / f"{chapter.index:03d}_{chapter.slug}"
    return None


def write_chapter_state(chapter: ChapterRecord, out_dir: Path) -> None:
    chapter_dir = chapter_dir_for_record(chapter, out_dir)
    if not chapter_dir:
        return
    if not chapter_dir.exists() and chapter_archive_path(chapter_dir).exists():
        return
    chapter_dir.mkdir(parents=True, exist_ok=True)
    state_path = chapter_dir / "chapter.json"
    done_path = chapter_dir / "chapter.done.json"
    record_data = chapter_record_to_dict(chapter)
    current_state = read_json_file(state_path)
    current_state.pop("updated_at", None)
    if current_state != record_data:
        state = {
            **record_data,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        state_path.write_text(
            json.dumps(state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    if is_chapter_complete(chapter):
        current_done = read_json_file(done_path)
        if current_done.get("record") != record_data:
            done = {
                "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "record": record_data,
            }
            done_path.write_text(
                json.dumps(done, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    elif done_path.exists():
        done_path.unlink()


def write_cache_state(chapters: list[ChapterRecord], out_dir: Path) -> None:
    for chapter in chapters:
        if chapter.html_path:
            write_chapter_state(chapter, out_dir)


def read_chapter_record_file(path: Path) -> ChapterRecord | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(data, dict) and isinstance(data.get("record"), dict):
        data = data["record"]
    if not isinstance(data, dict):
        return None
    return chapter_record_from_dict(data)


def load_existing_records(out_dir: Path) -> dict[str, ChapterRecord]:
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        return {}
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    records: dict[str, ChapterRecord] = {}
    for item in data.get("chapters", []):
        if not isinstance(item, dict):
            continue
        record = chapter_record_from_dict(item)
        if record.url:
            records[chapter_identity(record.url)] = record
    return records


def load_manifest_chapters(out_dir: Path) -> list[ChapterRecord]:
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        return []
    data = read_json_file(manifest_path)
    chapters = data.get("chapters", [])
    if not isinstance(chapters, list):
        return []
    records = [chapter_record_from_dict(item) for item in chapters if isinstance(item, dict)]
    return sorted(records, key=lambda item: item.index)


def refresh_library(root_dir: Path) -> None:
    for cache_dir in sorted(root_dir.iterdir(), key=lambda item: item.name.lower()):
        if not cache_dir.is_dir() or not re.match(r"^(smtt6|jmd9|55comic)_cache_", cache_dir.name):
            continue
        chapters = load_manifest_chapters(cache_dir)
        if chapters:
            write_main_viewer(chapters, cache_dir, load_catalog_title(cache_dir))
    write_library_index(root_dir)


def normalize_loaded_chapter(
    record: ChapterRecord,
    *,
    chapter_index: int,
    chapter_url: str,
    slug: str,
    chapter_dir: Path,
    out_dir: Path,
    title_hint: str,
) -> ChapterRecord:
    page_file = chapter_dir / "page.html"
    record.index = chapter_index
    record.url = chapter_url
    record.slug = slug
    record.html_path = safe_relpath(page_file, out_dir)
    record.title = clean_chapter_title(record.title, title_hint)
    if title_hint and not record.title:
        record.title = clean_chapter_title(title_hint)
    record.status = "done"
    record.error = None
    return record


def completed_chapter_from_cache(
    chapter_dir: Path,
    out_dir: Path,
    *,
    chapter_index: int,
    chapter_url: str,
    slug: str,
    title_hint: str,
    existing_record: ChapterRecord | None,
    skip_completed: bool,
    overwrite: bool,
) -> ChapterRecord | None:
    if not skip_completed or overwrite:
        return None

    existing_chapter_dir = (
        chapter_dir_for_record(existing_record, out_dir)
        if existing_record
        else None
    )
    candidates = [
        (read_chapter_record_file(chapter_dir / "chapter.done.json"), chapter_dir),
        (existing_record, existing_chapter_dir or chapter_dir),
    ]
    for record, cached_chapter_dir in candidates:
        if not record:
            continue
        record = normalize_loaded_chapter(
            record,
            chapter_index=chapter_index,
            chapter_url=chapter_url,
            slug=slug,
            chapter_dir=cached_chapter_dir,
            out_dir=out_dir,
            title_hint=title_hint,
        )
        page_file = (
            out_dir / record.html_path
            if record.html_path
            else cached_chapter_dir / "page.html"
        )
        if is_chapter_complete(record) and page_file.exists():
            return record
        if is_chapter_complete(record) and chapter_archive_path(cached_chapter_dir).exists():
            return record
    return None


def write_manifests(chapters: list[ChapterRecord], out_dir: Path) -> None:
    manifest = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "chapters": [chapter_record_to_dict(chapter) for chapter in chapters],
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    with (out_dir / "manifest.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "chapter_index",
                "chapter_title",
                "chapter_url",
                "image_index",
                "source_url",
                "downloaded_url",
                "local_path",
                "content_type",
                "bytes",
                "status",
                "error",
            ]
        )
        for chapter in chapters:
            for image in chapter.images:
                writer.writerow(
                    [
                        chapter.index,
                        chapter.title,
                        chapter.url,
                        image.index,
                        image.source_url,
                        image.downloaded_url,
                        image.local_path,
                        image.content_type,
                        image.bytes,
                        image.status,
                        image.error,
                    ]
                )

    image_lines = []
    for chapter in chapters:
        for image in chapter.images:
            if image.local_path:
                image_lines.append(image.local_path)
    (out_dir / "images.txt").write_text("\n".join(image_lines), encoding="utf-8")
    write_cache_state(chapters, out_dir)


def default_database_path() -> Path:
    return DEFAULT_LIBRARY_ROOT / DEFAULT_DATABASE_FILE


def cache_site_from_dir(out_dir: Path) -> str:
    name = out_dir.name.lower()
    if name.startswith("smtt6_cache_"):
        return "smtt6"
    if name.startswith("jmd9_cache_"):
        return "jmd9"
    if name.startswith("55comic_cache_"):
        return "55comic"
    return "local"


def load_catalog_meta(out_dir: Path, catalog_url: str = "", catalog_title: str = "") -> tuple[str, str]:
    meta_url = catalog_url
    meta_title = catalog_title
    meta_path = catalog_meta_path(out_dir)
    if meta_path.exists():
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            meta_url = meta_url or clean_text(str(data.get("url") or ""))
            meta_title = meta_title or clean_text(str(data.get("title") or ""))
        except (OSError, json.JSONDecodeError):
            pass
    return meta_url, meta_title or clean_catalog_title("", out_dir.name)


def write_sqlite_index(
    chapters: list[ChapterRecord],
    out_dir: Path,
    database_path: Path | None,
    *,
    catalog_url: str = "",
    catalog_title: str = "",
    replace_all: bool = False,
) -> None:
    """Publish cache metadata to a shared SQLite read model.

    Incremental calls replace only the supplied chapters, while a final
    replace_all call makes the database exactly match the manifest. The
    image files remain the source of truth for media bytes; SQLite stores
    searchable metadata and safe relative paths for the local reader.
    """
    if database_path is None:
        return

    database_path = Path(database_path).resolve()
    out_dir = out_dir.resolve()
    database_path.parent.mkdir(parents=True, exist_ok=True)
    source_url, title = load_catalog_meta(out_dir, catalog_url, catalog_title)
    catalog_metadata = load_catalog_metadata(out_dir)
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    cache_key = str(out_dir)

    schema = """
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS manga_comics (
        cache_key TEXT PRIMARY KEY,
        dir_name TEXT NOT NULL,
        site TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        manifest_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        last_sync_at TEXT NOT NULL DEFAULT '',
        chapter_count INTEGER NOT NULL DEFAULT 0,
        done_chapter_count INTEGER NOT NULL DEFAULT 0,
        image_count INTEGER NOT NULL DEFAULT 0,
        downloaded_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        author TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        publication_status TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        cover_url TEXT NOT NULL DEFAULT '',
        cover_path TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_manga_comics_dir_name ON manga_comics(dir_name);
    CREATE TABLE IF NOT EXISTS manga_chapters (
        cache_key TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        slug TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        html_path TEXT,
        image_count INTEGER NOT NULL DEFAULT 0,
        downloaded_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        error TEXT,
        PRIMARY KEY (cache_key, chapter_index),
        FOREIGN KEY (cache_key) REFERENCES manga_comics(cache_key) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS manga_images (
        cache_key TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        image_index INTEGER NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        downloaded_url TEXT,
        final_url TEXT,
        local_path TEXT,
        content_type TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        error TEXT,
        PRIMARY KEY (cache_key, chapter_index, image_index),
        FOREIGN KEY (cache_key, chapter_index)
            REFERENCES manga_chapters(cache_key, chapter_index) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_manga_images_local_path
        ON manga_images(cache_key, local_path);
    """

    database = None
    try:
        database = sqlite3.connect(str(database_path), timeout=30)
        database.execute("PRAGMA journal_mode = WAL")
        database.execute("PRAGMA synchronous = NORMAL")
        database.executescript(schema)
        existing_columns = {row[1] for row in database.execute("PRAGMA table_info(manga_comics)")}
        for column, definition in {
            "author": "TEXT NOT NULL DEFAULT ''",
            "description": "TEXT NOT NULL DEFAULT ''",
            "publication_status": "TEXT NOT NULL DEFAULT ''",
            "region": "TEXT NOT NULL DEFAULT ''",
            "tags_json": "TEXT NOT NULL DEFAULT '[]'",
            "cover_url": "TEXT NOT NULL DEFAULT ''",
            "cover_path": "TEXT NOT NULL DEFAULT ''",
        }.items():
            if column not in existing_columns:
                database.execute(f"ALTER TABLE manga_comics ADD COLUMN {column} {definition}")
        database.commit()
        database.execute("BEGIN IMMEDIATE")
        database.execute(
            """
            INSERT INTO manga_comics (
                cache_key, dir_name, site, title, source_url, manifest_path,
                created_at, updated_at, last_sync_at, author, description,
                publication_status, region, tags_json, cover_url, cover_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                dir_name = excluded.dir_name,
                site = excluded.site,
                title = excluded.title,
                source_url = excluded.source_url,
                manifest_path = excluded.manifest_path,
                author = excluded.author,
                description = excluded.description,
                publication_status = excluded.publication_status,
                region = excluded.region,
                tags_json = excluded.tags_json,
                cover_url = excluded.cover_url,
                cover_path = excluded.cover_path,
                updated_at = excluded.updated_at,
                last_sync_at = excluded.last_sync_at
            """,
            (
                cache_key,
                out_dir.name,
                cache_site_from_dir(out_dir),
                title,
                source_url,
                safe_relpath(out_dir / "manifest.json", out_dir.parent),
                now,
                now,
                now,
                clean_text(str(catalog_metadata.get("author") or "")),
                clean_text(str(catalog_metadata.get("description") or "")),
                clean_text(str(catalog_metadata.get("status") or "")),
                clean_text(str(catalog_metadata.get("region") or "")),
                json.dumps(catalog_metadata.get("tags") or [], ensure_ascii=False),
                clean_text(str(catalog_metadata.get("cover_url") or "")),
                clean_text(str(catalog_metadata.get("cover_path") or "")),
            ),
        )
        if replace_all:
            database.execute("DELETE FROM manga_chapters WHERE cache_key = ?", (cache_key,))

        upsert_chapter = database.execute
        for chapter in chapters:
            chapter_index = int(chapter.index)
            upsert_chapter(
                """
                INSERT INTO manga_chapters (
                    cache_key, chapter_index, slug, title, url, html_path,
                    image_count, downloaded_count, skipped_count, failed_count,
                    status, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key, chapter_index) DO UPDATE SET
                    slug = excluded.slug,
                    title = excluded.title,
                    url = excluded.url,
                    html_path = excluded.html_path,
                    image_count = excluded.image_count,
                    downloaded_count = excluded.downloaded_count,
                    skipped_count = excluded.skipped_count,
                    failed_count = excluded.failed_count,
                    status = excluded.status,
                    error = excluded.error
                """,
                (
                    cache_key,
                    chapter_index,
                    chapter.slug,
                    chapter.title,
                    chapter.url,
                    chapter.html_path,
                    chapter.image_count,
                    chapter.downloaded_count,
                    chapter.skipped_count,
                    chapter.failed_count,
                    chapter.status,
                    chapter.error,
                ),
            )
            database.execute(
                "DELETE FROM manga_images WHERE cache_key = ? AND chapter_index = ?",
                (cache_key, chapter_index),
            )
            database.executemany(
                """
                INSERT INTO manga_images (
                    cache_key, chapter_index, image_index, source_url,
                    downloaded_url, final_url, local_path, content_type,
                    bytes, status, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        cache_key,
                        chapter_index,
                        image.index,
                        image.source_url,
                        image.downloaded_url,
                        image.final_url,
                        image.local_path,
                        image.content_type,
                        image.bytes,
                        image.status,
                        image.error,
                    )
                    for image in chapter.images
                ],
            )

        database.execute(
            """
            UPDATE manga_comics
            SET chapter_count = (
                    SELECT COUNT(*) FROM manga_chapters WHERE cache_key = ?
                ),
                done_chapter_count = (
                    SELECT COUNT(*) FROM manga_chapters
                    WHERE cache_key = ? AND status IN ('done', 'repaired')
                ),
                image_count = COALESCE((
                    SELECT SUM(image_count) FROM manga_chapters WHERE cache_key = ?
                ), 0),
                downloaded_count = COALESCE((
                    SELECT SUM(downloaded_count) FROM manga_chapters WHERE cache_key = ?
                ), 0),
                failed_count = COALESCE((
                    SELECT SUM(failed_count) FROM manga_chapters WHERE cache_key = ?
                ), 0),
                updated_at = ?,
                last_sync_at = ?
            WHERE cache_key = ?
            """,
            (cache_key, cache_key, cache_key, cache_key, cache_key, now, now, cache_key),
        )
        database.commit()
    except sqlite3.Error as exc:
        if database is not None:
            try:
                database.rollback()
            except Exception:
                pass
        print(f"SQLite index warning: {exc}", file=sys.stderr)
    finally:
        if database is not None:
            try:
                database.close()
            except Exception:
                pass


def records_from_manifest(out_dir: Path) -> list[ChapterRecord]:
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        return []
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [
        chapter_record_from_dict(item)
        for item in data.get("chapters", [])
        if isinstance(item, dict)
    ]


def rebuild_sqlite_index(args: argparse.Namespace) -> int:
    database_path = Path(args.database or default_database_path()).resolve()
    library_root = database_path.parent
    if args.out:
        candidates = [Path(args.out).resolve()]
    else:
        candidates = [
            entry
            for entry in library_root.iterdir()
            if entry.is_dir()
            and re.match(r"^(?:smtt6|jmd9|55comic)_cache_[A-Za-z0-9_-]+$", entry.name, re.I)
        ]
    indexed = 0
    for out_dir in sorted(candidates, key=lambda item: item.name.lower()):
        records = records_from_manifest(out_dir)
        if not records:
            continue
        source_url, title = load_catalog_meta(out_dir)
        catalog_html_path = out_dir / "catalog.html"
        if catalog_html_path.exists():
            catalog_html = catalog_html_path.read_text(encoding="utf-8", errors="replace")
            parsed_title = clean_catalog_title(parse_page(catalog_html).title, out_dir.name)
            title = parsed_title or title
            metadata = extract_catalog_metadata(catalog_html, source_url, title)
            existing_metadata = load_catalog_metadata(out_dir)
            if existing_metadata.get("cover_path"):
                metadata["cover_path"] = existing_metadata["cover_path"]
            if getattr(args, "cache_covers", False) and not metadata.get("cover_path"):
                cache_catalog_cover(metadata, out_dir, timeout=args.timeout, retries=args.retries)
            write_catalog_meta(out_dir, source_url, title, metadata)
        write_sqlite_index(
            records,
            out_dir,
            database_path,
            catalog_url=source_url,
            catalog_title=title,
            replace_all=True,
        )
        indexed += 1
        print(f"Indexed SQLite: {out_dir.name} ({len(records)} chapters)")
    write_library_index(library_root)
    print(f"SQLite database: {database_path}")
    print(f"Indexed caches: {indexed}")
    return 0


def chapter_index_from_dir(chapter_dir: Path, fallback: int) -> int:
    match = re.match(r"^(\d+)_", chapter_dir.name)
    if match:
        return int(match.group(1))
    return fallback


def chapter_slug_from_dir(chapter_dir: Path) -> str:
    match = re.match(r"^\d+_(.+)$", chapter_dir.name)
    return match.group(1) if match else chapter_dir.name


def repair_local_pages(args: argparse.Namespace) -> int:
    start_url = normalize_url(args.url)
    comic_id = comic_id_from_url(start_url)
    catalog_url = catalog_url_for(start_url, comic_id)
    out_dir = Path(args.out or default_out_dir_for(start_url, comic_id)).resolve()
    database_path = Path(args.database or default_database_path()).resolve()
    chapters_dir = out_dir / "chapters"
    if not chapters_dir.exists():
        print(f"No chapters directory: {chapters_dir}", file=sys.stderr)
        return 2

    catalog_html = out_dir / "catalog.html"
    if catalog_html.exists():
        catalog_html_text = catalog_html.read_text(encoding="utf-8", errors="replace")
        catalog_page = parse_page(catalog_html_text)
        title = clean_catalog_title(catalog_page.title, comic_id)
        metadata = extract_catalog_metadata(catalog_html_text, catalog_url, title)
        existing_metadata = load_catalog_metadata(out_dir)
        if existing_metadata.get("cover_path"):
            metadata["cover_path"] = existing_metadata["cover_path"]
        write_catalog_meta(out_dir, catalog_url, title, metadata)

    records: list[ChapterRecord] = []
    for fallback_index, chapter_dir in enumerate(sorted(chapters_dir.iterdir()), start=1):
        if not chapter_dir.is_dir():
            continue
        source_page = chapter_dir / "page.original.html"
        if not source_page.exists():
            source_page = chapter_dir / "page.html"
        if not source_page.exists():
            continue

        chapter_index = chapter_index_from_dir(chapter_dir, fallback_index)
        slug = chapter_slug_from_dir(chapter_dir)
        page_url = chapter_url_for(catalog_url, comic_id, slug)
        page_html = source_page.read_text(encoding="utf-8", errors="replace")
        page = parse_page(page_html)
        image_urls = extract_image_urls(page_url, page_html)
        if args.limit_images_per_page:
            image_urls = image_urls[: args.limit_images_per_page]

        page_file = chapter_dir / "page.html"
        record = ChapterRecord(
            index=chapter_index,
            url=page_url,
            slug=slug,
            title=clean_chapter_title(page.title) or slug,
            html_path=safe_relpath(page_file, out_dir),
            image_count=len(image_urls),
            status="repaired",
        )

        image_dir = chapter_dir / "images"
        for image_index, image_url in enumerate(image_urls, start=1):
            image = ImageRecord(index=image_index, source_url=image_url)
            cached_path = find_cached_image(image_dir, image_index)
            if cached_path:
                image.status = "exists"
                image.bytes = cached_path.stat().st_size
                image.local_path = safe_relpath(cached_path, out_dir)
                image.content_type = content_type_for_url(cached_path.name)
                record.downloaded_count += 1
            else:
                image.status = "missing"
                image.error = "No cached image file found"
                record.failed_count += 1
            record.images.append(image)

        localized_html = localize_page_html(
            page_html,
            page_url,
            record,
            chapter_dir,
            out_dir,
        )
        page_file.write_text(localized_html, encoding="utf-8")
        records.append(record)
        print(
            f"[{chapter_index:03d}] repaired {record.downloaded_count}/"
            f"{record.image_count}: {chapter_dir.name}"
        )

    records.sort(key=lambda item: item.index)
    write_chapter_viewers(records, out_dir)
    write_manifests(records, out_dir)
    write_sqlite_index(
        records,
        out_dir,
        database_path,
        catalog_url=catalog_url,
        catalog_title=load_catalog_title(out_dir),
        replace_all=True,
    )
    write_main_viewer(records, out_dir)
    write_library_index(out_dir.parent)
    print(f"Repaired local pages: {out_dir}")
    print(f"Open local viewer: {out_dir / 'index.html'}")
    return 0


def source_catalog_url(url: str) -> str:
    url = normalize_url(url)
    return catalog_url_for(url, comic_id_from_url(url))


def parse_source_line(line: str) -> tuple[str, str | None] | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if "#" in line:
        line = line.split("#", 1)[0].strip()
    if not line:
        return None
    if "|" in line:
        url, out_dir = [part.strip() for part in line.split("|", 1)]
        return url, out_dir or None
    return line, None


def source_file_urls(path: Path) -> set[str]:
    if not path.exists():
        return set()
    urls: set[str] = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        parsed = parse_source_line(line)
        if not parsed:
            continue
        url, _out_dir = parsed
        try:
            urls.add(source_catalog_url(url))
        except ValueError:
            continue
    return urls


def create_sources_file(path: Path, urls: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    unique_urls = []
    seen: set[str] = set()
    for url in urls:
        catalog = source_catalog_url(url)
        if catalog not in seen:
            seen.add(catalog)
            unique_urls.append(catalog)
    lines = [
        "# comic source catalogs",
        "# One catalog URL per line.",
        "# Optional custom output: https://smtt6.com/man-hua-yue-du/123456.html | .\\my_cache",
        "",
        *unique_urls,
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def remember_source(args: argparse.Namespace, catalog_url: str) -> None:
    if getattr(args, "no_record_source", False) or getattr(args, "sources", None):
        return
    source_path = Path(getattr(args, "sources_file", DEFAULT_SOURCES_FILE)).resolve()
    existing = source_file_urls(source_path)
    catalog_url = source_catalog_url(catalog_url)
    if not source_path.exists():
        create_sources_file(source_path, [catalog_url])
        return
    if catalog_url in existing:
        return
    with source_path.open("a", encoding="utf-8") as fh:
        if source_path.stat().st_size:
            fh.write("\n")
        fh.write(catalog_url + "\n")


def read_sources(path: Path) -> list[tuple[str, str | None]]:
    if not path.exists():
        return []
    jobs: list[tuple[str, str | None]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        parsed = parse_source_line(line)
        if not parsed:
            continue
        url, out_dir = parsed
        try:
            jobs.append((source_catalog_url(url), out_dir))
        except ValueError as exc:
            print(f"[sources:{line_no}] ignored invalid URL: {exc}", file=sys.stderr)
    return jobs


def run_sources(args: argparse.Namespace) -> int:
    source_path = Path(args.sources or DEFAULT_SOURCES_FILE).resolve()
    if not source_path.exists():
        create_sources_file(source_path, [args.url])
        print(f"Created sources file: {source_path}")

    jobs = read_sources(source_path)
    if not jobs:
        print(f"No sources found in: {source_path}", file=sys.stderr)
        return 2

    failures = 0
    print(f"Sources: {source_path}")
    print(f"Jobs: {len(jobs)}")
    for index, (url, out_dir) in enumerate(jobs, start=1):
        print(f"\n=== [{index}/{len(jobs)}] {url} ===")
        job_args = argparse.Namespace(**vars(args))
        job_args.url = url
        job_args.out = out_dir
        job_args.sources = None
        job_args.no_record_source = True
        code = repair_local_pages(job_args) if args.repair_local_pages else crawl(job_args)
        if code != 0:
            failures += 1
    return 1 if failures else 0


def crawl(args: argparse.Namespace) -> int:
    start_url = normalize_url(args.url)
    comic_id = comic_id_from_url(start_url)
    catalog_url = catalog_url_for(start_url, comic_id)
    out_dir = Path(args.out or default_out_dir_for(start_url, comic_id)).resolve()
    database_path = Path(args.database or default_database_path()).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_existed = (out_dir / "manifest.json").exists()
    remember_source(args, catalog_url)
    existing_records = load_existing_records(out_dir)

    robots = None if args.no_robots else RobotsCache(timeout=args.timeout)
    if robots and not args.single_page and not robots.allowed(catalog_url):
        print(f"robots.txt blocks catalog: {catalog_url}", file=sys.stderr)
        return 2

    if args.single_page:
        print(f"Single page: {start_url}")
        chapters = [(start_url, "")]
        catalog_title = clean_catalog_title("", comic_id)
    else:
        print(f"Catalog: {catalog_url}")
        catalog_data, _final_url, _content_type, headers = fetch_bytes(
            catalog_url,
            referer=None,
            accept=HTML_ACCEPT,
            timeout=args.timeout,
            retries=args.retries,
        )
        catalog_html = decode_text(catalog_data, headers.get("content-type", ""))
        (out_dir / "catalog.html").write_text(catalog_html, encoding="utf-8")
        catalog_page = parse_page(catalog_html)
        catalog_title = clean_catalog_title(catalog_page.title, comic_id)
        catalog_metadata = extract_catalog_metadata(catalog_html, catalog_url, catalog_title)
        existing_metadata = load_catalog_metadata(out_dir)
        if existing_metadata.get("cover_path"):
            catalog_metadata["cover_path"] = existing_metadata["cover_path"]
        cache_catalog_cover(
            catalog_metadata,
            out_dir,
            timeout=args.timeout,
            retries=args.retries,
            robots=robots,
        )
        write_catalog_meta(out_dir, catalog_url, catalog_title, catalog_metadata)

        chapters = extract_chapter_urls(catalog_url, catalog_html, comic_id)
        if not chapters:
            chapters = [(start_url, "")]
    if args.limit_pages:
        chapters = chapters[: args.limit_pages]
    print(f"Chapters: {len(chapters)}")

    records: list[ChapterRecord] = []
    pending_chapters: list[tuple[int, str, str, str, Path, Path, ChapterRecord]] = []
    for chapter_index, (chapter_url, title_hint) in enumerate(chapters, start=1):
        slug = chapter_slug(chapter_url)
        chapter_dir = out_dir / "chapters" / f"{chapter_index:03d}_{slug}"
        image_dir = chapter_dir / "images"

        completed_record = completed_chapter_from_cache(
            chapter_dir,
            out_dir,
            chapter_index=chapter_index,
            chapter_url=chapter_url,
            slug=slug,
            title_hint=title_hint,
            existing_record=existing_records.get(chapter_identity(chapter_url)),
            skip_completed=not args.no_skip_completed,
            overwrite=args.overwrite,
        )
        if completed_record:
            records.append(completed_record)
            continue

        pending_record = ChapterRecord(
            index=chapter_index,
            url=chapter_url,
            slug=slug,
            title=clean_chapter_title("", title_hint) or f"第 {chapter_index} 话",
            status="pending",
        )
        records.append(pending_record)
        pending_chapters.append(
            (chapter_index, chapter_url, title_hint, slug, chapter_dir, image_dir, pending_record)
        )

    catalog_sequence = [chapter_identity(url) for url, _title in chapters]
    catalog_identities = set(catalog_sequence)
    existing_sequence = [
        chapter_identity(record.url)
        for record in sorted(existing_records.values(), key=lambda item: item.index)
    ]
    catalog_structure_changed = catalog_sequence != existing_sequence
    removed_count = len(set(existing_records) - catalog_identities)
    cached_complete_count = len(records) - len(pending_chapters)
    if not manifest_existed:
        # A new comic should appear in the library as soon as its remote
        # directory is known. Pending rows have no media paths until their
        # chapter finishes, when the normal incremental upsert replaces them.
        published_records = sorted(records, key=lambda item: item.index)
        write_manifests(published_records, out_dir)
        write_sqlite_index(
            published_records,
            out_dir,
            database_path,
            catalog_url=catalog_url,
            catalog_title=catalog_title,
            replace_all=True,
        )
    print(f"Cached complete: {cached_complete_count}")
    print(f"Need update: {len(pending_chapters)}")
    emit_progress(
        "catalog",
        totalChapters=len(chapters),
        cachedChapters=cached_complete_count,
        pendingChapters=len(pending_chapters),
        removedChapters=removed_count,
    )
    if removed_count:
        print(f"Removed from source catalog: {removed_count}")
    if not pending_chapters:
        print("Already up to date; no chapter page requests needed.")

    for pending_position, (
        chapter_index,
        chapter_url,
        title_hint,
        slug,
        chapter_dir,
        image_dir,
        record,
    ) in enumerate(pending_chapters, start=1):
        image_dir.mkdir(parents=True, exist_ok=True)
        emit_progress(
            "chapter-start",
            chapterIndex=chapter_index,
            chapterTitle=clean_chapter_title(title_hint) or f"第 {chapter_index} 话",
            pendingPosition=pending_position,
            pendingChapters=len(pending_chapters),
        )

        if robots and not robots.allowed(chapter_url):
            record.status = "skipped_robots"
            record.error = f"Blocked by robots.txt: {chapter_url}"
            print(f"[{chapter_index:03d}] skipped by robots: {chapter_url}")
            emit_progress(
                "chapter-complete",
                chapterIndex=chapter_index,
                status=record.status,
                failedImages=0,
            )
            continue

        print(f"[{chapter_index:03d}] Fetch page: {chapter_url}")
        try:
            data, _final_url, _content_type, headers = fetch_bytes(
                chapter_url,
                referer=catalog_url,
                accept=HTML_ACCEPT,
                timeout=args.timeout,
                retries=args.retries,
            )
            page_html = decode_text(data, headers.get("content-type", ""))
            original_page_file = chapter_dir / "page.original.html"
            original_page_file.write_text(page_html, encoding="utf-8")
            page_file = chapter_dir / "page.html"
            record.html_path = safe_relpath(page_file, out_dir)

            page = parse_page(page_html)
            record.title = clean_chapter_title(page.title, title_hint) or slug
            image_urls = extract_image_urls(chapter_url, page_html)
            if args.limit_images_per_page:
                image_urls = image_urls[: args.limit_images_per_page]
            record.image_count = len(image_urls)
            print(f"[{chapter_index:03d}] Images: {record.image_count}")
            emit_progress(
                "chapter-images",
                chapterIndex=chapter_index,
                chapterTitle=record.title,
                totalImages=record.image_count,
            )

            image_progress = {"downloaded": 0, "failed": 0, "bytes": 0}

            def report_image_progress(completed, total, image):
                if image.status in {"downloaded", "exists"}:
                    image_progress["downloaded"] += 1
                elif image.status == "failed":
                    image_progress["failed"] += 1
                image_progress["bytes"] += max(0, int(image.bytes or 0))
                emit_progress(
                    "image-progress",
                    chapterIndex=chapter_index,
                    completedImages=completed,
                    totalImages=total,
                    downloadedImages=image_progress["downloaded"],
                    failedImages=image_progress["failed"],
                    downloadedBytes=image_progress["bytes"],
                )

            record.images = download_chapter_images(
                image_urls,
                image_dir,
                chapter_url,
                out_dir,
                timeout=args.timeout,
                retries=args.retries,
                prefer_webp=not args.no_prefer_webp,
                overwrite=args.overwrite,
                robots=robots,
                image_workers=args.image_workers,
                image_delay=args.image_delay,
                progress_callback=report_image_progress,
            )
            record.downloaded_count = sum(
                1 for image in record.images if image.status in {"downloaded", "exists"}
            )
            record.skipped_count = sum(
                1 for image in record.images if image.status.startswith("skipped")
            )
            record.failed_count = len(record.images) - record.downloaded_count - record.skipped_count

            record.status = "done"
            localized_html = localize_page_html(
                page_html,
                chapter_url,
                record,
                chapter_dir,
                out_dir,
            )
            page_file.write_text(localized_html, encoding="utf-8")
            emit_progress(
                "chapter-complete",
                chapterIndex=chapter_index,
                status=record.status,
                downloadedImages=record.downloaded_count,
                failedImages=record.failed_count,
            )
        except Exception as exc:
            record.status = "failed"
            record.error = str(exc)
            print(f"[{chapter_index:03d}] failed: {exc}", file=sys.stderr)
            emit_progress(
                "chapter-complete",
                chapterIndex=chapter_index,
                status=record.status,
                error=record.error,
            )

        # Persist only the chapter that was just handled. A final manifest is
        # published once after the update batch; chapter.done.json is enough to
        # resume safely if the process stops before that final publish.
        if record.html_path:
            write_chapter_state(record, out_dir)
        write_sqlite_index(
            [record],
            out_dir,
            database_path,
            catalog_url=catalog_url,
            catalog_title=catalog_title,
        )
        if args.delay:
            time.sleep(args.delay)

    records.sort(key=lambda item: item.index)
    database_needs_rebuild = not database_path.exists()
    if pending_chapters or catalog_structure_changed or database_needs_rebuild:
        write_manifests(records, out_dir)
        write_sqlite_index(
            records,
            out_dir,
            database_path,
            catalog_url=catalog_url,
            catalog_title=catalog_title,
            replace_all=True,
        )
        write_chapter_viewers(records, out_dir)
        write_main_viewer(records, out_dir, catalog_title)
    else:
        # Keep last-sync/catalog metadata current without rewriting every cached
        # chapter and image row when the remote catalog did not change.
        write_sqlite_index(
            [],
            out_dir,
            database_path,
            catalog_url=catalog_url,
            catalog_title=catalog_title,
        )
    write_library_index(out_dir.parent)
    emit_progress(
        "complete",
        totalChapters=len(records),
        failedChapters=sum(1 for record in records if record.status == "failed"),
    )
    print(f"Done: {out_dir}")
    print(f"Open local viewer: {out_dir / 'index.html'}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Cache smtt6, jmd9/91jmd, and 55comic reader pages and manga images locally."
    )
    parser.add_argument("url", nargs="?", default=DEFAULT_START_URL)
    parser.add_argument("--out", help="Output directory. Default: <site>_cache_<comic_id>")
    parser.add_argument(
        "--database",
        help=f"SQLite index path. Default: {DEFAULT_LIBRARY_ROOT / DEFAULT_DATABASE_FILE}",
    )
    parser.add_argument(
        "--sources",
        nargs="?",
        const=DEFAULT_SOURCES_FILE,
        help=f"Read catalog URLs from a source file. Default: {DEFAULT_SOURCES_FILE}",
    )
    parser.add_argument(
        "--sources-file",
        default=DEFAULT_SOURCES_FILE,
        help=f"File used to remember catalog URLs during normal runs. Default: {DEFAULT_SOURCES_FILE}",
    )
    parser.add_argument(
        "--no-record-source",
        action="store_true",
        help="Do not append the current catalog URL to the source file",
    )
    parser.add_argument("--limit-pages", type=int, default=0, help="Only crawl first N chapters")
    parser.add_argument(
        "--single-page",
        action="store_true",
        help="Cache only the URL passed on the command line instead of scanning the catalog",
    )
    parser.add_argument(
        "--repair-local-pages",
        action="store_true",
        help="Do not download; rewrite cached chapter pages to load local images",
    )
    parser.add_argument(
        "--rebuild-sqlite",
        action="store_true",
        help="Index existing cache manifests into SQLite without network requests",
    )
    parser.add_argument(
        "--cache-covers",
        action="store_true",
        help="With --rebuild-sqlite, download real catalog covers into each comic cache",
    )
    parser.add_argument(
        "--write-library-index",
        action="store_true",
        help="Only refresh the outer library index and cache index backlinks",
    )
    parser.add_argument(
        "--pack-chapters",
        action="store_true",
        help="Pack chapter directories into chapters/*.zip. By default removes the unpacked directories after each zip is verified.",
    )
    parser.add_argument(
        "--keep-unpacked",
        action="store_true",
        help="With --pack-chapters, keep the original chapter directories after creating zip files.",
    )
    parser.add_argument(
        "--overwrite-zip",
        action="store_true",
        help="With --pack-chapters, rebuild chapter zip files that already exist.",
    )
    parser.add_argument(
        "--zip-compression",
        choices=sorted(ZIP_COMPRESSION_METHODS),
        default="stored",
        help="Zip compression method for --pack-chapters. Default: stored, fast and suitable for already-compressed images.",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Serve the local library over HTTP and auto-unpack zipped chapters when opened.",
    )
    parser.add_argument(
        "--clear-unpacked-cache",
        "--delete-unpacked-cache",
        action="store_true",
        help="Delete unpacked chapter directories only when the matching chapters/*.zip exists.",
    )
    parser.add_argument("--host", default=DEFAULT_SERVE_HOST, help=f"Host for --serve. Default: {DEFAULT_SERVE_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_SERVE_PORT, help=f"Port for --serve. Default: {DEFAULT_SERVE_PORT}")
    parser.add_argument("--no-open", action="store_true", help="With --serve, do not open the browser automatically.")
    parser.add_argument(
        "--limit-images-per-page",
        type=int,
        default=0,
        help="Only download first N images per chapter",
    )
    parser.add_argument("--delay", type=float, default=0.0, help="Delay between chapters")
    parser.add_argument("--image-delay", type=float, default=0.0, help="Delay after image requests")
    parser.add_argument(
        "--image-workers",
        type=int,
        default=3,
        help="Parallel image download workers per chapter",
    )
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing images")
    parser.add_argument(
        "--full-scan",
        "--no-skip-completed",
        dest="no_skip_completed",
        action="store_true",
        help="Fetch every chapter page again instead of the default incremental update",
    )
    parser.add_argument(
        "--no-prefer-webp",
        action="store_true",
        help="Download original URLs instead of trying .webp first",
    )
    parser.add_argument(
        "--no-robots",
        action="store_true",
        help="Do not check robots.txt before fetching URLs",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if len(sys.argv) == 1:
        library_root = DEFAULT_LIBRARY_ROOT.resolve()
        library_root.mkdir(parents=True, exist_ok=True)
        os.chdir(library_root)
        sources_path = Path(args.sources_file)
        if not sources_path.is_absolute():
            sources_path = library_root / sources_path
        args.sources = str(sources_path)
        print(f"No arguments; using sources file: {sources_path}")
        return run_sources(args)
    if args.serve:
        return serve_library(args)
    if args.pack_chapters:
        return pack_chapters(args)
    if args.clear_unpacked_cache:
        return clear_unpacked_cache(args)
    if args.rebuild_sqlite:
        return rebuild_sqlite_index(args)
    if args.write_library_index:
        refresh_library(Path.cwd().resolve())
        print(f"Library index: {Path.cwd().resolve() / 'index.html'}")
        return 0
    if args.repair_local_pages:
        return repair_local_pages(args)
    if args.sources:
        return run_sources(args)
    return crawl(args)


if __name__ == "__main__":
    raise SystemExit(main())
