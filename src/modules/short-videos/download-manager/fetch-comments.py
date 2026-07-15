from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Dict, List


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch Douyin comments through the configured downloader client.")
    parser.add_argument("--downloader-root", required=True)
    parser.add_argument("--cookie-json", required=True)
    parser.add_argument("--aweme-id", required=True)
    parser.add_argument("--max-comments", type=int, default=100)
    parser.add_argument("--include-replies", action="store_true")
    return parser.parse_args()


async def fetch_comments(args: argparse.Namespace) -> Dict[str, Any]:
    downloader_root = Path(args.downloader_root).resolve()
    sys.path.insert(0, str(downloader_root))
    from core.api_client import DouyinAPIClient

    cookies = json.loads(Path(args.cookie_json).read_text(encoding="utf-8"))
    limit = max(1, min(500, int(args.max_comments or 100)))
    comments: List[Dict[str, Any]] = []
    cursor = 0
    available_total = 0
    seen_ids = set()

    async with DouyinAPIClient(cookies) as client:
        while len(comments) < limit:
            page = await client.get_aweme_comments(
                args.aweme_id,
                cursor=cursor,
                count=min(20, limit - len(comments)),
                include_replies=bool(args.include_replies),
            )
            items = page.get("items") or []
            if not items:
                break
            for item in items:
                if not isinstance(item, dict):
                    continue
                cid = str(item.get("cid") or item.get("comment_id") or "")
                if cid and cid in seen_ids:
                    continue
                if cid:
                    seen_ids.add(cid)
                comments.append(item)
                available_total = max(available_total, int(item.get("item_comment_total") or 0))
                if len(comments) >= limit:
                    break
            if not page.get("has_more"):
                break
            next_cursor = int(page.get("max_cursor") or 0)
            if next_cursor == cursor:
                break
            cursor = next_cursor
            await asyncio.sleep(0.08)

    return {
        "ok": True,
        "aweme_id": args.aweme_id,
        "count": len(comments),
        "available_total": available_total,
        "comments": comments,
    }


def main() -> None:
    args = parse_args()
    payload = asyncio.run(fetch_comments(args))
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
