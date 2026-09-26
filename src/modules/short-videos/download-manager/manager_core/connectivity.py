"""Read-only probes for the real Douyin API path used by downloads."""

from __future__ import annotations

from typing import Any

from .database import db
from .download_supervisor import download_manager


def select_detail_probe_target() -> dict[str, Any] | None:
    """Choose one real work without changing queue or failure state."""

    with db() as conn:
        row = conn.execute(
            """
            SELECT id, aweme_id, url, status
            FROM links
            WHERE LENGTH(TRIM(COALESCE(aweme_id, ''))) BETWEEN 8 AND 32
              AND TRIM(aweme_id) NOT GLOB '*[^0-9]*'
            ORDER BY
              CASE status
                WHEN 'pending' THEN 0
                WHEN 'failed' THEN 1
                WHEN 'downloaded' THEN 2
                ELSE 3
              END,
              id DESC
            LIMIT 1
            """
        ).fetchone()
    return dict(row) if row else None


def probe_download_api() -> dict[str, Any]:
    target = select_detail_probe_target()
    if target is None:
        return {
            "ok": False,
            "message": "数据库中没有可用于测试的作品 ID",
            "endpoint": "/aweme/v1/web/aweme/detail/",
        }

    result = download_manager.probe_aweme_detail(str(target["aweme_id"]))
    if not isinstance(result, dict):
        result = {"ok": False, "message": "接口测试返回格式无效"}
    return {
        **result,
        "endpoint": str(result.get("endpoint") or "/aweme/v1/web/aweme/detail/"),
        "target": {
            "link_id": int(target["id"]),
            "aweme_id": str(target["aweme_id"]),
            "status": str(target["status"] or ""),
            "url": str(target["url"] or ""),
        },
    }
