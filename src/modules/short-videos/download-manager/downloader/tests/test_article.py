import json
from unittest.mock import AsyncMock

import pytest
from test_video_downloader import _build_downloader

from core.article import article_markdown, is_article
from core.downloader_base import _LOCAL_AWEME_INDEX_CACHE
from core.url_parser import URLParser

ARTICLE_ID = "7990000000000000001"


def article(markdown="正文第一段。\n\n## 小标题\n\n**第二段**"):
    return {
        "aweme_id": ARTICLE_ID, "create_time": 1700000000,
        "author": {"nickname": "测试作者", "sec_uid": "fixture-author"},
        "images": [{"url_list": ["https://example.com/cover.jpg"]}],
        "article_info": {
            "article_title": "测试文章",
            "article_content": json.dumps({"markdown": markdown}),
        },
    }


def test_url_and_body_contract():
    assert URLParser.parse(f"https://www.douyin.com/article/{ARTICLE_ID}") == {
        "type": "article", "aweme_id": ARTICLE_ID,
        "original_url": f"https://www.douyin.com/article/{ARTICLE_ID}",
    }
    assert URLParser.parse(f"https://www.douyin.com/article/{ARTICLE_ID}?modal_id=123")["type"] == "article"
    assert is_article(article())
    assert article_markdown(article()).startswith("正文")
    assert article_markdown({"articleInfo": {"articleContent": {"markdown": "camel"}}}) == "camel"
    assert not article_markdown({"article_info": {"article_content": "{broken"}})


@pytest.mark.asyncio
async def test_text_article_is_downloaded_and_deduped(tmp_path):
    downloader, client = _build_downloader(tmp_path)
    client.get_session = AsyncMock(return_value=object())
    client.get_video_detail = AsyncMock(return_value=article())
    downloader.database = AsyncMock()
    downloader.database.is_downloaded.return_value = False
    try:
        result = await downloader.download(URLParser.parse(f"https://www.douyin.com/article/{ARTICLE_ID}"))
        assert (result.success, result.failed) == (1, 0)
        record = downloader.completed_manifest_records[0]
        assert record["media_type"] == "article"
        assert record["desc"] == "测试文章"
        html = next(tmp_path.rglob("*.html")).read_text("utf-8")
        assert "<h2>小标题</h2>" in html
        assert "<strong>第二段</strong>" in html
        assert "测试作者" in html and f"/article/{ARTICLE_ID}" in html
        assert next(tmp_path.rglob("*.md")).read_text("utf-8").startswith("# 测试文章")
        assert downloader.database.add_aweme.call_args.args[0]["aweme_type"] == "article"
        _LOCAL_AWEME_INDEX_CACHE.pop(str(tmp_path.resolve()), None)
        downloader._local_aweme_ids = None
        assert not await downloader._should_download(ARTICLE_ID)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_article_embeds_downloaded_images_and_escapes_html(tmp_path):
    downloader, client = _build_downloader(tmp_path)
    client.get_session = AsyncMock(return_value=object())
    png = b"\x89PNG\r\n\x1a\nfixture"

    async def download(url, path, *args, **kwargs):
        assert url == "https://example.com/image.png"
        path.write_bytes(png)
        return path

    downloader._download_with_retry = AsyncMock(side_effect=download)
    data = article('![一](https://example.com/image.png)\n\n![二][ref]\n\n[ref]: https://example.com/image.png\n\n<script>alert(1)</script>')
    try:
        assert await downloader._download_aweme(data)
        assert downloader._detect_media_type(data) == "article"
        assert downloader._download_with_retry.await_count == 1
        document = next(tmp_path.rglob("*.html")).read_text("utf-8")
        assert document.count('src="data:image/png;base64,') == 2
        assert "<script>" not in document
        assert "&lt;script&gt;" in document
        assert "default-src 'none'" in document
        markdown = next(tmp_path.rglob("*.md")).read_text("utf-8")
        assert "https://example.com/image.png" not in markdown
        assert "_article_1.png" in markdown
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("body", ["", "![图](https://example.com/fail.jpg)", "![图](../private.png)"])
async def test_missing_body_or_image_is_not_success(tmp_path, body):
    downloader, client = _build_downloader(tmp_path)
    client.get_session = AsyncMock(return_value=object())
    client.get_video_detail = AsyncMock(return_value=None)
    downloader._download_with_retry = AsyncMock(return_value=False)
    downloader.database = AsyncMock()
    try:
        assert not await downloader._download_aweme(article(body))
        downloader.database.add_aweme.assert_not_awaited()
        assert not downloader.completed_manifest_records
        assert not list(tmp_path.rglob("*.html"))
        assert not downloader._is_locally_downloaded(ARTICLE_ID)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_profile_article_summary_fetches_full_body(tmp_path):
    downloader, client = _build_downloader(tmp_path)
    client.get_session = AsyncMock(return_value=object())
    client.get_video_detail = AsyncMock(return_value=article())
    try:
        summary = article("")
        assert await downloader._download_aweme_assets(summary, "测试作者", mode="post")
        client.get_video_detail.assert_awaited_once_with(ARTICLE_ID)
        assert list(tmp_path.rglob("*.html"))
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_incomplete_detail_cannot_downgrade_article_to_gallery(tmp_path):
    downloader, client = _build_downloader(tmp_path)
    client.get_session = AsyncMock(return_value=object())
    client.get_video_detail = AsyncMock(return_value={
        "aweme_id": ARTICLE_ID, "article_info": None,
        "images": [{"url_list": ["https://example.com/cover.jpg"]}],
    })
    downloader._download_with_retry = AsyncMock(return_value=True)
    try:
        assert not await downloader._download_aweme(article(""))
        downloader._download_with_retry.assert_not_awaited()
        assert not downloader.completed_manifest_records
    finally:
        await client.close()


def test_partial_article_images_do_not_count_as_a_completed_work(tmp_path):
    (tmp_path / f"{ARTICLE_ID}_article_1.jpg").write_bytes(b"partial")
    downloader, _ = _build_downloader(tmp_path)
    assert not downloader._is_locally_downloaded(ARTICLE_ID)
