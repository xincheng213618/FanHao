"""Internal download supervisor responsibilities for the download manager."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .common import iso_from_timestamp, normalize_int, now_iso, row_text
from .config import DEFAULT_OUTPUT_DIR, DOWNLOAD_QUEUE_ORDER, MAX_CONCURRENCY, QUALITY_UPGRADE_INTENT
from .database import add_event, create_job, db, download_cycle_cooldown_seconds, download_cycle_limit, setting, update_job
from .domain_manifest import profile_output_dir
from .download_state import DownloadManager
from .queue import queue_pending_count, sync_download_queue
from .runtime import download_timing
from .download_guard import DownloadGuardMixin
from .sidecar_runtime import SidecarRuntimeMixin


class SidecarDownloadManager(DownloadGuardMixin, SidecarRuntimeMixin, DownloadManager):
    def __init__(self) -> None:
        super().__init__()
        self.sidecar_signature: tuple[str, int, str] | None = None
        self.watch_new = True
        self.active_job_started: dict[str, float] = {}

    def start(
        self,
        concurrency: int,
        retry_failed: bool = False,
        limit: int = 0,
        profile_id: int | None = None,
        watch_new: bool = True,
        manual: bool = True,
    ) -> dict[str, Any]:
        concurrency = normalize_int(concurrency, 8, 1, MAX_CONCURRENCY)
        limit = normalize_int(limit, 0, 0, 1000000)
        if profile_id is None:
            return {"ok": False, "message": "当前主页还没有入库，请先采集链接"}
        with self.lock:
            if self.active:
                return {"ok": False, "message": "下载任务已经在运行"}
            if self.failure_guard_until and time.time() < self.failure_guard_until and not manual:
                return {
                    "ok": False,
                    "message": f"下载保护暂停中，预计 {iso_from_timestamp(self.failure_guard_until)} 后自动重试",
                }
            if manual or not self.failure_guard_until or time.time() >= self.failure_guard_until:
                self._clear_failure_guard_locked()
            if retry_failed:
                with db() as conn:
                    conn.execute(
                        "UPDATE links SET status='pending', last_error=NULL WHERE status='failed' AND profile_id=?",
                        (profile_id,),
                    )
            with db() as conn:
                conn.execute(
                    "UPDATE links SET status='pending' WHERE status='downloading' AND profile_id=?",
                    (profile_id,),
                )
                pending = conn.execute(
                    "SELECT COUNT(*) c FROM links WHERE status='pending' AND profile_id=?",
                    (profile_id,),
                ).fetchone()["c"]
                queue_pending = queue_pending_count(conn)
            if pending <= 0 and queue_pending > 0:
                pending = queue_pending
            if pending <= 0 and not watch_new:
                return {"ok": False, "message": "没有待下载链接"}
            run_total = min(pending, limit) if limit > 0 else pending
            mode = "动态监听" if watch_new and limit <= 0 else f"本次 {run_total} 条"
            self.limit = limit
            self.profile_id = profile_id
            self.watch_new = bool(watch_new)
            self.cycle_sidecar_success = 0
            self.cycle_idle_since = None
            self.stop_event.clear()
            self.job_id = create_job(
                "download",
                f"并发 {concurrency}，{mode}，当前待下载 {pending} 条",
                profile_id,
            )
            download_timing(
                "manager_start",
                job_id=self.job_id,
                profile_id=profile_id,
                concurrency=concurrency,
                pending=pending,
                limit=limit,
                watch_new=self.watch_new,
            )
            self.active = True
            self.supervisor = threading.Thread(
                target=self._run_supervisor,
                args=(self.job_id, concurrency),
                daemon=True,
            )
            self.supervisor.start()
            add_event("info", f"下载启动：并发 {concurrency}，{mode}，当前待下载 {pending} 条")
            return {
                "ok": True,
                "job_id": self.job_id,
                "pending": pending,
                "run_total": run_total,
                "watch_new": self.watch_new,
            }

    def stop(self) -> dict[str, Any]:
        with self.lock:
            had_pause = bool(self.failure_guard_until and time.time() < self.failure_guard_until)
            had_work = self.active or self.sidecar_proc is not None or had_pause
            if had_pause:
                self._clear_failure_guard_locked()
            self.stop_event.set()
            proc = self.sidecar_proc
            self.sidecar_proc = None
            self.sidecar_port = None
            self.sidecar_signature = None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=8)
            except Exception:
                try:
                    proc.kill()
                except OSError:
                    pass
        if had_work:
            self._reset_active_jobs("下载被停止，等待下次继续")
            add_event("warn", "下载自动恢复已取消" if had_pause and proc is None else "sidecar 已停止")
            return {"ok": True}
        return {"ok": False, "message": "当前没有下载任务"}

    def _run_supervisor(self, job_id: int, concurrency: int) -> None:
        profile_id = self.profile_id
        if profile_id is None:
            update_job(job_id, status="failed", finished_at=now_iso(), message="当前主页不存在")
            return
        output_dir = profile_output_dir(setting("output_dir", str(DEFAULT_OUTPUT_DIR)), profile_id)
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        download_timing(
            "supervisor_start",
            job_id=job_id,
            profile_id=profile_id,
            concurrency=concurrency,
            output_dir=output_dir,
        )

        total = processed = success = failed = 0
        sidecar_success = 0
        active: dict[str, sqlite3.Row] = {}
        target_limit = self.limit
        watch_new = self.watch_new
        max_active = max(1, concurrency)
        cycle_limit = download_cycle_limit()
        cycle_cooldown_seconds = download_cycle_cooldown_seconds()
        stopped = False
        guard_triggered = False
        cycle_pause_triggered = False
        try:
            update_job(job_id, total=total, processed=0, success=0, failed=0)
            port = self._ensure_sidecar(output_dir, concurrency)
            wait_message_at = 0.0
            while not self.stop_event.is_set():
                self._raise_if_sidecar_exited()
                idle_reset_completed = self._reset_cycle_after_idle(cycle_cooldown_seconds, cycle_limit)
                if idle_reset_completed:
                    sidecar_success = 0
                    cooldown_minutes = max(1, cycle_cooldown_seconds // 60)
                    add_event(
                        "info",
                        f"下载队列已连续空闲 {cooldown_minutes} 分钟，本轮 {idle_reset_completed} 个实际下载已重新计数；队列位置保持不变",
                    )
                    download_timing(
                        "cycle_idle_reset",
                        job_id=job_id,
                        profile_id=profile_id,
                        completed=idle_reset_completed,
                        cooldown_seconds=cycle_cooldown_seconds,
                    )
                if cycle_limit > 0 and sidecar_success >= cycle_limit:
                    self._enter_cycle_cooldown(
                        job_id,
                        concurrency,
                        target_limit,
                        profile_id,
                        watch_new,
                        sidecar_success,
                    )
                    cycle_pause_triggered = True
                    self.stop_event.set()
                    break
                remaining = None
                if target_limit > 0:
                    remaining = target_limit - (processed + len(active))
                    claim_allowed = max(0, remaining)
                else:
                    claim_allowed = max_active
                if cycle_limit > 0:
                    cycle_remaining = max(0, cycle_limit - sidecar_success - len(active))
                    claim_allowed = min(claim_allowed, cycle_remaining)

                capacity = min(max_active - len(active), claim_allowed)
                if capacity > 0:
                    links = self._claim_queue_batch(profile_id, capacity)
                    if links:
                        self._cancel_cycle_idle()
                        first_profile_id = int(links[0]["profile_id"] or profile_id)
                        if first_profile_id != profile_id:
                            profile_id = first_profile_id
                            with self.lock:
                                self.profile_id = profile_id
                        total += len(links)
                        update_job(job_id, total=total, message=f"下载中：已入队 {total} 条，处理中 {len(active)} 条")
                        done, ok, bad = self._submit_links(job_id, port, links, output_dir, active)
                        processed += done
                        success += ok
                        failed += bad
                        update_job(job_id, processed=processed, success=success, failed=failed)
                        if self._record_failure_guard_outcome(ok, bad):
                            self._enter_failure_guard(job_id, concurrency, target_limit, profile_id, watch_new)
                            guard_triggered = True
                            self.stop_event.set()
                            break

                done, ok, bad = self._poll_active_sidecar_jobs(job_id, port, active, output_dir)
                if done:
                    processed += done
                    success += ok
                    failed += bad
                    sidecar_success += ok
                    with self.lock:
                        self.cycle_sidecar_success = sidecar_success
                        if ok > 0:
                            self.cycle_idle_since = None
                    update_job(job_id, processed=processed, success=success, failed=failed)
                    if self._record_failure_guard_outcome(ok, bad):
                        self._enter_failure_guard(job_id, concurrency, target_limit, profile_id, watch_new)
                        guard_triggered = True
                        self.stop_event.set()
                        break

                if active:
                    self._cancel_cycle_idle()
                    time.sleep(0.8)
                    continue
                if target_limit > 0 and processed >= target_limit:
                    break
                pending = self._queue_pending_count()
                if pending > 0:
                    self._cancel_cycle_idle()
                    continue
                if not watch_new:
                    break
                self._begin_cycle_idle()
                if time.time() - wait_message_at > 5:
                    update_job(
                        job_id,
                        message=f"等待新链接：已处理 {processed} 条，sidecar 端口 {port}",
                    )
                    wait_message_at = time.time()
                time.sleep(1.0)
        except Exception as exc:
            download_timing("supervisor_error", job_id=job_id, profile_id=profile_id, error=str(exc)[:1000])
            add_event("error", f"sidecar 下载任务异常：{exc}")
            update_job(job_id, status="failed", finished_at=now_iso(), message=str(exc)[:2000])
            self._reset_active_jobs("sidecar 异常，已重置为待下载")
            return
        finally:
            if self.stop_event.is_set():
                stopped = True
                self._stop_sidecar_process()
                for link in active.values():
                    self._mark_pending(link, "下载被停止，等待下次继续")
                active.clear()
            with self.lock:
                self.active = False
                self.active_jobs.clear()
                self.active_job_started.clear()

        if self._job_status(job_id) == "running":
            update_job(
                job_id,
                status="stopped" if stopped else "complete",
                finished_at=now_iso(),
                total=total,
                processed=processed,
                success=success,
                failed=failed,
                message=(
                    "主动分段暂停，等待自动恢复"
                    if cycle_pause_triggered
                    else "保护暂停，等待换 IP 或自动恢复"
                    if guard_triggered
                    else "已停止"
                    if stopped
                    else "下载队列处理完成"
                ),
            )
        add_event(
            "warn" if guard_triggered else "info",
            "下载主动休息" if cycle_pause_triggered else "下载保护暂停" if guard_triggered else ("下载任务已停止" if stopped else "下载任务完成"),
        )
        download_timing(
            "supervisor_done",
            job_id=job_id,
            profile_id=profile_id,
            stopped=stopped,
            guard_triggered=guard_triggered,
            cycle_pause_triggered=cycle_pause_triggered,
            sidecar_success=sidecar_success,
            cycle_limit=cycle_limit,
            total=total,
            processed=processed,
            success=success,
            failed=failed,
        )

    def _claim_batch(
        self,
        profile_id: int,
        limit: int,
        quality_only: bool = False,
    ) -> list[sqlite3.Row]:
        if limit <= 0:
            return []
        sql_limit = "LIMIT ?"
        params: list[Any] = [profile_id]
        quality_filter = ""
        if quality_only:
            quality_filter = " AND download_intent=?"
            params.append(QUALITY_UPGRADE_INTENT)
        params.append(limit)
        with db() as conn:
            rows = conn.execute(
                f"SELECT * FROM links WHERE status='pending' AND profile_id=?{quality_filter} "
                f"ORDER BY {DOWNLOAD_QUEUE_ORDER} {sql_limit}",
                params,
            ).fetchall()
            ids = [row["id"] for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                claimed_at = now_iso()
                conn.execute(
                    f"UPDATE links SET status='downloading', attempts=attempts+1, last_started_at=?, failed_at=NULL, last_error=NULL "
                    f"WHERE id IN ({placeholders})",
                    [claimed_at, *ids],
                )
                quality_aweme_ids = [
                    str(row["aweme_id"])
                    for row in rows
                    if row_text(row, "download_intent") == QUALITY_UPGRADE_INTENT
                ]
                if quality_aweme_ids:
                    quality_placeholders = ",".join("?" for _ in quality_aweme_ids)
                    conn.execute(
                        f"UPDATE video_quality_audit_items SET redownload_status='downloading', updated_at=? "
                        f"WHERE aweme_id IN ({quality_placeholders}) AND upgrade_available=1 "
                        f"AND redownload_status='queued'",
                        [claimed_at, *quality_aweme_ids],
                    )
        if rows:
            download_timing(
                "claim_batch",
                profile_id=profile_id,
                count=len(rows),
                first_link_id=rows[0]["id"],
                first_aweme_id=rows[0]["aweme_id"],
                last_link_id=rows[-1]["id"],
                last_aweme_id=rows[-1]["aweme_id"],
            )
        return rows

    def _claim_quality_queue_batch(self, limit: int) -> list[sqlite3.Row]:
        if limit <= 0:
            return []
        with db() as conn:
            sync_download_queue(conn)
            rows = conn.execute(
                """
                SELECT links.*
                FROM links
                JOIN profile_download_queue q ON q.profile_id=links.profile_id
                WHERE q.enabled=1
                  AND links.status='pending'
                  AND links.download_intent=?
                ORDER BY
                  COALESCE(links.digg_count, 0) DESC,
                  CASE WHEN links.create_time IS NULL THEN 1 ELSE 0 END,
                  links.create_time DESC,
                  links.last_seen_at DESC,
                  links.id DESC
                LIMIT ?
                """,
                (QUALITY_UPGRADE_INTENT, limit),
            ).fetchall()
            ids = [int(row["id"]) for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                claimed_at = now_iso()
                conn.execute(
                    f"UPDATE links SET status='downloading', attempts=attempts+1, "
                    f"last_started_at=?, failed_at=NULL, last_error=NULL "
                    f"WHERE id IN ({placeholders})",
                    [claimed_at, *ids],
                )
                aweme_ids = [str(row["aweme_id"]) for row in rows]
                aweme_placeholders = ",".join("?" for _ in aweme_ids)
                conn.execute(
                    f"UPDATE video_quality_audit_items SET redownload_status='downloading', updated_at=? "
                    f"WHERE aweme_id IN ({aweme_placeholders}) "
                    f"AND redownload_status='queued'",
                    [claimed_at, *aweme_ids],
                )
        if rows:
            download_timing(
                "claim_quality_queue_batch",
                count=len(rows),
                highest_digg_count=int(rows[0]["digg_count"] or 0),
                lowest_digg_count=int(rows[-1]["digg_count"] or 0),
                first_aweme_id=rows[0]["aweme_id"],
                last_aweme_id=rows[-1]["aweme_id"],
            )
        return rows

    def _claim_queue_batch(self, preferred_profile_id: int | None, limit: int) -> list[sqlite3.Row]:
        if limit <= 0:
            return []
        profile_ids: list[int] = []
        with db() as conn:
            sync_download_queue(conn)
            rows = conn.execute(
                """
                SELECT q.profile_id
                FROM profile_download_queue q
                WHERE q.enabled=1
                  AND EXISTS (
                    SELECT 1 FROM links
                    WHERE links.profile_id=q.profile_id AND links.status='pending'
                  )
                ORDER BY
                  CASE WHEN EXISTS (
                    SELECT 1 FROM links quality_links
                    WHERE quality_links.profile_id=q.profile_id
                      AND quality_links.status='pending'
                      AND quality_links.download_intent='quality_upgrade'
                  ) THEN 0 ELSE 1 END,
                  q.sort_order,
                  q.profile_id
                """,
            ).fetchall()
            profile_ids.extend(int(row["profile_id"]) for row in rows if int(row["profile_id"]) not in profile_ids)

        # Quality repairs share the ordinary queue, but are claimed globally by
        # like count so the most valuable videos are repaired first regardless
        # of which author profile owns them.
        claimed: list[sqlite3.Row] = self._claim_quality_queue_batch(limit)
        for profile_id in profile_ids:
            remaining = limit - len(claimed)
            if remaining <= 0:
                break
            claimed.extend(self._claim_batch(profile_id, remaining))
        if claimed:
            profile_counts: dict[str, int] = {}
            for link in claimed:
                key = str(link["profile_id"] or "")
                profile_counts[key] = profile_counts.get(key, 0) + 1
            download_timing(
                "claim_queue_batch",
                preferred_profile_id=preferred_profile_id,
                count=len(claimed),
                profiles=profile_counts,
            )
        return claimed

    def _pending_count(self, profile_id: int) -> int:
        with db() as conn:
            return int(
                conn.execute(
                    "SELECT COUNT(*) c FROM links WHERE status='pending' AND profile_id=?",
                    (profile_id,),
                ).fetchone()["c"]
            )

    def _queue_pending_count(self) -> int:
        with db() as conn:
            return queue_pending_count(conn)


download_manager = SidecarDownloadManager()
