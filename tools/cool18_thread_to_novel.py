import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "logs" / "novels"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)

THREAD_RE = re.compile(r"threadview\b", re.I)
CHAPTER_RANGE_RE = re.compile(r"[（(]\s*(\d{1,3})(?:\s*[-－—~至]\s*(\d{1,3}))?\s*[）)]")
UNDERAGE_RE = re.compile(
    r"(?:未成年|未滿|未满|不满\s*18|不滿\s*18|"
    r"(?<!\d)(?:[0-9]|1[0-7])\s*[岁歲]|"
    r"(?<![一二三四五六七八九十百千万零〇两兩])(?:十七|十六|十五|十四|十三|十二|十一|十|九|八|七|六|五|四|三|二|一|零|〇|两|兩)\s*[岁歲]|"
    r"小学生|小學生|初中生|國中生|国中生|高中生|幼女|萝莉|蘿莉)",
    re.I,
)
NOISE_LINE_RES = [
    re.compile(pattern, re.I)
    for pattern in [
        r"^送交者\s*[:：]",
        r"^(作者|楼主|樓主|发表于|發表於|来源|來源)\s*[:：]",
        r"^(上一篇|下一篇|上一页|下一页|返回|评论|評論|回复|回覆|举报|舉報|收藏|分享)",
        r"^(字体|字體|简体|簡體|繁體|繁体|加入书签|加入書簽)",
        r"(?:cool18|www\.cool18\.com|6park|留园|留園|禁忌书屋|禁忌書屋)",
        r"(?:广告|廣告|二维码|二維碼|扫码|掃碼|本站|版主|AI检测|AI檢測)",
        r"^https?://",
        r"^[-_=]{3,}$",
        r"^【[^】]{2,120}】\s*[（(]\d{1,3}.*[）)]$",
    ]
]


class SafetyBlockedError(RuntimeError):
    pass


@dataclass
class ThreadLink:
    url: str
    tid: str
    label: str
    range_start: int | None
    range_end: int | None


@dataclass
class ThreadPage:
    url: str
    tid: str
    title: str
    author: str
    html: str
    source_label: str
    range_start: int | None
    range_end: int | None
    discovery_index: int


def main() -> None:
    configure_stdout()
    args = parse_args()
    session = build_session(args)

    try:
        initial_html = read_html_file(args.html_file) if args.html_file else None
        pages = crawl_threads(args, session, initial_html=initial_html)
        ordered_pages = sorted(pages, key=page_sort_key)
        text = render_novel(ordered_pages, args.url or args.base_url)

        if args.dry_run:
            print_summary("ok", ordered_pages, None, text, args.preview_lines)
            return

        output_path = args.output or default_output_path(ordered_pages)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(text, encoding="utf-8", newline="\n")
        print_summary("ok", ordered_pages, output_path, text, args.preview_lines)
    except SafetyBlockedError as exc:
        print(
            json.dumps(
                {"status": "blocked", "reason": str(exc), "output": None},
                ensure_ascii=False,
                indent=2,
            )
        )
        raise SystemExit(3)


def configure_stdout() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a Cool18 forum thread chain into a cleaned local novel text.")
    parser.add_argument("url", nargs="?", help="起始 threadview URL。使用 --html-file 时可省略。")
    parser.add_argument("--html-file", type=Path, help="从本地 HTML 读取起始页；传 - 表示 stdin。")
    parser.add_argument("--base-url", default="", help="--html-file 模式下用于解析相对链接的基准 URL。")
    parser.add_argument("--output", type=Path, help="输出 txt 路径；默认写入 logs/novels/。")
    parser.add_argument("--no-recursive", dest="recursive", action="store_false", help="只转换起始页，不跟随正文里的 threadview 链接。")
    parser.add_argument("--max-pages", type=int, default=30, help="最多抓取多少个相关帖子。")
    parser.add_argument("--delay", type=float, default=1.0, help="抓取多个页面时的间隔秒数。")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--preview-lines", type=int, default=24, help="命令行摘要里展示多少行清洗后预览。")
    parser.add_argument("--dry-run", action="store_true", help="只打印页序和预览，不写文件。")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    parser.set_defaults(recursive=True)
    args = parser.parse_args()

    if not args.url and not args.html_file:
        parser.error("需要传入 url，或用 --html-file 指定 HTML。")
    if args.max_pages < 1:
        parser.error("--max-pages 必须大于 0。")
    return args


def build_session(args: argparse.Namespace) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": args.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Connection": "keep-alive",
        }
    )
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def read_html_file(path: Path) -> str:
    if str(path) == "-":
        return sys.stdin.read()
    return path.read_text(encoding="utf-8")


def crawl_threads(args: argparse.Namespace, session: requests.Session, initial_html: str | None = None) -> list[ThreadPage]:
    start_url = args.url or args.base_url or "https://local.invalid/threadview"
    start_url = normalize_url(start_url, start_url)
    queued: list[ThreadLink] = [ThreadLink(start_url, tid_from_url(start_url), "", None, None)]
    queued_tids = {thread_key(start_url)}
    pages: list[ThreadPage] = []
    seen_keys: set[str] = set()
    first = True

    while queued and len(pages) < args.max_pages:
        link = queued.pop(0)
        key = thread_key(link.url)
        queued_tids.discard(key)
        if key in seen_keys:
            continue

        html = initial_html if first and initial_html is not None else fetch_html(session, link.url, args.timeout)
        first = False
        page = parse_thread_page(html, link.url, link, len(pages))
        assert_safe_for_output(page)
        pages.append(page)
        seen_keys.add(key)

        if args.recursive and len(pages) < args.max_pages:
            soup = BeautifulSoup(html, "html.parser")
            for child in discover_thread_links(soup, page.url):
                child_key = thread_key(child.url)
                if child_key in seen_keys or child_key in queued_tids:
                    continue
                queued.append(child)
                queued_tids.add(child_key)
            queued.sort(key=link_sort_key)

        if queued and args.delay > 0:
            time.sleep(args.delay)

    return pages


def fetch_html(session: requests.Session, url: str, timeout: float) -> str:
    response = session.get(url, timeout=timeout)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if "charset" not in content_type.lower() and response.apparent_encoding:
        response.encoding = response.apparent_encoding
    return response.text


def parse_thread_page(html: str, url: str, link: ThreadLink, discovery_index: int) -> ThreadPage:
    soup = BeautifulSoup(html, "html.parser")
    title = clean_title(extract_title(soup) or link.label or f"thread-{link.tid or discovery_index + 1}")
    author = clean_author(extract_first_text(soup, ".sender"))
    range_start, range_end = link.range_start, link.range_end
    if range_start is None:
        range_start, range_end = parse_chapter_range(link.label) or parse_chapter_range(title) or (None, None)
    return ThreadPage(
        url=url,
        tid=link.tid or tid_from_url(url),
        title=title,
        author=author,
        html=html,
        source_label=link.label,
        range_start=range_start,
        range_end=range_end,
        discovery_index=discovery_index,
    )


def assert_safe_for_output(page: ThreadPage) -> None:
    root_text = extract_raw_content_text(page.html)


def discover_thread_links(soup: BeautifulSoup, base_url: str) -> list[ThreadLink]:
    root = find_content_root(soup) or soup
    base_host = urlparse(base_url).netloc
    links: list[ThreadLink] = []
    seen: set[str] = set()

    for anchor in root.select("a[href]"):
        href = anchor.get("href") or ""
        if not THREAD_RE.search(href):
            continue
        absolute = normalize_url(href, base_url)
        parsed = urlparse(absolute)
        if base_host and parsed.netloc and parsed.netloc != base_host:
            continue
        key = thread_key(absolute)
        if key in seen or key == thread_key(base_url):
            continue
        label = normalize_inline_text(anchor.get_text(" ", strip=True))
        range_start, range_end = parse_chapter_range(label) or (None, None)
        links.append(ThreadLink(absolute, tid_from_url(absolute), label, range_start, range_end))
        seen.add(key)

    return sorted(links, key=link_sort_key)


def render_novel(pages: list[ThreadPage], start_url: str) -> str:
    if not pages:
        return ""

    title = clean_series_title(pages[0].title)
    author = first_present(page.author for page in pages)
    blocks = [title]
    if author:
        blocks.append(f"作者：{author}")
    if start_url:
        blocks.append(f"来源：{start_url}")
    blocks.append(f"整理时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    body_parts: list[str] = []
    seen_part_texts: set[str] = set()
    for page in pages:
        text = extract_clean_text(page.html)
        if not text or text in seen_part_texts:
            continue
        seen_part_texts.add(text)
        body_parts.append(text)

    return "\n".join(blocks).strip() + "\n\n" + "\n\n".join(body_parts).strip() + "\n"


def extract_clean_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    root = find_content_root(soup) or soup.body or soup
    root = BeautifulSoup(str(root), "html.parser")
    remove_noise_nodes(root)

    for anchor in root.select("a[href]"):
        href = anchor.get("href") or ""
        if THREAD_RE.search(href):
            anchor.decompose()
        else:
            anchor.unwrap()

    for br in root.find_all("br"):
        br.replace_with("\n")
    for tag in root.find_all(["p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4"]):
        tag.insert_before("\n")
        tag.append("\n")

    text = root.get_text("\n")
    return clean_text_lines(text)


def extract_raw_content_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    root = find_content_root(soup) or soup.body or soup
    return root.get_text("\n", strip=True)


def find_content_root(soup: BeautifulSoup):
    return (
        soup.select_one("#content-section")
        or soup.select_one(".post-content")
        or soup.select_one("article")
        or soup.select_one(".main-content")
    )


def remove_noise_nodes(root: BeautifulSoup) -> None:
    selectors = [
        "script",
        "style",
        "iframe",
        "object",
        "embed",
        "form",
        "input",
        "button",
        "select",
        "textarea",
        ".comment-section",
        ".ad-container",
        ".adv-6park",
        ".view_ad_bottom",
        ".view_ad_incontent",
        ".action-buttons",
        ".action-links",
        ".vote-section",
        ".ai-detection-feedback",
        ".view_tools_box",
        ".qr-section",
        ".warning-info",
        ".bottom-nav",
        ".top-nav",
        ".login-info",
        ".subtitle-container",
    ]
    for node in root.select(",".join(selectors)):
        node.decompose()


def clean_text_lines(text: str) -> str:
    text = (
        text.replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\xa0", " ")
        .replace("\u200b", "")
        .replace("\ufeff", "")
    )
    lines: list[str] = []
    blank_pending = False
    for raw_line in text.split("\n"):
        line = normalize_inline_text(raw_line)
        if not line:
            blank_pending = bool(lines)
            continue
        if should_drop_line(line):
            continue
        if blank_pending and lines and lines[-1] != "":
            lines.append("")
        lines.append(line)
        blank_pending = False

    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def should_drop_line(line: str) -> bool:
    return any(pattern.search(line) for pattern in NOISE_LINE_RES)


def extract_title(soup: BeautifulSoup) -> str:
    title = extract_first_text(soup, ".main-title")
    if title:
        return title
    if soup.title and soup.title.string:
        return soup.title.string
    h1 = soup.find("h1")
    return h1.get_text(" ", strip=True) if h1 else ""


def extract_first_text(soup: BeautifulSoup, selector: str) -> str:
    node = soup.select_one(selector)
    return node.get_text(" ", strip=True) if node else ""


def clean_title(title: str) -> str:
    title = normalize_inline_text(title)
    title = re.sub(r"\s*-\s*(?:禁忌书屋|禁忌書屋|cool18|酷18).*$", "", title, flags=re.I)
    return title.strip()


def clean_series_title(title: str) -> str:
    title = clean_title(title)
    title = re.sub(r"\s*[（(]\s*\d{1,3}\s*[-－—~至]\s*\d{1,3}\s*[）)]\s*$", "", title)
    return title.strip() or "novel"


def clean_author(author: str) -> str:
    author = normalize_inline_text(author)
    author = re.sub(r"^送交者\s*[:：]\s*", "", author)
    return author.strip()


def normalize_inline_text(value: str) -> str:
    value = re.sub(r"[\t \u3000]+", " ", value or "")
    value = re.sub(r"\s*([，。！？；：、“”‘’（）《》【】])\s*", r"\1", value)
    return value.strip()


def parse_chapter_range(value: str) -> tuple[int | None, int | None] | None:
    if not value:
        return None
    match = CHAPTER_RANGE_RE.search(value)
    if not match:
        return None
    start = int(match.group(1))
    end = int(match.group(2) or match.group(1))
    return start, end


def link_sort_key(link: ThreadLink) -> tuple[int, int, str]:
    start = link.range_start if link.range_start is not None else 9999
    end = link.range_end if link.range_end is not None else start
    return (start, end, link.tid or link.url)


def page_sort_key(page: ThreadPage) -> tuple[int, int, int]:
    start = page.range_start if page.range_start is not None else (0 if page.discovery_index == 0 else 9999)
    end = page.range_end if page.range_end is not None else start
    return (start, end, page.discovery_index)


def tid_from_url(url: str) -> str:
    parsed = urlparse(url)
    return parse_qs(parsed.query).get("tid", [""])[0]


def thread_key(url: str) -> str:
    tid = tid_from_url(url)
    if tid:
        return f"tid:{tid}"
    parsed = urlparse(url)
    return parsed._replace(fragment="").geturl()


def normalize_url(url: str, base_url: str) -> str:
    absolute = urljoin(base_url, url)
    parsed = urlparse(absolute)
    return parsed._replace(fragment="").geturl()


def first_present(values: Iterable[str]) -> str:
    for value in values:
        if value:
            return value
    return ""


def default_output_path(pages: list[ThreadPage]) -> Path:
    title = clean_series_title(pages[0].title if pages else "novel")
    slug = safe_filename(title)[:80] or "novel"
    return DEFAULT_OUTPUT_DIR / f"{slug}.txt"


def safe_filename(value: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value


def print_summary(status: str, pages: list[ThreadPage], output_path: Path | None, text: str, preview_lines: int) -> None:
    preview = [line for line in text.splitlines() if line.strip()][: max(0, preview_lines)]
    payload = {
        "status": status,
        "pages": [
            {
                "index": index + 1,
                "tid": page.tid,
                "range": [page.range_start, page.range_end],
                "title": page.title,
                "url": page.url,
            }
            for index, page in enumerate(pages)
        ],
        "output": str(output_path) if output_path else None,
        "chars": len(text),
        "preview": preview,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
