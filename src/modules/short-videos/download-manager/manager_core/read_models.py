"""Internal read models responsibilities for the download manager."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import download_supervisor, extraction
from .auth import cookie_auth_status
from .common import first_text, normalize_int
from .config import BASE_DIR, DB_PATH, DEFAULT_OUTPUT_DIR, FROZEN_BUILD, LIBRARY_SEC_UID, LOG_DIR
from .database import db
from .domain_manifest import profile_output_dir
from .profiles_links import current_profile_id
from .queue import link_stats, list_download_queue


def get_state() -> dict[str, Any]:
    profile_id = current_profile_id(create=False)
    with db() as conn:
        stats = link_stats(conn, profile_id)
        settings = {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM settings")}
        profiles = [
            dict(row)
            for row in conn.execute(
                """
                SELECT
                  profiles.id,
                  profiles.url,
                  profiles.title,
                  profiles.created_at,
                  profiles.updated_at,
                  profiles.last_extracted_at,
                  profiles.sec_uid,
                  profiles.tab,
                  profiles.uid,
                  profiles.nickname,
                  profiles.avatar_url,
                  profiles.unique_id,
                  profiles.short_id,
                  profiles.signature,
                  profiles.ip_location,
                  profiles.following_count,
                  profiles.follower_count,
                  profiles.total_favorited,
                  profiles.aweme_count,
                  profiles.has_deleted_works,
                  profiles.favoriting_count,
                  profiles.gender,
                  profiles.age,
                  profiles.verification,
                  profiles.profile_collected_at,
                  profiles.is_following,
                  profiles.following_discovered_at,
                  COUNT(links.id) total,
                  SUM(CASE WHEN links.status='pending' THEN 1 ELSE 0 END) pending,
                  SUM(CASE WHEN links.status='downloading' THEN 1 ELSE 0 END) downloading,
                  SUM(CASE WHEN links.status='downloaded' THEN 1 ELSE 0 END) downloaded,
                  SUM(CASE WHEN links.status='failed' THEN 1 ELSE 0 END) failed,
                  MAX(links.create_time) latest_work_create_time
                FROM profiles
                LEFT JOIN links ON links.profile_id=profiles.id
                WHERE EXISTS (SELECT 1 FROM links state_links WHERE state_links.profile_id=profiles.id)
                   OR (profiles.sec_uid=? AND profiles.tab='like')
                GROUP BY profiles.id
                ORDER BY profiles.updated_at DESC
                """
                ,
                (LIBRARY_SEC_UID,),
            ).fetchall()
        ]
        for profile in profiles:
            profile["is_self"] = int(
                first_text(profile.get("sec_uid")) == LIBRARY_SEC_UID
                and str(profile.get("tab") or "post") == "like"
            )
        current_profile = None
        if profile_id is not None:
            row = conn.execute("SELECT * FROM profiles WHERE id=?", (profile_id,)).fetchone()
            current_profile = dict(row) if row else None
        jobs = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM jobs ORDER BY id DESC LIMIT 8"
            ).fetchall()
        ]
        download_queue = list_download_queue(conn)
        events = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT 20"
            ).fetchall()
        ]
    return {
        "app": {
            "desktop": False,
            "browser": FROZEN_BUILD,
            "frozen": FROZEN_BUILD,
        },
        "settings": settings,
        "current_profile": current_profile,
        "profiles": profiles,
        "download_queue": download_queue,
        "stats": stats,
        "extract": {
            "active": extraction.extract_thread is not None and extraction.extract_thread.is_alive(),
            "job_id": extraction.extract_job_id,
        },
        "download": download_supervisor.download_manager.snapshot(),
        "auth": cookie_auth_status(),
        "jobs": jobs,
        "events": events,
        "paths": {
            "base": str(BASE_DIR),
            "database": str(DB_PATH),
            "logs": str(LOG_DIR),
            "library": str(Path(profile_output_dir(settings.get("output_dir", str(DEFAULT_OUTPUT_DIR)), profile_id or 0))),
            "manifest": str(Path(profile_output_dir(settings.get("output_dir", str(DEFAULT_OUTPUT_DIR)), profile_id)) / "download_manifest.jsonl")
            if profile_id is not None
            else "",
        },
    }


def list_profiles(query: dict[str, list[str]]) -> dict[str, Any]:
    scope = (query.get("scope") or ["collected"])[0].strip().lower()
    search = (query.get("q") or [""])[0].strip()
    sort_mode = (query.get("sort") or ["latest_desc"])[0].strip().lower()
    limit = normalize_int((query.get("limit") or ["200"])[0], 200, 1, 500)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    since_timestamp = normalize_int((query.get("since") or ["0"])[0], 0, 0, 9999999999)
    deleted_works = (query.get("deleted_works") or ["all"])[0].strip().lower()
    where: list[str] = []
    params: list[Any] = []
    if scope == "following":
        where.append("(profiles.is_following=1 OR (profiles.sec_uid=? AND profiles.tab='like'))")
        params.append(LIBRARY_SEC_UID)
    elif scope == "collected":
        where.append("(COALESCE(stats.total, 0)>0 OR (profiles.sec_uid=? AND profiles.tab='like'))")
        params.append(LIBRARY_SEC_UID)
    elif scope != "all":
        raise ValueError("主页范围只能是 collected/following/all")
    if deleted_works == "flagged":
        where.append("profiles.has_deleted_works=1")
    elif deleted_works != "all":
        raise ValueError("作品差异只能是 all/flagged")
    if search:
        where.append(
            "(profiles.nickname LIKE ? OR profiles.title LIKE ? OR profiles.unique_id LIKE ? "
            "OR profiles.short_id LIKE ? OR profiles.sec_uid LIKE ?)"
        )
        like = f"%{search}%"
        params.extend([like, like, like, like, like])
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    order_map = {
        "latest_desc": "COALESCE(stats.latest_work_create_time, 0) DESC, profiles.id DESC",
        "works_desc": "COALESCE(profiles.aweme_count, stats.total, 0) DESC, profiles.id DESC",
        "likes_desc": "COALESCE(profiles.total_favorited, 0) DESC, profiles.id DESC",
        "followers_desc": "COALESCE(profiles.follower_count, 0) DESC, profiles.id DESC",
        "last_refresh_asc": "COALESCE(profiles.last_extracted_at, '') ASC, profiles.id ASC",
    }
    order_sql = order_map.get(sort_mode, order_map["latest_desc"])
    stats_sql = """
      SELECT
        profile_id,
        COUNT(*) total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
        SUM(CASE WHEN status='downloading' THEN 1 ELSE 0 END) downloading,
        SUM(CASE WHEN status='downloaded' THEN 1 ELSE 0 END) downloaded,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
        MAX(create_time) latest_work_create_time
      FROM links
      WHERE profile_id IS NOT NULL
      GROUP BY profile_id
    """
    with db() as conn:
        total = int(
            conn.execute(
                f"SELECT COUNT(*) c FROM profiles LEFT JOIN ({stats_sql}) stats ON stats.profile_id=profiles.id {where_sql}",
                params,
            ).fetchone()["c"]
        )
        rows = [
            dict(row)
            for row in conn.execute(
                f"""
                SELECT profiles.*, COALESCE(stats.total, 0) total,
                  COALESCE(stats.pending, 0) pending,
                  COALESCE(stats.downloading, 0) downloading,
                  COALESCE(stats.downloaded, 0) downloaded,
                  COALESCE(stats.failed, 0) failed,
                  stats.latest_work_create_time
                FROM profiles
                LEFT JOIN ({stats_sql}) stats ON stats.profile_id=profiles.id
                {where_sql}
                ORDER BY CASE WHEN profiles.sec_uid=? AND profiles.tab='like' THEN 0 ELSE 1 END, {order_sql}
                LIMIT ? OFFSET ?
                """,
                [*params, LIBRARY_SEC_UID, limit, offset],
            ).fetchall()
        ]
        eligible_params: list[Any] = [LIBRARY_SEC_UID]
        eligible_where = "(COALESCE(stats.total, 0)>0 OR (profiles.sec_uid=? AND profiles.tab='like'))"
        if since_timestamp > 0:
            eligible_where += " AND (profiles.tab='like' OR stats.latest_work_create_time IS NULL OR stats.latest_work_create_time>=?)"
            eligible_params.append(since_timestamp)
        eligible_count = int(
            conn.execute(
                f"SELECT COUNT(*) c FROM profiles LEFT JOIN ({stats_sql}) stats ON stats.profile_id=profiles.id WHERE {eligible_where}",
                eligible_params,
            ).fetchone()["c"]
        )
    for profile in rows:
        profile["is_self"] = int(
            first_text(profile.get("sec_uid")) == LIBRARY_SEC_UID
            and str(profile.get("tab") or "post") == "like"
        )
    return {"total": total, "eligible_count": eligible_count, "profiles": rows}


def list_links(query: dict[str, list[str]]) -> dict[str, Any]:
    status = (query.get("status") or [""])[0]
    search = (query.get("q") or [""])[0]
    scope = (query.get("scope") or ["global"])[0].strip().lower()
    limit = normalize_int((query.get("limit") or ["100"])[0], 100, 1, 500)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    profile_id = normalize_int((query.get("profile_id") or ["0"])[0], 0, 0, 1000000)
    if profile_id <= 0 and scope in {"current", "profile"}:
        profile_id = current_profile_id(create=False) or 0
    where = []
    params: list[Any] = []
    if profile_id > 0:
        where.append("links.profile_id=?")
        params.append(profile_id)
    if status:
        where.append("links.status=?")
        params.append(status)
    if search:
        where.append(
            "(links.url LIKE ? OR links.aweme_id LIKE ? OR links.last_error LIKE ? "
            "OR links.author_uid LIKE ? OR links.author_sec_uid LIKE ? OR links.author_nickname LIKE ? "
            "OR links.desc LIKE ?)"
        )
        like = f"%{search}%"
        params.extend([like, like, like, like, like, like, like])
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    with db() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) c FROM links {where_sql}",
            params,
        ).fetchone()["c"]
        order_sql = "ORDER BY links.id DESC"
        if status == "downloaded":
            order_sql = (
                "ORDER BY COALESCE(links.downloaded_at, links.last_started_at, "
                "links.last_seen_at, links.discovered_at) DESC, links.id DESC"
            )
        rows = conn.execute(
            f"""
            SELECT
              links.*,
              profiles.url profile_url,
              profiles.nickname profile_nickname,
              profiles.title profile_title,
              profiles.tab profile_tab
            FROM links
            LEFT JOIN profiles ON profiles.id=links.profile_id
            {where_sql}
            {order_sql}
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()
    return {"total": total, "links": [dict(row) for row in rows]}
