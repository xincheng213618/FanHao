"""Probe saved site credentials through the same HTTP stack as collection tasks."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from adapters import collect_alicesw
from core import CollectionError, CollectorContext


ALICESW_ACCOUNT_URL = "https://www.alicesw.com/user/index.html"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cookie-file", required=True, type=Path)
    parser.add_argument("--url", default="")
    args = parser.parse_args()
    try:
        result = probe(args.cookie_file, args.url)
    except Exception as exc:
        result = {
            "ok": False,
            "message": "爱丽丝书屋 Cookie 检测失败",
            "error": str(exc) or exc.__class__.__name__,
        }
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)


def probe(cookie_file: Path, url: str) -> dict[str, Any]:
    context = CollectorContext(
        {
            "cookieFile": str(cookie_file.resolve()),
            "delayMs": 0,
            "timeoutMs": 30000,
            "useEnvProxy": False,
        },
        lambda *_args, **_kwargs: None,
    )
    try:
        response = context.session.get(ALICESW_ACCOUNT_URL, timeout=context.timeout)
        response.raise_for_status()
    except Exception as exc:
        raise CollectionError(f"登录状态请求失败：{exc}") from exc
    if "/user/user/login.html" in str(response.url).lower():
        return {
            "ok": False,
            "message": "Cookie 已失效或没有登录爱丽丝书屋",
            "error": "Cookie 已失效或没有登录爱丽丝书屋",
        }

    target = str(url or "").strip()
    if not target:
        return {
            "ok": True,
            "message": "爱丽丝书屋登录状态有效",
            "authenticated": True,
        }

    book = collect_alicesw(target, {"maxChapters": 1}, context)
    chapters = list(book.get("chapters") or [])
    first = chapters[0] if chapters else {}
    return {
        "ok": True,
        "message": "登录有效，目标正文页读取成功",
        "authenticated": True,
        "title": str(book.get("title") or ""),
        "chapterTitle": str(first.get("title") or ""),
        "chapterChars": len(str(first.get("content") or "")),
    }


if __name__ == "__main__":
    main()
