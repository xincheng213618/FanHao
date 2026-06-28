#!/usr/bin/env python3
"""Smoke tests for the TXT formatter used by the admin job runner."""

from pathlib import Path
from tempfile import TemporaryDirectory

from novel_text_formatter import fix_novel_file, format_novel_text, is_chapter_title


RAW = """测试书名
作者：匿名

第一章 初遇
这是第一段，
被错误折行了。
这是第二段。
【1】
本章未完，点击[数字分页]继续阅读-->>【2】【3】
第二章 继续
短句
继续这一句。
"""


def assert_true(value, message):
    if not value:
        raise AssertionError(message)


def main() -> None:
    formatted, stats = format_novel_text(RAW, indent=True)
    lines = formatted.splitlines()

    assert_true("数字分页" not in formatted, "pagination junk should be removed")
    assert_true("【1】" not in formatted, "page marker should be removed")
    assert_true(any(is_chapter_title(line) for line in lines), "chapter title should be detected")
    assert_true("　　这是第一段，被错误折行了。" in formatted, "wrapped paragraph should be joined and indented")
    assert_true(stats["chapters"] == 2, "chapter count should be 2")
    assert_true(stats["paragraphs"] >= 2, "paragraph count should be available")

    with TemporaryDirectory() as temp_dir:
        source = Path(temp_dir) / "sample.txt"
        source.write_text(RAW, encoding="utf-8")
        result = fix_novel_file(source, quiet=True)
        output = Path(result["output_path"])
        assert_true(output.exists(), "output file should exist")
        assert_true(output.read_text(encoding="utf-8") == formatted, "file output should match pure function")

    print("novel text formatter verification passed")


if __name__ == "__main__":
    main()
