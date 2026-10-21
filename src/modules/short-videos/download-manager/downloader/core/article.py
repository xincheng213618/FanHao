"""Archive Douyin article Markdown and its images without executing source HTML."""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
from datetime import datetime
from html import escape
from pathlib import Path
from urllib.parse import quote, urlparse

import aiofiles
from markdown_it import MarkdownIt


def article_info(data: dict) -> dict:
    value = data.get("article_info") or data.get("articleInfo")
    return value if isinstance(value, dict) else {}


def is_article(data: dict) -> bool:
    return bool(article_info(data)) or data.get("media_type") == "article"


def article_title(data: dict) -> str:
    info = article_info(data)
    return str(info.get("article_title") or info.get("articleTitle") or data.get("desc") or "")


def article_markdown(data: dict) -> str:
    info = article_info(data)
    content = info.get("article_content") or info.get("articleContent")
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (ValueError, TypeError):
            return ""
    if not isinstance(content, dict):
        return ""
    markdown = content.get("markdown")
    return markdown.strip() if isinstance(markdown, str) else ""


def _image_tokens(tokens):
    for token in tokens:
        if token.type == "image":
            yield token
        if token.children:
            yield from _image_tokens(token.children)


async def _write_text(path: Path, text: str) -> None:
    temporary = path.with_suffix(path.suffix + ".part")
    async with aiofiles.open(temporary, "w", encoding="utf-8") as handle:
        await handle.write(text)
    await asyncio.to_thread(os.replace, temporary, path)


async def save_article(downloader, data: dict, directory: Path, stem: str, session) -> list[Path]:
    markdown = article_markdown(data)
    if not markdown:
        raise ValueError("文章正文为空或格式不支持，未保存为已下载")
    renderer = MarkdownIt("commonmark", {"html": False}).enable("table").enable("strikethrough")
    environment = {}
    tokens = renderer.parse(markdown, environment)
    images: dict[str, tuple[Path, str]] = {}
    for token in _image_tokens(tokens):
        source = token.attrGet("src") or ""
        url = "https:" + source if source.startswith("//") else source
        parsed = urlparse(url)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("文章配图地址无效，未保存为已下载")
        if source not in images:
            path = directory / f"{stem}_article_{len(images) + 1}{downloader._infer_image_extension(url)}"
            saved = await downloader._download_with_retry(
                url, path, session, headers=downloader._download_headers(),
                prefer_response_content_type=True, return_saved_path=True,
            )
            if not saved:
                raise ValueError("文章配图下载失败，未保存为已下载")
            path = saved if isinstance(saved, Path) else path
            async with aiofiles.open(path, "rb") as handle:
                content = await handle.read()
            mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
            if not content or mime not in {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}:
                raise ValueError("文章配图格式无效，未保存为已下载")
            images[source] = (path, f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}")
        token.attrSet("src", images[source][1])

    # HTML embeds images so it opens both from disk and the manager's media endpoint.
    body = renderer.renderer.render(tokens, renderer.options, environment)
    title = article_title(data) or str(data["aweme_id"])
    author = str((data.get("author") or {}).get("nickname") or "")
    source_url = f"https://www.douyin.com/article/{quote(str(data['aweme_id']), safe='')}"
    timestamp = data.get("create_time")
    try:
        published = datetime.fromtimestamp(int(timestamp)).isoformat(sep=" ", timespec="seconds")
    except (TypeError, ValueError, OverflowError, OSError):
        published = ""
    document = (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
        'img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
        f"<title>{escape(title)}</title><style>"
        "body{max-width:800px;margin:40px auto;padding:0 24px;font:18px/1.8 system-ui,sans-serif;"
        "color:#222;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}"
        "pre{overflow:auto;white-space:pre-wrap}table{border-collapse:collapse}"
        "td,th{border:1px solid #ddd;padding:6px 12px}.meta{color:#666;font-size:14px}"
        f"</style></head><body><h1>{escape(title)}</h1>"
        f'<p class="meta">{escape(author)} · {escape(published)} · '
        f'<a href="{escape(source_url, quote=True)}" rel="noreferrer">抖音原文</a></p>'
        f"<main>{body}</main></body></html>"
    )
    local_markdown = markdown
    for source, (path, _) in images.items():
        local_markdown = local_markdown.replace(source, quote(path.name))
    header = f"# {title}\n\n作者：{author}\n\n发布时间：{published}\n\n原文：{source_url}\n\n"
    markdown_path = directory / f"{stem}.md"
    html_path = directory / f"{stem}.html"
    await _write_text(markdown_path, header + local_markdown + "\n")
    # Write the completed document last: failed image downloads cannot become a local success.
    await _write_text(html_path, document)
    return [html_path, markdown_path, *(path for path, _ in images.values())]
