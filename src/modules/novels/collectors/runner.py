#!/usr/bin/env python3
"""Unified CLI and backend worker for FanHao novel collection."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from adapters import collect
from core import CollectionError, CollectorContext, json_event, safe_filename


BUILTIN_DIRECT_ADAPTERS = {
    "diyibanzhu": {
        "id": "diyibanzhu",
        "name": "第一版主",
        "driver": "diyibanzhu",
        "config": {"delayMs": 500, "timeoutMs": 30000, "maxChapters": 0, "useEnvProxy": False},
    },
    "cool18": {
        "id": "cool18",
        "name": "Cool18 帖子链",
        "driver": "cool18",
        "config": {"delayMs": 1000, "timeoutMs": 30000, "maxChapters": 30, "useEnvProxy": False},
    },
    "alicesw": {
        "id": "alicesw",
        "name": "爱丽丝书屋",
        "driver": "alicesw",
        "config": {"delayMs": 5000, "timeoutMs": 30000, "maxChapters": 0, "useEnvProxy": False},
    },
}


def main(argv: list[str] | None = None) -> None:
    configure_stdio()
    args = parse_args(argv)
    result_path = Path(args.result).resolve() if args.result else None
    try:
        payload = load_payload(args)
        output_dir = Path(args.output_dir or default_output_dir(payload)).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        if result_path is None:
            result_path = output_dir / "result.json"
        execute(payload, output_dir, result_path)
    except Exception as exc:
        error_payload = {
            "status": "failed",
            "error": str(exc) or exc.__class__.__name__,
            "errorType": exc.__class__.__name__,
        }
        if result_path:
            try:
                result_path.parent.mkdir(parents=True, exist_ok=True)
                write_json(result_path, error_payload)
            except Exception:
                pass
        emit("error", message=error_payload["error"])
        raise SystemExit(1) from exc


def execute(payload: dict[str, Any], output_dir: Path, result_path: Path) -> None:
    adapter = payload.get("adapter") or {}
    emit("status", message=f"正在启动适配器：{adapter.get('name') or adapter.get('id') or 'custom'}")
    context = CollectorContext(dict(adapter.get("config") or {}), emit)
    book = collect(payload, context)
    chapters = list(book.get("chapters") or [])
    if not chapters:
        raise CollectionError("采集器没有返回章节")
    output_path = output_dir / f"{safe_filename(book.get('title') or 'novel')}.txt"
    output_text = render_output_text(book, payload)
    output_path.write_text(output_text, encoding="utf-8", newline="\n")
    result = {
        "status": "ok",
        "taskId": str(payload.get("taskId") or ""),
        "adapterId": str(adapter.get("id") or ""),
        "adapterName": str(adapter.get("name") or ""),
        "book": {
            "title": str(book.get("title") or "网页小说"),
            "author": str(book.get("author") or ""),
            "category": str(book.get("category") or "网页采集"),
            "sourceUrl": str(book.get("sourceUrl") or payload.get("url") or ""),
            "chapters": chapters,
        },
        "outputPath": str(output_path),
        "report": book.get("report") if isinstance(book.get("report"), dict) else {},
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(result_path, result)
    emit(
        "complete",
        message=f"采集完成：{result['book']['title']}",
        chapters=len(chapters),
        outputPath=str(output_path),
    )


def render_output_text(book: dict[str, Any], payload: dict[str, Any]) -> str:
    title = str(book.get("title") or "网页小说").strip()
    author = str(book.get("author") or "").strip()
    source_url = str(book.get("sourceUrl") or payload.get("url") or "").strip()
    header = [title]
    if author:
        header.append(f"作者：{author}")
    if source_url:
        header.append(f"来源：{source_url}")
    header.append(f"整理时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    blocks = []
    for index, chapter in enumerate(book.get("chapters") or [], 1):
        chapter_title = str(chapter.get("title") or f"第 {index} 章").strip()
        content = str(chapter.get("content") or "").strip()
        if content:
            blocks.append(f"{chapter_title}\n\n{content}")
    text = "\n".join(header).strip() + "\n\n" + "\n\n".join(blocks).strip() + "\n"
    project_root = Path(str(payload.get("projectRoot") or Path(__file__).resolve().parents[4]))
    tools_dir = project_root / "tools"
    if tools_dir.is_dir() and str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))
    try:
        from novel_text_formatter import fix_novel_text

        return fix_novel_text(text, indent=True)
    except Exception as exc:
        emit("warning", message=f"TXT 格式化器不可用，已保留采集原文：{exc}")
        return text


def load_payload(args: argparse.Namespace) -> dict[str, Any]:
    if args.config:
        payload = read_json(Path(args.config))
        if not isinstance(payload, dict):
            raise CollectionError("任务配置必须是 JSON 对象")
        return payload
    if not args.url:
        raise CollectionError("需要提供网页 URL 或 --config")
    adapter_id = args.adapter if args.adapter != "auto" else adapter_for_url(args.url)
    if adapter_id == "generic":
        if not args.adapter_config:
            raise CollectionError("generic 适配器需要 --adapter-config JSON 文件")
        adapter_config = read_json(Path(args.adapter_config))
        if not isinstance(adapter_config, dict):
            raise CollectionError("自定义适配器配置必须是 JSON 对象")
        adapter = {
            "id": "cli-generic",
            "name": str(adapter_config.get("name") or "CLI 自定义适配器"),
            "driver": "generic",
            "config": adapter_config.get("config") if isinstance(adapter_config.get("config"), dict) else adapter_config,
        }
    else:
        adapter = json.loads(json.dumps(BUILTIN_DIRECT_ADAPTERS[adapter_id], ensure_ascii=False))
    if args.max_chapters is not None:
        adapter.setdefault("config", {})["maxChapters"] = max(0, args.max_chapters)
    if args.delay_ms is not None:
        adapter.setdefault("config", {})["delayMs"] = max(0, args.delay_ms)
    if args.timeout_ms is not None:
        adapter.setdefault("config", {})["timeoutMs"] = max(3000, args.timeout_ms)
    return {
        "taskId": "",
        "url": args.url,
        "mode": "test" if args.test else "collect",
        "adapter": adapter,
        "options": {},
        "projectRoot": str(Path(__file__).resolve().parents[4]),
    }


def adapter_for_url(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if host == "diyibanzhu.me" or host.endswith(".diyibanzhu.me"):
        return "diyibanzhu"
    if host == "cool18.com" or host.endswith(".cool18.com") or host == "6park.com" or host.endswith(".6park.com"):
        return "cool18"
    if host == "alicesw.com" or host.endswith(".alicesw.com"):
        return "alicesw"
    raise CollectionError("无法自动识别站点，请用 --adapter generic --adapter-config <json>")


def default_output_dir(payload: dict[str, Any]) -> str:
    project_root = Path(str(payload.get("projectRoot") or Path(__file__).resolve().parents[4]))
    return str(project_root / "logs" / "novels")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="统一小说采集器：支持内置站点和 CSS 选择器自定义适配器。"
    )
    parser.add_argument("url", nargs="?", help="直接运行时的目录页或起始页 URL")
    parser.add_argument("--config", help="后台任务 JSON 配置")
    parser.add_argument("--adapter", choices=["auto", "diyibanzhu", "cool18", "alicesw", "generic"], default="auto")
    parser.add_argument("--adapter-config", help="generic 适配器 JSON 文件")
    parser.add_argument("--output-dir", help="TXT 和诊断结果输出目录")
    parser.add_argument("--result", help="结构化 JSON 结果路径")
    parser.add_argument("--max-chapters", type=int)
    parser.add_argument("--delay-ms", type=int)
    parser.add_argument("--timeout-ms", type=int)
    parser.add_argument("--test", action="store_true", help="只采集第一章，用于验证适配")
    return parser.parse_args(argv)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CollectionError(f"JSON 文件不存在：{path}") from exc
    except json.JSONDecodeError as exc:
        raise CollectionError(f"JSON 格式错误：{path}；{exc}") from exc


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")


def emit(event: str, **payload: Any) -> None:
    print(json_event(event, **payload), flush=True)


def configure_stdio() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


if __name__ == "__main__":
    main()
