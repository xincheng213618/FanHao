"""Internal read models responsibilities for the download manager."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from . import download_supervisor, extraction
from .auth import cookie_auth_status
from .common import first_text, normalize_int
from .config import BASE_DIR, DB_PATH, DEFAULT_OUTPUT_DIR, FROZEN_BUILD, LIBRARY_SEC_UID, LOG_DIR
from .database import db
from .domain_manifest import profile_output_dir
from .profiles_links import current_profile_id
from .profile_refresh_policy import (
    PROFILE_LINK_STATS_SQL,
    attach_profile_refresh_decision,
    profile_refresh_decision,
)
from .queue import link_stats, list_download_queue


def get_runtime_status() -> dict[str, Any]:
    """Return the small, frequently-polled runtime surface for the manager UI."""
    return {
        "app": {
            "desktop": False,
            "browser": FROZEN_BUILD,
            "frozen": FROZEN_BUILD,
        },
        "extract": {
            "active": extraction.extract_thread is not None and extraction.extract_thread.is_alive(),
            "job_id": extraction.extract_job_id,
        },
        "download": download_supervisor.download_manager.snapshot(),
    }


def get_activity_state() -> dict[str, Any]:
    """Return recent jobs and events without loading every profile and link count."""
    with db() as conn:
        jobs = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM jobs ORDER BY id DESC LIMIT 8"
            ).fetchall()
        ]
        events = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT 20"
            ).fetchall()
        ]
    return {"jobs": jobs, "events": events}


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
                   profiles.account_status,
                   profiles.account_status_reason,
                   profiles.account_status_detected_at,
                   profiles.full_scan_required,
                   profiles.full_scan_reason,
                   profiles.full_scan_required_at,
                   profiles.last_full_scan_at,
                   profiles.last_full_scan_aweme_count,
                   profiles.last_full_scan_link_total,
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
    deleted_works = (query.get("deleted_works") or ["all"])[0].strip().lower()
    where: list[str] = []
    params: list[Any] = []
    if scope == "following":
        where.append("(profiles.is_following=1 OR (profiles.sec_uid=? AND profiles.tab='like'))")
        params.append(LIBRARY_SEC_UID)
    elif scope == "banned":
        where.append("COALESCE(profiles.account_status, 'active')='banned'")
    elif scope == "collected":
        where.append("(COALESCE(stats.total, 0)>0 OR (profiles.sec_uid=? AND profiles.tab='like'))")
        params.append(LIBRARY_SEC_UID)
    elif scope != "all":
        raise ValueError("主页范围只能是 collected/following/banned/all")
    if deleted_works == "flagged":
        where.append("profiles.has_deleted_works=1")
    elif deleted_works == "pending":
        where.append("profiles.full_scan_required=1")
    elif deleted_works != "all":
        raise ValueError("作品差异只能是 all/flagged/pending")
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
    stats_sql = PROFILE_LINK_STATS_SQL
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
                SELECT
                  profiles.id,
                  profiles.url,
                  profiles.sec_uid,
                  profiles.tab,
                  profiles.title,
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
                   profiles.account_status,
                   profiles.account_status_reason,
                   profiles.account_status_detected_at,
                   profiles.full_scan_required,
                   profiles.full_scan_reason,
                   profiles.full_scan_required_at,
                   profiles.last_full_scan_at,
                   profiles.last_full_scan_aweme_count,
                   profiles.last_full_scan_link_total,
                   profiles.favoriting_count,
                  profiles.gender,
                  profiles.age,
                  profiles.verification,
                  profiles.profile_collected_at,
                  profiles.is_following,
                  profiles.following_discovered_at,
                  profiles.created_at,
                  profiles.updated_at,
                  profiles.last_extracted_at,
                  COALESCE(stats.total, 0) total,
                  COALESCE(stats.pending, 0) pending,
                  COALESCE(stats.downloading, 0) downloading,
                  COALESCE(stats.downloaded, 0) downloaded,
                  COALESCE(stats.failed, 0) failed,
                   stats.latest_work_create_time,
                   stats.previous_work_create_time,
                   (
                     SELECT history.observed_aweme_count
                     FROM profile_collection_history history
                     WHERE history.profile_id=profiles.id AND history.status='complete'
                     ORDER BY history.id DESC LIMIT 1
                   ) last_collection_aweme_count,
                   (
                     SELECT history.previous_aweme_count
                     FROM profile_collection_history history
                     WHERE history.profile_id=profiles.id AND history.status='complete'
                     ORDER BY history.id DESC LIMIT 1
                   ) previous_collection_aweme_count
                FROM profiles
                LEFT JOIN ({stats_sql}) stats ON stats.profile_id=profiles.id
                {where_sql}
                ORDER BY CASE WHEN profiles.sec_uid=? AND profiles.tab='like' THEN 0 ELSE 1 END, {order_sql}
                LIMIT ? OFFSET ?
                """,
                [*params, LIBRARY_SEC_UID, limit, offset],
            ).fetchall()
        ]
        eligible_where = "(COALESCE(stats.total, 0)>0 OR (profiles.sec_uid=? AND profiles.tab='like'))"
        refresh_candidates = [
            dict(row)
            for row in conn.execute(
                f"""
                SELECT
                   profiles.tab,
                   profiles.last_extracted_at,
                   profiles.account_status,
                   profiles.full_scan_required,
                   profiles.full_scan_required_at,
                   stats.latest_work_create_time,
                  stats.previous_work_create_time
                FROM profiles
                LEFT JOIN ({stats_sql}) stats ON stats.profile_id=profiles.id
                WHERE {eligible_where}
                """,
                [LIBRARY_SEC_UID],
            ).fetchall()
        ]
    now_timestamp = int(time.time())
    for profile in rows:
        profile["is_self"] = int(
            first_text(profile.get("sec_uid")) == LIBRARY_SEC_UID
            and str(profile.get("tab") or "post") == "like"
        )
        attach_profile_refresh_decision(profile, now_timestamp=now_timestamp)
    eligible_count = sum(
        int(profile_refresh_decision(profile, now_timestamp=now_timestamp)["refresh_due"])
        for profile in refresh_candidates
    )
    deferred_count = len(refresh_candidates) - eligible_count
    full_scan_required_count = sum(
        int(profile.get("full_scan_required") or 0)
        for profile in refresh_candidates
        if str(profile.get("tab") or "post") == "post"
        and str(profile.get("account_status") or "active").strip().lower() != "banned"
    )
    banned_count = sum(
        str(profile.get("account_status") or "active").strip().lower() == "banned"
        for profile in refresh_candidates
    )
    return {
        "total": total,
        "eligible_count": eligible_count,
        "deferred_count": deferred_count,
        "full_scan_required_count": full_scan_required_count,
        "banned_count": banned_count,
        "auto_candidate_count": len(refresh_candidates),
        "profiles": rows,
    }


def list_links(query: dict[str, list[str]]) -> dict[str, Any]:
    status = (query.get("status") or [""])[0]
    search = (query.get("q") or [""])[0]
    scope = (query.get("scope") or ["global"])[0].strip().lower()
    view = (query.get("view") or ["full"])[0].strip().lower()
    include_summary = str((query.get("include_summary") or [""])[0]).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if view not in {"full", "manager"}:
        raise ValueError("链接视图只能是 full/manager")
    limit = normalize_int((query.get("limit") or ["100"])[0], 100, 1, 500)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    profile_id = normalize_int((query.get("profile_id") or ["0"])[0], 0, 0, 1000000)
    if profile_id <= 0 and scope in {"current", "profile"}:
        profile_id = current_profile_id(create=False) or 0
    base_where = []
    base_params: list[Any] = []
    if profile_id > 0:
        base_where.append("links.profile_id=?")
        base_params.append(profile_id)
    if search:
        base_where.append(
            "(links.url LIKE ? OR links.aweme_id LIKE ? OR links.last_error LIKE ? "
            "OR links.author_uid LIKE ? OR links.author_sec_uid LIKE ? OR links.author_nickname LIKE ? "
            "OR links.desc LIKE ?)"
        )
        like = f"%{search}%"
        base_params.extend([like, like, like, like, like, like, like])
    where = list(base_where)
    params = list(base_params)
    if status:
        where.append("links.status=?")
        params.append(status)
    base_where_sql = f"WHERE {' AND '.join(base_where)}" if base_where else ""
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    with db() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) c FROM links {where_sql}",
            params,
        ).fetchone()["c"]
        summary = None
        if include_summary:
            summary = {
                "all": 0,
                "pending": 0,
                "downloading": 0,
                "downloaded": 0,
                "failed": 0,
            }
            summary_rows = conn.execute(
                f"SELECT links.status, COUNT(*) c FROM links {base_where_sql} GROUP BY links.status",
                base_params,
            ).fetchall()
            for summary_row in summary_rows:
                count = int(summary_row["c"] or 0)
                summary["all"] += count
                summary_status = str(summary_row["status"] or "")
                if summary_status in summary:
                    summary[summary_status] = count
        order_sql = "ORDER BY links.id DESC"
        if status == "downloaded":
            order_sql = (
                "ORDER BY COALESCE(links.downloaded_at, links.last_started_at, "
                "links.last_seen_at, links.discovered_at) DESC, links.id DESC"
            )
        link_columns = "links.*"
        if view == "manager":
            link_columns = """
              links.id,
              links.profile_id,
              links.aweme_id,
              links.kind,
              links.url,
              links.author_uid,
              links.author_sec_uid,
              links.author_nickname,
              links.desc,
              links.cover_url,
              links.create_time,
              links.media_type,
              links.status,
              links.attempts,
              links.discovered_at,
              links.last_seen_at,
              links.last_started_at,
              links.downloaded_at,
              links.failed_at,
              links.last_error,
              links.actual_probe_error,
              links.download_intent
            """
        rows = conn.execute(
            f"""
            SELECT
              {link_columns},
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
    result = {"total": total, "view": view, "links": [dict(row) for row in rows]}
    if summary is not None:
        result["summary"] = summary
    return result
