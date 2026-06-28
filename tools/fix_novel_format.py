#!/usr/bin/env python3
"""Compatibility wrapper for older novel downloader scripts."""

from novel_text_formatter import (
    fix_novel_file,
    fix_novel_text,
    format_novel_text,
    is_chapter_title,
    is_standalone_meta,
    main,
)


if __name__ == "__main__":
    main()
