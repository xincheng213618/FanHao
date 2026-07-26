"""Sidecar process lifecycle, submission, and polling behavior."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import time
from pathlib import Path

from .common import elapsed_ms, normalize_proxy, now_iso, row_text, tail_text
from .config import GALLERY_MUSIC_INTENT, LOG_DIR, QUALITY_UPGRADE_INTENT
from .database import add_event, db, failure_guard_threshold, is_antibot_error, setting
from .domain_manifest import download_record_hash, existing_downloaded_work, manifest_has
from .downloader_client import downloader_command, free_port, sidecar_json, write_sidecar_config
from .runtime import download_timing


def completed_record_from_state(state: dict, aweme_id: str) -> dict | None:
    records = state.get("records")
    if not isinstance(records, list):
        return None
    target = str(aweme_id or "")
    for record in reversed(records):
        if isinstance(record, dict) and str(record.get("aweme_id") or "") == target:
            return record
    return None


class SidecarRuntimeMixin:
    def _start_download_attempt(
        self,
        job_id: int,
        sidecar_job_id: str,
        link: sqlite3.Row,
    ) -> None:
        with db() as conn:
            conn.execute(
                """
                INSERT INTO download_attempts(
                  aweme_id, link_id, profile_id, job_id, sidecar_job_id,
                  status, started_at
                )
                VALUES(?, ?, ?, ?, ?, 'running', ?)
                """,
                (
                    str(link["aweme_id"]),
                    int(link["id"]),
                    int(link["profile_id"]) if link["profile_id"] is not None else None,
                    int(job_id),
                    sidecar_job_id,
                    now_iso(),
                ),
            )

    def _finish_download_attempt(
        self,
        sidecar_job_id: str,
        status: str,
        *,
        error: str = "",
        record: dict | None = None,
    ) -> None:
        record_hash = download_record_hash(record) if record else None
        with db() as conn:
            conn.execute(
                """
                UPDATE download_attempts SET
                  status=?, error=?, finished_at=?, record_hash=?
                WHERE id=(
                  SELECT id FROM download_attempts
                  WHERE sidecar_job_id=?
                  ORDER BY id DESC
                  LIMIT 1
                )
                """,
                (
                    status,
                    error[:2000] or None,
                    now_iso(),
                    record_hash,
                    sidecar_job_id,
                ),
            )

    def _ensure_sidecar(self, output_dir: str, concurrency: int) -> int:
        proxy = normalize_proxy(setting("download_proxy", ""))
        signature = (str(Path(output_dir).resolve()), concurrency, proxy)
        with self.lock:
            proc = self.sidecar_proc
            port = self.sidecar_port
            if proc is not None and proc.poll() is None and port and self.sidecar_signature == signature:
                download_timing("sidecar_reuse", port=port, concurrency=concurrency, output_dir=output_dir, proxy=proxy)
                return port

        download_timing("sidecar_restart_needed", concurrency=concurrency, output_dir=output_dir, proxy=proxy)
        self._stop_sidecar_process()
        port = self._start_sidecar(output_dir, concurrency)
        with self.lock:
            self.sidecar_signature = signature
        return port

    def _start_sidecar(self, output_dir: str, concurrency: int) -> int:
        config_path = write_sidecar_config(output_dir, concurrency)
        port = free_port()
        command, downloader_cwd = downloader_command(
            [
                "--serve",
                "--config",
                str(config_path),
                "--serve-host",
                "127.0.0.1",
                "--serve-port",
                str(port),
            ]
        )
        stamp = int(time.time())
        started = time.monotonic()
        log_path = LOG_DIR / f"sidecar-{stamp}.log"
        err_path = LOG_DIR / f"sidecar-{stamp}.err.log"
        env = os.environ.copy()
        env.update(
            {
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8:replace",
                "PYTHONLEGACYWINDOWSSTDIO": "0",
                "DOUYIN_TIMING_DIR": str(LOG_DIR),
            }
        )
        download_timing(
            "sidecar_start_begin",
            port=port,
            concurrency=concurrency,
            output_dir=output_dir,
            config_path=str(config_path),
        )
        stdout = log_path.open("ab")
        stderr = err_path.open("ab")
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(downloader_cwd),
                stdout=stdout,
                stderr=stderr,
                env=env,
            )
        finally:
            stdout.close()
            stderr.close()

        with self.lock:
            self.sidecar_proc = proc
            self.sidecar_port = port
        try:
            deadline = time.time() + 30
            while time.time() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError(f"sidecar 启动失败，退出码 {proc.returncode}: {tail_text(err_path, 1200)}")
                try:
                    sidecar_json(port, "GET", "/api/v1/health")
                    proxy_text = f"，代理 {normalize_proxy(setting('download_proxy', ''))}" if normalize_proxy(setting("download_proxy", "")) else ""
                    add_event("info", f"sidecar 已启动：端口 {port}，并发 {concurrency}{proxy_text}")
                    download_timing(
                        "sidecar_start_ready",
                        port=port,
                        concurrency=concurrency,
                        output_dir=output_dir,
                        startup_ms=elapsed_ms(started),
                    )
                    return port
                except Exception:
                    time.sleep(0.5)
            raise RuntimeError(f"sidecar 启动超时: {tail_text(err_path, 1200)}")
        except Exception:
            self._stop_sidecar_process()
            raise

    def _submit_links(
        self,
        job_id: int,
        port: int,
        links: list[sqlite3.Row],
        output_dir: str,
        active: dict[str, sqlite3.Row],
    ) -> tuple[int, int, int]:
        processed = success = failed = 0
        for link in links:
            download_intent = row_text(link, "download_intent")
            music_backfill = download_intent == GALLERY_MUSIC_INTENT
            forced_redownload = download_intent in {GALLERY_MUSIC_INTENT, QUALITY_UPGRADE_INTENT}
            submit_started = time.monotonic()
            download_timing(
                "submit_begin",
                job_id=job_id,
                link_id=link["id"],
                profile_id=link["profile_id"],
                aweme_id=link["aweme_id"],
                url=link["url"],
                active_before=len(active),
            )
            if self.stop_event.is_set():
                self._mark_pending(link, "下载被停止，等待下次继续")
                download_timing(
                    "submit_cancelled",
                    job_id=job_id,
                    link_id=link["id"],
                    aweme_id=link["aweme_id"],
                    elapsed_ms=elapsed_ms(submit_started),
                )
                continue
            if not forced_redownload and manifest_has(output_dir, link["aweme_id"]):
                reused = self._mark_downloaded(
                    link,
                    output_dir,
                    "复用当前主页已有文件",
                    verify_reused=True,
                    continue_download=True,
                )
                if reused:
                    download_timing(
                        "skip_manifest",
                        job_id=job_id,
                        link_id=link["id"],
                        profile_id=link["profile_id"],
                        aweme_id=link["aweme_id"],
                        elapsed_ms=elapsed_ms(submit_started),
                    )
                    processed += 1
                    success += 1
                    continue
                forced_redownload = True
                download_timing(
                    "reuse_requires_redownload",
                    job_id=job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    source="manifest",
                    elapsed_ms=elapsed_ms(submit_started),
                )
            existing = None if forced_redownload else existing_downloaded_work(link["aweme_id"], link["id"])
            if existing:
                reused = self._mark_downloaded(
                    link,
                    existing["output_dir"],
                    f"复用已下载文件 #{existing['source_link_id']}",
                    existing["record"],
                    verify_reused=True,
                    continue_download=True,
                )
                if reused:
                    download_timing(
                        "reuse_downloaded",
                        job_id=job_id,
                        link_id=link["id"],
                        profile_id=link["profile_id"],
                        aweme_id=link["aweme_id"],
                        source_link_id=existing["source_link_id"],
                        source_profile_id=existing["source_profile_id"],
                        elapsed_ms=elapsed_ms(submit_started),
                    )
                    processed += 1
                    success += 1
                    continue
                forced_redownload = True
                download_timing(
                    "reuse_requires_redownload",
                    job_id=job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    source="downloaded_link",
                    source_link_id=existing["source_link_id"],
                    elapsed_ms=elapsed_ms(submit_started),
                )
            try:
                resp = sidecar_json(port, "POST", "/api/v1/download", {"url": link["url"]})
                sidecar_job_id = str(resp["job_id"])
                active[sidecar_job_id] = link
                with self.lock:
                    self.active_jobs[sidecar_job_id] = link
                    self.active_job_started[sidecar_job_id] = time.monotonic()
                self._start_download_attempt(job_id, sidecar_job_id, link)
                download_timing(
                    "submit_ok",
                    job_id=job_id,
                    sidecar_job_id=sidecar_job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    submit_ms=elapsed_ms(submit_started),
                    active_after=len(active),
                )
            except Exception as exc:
                if not forced_redownload and manifest_has(output_dir, link["aweme_id"]):
                    reused = self._mark_downloaded(
                        link,
                        output_dir,
                        "提交超时后复用当前主页已有文件",
                        verify_reused=True,
                    )
                    if not reused:
                        download_timing(
                            "submit_timeout_reuse_requeued",
                            job_id=job_id,
                            link_id=link["id"],
                            profile_id=link["profile_id"],
                            aweme_id=link["aweme_id"],
                            error=str(exc)[:500],
                            elapsed_ms=elapsed_ms(submit_started),
                        )
                        continue
                    download_timing(
                        "submit_timeout_manifest_found",
                        job_id=job_id,
                        link_id=link["id"],
                        profile_id=link["profile_id"],
                        aweme_id=link["aweme_id"],
                        error=str(exc)[:500],
                        elapsed_ms=elapsed_ms(submit_started),
                    )
                    processed += 1
                    success += 1
                    continue
                existing = None if forced_redownload else existing_downloaded_work(link["aweme_id"], link["id"])
                if existing:
                    reused = self._mark_downloaded(
                        link,
                        existing["output_dir"],
                        f"提交超时后复用已下载文件 #{existing['source_link_id']}",
                        existing["record"],
                        verify_reused=True,
                    )
                    if not reused:
                        download_timing(
                            "submit_timeout_reuse_requeued",
                            job_id=job_id,
                            link_id=link["id"],
                            profile_id=link["profile_id"],
                            aweme_id=link["aweme_id"],
                            source_link_id=existing["source_link_id"],
                            error=str(exc)[:500],
                            elapsed_ms=elapsed_ms(submit_started),
                        )
                        continue
                    download_timing(
                        "submit_timeout_reuse_downloaded",
                        job_id=job_id,
                        link_id=link["id"],
                        profile_id=link["profile_id"],
                        aweme_id=link["aweme_id"],
                        source_link_id=existing["source_link_id"],
                        source_profile_id=existing["source_profile_id"],
                        error=str(exc)[:500],
                        elapsed_ms=elapsed_ms(submit_started),
                    )
                    processed += 1
                    success += 1
                    continue
                if self._recover_sidecar_submission(port, link, active):
                    add_event("warn", f"{link['aweme_id']} 提交 sidecar 超时，但已找回运行中的 sidecar 任务")
                    download_timing(
                        "submit_recovered",
                        job_id=job_id,
                        link_id=link["id"],
                        profile_id=link["profile_id"],
                        aweme_id=link["aweme_id"],
                        error=str(exc)[:500],
                        elapsed_ms=elapsed_ms(submit_started),
                    )
                    continue
                self._mark_failed(link, f"提交 sidecar 任务失败：{exc}")
                download_timing(
                    "submit_failed",
                    job_id=job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    error=str(exc)[:1000],
                    elapsed_ms=elapsed_ms(submit_started),
                )
                processed += 1
                failed += 1
        return processed, success, failed

    def _recover_sidecar_submission(
        self,
        port: int,
        link: sqlite3.Row,
        active: dict[str, sqlite3.Row],
    ) -> bool:
        try:
            payload = sidecar_json(port, "GET", "/api/v1/jobs")
        except Exception:
            return False
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            return False
        matches = [
            job
            for job in jobs
            if str(job.get("url") or "") == str(link["url"])
            and str(job.get("status") or "") in {"running", "success", "failed"}
            and job.get("job_id")
        ]
        if not matches:
            return False
        matches.sort(key=lambda job: str(job.get("created_at") or ""))
        sidecar_job_id = str(matches[-1]["job_id"])
        active[sidecar_job_id] = link
        with self.lock:
            self.active_jobs[sidecar_job_id] = link
            self.active_job_started[sidecar_job_id] = time.monotonic()
        return True

    def _poll_active_sidecar_jobs(
        self,
        job_id: int,
        port: int,
        active: dict[str, sqlite3.Row],
        output_dir: str,
    ) -> tuple[int, int, int]:
        processed = success = failed = 0
        for sidecar_job_id, link in list(active.items()):
            try:
                state = sidecar_json(port, "GET", f"/api/v1/jobs/{sidecar_job_id}")
            except Exception:
                continue
            status = str(state.get("status") or "")
            if status not in {"success", "failed"}:
                continue
            completed_record = completed_record_from_state(state, str(link["aweme_id"]))
            active.pop(sidecar_job_id, None)
            with self.lock:
                self.active_jobs.pop(sidecar_job_id, None)
                started = self.active_job_started.pop(sidecar_job_id, None)
            sidecar_elapsed = elapsed_ms(started)
            if status == "success" and (
                int(state.get("success") or 0) > 0
                or completed_record is not None
                or manifest_has(output_dir, link["aweme_id"])
            ):
                mark_started = time.monotonic()
                marked_downloaded = self._mark_downloaded(
                    link,
                    output_dir,
                    "",
                    record=completed_record,
                )
                download_timing(
                    "sidecar_job_done",
                    job_id=job_id,
                    sidecar_job_id=sidecar_job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    status=status,
                    sidecar_total=state.get("total"),
                    sidecar_success=state.get("success"),
                    sidecar_failed=state.get("failed"),
                    sidecar_skipped=state.get("skipped"),
                    sidecar_elapsed_ms=sidecar_elapsed,
                    mark_ms=elapsed_ms(mark_started),
                    marked_downloaded=marked_downloaded,
                )
                if marked_downloaded:
                    self._finish_download_attempt(
                        sidecar_job_id,
                        "downloaded",
                        record=completed_record,
                    )
                    success += 1
                    processed += 1
                else:
                    self._finish_download_attempt(
                        sidecar_job_id,
                        "requeued",
                        error="下载结果未通过本地质量校验",
                        record=completed_record,
                    )
            else:
                error = state.get("error") or f"sidecar job {status}: {state}"
                error_text = str(error)
                anti_bot = is_antibot_error(error_text)
                if anti_bot:
                    self._mark_pending(link, f"详情接口疑似风控，等待换 IP 或冷却后重试：{error_text[:500]}")
                    with self.lock:
                        self.failure_guard_consecutive = max(
                            self.failure_guard_consecutive,
                            max(0, failure_guard_threshold() - 1),
                        )
                    add_event("warn", f"{link['aweme_id']} 详情接口疑似风控，已转回待下载")
                else:
                    self._mark_failed(link, error_text)
                self._finish_download_attempt(
                    sidecar_job_id,
                    "pending" if anti_bot else "failed",
                    error=error_text,
                    record=completed_record,
                )
                download_timing(
                    "sidecar_job_done",
                    job_id=job_id,
                    sidecar_job_id=sidecar_job_id,
                    link_id=link["id"],
                    profile_id=link["profile_id"],
                    aweme_id=link["aweme_id"],
                    status=status,
                    sidecar_total=state.get("total"),
                    sidecar_success=state.get("success"),
                    sidecar_failed=state.get("failed"),
                    sidecar_skipped=state.get("skipped"),
                    sidecar_elapsed_ms=sidecar_elapsed,
                    error=error_text[:1000],
                    anti_bot=anti_bot,
                )
                failed += 1
                processed += 1
        return processed, success, failed

    def _job_status(self, job_id: int) -> str | None:
        with db() as conn:
            row = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            return row["status"] if row else None

    def _raise_if_sidecar_exited(self) -> None:
        with self.lock:
            proc = self.sidecar_proc
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"sidecar 已退出，退出码 {proc.returncode}")

    def _reset_active_jobs(self, message: str) -> None:
        with self.lock:
            links = list(self.active_jobs.values())
            self.active_jobs.clear()
            self.active_job_started.clear()
        for link in links:
            self._mark_pending(link, message)

    def _stop_sidecar_process(self) -> None:
        with self.lock:
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
