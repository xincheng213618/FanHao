from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


QUALITY_UPGRADE_INTENT = "quality_upgrade"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare downloaded Douyin video dimensions with the best currently available source."
    )
    parser.add_argument("--since", help="Downloaded-at lower bound, for example 2026-07-15")
    parser.add_argument(
        "--all-downloaded",
        action="store_true",
        help="Inspect every downloaded video regardless of date or like count, including confirmed upgrades already queued",
    )
    parser.add_argument(
        "--min-digg-count",
        type=int,
        default=0,
        help="Only inspect works at or above this like count",
    )
    parser.add_argument("--max-digg-count", type=int, default=0, help="Optionally cap the like-count range")
    parser.add_argument(
        "--max-current-long-edge",
        type=int,
        default=0,
        help="Optional local-resolution prefilter; 0 compares every matched file",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--apply", action="store_true", help="Queue confirmed upgrades for safe re-download")
    parser.add_argument(
        "--apply-existing-report",
        type=Path,
        help="Queue the confirmed upgrades in an existing audit report without querying Douyin again",
    )
    parser.add_argument(
        "--queue-failures-existing-report",
        type=Path,
        help="Queue confirmed upgrades plus source/probe failures from an existing report for highest-resolution retry",
    )
    parser.add_argument(
        "--import-existing-report",
        type=Path,
        help="Store an existing JSON report in the audit-history tables without re-downloading",
    )
    parser.add_argument(
        "--verify-existing-report",
        type=Path,
        help="FFprobe upgraded files and persist whether the expected resolution was reached",
    )
    parser.add_argument(
        "--retry-existing-report",
        type=Path,
        help="Retry only API failures in an existing report and merge the refreshed results",
    )
    parser.add_argument(
        "--retry-probe-errors-existing-report",
        type=Path,
        help="Retry only local FFprobe failures in an existing report and merge the refreshed results",
    )
    parser.add_argument(
        "--request-delay",
        type=float,
        default=0,
        help="Minimum delay in seconds between Douyin detail requests; useful for rate-limit recovery",
    )
    parser.add_argument(
        "--local-detail-only",
        action="store_true",
        help="Use saved *_data.json details only and skip Douyin API fallback",
    )
    parser.add_argument(
        "--write-actual-from-report",
        type=Path,
        help="Write locally probed dimensions from a report into FanHao short_videos",
    )
    parser.add_argument(
        "--backfill-playback-metadata",
        action="store_true",
        help="Probe local videos missing codec/frame-rate metadata without querying Douyin",
    )
    parser.add_argument(
        "--backfill-min-long-edge",
        type=int,
        default=2160,
        help="Minimum stored long edge for playback metadata backfill; defaults to the smooth-4K threshold",
    )
    parser.add_argument("--manager-db", type=Path)
    parser.add_argument("--fanhao-db", type=Path)
    parser.add_argument("--downloader-root", type=Path)
    parser.add_argument("--cookie-json", type=Path)
    parser.add_argument("--ffprobe", type=Path)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def iso_now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def resolve_paths(args: argparse.Namespace) -> Dict[str, Path]:
    manager_root = Path(__file__).resolve().parents[1]
    project_root = manager_root.parents[3]
    manager_db = (args.manager_db or manager_root / "data" / "douyin_downloads.sqlite").resolve()
    fanhao_db = (args.fanhao_db or project_root / "data" / "short-videos.sqlite").resolve()
    downloader_root = args.downloader_root
    if downloader_root is None and manager_db.is_file():
        with sqlite3.connect(str(manager_db)) as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='downloader_root'").fetchone()
        if row and str(row[0] or "").strip():
            downloader_root = Path(str(row[0]).strip())
    if downloader_root is None:
        downloader_root = project_root.parent / "Tool" / "douyin-downloader"
    cookie_json = args.cookie_json or manager_root / "data" / "configs" / ".cookies.json"
    report = args.report or manager_root / "data" / (
        "quality-audit-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"
    )
    ffprobe = args.ffprobe or (Path(shutil.which("ffprobe")) if shutil.which("ffprobe") else None)
    return {
        "manager_root": manager_root,
        "project_root": project_root,
        "manager_db": manager_db,
        "fanhao_db": fanhao_db,
        "downloader_root": downloader_root.resolve(),
        "cookie_json": cookie_json.resolve(),
        "ffprobe": ffprobe.resolve() if ffprobe else Path("ffprobe"),
        "report": report.resolve(),
    }


def normalize_since(value: str) -> str:
    value = value.strip()
    if len(value) == 10:
        return value + "T00:00:00+08:00"
    return value


def load_candidates(
    manager_db: Path,
    fanhao_db: Path,
    since: Optional[str],
    min_digg_count: int,
    max_digg_count: int,
    limit: int,
    include_quality_queue: bool = False,
) -> List[Dict[str, Any]]:
    with closing(sqlite3.connect(str(manager_db))) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("ATTACH DATABASE ? AS fanhao", (str(fanhao_db),))
        eligible_status = (
            "(l.status='downloaded' OR l.download_intent='quality_upgrade')"
            if include_quality_queue
            else "l.status='downloaded'"
        )
        eligible_latest_status = (
            "(l2.status='downloaded' OR l2.download_intent='quality_upgrade')"
            if include_quality_queue
            else "l2.status='downloaded'"
        )
        latest_order = (
            "CASE WHEN l2.download_intent='quality_upgrade' THEN 0 ELSE 1 END, "
            if include_quality_queue
            else ""
        )
        query = f"""
            SELECT l.id link_id, l.profile_id, l.aweme_id, l.url, l.downloaded_at,
                   MAX(COALESCE(l.digg_count, 0), COALESCE(sv.digg_count, 0)) digg_count,
                   sv.width metadata_width, sv.height metadata_height,
                   sv.source_path, sv.size_bytes
            FROM links l
            JOIN fanhao.short_videos sv ON sv.aweme_id=l.aweme_id
            WHERE {eligible_status}
              AND l.media_type='video'
              AND l.kind='video'
              AND COALESCE(sv.source_path, '')<>''
              AND l.id=(
                SELECT l2.id FROM links l2
                WHERE l2.aweme_id=l.aweme_id AND {eligible_latest_status}
                ORDER BY {latest_order}l2.downloaded_at DESC, l2.id DESC LIMIT 1
              )
        """
        params: List[Any] = []
        if since:
            query += " AND l.downloaded_at>=?"
            params.append(since)
        if min_digg_count > 0:
            query += " AND MAX(COALESCE(l.digg_count, 0), COALESCE(sv.digg_count, 0))>=?"
            params.append(min_digg_count)
        if max_digg_count > 0:
            query += " AND MAX(COALESCE(l.digg_count, 0), COALESCE(sv.digg_count, 0))<=?"
            params.append(max_digg_count)
        query += " ORDER BY l.downloaded_at DESC, l.id DESC"
        if limit > 0:
            query += " LIMIT ?"
            params.append(limit)
        return [dict(row) for row in conn.execute(query, params).fetchall()]


def load_playback_metadata_backfill_candidates(
    fanhao_db: Path,
    min_long_edge: int,
    limit: int,
) -> List[Dict[str, Any]]:
    with sqlite3.connect(str(fanhao_db), timeout=30) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=30000")
        ensure_fanhao_actual_video_columns(conn)
        query = """
            SELECT id, aweme_id, source_path, size_bytes,
                   actual_width current_width,
                   actual_height current_height,
                   actual_bit_rate current_bit_rate,
                   actual_codec current_codec,
                   actual_frame_rate current_frame_rate,
                   COALESCE(digg_count, 0) digg_count
            FROM short_videos
            WHERE media_type='video'
              AND COALESCE(source_path, '')<>''
              AND MAX(COALESCE(actual_long_edge, 0), COALESCE(actual_width, 0), COALESCE(actual_height, 0))>=?
              AND (COALESCE(actual_codec, '')='' OR COALESCE(actual_frame_rate, 0)<=0)
            ORDER BY COALESCE(digg_count, 0) DESC, id
        """
        params: List[Any] = [max(0, int(min_long_edge))]
        if limit > 0:
            query += " LIMIT ?"
            params.append(limit)
        return [dict(row) for row in conn.execute(query, params).fetchall()]


def ensure_fanhao_actual_video_columns(conn: sqlite3.Connection) -> None:
    columns = {row[1] for row in conn.execute("PRAGMA table_info(short_videos)").fetchall()}
    specs = {
        "actual_width": "INTEGER NOT NULL DEFAULT 0",
        "actual_height": "INTEGER NOT NULL DEFAULT 0",
        "actual_bit_rate": "INTEGER NOT NULL DEFAULT 0",
        "actual_codec": "TEXT NOT NULL DEFAULT ''",
        "actual_frame_rate": "REAL NOT NULL DEFAULT 0",
        "actual_pixels": "INTEGER NOT NULL DEFAULT 0",
        "actual_long_edge": "INTEGER NOT NULL DEFAULT 0",
        "actual_probed_at": "TEXT NOT NULL DEFAULT ''",
        "actual_probe_error": "TEXT NOT NULL DEFAULT ''",
    }
    for name, definition in specs.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE short_videos ADD COLUMN {name} {definition}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_short_videos_actual_pixels ON short_videos(actual_pixels DESC, id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_short_videos_actual_long_edge ON short_videos(actual_long_edge DESC, id)"
    )


def write_actual_video_metadata(
    fanhao_db: Path,
    items: List[Dict[str, Any]],
    probed_at: Optional[str] = None,
) -> int:
    timestamp = probed_at or iso_now()
    changed = 0
    with sqlite3.connect(str(fanhao_db), timeout=30) as conn:
        conn.execute("PRAGMA busy_timeout=30000")
        ensure_fanhao_actual_video_columns(conn)
        for item in items:
            verified_at = str(item.get("verified_at") or "")
            width = int(item.get("verified_width") or 0) if verified_at else int(item.get("current_width") or 0)
            height = int(item.get("verified_height") or 0) if verified_at else int(item.get("current_height") or 0)
            bit_rate = (
                int(item.get("verified_bit_rate") or 0)
                if verified_at
                else int(item.get("current_bit_rate") or 0)
            )
            codec = (
                str(item.get("verified_codec") or "")
                if verified_at
                else str(item.get("current_codec") or "")
            ).strip().lower()
            frame_rate = (
                float(item.get("verified_frame_rate") or 0)
                if verified_at
                else float(item.get("current_frame_rate") or 0)
            )
            error = str(item.get("probe_error") or "")
            if verified_at and str(item.get("verification_status") or "") == "probe_failed":
                error = str(item.get("verification_error") or error)
            cursor = conn.execute(
                """
                UPDATE short_videos SET
                  actual_width=?, actual_height=?, actual_bit_rate=?,
                  actual_codec=?, actual_frame_rate=?, actual_pixels=?,
                  actual_long_edge=?, actual_probed_at=?, actual_probe_error=?
                WHERE aweme_id=?
                """,
                (
                    width,
                    height,
                    bit_rate,
                    codec,
                    frame_rate,
                    width * height,
                    max(width, height),
                    verified_at or timestamp,
                    error,
                    str(item.get("aweme_id") or ""),
                ),
            )
            changed += int(cursor.rowcount or 0)
    return changed


def ffprobe_one(candidate: Dict[str, Any], ffprobe: Path) -> Dict[str, Any]:
    result = dict(candidate)

    def run_probe(probe_path: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                str(ffprobe),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate",
                "-of",
                "json",
                str(probe_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )

    try:
        source_path = Path(str(candidate["source_path"]))
        completed = run_probe(source_path)
        if completed.returncode != 0 and source_path.is_file() and os.name == "nt":
            short_root = next(
                (
                    parent
                    for parent in reversed(source_path.parents)
                    if str(parent) != source_path.anchor and len(str(parent)) <= 80
                ),
                source_path.parent,
            )
            probe_dir = short_root / ".fanhao-ffprobe"
            probe_path = probe_dir / f"probe-{uuid.uuid4().hex}{source_path.suffix or '.mp4'}"
            try:
                probe_dir.mkdir(parents=True, exist_ok=True)
                os.link(source_path, probe_path)
                completed = run_probe(probe_path)
            finally:
                probe_path.unlink(missing_ok=True)
                try:
                    probe_dir.rmdir()
                except OSError:
                    pass
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or "ffprobe failed").strip()[-300:])
        payload = json.loads(completed.stdout)
        stream = (payload.get("streams") or [None])[0]
        if not isinstance(stream, dict):
            raise RuntimeError("video stream unavailable")
        result["current_width"] = int(stream.get("width") or 0)
        result["current_height"] = int(stream.get("height") or 0)
        result["current_bit_rate"] = int(stream.get("bit_rate") or (payload.get("format") or {}).get("bit_rate") or 0)
        result["current_codec"] = str(stream.get("codec_name") or "").strip().lower()
        frame_rate_text = str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "").strip()
        frame_rate_parts = frame_rate_text.split("/", 1)
        try:
            result["current_frame_rate"] = float(frame_rate_parts[0]) / max(
                1.0, float(frame_rate_parts[1] if len(frame_rate_parts) > 1 else 1)
            )
        except (TypeError, ValueError, ZeroDivisionError):
            result["current_frame_rate"] = 0.0
        if not result["current_width"] or not result["current_height"]:
            raise RuntimeError("video dimensions unavailable")
        result["probe_error"] = ""
    except Exception as exc:
        result.update(
            {
                "current_width": 0,
                "current_height": 0,
                "current_bit_rate": 0,
                "current_codec": "",
                "current_frame_rate": 0.0,
                "probe_error": str(exc),
            }
        )
    return result


async def probe_candidates(
    candidates: List[Dict[str, Any]], ffprobe: Path, concurrency: int
) -> List[Dict[str, Any]]:
    semaphore = asyncio.Semaphore(max(1, min(16, concurrency)))

    async def probe(candidate: Dict[str, Any]) -> Dict[str, Any]:
        async with semaphore:
            return await asyncio.to_thread(ffprobe_one, candidate, ffprobe)

    tasks = [asyncio.create_task(probe(candidate)) for candidate in candidates]
    results: List[Dict[str, Any]] = []
    for index, task in enumerate(asyncio.as_completed(tasks), start=1):
        results.append(await task)
        if index == len(tasks) or index % 100 == 0:
            print(f"probed {index}/{len(tasks)}", flush=True)
    return results


def address_dimensions(address: Optional[Dict[str, Any]]) -> tuple[int, int]:
    if not isinstance(address, dict):
        return 0, 0
    try:
        return int(address.get("width") or 0), int(address.get("height") or 0)
    except (TypeError, ValueError):
        return 0, 0


def address_bit_rate(video: Dict[str, Any], address: Optional[Dict[str, Any]]) -> int:
    if not isinstance(address, dict):
        return 0
    for entry in video.get("bit_rate") or []:
        if not isinstance(entry, dict):
            continue
        play_addr = entry.get("play_addr")
        if play_addr is address or play_addr == address:
            try:
                return int(entry.get("bit_rate") or 0)
            except (TypeError, ValueError):
                return 0
    return 0


def highest_resolution_play_addr(video: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Select the largest saved source without importing the downloader runtime."""
    if not isinstance(video, dict):
        return None

    entries: List[tuple[int, int, int, Dict[str, Any]]] = []
    for entry in video.get("bit_rate") or []:
        if not isinstance(entry, dict):
            continue
        play_addr = entry.get("play_addr")
        if not isinstance(play_addr, dict):
            continue
        try:
            bit_rate = int(entry.get("bit_rate") or 0)
            width = int(play_addr.get("width") or entry.get("width") or 0)
            height = int(play_addr.get("height") or entry.get("height") or 0)
        except (TypeError, ValueError):
            continue
        entries.append((bit_rate, width, height, play_addr))
    if entries:
        entries.sort(key=lambda item: (-(item[1] * item[2]), -max(item[1], item[2]), -item[0]))
        return entries[0][3]

    primary = video.get("play_addr")
    if isinstance(primary, dict) and primary.get("uri"):
        return primary
    for key in ("play_addr_h264", "play_addr_265", "play_addr_256", "play_addr"):
        candidate = video.get(key)
        if isinstance(candidate, dict) and (candidate.get("uri") or candidate.get("url_list")):
            return candidate
    return None


def local_download_detail(candidate: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    source_path = Path(str(candidate.get("source_path") or ""))
    if not source_path.is_file():
        return None
    data_files = sorted(source_path.parent.glob("*_data.json"))
    for data_path in data_files:
        try:
            detail = json.loads(data_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        detail_aweme_id = str(detail.get("aweme_id") or "") if isinstance(detail, dict) else ""
        expected_aweme_id = str(candidate.get("aweme_id") or "")
        if detail_aweme_id and detail_aweme_id != expected_aweme_id:
            continue
        video = detail.get("video") if isinstance(detail, dict) else None
        if isinstance(video, dict) and (video.get("bit_rate") or video.get("play_addr")):
            return detail
    return None


async def audit_candidates(
    candidates: List[Dict[str, Any]],
    downloader_root: Path,
    cookie_json: Path,
    proxy: str,
    concurrency: int,
    request_delay: float = 0,
    allow_api: bool = True,
) -> List[Dict[str, Any]]:
    semaphore = asyncio.Semaphore(max(1, min(12, concurrency)))
    request_lock = asyncio.Lock()
    request_delay = max(0.0, float(request_delay or 0))

    async def collect(client: Any = None) -> List[Dict[str, Any]]:
        async def inspect(candidate: Dict[str, Any]) -> Dict[str, Any]:
            result = dict(candidate)
            current_width = int(candidate["current_width"] or 0)
            current_height = int(candidate["current_height"] or 0)
            try:
                detail = local_download_detail(candidate)
                detail_source = "local_data_json" if detail else "douyin_api"
                if not detail and allow_api:
                    if client is None:
                        raise RuntimeError("Douyin API client unavailable")
                    for attempt in range(3):
                        if request_delay > 0:
                            async with request_lock:
                                await asyncio.sleep(request_delay)
                                detail = await client.get_video_detail(str(candidate["aweme_id"]), suppress_error=True)
                        else:
                            async with semaphore:
                                detail = await client.get_video_detail(str(candidate["aweme_id"]), suppress_error=True)
                        if detail:
                            break
                        await asyncio.sleep(0.15 * (attempt + 1))
                if not detail:
                    raise RuntimeError("detail unavailable")
                video = detail.get("video") if isinstance(detail.get("video"), dict) else {}
                selected = highest_resolution_play_addr(video)
                target_width, target_height = address_dimensions(selected)
                target_bit_rate = address_bit_rate(video, selected)
                if not target_width or not target_height:
                    raise RuntimeError("source dimensions unavailable")
                current_pixels = current_width * current_height
                target_pixels = target_width * target_height
                result.update(
                    {
                        "target_width": target_width,
                        "target_height": target_height,
                        "target_bit_rate": target_bit_rate,
                        "detail_source": detail_source,
                        "current_pixels": current_pixels,
                        "target_pixels": target_pixels,
                        "upgrade": target_pixels > current_pixels,
                        "error": "",
                    }
                )
            except Exception as exc:
                result.update(
                    {
                        "target_width": 0,
                        "target_height": 0,
                        "target_bit_rate": 0,
                        "current_pixels": current_width * current_height,
                        "target_pixels": 0,
                        "upgrade": False,
                        "error": str(exc),
                    }
                )
            return result

        tasks = [asyncio.create_task(inspect(candidate)) for candidate in candidates]
        results: List[Dict[str, Any]] = []
        for index, task in enumerate(asyncio.as_completed(tasks), start=1):
            results.append(await task)
            if index == len(tasks) or index % 25 == 0:
                print(f"checked {index}/{len(tasks)}", flush=True)
        return sorted(results, key=lambda item: str(item.get("downloaded_at") or ""), reverse=True)

    if not allow_api:
        return await collect()

    sys.path.insert(0, str(downloader_root))
    from core.api_client import DouyinAPIClient

    cookies = json.loads(cookie_json.read_text(encoding="utf-8"))
    async with DouyinAPIClient(cookies, proxy=proxy) as client:
        return await collect(client)


AUDIT_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS video_quality_audit_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  since_at TEXT,
  min_digg_count INTEGER NOT NULL DEFAULT 0,
  max_digg_count INTEGER NOT NULL DEFAULT 0,
  max_current_long_edge INTEGER NOT NULL DEFAULT 0,
  downloaded_count INTEGER NOT NULL DEFAULT 0,
  probe_error_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  checked_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  upgrade_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  report_path TEXT,
  backup_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_quality_audit_runs_generated
  ON video_quality_audit_runs(generated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS video_quality_audit_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES video_quality_audit_runs(id) ON DELETE CASCADE,
  link_id INTEGER,
  profile_id INTEGER,
  aweme_id TEXT NOT NULL,
  digg_count INTEGER NOT NULL DEFAULT 0,
  source_path TEXT,
  downloaded_at TEXT,
  metadata_width INTEGER NOT NULL DEFAULT 0,
  metadata_height INTEGER NOT NULL DEFAULT 0,
  local_width INTEGER NOT NULL DEFAULT 0,
  local_height INTEGER NOT NULL DEFAULT 0,
  local_bit_rate INTEGER NOT NULL DEFAULT 0,
  local_size_bytes INTEGER NOT NULL DEFAULT 0,
  best_width INTEGER NOT NULL DEFAULT 0,
  best_height INTEGER NOT NULL DEFAULT 0,
  best_bit_rate INTEGER NOT NULL DEFAULT 0,
  local_pixels INTEGER NOT NULL DEFAULT 0,
  best_pixels INTEGER NOT NULL DEFAULT 0,
  audit_status TEXT NOT NULL,
  upgrade_available INTEGER NOT NULL DEFAULT 0,
  probe_error TEXT,
  api_error TEXT,
  redownload_status TEXT NOT NULL DEFAULT 'not_requested',
  queued_at TEXT,
  completed_at TEXT,
  verified_width INTEGER NOT NULL DEFAULT 0,
  verified_height INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  verification_status TEXT NOT NULL DEFAULT 'not_checked',
  verification_error TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, aweme_id)
);
CREATE INDEX IF NOT EXISTS idx_video_quality_audit_items_aweme
  ON video_quality_audit_items(aweme_id, run_id DESC);
CREATE INDEX IF NOT EXISTS idx_video_quality_audit_items_status
  ON video_quality_audit_items(audit_status, redownload_status, run_id DESC);
CREATE INDEX IF NOT EXISTS idx_video_quality_audit_items_digg
  ON video_quality_audit_items(digg_count DESC, run_id DESC);
"""


def ensure_audit_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(AUDIT_SCHEMA_SQL)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(video_quality_audit_items)").fetchall()}
    specs = {
        "verified_width": "INTEGER NOT NULL DEFAULT 0",
        "verified_height": "INTEGER NOT NULL DEFAULT 0",
        "verified_at": "TEXT",
        "verification_status": "TEXT NOT NULL DEFAULT 'not_checked'",
        "verification_error": "TEXT",
    }
    for name, definition in specs.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE video_quality_audit_items ADD COLUMN {name} {definition}")


def item_audit_status(item: Dict[str, Any]) -> str:
    explicit = str(item.get("audit_status") or "").strip()
    if explicit:
        return explicit
    if item.get("probe_error"):
        return "probe_failed"
    if item.get("skipped_reason"):
        return "skipped_threshold"
    if item.get("error"):
        return "source_unavailable"
    if item.get("upgrade"):
        return "upgrade_available"
    return "up_to_date"


def persist_audit_run(
    manager_db: Path,
    payload: Dict[str, Any],
    items: List[Dict[str, Any]],
    report_path: Path,
) -> int:
    now = iso_now()
    generated_at = str(payload.get("generated_at") or now)
    report_value = str(report_path.resolve())
    with sqlite3.connect(str(manager_db)) as conn:
        conn.row_factory = sqlite3.Row
        ensure_audit_schema(conn)
        existing = conn.execute(
            "SELECT id FROM video_quality_audit_runs WHERE generated_at=? AND report_path=? ORDER BY id LIMIT 1",
            (generated_at, report_value),
        ).fetchone()
        values = (
            generated_at,
            payload.get("since"),
            int(payload.get("min_digg_count") or 0),
            int(payload.get("max_digg_count") or 0),
            int(payload.get("max_current_long_edge") or 0),
            int(payload.get("downloaded_count") or 0),
            int(payload.get("probe_error_count") or 0),
            int(payload.get("candidate_count") or 0),
            int(payload.get("checked_count") or 0),
            int(payload.get("error_count") or 0),
            int(payload.get("upgrade_count") or 0),
            int(payload.get("applied_count") or 0),
            report_value,
            str(payload.get("backup_path") or "") or None,
        )
        if existing:
            run_id = int(existing["id"])
            conn.execute(
                """
                UPDATE video_quality_audit_runs SET
                  generated_at=?, since_at=?, min_digg_count=?, max_digg_count=?,
                  max_current_long_edge=?, downloaded_count=?, probe_error_count=?,
                  candidate_count=?, checked_count=?, error_count=?, upgrade_count=?,
                  applied_count=?, report_path=?, backup_path=?
                WHERE id=?
                """,
                (*values, run_id),
            )
            conn.execute("DELETE FROM video_quality_audit_items WHERE run_id=?", (run_id,))
        else:
            cursor = conn.execute(
                """
                INSERT INTO video_quality_audit_runs(
                  generated_at, since_at, min_digg_count, max_digg_count,
                  max_current_long_edge, downloaded_count, probe_error_count,
                  candidate_count, checked_count, error_count, upgrade_count,
                  applied_count, report_path, backup_path, created_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (*values, now),
            )
            run_id = int(cursor.lastrowid)

        for item in items:
            link_id = int(item.get("link_id") or 0)
            link = conn.execute(
                "SELECT status, download_intent, downloaded_at FROM links WHERE id=?",
                (link_id,),
            ).fetchone() if link_id else None
            upgrade = bool(item.get("upgrade") or item.get("queued_for_retry"))
            redownload_status = "not_needed" if not upgrade else "not_requested"
            queued_at = completed_at = None
            if upgrade and link:
                intent = str(link["download_intent"] or "")
                link_status = str(link["status"] or "")
                if intent == QUALITY_UPGRADE_INTENT and link_status == "pending":
                    redownload_status = "queued"
                    queued_at = now
                elif intent == QUALITY_UPGRADE_INTENT and link_status == "downloading":
                    redownload_status = "downloading"
                    queued_at = now
                elif intent == QUALITY_UPGRADE_INTENT and link_status == "failed":
                    redownload_status = "failed"
                elif int(payload.get("applied_count") or 0) > 0 and link_status == "downloaded":
                    redownload_status = "completed"
                    completed_at = str(link["downloaded_at"] or now)
            conn.execute(
                """
                INSERT INTO video_quality_audit_items(
                  run_id, link_id, profile_id, aweme_id, digg_count, source_path,
                  downloaded_at, metadata_width, metadata_height, local_width,
                  local_height, local_bit_rate, local_size_bytes, best_width,
                  best_height, best_bit_rate, local_pixels, best_pixels,
                  audit_status, upgrade_available, probe_error, api_error,
                  redownload_status, queued_at, completed_at, raw_json,
                  created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    link_id or None,
                    int(item.get("profile_id") or 0) or None,
                    str(item.get("aweme_id") or ""),
                    int(item.get("digg_count") or 0),
                    str(item.get("source_path") or "") or None,
                    str(item.get("downloaded_at") or "") or None,
                    int(item.get("metadata_width") or 0),
                    int(item.get("metadata_height") or 0),
                    int(item.get("current_width") or 0),
                    int(item.get("current_height") or 0),
                    int(item.get("current_bit_rate") or 0),
                    int(item.get("size_bytes") or 0),
                    int(item.get("target_width") or 0),
                    int(item.get("target_height") or 0),
                    int(item.get("target_bit_rate") or 0),
                    int(item.get("current_pixels") or 0),
                    int(item.get("target_pixels") or 0),
                    item_audit_status(item),
                    1 if upgrade else 0,
                    str(item.get("probe_error") or "") or None,
                    str(item.get("error") or "") or None,
                    redownload_status,
                    queued_at,
                    completed_at,
                    json.dumps(item, ensure_ascii=False, separators=(",", ":")),
                    now,
                    now,
                ),
            )
    return run_id


def manager_proxy(manager_db: Path) -> str:
    with closing(sqlite3.connect(str(manager_db))) as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='download_proxy'").fetchone()
    return str(row[0] or "").strip() if row else ""


def backup_database(manager_db: Path) -> Path:
    backup_dir = manager_db.parent / "quality-backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / (
        manager_db.stem + "-before-quality-upgrade-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".sqlite"
    )
    with closing(sqlite3.connect(str(manager_db))) as source, closing(
        sqlite3.connect(str(backup_path))
    ) as target:
        source.backup(target)
        check = target.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("database backup verification failed")
    return backup_path


def queue_upgrades(
    manager_db: Path,
    results: List[Dict[str, Any]],
    audit_run_id: int = 0,
    include_failures: bool = False,
) -> tuple[int, Path]:
    queueable: List[Dict[str, Any]] = []
    for item in results:
        confirmed_upgrade = bool(item.get("upgrade") and not item.get("error") and not item.get("probe_error"))
        failed_audit = bool(item.get("error") or item.get("probe_error"))
        if not confirmed_upgrade and not (include_failures and failed_audit):
            continue
        item["queued_for_retry"] = bool(failed_audit and not confirmed_upgrade)
        queueable.append(item)
    backup_path = backup_database(manager_db)
    now = iso_now()
    changed = 0
    profiles = set()
    with closing(sqlite3.connect(str(manager_db))) as conn:
        conn.row_factory = sqlite3.Row
        ensure_audit_schema(conn)
        for item in queueable:
            retry_reason = (
                "画质检查失败，重新下载最高分辨率版本"
                if item.get("queued_for_retry")
                else "等待重新下载最高分辨率版本"
            )
            existing = conn.execute(
                "SELECT profile_id, status, download_intent FROM links WHERE id=? AND aweme_id=?",
                (int(item["link_id"]), str(item["aweme_id"])),
            ).fetchone()
            if existing is None:
                continue
            already_queued = (
                str(existing["download_intent"] or "") == QUALITY_UPGRADE_INTENT
                and str(existing["status"] or "") in {"pending", "downloading"}
            )
            if already_queued:
                profiles.add(int(existing["profile_id"]))
                if audit_run_id > 0:
                    conn.execute(
                        """
                        UPDATE video_quality_audit_items SET
                          upgrade_available=1,
                          redownload_status='queued', queued_at=COALESCE(queued_at, ?), updated_at=?
                        WHERE run_id=? AND aweme_id=?
                        """,
                        (now, now, audit_run_id, str(item["aweme_id"])),
                    )
                continue
            if str(existing["status"] or "") == "downloading":
                continue
            cursor = conn.execute(
                """
                UPDATE links SET
                  status='pending', download_intent=?, failed_at=NULL,
                  last_started_at=NULL, last_error=?,
                  digg_count=MAX(COALESCE(digg_count, 0), ?)
                WHERE id=? AND aweme_id=?
                """,
                (
                    QUALITY_UPGRADE_INTENT,
                    retry_reason,
                    int(item.get("digg_count") or 0),
                    int(item["link_id"]),
                    str(item["aweme_id"]),
                ),
            )
            if cursor.rowcount:
                changed += int(cursor.rowcount)
                profiles.add(int(item["profile_id"]))
                if audit_run_id > 0:
                    conn.execute(
                        """
                        UPDATE video_quality_audit_items SET
                          upgrade_available=1,
                          redownload_status='queued', queued_at=?, updated_at=?
                        WHERE run_id=? AND aweme_id=?
                        """,
                        (now, now, audit_run_id, str(item["aweme_id"])),
                    )
        for profile_id in profiles:
            conn.execute(
                """
                INSERT INTO profile_download_queue(profile_id, sort_order, enabled, created_at, updated_at)
                VALUES(?, COALESCE((SELECT MAX(sort_order)+1 FROM profile_download_queue), 0), 1, ?, ?)
                ON CONFLICT(profile_id) DO UPDATE SET enabled=1, updated_at=excluded.updated_at
                """,
                (profile_id, now, now),
            )
        conn.execute(
            "INSERT INTO events(ts, level, message) VALUES(?, 'info', ?)",
            (
                now,
                f"画质回测完成：排队重下 {changed} 条"
                + (f"（含检查失败 {sum(1 for item in queueable if item.get('queued_for_retry'))} 条）" if include_failures else ""),
            ),
        )
        conn.commit()
    return changed, backup_path


async def verify_existing_report(
    manager_db: Path,
    fanhao_db: Path,
    ffprobe: Path,
    report_path: Path,
    concurrency: int,
) -> Dict[str, Any]:
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    upgrades = [item for item in payload.get("results") or [] if item.get("upgrade")]
    probed = await probe_candidates(upgrades, ffprobe, max(1, concurrency))
    probed_by_aweme = {str(item.get("aweme_id") or ""): item for item in probed}
    verified_at = iso_now()
    passed = failed = probe_failed = 0
    run_id = int(payload.get("audit_run_id") or 0)
    with sqlite3.connect(str(manager_db)) as conn:
        ensure_audit_schema(conn)
        for item in upgrades:
            aweme_id = str(item.get("aweme_id") or "")
            result = probed_by_aweme.get(aweme_id) or {}
            verified_width = int(result.get("current_width") or 0)
            verified_height = int(result.get("current_height") or 0)
            verified_bit_rate = int(result.get("current_bit_rate") or 0)
            verified_codec = str(result.get("current_codec") or "")
            verified_frame_rate = float(result.get("current_frame_rate") or 0)
            error = str(result.get("probe_error") or "")
            target_pixels = int(item.get("target_pixels") or 0)
            if target_pixels <= 0:
                target_pixels = int(item.get("target_width") or 0) * int(item.get("target_height") or 0)
            verified_pixels = verified_width * verified_height
            if error:
                status = "probe_failed"
                probe_failed += 1
            elif target_pixels > 0 and verified_pixels >= target_pixels:
                status = "passed"
                passed += 1
            else:
                status = "failed"
                failed += 1
                error = (
                    f"expected {int(item.get('target_width') or 0)}x{int(item.get('target_height') or 0)}, "
                    f"verified {verified_width}x{verified_height}"
                )
            item["verified_width"] = verified_width
            item["verified_height"] = verified_height
            item["verified_bit_rate"] = verified_bit_rate
            item["verified_codec"] = verified_codec
            item["verified_frame_rate"] = verified_frame_rate
            item["verified_at"] = verified_at
            item["verification_status"] = status
            item["verification_error"] = error
            if run_id > 0:
                conn.execute(
                    """
                    UPDATE video_quality_audit_items SET
                      verified_width=?, verified_height=?, verified_at=?,
                      verification_status=?, verification_error=?,
                      redownload_status=CASE WHEN ?='passed' THEN 'completed' ELSE 'verification_failed' END,
                      updated_at=?
                    WHERE run_id=? AND aweme_id=? AND upgrade_available=1
                    """,
                    (
                        verified_width,
                        verified_height,
                        verified_at,
                        status,
                        error or None,
                        status,
                        verified_at,
                        run_id,
                        aweme_id,
                    ),
                )
    payload["verification"] = {
        "verified_at": verified_at,
        "total": len(upgrades),
        "passed": passed,
        "failed": failed,
        "probe_failed": probe_failed,
    }
    write_actual_video_metadata(fanhao_db, upgrades, probed_at=verified_at)
    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload["verification"]


async def run(args: argparse.Namespace) -> int:
    paths = resolve_paths(args)
    if args.backfill_playback_metadata:
        for key in ("fanhao_db", "ffprobe"):
            if not paths[key].exists():
                raise FileNotFoundError(f"{key} not found: {paths[key]}")
        candidates = load_playback_metadata_backfill_candidates(
            paths["fanhao_db"],
            max(0, int(args.backfill_min_long_edge)),
            max(0, int(args.limit)),
        )
        print(f"playback metadata candidates {len(candidates)}", flush=True)
        probed = await probe_candidates(candidates, paths["ffprobe"], max(1, int(args.concurrency) * 2))
        successful = [item for item in probed if not item.get("probe_error")]
        changed = write_actual_video_metadata(paths["fanhao_db"], successful)
        failures = [
            {"aweme_id": item.get("aweme_id"), "error": item.get("probe_error")}
            for item in probed
            if item.get("probe_error")
        ]
        print(
            json.dumps(
                {
                    "candidates": len(candidates),
                    "probed": len(probed),
                    "changed": changed,
                    "failed": len(failures),
                    "failures": failures[:20],
                },
                ensure_ascii=False,
            )
        )
        return 0
    if args.write_actual_from_report:
        report_path = args.write_actual_from_report.resolve()
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        stored_items = payload.get("results") or []
        changed = write_actual_video_metadata(
            paths["fanhao_db"],
            stored_items,
            probed_at=str(payload.get("generated_at") or iso_now()),
        )
        print(
            json.dumps(
                {"changed": changed, "item_count": len(stored_items), "report": str(report_path)},
                ensure_ascii=False,
            )
        )
        return 0

    if args.verify_existing_report:
        report_path = args.verify_existing_report.resolve()
        summary = await verify_existing_report(
            paths["manager_db"],
            paths["fanhao_db"],
            paths["ffprobe"],
            report_path,
            max(1, int(args.concurrency)),
        )
        print(json.dumps({**summary, "report": str(report_path)}, ensure_ascii=False))
        return 0

    if args.retry_probe_errors_existing_report:
        report_path = args.retry_probe_errors_existing_report.resolve()
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        stored_items = payload.get("results") or []
        retry_items = [item for item in stored_items if str(item.get("probe_error") or "").strip()]
        print(f"retrying probe errors {len(retry_items)}", flush=True)
        reprobed = await probe_candidates(
            retry_items,
            paths["ffprobe"],
            max(1, int(args.concurrency) * 2),
        )
        write_actual_video_metadata(paths["fanhao_db"], reprobed)
        max_current_long_edge = max(0, int(payload.get("max_current_long_edge") or 0))
        recovered_candidates: List[Dict[str, Any]] = []
        refreshed_by_aweme: Dict[str, Dict[str, Any]] = {}
        for item in reprobed:
            aweme_id = str(item.get("aweme_id") or "")
            refreshed = dict(item)
            refreshed.pop("skipped_reason", None)
            if refreshed.get("probe_error"):
                refreshed_by_aweme[aweme_id] = refreshed
                continue
            current_width = int(refreshed.get("current_width") or 0)
            current_height = int(refreshed.get("current_height") or 0)
            if max_current_long_edge > 0 and max(current_width, current_height) > max_current_long_edge:
                refreshed.update(
                    {
                        "target_width": 0,
                        "target_height": 0,
                        "target_bit_rate": 0,
                        "current_pixels": current_width * current_height,
                        "target_pixels": 0,
                        "upgrade": False,
                        "error": "",
                        "skipped_reason": "local_threshold",
                    }
                )
                refreshed_by_aweme[aweme_id] = refreshed
                continue
            recovered_candidates.append(refreshed)
        recovered_results = await audit_candidates(
            recovered_candidates,
            paths["downloader_root"],
            paths["cookie_json"],
            manager_proxy(paths["manager_db"]),
            max(1, int(args.concurrency)),
            max(0.0, float(args.request_delay or 0)),
            not args.local_detail_only,
        )
        refreshed_by_aweme.update(
            {str(item.get("aweme_id") or ""): item for item in recovered_results}
        )
        merged = [
            refreshed_by_aweme.get(str(item.get("aweme_id") or ""), item)
            for item in stored_items
        ]
        probe_errors = [item for item in merged if str(item.get("probe_error") or "").strip()]
        candidates = [
            item
            for item in merged
            if not str(item.get("probe_error") or "").strip()
            and not str(item.get("skipped_reason") or "").strip()
        ]
        errors = [item for item in candidates if str(item.get("error") or "").strip()]
        upgrades = [item for item in merged if item.get("upgrade")]
        payload["results"] = merged
        payload["probe_error_count"] = len(probe_errors)
        payload["candidate_count"] = len(candidates)
        payload["checked_count"] = len(candidates) - len(errors)
        payload["error_count"] = len(errors)
        payload["upgrade_count"] = len(upgrades)
        payload["probe_retry_count"] = len(retry_items)
        payload["probe_retried_at"] = iso_now()
        run_id = int(payload.get("audit_run_id") or 0)
        if run_id <= 0:
            run_id = persist_audit_run(paths["manager_db"], payload, merged, report_path)
        if args.apply:
            applied_count, backup_path = queue_upgrades(paths["manager_db"], merged, audit_run_id=run_id)
            payload["applied_count"] = int(payload.get("applied_count") or 0) + applied_count
            payload["backup_path"] = str(backup_path)
        payload["audit_run_id"] = run_id
        payload["stored_item_count"] = len(merged)
        persist_audit_run(paths["manager_db"], payload, merged, report_path)
        report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {
                    "probe_retry_count": len(retry_items),
                    "probe_error_count": len(probe_errors),
                    "checked_count": payload["checked_count"],
                    "error_count": len(errors),
                    "upgrade_count": len(upgrades),
                    "applied_count": int(payload.get("applied_count") or 0),
                    "audit_run_id": run_id,
                    "report": str(report_path),
                },
                ensure_ascii=False,
            )
        )
        return 0

    if args.retry_existing_report:
        report_path = args.retry_existing_report.resolve()
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        stored_items = payload.get("results") or []
        retry_items = [
            item for item in stored_items
            if str(item.get("error") or "").strip()
            and not str(item.get("probe_error") or "").strip()
            and int(item.get("current_width") or 0) > 0
            and int(item.get("current_height") or 0) > 0
        ]
        print(f"retrying {len(retry_items)}", flush=True)
        retried = await audit_candidates(
            retry_items,
            paths["downloader_root"],
            paths["cookie_json"],
            manager_proxy(paths["manager_db"]),
            max(1, int(args.concurrency)),
            max(0.0, float(args.request_delay or 0)),
            not args.local_detail_only,
        )
        retried_by_aweme = {str(item.get("aweme_id") or ""): item for item in retried}
        merged = [
            retried_by_aweme.get(str(item.get("aweme_id") or ""), item)
            for item in stored_items
        ]
        errors = [item for item in merged if str(item.get("error") or "").strip()]
        upgrades = [item for item in merged if item.get("upgrade")]
        payload["results"] = merged
        payload["checked_count"] = len(merged) - int(payload.get("probe_error_count") or 0) - len(errors)
        payload["error_count"] = len(errors)
        payload["upgrade_count"] = len(upgrades)
        payload["retry_count"] = len(retry_items)
        payload["retried_at"] = iso_now()
        run_id = int(payload.get("audit_run_id") or 0)
        if run_id <= 0:
            run_id = persist_audit_run(paths["manager_db"], payload, merged, report_path)
        if args.apply:
            applied_count, backup_path = queue_upgrades(paths["manager_db"], merged, audit_run_id=run_id)
            payload["applied_count"] = applied_count
            payload["backup_path"] = str(backup_path)
        payload["audit_run_id"] = run_id
        payload["stored_item_count"] = len(merged)
        persist_audit_run(paths["manager_db"], payload, merged, report_path)
        report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "retry_count": len(retry_items),
            "checked_count": payload["checked_count"],
            "error_count": len(errors),
            "upgrade_count": len(upgrades),
            "applied_count": int(payload.get("applied_count") or 0),
            "audit_run_id": run_id,
            "report": str(report_path),
        }, ensure_ascii=False))
        return 0

    if args.import_existing_report:
        report_path = args.import_existing_report.resolve()
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        stored_items = payload.get("results") or []
        run_id = persist_audit_run(paths["manager_db"], payload, stored_items, report_path)
        payload["audit_run_id"] = run_id
        payload["stored_item_count"] = len(stored_items)
        report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {
                    "audit_run_id": run_id,
                    "stored_item_count": len(stored_items),
                    "report": str(report_path),
                },
                ensure_ascii=False,
            )
        )
        return 0

    if args.queue_failures_existing_report:
        report_path = args.queue_failures_existing_report.resolve()
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        stored_items = payload.get("results") or []
        run_id = int(payload.get("audit_run_id") or 0)
        if run_id <= 0:
            run_id = persist_audit_run(paths["manager_db"], payload, stored_items, report_path)
        queued_failure_count = sum(
            1 for item in stored_items if item.get("error") or item.get("probe_error")
        )
        applied_count, backup_path = queue_upgrades(
            paths["manager_db"],
            stored_items,
            audit_run_id=run_id,
            include_failures=True,
        )
        payload["applied_count"] = applied_count
        payload["queued_failure_count"] = queued_failure_count
        payload["backup_path"] = str(backup_path)
        payload["audit_run_id"] = run_id
        payload["stored_item_count"] = len(stored_items)
        persist_audit_run(paths["manager_db"], payload, stored_items, report_path)
        report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "upgrade_count": payload.get("upgrade_count", 0),
            "queued_failure_count": queued_failure_count,
            "applied_count": applied_count,
            "audit_run_id": run_id,
            "report": str(report_path),
            "backup": str(backup_path),
        }, ensure_ascii=False))
        return 0

    if args.apply_existing_report:
        report_path = args.apply_existing_report.resolve()
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        stored_items = payload.get("results") or []
        run_id = int(payload.get("audit_run_id") or 0)
        if run_id <= 0:
            run_id = persist_audit_run(paths["manager_db"], payload, stored_items, report_path)
        applied_count, backup_path = queue_upgrades(
            paths["manager_db"],
            stored_items,
            audit_run_id=run_id,
        )
        payload["applied_count"] = applied_count
        payload["backup_path"] = str(backup_path)
        payload["audit_run_id"] = run_id
        payload["stored_item_count"] = len(stored_items)
        persist_audit_run(paths["manager_db"], payload, stored_items, report_path)
        report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {
                    "upgrade_count": payload.get("upgrade_count", 0),
                    "applied_count": applied_count,
                    "audit_run_id": run_id,
                    "report": str(report_path),
                    "backup": str(backup_path),
                },
                ensure_ascii=False,
            )
        )
        return 0

    min_digg_count = max(0, int(args.min_digg_count or 0))
    max_digg_count = max(0, int(args.max_digg_count or 0))
    if max_digg_count > 0 and max_digg_count < min_digg_count:
        raise ValueError("--max-digg-count must be greater than or equal to --min-digg-count")
    if not args.since and min_digg_count <= 0 and not args.all_downloaded:
        raise ValueError(
            "provide --since, --min-digg-count, or --all-downloaded unless --apply-existing-report is used"
        )
    if args.all_downloaded and (args.since or min_digg_count > 0 or max_digg_count > 0):
        raise ValueError("--all-downloaded cannot be combined with date or like-count filters")
    for key in ("manager_db", "fanhao_db", "downloader_root", "cookie_json", "ffprobe"):
        if not paths[key].exists():
            raise FileNotFoundError(f"{key} not found: {paths[key]}")

    since = normalize_since(args.since) if args.since else None
    downloaded = load_candidates(
        paths["manager_db"],
        paths["fanhao_db"],
        since,
        min_digg_count,
        max_digg_count,
        max(0, int(args.limit)),
        include_quality_queue=bool(args.all_downloaded),
    )
    print(f"downloaded {len(downloaded)}", flush=True)
    probed = await probe_candidates(downloaded, paths["ffprobe"], max(1, int(args.concurrency) * 2))
    actual_write_count = write_actual_video_metadata(paths["fanhao_db"], probed)
    probe_errors = [item for item in probed if item.get("probe_error")]
    max_current_long_edge = max(0, int(args.max_current_long_edge))
    candidates = [
        item
        for item in probed
        if not item.get("probe_error")
        and (
            max_current_long_edge <= 0
            or max(int(item["current_width"]), int(item["current_height"]))
            <= max_current_long_edge
        )
    ]
    print(f"candidates {len(candidates)}", flush=True)
    results = await audit_candidates(
        candidates,
        paths["downloader_root"],
        paths["cookie_json"],
        manager_proxy(paths["manager_db"]),
        max(1, int(args.concurrency)),
        max(0.0, float(args.request_delay or 0)),
        not args.local_detail_only,
    )
    audited_by_aweme = {str(item.get("aweme_id") or ""): item for item in results}
    stored_results: List[Dict[str, Any]] = []
    for item in probed:
        aweme_id = str(item.get("aweme_id") or "")
        audited = audited_by_aweme.get(aweme_id)
        if audited:
            stored_results.append(audited)
            continue
        stored = dict(item)
        current_width = int(stored.get("current_width") or 0)
        current_height = int(stored.get("current_height") or 0)
        stored.update(
            {
                "target_width": 0,
                "target_height": 0,
                "target_bit_rate": 0,
                "current_pixels": current_width * current_height,
                "target_pixels": 0,
                "upgrade": False,
                "error": "",
                "skipped_reason": "probe_failed" if stored.get("probe_error") else "local_threshold",
            }
        )
        stored_results.append(stored)
    stored_results.sort(key=lambda item: str(item.get("downloaded_at") or ""), reverse=True)
    upgrades = [item for item in stored_results if item.get("upgrade")]
    errors = [item for item in results if item.get("error")]
    payload = {
        "generated_at": iso_now(),
        "since": since,
        "min_digg_count": min_digg_count,
        "max_digg_count": max_digg_count,
        "all_downloaded": bool(args.all_downloaded),
        "max_current_long_edge": max_current_long_edge,
        "downloaded_count": len(downloaded),
        "probe_error_count": len(probe_errors),
        "actual_write_count": actual_write_count,
        "candidate_count": len(candidates),
        "checked_count": len(results) - len(errors),
        "error_count": len(errors),
        "upgrade_count": len(upgrades),
        "applied_count": 0,
        "backup_path": "",
        "stored_item_count": len(stored_results),
        "results": stored_results,
    }
    paths["report"].parent.mkdir(parents=True, exist_ok=True)
    paths["report"].write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    run_id = persist_audit_run(paths["manager_db"], payload, stored_results, paths["report"])
    payload["audit_run_id"] = run_id
    if args.apply:
        applied_count, backup_path = queue_upgrades(
            paths["manager_db"],
            stored_results,
            audit_run_id=run_id,
        )
        payload["applied_count"] = applied_count
        payload["backup_path"] = str(backup_path)
        persist_audit_run(paths["manager_db"], payload, stored_results, paths["report"])
    paths["report"].write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "candidate_count": payload["candidate_count"],
                "checked_count": payload["checked_count"],
                "error_count": payload["error_count"],
                "upgrade_count": payload["upgrade_count"],
                "applied_count": payload["applied_count"],
                "audit_run_id": run_id,
                "report": str(paths["report"]),
                "backup": payload["backup_path"],
            },
            ensure_ascii=False,
        )
    )
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(run(parse_args())))


if __name__ == "__main__":
    main()
