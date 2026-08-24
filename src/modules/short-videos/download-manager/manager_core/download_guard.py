"""Failure guard and automatic-resume policy for download jobs."""

from __future__ import annotations

import json
import threading
import time

from .common import first_text, iso_from_timestamp, normalize_int
from .config import DOWNLOAD_GUARD_STATE_SETTING, FAILURE_GUARD_COOLDOWN_SECONDS, MAX_CONCURRENCY
from .database import add_event, download_cycle_cooldown_seconds, download_cycle_limit, failure_guard_threshold, set_setting, setting, update_job
from .runtime import download_timing


class DownloadGuardMixin:
    def _clear_failure_guard_locked(self) -> None:
        timer = self.auto_resume_timer
        if timer is not None:
            timer.cancel()
        self.failure_guard_until = None
        self.failure_guard_reason = ""
        self.failure_guard_kind = ""
        self.failure_guard_consecutive = 0
        self.auto_resume_config = None
        self.auto_resume_timer = None
        set_setting(DOWNLOAD_GUARD_STATE_SETTING, "{}")

    def restore_failure_guard(self) -> bool:
        try:
            state = json.loads(setting(DOWNLOAD_GUARD_STATE_SETTING, "{}") or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            state = {}
        until = float(state.get("until") or 0)
        if until <= time.time():
            set_setting(DOWNLOAD_GUARD_STATE_SETTING, "{}")
            return False
        concurrency = normalize_int(state.get("concurrency", setting("concurrency", "8")), 8, 1, MAX_CONCURRENCY)
        limit = normalize_int(state.get("limit", 0), 0, 0, 1000000)
        profile_id = normalize_int(state.get("profile_id", 0), 0, 0, 1000000) or None
        watch_new = bool(state.get("watch_new", True))
        remaining = max(0.1, until - time.time())
        with self.lock:
            self.failure_guard_until = until
            self.failure_guard_reason = first_text(state.get("reason"))
            self.failure_guard_kind = first_text(state.get("kind"), "failure_guard")
            self.failure_guard_consecutive = normalize_int(state.get("consecutive", 0), 0, 0, 1000000)
            self.auto_resume_config = (concurrency, limit, profile_id, watch_new)
            timer = threading.Timer(remaining, self._auto_resume_after_guard)
            timer.daemon = True
            self.auto_resume_timer = timer
            timer.start()
        add_event("info", f"已恢复下载保护暂停，{iso_from_timestamp(until)} 后自动重试")
        return True

    def _record_failure_guard_outcome(self, ok: int, bad: int) -> bool:
        if ok > 0:
            with self.lock:
                self.failure_guard_consecutive = 0
            return False
        if bad <= 0:
            return False
        threshold = failure_guard_threshold()
        if threshold <= 0:
            return False
        with self.lock:
            self.failure_guard_consecutive += bad
            return self.failure_guard_consecutive >= threshold

    def _enter_failure_guard(
        self,
        job_id: int,
        concurrency: int,
        limit: int,
        profile_id: int | None,
        watch_new: bool,
    ) -> None:
        consecutive = self.failure_guard_consecutive
        reason = f"连续 {consecutive} 次下载失败，疑似触发平台保护"
        until = self._schedule_auto_resume(
            concurrency,
            limit,
            profile_id,
            watch_new,
            FAILURE_GUARD_COOLDOWN_SECONDS,
            "failure_guard",
            reason,
        )
        message = f"连续 {consecutive} 次下载失败，已暂停下载；{iso_from_timestamp(until)} 后自动重试"
        add_event("warn", message)
        update_job(job_id, message=message)
        download_timing(
            "failure_guard_enter",
            job_id=job_id,
            profile_id=profile_id,
            concurrency=concurrency,
            consecutive=consecutive,
            cooldown_seconds=FAILURE_GUARD_COOLDOWN_SECONDS,
            resume_at=iso_from_timestamp(until),
        )

    def _enter_cycle_cooldown(
        self,
        job_id: int,
        concurrency: int,
        limit: int,
        profile_id: int | None,
        watch_new: bool,
        completed: int,
    ) -> None:
        cooldown_seconds = download_cycle_cooldown_seconds()
        cooldown_minutes = cooldown_seconds // 60
        reason = f"本轮已完成 {completed} 个实际下载，主动休息 {cooldown_minutes} 分钟"
        until = self._schedule_auto_resume(
            concurrency,
            limit,
            profile_id,
            watch_new,
            cooldown_seconds,
            "cycle_limit",
            reason,
        )
        message = f"{reason}；{iso_from_timestamp(until)} 后自动继续"
        add_event("info", message)
        update_job(job_id, message=message)
        download_timing(
            "cycle_cooldown_enter",
            job_id=job_id,
            profile_id=profile_id,
            concurrency=concurrency,
            completed=completed,
            cycle_limit=download_cycle_limit(),
            cooldown_seconds=cooldown_seconds,
            resume_at=iso_from_timestamp(until),
        )

    def _schedule_auto_resume(
        self,
        concurrency: int,
        limit: int,
        profile_id: int | None,
        watch_new: bool,
        cooldown_seconds: int,
        kind: str,
        reason: str,
    ) -> float:
        until = time.time() + cooldown_seconds
        with self.lock:
            self.failure_guard_until = until
            self.failure_guard_reason = reason
            self.failure_guard_kind = kind
            self.auto_resume_config = (concurrency, limit, profile_id, watch_new)
            if self.auto_resume_timer is not None:
                self.auto_resume_timer.cancel()
            timer = threading.Timer(cooldown_seconds, self._auto_resume_after_guard)
            timer.daemon = True
            self.auto_resume_timer = timer
            timer.start()
        set_setting(
            DOWNLOAD_GUARD_STATE_SETTING,
            json.dumps(
                {
                    "until": until,
                    "reason": reason,
                    "kind": kind,
                    "consecutive": self.failure_guard_consecutive,
                    "concurrency": concurrency,
                    "limit": limit,
                    "profile_id": profile_id,
                    "watch_new": watch_new,
                },
                ensure_ascii=False,
            ),
        )
        return until

    def _auto_resume_after_guard(self) -> None:
        with self.lock:
            config = self.auto_resume_config
            pause_kind = self.failure_guard_kind
            if self.active or not config:
                return
            concurrency, limit, profile_id, watch_new = config
            if self.failure_guard_until and time.time() < self.failure_guard_until:
                remaining = max(0.1, self.failure_guard_until - time.time())
                timer = threading.Timer(remaining, self._auto_resume_after_guard)
                timer.daemon = True
                self.auto_resume_timer = timer
                timer.start()
                return
            self.failure_guard_until = None
            self.failure_guard_reason = ""
            self.failure_guard_kind = ""
            self.failure_guard_consecutive = 0
            self.auto_resume_config = None
            self.auto_resume_timer = None
        set_setting(DOWNLOAD_GUARD_STATE_SETTING, "{}")
        add_event("info", "主动休息结束，自动恢复下载" if pause_kind == "cycle_limit" else "下载保护冷却结束，自动恢复下载")
        self.start(
            concurrency,
            retry_failed=False,
            limit=limit,
            profile_id=profile_id,
            watch_new=watch_new,
            manual=False,
        )
