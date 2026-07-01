#!/usr/bin/env python3
"""Scan local TXT novels into FanHao's standalone novel SQLite database."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from novel_text_formatter import format_novel_text, is_chapter_title, read_text_file


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "novels.sqlite"
DEFAULT_ROOTS = [
    Path(r"C:\Users\17917\OneDrive\小说\情色"),
    Path(r"C:\Users\17917\OneDrive\小说\小说"),
]
MAX_CHAPTER_CHARS = 12000


@dataclass
class Chapter:
    index: int
    title: str
    content: str


@dataclass
class BookRecord:
    id: str
    title: str
    author: str
    category: str
    source_root: str
    source_path: str
    relative_path: str
    file_name: str
    size_bytes: int
    mtime_ms: int
    encoding: str
    char_count: int
    chapter_count: int
    first_chapter_id: str
    latest_chapter_id: str
    latest_chapter_title: str
    summary: str
    tags_json: str
    status: str
    error: str
    updated_at: str
    chapters: list[Chapter]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild data/novels.sqlite from local TXT files.")
    parser.add_argument("--root", action="append", dest="roots", help="TXT novel directory. Can be repeated.")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="Target SQLite database path.")
    parser.add_argument("--limit", type=int, default=0, help="Maximum TXT files to scan. 0 means all.")
    parser.add_argument("--dry-run", action="store_true", help="Parse and summarize without writing the database.")
    return parser.parse_args()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def stable_id(source_path: Path) -> str:
    text = str(source_path.resolve()).replace("\\", "/").lower()
    return hashlib.sha1(text.encode("utf-8", errors="ignore")).hexdigest()[:20]


def iter_txt_files(roots: Iterable[Path], limit: int = 0) -> list[tuple[Path, Path]]:
    files: list[tuple[Path, Path]] = []
    for root in roots:
        if not root.exists():
            print(f"[warn] root not found: {root}", file=sys.stderr)
            continue
        for path in root.rglob("*.txt"):
            if path.is_file():
                files.append((root, path))
    files.sort(key=lambda item: str(item[1]).lower())
    return files[:limit] if limit and limit > 0 else files


def clean_title(stem: str) -> str:
    title = re.sub(r"[_\-\s]*(?:fixed|format|formatted|utf8|utf-8|精校|校对版|完结)\s*$", "", stem, flags=re.I)
    title = re.sub(r"^[\[\(【（].{1,16}[\]\)】）]\s*", "", title)
    return html.unescape(title.strip(" -_　") or stem)


def detect_author(text: str, file_stem: str) -> str:
    for line in text.splitlines()[:120]:
        value = line.strip()
        match = re.match(r"^(?:作者|原作者|Author|writer)\s*[:：]\s*(.+)$", value, flags=re.I)
        if match:
            author = match.group(1).strip()
            if author and len(author) <= 80:
                return html.unescape(author)
    match = re.search(r"(?:作者|by)[:：\s]+([^_\-【】\[\]\(\)（）]{1,40})", file_stem, flags=re.I)
    return html.unescape(match.group(1).strip()) if match else ""


def category_for(root: Path, source_path: Path) -> str:
    try:
        relative = source_path.relative_to(root)
    except ValueError:
        return root.name or "全部"
    if len(relative.parts) > 1:
        return relative.parts[0]
    return root.name or "全部"


def paragraphs_from_text(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"\n\s*\n+", text) if part.strip()]


def summarize_text(text: str) -> str:
    parts = []
    for paragraph in paragraphs_from_text(text):
        if is_chapter_title(paragraph):
            continue
        if re.match(r"^(?:作者|书名|标题|来源|网址|链接)\s*[:：]", paragraph, flags=re.I):
            continue
        if re.search(r"(?:本作品来自互联网|内容版权归作者所有|更多好书|推广链接|https?://)", paragraph, flags=re.I):
            continue
        parts.append(paragraph)
        if sum(len(item) for item in parts) >= 260:
            break
    return html.unescape(re.sub(r"\s+", " ", "".join(parts)).strip())[:280]


def chunk_plain_text(text: str) -> list[Chapter]:
    paragraphs = paragraphs_from_text(text)
    chapters: list[Chapter] = []
    current: list[str] = []
    current_len = 0
    for paragraph in paragraphs:
        if current and current_len + len(paragraph) > MAX_CHAPTER_CHARS:
            index = len(chapters) + 1
            chapters.append(Chapter(index=index, title=f"正文 {index}", content="\n\n".join(current)))
            current = []
            current_len = 0
        current.append(paragraph)
        current_len += len(paragraph)
    if current:
        index = len(chapters) + 1
        title = "正文" if not chapters else f"正文 {index}"
        chapters.append(Chapter(index=index, title=title, content="\n\n".join(current)))
    return chapters


def split_chapters(text: str) -> list[Chapter]:
    paragraphs = paragraphs_from_text(text)
    chapters: list[Chapter] = []
    current_title = ""
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_title, current_lines
        if not current_title and not current_lines:
            return
        if not current_title:
            return
        content = "\n\n".join(line for line in current_lines if line.strip()).strip()
        if not content:
            content = current_title
        chapters.append(Chapter(index=len(chapters) + 1, title=current_title.strip(), content=content))
        current_title = ""
        current_lines = []

    for paragraph in paragraphs:
        if is_chapter_title(paragraph):
            flush()
            current_title = html.unescape(paragraph.strip())
            current_lines = []
            continue
        if current_title:
            current_lines.append(paragraph)

    flush()
    if chapters:
        return chapters
    return chunk_plain_text(text)


def build_book(root: Path, source_path: Path) -> BookRecord:
    stat = source_path.stat()
    source_path = source_path.resolve()
    root = root.resolve()
    book_id = stable_id(source_path)
    updated_at = now_iso()
    try:
        raw_text, encoding = read_text_file(source_path)
        formatted, _stats = format_novel_text(raw_text, indent=False, clean_junk=True)
        formatted = formatted.strip()
        chapters = split_chapters(formatted)
        title = clean_title(source_path.stem)
        author = detect_author(raw_text, source_path.stem)
        category = category_for(root, source_path)
        summary = summarize_text("\n\n".join(chapter.content for chapter in chapters[:2]) or formatted)
        first_id = f"{book_id}-{chapters[0].index:05d}" if chapters else ""
        latest_id = f"{book_id}-{chapters[-1].index:05d}" if chapters else ""
        latest_title = chapters[-1].title if chapters else ""
        tags = [item for item in [category, root.name] if item]
        return BookRecord(
            id=book_id,
            title=title,
            author=author,
            category=category,
            source_root=str(root),
            source_path=str(source_path),
            relative_path=str(source_path.relative_to(root)),
            file_name=source_path.name,
            size_bytes=stat.st_size,
            mtime_ms=int(stat.st_mtime * 1000),
            encoding=encoding,
            char_count=len(formatted),
            chapter_count=len(chapters),
            first_chapter_id=first_id,
            latest_chapter_id=latest_id,
            latest_chapter_title=latest_title,
            summary=summary,
            tags_json=json.dumps(tags, ensure_ascii=False),
            status="ok",
            error="",
            updated_at=updated_at,
            chapters=chapters,
        )
    except Exception as error:  # noqa: BLE001 - keep bad files visible in the library scan.
        category = category_for(root, source_path)
        return BookRecord(
            id=book_id,
            title=clean_title(source_path.stem),
            author="",
            category=category,
            source_root=str(root),
            source_path=str(source_path),
            relative_path=str(source_path.relative_to(root)),
            file_name=source_path.name,
            size_bytes=stat.st_size,
            mtime_ms=int(stat.st_mtime * 1000),
            encoding="",
            char_count=0,
            chapter_count=0,
            first_chapter_id="",
            latest_chapter_id="",
            latest_chapter_title="",
            summary="",
            tags_json=json.dumps([category], ensure_ascii=False),
            status="error",
            error=str(error)[:1000],
            updated_at=updated_at,
            chapters=[],
        )


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS novel_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS novel_books (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          author TEXT,
          category TEXT,
          source_root TEXT NOT NULL,
          source_path TEXT NOT NULL UNIQUE,
          relative_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          size_bytes INTEGER,
          mtime_ms INTEGER,
          encoding TEXT,
          char_count INTEGER,
          chapter_count INTEGER,
          first_chapter_id TEXT,
          latest_chapter_id TEXT,
          latest_chapter_title TEXT,
          summary TEXT,
          tags_json TEXT,
          status TEXT NOT NULL DEFAULT 'ok',
          error TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_novel_books_title ON novel_books(title);
        CREATE INDEX IF NOT EXISTS idx_novel_books_author ON novel_books(author);
        CREATE INDEX IF NOT EXISTS idx_novel_books_category ON novel_books(category);
        CREATE INDEX IF NOT EXISTS idx_novel_books_updated ON novel_books(updated_at);
        CREATE TABLE IF NOT EXISTS novel_chapters (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          chapter_index INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          char_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(book_id, chapter_index)
        );
        CREATE INDEX IF NOT EXISTS idx_novel_chapters_book ON novel_chapters(book_id, chapter_index);
        CREATE TABLE IF NOT EXISTS novel_reading_state (
          book_id TEXT PRIMARY KEY,
          chapter_id TEXT,
          chapter_index INTEGER,
          scroll_ratio REAL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        DROP TABLE IF EXISTS novel_search;
        CREATE VIRTUAL TABLE novel_search USING fts5(
          book_id UNINDEXED,
          chapter_id UNINDEXED,
          title,
          author,
          category,
          chapter_title,
          tokenize='trigram'
        );
        """
    )


def write_records(db_path: Path, roots: list[Path], records: list[BookRecord]) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        ensure_schema(conn)
        conn.execute("BEGIN")
        conn.execute("DELETE FROM novel_search")
        conn.execute("DELETE FROM novel_chapters")
        conn.execute("DELETE FROM novel_books")
        conn.executemany(
            """
            INSERT INTO novel_books (
              id, title, author, category, source_root, source_path, relative_path, file_name,
              size_bytes, mtime_ms, encoding, char_count, chapter_count, first_chapter_id,
              latest_chapter_id, latest_chapter_title, summary, tags_json, status, error, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    item.id,
                    item.title,
                    item.author,
                    item.category,
                    item.source_root,
                    item.source_path,
                    item.relative_path,
                    item.file_name,
                    item.size_bytes,
                    item.mtime_ms,
                    item.encoding,
                    item.char_count,
                    item.chapter_count,
                    item.first_chapter_id,
                    item.latest_chapter_id,
                    item.latest_chapter_title,
                    item.summary,
                    item.tags_json,
                    item.status,
                    item.error,
                    item.updated_at,
                )
                for item in records
            ],
        )
        chapter_rows = []
        search_rows = []
        for book in records:
            for chapter in book.chapters:
                chapter_id = f"{book.id}-{chapter.index:05d}"
                chapter_rows.append((chapter_id, book.id, chapter.index, chapter.title, chapter.content, len(chapter.content), book.updated_at))
                search_rows.append((book.id, chapter_id, book.title, book.author, book.category, chapter.title))
        conn.executemany(
            """
            INSERT INTO novel_chapters (id, book_id, chapter_index, title, content, char_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            chapter_rows,
        )
        conn.executemany(
            """
            INSERT INTO novel_search (book_id, chapter_id, title, author, category, chapter_title)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            search_rows,
        )
        conn.execute("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('schema_version', '1')")
        conn.execute("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('scanned_at', ?)", (now_iso(),))
        conn.execute("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('roots_json', ?)", (json.dumps([str(root.resolve()) for root in roots], ensure_ascii=False),))
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> int:
    args = parse_args()
    roots = [Path(item) for item in (args.roots or [str(root) for root in DEFAULT_ROOTS])]
    files = iter_txt_files(roots, args.limit)
    records: list[BookRecord] = []
    for index, (root, path) in enumerate(files, start=1):
        records.append(build_book(root, path))
        if index % 25 == 0:
            print(f"[scan] {index}/{len(files)}")

    ok_records = [item for item in records if item.status == "ok"]
    summary = {
        "ok": True,
        "dryRun": bool(args.dry_run),
        "db": str(Path(args.db)),
        "roots": [str(root) for root in roots],
        "files": len(files),
        "books": len(records),
        "parsed": len(ok_records),
        "errors": len(records) - len(ok_records),
        "chapters": sum(item.chapter_count for item in ok_records),
        "chars": sum(item.char_count for item in ok_records),
        "bytes": sum(item.size_bytes for item in records),
    }

    if not args.dry_run:
        write_records(Path(args.db), roots, records)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
