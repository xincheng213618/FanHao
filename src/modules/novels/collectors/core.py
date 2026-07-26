"""Shared HTTP, parsing, and text helpers for the unified novel collector."""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)
DEFAULT_REMOVE_SELECTORS = [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "button",
    "select",
    "textarea",
    "nav",
    "footer",
    ".ad",
    ".ads",
    ".advert",
    ".comment",
    ".comments",
    ".share",
    ".toolbar",
    ".breadcrumb",
]
DEFAULT_NOISE_PATTERNS = [
    r"^(?:上一页|下一页|上一章|下一章|返回目录|章节目录|加入书签|投推荐票)$",
    r"^(?:首页|登录|注册|收藏|分享|举报|评论)$",
    r"^\s*\d+\s*/\s*\d+\s*$",
    r"^[-_=]{3,}$",
]
BLOCK_TAGS = [
    "p",
    "div",
    "section",
    "article",
    "li",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "blockquote",
]


class CollectionError(RuntimeError):
    """A user-facing collection failure."""


@dataclass
class Chapter:
    title: str
    url: str
    content: str = ""
    order: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "url": self.url,
            "content": self.content,
            "order": self.order,
        }


class CollectorContext:
    def __init__(
        self,
        config: dict[str, Any],
        emit,
        *,
        checkpoint_path: str | Path | None = None,
        checkpoint_identity: dict[str, Any] | None = None,
    ):
        self.config = config
        self.emit = emit
        self.timeout = max(3.0, float(config.get("timeoutMs", 30000)) / 1000.0)
        self.delay = max(0.0, float(config.get("delayMs", 800)) / 1000.0)
        self.session = build_session(config)
        self.checkpoint_path = Path(checkpoint_path).resolve() if checkpoint_path else None
        self.checkpoint_identity = {
            str(key): str(value or "")
            for key, value in (checkpoint_identity or {}).items()
        }
        self._checkpoint_chapters: dict[str, dict[str, Any]] = {}
        self._load_checkpoint()

    def fetch(self, url: str) -> str:
        target = normalize_http_url(url)
        try:
            response = self.session.get(target, timeout=self.timeout)
        except requests.RequestException as exc:
            raise CollectionError(f"请求失败：{target}；{exc}") from exc
        if is_cloudflare_challenge(response):
            raise CollectionError("目标站点返回 Cloudflare 交互验证，当前采集器无法继续")
        if is_access_challenge(response):
            raise CollectionError(
                f"目标站点要求访问验证码：{target}；请配置已登录并通过验证的 Cookie 后重试"
            )
        try:
            response.raise_for_status()
        except requests.RequestException as exc:
            raise CollectionError(f"HTTP 请求失败：{target}；状态码 {response.status_code}") from exc
        content_type = response.headers.get("content-type", "")
        if "charset" not in content_type.lower() and response.apparent_encoding:
            response.encoding = response.apparent_encoding
        return response.text

    def pause(self) -> None:
        if self.delay > 0:
            time.sleep(self.delay)

    def progress(self, current: int, total: int, message: str) -> None:
        self.emit("progress", current=current, total=total, message=message)

    def status(self, message: str) -> None:
        self.emit("status", message=message)

    def warning(self, message: str) -> None:
        self.emit("warning", message=message)

    @property
    def checkpoint_count(self) -> int:
        return len(self._checkpoint_chapters)

    def restore_chapter(self, chapter: Chapter) -> Chapter | None:
        try:
            key = normalize_http_url(chapter.url)
        except CollectionError:
            return None
        saved = self._checkpoint_chapters.get(key)
        if not saved:
            return None
        content = str(saved.get("content") or "").strip()
        if not content:
            return None
        return Chapter(
            title=str(saved.get("title") or chapter.title),
            url=key,
            content=content,
            order=int(saved.get("order") or chapter.order or 0),
        )

    def checkpoint_metadata(self, url: str) -> dict[str, Any]:
        try:
            key = normalize_http_url(url)
        except CollectionError:
            return {}
        saved = self._checkpoint_chapters.get(key) or {}
        metadata = saved.get("metadata")
        return dict(metadata) if isinstance(metadata, dict) else {}

    def save_chapter(
        self,
        chapter: Chapter,
        *,
        metadata: dict[str, Any] | None = None,
        total: int = 0,
    ) -> None:
        if self.checkpoint_path is None:
            return
        content = str(chapter.content or "").strip()
        if not content:
            return
        key = normalize_http_url(chapter.url)
        self._checkpoint_chapters[key] = {
            "title": str(chapter.title or ""),
            "url": key,
            "content": content,
            "order": int(chapter.order or len(self._checkpoint_chapters) + 1),
            "metadata": dict(metadata) if isinstance(metadata, dict) else {},
        }
        self._write_checkpoint()
        self.emit(
            "checkpoint",
            saved=self.checkpoint_count,
            total=max(0, int(total or 0)),
            message=f"已保存断点：{self.checkpoint_count} 章",
        )

    def _load_checkpoint(self) -> None:
        if self.checkpoint_path is None or not self.checkpoint_path.exists():
            return
        try:
            payload = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
        except Exception as exc:
            self.emit("warning", message=f"断点记录无法读取，将从头采集：{exc}")
            return
        if not isinstance(payload, dict):
            return
        identity = payload.get("identity")
        normalized_identity = {
            str(key): str(value or "")
            for key, value in identity.items()
        } if isinstance(identity, dict) else {}
        if normalized_identity != self.checkpoint_identity:
            self.emit("warning", message="断点记录与当前网址或适配器不一致，将从头采集")
            return
        chapters = payload.get("chapters")
        if not isinstance(chapters, list):
            return
        for saved in chapters:
            if not isinstance(saved, dict):
                continue
            try:
                key = normalize_http_url(saved.get("url"))
            except CollectionError:
                continue
            if not str(saved.get("content") or "").strip():
                continue
            self._checkpoint_chapters[key] = {
                "title": str(saved.get("title") or ""),
                "url": key,
                "content": str(saved.get("content") or ""),
                "order": int(saved.get("order") or len(self._checkpoint_chapters) + 1),
                "metadata": dict(saved.get("metadata")) if isinstance(saved.get("metadata"), dict) else {},
            }

    def _write_checkpoint(self) -> None:
        if self.checkpoint_path is None:
            return
        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "identity": self.checkpoint_identity,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "chapters": list(self._checkpoint_chapters.values()),
        }
        temporary = Path(f"{self.checkpoint_path}.tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
            newline="\n",
        )
        os.replace(temporary, self.checkpoint_path)


def build_session(config: dict[str, Any]) -> requests.Session:
    session = requests.Session()
    session.trust_env = bool(config.get("useEnvProxy", False))
    headers = {
        "User-Agent": str(config.get("userAgent") or DEFAULT_USER_AGENT),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Connection": "keep-alive",
    }
    custom_headers = config.get("headers")
    if isinstance(custom_headers, dict):
        for key, value in custom_headers.items():
            if key and value is not None:
                headers[str(key)] = str(value)
    cookie = read_cookie_file(config.get("cookieFile"))
    if cookie:
        headers["Cookie"] = cookie
    session.headers.update(headers)
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=0.7,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def normalize_http_url(value: str, base_url: str = "") -> str:
    target = urljoin(base_url, str(value or "").strip())
    parsed = urlparse(target)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise CollectionError(f"无效网页地址：{target or value}")
    return parsed._replace(fragment="").geturl()


def same_host(left: str, right: str) -> bool:
    return urlparse(left).hostname == urlparse(right).hostname


def select_nodes(soup: BeautifulSoup, selector: str, label: str) -> list:
    selector = str(selector or "").strip()
    if not selector:
        return []
    try:
        return list(soup.select(selector))
    except Exception as exc:
        raise CollectionError(f"{label} CSS 选择器无效：{selector}；{exc}") from exc


def select_first(soup: BeautifulSoup, selector: str, label: str):
    nodes = select_nodes(soup, selector, label)
    return nodes[0] if nodes else None


def selected_text(soup: BeautifulSoup, selector: str, label: str) -> str:
    node = select_first(soup, selector, label) if selector else None
    return normalize_inline(node.get_text(" ", strip=True)) if node else ""


def fallback_page_title(soup: BeautifulSoup) -> str:
    for selector in ("h1", ".book-title", ".title"):
        node = soup.select_one(selector)
        if node:
            value = normalize_inline(node.get_text(" ", strip=True))
            if value:
                return value
    if soup.title:
        return normalize_inline(soup.title.get_text(" ", strip=True))
    return ""


def extract_content(
    html: str,
    selector: str,
    *,
    remove_selectors: Iterable[str] | None = None,
    line_patterns: Iterable[str] | None = None,
    first_only: bool = False,
) -> str:
    soup = BeautifulSoup(html, "html.parser")
    nodes = select_nodes(soup, selector, "正文") if selector else [soup.body or soup]
    if not nodes:
        raise CollectionError(f"正文选择器没有匹配内容：{selector}")
    if first_only:
        nodes = nodes[:1]
    parts: list[str] = []
    seen: set[str] = set()
    for node in nodes:
        fragment = BeautifulSoup(str(node), "html.parser")
        strip_nodes(fragment, [*DEFAULT_REMOVE_SELECTORS, *(remove_selectors or [])])
        text = html_fragment_text(fragment)
        text = clean_body_text(text, line_patterns=line_patterns)
        key = re.sub(r"\s+", "", text)
        if text and key not in seen:
            seen.add(key)
            parts.append(text)
    return "\n\n".join(parts).strip()


def strip_nodes(soup: BeautifulSoup, selectors: Iterable[str]) -> None:
    for selector in selectors:
        value = str(selector or "").strip()
        if not value:
            continue
        try:
            nodes = list(soup.select(value))
        except Exception as exc:
            raise CollectionError(f"移除元素 CSS 选择器无效：{value}；{exc}") from exc
        for node in nodes:
            node.decompose()


def html_fragment_text(fragment: BeautifulSoup) -> str:
    for br in fragment.find_all("br"):
        br.replace_with("\n")
    for tag in fragment.find_all(BLOCK_TAGS):
        tag.insert_before("\n")
        tag.append("\n")
    return fragment.get_text("\n")


def clean_body_text(text: str, *, line_patterns: Iterable[str] | None = None) -> str:
    patterns = compile_patterns([*DEFAULT_NOISE_PATTERNS, *(line_patterns or [])])
    source = (
        str(text or "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\xa0", " ")
        .replace("\u200b", "")
        .replace("\ufeff", "")
    )
    lines: list[str] = []
    for raw_line in source.split("\n"):
        line = normalize_inline(raw_line)
        if not line:
            continue
        if any(pattern.search(line) for pattern in patterns):
            continue
        if lines and lines[-1] == line:
            continue
        lines.append(line)
    return "\n\n".join(lines).strip()


def compile_patterns(values: Iterable[str]) -> list[re.Pattern]:
    patterns: list[re.Pattern] = []
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        try:
            patterns.append(re.compile(text, re.I))
        except re.error as exc:
            raise CollectionError(f"正文过滤正则无效：{text}；{exc}") from exc
    return patterns


def normalize_inline(value: str) -> str:
    text = re.sub(r"[\t \u3000]+", " ", str(value or ""))
    text = re.sub(r"\s*([，。！？；：、“”‘’（）《》【】])\s*", r"\1", text)
    return text.strip()


def clean_title(value: str, fallback: str = "网页小说") -> str:
    text = normalize_inline(value)
    text = re.sub(r"\s*[-–—_]\s*(?:最新章节|章节列表|全文阅读).*$", "", text, flags=re.I)
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")
    return text[:160] or fallback


def clean_author(value: str) -> str:
    text = normalize_inline(value)
    text = re.sub(r"^(?:作者|作\s*者|原作者|送交者)\s*[:：]?\s*", "", text, flags=re.I)
    return text[:80]


def safe_filename(value: str) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value or "novel"))
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:120] or "novel"


def dedupe_links(chapters: Iterable[Chapter]) -> list[Chapter]:
    result: list[Chapter] = []
    seen: set[str] = set()
    for chapter in chapters:
        key = normalize_http_url(chapter.url)
        if key in seen:
            continue
        seen.add(key)
        chapter.url = key
        chapter.order = len(result) + 1
        result.append(chapter)
    return result


def numeric_sort_key(value: str) -> tuple[int, str]:
    match = re.search(r"(\d+)", str(value or ""))
    return (int(match.group(1)) if match else 10**9, str(value or ""))


def json_event(event: str, **payload: Any) -> str:
    return json.dumps({"event": event, **payload}, ensure_ascii=False, separators=(",", ":"))


def is_cloudflare_challenge(response: requests.Response) -> bool:
    if response.status_code != 403:
        return False
    if response.headers.get("Cf-Mitigated", "").lower() == "challenge":
        return True
    text = response.text[:3000].lower()
    return "challenges.cloudflare.com" in text or "<title>just a moment" in text


def is_access_challenge(response: requests.Response) -> bool:
    final_url = str(response.url or "").lower()
    if "/captcha_page/" in final_url or "/captcha/" in final_url:
        return True
    text = response.text[:6000]
    return (
        "访问验证" in text
        and any(marker in text for marker in ("当前访问行为触发", "输入验证码", "安全验证"))
    )


def read_cookie_file(value: Any) -> str:
    cookie_path = str(value or "").strip()
    if not cookie_path:
        return ""
    path_value = Path(cookie_path)
    try:
        if path_value.stat().st_size > 128 * 1024:
            raise CollectionError("登录 Cookie 文件过大")
        raw = path_value.read_text(encoding="utf-8")
    except CollectionError:
        raise
    except OSError as exc:
        raise CollectionError("登录 Cookie 文件不可读") from exc
    cookie = "; ".join(
        line.strip()
        for line in re.sub(r"^\s*Cookie:\s*", "", raw, count=1, flags=re.I).splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ).strip()
    if cookie and "=" not in cookie:
        raise CollectionError("登录 Cookie 内容无效")
    return cookie
