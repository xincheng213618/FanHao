"""Internal read models responsibilities for the download manager."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import time
from contextlib import closing
from pathlib import Path
from typing import Any

from . import download_supervisor, extraction
from .auth import cookie_auth_status
from .common import first_text, normalize_int
from .collection_scheduler import automatic_collection_scheduler
from .config import BASE_DIR, DB_PATH, DEFAULT_OUTPUT_DIR, FROZEN_BUILD, LIBRARY_SEC_UID, LOG_DIR
from .database import db
from .domain_manifest import profile_output_dir
from .profiles_links import current_profile_id
from .profile_refresh_policy import (
    PROFILE_LINK_STATS_SQL,
    attach_profile_refresh_decision,
    profile_requires_full_scan,
    profile_refresh_decision,
)
from .queue import link_stats, list_download_queue


ACTIVITY_JOB_LIMIT = 200
ACTIVITY_EVENT_LIMIT = 100


def get_runtime_status() -> dict[str, Any]:
    """Return the small, frequently-polled runtime surface for the manager UI."""
    return {
        "app": {
            "desktop": False,
            "browser": FROZEN_BUILD,
            "frozen": FROZEN_BUILD,
        },
        "extract": extraction.extract_status(),
        "download": download_supervisor.download_manager.snapshot(),
    }


def get_activity_state() -> dict[str, Any]:
    """Return the bounded task history plus the authoritative extraction queue."""
    extract = extraction.extract_status()
    with db() as conn:
        jobs = [
            dict(row)
            for row in conn.execute(
                """
                SELECT *
                FROM jobs
                WHERE status IN ('running', 'queued')
                   OR id IN (
                     SELECT id FROM jobs ORDER BY id DESC LIMIT ?
                   )
                ORDER BY id DESC
                """,
                (ACTIVITY_JOB_LIMIT,),
            ).fetchall()
        ]
        events = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?",
                (ACTIVITY_EVENT_LIMIT,),
            ).fetchall()
        ]
    return {"jobs": jobs, "events": events, "extract": extract}


def get_state(*, include_profiles: bool = True) -> dict[str, Any]:
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
                  profiles.nickname_history_json,
                  profiles.total_favorited_history_json,
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
                  profiles.auto_collect_enabled,
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
        ] if include_profiles else []
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
        "automatic_collection": automatic_collection_scheduler.snapshot(),
        "current_profile": current_profile,
        "profiles": profiles,
        "download_queue": download_queue,
        "stats": stats,
        "extract": extraction.extract_status(),
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
    sort_mode = (query.get("sort") or ["last_extracted_desc"])[0].strip().lower()
    limit = normalize_int((query.get("limit") or ["200"])[0], 200, 1, 500)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    deleted_works = (query.get("deleted_works") or ["all"])[0].strip().lower()
    pending_full_scan_sql = """
    (
      COALESCE(profiles.full_scan_required, 0)=1
      OR (
        profiles.tab='post'
        AND COALESCE(profiles.account_status, 'active')<>'banned'
        AND COALESCE(profiles.has_deleted_works, 0)=0
        AND NULLIF(TRIM(COALESCE(profiles.last_full_scan_at, '')), '') IS NULL
        AND profiles.aweme_count IS NOT NULL
        AND COALESCE(stats.total, 0)-profiles.aweme_count>=10
        AND profiles.aweme_count<=COALESCE(stats.total, 0)*0.9
      )
    )
    """
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
        where.append(pending_full_scan_sql)
    elif deleted_works != "all":
        raise ValueError("作品差异只能是 all/flagged/pending")
    if search:
        where.append(
            "(profiles.nickname LIKE ? OR profiles.title LIKE ? OR profiles.unique_id LIKE ? "
            "OR profiles.short_id LIKE ? OR profiles.sec_uid LIKE ? OR profiles.nickname_history_json LIKE ?)"
        )
        like = f"%{search}%"
        params.extend([like, like, like, like, like, like])
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    order_map = {
        "last_extracted_desc": "COALESCE(profiles.last_extracted_at, '') DESC, profiles.id DESC",
        "latest_desc": "COALESCE(stats.latest_work_create_time, 0) DESC, profiles.id DESC",
        "works_desc": "COALESCE(profiles.aweme_count, stats.total, 0) DESC, profiles.id DESC",
        "likes_desc": "COALESCE(profiles.total_favorited, 0) DESC, profiles.id DESC",
        "followers_desc": "COALESCE(profiles.follower_count, 0) DESC, profiles.id DESC",
        "last_refresh_asc": "COALESCE(profiles.last_extracted_at, '') ASC, profiles.id ASC",
    }
    order_sql = order_map.get(sort_mode, order_map["last_extracted_desc"])
    # Count, page and refresh eligibility share one request-local aggregate.
    # Closing the connection also discards the temporary table; no stale cache
    # survives a download, deletion or profile update.
    stats_sql = "SELECT * FROM manager_profile_stats"
    with closing(db()) as conn, conn:
        # The temporary aggregate does not start a lasting read transaction.
        # Keep it, the profile page and refresh settings on one WAL snapshot.
        conn.execute("BEGIN")
        conn.execute(f"CREATE TEMP TABLE manager_profile_stats AS {PROFILE_LINK_STATS_SQL}")
        conn.execute("CREATE UNIQUE INDEX temp.idx_manager_profile_stats ON manager_profile_stats(profile_id)")
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
                  profiles.nickname_history_json,
                  profiles.total_favorited_history_json,
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
                  profiles.auto_collect_enabled,
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
                   profiles.auto_collect_enabled,
                   profiles.aweme_count,
                   profiles.has_deleted_works,
                   profiles.full_scan_required,
                   profiles.full_scan_required_at,
                   profiles.last_full_scan_at,
                   COALESCE(stats.total, 0) link_total,
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
    paused_count = sum(int(profile.get("auto_collect_enabled", 1) or 0) == 0 for profile in refresh_candidates)
    active_candidates = [
        profile for profile in refresh_candidates if int(profile.get("auto_collect_enabled", 1) or 0) == 1
    ]
    eligible_count = sum(
        int(profile_refresh_decision(profile, now_timestamp=now_timestamp)["refresh_due"])
        for profile in active_candidates
    )
    deferred_count = len(active_candidates) - eligible_count
    full_scan_required_count = sum(
        int(profile_requires_full_scan(profile))
        for profile in active_candidates
    )
    banned_count = sum(
        str(profile.get("account_status") or "active").strip().lower() == "banned"
        for profile in active_candidates
    )
    return {
        "total": total,
        "eligible_count": eligible_count,
        "deferred_count": deferred_count,
        "full_scan_required_count": full_scan_required_count,
        "banned_count": banned_count,
        "paused_count": paused_count,
        "auto_candidate_count": len(active_candidates),
        "profiles": rows,
    }


DOWNLOAD_TIME_SQL = "COALESCE(links.downloaded_at, links.last_started_at, links.last_seen_at, links.discovered_at)"
MANAGER_LINK_COLUMNS = """
    links.id, links.profile_id, links.aweme_id, links.kind, links.url,
    links.author_uid, links.author_sec_uid, links.author_nickname, links.desc,
    links.cover_url, links.create_time, links.media_type, links.status, links.attempts,
    links.discovered_at, links.last_seen_at, links.last_started_at, links.downloaded_at,
    links.failed_at, links.last_error, links.actual_probe_error, links.download_intent
"""


def _link_query(query: dict[str, list[str]]) -> dict[str, Any]:
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
    fingerprint = hashlib.sha256(json.dumps(
        [status, search, profile_id, view], ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    return {"status": status, "view": view, "include_summary": include_summary,
            "base_where": base_where, "base_params": base_params, "where": where,
            "params": params, "fingerprint": fingerprint}


def _where_sql(parts: list[str]) -> str:
    return f"WHERE {' AND '.join(parts)}" if parts else ""


def _link_cursor(raw: str, context: dict[str, Any]) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        if len(raw) > 2048:
            raise ValueError()
        decoded = base64.b64decode(raw + "=" * (-len(raw) % 4), altchars=b"-_", validate=True)
        cursor = json.loads(decoded)
        if not isinstance(cursor, dict) or set(cursor) != {"v", "q", "bound", "head", "after"}:
            raise ValueError()
        if type(cursor["v"]) is not int or cursor["v"] != 1 or cursor["q"] != context["fingerprint"]:
            raise ValueError()
        bound = cursor["bound"]
        if type(bound) is not int or not 0 <= bound <= 9223372036854775807:
            raise ValueError()
        for key in ("head", "after"):
            value = cursor[key]
            if (not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], str)
                    or len(value[0]) > 128 or type(value[1]) is not int or not 0 <= value[1] <= bound):
                raise ValueError()
            if context["status"] != "downloaded" and value[0] != "":
                raise ValueError()
        if tuple(cursor["after"]) > tuple(cursor["head"]):
            raise ValueError()
        return cursor
    except (ValueError, TypeError, KeyError, RecursionError, UnicodeDecodeError, binascii.Error):
        raise ValueError("链接游标无效或与当前查询不匹配") from None


def _encode_link_cursor(cursor: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(cursor, ensure_ascii=False, separators=(",", ":"))
                                   .encode("utf-8")).decode("ascii").rstrip("=")


def _cursor_where(context: dict[str, Any], cursor: dict[str, Any] | None,
                  *, continuation: bool = False) -> tuple[list[str], list[Any]]:
    where, params = list(context["where"]), list(context["params"])
    if cursor is not None:
        where.append("links.id<=?")
        params.append(cursor["bound"])
        if context["status"] == "downloaded":
            # Match the existing downloaded ordering and expression index exactly.
            where.append(f"({DOWNLOAD_TIME_SQL}, links.id)<= (?, ?)")
            params.extend(cursor["head"])
            if continuation:
                where.append(f"({DOWNLOAD_TIME_SQL}, links.id)< (?, ?)")
                params.extend(cursor["after"])
        elif continuation:
            where.append("links.id<?")
            params.append(cursor["after"][1])
    return where, params


def _link_summary(conn: Any, context: dict[str, Any]) -> dict[str, int] | None:
    if not context["include_summary"]:
        return None
    summary = dict.fromkeys(("all", "pending", "downloading", "downloaded", "failed"), 0)
    for row in conn.execute(
        f"SELECT links.status, COUNT(*) c FROM links {_where_sql(context['base_where'])} GROUP BY links.status",
        context["base_params"],
    ):
        count = int(row["c"] or 0)
        summary["all"] += count
        if str(row["status"] or "") in summary:
            summary[str(row["status"])] = count
    return summary


def _select_links(conn: Any, context: dict[str, Any], where: list[str], params: list[Any],
                  suffix: str, *, cursor_time: bool = False,
                  downloaded_index: bool = False) -> list[dict[str, Any]]:
    columns = MANAGER_LINK_COLUMNS if context["view"] == "manager" else "links.*"
    if cursor_time:
        columns += f", {DOWNLOAD_TIME_SQL} AS _cursor_time"
    index_sql = "INDEXED BY idx_links_downloaded_order" if downloaded_index else ""
    if downloaded_index:
        # The partial index predicate must be explicit at SQL preparation time.
        where = [*where, "links.status='downloaded'"]
    return [dict(row) for row in conn.execute(f"""
        SELECT {columns}, profiles.url profile_url, profiles.nickname profile_nickname,
          profiles.title profile_title, profiles.tab profile_tab
        FROM links {index_sql} LEFT JOIN profiles ON profiles.id=links.profile_id
        {_where_sql(where)} {suffix}
    """, params).fetchall()]


def list_links(query: dict[str, list[str]]) -> dict[str, Any]:
    context = _link_query(query)
    limit = normalize_int((query.get("limit") or ["100"])[0], 100, 1, 500)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    paging = (query.get("paging") or ["offset"])[0]
    raw_cursor = (query.get("cursor") or [""])[0]
    if paging not in {"offset", "cursor"}:
        raise ValueError("链接分页方式只能是 offset/cursor")
    cursor_mode = paging == "cursor" or bool(raw_cursor)
    if cursor_mode and offset:
        raise ValueError("游标分页不能同时使用非零 offset")
    cursor = _link_cursor(raw_cursor, context)
    downloaded = context["status"] == "downloaded"
    order_sql = f"ORDER BY {DOWNLOAD_TIME_SQL} DESC, links.id DESC" if downloaded else "ORDER BY links.id DESC"
    with db() as conn:
        # SELECT alone does not begin a transaction in Python's SQLite driver.
        # Keep the count, status summary and page on one short WAL read snapshot.
        conn.execute("BEGIN")
        if cursor_mode and cursor is None:
            bound = int(conn.execute("SELECT COALESCE(MAX(id),0) FROM links").fetchone()[0])
            cursor = {"v": 1, "q": context["fingerprint"], "bound": bound,
                      "head": ["", bound], "after": ["", bound]}
            if downloaded:
                head_where = [*context["where"], "links.id<=?", "links.status='downloaded'"]
                head = conn.execute(f"SELECT {DOWNLOAD_TIME_SQL}, links.id FROM links INDEXED BY idx_links_downloaded_order "
                                    f"{_where_sql(head_where)} {order_sql} LIMIT 1",
                                    [*context["params"], bound]).fetchone()
                cursor["head"] = [str(head[0]), int(head[1])] if head else ["", 0]
                cursor["after"] = list(cursor["head"])
        where, params = _cursor_where(context, cursor)
        total = conn.execute(
            f"SELECT COUNT(*) c FROM links {_where_sql(where)}",
            params,
        ).fetchone()["c"]
        summary = _link_summary(conn, context)
        if cursor_mode and downloaded and raw_cursor:
            # SQLite cannot seek an expression-index tuple inequality. Split
            # ties and earlier times into two disjoint seeks, retaining exactly
            # the existing (COALESCE time DESC, id DESC) order.
            page_where = [*context["where"], "links.id<=?"]
            page_params = [*context["params"], cursor["bound"]]
            after_time, after_id = cursor["after"]
            rows = _select_links(conn, context,
                                 [*page_where, f"{DOWNLOAD_TIME_SQL}=?", "links.id<?"],
                                 [*page_params, after_time, after_id, limit + 1],
                                 "ORDER BY links.id DESC LIMIT ?", cursor_time=True, downloaded_index=True)
            remaining = limit + 1 - len(rows)
            if remaining > 0:
                rows.extend(_select_links(conn, context, [*page_where, f"{DOWNLOAD_TIME_SQL}<?"],
                                          [*page_params, after_time, remaining],
                                          f"{order_sql} LIMIT ?", cursor_time=True, downloaded_index=True))
        else:
            page_where, page_params = _cursor_where(context, cursor, continuation=bool(raw_cursor))
            pagination = "LIMIT ?" if cursor_mode else "LIMIT ? OFFSET ?"
            page_params.extend([limit + 1] if cursor_mode else [limit, offset])
            rows = _select_links(conn, context, page_where, page_params,
                                 f"{order_sql} {pagination}", cursor_time=cursor_mode and downloaded,
                                 downloaded_index=cursor_mode and downloaded)
    result = {"total": total, "view": context["view"], "links": rows}
    if cursor_mode:
        has_more = len(rows) > limit
        del rows[limit:]
        if rows:
            cursor["after"] = [str(rows[-1].get("_cursor_time", "")), int(rows[-1]["id"])]
        for row in rows:
            row.pop("_cursor_time", None)
        encoded = _encode_link_cursor(cursor)
        result.update(paging="cursor", has_more=has_more, page_cursor=encoded,
                      next_cursor=encoded if has_more else None)
    if summary is not None:
        result["summary"] = summary
    return result


def refresh_links(query: dict[str, list[str]]) -> dict[str, Any]:
    """Refresh bounded loaded IDs and counts without replacing a live traversal."""
    context = _link_query(query)
    raw_ids = (query.get("ids") or [""])[0]
    try:
        parts = raw_ids.split(",") if raw_ids else []
        if len(parts) > 100 or len(raw_ids) > 2100 or any(not part.isascii() or not part.isdecimal() for part in parts):
            raise ValueError()
        ids = list(dict.fromkeys(int(part) for part in parts))
        if any(not 0 < link_id <= 9223372036854775807 for link_id in ids):
            raise ValueError()
    except ValueError:
        raise ValueError("链接刷新最多接受 100 个有效 ID") from None
    cursor = _link_cursor((query.get("cursor") or [""])[0], context)
    where, params = _cursor_where(context, cursor)
    with db() as conn:
        conn.execute("BEGIN")
        total = conn.execute(f"SELECT COUNT(*) c FROM links {_where_sql(where)}", params).fetchone()["c"]
        summary = _link_summary(conn, context)
        rows = _select_links(conn, context, [*where, f"links.id IN ({','.join('?' for _ in ids)})"],
                             [*params, *ids], "") if ids else []
    present = {row["id"] for row in rows}
    result = {"total": total, "view": context["view"], "links": rows,
              "missing_ids": [link_id for link_id in ids if link_id not in present]}
    if summary is not None:
        result["summary"] = summary
    return result
