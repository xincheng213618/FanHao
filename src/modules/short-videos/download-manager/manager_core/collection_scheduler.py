"""Persistent scheduler for periodic smart profile collection."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .common import normalize_int
from .database import add_event, set_setting, setting
from .extraction import start_refresh_profiles


AUTOMATIC_COLLECTION_ENABLED_SETTING = "automatic_collection_enabled"
AUTOMATIC_COLLECTION_INTERVAL_SETTING = "automatic_collection_interval_hours"
AUTOMATIC_COLLECTION_LAST_STARTED_SETTING = "automatic_collection_last_started_at"
AUTOMATIC_COLLECTION_NEXT_RUN_SETTING = "automatic_collection_next_run_at"

DEFAULT_AUTOMATIC_COLLECTION_INTERVAL_HOURS = 24
MIN_AUTOMATIC_COLLECTION_INTERVAL_HOURS = 1
MAX_AUTOMATIC_COLLECTION_INTERVAL_HOURS = 24 * 30


def _enabled_value(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _aware_datetime(value: datetime | None = None) -> datetime:
    current = value or datetime.now().astimezone()
    if current.tzinfo is None:
        return current.replace(tzinfo=timezone.utc).astimezone()
    return current.astimezone()


def _parse_datetime(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _aware_datetime(parsed)


def _iso_datetime(value: datetime) -> str:
    return _aware_datetime(value).isoformat(timespec="seconds")


class AutomaticCollectionScheduler:
    def __init__(
        self,
        submit_collection: Callable[[dict[str, Any]], dict[str, Any]] = start_refresh_profiles,
    ) -> None:
        self._submit_collection = submit_collection
        self._thread: threading.Thread | None = None
        self._thread_lock = threading.Lock()
        self._run_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()

    def _configuration(self) -> tuple[bool, int]:
        enabled = _enabled_value(setting(AUTOMATIC_COLLECTION_ENABLED_SETTING, "0"))
        interval_hours = normalize_int(
            setting(
                AUTOMATIC_COLLECTION_INTERVAL_SETTING,
                str(DEFAULT_AUTOMATIC_COLLECTION_INTERVAL_HOURS),
            ),
            DEFAULT_AUTOMATIC_COLLECTION_INTERVAL_HOURS,
            MIN_AUTOMATIC_COLLECTION_INTERVAL_HOURS,
            MAX_AUTOMATIC_COLLECTION_INTERVAL_HOURS,
        )
        return enabled, interval_hours

    def snapshot(self) -> dict[str, Any]:
        enabled, interval_hours = self._configuration()
        with self._thread_lock:
            running = self._thread is not None and self._thread.is_alive()
        return {
            "enabled": enabled,
            "interval_hours": interval_hours,
            "last_started_at": setting(AUTOMATIC_COLLECTION_LAST_STARTED_SETTING, "") or None,
            "next_run_at": setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, "") or None,
            "scheduler_running": running,
        }

    def reschedule(self, *, reset: bool = False, now: datetime | None = None) -> dict[str, Any]:
        enabled, interval_hours = self._configuration()
        current = _aware_datetime(now)
        if not enabled:
            if setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, ""):
                set_setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, "")
        else:
            next_run = _parse_datetime(setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, ""))
            if reset or next_run is None:
                set_setting(
                    AUTOMATIC_COLLECTION_NEXT_RUN_SETTING,
                    _iso_datetime(current + timedelta(hours=interval_hours)),
                )
        self._wake_event.set()
        return self.snapshot()

    def run_due_once(self, *, now: datetime | None = None) -> dict[str, Any]:
        with self._run_lock:
            enabled, interval_hours = self._configuration()
            current = _aware_datetime(now)
            if not enabled:
                return {"ok": True, "triggered": False, "reason": "disabled"}

            next_run = _parse_datetime(setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, ""))
            if next_run is None:
                next_run = current + timedelta(hours=interval_hours)
                set_setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, _iso_datetime(next_run))
                return {
                    "ok": True,
                    "triggered": False,
                    "reason": "scheduled",
                    "next_run_at": _iso_datetime(next_run),
                }
            if next_run > current:
                return {
                    "ok": True,
                    "triggered": False,
                    "reason": "waiting",
                    "next_run_at": _iso_datetime(next_run),
                }

            try:
                result = self._submit_collection({"automatic": True})
            except Exception as exc:
                retry_at = current + timedelta(minutes=5)
                set_setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, _iso_datetime(retry_at))
                add_event("error", f"定时智能采集启动失败：{exc}")
                return {
                    "ok": False,
                    "triggered": False,
                    "message": str(exc),
                    "next_run_at": _iso_datetime(retry_at),
                }

            if not bool(result.get("ok")):
                retry_at = current + timedelta(minutes=5)
                set_setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, _iso_datetime(retry_at))
                message = str(result.get("message") or "无法启动采集任务")
                add_event("warn", f"定时智能采集稍后重试：{message}")
                return {
                    "ok": False,
                    "triggered": False,
                    "message": message,
                    "next_run_at": _iso_datetime(retry_at),
                }

            started_at = _iso_datetime(current)
            next_run_at = _iso_datetime(current + timedelta(hours=interval_hours))
            set_setting(AUTOMATIC_COLLECTION_LAST_STARTED_SETTING, started_at)
            set_setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, next_run_at)
            job_id = int(result.get("job_id") or 0)
            queue_label = "已在队列中" if result.get("duplicate") else "已排队" if result.get("queued") else "已启动"
            add_event("info", f"定时智能采集{queue_label} #{job_id}；下次 {next_run_at}")
            return {
                "ok": True,
                "triggered": True,
                "job_id": job_id,
                "queued": bool(result.get("queued")),
                "duplicate": bool(result.get("duplicate")),
                "next_run_at": next_run_at,
            }

    def start(self) -> None:
        with self._thread_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
        self.reschedule(reset=False)
        with self._thread_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._run,
                daemon=True,
                name="douyin-automatic-collection",
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._wake_event.set()
        with self._thread_lock:
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        with self._thread_lock:
            if self._thread is thread and (thread is None or not thread.is_alive()):
                self._thread = None

    def _run(self) -> None:
        try:
            while not self._stop_event.is_set():
                self.run_due_once()
                enabled, _interval_hours = self._configuration()
                next_run = _parse_datetime(setting(AUTOMATIC_COLLECTION_NEXT_RUN_SETTING, ""))
                if enabled and next_run is not None:
                    remaining = max(1.0, (next_run - _aware_datetime()).total_seconds())
                    timeout = min(60.0, remaining)
                else:
                    timeout = 60.0
                self._wake_event.wait(timeout)
                self._wake_event.clear()
        finally:
            with self._thread_lock:
                if self._thread is threading.current_thread():
                    self._thread = None


automatic_collection_scheduler = AutomaticCollectionScheduler()
