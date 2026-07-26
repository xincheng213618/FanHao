"""Internal extraction responsibilities for the download manager."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Any

from .common import clean_profile_nickname, first_text, int_or_none, normalize_int, normalize_profile_tab, now_iso, parse_profile_url, tail_text
from .config import BASE_DIR, DATA_DIR, DEFAULT_COOKIE_FILE, LIBRARY_SEC_UID, LOG_DIR, NODE_EXECUTABLE, TEST_PROFILE_URL
from .database import add_event, create_job, db, set_setting, setting, update_job
from .profiles_links import (
    update_profile_deleted_works_flag,
    upsert_following_profiles,
    upsert_links,
    upsert_profile,
    upsert_profile_metadata,
)
from .profile_refresh_policy import PROFILE_LINK_STATS_SQL, profile_refresh_decision


extract_lock = threading.Lock()


extract_thread: threading.Thread | None = None


extract_job_id: int | None = None


extract_process: subprocess.Popen[Any] | None = None


extract_stop_event = threading.Event()


extract_cancel_event = threading.Event()


def run_extract_job(
    job_id: int,
    url: str,
    max_items: int,
    scrolls: int,
    idle_rounds: int,
    headed: bool,
    incremental_stop_existing: int,
    clear_global: bool = True,
    full_scan: bool = False,
) -> None:
    global extract_thread, extract_job_id, extract_process
    profile_id = upsert_profile(url)
    with db() as conn:
        profile_row = conn.execute("SELECT tab, aweme_count FROM profiles WHERE id=?", (profile_id,)).fetchone()
        profile_tab_for_job = str(profile_row["tab"] or "post") if profile_row else "post"
        profile_aweme_count = int_or_none(profile_row["aweme_count"]) or 0 if profile_row else 0
    out_path = DATA_DIR / f"extract-{uuid.uuid4().hex}.json"
    stream_path = DATA_DIR / f"extract-stream-{job_id}.jsonl"
    log_path = LOG_DIR / f"extract-job-{job_id}.log"
    cookie_file = setting("cookie_file", str(DEFAULT_COOKIE_FILE))
    cmd = [
        NODE_EXECUTABLE,
        str(BASE_DIR / "extract-links.mjs"),
        url,
        "--max",
        str(max_items),
        "--scrolls",
        str(scrolls),
        "--idle-rounds",
        str(idle_rounds),
        "--cookie-file",
        cookie_file,
        "--out",
        str(out_path),
        "--stream-out",
        str(stream_path),
        "--flush-every",
        "25",
    ]
    if headed:
        cmd.append("--headed")

    update_job(job_id, profile_id=profile_id, message="正在采集链接")
    add_event("info", f"开始采集：{url}")
    total_seen = inserted_total = updated_total = 0
    collection_started_at = datetime.now().astimezone()
    like_sequence = 0
    offset = 0
    partial = ""
    incremental_stop_triggered = False
    target_count_stop_triggered = False
    consecutive_existing = 0
    recent_existing_flags: list[bool] = []
    incremental_stop_reason = ""
    existing_aweme_ids: set[str] = set()
    full_scan_seen_aweme_ids: set[str] = set()
    if incremental_stop_existing > 0:
        try:
            with db() as conn:
                existing_aweme_ids = {
                    str(row["aweme_id"] or "").strip()
                    for row in conn.execute(
                        "SELECT aweme_id FROM links WHERE profile_id=? AND COALESCE(aweme_id, '') <> ''",
                        (profile_id,),
                    ).fetchall()
                }
        except sqlite3.Error:
            existing_aweme_ids = set()
    if not existing_aweme_ids:
        incremental_stop_existing = 0

    def finish_full_scan_flag() -> str:
        if not full_scan or profile_tab_for_job != "post":
            return ""
        result = update_profile_deleted_works_flag(profile_id, full_scan_seen_aweme_ids)
        if not result or result.get("skipped") or not result["has_deleted_works"]:
            return ""
        difference = int(result["marked"] or 0)
        add_event(
            "warn",
            f"全部扫描发现：本次去重后 {len(full_scan_seen_aweme_ids)} 条，数据库保留 {result['link_total']} 条，"
            f"主页不可见 {difference} 条作品（主页计数 {result['aweme_count']}）",
        )
        return f"；主页不可见 {difference} 条作品，已标记"

    def consume_stream() -> None:
        nonlocal offset, partial, total_seen, inserted_total, updated_total, consecutive_existing, incremental_stop_triggered, incremental_stop_reason, profile_aweme_count, target_count_stop_triggered, like_sequence
        if not stream_path.exists():
            return
        with stream_path.open("rb") as stream:
            stream.seek(offset)
            data = stream.read()
            offset = stream.tell()
        if not data:
            return
        text = partial + data.decode("utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        if lines and not lines[-1].endswith(("\n", "\r")):
            partial = lines.pop()
        else:
            partial = ""
        for raw in lines:
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            row_type = row.get("type")
            if row_type == "works":
                works = row.get("works") or []
                if profile_tab_for_job == "like":
                    for work in works:
                        if not isinstance(work, dict):
                            continue
                        work["_liked_at"] = (
                            collection_started_at - timedelta(microseconds=like_sequence)
                        ).isoformat(timespec="microseconds")
                        like_sequence += 1
                for work in works:
                    aweme_id = str((work or {}).get("aweme_id") or "").strip()
                    if not aweme_id:
                        continue
                    if full_scan:
                        full_scan_seen_aweme_ids.add(aweme_id)
                    was_existing = aweme_id in existing_aweme_ids
                    if incremental_stop_existing > 0 and was_existing:
                        consecutive_existing += 1
                    else:
                        consecutive_existing = 0
                    if incremental_stop_existing > 0:
                        recent_existing_flags.append(was_existing)
                        if len(recent_existing_flags) > incremental_stop_existing * 4:
                            del recent_existing_flags[: len(recent_existing_flags) - incremental_stop_existing * 4]
                    existing_aweme_ids.add(aweme_id)
                inserted, updated = upsert_links(profile_id, works)
                inserted_total += inserted
                updated_total += updated
                total_seen = max(total_seen, int(row.get("count") or 0), inserted_total + updated_total)
                update_job(
                    job_id,
                    total=total_seen,
                    processed=total_seen,
                    success=inserted_total,
                    failed=0,
                    message=f"采集中：累计 {total_seen} 条，新 {inserted_total}，已存在 {updated_total}",
                )
                if (
                    profile_tab_for_job == "post"
                    and profile_aweme_count > 0
                    and total_seen >= profile_aweme_count
                    and not target_count_stop_triggered
                    and not incremental_stop_triggered
                ):
                    target_count_stop_triggered = True
                    extract_stop_event.set()
                    proc = extract_process
                    if proc is not None and proc.poll() is None:
                        try:
                            proc.terminate()
                        except OSError:
                            pass
                if (
                    incremental_stop_existing > 0
                    and (
                        consecutive_existing >= incremental_stop_existing
                        or (
                            len(recent_existing_flags) >= incremental_stop_existing * 2
                            and sum(1 for flag in recent_existing_flags if flag)
                            >= max(incremental_stop_existing, int(len(recent_existing_flags) * 0.75))
                        )
                    )
                    and not incremental_stop_triggered
                ):
                    incremental_stop_triggered = True
                    if consecutive_existing >= incremental_stop_existing:
                        incremental_stop_reason = f"连续 {consecutive_existing} 条已存在"
                    else:
                        existing_recent = sum(1 for flag in recent_existing_flags if flag)
                        incremental_stop_reason = f"最近 {len(recent_existing_flags)} 条中 {existing_recent} 条已存在"
                    extract_stop_event.set()
                    proc = extract_process
                    if proc is not None and proc.poll() is None:
                        try:
                            proc.terminate()
                        except OSError:
                            pass
            elif row_type == "profile":
                profile_payload = row.get("profile") or {}
                upsert_profile_metadata(profile_id, profile_payload)
                fresh_aweme_count = int_or_none(
                    profile_payload.get("aweme_count")
                    if profile_payload.get("aweme_count") is not None
                    else profile_payload.get("awemeCount")
                )
                if fresh_aweme_count is not None:
                    profile_aweme_count = fresh_aweme_count
            elif row_type == "progress":
                total_seen = max(total_seen, int(row.get("count") or 0))
                update_job(
                    job_id,
                    total=total_seen,
                    processed=total_seen,
                    success=inserted_total,
                    failed=0,
                    message=f"采集中：第 {row.get('round')} 轮，累计 {total_seen} 条",
                )
                if (
                    profile_tab_for_job == "post"
                    and profile_aweme_count > 0
                    and total_seen >= profile_aweme_count
                    and not target_count_stop_triggered
                    and not incremental_stop_triggered
                ):
                    target_count_stop_triggered = True
                    extract_stop_event.set()
                    proc = extract_process
                    if proc is not None and proc.poll() is None:
                        try:
                            proc.terminate()
                        except OSError:
                            pass
            elif row_type == "done":
                total_seen = max(total_seen, int(row.get("count") or 0))
                upsert_profile_metadata(profile_id, row.get("profile") or {})

    try:
        try:
            stream_path.unlink()
        except FileNotFoundError:
            pass
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            proc = subprocess.Popen(
                cmd,
                cwd=str(BASE_DIR),
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            with extract_lock:
                extract_process = proc
            while proc.poll() is None:
                consume_stream()
                time.sleep(1.0)
            consume_stream()
        if extract_stop_event.is_set():
            if target_count_stop_triggered:
                deletion_suffix = finish_full_scan_flag()
                update_job(
                    job_id,
                    status="complete",
                    total=total_seen,
                    processed=total_seen,
                    success=inserted_total,
                    failed=0,
                    finished_at=now_iso(),
                    message=(
                        f"采集完成：已达到主页作品数 {profile_aweme_count}，"
                        f"已入库 {total_seen} 条，新 {inserted_total}，已存在 {updated_total}{deletion_suffix}"
                    ),
                )
                add_event(
                    "info",
                    f"采集完成：已达到主页作品数 {profile_aweme_count}，新 {inserted_total}，已存在 {updated_total}",
                )
                return
            if incremental_stop_triggered:
                update_job(
                    job_id,
                    status="complete",
                    total=total_seen,
                    processed=total_seen,
                    success=inserted_total,
                    failed=0,
                    finished_at=now_iso(),
                    message=(
                        f"增量采集完成：{incremental_stop_reason or f'连续 {consecutive_existing} 条已存在'}，"
                        f"已入库 {total_seen} 条，新 {inserted_total}，已存在 {updated_total}"
                    ),
                )
                add_event(
                    "info",
                    f"增量采集完成：{incremental_stop_reason or f'连续 {consecutive_existing} 条已存在'}，新 {inserted_total}，已存在 {updated_total}",
                )
                return
            update_job(
                job_id,
                status="stopped",
                total=total_seen,
                processed=total_seen,
                success=inserted_total,
                failed=0,
                finished_at=now_iso(),
                message=f"采集已停止：已入库 {total_seen} 条，新 {inserted_total}，已存在 {updated_total}",
            )
            add_event("warn", f"采集已停止：已入库 {total_seen} 条")
            return
        if proc.returncode != 0:
            message = f"采集失败，退出码 {proc.returncode}: {tail_text(log_path, 1200)}"
            update_job(job_id, status="failed", finished_at=now_iso(), message=message)
            add_event("error", message[:260])
            return
        if total_seen == 0 and out_path.exists():
            payload = json.loads(out_path.read_text(encoding="utf-8"))
            upsert_profile_metadata(profile_id, payload.get("profile") or {})
            works = payload.get("works") or []
            if full_scan:
                full_scan_seen_aweme_ids.update(
                    str((work or {}).get("aweme_id") or "").strip()
                    for work in works
                    if str((work or {}).get("aweme_id") or "").strip()
                )
            inserted, updated = upsert_links(profile_id, works)
            inserted_total += inserted
            updated_total += updated
            total_seen = len(works)
        deletion_suffix = finish_full_scan_flag()
        update_job(
            job_id,
            status="complete",
            total=total_seen,
            processed=total_seen,
            success=inserted_total,
            failed=0,
            finished_at=now_iso(),
            message=f"采集完成：{total_seen} 条，新 {inserted_total}，已存在 {updated_total}{deletion_suffix}",
        )
        add_event("info", f"采集完成：{total_seen} 条，新 {inserted_total}，已存在 {updated_total}")
    except Exception as exc:
        update_job(job_id, status="failed", finished_at=now_iso(), message=str(exc))
        add_event("error", f"采集异常：{exc}")
    finally:
        with extract_lock:
            extract_process = None
            if clear_global:
                extract_thread = None
                extract_job_id = None
                extract_stop_event.clear()
                extract_cancel_event.clear()


def start_extract(payload: dict[str, Any]) -> dict[str, Any]:
    global extract_thread, extract_job_id
    url = str(payload.get("url") or setting("profile_url", TEST_PROFILE_URL)).strip()
    if not url:
        return {"ok": False, "message": "需要主页链接"}
    profile_tab = normalize_profile_tab(payload.get("profile_tab") or setting("profile_tab", "auto"))
    parsed_profile = parse_profile_url(url, profile_tab)
    set_setting("profile_url", parsed_profile["url"])
    set_setting("profile_tab", profile_tab)
    url = parsed_profile["url"]
    max_items = normalize_int(payload.get("max", 0), 0, 0, 100000)
    scrolls = normalize_int(payload.get("scrolls", setting("scrolls", "12000")), 12000, 1, 30000)
    idle_rounds = normalize_int(payload.get("idle_rounds", setting("idle_rounds", "160")), 160, 1, 1000)
    incremental_stop_existing = normalize_int(
        payload.get("incremental_stop_existing", setting("incremental_stop_existing", "12")),
        12,
        0,
        1000,
    )
    full_scan = payload.get("full_scan") is True
    if full_scan:
        max_items = 0
        incremental_stop_existing = 0
    headed = bool(payload.get("headed", False))

    with extract_lock:
        if extract_thread is not None and extract_thread.is_alive():
            return {"ok": False, "message": "采集任务已经在运行"}
        extract_stop_event.clear()
        extract_cancel_event.clear()
        job_id = create_job("extract", "准备采集")
        extract_job_id = job_id
        extract_thread = threading.Thread(
            target=run_extract_job,
            args=(job_id, url, max_items, scrolls, idle_rounds, headed, incremental_stop_existing),
            kwargs={"full_scan": full_scan},
            daemon=True,
        )
        extract_thread.start()
    return {"ok": True, "job_id": job_id}


def run_refresh_profiles_job(
    job_id: int,
    max_profiles: int,
    profile_ids: list[int],
    max_items: int,
    scrolls: int,
    idle_rounds: int,
    headed: bool,
    incremental_stop_existing: int,
    full_scan: bool,
) -> None:
    global extract_thread, extract_job_id, extract_process
    success_profiles = 0
    failed_profiles = 0
    stopped = False
    try:
        with db() as conn:
            rows = [
                dict(row)
                for row in conn.execute(
                    f"""
                    SELECT
                      profiles.id,
                      profiles.url,
                      profiles.tab,
                      profiles.title,
                      profiles.nickname,
                      profiles.unique_id,
                      profiles.short_id,
                      profiles.updated_at,
                      profiles.last_extracted_at,
                      profiles.sec_uid,
                      q.sort_order,
                      COALESCE(stats.total, 0) link_total,
                      stats.latest_work_create_time,
                      stats.previous_work_create_time
                    FROM profiles
                    LEFT JOIN profile_download_queue q ON q.profile_id=profiles.id AND q.enabled=1
                    LEFT JOIN ({PROFILE_LINK_STATS_SQL}) stats ON stats.profile_id=profiles.id
                    WHERE COALESCE(profiles.url, '') <> ''
                    ORDER BY
                      CASE WHEN q.profile_id IS NULL THEN 1 ELSE 0 END,
                      COALESCE(q.sort_order, 999999999),
                      COALESCE(profiles.last_extracted_at, profiles.updated_at, profiles.created_at),
                      profiles.id
                    """
                ).fetchall()
            ]
        smart_skipped = 0
        if profile_ids:
            selected_ids = set(profile_ids)
            rows = [row for row in rows if int(row["id"]) in selected_ids]
        else:
            rows = [
                row
                for row in rows
                if int(row.get("link_total") or 0) > 0
                or (
                    first_text(row.get("sec_uid")) == LIBRARY_SEC_UID
                    and str(row.get("tab") or "post") == "like"
                )
            ]
            if not full_scan:
                now_timestamp = int(time.time())
                due_rows = []
                for row in rows:
                    decision = profile_refresh_decision(row, now_timestamp=now_timestamp)
                    row.update(decision)
                    if decision["refresh_due"]:
                        due_rows.append(row)
                smart_skipped = len(rows) - len(due_rows)
                rows = due_rows
        if max_profiles > 0:
            rows = rows[:max_profiles]
        total_profiles = len(rows)
        prepare_message = f"准备刷新 {total_profiles} 个主页"
        if smart_skipped:
            prepare_message += f"，智能跳过 {smart_skipped} 个未到期主页"
        update_job(job_id, total=total_profiles, processed=0, success=0, failed=0, message=prepare_message)
        if not rows:
            message = (
                f"智能判定：暂时没有到期主页，已跳过 {smart_skipped} 个"
                if smart_skipped
                else "没有可刷新的已入库主页"
            )
            update_job(job_id, status="complete", finished_at=now_iso(), message=message)
            return
        event_message = f"开始批量刷新现有主页：{total_profiles} 个"
        if smart_skipped:
            event_message += f"，智能跳过 {smart_skipped} 个"
        add_event("info", event_message)
        for index, profile in enumerate(rows, start=1):
            if extract_cancel_event.is_set():
                stopped = True
                break
            extract_stop_event.clear()
            label = clean_profile_nickname(profile.get("nickname") or profile.get("title")) or f"主页 #{profile['id']}"
            update_job(
                job_id,
                processed=index - 1,
                success=success_profiles,
                failed=failed_profiles,
                message=f"刷新中：{index}/{total_profiles} {label}",
            )
            sub_job_id = create_job("extract", f"批量刷新 {index}/{total_profiles}: {label}", int(profile["id"]))
            run_extract_job(
                sub_job_id,
                str(profile["url"]),
                max_items,
                scrolls,
                idle_rounds,
                headed,
                incremental_stop_existing,
                clear_global=False,
                full_scan=full_scan,
            )
            with db() as conn:
                sub = conn.execute("SELECT status FROM jobs WHERE id=?", (sub_job_id,)).fetchone()
            sub_status = str(sub["status"] if sub else "")
            if sub_status == "failed":
                failed_profiles += 1
            else:
                success_profiles += 1
            if sub_status == "stopped":
                stopped = True
                break
            update_job(
                job_id,
                processed=index,
                success=success_profiles,
                failed=failed_profiles,
                message=f"刷新进度：{index}/{total_profiles}，成功 {success_profiles}，失败 {failed_profiles}",
            )
        status = "stopped" if stopped else "complete"
        message = (
            f"批量刷新已停止：成功 {success_profiles}，失败 {failed_profiles}"
            if stopped
            else f"批量刷新完成：成功 {success_profiles}，失败 {failed_profiles}"
        )
        if smart_skipped:
            message += f"，智能跳过 {smart_skipped} 个"
        update_job(
            job_id,
            status=status,
            processed=success_profiles + failed_profiles,
            success=success_profiles,
            failed=failed_profiles,
            finished_at=now_iso(),
            message=message,
        )
        add_event("warn" if stopped else "info", message)
    except Exception as exc:
        update_job(job_id, status="failed", finished_at=now_iso(), message=str(exc)[:2000])
        add_event("error", f"批量刷新异常：{exc}")
    finally:
        with extract_lock:
            extract_process = None
            extract_thread = None
            extract_job_id = None
        extract_stop_event.clear()
        extract_cancel_event.clear()


def start_refresh_profiles(payload: dict[str, Any]) -> dict[str, Any]:
    global extract_thread, extract_job_id
    max_profiles = normalize_int(payload.get("max_profiles", 0), 0, 0, 100000)
    raw_profile_ids = payload.get("profile_ids")
    profile_ids: list[int] = []
    if isinstance(raw_profile_ids, list):
        for value in raw_profile_ids:
            profile_id = normalize_int(value, 0, 0, 1000000)
            if profile_id > 0 and profile_id not in profile_ids:
                profile_ids.append(profile_id)
    max_items = normalize_int(payload.get("max", 0), 0, 0, 100000)
    scrolls = normalize_int(payload.get("scrolls", setting("scrolls", "12000")), 12000, 1, 30000)
    idle_rounds = normalize_int(payload.get("idle_rounds", setting("idle_rounds", "160")), 160, 1, 1000)
    incremental_stop_existing = normalize_int(
        payload.get("incremental_stop_existing", setting("incremental_stop_existing", "12")),
        12,
        0,
        1000,
    )
    full_scan = payload.get("full_scan") is True
    if full_scan:
        max_items = 0
        incremental_stop_existing = 0
    headed = bool(payload.get("headed", False))
    with extract_lock:
        if extract_thread is not None and extract_thread.is_alive():
            return {"ok": False, "message": "采集任务已经在运行"}
        extract_stop_event.clear()
        extract_cancel_event.clear()
        job_id = create_job("refresh", "准备批量刷新现有主页")
        extract_job_id = job_id
        extract_thread = threading.Thread(
            target=run_refresh_profiles_job,
            args=(
                job_id,
                max_profiles,
                profile_ids,
                max_items,
                scrolls,
                idle_rounds,
                headed,
                incremental_stop_existing,
                full_scan,
            ),
            daemon=True,
        )
        extract_thread.start()
    return {"ok": True, "job_id": job_id}


def run_following_import_job(
    job_id: int,
    url: str,
    max_users: int,
    scrolls: int,
    idle_rounds: int,
    headed: bool,
) -> None:
    global extract_thread, extract_job_id, extract_process
    out_path = DATA_DIR / f"following-{uuid.uuid4().hex}.json"
    log_path = LOG_DIR / f"following-job-{job_id}.log"
    cmd = [
        NODE_EXECUTABLE,
        str(BASE_DIR / "extract-following.mjs"),
        url,
        "--max",
        str(max_users),
        "--scrolls",
        str(scrolls),
        "--idle-rounds",
        str(idle_rounds),
        "--cookie-file",
        setting("cookie_file", str(DEFAULT_COOKIE_FILE)),
        "--out",
        str(out_path),
    ]
    if headed:
        cmd.append("--headed")
    update_job(job_id, message="正在打开本人关注列表")
    add_event("info", "开始提取本人关注列表")
    seen_sec_uids: set[str] = set()
    inserted_total = 0
    updated_total = 0

    def consume_checkpoint() -> None:
        nonlocal inserted_total, updated_total
        if not out_path.exists():
            return
        try:
            payload = json.loads(out_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        fresh_users = []
        for user in payload.get("users") or []:
            if not isinstance(user, dict):
                continue
            sec_uid = first_text(user.get("sec_uid"), user.get("secUid"))
            if not sec_uid or sec_uid in seen_sec_uids:
                continue
            seen_sec_uids.add(sec_uid)
            fresh_users.append(user)
        if not fresh_users:
            return
        inserted, updated = upsert_following_profiles(fresh_users)
        inserted_total += inserted
        updated_total += updated
        total = len(seen_sec_uids)
        update_job(
            job_id,
            total=total,
            processed=total,
            success=inserted_total,
            failed=0,
            message=f"关注列表提取中：已入库 {total} 人，新 {inserted_total}，更新 {updated_total}",
        )
    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            proc = subprocess.Popen(
                cmd,
                cwd=str(BASE_DIR),
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            with extract_lock:
                extract_process = proc
            while proc.poll() is None:
                consume_checkpoint()
                if extract_stop_event.is_set():
                    try:
                        proc.terminate()
                    except OSError:
                        pass
                time.sleep(1.0)
        consume_checkpoint()
        if extract_stop_event.is_set():
            update_job(job_id, status="stopped", finished_at=now_iso(), message="关注列表提取已停止")
            add_event("warn", "关注列表提取已停止")
            return
        if proc.returncode != 0:
            message = f"关注列表提取失败，退出码 {proc.returncode}: {tail_text(log_path, 1200)}"
            update_job(job_id, status="failed", finished_at=now_iso(), message=message)
            add_event("error", message[:260])
            return
        total = len(seen_sec_uids)
        message = f"关注列表提取完成：{total} 人，新 {inserted_total}，更新 {updated_total}"
        update_job(
            job_id,
            status="complete",
            total=total,
            processed=total,
            success=inserted_total,
            failed=0,
            finished_at=now_iso(),
            message=message,
        )
        add_event("info", message)
    except Exception as exc:
        update_job(job_id, status="failed", finished_at=now_iso(), message=str(exc)[:2000])
        add_event("error", f"关注列表提取异常：{exc}")
    finally:
        try:
            out_path.unlink()
        except FileNotFoundError:
            pass
        with extract_lock:
            extract_process = None
            extract_thread = None
            extract_job_id = None
        extract_stop_event.clear()
        extract_cancel_event.clear()


def start_following_import(payload: dict[str, Any]) -> dict[str, Any]:
    global extract_thread, extract_job_id
    max_users = normalize_int(payload.get("max", 0), 0, 0, 100000)
    scrolls = normalize_int(payload.get("scrolls", 1200), 1200, 1, 30000)
    idle_rounds = normalize_int(payload.get("idle_rounds", 16), 16, 1, 1000)
    headed = bool(payload.get("headed", False))
    url = f"https://www.douyin.com/user/{LIBRARY_SEC_UID}"
    with extract_lock:
        if extract_thread is not None and extract_thread.is_alive():
            return {"ok": False, "message": "采集任务已经在运行"}
        extract_stop_event.clear()
        extract_cancel_event.clear()
        job_id = create_job("following", "准备提取本人关注列表")
        extract_job_id = job_id
        extract_thread = threading.Thread(
            target=run_following_import_job,
            args=(job_id, url, max_users, scrolls, idle_rounds, headed),
            daemon=True,
        )
        extract_thread.start()
    return {"ok": True, "job_id": job_id}


def stop_extract() -> dict[str, Any]:
    with extract_lock:
        running = extract_thread is not None and extract_thread.is_alive()
        proc = extract_process
        if not running:
            return {"ok": False, "message": "当前没有采集任务"}
        extract_cancel_event.set()
        extract_stop_event.set()
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
    add_event("warn", "正在停止采集任务")
    return {"ok": True}
