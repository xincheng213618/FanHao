import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse

try:
    import cloudscraper
except ModuleNotFoundError:
    cloudscraper = None
import requests
from bs4 import BeautifulSoup
from requests import RequestException


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "logs" / "novels"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)


class ProbeError(RuntimeError):
    pass

ARTICLE_RE = re.compile(r"\baction=article\b", re.I)
CHAPTER_RANGE_RE = re.compile(
    r"(?:[（(]\s*)?(\d+(?:\.\d+)?)\s*(?:[-－—~至]\s*(\d+(?:\.\d+)?))?"
)
NOISE_LINE_RES = [
    re.compile(pattern, re.I)
    for pattern in [
        r"^作者[:：].*字数[:：]",
        r"^字数[:：]?\d+",
        r"^\d{2,4}[-/年]\d{1,2}[-/月]\d{0,2}",
        r"^(首页|排行|全本|阅读史|阅读记录|书库|安卓APP|sitemap)$",
        r"^(上一章|下一章|返回目录|章节目录|点击下载|加入书签|投推荐票)",
        r"(?:下载安卓APP|APP网址|网址被屏蔽|chrome浏览器)",
        r"(?:第一版主|diyibanzhu|www\.diyibanzhu\.me|m\.diyibanzhu\.me)",
        r"^[-_=]{3,}$",
    ]
]


@dataclass
class ChapterLink:
    index: int
    label: str
    url: str
    article_id: str
    range_start: float | None
    range_end: float | None


@dataclass
class PageResult:
    fenye: int
    url: str
    title: str
    raw_chars: int
    clean_chars: int
    body: str  # added to hold the actual main text (正文)


def main() -> None:
    configure_stdout()
    args = parse_args()
    try:
        run_probe(args)
    except ProbeError as exc:
        raise SystemExit(f"错误：{exc}") from exc


def run_probe(args: argparse.Namespace) -> None:
    scraper = build_scraper(args)
    catalog_html = fetch_html(scraper, args.url, args.timeout)
    soup = BeautifulSoup(catalog_html, "html.parser")
    book_title = extract_book_title(soup)
    all_chapters = extract_chapter_links(soup, args.url)
    selected_chapters = remove_covered_ranges(all_chapters) if args.skip_covered else all_chapters
    chapters = selected_chapters[: args.max_chapters] if args.max_chapters else selected_chapters

    report = {
        "status": "ok",
        "bookTitle": book_title,
        "listUrl": args.url,
        "chaptersFound": len(all_chapters),
        "chaptersSelected": len(selected_chapters),
        "chaptersChecked": len(chapters),
        "skippedCovered": [
            chapter_to_report(chapter)
            for chapter in all_chapters
            if chapter.article_id not in {selected.article_id for selected in selected_chapters}
        ],
        "chapterLinks": [chapter_to_report(chapter) for chapter in all_chapters],
        "chapters": [],
    }

    all_chapter_bodies = []

    for chapter in chapters:
        pages = probe_chapter_pages(scraper, chapter, args)
        chapter_body = "\n\n".join(p.body for p in pages if getattr(p, "body", ""))
        all_chapter_bodies.append(f"{chapter.label}\n\n{chapter_body}" if chapter_body else chapter.label)

        report["chapters"].append(
            {
                "index": chapter.index,
                "articleId": chapter.article_id,
                "label": chapter.label,
                "range": [chapter.range_start, chapter.range_end],
                "url": chapter.url,
                "pages": [
                    {
                        "fenye": page.fenye,
                        "url": page.url,
                        "title": page.title,
                        "rawChars": page.raw_chars,
                        "cleanChars": page.clean_chars,
                        "bodyPreview": preview_text(page.body, args.preview_chars),
                    }
                    for page in pages
                ],
                "pageCount": len(pages),
                "cleanCharsTotal": sum(page.clean_chars for page in pages),
            }
        )
        if args.delay > 0:
            time.sleep(args.delay)

    novel_header = [
        book_title,
    ]
    if "author" in report and report["author"]:
        novel_header.append(f"作者：{report['author']}")
    novel_header.extend(
        [
            f"来源：{args.url}",
            f"整理时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            "",
        ]
    )

    full_text = "\n\n".join(novel_header) + "\n\n" + "\n\n".join(all_chapter_bodies) + "\n"

    try:
        from fix_novel_format import fix_novel_text

        full_text = fix_novel_text(full_text, indent=True)
    except Exception:
        pass

    out_txt = DEFAULT_OUTPUT_DIR / f"{safe_filename(book_title)}.txt"
    out_txt.parent.mkdir(parents=True, exist_ok=True)
    out_txt.write_text(full_text, encoding="utf-8", newline="\n")
    report["novelTxt"] = str(out_txt)
    report["novelChars"] = len(full_text)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        report["output"] = str(args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def configure_stdout() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download and format diyibanzhu novel from catalog URL. Outputs full novel text with body (正文), UTF-8, and standard formatting.")
    parser.add_argument("url", help="目录页 URL，例如 https://www.diyibanzhu.me/wap.php?action=list&id=14370")
    parser.add_argument("--max-chapters", type=int, default=0, help="最多检查多少个章节链接；0 表示全部。")
    parser.add_argument("--delay", type=float, default=0.5)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--output", type=Path, help="可选：把 JSON 诊断报告写入文件。")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    parser.add_argument("--use-env-proxy", action="store_true", help="默认关闭环境代理；需要时显式开启。")
    parser.add_argument("--keep-covered", dest="skip_covered", action="store_false", help="保留被后续合集条目覆盖的旧目录项。")
    parser.add_argument("--preview-chars", type=int, default=0, help="JSON 报告里每页正文预览字符数；默认 0 表示不输出正文预览。")
    parser.set_defaults(skip_covered=True)
    args = parser.parse_args()
    if args.max_chapters < 0:
        parser.error("--max-chapters 不能小于 0。")
    if args.preview_chars < 0:
        parser.error("--preview-chars 不能小于 0。")
    if not args.output:
        safe_name = safe_filename(urlparse(args.url).query or "diyibanzhu")
        args.output = DEFAULT_OUTPUT_DIR / f"{safe_name}-probe.json"
    return args


def build_scraper(args: argparse.Namespace):
    scraper = cloudscraper.create_scraper() if cloudscraper else requests.Session()
    scraper.trust_env = bool(args.use_env_proxy)
    scraper.headers.update(
        {
            "User-Agent": args.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
    )
    return scraper


def fetch_html(scraper, url: str, timeout: float) -> str:
    try:
        response = scraper.get(url, timeout=timeout)
    except RequestException as exc:
        raise ProbeError(f"请求失败：{url}；{exc}") from exc
    if is_cloudflare_challenge(response):
        raise ProbeError(
            "目标站点返回 Cloudflare 交互式验证/403，当前脚本请求被拦截；"
            "请先在浏览器确认该 URL 能打开，或稍后重试。"
        )
    try:
        response.raise_for_status()
    except RequestException as exc:
        raise ProbeError(f"HTTP 请求失败：{url}；状态码 {response.status_code}") from exc
    response.encoding = response.apparent_encoding or response.encoding or "utf-8"
    return response.text


def is_cloudflare_challenge(response) -> bool:
    if response.status_code != 403:
        return False
    if response.headers.get("Cf-Mitigated", "").lower() == "challenge":
        return True
    text = response.text[:2000].lower()
    return "challenges.cloudflare.com" in text or "<title>just a moment" in text


def extract_book_title(soup: BeautifulSoup) -> str:
    detail_title = soup.select_one(".detail h1, .detail .title, .detail .book-title")
    if detail_title:
        return normalize_text(detail_title.get_text(" ", strip=True))
    raw_title = soup.title.get_text(" ", strip=True) if soup.title else ""
    raw_title = re.sub(r"最新章节.*$", "", raw_title)
    raw_title = re.sub(r"_.*$", "", raw_title)
    return normalize_text(raw_title) or "diyibanzhu-novel"


def extract_chapter_links(soup: BeautifulSoup, base_url: str) -> list[ChapterLink]:
    chapter_lists = soup.select(".chapter-list")
    root = select_chapter_root(chapter_lists) if chapter_lists else soup
    links: list[ChapterLink] = []
    seen: set[str] = set()

    for anchor in root.select("a[href]"):
        href = anchor.get("href") or ""
        if not ARTICLE_RE.search(href):
            continue
        absolute = urljoin(base_url, href)
        article_id = article_id_from_url(absolute)
        if not article_id or article_id == "0" or article_id in seen:
            continue
        label = normalize_text(anchor.get_text(" ", strip=True))
        start, end = parse_chapter_range(label)
        links.append(ChapterLink(len(links) + 1, label, absolute, article_id, start, end))
        seen.add(article_id)

    return links


def select_chapter_root(chapter_lists) -> BeautifulSoup:
    return max(
        chapter_lists,
        key=lambda node: sum(1 for anchor in node.select("a[href]") if ARTICLE_RE.search(anchor.get("href") or "")),
    )


def remove_covered_ranges(chapters: list[ChapterLink]) -> list[ChapterLink]:
    selected_reversed: list[ChapterLink] = []
    covered_ranges: list[tuple[float, float]] = []

    for chapter in reversed(chapters):
        chapter_range = normalized_range(chapter)
        if chapter_range and any(is_range_covered(chapter_range, known_range) for known_range in covered_ranges):
            continue
        selected_reversed.append(chapter)
        if chapter_range:
            covered_ranges.append(chapter_range)

    return list(reversed(selected_reversed))


def normalized_range(chapter: ChapterLink) -> tuple[float, float] | None:
    if chapter.range_start is None or chapter.range_end is None:
        return None
    return min(chapter.range_start, chapter.range_end), max(chapter.range_start, chapter.range_end)


def is_range_covered(candidate: tuple[float, float], known_range: tuple[float, float]) -> bool:
    return known_range[0] <= candidate[0] and candidate[1] <= known_range[1]


def chapter_to_report(chapter: ChapterLink) -> dict:
    return {
        "index": chapter.index,
        "articleId": chapter.article_id,
        "label": chapter.label,
        "range": [chapter.range_start, chapter.range_end],
        "url": chapter.url,
    }


def preview_text(text: str, chars: int) -> str:
    return text[:chars] if chars > 0 and text else ""


def probe_chapter_pages(scraper, chapter: ChapterLink, args: argparse.Namespace) -> list[PageResult]:
    first_html = fetch_html(scraper, chapter.url, args.timeout)
    page_urls = discover_page_urls(first_html, chapter.url)
    results: list[PageResult] = []
    for fenye, url in page_urls:
        html = first_html if fenye == 1 and url == chapter.url else fetch_html(scraper, url, args.timeout)
        results.append(parse_page_result(html, url, fenye))
        if args.delay > 0 and url != page_urls[-1][1]:
            time.sleep(args.delay)
    return results


def discover_page_urls(html: str, base_url: str) -> list[tuple[int, str]]:
    soup = BeautifulSoup(html, "html.parser")
    urls = {1: strip_fragment(base_url)}
    for anchor in soup.select(".chapterPages a[href]"):
        absolute = strip_fragment(urljoin(base_url, anchor.get("href") or ""))
        fenye = fenye_from_url(absolute)
        if fenye > 1:
            urls[fenye] = absolute
    return sorted(urls.items(), key=lambda item: item[0])


def parse_page_result(html: str, url: str, fenye: int) -> PageResult:
    soup = BeautifulSoup(html, "html.parser")
    title = normalize_text(extract_page_title(soup))
    root = soup.select_one("#nr1") or soup.select_one(".chapter") or soup.body or soup
    raw_text = root.get_text("\n", strip=True)
    clean_text = clean_body_text(raw_text)
    return PageResult(
        fenye=fenye,
        url=url,
        title=title,
        raw_chars=len(raw_text),
        clean_chars=len(clean_text),
        body=clean_text,
    )


def extract_page_title(soup: BeautifulSoup) -> str:
    node = soup.select_one(".page-title")
    if node:
        return node.get_text(" ", strip=True)
    return soup.title.get_text(" ", strip=True) if soup.title else ""


def clean_body_text(text: str) -> str:
    lines: list[str] = []
    for raw_line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = normalize_text(raw_line)
        if not line or any(pattern.search(line) for pattern in NOISE_LINE_RES):
            continue
        lines.append(line)
    return "\n".join(lines)


def parse_chapter_range(label: str) -> tuple[float | None, float | None]:
    matches = list(CHAPTER_RANGE_RE.finditer(label))
    if not matches:
        return None, None
    match = matches[-1]
    start = float(match.group(1))
    end = float(match.group(2) or match.group(1))
    return start, end


def article_id_from_url(url: str) -> str:
    return parse_qs(urlparse(url).query).get("id", [""])[0]


def fenye_from_url(url: str) -> int:
    raw = parse_qs(urlparse(url).query).get("fenye", ["1"])[0]
    try:
        return max(1, int(raw))
    except ValueError:
        return 1


def strip_fragment(url: str) -> str:
    parsed = urlparse(url)
    return parsed._replace(fragment="").geturl()


def normalize_text(value: str) -> str:
    value = (value or "").replace("\xa0", " ").replace("\u3000", " ")
    return re.sub(r"\s+", " ", value).strip()


def safe_filename(value: str) -> str:
    value = re.sub(r'[<>:"/\\|?*&=\x00-\x1f]+', "_", value)
    return re.sub(r"_+", "_", value).strip(" ._") or "diyibanzhu"


if __name__ == "__main__":
    main()
