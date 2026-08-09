"""Internal maintenance responsibilities for the download manager."""

from __future__ import annotations

from typing import Any

from .common import normalize_int
from .config import GALLERY_MUSIC_INTENT
from .database import add_event, db
from .profiles_links import current_profile_id
from .queue import sync_download_queue
from .read_models import get_state


def reset_failed_links(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope") or "current").strip().lower()
    profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
    params: list[Any] = []
    where = "status='failed'"
    scope_label = "全部主页"

    if profile_id > 0:
        where += " AND profile_id=?"
        params.append(profile_id)
        scope_label = f"主页 #{profile_id}"
    elif scope not in {"all", "global"}:
        current_id = current_profile_id(create=False)
        if current_id is None:
            return {"ok": False, "message": "当前主页还没有入库"}
        where += " AND profile_id=?"
        params.append(current_id)
        scope_label = "当前主页"

    with db() as conn:
        cur = conn.execute(
            f"""
            UPDATE links
            SET status='pending',
                last_error=NULL,
                failed_at=NULL,
                last_started_at=NULL
            WHERE {where}
            """,
            params,
        )
        sync_download_queue(conn)
        changed = cur.rowcount if cur.rowcount is not None else 0
    add_event("info", f"{scope_label}失败链接已转为待下载：{changed} 条")
    return {"ok": True, "changed": changed, "scope": scope, "state": get_state()}


def retry_link(payload: dict[str, Any]) -> dict[str, Any]:
    """Move one failed link back to pending without touching sibling records."""
    link_id = normalize_int(payload.get("id", 0), 0, 0, 1000000000)
    if link_id <= 0:
        return {"ok": False, "message": "缺少有效的链接记录 ID"}
    with db() as conn:
        row = conn.execute(
            "SELECT id, aweme_id, profile_id, status FROM links WHERE id=?",
            (link_id,),
        ).fetchone()
        if row is None:
            return {"ok": False, "message": "这条数据库记录已经不存在"}
        if str(row["status"] or "") != "failed":
            return {"ok": False, "message": "只有失败记录可以重新加入下载队列"}
        conn.execute(
            """
            UPDATE links
            SET status='pending',
                last_error=NULL,
                failed_at=NULL,
                last_started_at=NULL
            WHERE id=?
            """,
            (link_id,),
        )
        sync_download_queue(conn)
    aweme_id = str(row["aweme_id"] or "")
    add_event("info", f"单条失败链接已转为待下载：{aweme_id or link_id}")
    return {
        "ok": True,
        "changed": 1,
        "id": link_id,
        "aweme_id": aweme_id,
        "profile_id": int(row["profile_id"] or 0),
        "status": "pending",
    }


def queue_gallery_music_backfill(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope") or "all").strip().lower()
    params: list[Any] = []
    where = """
      links.status='downloaded'
      AND (LOWER(COALESCE(links.media_type, ''))='gallery' OR LOWER(COALESCE(links.kind, ''))='note')
      AND COALESCE(links.gallery_music_status, '') NOT IN ('downloaded', 'unavailable')
      AND COALESCE(NULLIF(TRIM(links.local_music_path), ''), '') = ''
      AND COALESCE(links.local_file_names, '') NOT LIKE '%_music.%'
      AND COALESCE(links.local_file_paths, '') NOT LIKE '%_music.%'
      AND NOT EXISTS (
        SELECT 1 FROM links AS music_copy
        WHERE music_copy.aweme_id=links.aweme_id
          AND (
            COALESCE(NULLIF(TRIM(music_copy.local_music_path), ''), '') <> ''
            OR COALESCE(music_copy.local_file_names, '') LIKE '%_music.%'
            OR COALESCE(music_copy.local_file_paths, '') LIKE '%_music.%'
            OR COALESCE(music_copy.gallery_music_status, '') IN ('downloaded', 'unavailable')
          )
      )
    """
    scope_label = "全部主页"
    if scope not in {"all", "global"}:
        profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
        if profile_id <= 0:
            profile_id = current_profile_id(create=False) or 0
        if profile_id <= 0:
            return {"ok": False, "message": "当前主页还没有入库"}
        where += " AND links.profile_id=?"
        params.append(profile_id)
        scope_label = f"主页 #{profile_id}"

    with db() as conn:
        candidates = conn.execute(
            f"SELECT MIN(links.id) AS id FROM links WHERE {where} GROUP BY links.aweme_id ORDER BY MIN(links.id)",
            params,
        ).fetchall()
        ids = [int(row["id"]) for row in candidates]
        dry_run = str(payload.get("dry_run") or "").strip().lower() in {"1", "true", "yes", "on"}
        if ids and not dry_run:
            placeholders = ",".join("?" for _ in ids)
            conn.execute(
                f"""
                UPDATE links SET
                  status='pending',
                  download_intent=?,
                  gallery_music_status='pending',
                  gallery_music_checked_at=NULL,
                  failed_at=NULL,
                  last_error='等待重新下载图集并补齐背景音乐'
                WHERE id IN ({placeholders})
                """,
                [GALLERY_MUSIC_INTENT, *ids],
            )
            sync_download_queue(conn)
    changed = 0 if dry_run else len(ids)
    if dry_run:
        return {"ok": True, "eligible": len(ids), "changed": 0, "scope": scope}
    add_event("info", f"{scope_label}图集音乐补齐任务已加入队列：{changed} 条")
    return {"ok": True, "eligible": len(ids), "changed": changed, "scope": scope, "state": get_state()}


EMPTY_FAILED_LINK_SQL = """
status='failed'
AND COALESCE(NULLIF(TRIM(desc), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_nickname), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_uid), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_sec_uid), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_avatar_url), ''), '') = ''
AND COALESCE(NULLIF(TRIM(author_url), ''), '') = ''
AND COALESCE(NULLIF(TRIM(cover_url), ''), '') = ''
AND COALESCE(NULLIF(TRIM(local_cover_path), ''), '') = ''
AND COALESCE(NULLIF(TRIM(preview_path), ''), '') = ''
AND COALESCE(NULLIF(TRIM(local_file_names), ''), '') = ''
AND COALESCE(NULLIF(TRIM(local_file_paths), ''), '') = ''
AND COALESCE(NULLIF(TRIM(metadata_json), ''), '{}') = '{}'
"""


def delete_empty_failed_links(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope") or "current").strip().lower()
    params: list[Any] = []
    where = EMPTY_FAILED_LINK_SQL
    scope_label = "全部主页"
    if scope not in {"all", "global"}:
        profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
        if profile_id <= 0:
            profile_id = current_profile_id(create=False) or 0
        if profile_id <= 0:
            return {"ok": False, "message": "当前主页还没有入库"}
        where += " AND profile_id=?"
        params.append(profile_id)
        scope_label = f"主页 #{profile_id}"
    with db() as conn:
        before = int(conn.execute(f"SELECT COUNT(*) c FROM links WHERE {where}", params).fetchone()["c"])
        cur = conn.execute(f"DELETE FROM links WHERE {where}", params)
        sync_download_queue(conn)
    changed = cur.rowcount if cur.rowcount is not None else before
    add_event("info", f"{scope_label}空壳失败链接已删除：{changed} 条")
    return {"ok": True, "changed": changed, "scope": scope, "state": get_state()}


def delete_failed_links(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope") or "all").strip().lower()
    if scope not in {"all", "global", "current", "profile"}:
        return {"ok": False, "message": "删除范围只能是 all/global/current/profile"}
    params: list[Any] = []
    where = "status='failed'"
    scope_label = "全部主页"
    if scope not in {"all", "global"}:
        profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
        if profile_id <= 0:
            profile_id = current_profile_id(create=False) or 0
        if profile_id <= 0:
            return {"ok": False, "message": "当前主页还没有入库"}
        where += " AND profile_id=?"
        params.append(profile_id)
        scope_label = f"主页 #{profile_id}"
    with db() as conn:
        before = int(conn.execute(f"SELECT COUNT(*) c FROM links WHERE {where}", params).fetchone()["c"])
        cur = conn.execute(f"DELETE FROM links WHERE {where}", params)
        sync_download_queue(conn)
    changed = cur.rowcount if cur.rowcount is not None else before
    add_event("warn", f"{scope_label}失败链接已删除：{changed} 条")
    return {"ok": True, "changed": changed, "scope": scope, "state": get_state()}


def delete_link(payload: dict[str, Any]) -> dict[str, Any]:
    link_id = normalize_int(payload.get("id", 0), 0, 0, 1000000000)
    if link_id <= 0:
        return {"ok": False, "message": "缺少有效的链接记录 ID"}
    with db() as conn:
        row = conn.execute(
            "SELECT id, aweme_id FROM links WHERE id=?",
            (link_id,),
        ).fetchone()
        if row is None:
            return {"ok": False, "message": "这条数据库记录已经不存在"}
        cur = conn.execute("DELETE FROM links WHERE id=?", (link_id,))
        sync_download_queue(conn)
    changed = cur.rowcount if cur.rowcount is not None else 1
    aweme_id = str(row["aweme_id"] or "")
    add_event("warn", f"单条数据库链接已删除：{aweme_id or link_id}")
    return {
        "ok": True,
        "changed": changed,
        "id": link_id,
        "aweme_id": aweme_id,
        "state": get_state(),
    }


def delete_profile(payload: dict[str, Any]) -> dict[str, Any]:
    profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
    if profile_id <= 0:
        return {"ok": False, "message": "缺少有效的主页记录 ID"}

    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        profile = conn.execute(
            "SELECT id, url, sec_uid, tab, nickname, title FROM profiles WHERE id=?",
            (profile_id,),
        ).fetchone()
        if profile is None:
            return {"ok": False, "message": "这个主页记录已经不存在"}

        running_job = conn.execute(
            "SELECT id FROM jobs WHERE profile_id=? AND status='running' LIMIT 1",
            (profile_id,),
        ).fetchone()
        if running_job is not None:
            return {
                "ok": False,
                "message": f"主页正在执行任务 #{running_job['id']}，请先停止任务再删除",
            }

        downloading = int(
            conn.execute(
                "SELECT COUNT(*) c FROM links WHERE profile_id=? AND status='downloading'",
                (profile_id,),
            ).fetchone()["c"]
        )
        if downloading > 0:
            return {
                "ok": False,
                "message": f"主页还有 {downloading} 条正在下载，请停止下载后再删除",
            }

        link_count = int(
            conn.execute("SELECT COUNT(*) c FROM links WHERE profile_id=?", (profile_id,)).fetchone()["c"]
        )
        file_count = int(
            conn.execute(
                """
                SELECT COUNT(*) c
                FROM link_files
                WHERE profile_id=?
                   OR link_id IN (SELECT id FROM links WHERE profile_id=?)
                """,
                (profile_id, profile_id),
            ).fetchone()["c"]
        )
        audit_count = int(
            conn.execute(
                """
                SELECT COUNT(*) c
                FROM video_quality_audit_items
                WHERE profile_id=?
                   OR link_id IN (SELECT id FROM links WHERE profile_id=?)
                """,
                (profile_id, profile_id),
            ).fetchone()["c"]
        )

        conn.execute(
            """
            DELETE FROM video_quality_audit_items
            WHERE profile_id=?
               OR link_id IN (SELECT id FROM links WHERE profile_id=?)
            """,
            (profile_id, profile_id),
        )
        conn.execute("DELETE FROM links WHERE profile_id=?", (profile_id,))
        conn.execute("UPDATE jobs SET profile_id=NULL WHERE profile_id=?", (profile_id,))

        current_url_row = conn.execute("SELECT value FROM settings WHERE key='profile_url'").fetchone()
        current_url = str(current_url_row["value"] or "") if current_url_row else ""
        if current_url == str(profile["url"] or ""):
            fallback = conn.execute(
                """
                SELECT url
                FROM profiles
                WHERE sec_uid=? AND id<>?
                ORDER BY CASE WHEN tab='post' THEN 0 ELSE 1 END, id
                LIMIT 1
                """,
                (str(profile["sec_uid"] or ""), profile_id),
            ).fetchone()
            conn.execute(
                "UPDATE settings SET value=? WHERE key='profile_url'",
                (str(fallback["url"] or "") if fallback else "",),
            )

        conn.execute("DELETE FROM profiles WHERE id=?", (profile_id,))
        sync_download_queue(conn)

    name = str(profile["nickname"] or profile["title"] or f"主页 #{profile_id}")
    add_event("warn", f"主页记录已删除：{name}（#{profile_id}），数据库链接 {link_count} 条")
    return {
        "ok": True,
        "profile_id": profile_id,
        "name": name,
        "links_deleted": link_count,
        "file_records_deleted": file_count,
        "audit_records_deleted": audit_count,
        "disk_files_deleted": False,
        "state": get_state(),
    }
