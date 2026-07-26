"""Built-in and configurable adapters for the unified novel collector."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup

from core import (
    Chapter,
    CollectionError,
    CollectorContext,
    clean_author,
    clean_title,
    dedupe_links,
    extract_content,
    fallback_page_title,
    normalize_http_url,
    normalize_inline,
    numeric_sort_key,
    same_host,
    select_first,
    select_nodes,
    selected_text,
)


DIYIBANZHU_NOISE = [
    r"^作者[:：].*字数[:：]",
    r"^字数[:：]?\d+",
    r"^(?:首页|排行|全本|阅读史|阅读记录|书库|安卓APP|sitemap)$",
    r"(?:下载安卓APP|APP网址|网址被屏蔽|chrome浏览器)",
    r"(?:第一版主|diyibanzhu)",
]
COOL18_NOISE = [
    r"^送交者\s*[:：]",
    r"^(?:作者|楼主|发表于|来源)\s*[:：]",
    r"(?:cool18|6park|留园|禁忌书屋)",
    r"(?:广告|二维码|扫码|版主|AI检测)",
]
ALICESW_NOISE = [
    r"^(?:首页|文章|爱丽丝书屋|分类|最新章节|书架|排行|登录|注册|返回)",
    r"^(?:推荐|投票|加入书架|直达底部|快速导航)",
    r"^[\ue000-\uf8ff]+$",
    r"(?:alicesw|爱丽丝书屋)",
    r"(?:验证码|访问验证|安全验证|当前访问行为)",
]


def collect(payload: dict[str, Any], context: CollectorContext) -> dict[str, Any]:
    adapter = payload.get("adapter") or {}
    driver = str(adapter.get("driver") or "generic")
    url = normalize_http_url(payload.get("url") or "")
    config = dict(adapter.get("config") or {})
    options = payload.get("options") or {}
    for key in ("maxChapters", "delayMs", "timeoutMs"):
        value = options.get(key)
        if isinstance(value, (int, float)) and value >= 0:
            config[key] = value
    if payload.get("mode") == "test":
        config["maxChapters"] = 1
    context.config.update(config)
    context.timeout = max(3.0, float(config.get("timeoutMs", 30000)) / 1000.0)
    context.delay = max(0.0, float(config.get("delayMs", 800)) / 1000.0)

    if driver == "diyibanzhu":
        return collect_diyibanzhu(url, config, context)
    if driver == "cool18":
        return collect_cool18(url, config, context)
    if driver == "alicesw":
        return collect_alicesw(url, config, context)
    if driver == "generic":
        return collect_generic(url, config, context)
    raise CollectionError(f"未知采集驱动：{driver}")


def collect_generic(url: str, config: dict[str, Any], context: CollectorContext) -> dict[str, Any]:
    context.status("正在读取目录页")
    catalog_html = context.fetch(url)
    catalog_soup = BeautifulSoup(catalog_html, "html.parser")
    title = clean_title(
        selected_text(catalog_soup, config.get("bookTitleSelector", ""), "书名")
        or fallback_page_title(catalog_soup)
    )
    author = clean_author(selected_text(catalog_soup, config.get("authorSelector", ""), "作者"))
    chapter_selector = str(config.get("chapterLinkSelector") or "").strip()
    content_selector = str(config.get("contentSelector") or "").strip()
    if not content_selector:
        raise CollectionError("自定义适配器缺少正文 CSS 选择器")

    if not chapter_selector:
        chapters = [Chapter(title=title, url=url, order=1)]
        catalog_pages = 1
    else:
        chapters, catalog_pages = discover_generic_chapters(
            url,
            catalog_html,
            chapter_selector,
            config,
            context,
        )
    if not chapters:
        raise CollectionError("章节链接选择器没有解析出任何章节")
    if config.get("sortMode") == "numeric":
        chapters.sort(key=lambda chapter: numeric_sort_key(chapter.title))
        for index, chapter in enumerate(chapters, 1):
            chapter.order = index
    chapters = apply_limit(chapters, config.get("maxChapters"))
    context.status(f"已解析 {len(chapters)} 个章节链接")

    page_counts: list[int] = []
    completed: list[Chapter] = []
    for index, chapter in enumerate(chapters, 1):
        cached = context.restore_chapter(chapter)
        if cached:
            cached.order = len(completed) + 1
            completed.append(cached)
            metadata = context.checkpoint_metadata(chapter.url)
            page_counts.append(max(1, clamp_int(metadata.get("pageCount"), 1, 1, 200)))
            context.progress(index, len(chapters), f"已从断点恢复：{cached.title}")
            continue
        context.progress(index - 1, len(chapters), f"正在采集：{chapter.title}")
        content, page_count, page_title = collect_generic_chapter(chapter, config, context)
        if page_title:
            chapter.title = clean_title(page_title, chapter.title)
        if not content:
            context.warning(f"章节正文为空：{chapter.title}")
            continue
        chapter.content = content
        chapter.order = len(completed) + 1
        completed.append(chapter)
        page_counts.append(page_count)
        context.save_chapter(chapter, metadata={"pageCount": page_count}, total=len(chapters))
        context.progress(index, len(chapters), f"已完成：{chapter.title}")
        if index < len(chapters):
            context.pause()
    if not completed:
        raise CollectionError("没有采集到有效正文")
    return {
        "title": title,
        "author": author,
        "sourceUrl": url,
        "category": "网页采集",
        "chapters": [chapter.to_dict() for chapter in completed],
        "report": {
            "driver": "generic",
            "catalogPages": catalog_pages,
            "chapterLinks": len(chapters),
            "chapterPages": sum(page_counts),
        },
    }


def discover_generic_chapters(
    start_url: str,
    first_html: str,
    chapter_selector: str,
    config: dict[str, Any],
    context: CollectorContext,
) -> tuple[list[Chapter], int]:
    catalog_selector = str(config.get("catalogSelector") or "").strip()
    next_selector = str(config.get("catalogNextSelector") or "").strip()
    max_pages = clamp_int(config.get("maxCatalogPages"), 10, 1, 100)
    url_pattern = compile_optional_regex(config.get("chapterUrlPattern"), "章节网址")
    chapters: list[Chapter] = []
    seen_pages: set[str] = set()
    page_url = start_url
    html = first_html

    while page_url and len(seen_pages) < max_pages:
        normalized_page = normalize_http_url(page_url)
        if normalized_page in seen_pages:
            break
        seen_pages.add(normalized_page)
        soup = BeautifulSoup(html, "html.parser")
        root = select_first(soup, catalog_selector, "目录容器") if catalog_selector else soup
        if root is None:
            raise CollectionError(f"目录容器选择器没有匹配内容：{catalog_selector}")
        try:
            anchors = root.select(chapter_selector)
        except Exception as exc:
            raise CollectionError(f"章节链接 CSS 选择器无效：{chapter_selector}；{exc}") from exc
        for anchor in anchors:
            href = anchor.get("href") if hasattr(anchor, "get") else ""
            if not href:
                continue
            absolute = normalize_http_url(href, normalized_page)
            if url_pattern and not url_pattern.search(absolute):
                continue
            label = normalize_inline(anchor.get_text(" ", strip=True))
            chapters.append(Chapter(title=label or f"第 {len(chapters) + 1} 章", url=absolute))
        if not next_selector:
            break
        next_node = select_first(soup, next_selector, "目录下一页")
        next_href = next_node.get("href") if next_node else ""
        if not next_href:
            break
        candidate = normalize_http_url(next_href, normalized_page)
        if not same_host(start_url, candidate) or candidate in seen_pages:
            break
        context.status(f"正在读取目录第 {len(seen_pages) + 1} 页")
        context.pause()
        page_url = candidate
        html = context.fetch(candidate)

    return dedupe_links(chapters), len(seen_pages)


def collect_generic_chapter(
    chapter: Chapter,
    config: dict[str, Any],
    context: CollectorContext,
) -> tuple[str, int, str]:
    next_selector = str(config.get("chapterNextSelector") or "").strip()
    max_pages = clamp_int(config.get("maxChapterPages"), 20, 1, 200)
    remove_selectors = list(config.get("removeSelectors") or [])
    if next_selector:
        remove_selectors.append(next_selector)
    line_patterns = list(config.get("removeLinePatterns") or [])
    title_selector = str(config.get("chapterTitleSelector") or "").strip()
    page_url = chapter.url
    seen: set[str] = set()
    parts: list[str] = []
    page_title = ""

    while page_url and len(seen) < max_pages:
        normalized_page = normalize_http_url(page_url)
        if normalized_page in seen:
            break
        seen.add(normalized_page)
        html = context.fetch(normalized_page)
        soup = BeautifulSoup(html, "html.parser")
        if not page_title and title_selector:
            page_title = selected_text(soup, title_selector, "章节标题")
        part = extract_content(
            html,
            str(config.get("contentSelector") or ""),
            remove_selectors=remove_selectors,
            line_patterns=line_patterns,
        )
        if part and part not in parts:
            parts.append(part)
        if not next_selector:
            break
        next_node = select_first(soup, next_selector, "章节下一页")
        next_href = next_node.get("href") if next_node else ""
        if not next_href:
            break
        candidate = normalize_http_url(next_href, normalized_page)
        if not same_host(chapter.url, candidate) or candidate in seen:
            break
        context.pause()
        page_url = candidate

    return "\n\n".join(parts).strip(), len(seen), page_title


def collect_diyibanzhu(url: str, config: dict[str, Any], context: CollectorContext) -> dict[str, Any]:
    context.status("正在读取第一版主完整目录")
    html = context.fetch(url)
    soup = BeautifulSoup(html, "html.parser")
    title = clean_title(
        selected_text(soup, ".detail h1, .detail .title, .detail .book-title", "书名")
        or fallback_page_title(soup),
        "第一版主小说",
    )
    lists = soup.select(".chapter-list")
    root = max(
        lists,
        key=lambda node: sum(1 for anchor in node.select("a[href]") if "action=article" in (anchor.get("href") or "")),
    ) if lists else soup
    chapters: list[Chapter] = []
    for anchor in root.select("a[href]"):
        href = anchor.get("href") or ""
        if "action=article" not in href:
            continue
        label = normalize_inline(anchor.get_text(" ", strip=True))
        chapters.append(Chapter(title=label or f"第 {len(chapters) + 1} 章", url=urljoin(url, href)))
    chapters = dedupe_links(chapters)
    before_prune = list(chapters)
    if config.get("skipCoveredRanges", True):
        chapters = remove_covered_ranges(chapters)
    chapters_after_prune = list(chapters)
    chapters = apply_limit(chapters, config.get("maxChapters"))
    if not chapters:
        raise CollectionError("第一版主目录没有解析出 action=article 章节链接")

    completed: list[Chapter] = []
    total_pages = 0
    for index, chapter in enumerate(chapters, 1):
        cached = context.restore_chapter(chapter)
        if cached:
            cached.order = len(completed) + 1
            completed.append(cached)
            metadata = context.checkpoint_metadata(chapter.url)
            total_pages += max(1, clamp_int(metadata.get("pageCount"), 1, 1, 200))
            context.progress(index, len(chapters), f"已从断点恢复：{cached.title}")
            continue
        context.progress(index - 1, len(chapters), f"正在采集：{chapter.title}")
        first_html = context.fetch(chapter.url)
        page_urls = diyibanzhu_page_urls(first_html, chapter.url)
        parts: list[str] = []
        for page_index, page_url in enumerate(page_urls, 1):
            page_html = first_html if page_index == 1 else context.fetch(page_url)
            content_selector = first_available_selector(page_html, ["#nr1", ".chapter"])
            part = extract_content(
                page_html,
                content_selector,
                remove_selectors=[".chapterPages", ".pages", ".page", ".pagenavi"],
                line_patterns=DIYIBANZHU_NOISE,
                first_only=True,
            )
            if part and part not in parts:
                parts.append(part)
            if page_index < len(page_urls):
                context.pause()
        content = "\n\n".join(parts).strip()
        if content:
            chapter.content = content
            chapter.order = len(completed) + 1
            completed.append(chapter)
            context.save_chapter(chapter, metadata={"pageCount": len(page_urls)}, total=len(chapters))
        else:
            context.warning(f"章节正文为空：{chapter.title}")
        total_pages += len(page_urls)
        context.progress(index, len(chapters), f"已完成：{chapter.title}")
        if index < len(chapters):
            context.pause()
    if not completed:
        raise CollectionError("没有采集到有效正文")
    skipped = [chapter.title for chapter in before_prune if chapter.url not in {item.url for item in chapters_after_prune}]
    return {
        "title": title,
        "author": "",
        "sourceUrl": url,
        "category": "网页采集",
        "chapters": [chapter.to_dict() for chapter in completed],
        "report": {
            "driver": "diyibanzhu",
            "chaptersFound": len(before_prune),
            "chaptersSelected": len(chapters),
            "chaptersImported": len(completed),
            "chapterPages": total_pages,
            "skippedCovered": skipped,
        },
    }


def diyibanzhu_page_urls(first_html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(first_html, "html.parser")
    pages: dict[int, str] = {1: normalize_http_url(base_url)}
    for anchor in soup.select(".chapterPages a[href]"):
        absolute = normalize_http_url(anchor.get("href") or "", base_url)
        value = parse_qs(urlparse(absolute).query).get("fenye", ["1"])[0]
        try:
            number = max(1, int(value))
        except ValueError:
            number = len(pages) + 1
        pages[number] = absolute
    return [item[1] for item in sorted(pages.items())]


def remove_covered_ranges(chapters: list[Chapter]) -> list[Chapter]:
    selected: list[Chapter] = []
    covered: list[tuple[float, float]] = []
    for chapter in reversed(chapters):
        value = chapter_range(chapter.title)
        if value and any(known[0] <= value[0] and value[1] <= known[1] for known in covered):
            continue
        selected.append(chapter)
        if value:
            covered.append(value)
    selected.reverse()
    return selected


def chapter_range(value: str) -> tuple[float, float] | None:
    match = re.search(r"(?:[（(]\s*)?(\d+(?:\.\d+)?)\s*(?:[-－—~至]\s*(\d+(?:\.\d+)?))?", value or "")
    if not match:
        return None
    start = float(match.group(1))
    end = float(match.group(2) or match.group(1))
    return min(start, end), max(start, end)


def collect_alicesw(url: str, config: dict[str, Any], context: CollectorContext) -> dict[str, Any]:
    context.status("正在解析爱丽丝书屋目录")
    html = context.fetch(url)
    list_url = url
    if "/novel/" in url:
        soup = BeautifulSoup(html, "html.parser")
        for anchor in soup.select("a[href]"):
            label = normalize_inline(anchor.get_text(" ", strip=True))
            if any(text in label for text in ("查看所有章节", "章节列表", "全部章节")):
                list_url = normalize_http_url(anchor.get("href") or "", url)
                break
        if list_url == url:
            match = re.search(r"/other/chapters/id/\d+", html)
            if match:
                list_url = normalize_http_url(match.group(0), url)
        if list_url != url:
            context.pause()
            html = context.fetch(list_url)
    soup = BeautifulSoup(html, "html.parser")
    title = clean_title(fallback_page_title(soup), "爱丽丝书屋小说")
    author = clean_author(find_author_text(soup))
    root = soup.select_one(".warpper") or soup
    chapters: list[Chapter] = []
    for anchor in root.select("a[href]"):
        label = normalize_inline(anchor.get_text(" ", strip=True))
        href = anchor.get("href") or ""
        if not label or "/book/" not in urljoin(list_url, href):
            continue
        if not looks_like_alicesw_chapter(label):
            continue
        chapters.append(Chapter(title=label, url=urljoin(list_url, href)))
    chapters = dedupe_links(chapters)
    chapters.sort(key=lambda chapter: alicesw_sort_key(chapter.title))
    chapters = apply_limit(chapters, config.get("maxChapters"))
    if not chapters:
        raise CollectionError("爱丽丝书屋目录没有解析出章节链接")

    completed: list[Chapter] = []
    for index, chapter in enumerate(chapters, 1):
        cached = context.restore_chapter(chapter)
        if cached:
            cached.order = len(completed) + 1
            completed.append(cached)
            context.progress(index, len(chapters), f"已从断点恢复：{cached.title}")
            continue
        context.progress(index - 1, len(chapters), f"正在采集：{chapter.title}")
        chapter_html = context.fetch(chapter.url)
        content_selector = first_available_selector(
            chapter_html,
            [
                ".j_readContent",
                ".read-content",
                "#ajaxchapter",
                "[id^='ajaxchapter-']",
                ".text-wrap",
                ".main-text-wrap",
                "#j_readMainWrap",
                "article",
                ".webBody",
                "div[class*='content']",
            ],
        )
        content = extract_content(
            chapter_html,
            content_selector,
            remove_selectors=[
                ".text-head",
                ".text-info",
                ".chapter-control",
                ".chapter-nav",
                ".book-info",
                ".recommend",
                ".bottom",
                ".top",
            ],
            line_patterns=ALICESW_NOISE,
            first_only=True,
        )
        if any(text in content for text in ("输入验证码", "当前访问行为触发", "安全验证")):
            raise CollectionError("爱丽丝书屋要求验证码，无法继续采集")
        if content:
            chapter.content = content
            chapter.order = len(completed) + 1
            completed.append(chapter)
            context.save_chapter(chapter, total=len(chapters))
        context.progress(index, len(chapters), f"已完成：{chapter.title}")
        if index < len(chapters):
            context.pause()
    if not completed:
        raise CollectionError("没有采集到有效正文")
    return {
        "title": title,
        "author": author,
        "sourceUrl": url,
        "category": "网页采集",
        "chapters": [chapter.to_dict() for chapter in completed],
        "report": {
            "driver": "alicesw",
            "listUrl": list_url,
            "chapterLinks": len(chapters),
            "chaptersImported": len(completed),
        },
    }


def collect_cool18(url: str, config: dict[str, Any], context: CollectorContext) -> dict[str, Any]:
    configured_max = clamp_int(config.get("maxChapters"), 30, 0, 500)
    max_pages = configured_max or 500
    queue = [url]
    queued = {thread_key(url)}
    visited: set[str] = set()
    chapters: list[Chapter] = []
    author = ""
    series_title = ""

    while queue and len(chapters) < max_pages:
        current_url = queue.pop(0)
        key = thread_key(current_url)
        queued.discard(key)
        if key in visited:
            continue
        cached = context.restore_chapter(
            Chapter(title=f"帖子 {len(chapters) + 1}", url=current_url)
        )
        if cached:
            metadata = context.checkpoint_metadata(current_url)
            if not series_title:
                series_title = str(metadata.get("seriesTitle") or clean_cool18_series_title(cached.title))
            if not author:
                author = str(metadata.get("author") or "")
            for saved_url in metadata.get("nextUrls") or []:
                try:
                    candidate = normalize_http_url(saved_url, current_url)
                except CollectionError:
                    continue
                child_key = thread_key(candidate)
                if same_host(url, candidate) and child_key not in visited and child_key not in queued:
                    queue.append(candidate)
                    queued.add(child_key)
            cached.order = len(chapters) + 1
            chapters.append(cached)
            visited.add(key)
            queue.sort(key=lambda item: cool18_url_sort_key(item))
            context.progress(len(chapters), max_pages, f"已从断点恢复：{cached.title}")
            continue
        context.progress(len(chapters), max_pages, f"正在采集帖子 {len(chapters) + 1}")
        html = context.fetch(current_url)
        soup = BeautifulSoup(html, "html.parser")
        page_title = clean_title(
            selected_text(soup, ".main-title", "帖子标题") or fallback_page_title(soup),
            f"帖子 {len(chapters) + 1}",
        )
        if not series_title:
            series_title = clean_cool18_series_title(page_title)
        if not author:
            author = clean_author(selected_text(soup, ".sender", "作者"))
        root = soup.select_one("#content-section") or soup.select_one(".post-content") or soup.select_one("article") or soup
        discovered_urls: list[str] = []
        for anchor in root.select("a[href]"):
            href = anchor.get("href") or ""
            if "threadview" not in href.lower():
                continue
            candidate = normalize_http_url(href, current_url)
            child_key = thread_key(candidate)
            if same_host(url, candidate) and child_key not in visited and child_key not in queued:
                queue.append(candidate)
                queued.add(child_key)
                discovered_urls.append(candidate)
        content = extract_content(
            html,
            "#content-section, .post-content, article, .main-content",
            remove_selectors=[
                "a[href*='threadview']",
                ".comment-section",
                ".ad-container",
                ".view_ad_bottom",
                ".view_ad_incontent",
                ".action-buttons",
                ".vote-section",
                ".warning-info",
            ],
            line_patterns=COOL18_NOISE,
            first_only=True,
        )
        if content:
            chapter = Chapter(title=page_title, url=current_url, content=content, order=len(chapters) + 1)
            chapters.append(chapter)
            context.save_chapter(
                chapter,
                metadata={
                    "nextUrls": discovered_urls,
                    "author": author,
                    "seriesTitle": series_title,
                },
                total=max_pages,
            )
        visited.add(key)
        queue.sort(key=lambda item: cool18_url_sort_key(item))
        context.progress(len(chapters), max_pages, f"已完成：{page_title}")
        if queue and len(chapters) < max_pages:
            context.pause()
    if not chapters:
        raise CollectionError("没有从帖子链采集到有效正文")
    chapters.sort(key=lambda chapter: (*numeric_sort_key(chapter.title), chapter.order))
    for index, chapter in enumerate(chapters, 1):
        chapter.order = index
    return {
        "title": series_title or clean_cool18_series_title(chapters[0].title),
        "author": author,
        "sourceUrl": url,
        "category": "网页采集",
        "chapters": [chapter.to_dict() for chapter in chapters],
        "report": {
            "driver": "cool18",
            "pagesVisited": len(visited),
            "chaptersImported": len(chapters),
        },
    }


def apply_limit(chapters: list[Chapter], value: Any) -> list[Chapter]:
    limit = clamp_int(value, 0, 0, 20000)
    return chapters[:limit] if limit else chapters


def compile_optional_regex(value: Any, label: str):
    pattern = str(value or "").strip()
    if not pattern:
        return None
    try:
        return re.compile(pattern, re.I)
    except re.error as exc:
        raise CollectionError(f"{label}正则表达式无效：{pattern}；{exc}") from exc


def clamp_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = fallback
    return max(minimum, min(maximum, number))


def find_author_text(soup: BeautifulSoup) -> str:
    text = soup.get_text("\n", strip=True)
    match = re.search(r"作\s*者\s*[：:]\s*([^\s·(]{1,80})", text)
    return match.group(1) if match else ""


def looks_like_alicesw_chapter(value: str) -> bool:
    return bool(
        re.search(r"第\s*[一二三四五六七八九十百千零〇两\d]+\s*(?:章|篇)", value)
        or re.match(r"^第?[一二三四五六七八九十百千零〇两\d]+\s*卷", value)
        or re.match(r"^(?:番外|外传|后记|特别篇|尾声|前传|序章|楔子)", value)
    )


def alicesw_sort_key(value: str) -> tuple[int, int, int, str]:
    volume_match = re.search(r"第?\s*([一二三四五六七八九十百千零〇两\d]+)\s*卷", value)
    volume = chinese_number(volume_match.group(1)) if volume_match else 0
    chapter_match = re.search(r"第\s*([一二三四五六七八九十百千零〇两\d]+)\s*章", value)
    if chapter_match:
        return (0, volume, chinese_number(chapter_match.group(1)), value)
    part_match = re.search(r"第\s*([一二三四五六七八九十百千零〇两\d]+)\s*篇", value)
    if part_match:
        return (1, volume, chinese_number(part_match.group(1)), value)
    return (2, volume, numeric_sort_key(value)[0], value)


def chinese_number(value: str) -> int:
    text = str(value or "").strip()
    if text.isdigit():
        return int(text)
    digits = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    units = {"十": 10, "百": 100, "千": 1000}
    total = 0
    current = 0
    for character in text:
        if character in digits:
            current = digits[character]
        elif character in units:
            unit = units[character]
            total += (current or 1) * unit
            current = 0
    return total + current


def clean_cool18_series_title(value: str) -> str:
    title = re.sub(r"\s*[（(]\s*\d{1,3}\s*(?:[-－—~至]\s*\d{1,3})?\s*[）)]\s*$", "", value or "")
    title = re.sub(r"\s*-\s*(?:禁忌书屋|cool18|酷18).*$", "", title, flags=re.I)
    return clean_title(title, "Cool18 小说")


def thread_key(url: str) -> str:
    parsed = urlparse(url)
    tid = parse_qs(parsed.query).get("tid", [""])[0]
    return f"tid:{tid}" if tid else parsed._replace(fragment="").geturl()


def cool18_url_sort_key(url: str) -> tuple[int, str]:
    match = re.search(r"(?:tid=|[（(])(\d+)", url)
    return (int(match.group(1)) if match else 10**9, url)


def first_available_selector(html: str, selectors: list[str]) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for selector in selectors:
        try:
            if soup.select_one(selector):
                return selector
        except Exception as exc:
            raise CollectionError(f"内置正文选择器无效：{selector}；{exc}") from exc
    raise CollectionError("页面没有匹配到正文容器")
