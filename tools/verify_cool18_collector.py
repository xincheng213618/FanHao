"""Offline regressions for Cool18 metadata, body scope and chapter assembly."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/modules/novels/collectors"))

from bs4 import BeautifulSoup
from adapters import collect_cool18
from cool18_parser import build_chapters, chapter_heading, extract_post, title_metadata
from core import Chapter, CollectionError, CollectorContext, ReportingRetry


TITLE = "【旅途】（０１－０４完）作 者：测试作者"
URL = "https://www.cool18.com/bbs4/index.php?app=forum&act=threadview&tid=1"


def page(body, title=TITLE):
    return f'''<main class="main-content">
      <div class="title-section"><h1 class="main-title">{title}</h1>
        <div class="sender">搬运者 [勋章] 于 2026-01-01 已读100次</div>
        <button>大字阅读</button><span>繁体</span></div>
      <div class="post-content"><div id="content-section"><pre>{body}</pre>
        <div class="ai-detection-feedback">AI检测</div></div>
        <div class="view_tools_box">投票</div></div>
      <div class="bottom-nav">所有跟帖 联系我们</div></main>'''


class Cool18Tests(unittest.TestCase):
    def test_retry_events_are_reported(self):
        events = []
        retry = ReportingRetry(
            total=3,
            connect=3,
            read=3,
            retry_total=3,
            retry_reporter=lambda attempt, total, reason: events.append((attempt, total, reason)),
        )
        retry.increment(method="GET", url="/fixture", error=Exception("fixture failure"))
        self.assertEqual(events, [(1, 3, "Exception")])

    def test_title_author_and_fullwidth_range(self):
        self.assertEqual(title_metadata(TITLE + " - 禁忌书屋 cool18"), ("旅途", "测试作者"))
        self.assertEqual(title_metadata("旅途（21.2完）作者：测试作者"), ("旅途", "测试作者"))

    def test_body_scope_metadata_and_attachments(self):
        content, author = extract_post(BeautifulSoup(page('''【旅途】 第一章
作者：测试作者
2026/06/30发表于：站点
是否首发：是
是否AI辅助：是（10%）
字数：1,234 字
<a href="?act=threadview&tid=2">下一章</a>
序
这是作者写的序言。
第一章：启程
路旁的广告写着欢迎来到留园。
[attach]12345[/attach]
我说：“字数：不是这里要删除的正文。”'''), "html.parser"), TITLE, "旅途")
        self.assertEqual(author, "测试作者")
        self.assertEqual(content, "序\n\n这是作者写的序言。\n\n第一章：启程\n\n路旁的广告写着欢迎来到留园。\n\n我说：“字数：不是这里要删除的正文。”")

    def test_no_outer_container_fallback(self):
        with self.assertRaises(CollectionError):
            extract_post(BeautifulSoup('<div class="main-content">只有论坛界面</div>', "html.parser"), TITLE, "旅途")

    def test_split_combined_posts_and_merge_continuation(self):
        posts = [
            Chapter(TITLE, URL, "序\n\n序言。\n\n第一章：启程\n\n第一段。", 1),
            Chapter("【旅途】（2-3）作者：测试作者", URL + "2", "第二章 到站\n\n第二段。\n\n第三章 歇息\n\n第三段。", 2),
            Chapter("【旅途】（4.1）", URL + "3", "第四章 回家\n\n第四段上。", 3),
            Chapter("【旅途】（4.2完）", URL + "4", "第四段下。", 4),
        ]
        chapters = build_chapters(list(reversed(posts)))
        self.assertEqual([c.title for c in chapters], ["第一章 启程", "第二章 到站", "第三章 歇息", "第四章 回家"])
        self.assertEqual([c.order for c in chapters], [1, 2, 3, 4])
        self.assertEqual(chapters[0].content, "序\n\n序言。\n\n第一段。")
        self.assertEqual(chapters[-1].content, "第四段上。\n\n第四段下。")

    def test_continuation_must_be_adjacent(self):
        chapters = build_chapters([
            Chapter("【旅途】（4.1）", URL, "第四章 回家\n\n上部。", 1),
            Chapter("【旅途】（4.3）", URL + "3", "中间缺了一部分。", 2),
        ])
        self.assertEqual(len(chapters), 2)
        self.assertIn("第3部分", chapters[1].title)

    def test_repeated_heading_on_continuation(self):
        chapters = build_chapters([
            Chapter("【旅途】（4.1）", URL, "第四章 回家\n\n上部。", 1),
            Chapter("【旅途】（4.2）", URL + "2", "第四章 回家\n\n下部。", 2),
        ])
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0].content, "上部。\n\n下部。")

    def test_narrative_is_not_a_heading(self):
        self.assertIsNone(chapter_heading("第二章里发生过的事情，他还记得。"))
        self.assertEqual(chapter_heading("第二十一章：归途（大结局）"), (21, "第二十一章 归途（大结局）"))

    def test_checkpoint_version_and_resume(self):
        with tempfile.TemporaryDirectory(prefix="fanhao-cool18-") as directory:
            checkpoint = Path(directory) / "checkpoint.json"
            identity = {"sourceUrl": URL, "adapterId": "cool18", "mode": "collect"}
            events = []
            context = CollectorContext({"delayMs": 0}, lambda event, **data: events.append((event, data)), checkpoint_path=checkpoint, checkpoint_identity=identity)
            context.save_chapter(Chapter(TITLE, URL, "旧版脏内容"), metadata={"seriesTitle": TITLE, "author": "错误发帖人"})
            fetches = []
            def fetch(url):
                fetches.append(url)
                return page("第一章 启程\n\n新的正文。")
            context.fetch = fetch
            book = collect_cool18(URL, {"maxChapters": 0}, context)
            self.assertEqual(fetches, [URL], "old parser checkpoint must be fetched again")
            self.assertEqual((book["title"], book["author"]), ("旅途", "测试作者"))
            self.assertEqual(book["chapters"][0]["title"], "第一章 启程")
            self.assertEqual(book["chapters"][0]["content"], "新的正文。")
            resumed = CollectorContext({"delayMs": 0}, lambda *args, **kwargs: None, checkpoint_path=checkpoint, checkpoint_identity=identity)
            resumed.fetch = lambda url: self.fail("current parser checkpoint should not refetch")
            self.assertEqual(collect_cool18(URL, {"maxChapters": 0}, resumed), book)

    def test_sender_is_not_the_author(self):
        context = CollectorContext({"delayMs": 0}, lambda *args, **kwargs: None)
        context.fetch = lambda url: page("第一章 启程\n\n正文。", "【旅途】（1）")
        book = collect_cool18(URL, {}, context)
        self.assertEqual(book["author"], "")


if __name__ == "__main__":
    unittest.main()
