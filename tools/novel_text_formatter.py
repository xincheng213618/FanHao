#!/usr/bin/env python3
"""Format Chinese novel-style TXT files into a readable standard layout.

The module is intentionally usable both from CLI scripts and from FanHao's
admin job runner. It normalizes encodings, removes common web-pagination junk,
joins wrapped lines into logical paragraphs, keeps chapter titles separated,
and writes UTF-8 text with LF newlines.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


READ_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "gbk", "big5")
FULLWIDTH_INDENT = "\u3000\u3000"

CHAPTER_RE = re.compile(
    r"^(?:第\s*[零〇一二两兩三四五六七八九十百千万\d]+\s*[章节回话卷部篇]|"
    r"[零〇一二两兩三四五六七八九十百千万\d]+\s*[、.．]\s*|"
    r"(?:序章|序|楔子|正文|尾声|后记|番外|外传|前传|间章|特别篇|大结局|全书完|全文完))",
    re.I,
)
STANDALONE_META_RE = re.compile(
    r"^(?:作者|原著|原作者|来源|整理|整理时间|整理自|书名|标题|发表于|发布于|"
    r"网址|链接|URL|From|Source)\s*[:：]",
    re.I,
)
SENTENCE_END_RE = re.compile(r"[。！？!?…」』”）】》]$")
OPENING_PUNCT_RE = re.compile(r"^[，,。！？!?、；;：:）】》」』”]")
ASCII_WRAP_RE = re.compile(r"[A-Za-z0-9]$")

PAGINATION_PATTERNS = [
    re.compile(r"本章未完，?\s*点击\s*\[?\s*数字分页\s*\]?\s*继续阅读.*?(?=\n|$)", re.I),
    re.compile(r"\[?\s*本章完\s*\]?", re.I),
    re.compile(r"^\s*(?:上一页|下一页|上一章|下一章|返回目录|章节目录|加入书签|投推荐票)\s*$", re.I),
    re.compile(r"^\s*(?:【\d+】\s*)+$"),
    re.compile(r"^\s*\d+\s*/\s*\d+\s*$"),
]


@dataclass
class FormatStats:
    input_path: str
    output_path: str
    used_encoding: str
    original_lines: int
    original_nonblank: int
    final_lines: int
    final_nonblank: int
    chapters: int
    paragraphs: int
    joined_blocks: int
    removed_noise_lines: int
    reduction_lines: int


def normalize_text(text: str) -> str:
    text = text.replace("\ufeff", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ").replace("\u200b", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip("\n")


def strip_known_junk(text: str) -> tuple[str, int]:
    removed = 0
    current = text
    for pattern in PAGINATION_PATTERNS[:2]:
        current, count = pattern.subn("", current)
        removed += count

    kept: list[str] = []
    for line in current.splitlines():
        raw = line.strip()
        if any(pattern.match(raw) for pattern in PAGINATION_PATTERNS[2:]):
            removed += 1
            continue
        kept.append(line)
    return "\n".join(kept), removed


def is_chapter_title(line: str) -> bool:
    value = line.strip()
    if not value:
        return False
    if len(value) > 80:
        return False
    return bool(CHAPTER_RE.match(value))


def is_standalone_meta(line: str) -> bool:
    value = line.strip()
    if not value:
        return False
    if STANDALONE_META_RE.match(value):
        return True
    if value.startswith(("http://", "https://")):
        return True
    if value.startswith("【") and "】" in value and len(value) <= 90:
        return True
    if re.match(r"^\d{4}[-./年]\d{1,2}", value):
        return True
    return False


def is_probable_heading(line: str) -> bool:
    value = line.strip()
    if not value or len(value) > 42:
        return False
    if is_chapter_title(value) or is_standalone_meta(value):
        return True
    return bool(re.match(r"^[一二三四五六七八九十\d]+[、.．]\s*\S+", value))


def body_start_index(lines: list[str]) -> int:
    for index, line in enumerate(lines):
        if is_chapter_title(line):
            return index
        if len(line) >= 28 and not is_standalone_meta(line):
            return index
    return len(lines)


def should_join(previous: str, current: str) -> bool:
    previous = previous.rstrip()
    current = current.lstrip()
    if not previous or not current:
        return False
    if is_probable_heading(current) or is_standalone_meta(current):
        return False
    if OPENING_PUNCT_RE.match(current):
        return True
    if SENTENCE_END_RE.search(previous):
        return False
    if previous.endswith(("，", "、", "；", "：", ",", ";", ":")):
        return True
    if ASCII_WRAP_RE.search(previous) and re.match(r"^[A-Za-z0-9]", current):
        return True
    return True


def emit_paragraph(output: list[str], parts: list[str], indent: bool) -> int:
    if not parts:
        return 0
    paragraph = "".join(part.strip() for part in parts).strip()
    parts.clear()
    if not paragraph:
        return 0
    if indent and not is_chapter_title(paragraph) and not is_standalone_meta(paragraph):
        paragraph = paragraph.lstrip("\u3000 ")
        paragraph = FULLWIDTH_INDENT + paragraph
    output.append(paragraph)
    output.append("")
    return 1


def format_novel_text(text: str, *, indent: bool = True, clean_junk: bool = True) -> tuple[str, dict[str, int]]:
    normalized = normalize_text(text)
    removed_noise = 0
    if clean_junk:
        normalized, removed_noise = strip_known_junk(normalized)

    non_empty = [line.strip() for line in normalized.splitlines() if line.strip()]
    if not non_empty:
        return "", {"chapters": 0, "paragraphs": 0, "joined_blocks": 0, "removed_noise_lines": removed_noise}

    output: list[str] = []
    current: list[str] = []
    chapters = 0
    paragraphs = 0
    joined_blocks = 0
    body_start = body_start_index(non_empty)

    for meta_line in non_empty[:body_start]:
        output.append(meta_line)
    if output:
        output.append("")

    for line in non_empty[body_start:]:
        if is_chapter_title(line):
            if len(current) > 1:
                joined_blocks += 1
            paragraphs += emit_paragraph(output, current, indent)
            if output and output[-1] != "":
                output.append("")
            output.append(line.strip())
            output.append("")
            chapters += 1
            continue

        if is_standalone_meta(line):
            if len(current) > 1:
                joined_blocks += 1
            paragraphs += emit_paragraph(output, current, indent)
            output.append(line.strip())
            output.append("")
            continue

        if not current:
            current.append(line)
            continue

        if should_join(current[-1], line):
            current.append(line)
        else:
            if len(current) > 1:
                joined_blocks += 1
            paragraphs += emit_paragraph(output, current, indent)
            current.append(line)

    if len(current) > 1:
        joined_blocks += 1
    paragraphs += emit_paragraph(output, current, indent)

    while output and output[-1] == "":
        output.pop()
    formatted = "\n\n".join(line for line in output if line != "")
    if formatted:
        formatted += "\n"
    return formatted, {
        "chapters": chapters,
        "paragraphs": paragraphs,
        "joined_blocks": joined_blocks,
        "removed_noise_lines": removed_noise,
    }


def fix_novel_text(text: str, indent: bool = True) -> str:
    formatted, _ = format_novel_text(text, indent=indent)
    return formatted


def read_text_file(path: Path) -> tuple[str, str]:
    for encoding in READ_ENCODINGS:
        try:
            return path.read_text(encoding=encoding), encoding
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace"), "utf-8-replace"


def default_output_path(input_path: Path, suffix: str) -> Path:
    return input_path.with_name(f"{input_path.stem}{suffix}{input_path.suffix or '.txt'}")


def fix_novel_file(
    input_path: str | Path,
    output_path: str | Path | None = None,
    inplace: bool = False,
    quiet: bool = False,
    indent: bool = True,
    clean_junk: bool = True,
    suffix: str = "_格式化",
) -> dict:
    source = Path(input_path).expanduser()
    if not source.is_file():
        raise FileNotFoundError(f"Input file not found: {source}")
    if source.suffix.lower() != ".txt":
        raise ValueError("Only .txt files are supported")

    raw_text, used_encoding = read_text_file(source)
    formatted, detail = format_novel_text(raw_text, indent=indent, clean_junk=clean_junk)

    if inplace:
        backup = source.with_suffix(source.suffix + ".bak")
        shutil.copy2(source, backup)
        target = source
    else:
        target = Path(output_path).expanduser() if output_path else default_output_path(source, suffix)
        target.parent.mkdir(parents=True, exist_ok=True)

    target.write_text(formatted, encoding="utf-8", newline="\n")

    original_lines = raw_text.count("\n") + (1 if raw_text else 0)
    final_lines = formatted.count("\n") + (1 if formatted else 0)
    stats = FormatStats(
        input_path=str(source),
        output_path=str(target),
        used_encoding=used_encoding,
        original_lines=original_lines,
        original_nonblank=sum(1 for line in raw_text.splitlines() if line.strip()),
        final_lines=final_lines,
        final_nonblank=sum(1 for line in formatted.splitlines() if line.strip()),
        chapters=detail["chapters"],
        paragraphs=detail["paragraphs"],
        joined_blocks=detail["joined_blocks"],
        removed_noise_lines=detail["removed_noise_lines"],
        reduction_lines=original_lines - final_lines,
    )

    result = asdict(stats)
    if not quiet:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="格式化中文小说/长文本 TXT 文档。")
    parser.add_argument("input", help="输入 .txt 文件路径")
    parser.add_argument("-o", "--output", help="输出路径；默认写到 <原名>_格式化.txt")
    parser.add_argument("--suffix", default="_格式化", help="默认输出文件后缀")
    parser.add_argument("--inplace", action="store_true", help="覆盖原文件，自动创建 .bak 备份")
    parser.add_argument("--no-indent", action="store_true", help="不添加中文段落首行缩进")
    parser.add_argument("--no-clean-junk", action="store_true", help="不清理常见分页/章节导航噪声")
    parser.add_argument("--quiet", "-q", action="store_true", help="只执行，不输出统计 JSON")
    return parser.parse_args(argv)


def configure_stdio() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def main(argv: Iterable[str] | None = None) -> None:
    configure_stdio()
    args = parse_args(argv)
    try:
        fix_novel_file(
            args.input,
            output_path=args.output,
            inplace=args.inplace,
            quiet=args.quiet,
            indent=not args.no_indent,
            clean_junk=not args.no_clean_junk,
            suffix=args.suffix,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
