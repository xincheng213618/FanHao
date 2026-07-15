"""Internal download state responsibilities for the download manager."""

from __future__ import annotations

import sqlite3
import subprocess
import threading
import time
from typing import Any

from .common import iso_from_timestamp, normalize_proxy, now_iso, row_text
from .config import GALLERY_MUSIC_INTENT, QUALITY_UPGRADE_INTENT
from .database import add_event, db, download_cycle_cooldown_seconds, download_cycle_limit, failure_guard_threshold, setting
from .domain_manifest import manifest_has_gallery_music, manifest_record, sync_manifest_files, work_metadata_from_record
from .media_quality import reused_record_with_current_source, validate_downloaded_video_quality
from .queue import ensure_profile_in_download_queue


class DownloadManager:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.active = False
        self.job_id: int | None = None
        self.supervisor: threading.Thread | None = None
        self.sidecar_proc: subprocess.Popen[Any] | None = None
        self.sidecar_port: int | None = None
        self.active_jobs: dict[str, sqlite3.Row] = {}
        self.limit = 0
        self.profile_id: int | None = None
        self.failure_guard_until: float | None = None
        self.failure_guard_reason = ""
        self.failure_guard_kind = ""
        self.failure_guard_consecutive = 0
        self.cycle_sidecar_success = 0
        self.auto_resume_config: tuple[int, int, int | None, bool] | None = None
        self.auto_resume_timer: threading.Timer | None = None

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "active": self.active,
                "job_id": self.job_id,
                "profile_id": self.profile_id,
                "processes": len(self.active_jobs),
                "inflight": len(self.active_jobs),
                "sidecar_port": self.sidecar_port,
                "proxy": normalize_proxy(setting("download_proxy", "")),
                "watch_new": getattr(self, "watch_new", False),
                "failure_guard": {
                    "active": bool(self.failure_guard_until and time.time() < self.failure_guard_until),
                    "until": iso_from_timestamp(self.failure_guard_until),
                    "remaining_seconds": max(0, int((self.failure_guard_until or 0) - time.time())),
                    "reason": self.failure_guard_reason,
                    "kind": self.failure_guard_kind,
                    "consecutive": self.failure_guard_consecutive,
                    "threshold": failure_guard_threshold(),
                },
                "cycle": {
                    "completed": self.cycle_sidecar_success,
                    "limit": download_cycle_limit(),
                    "cooldown_minutes": download_cycle_cooldown_seconds() // 60,
                },
            }

    def _mark_downloaded(
        self,
        link: sqlite3.Row,
        output_dir: str,
        note: str,
        record: dict[str, Any] | None = None,
        verify_reused: bool = False,
        continue_download: bool = False,
    ) -> bool:
        record = record or manifest_record(output_dir, link["aweme_id"])
        if verify_reused:
            record = reused_record_with_current_source(link, record)
        quality_ok, quality_error, quality_note, actual_video = validate_downloaded_video_quality(
            link,
            output_dir,
            record,
            require_source_dimensions=verify_reused,
        )
        if not quality_ok:
            queued_at = now_iso()
            with db() as conn:
                conn.execute(
                    """
                    UPDATE links SET
                      status=?, download_intent=?, failed_at=NULL,
                      last_started_at=CASE WHEN ? THEN last_started_at ELSE NULL END,
                      last_error=?
                    WHERE id=?
                    """,
                    (
                        "downloading" if continue_download else "pending",
                        QUALITY_UPGRADE_INTENT,
                        1 if continue_download else 0,
                        quality_error[:2000],
                        link["id"],
                    ),
                )
                ensure_profile_in_download_queue(conn, int(link["profile_id"] or 0))
                conn.execute(
                    """
                    UPDATE video_quality_audit_items SET
                      upgrade_available=1, redownload_status=?,
                      queued_at=COALESCE(queued_at, ?), updated_at=?
                    WHERE aweme_id=? AND redownload_status IN ('queued', 'downloading')
                    """,
                    (
                        "downloading" if continue_download else "queued",
                        queued_at,
                        queued_at,
                        str(link["aweme_id"]),
                    ),
                )
            add_event("warn", f"{link['aweme_id']} {quality_error[:300]}")
            return False
        if quality_note:
            note = f"{note}；{quality_note}" if note else quality_note
        metadata = work_metadata_from_record(record, output_dir) if record else {}
        with db() as conn:
            fresh_intent_row = conn.execute(
                "SELECT download_intent FROM links WHERE id=?",
                (link["id"],),
            ).fetchone()
        download_intent = row_text(fresh_intent_row, "download_intent") or row_text(link, "download_intent")
        music_backfill = download_intent == GALLERY_MUSIC_INTENT
        clear_download_intent = download_intent in {GALLERY_MUSIC_INTENT, QUALITY_UPGRADE_INTENT}
        music_status = None
        music_checked_at = None
        if music_backfill:
            music_status = "downloaded" if manifest_has_gallery_music(record) else "unavailable"
            music_checked_at = now_iso()
        completed_at = now_iso()
        with db() as conn:
            conn.execute(
                """
                UPDATE links SET
                  status='downloaded',
                  downloaded_at=?,
                  failed_at=NULL,
                  output_dir=?,
                  last_error=?,
                  desc=COALESCE(?, desc),
                  media_type=COALESCE(?, media_type),
                  create_time=COALESCE(?, create_time),
                  local_file_names=COALESCE(?, local_file_names),
                  local_file_paths=COALESCE(?, local_file_paths),
                  local_cover_path=COALESCE(?, local_cover_path),
                  preview_path=COALESCE(?, preview_path),
                  metadata_json=COALESCE(?, metadata_json),
                  actual_width=COALESCE(?, actual_width),
                  actual_height=COALESCE(?, actual_height),
                  actual_bit_rate=COALESCE(?, actual_bit_rate),
                  actual_codec=COALESCE(?, actual_codec),
                  actual_frame_rate=COALESCE(?, actual_frame_rate),
                  actual_pixels=COALESCE(?, actual_pixels),
                  actual_long_edge=COALESCE(?, actual_long_edge),
                  actual_probed_at=COALESCE(?, actual_probed_at),
                  actual_probe_error=COALESCE(?, actual_probe_error),
                  music_id=COALESCE(?, music_id),
                  music_title=COALESCE(?, music_title),
                  music_author=COALESCE(?, music_author),
                  music_cover_url=COALESCE(?, music_cover_url),
                  music_play_url=COALESCE(?, music_play_url),
                  local_music_path=COALESCE(?, local_music_path),
                  gallery_music_status=COALESCE(?, gallery_music_status),
                  gallery_music_checked_at=COALESCE(?, gallery_music_checked_at),
                  download_intent=CASE WHEN ? THEN NULL ELSE download_intent END
                WHERE id=?
                """,
                (
                    completed_at,
                    output_dir,
                    note or None,
                    metadata.get("desc") or None,
                    metadata.get("media_type") or None,
                    metadata.get("create_time"),
                    metadata.get("local_file_names") or None,
                    metadata.get("local_file_paths") or None,
                    metadata.get("local_cover_path") or None,
                    metadata.get("preview_path") or None,
                    metadata.get("metadata_json") or None,
                    int(actual_video.get("width") or 0) or None if actual_video else None,
                    int(actual_video.get("height") or 0) or None if actual_video else None,
                    int(actual_video.get("bit_rate") or 0) or None if actual_video else None,
                    str(actual_video.get("codec") or "").strip() or None if actual_video else None,
                    float(actual_video.get("frame_rate") or 0) or None if actual_video else None,
                    int(actual_video.get("pixels") or 0) or None if actual_video else None,
                    int(actual_video.get("long_edge") or 0) or None if actual_video else None,
                    str(actual_video.get("probed_at") or "").strip() or None if actual_video else None,
                    str(actual_video.get("error") or "") if actual_video else None,
                    metadata.get("music_id") or None,
                    metadata.get("music_title") or None,
                    metadata.get("music_author") or None,
                    metadata.get("music_cover_url") or None,
                    metadata.get("music_play_url") or None,
                    metadata.get("local_music_path") or None,
                    music_status,
                    music_checked_at,
                    1 if clear_download_intent else 0,
                    link["id"],
                ),
            )
            if download_intent == QUALITY_UPGRADE_INTENT:
                conn.execute(
                    """
                    UPDATE video_quality_audit_items SET
                      redownload_status='completed', completed_at=?, updated_at=?
                    WHERE aweme_id=?
                      AND upgrade_available=1
                      AND redownload_status IN ('queued', 'downloading')
                    """,
                    (completed_at, completed_at, str(link["aweme_id"])),
                )
            if music_backfill:
                conn.execute(
                    """
                    UPDATE links SET
                      local_file_names=COALESCE(?, local_file_names),
                      local_file_paths=COALESCE(?, local_file_paths),
                      local_cover_path=COALESCE(?, local_cover_path),
                      preview_path=COALESCE(?, preview_path),
                      metadata_json=COALESCE(?, metadata_json),
                      music_id=COALESCE(?, music_id),
                      music_title=COALESCE(?, music_title),
                      music_author=COALESCE(?, music_author),
                      music_cover_url=COALESCE(?, music_cover_url),
                      music_play_url=COALESCE(?, music_play_url),
                      local_music_path=COALESCE(?, local_music_path),
                      gallery_music_status=?,
                      gallery_music_checked_at=?
                    WHERE aweme_id=? AND id<>? AND status='downloaded'
                    """,
                    (
                        metadata.get("local_file_names") or None,
                        metadata.get("local_file_paths") or None,
                        metadata.get("local_cover_path") or None,
                        metadata.get("preview_path") or None,
                        metadata.get("metadata_json") or None,
                        metadata.get("music_id") or None,
                        metadata.get("music_title") or None,
                        metadata.get("music_author") or None,
                        metadata.get("music_cover_url") or None,
                        metadata.get("music_play_url") or None,
                        metadata.get("local_music_path") or None,
                        music_status,
                        music_checked_at,
                        link["aweme_id"],
                        link["id"],
                    ),
                )
            if record:
                profile_ids = [int(link["profile_id"])] if link["profile_id"] is not None else []
                if music_backfill:
                    profile_ids = [
                        int(row["profile_id"])
                        for row in conn.execute(
                            "SELECT DISTINCT profile_id FROM links WHERE aweme_id=? AND profile_id IS NOT NULL",
                            (link["aweme_id"],),
                        ).fetchall()
                    ]
                for profile_id in profile_ids:
                    sync_manifest_files(
                        conn,
                        profile_id,
                        str(link["aweme_id"]),
                        output_dir,
                        record,
                    )
        return True

    def _mark_failed(self, link: sqlite3.Row, error: str) -> None:
        download_intent = row_text(link, "download_intent")
        music_backfill = download_intent == GALLERY_MUSIC_INTENT
        failed_at = now_iso()
        with db() as conn:
            conn.execute(
                "UPDATE links SET status='failed', failed_at=?, last_error=?, "
                "gallery_music_status=CASE WHEN ? THEN 'failed' ELSE gallery_music_status END WHERE id=?",
                (failed_at, error[:2000], 1 if music_backfill else 0, link["id"]),
            )
            if download_intent == QUALITY_UPGRADE_INTENT:
                conn.execute(
                    """
                    UPDATE video_quality_audit_items SET
                      redownload_status='failed', updated_at=?
                    WHERE aweme_id=?
                      AND upgrade_available=1
                      AND redownload_status IN ('queued', 'downloading')
                    """,
                    (failed_at, str(link["aweme_id"])),
                )
        add_event("error", f"{link['aweme_id']} 下载失败：{error[:180]}")

    def _mark_pending(self, link: sqlite3.Row, error: str) -> None:
        with db() as conn:
            conn.execute(
                "UPDATE links SET status='pending', failed_at=NULL, last_error=? WHERE id=?",
                (error, link["id"]),
            )
