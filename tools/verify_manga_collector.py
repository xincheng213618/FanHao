import importlib.util
import json
import sqlite3
import sys
import tempfile
from pathlib import Path


COLLECTOR_PATH = Path(__file__).with_name("manga_collector.py")
SPEC = importlib.util.spec_from_file_location("fanhao_manga_collector", COLLECTOR_PATH)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collector
SPEC.loader.exec_module(collector)


SMTT6 = """
<title>《秘密教学》未删减全集在线阅读</title>
<meta name="description" content="《秘密教学》在线阅读，剧情介绍：作品简介" />
<div class="hl-dc-pic"><span data-original="https://img.example/cover.webp"></span></div>
<em>状态：</em><span>连载中</span>
<em>TAG：</em><a>韩漫</a></li>
<em>作者：</em><a>作者甲</a>
"""

metadata = collector.extract_catalog_metadata(SMTT6, "https://smtt6.com/man-hua-yue-du/1.html", "秘密教学")
assert metadata["author"] == "作者甲"
assert metadata["description"] == "作品简介"
assert metadata["status"] == "连载中"
assert metadata["region"] == "韩国"
assert metadata["cover_url"] == "https://img.example/cover.webp"
assert collector.comic_id_from_url("https://www.55comic.com/book/3980") == "3980"
assert collector.catalog_url_for("https://www.55comic.com/book/3980", "3980") == "https://www.55comic.com/book/3980"
assert collector.comic_id_from_url("https://91jmd.com/manga/52655") == "52655"
assert collector.catalog_url_for("https://91jmd.com/manga/52655", "52655") == "https://91jmd.com/manga/52655"
assert collector.default_out_dir_for("https://91jmd.com/manga/52655", "52655") == "jmd9_cache_52655"
assert collector.clean_catalog_title(
    "《恋爱版本更新中》未删减版全集免費在线阅读 - 禁漫岛 - 韩漫日漫3D漫画的禁漫天堂",
    "52655",
) == "恋爱版本更新中"
assert collector.is_chapter_url(
    "https://91jmd.com/manga/52655",
    "https://91jmd.com/manga/52655/ODEpClHJlVquLuaVBcwr",
    "52655",
)
assert collector.is_chapter_url(
    "https://www.55comic.com/book/3980",
    "https://www.55comic.com/free-chapter/15625?t=20260415",
    "3980",
)
assert collector.chapter_identity(
    "https://www.55comic.com/free-chapter/15625?t=20260415"
) == collector.chapter_identity(
    "https://www.55comic.com/free-chapter/15625?t=20260829"
)
assert collector.chapter_identity(
    "https://jmd9.com/manga/52622/chapter-one"
) == collector.chapter_identity(
    "https://www.91jmd.com/manga/52622/chapter-one?from=alias"
)

with tempfile.TemporaryDirectory(prefix="fanhao-manga-meta-") as temporary:
    root = Path(temporary)
    collector.write_catalog_meta(root, metadata["url"], metadata["title"], metadata)
    saved = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
    assert saved["author"] == "作者甲"
    assert saved["cover_url"].endswith("cover.webp")

with tempfile.TemporaryDirectory(prefix="fanhao-manga-update-") as temporary:
    root = Path(temporary)
    old_chapter_dir = root / "chapters" / "001_15625"
    old_chapter_dir.mkdir(parents=True)
    (old_chapter_dir / "page.html").write_text("cached", encoding="utf-8")
    cached = collector.ChapterRecord(
        index=1,
        url="https://www.55comic.com/free-chapter/15625?t=20260415",
        slug="15625",
        title="第1話",
        html_path="chapters/001_15625/page.html",
        image_count=2,
        downloaded_count=2,
        status="done",
    )
    reused = collector.completed_chapter_from_cache(
        root / "chapters" / "007_15625",
        root,
        chapter_index=7,
        chapter_url="https://www.55comic.com/free-chapter/15625?t=20260829",
        slug="15625",
        title_hint="第1話",
        existing_record=cached,
        skip_completed=True,
        overwrite=False,
    )
    assert reused is not None
    assert reused.index == 7
    assert reused.html_path == "chapters/001_15625/page.html"

with tempfile.TemporaryDirectory(prefix="fanhao-manga-incremental-") as temporary:
    library_root = Path(temporary)
    cache_root = library_root / "55comic_cache_3980"
    chapter_root = cache_root / "chapters" / "001_15625"
    chapter_root.mkdir(parents=True)
    (chapter_root / "page.html").write_text("cached", encoding="utf-8")
    cached = collector.ChapterRecord(
        index=1,
        url="https://www.55comic.com/free-chapter/15625?t=20260415",
        slug="15625",
        title="第1話",
        html_path="chapters/001_15625/page.html",
        image_count=2,
        downloaded_count=2,
        status="done",
    )
    collector.write_manifests([cached], cache_root)
    catalog_url = "https://www.55comic.com/book/3980"
    catalog_html = """
    <title>测试漫画 - 污污漫畫</title>
    <a href="/free-chapter/15625?t=20260829" title="第1話"></a>
    """
    requests = []
    original_fetch_bytes = collector.fetch_bytes

    def fake_fetch_bytes(url, **_kwargs):
        requests.append(url)
        if url != catalog_url:
            raise AssertionError(f"incremental update fetched cached chapter: {url}")
        return catalog_html.encode("utf-8"), url, "text/html", {
            "content-type": "text/html; charset=utf-8"
        }

    collector.fetch_bytes = fake_fetch_bytes
    try:
        args = collector.build_parser().parse_args(
            [
                catalog_url,
                "--out",
                str(cache_root),
                "--database",
                str(library_root / "manga.sqlite"),
                "--no-record-source",
                "--no-robots",
            ]
        )
        assert collector.crawl(args) == 0
    finally:
        collector.fetch_bytes = original_fetch_bytes
    assert requests == [catalog_url]

with tempfile.TemporaryDirectory(prefix="fanhao-manga-pending-catalog-") as temporary:
    library_root = Path(temporary)
    cache_root = library_root / "smtt6_cache_42"
    database_path = library_root / "manga.sqlite"
    catalog_url = "https://smtt6.com/man-hua-yue-du/42.html"
    chapter_urls = [
        "https://smtt6.com/man-hua-yue-du/42/chapter-a.html",
        "https://smtt6.com/man-hua-yue-du/42/chapter-b.html",
    ]
    catalog_html = f"""
    <title>《目录先行测试》未删减全集在线阅读</title>
    <a href="{chapter_urls[0]}" title="目录先行测试-第1话"></a>
    <a href="{chapter_urls[1]}" title="目录先行测试-第2话"></a>
    """
    original_fetch_bytes = collector.fetch_bytes
    published = [False]

    def fake_pending_fetch(url, **_kwargs):
        if url == catalog_url:
            return catalog_html.encode("utf-8"), url, "text/html", {
                "content-type": "text/html; charset=utf-8"
            }
        assert url in chapter_urls
        if not published[0]:
            manifest = json.loads((cache_root / "manifest.json").read_text(encoding="utf-8"))
            assert len(manifest["chapters"]) == 2
            assert {item["status"] for item in manifest["chapters"]} == {"pending"}
            database = sqlite3.connect(database_path)
            try:
                counts = database.execute(
                    "SELECT chapter_count, done_chapter_count FROM manga_comics"
                ).fetchone()
            finally:
                database.close()
            assert counts == (2, 0)
            published[0] = True
        return b"<title>Test chapter</title>", url, "text/html", {
            "content-type": "text/html; charset=utf-8"
        }

    collector.fetch_bytes = fake_pending_fetch
    try:
        args = collector.build_parser().parse_args(
            [
                catalog_url,
                "--out",
                str(cache_root),
                "--database",
                str(database_path),
                "--no-record-source",
                "--no-robots",
                "--delay",
                "0",
            ]
        )
        assert collector.crawl(args) == 0
    finally:
        collector.fetch_bytes = original_fetch_bytes
    assert published[0]

print("Manga collector verification passed.")
