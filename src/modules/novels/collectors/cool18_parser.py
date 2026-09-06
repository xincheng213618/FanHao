"""Cool18 post metadata and chapter boundaries, independent of the forum UI."""

from __future__ import annotations

import re
import unicodedata

from core import Chapter, clean_title, extract_content


PARSER_VERSION = 2
NUMBER = r"[\d一二三四五六七八九十百千零〇两]+"
HEADING = re.compile(rf"^第\s*({NUMBER})\s*章(?:\s*[:：、．.]\s*|\s+|$)(.*)$")
AUTHOR = re.compile(r"作\s*者\s*[:：_]\s*(.+)$")
POST_NUMBER = re.compile(r"[（(]\s*(\d+)(?:\s*[-－—~～至]\s*(\d+)|[.．](\d+))?\s*(?:完|完结|大结局)?\s*[）)]")
HEADER_META = re.compile(
    r"^(?:作\s*者\s*[:：]|是否(?:首发|AI辅助)\s*[:：]|字数\s*[:：]|"
    r"\d{4}[/年.-]\d{1,2}[/月.-]\d{1,2}.*(?:发表|发布)|"
    r"送交者\s*[:：]|已读\s*\d+次|大字阅读$|繁体$)"
)


def normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value or "").strip()


def title_metadata(value: str) -> tuple[str, str]:
    value = re.sub(r"\s*-\s*(?:禁忌书屋|禁忌書屋|cool18|酷18).*$", "", value or "", flags=re.I)
    match = AUTHOR.search(value)
    author = match.group(1).strip() if match else ""
    title = value[:match.start()].strip() if match else value.strip()
    bracketed = re.match(r"^[【《\[]([^】》\]]+)[】》\]]", title)
    if bracketed:
        title = bracketed.group(1)
    else:
        title = POST_NUMBER.sub("", title).strip()
    return clean_title(title, "Cool18 小说"), author


def clean_series_title(value: str) -> str:
    return title_metadata(value)[0]


def post_number(title: str) -> tuple[int, int, int] | None:
    match = POST_NUMBER.search(normalized(title))
    if not match:
        return None
    return int(match[1]), int(match[2] or match[1]), int(match[3] or 1)


def chapter_heading(line: str) -> tuple[int, str] | None:
    line = line.strip()
    if len(line) > 90:
        return None
    match = HEADING.fullmatch(line)
    if not match:
        return None
    number_text = normalized(match[1])
    if number_text.isdigit():
        number = int(number_text)
    else:
        digits = dict(zip("零〇一二两三四五六七八九", [0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9]))
        total = current = 0
        for char in number_text:
            if char in digits:
                current = digits[char]
            else:
                total += (current or 1) * {"十": 10, "百": 100, "千": 1000}[char]
                current = 0
        number = total + current
    if number < 1:
        return None
    subtitle = match[2].strip().replace("(", "（").replace(")", "）")
    return number, f"第{match[1]}章 {subtitle}".strip()


def extract_post(soup, page_title: str, series_title: str) -> tuple[str, str]:
    # A comma-separated selector is returned in DOM order, NOT priority order.
    # In particular .main-content precedes and contains the real post body.
    node = None
    for selector in ("#content-section pre", "#content-section", ".post-content", "article"):
        node = soup.select_one(selector)
        if node is not None:
            break
    if node is None:
        from core import CollectionError
        raise CollectionError("Cool18 页面没有匹配到正文容器")
    body_author = ""
    for line in node.get_text("\n").splitlines()[:30]:
        match = AUTHOR.fullmatch(line.strip())
        if match:
            body_author = match[1].strip()
            break
    content = extract_content(
        f'<article id="cool18-body">{node}</article>', "#cool18-body",
        remove_selectors=[
            "a[href*='threadview']", ".comment-section", ".ad-container",
            ".view_ad_bottom", ".view_ad_incontent", ".action-buttons",
            ".vote-section", ".warning-info", ".ai-detection-feedback",
            ".view-gift", ".view_tools_box", ".post-list", ".bottom-nav",
        ],
        first_only=True,
    )
    return clean_post_text(content, page_title, series_title), body_author


def clean_post_text(content: str, page_title: str, series_title: str) -> str:
    content = re.sub(r"\[attach\]\s*\d+\s*\[/attach\]", "", content, flags=re.I)
    header = re.compile(
        rf"^[【《\[]{re.escape(normalized(series_title))}[】》\]]\s*"
        rf"(?:第\s*{NUMBER}\s*章|\([^)]*\))?\s*(?:作\s*者\s*[:：_].*)?$"
    )
    lines = []
    in_header = True
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        if in_header and (normalized(line) == normalized(page_title) or header.fullmatch(normalized(line)) or HEADER_META.match(line)):
            continue
        in_header = False
        lines.append(line)
    return "\n\n".join(lines)


def build_chapters(posts: list[Chapter]) -> list[Chapter]:
    def sort_key(post):
        spec = post_number(post.title)
        heading = next((chapter_heading(line) for line in post.content.splitlines() if chapter_heading(line)), None)
        return (spec[0] if spec else heading[0] if heading else 10**9, spec[2] if spec else 1, post.order)

    chapters: list[Chapter] = []
    previous_number = previous_part = None
    for post in sorted(posts, key=sort_key):
        lines = [line.strip() for line in post.content.splitlines() if line.strip()]
        headings = [(i, chapter_heading(line)) for i, line in enumerate(lines) if chapter_heading(line)]
        spec = post_number(post.title)
        continuation = bool(spec and spec[0] == spec[1] and spec[2] > 1
                            and previous_number == spec[0] and previous_part == spec[2] - 1)
        if not headings:
            if continuation and chapters:
                chapters[-1].content += "\n\n" + post.content
            else:
                title = (f"第{spec[0]}章" if spec[0] == spec[1] else f"第{spec[0]}—{spec[1]}章") if spec else post.title
                if spec and spec[2] > 1:
                    title += f"（第{spec[2]}部分）"
                chapters.append(Chapter(title=title, url=post.url, content=post.content))
        else:
            for j, (start, heading) in enumerate(headings):
                end = headings[j + 1][0] if j + 1 < len(headings) else len(lines)
                # Keep prefaces/author notes; only remove the repeated chapter heading.
                body = (lines[:start] if j == 0 else []) + lines[start + 1:end]
                content = "\n\n".join(body).strip()
                if not content:
                    continue
                if j == 0 and continuation and chapters and heading[0] == spec[0]:
                    chapters[-1].content += "\n\n" + content
                else:
                    chapters.append(Chapter(title=heading[1], url=post.url, content=content))
        previous_number = headings[-1][1][0] if headings else spec[0] if spec else None
        previous_part = spec[2] if spec else 1
    for index, chapter in enumerate(chapters, 1):
        chapter.order = index
    return chapters
