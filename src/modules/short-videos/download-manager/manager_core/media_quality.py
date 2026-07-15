"""Internal media quality responsibilities for the download manager."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import uuid
from pathlib import Path
from typing import Any

from .common import first_text, flatten_strings, int_or_none, now_iso, row_text
from .domain_manifest import first_existing_manifest_file, json_value, raw_metadata_object


def probe_actual_video_file(path: str) -> dict[str, Any]:
    probed_at = now_iso()
    result = {
        "codec": "",
        "frame_rate": 0.0,
        "width": 0,
        "height": 0,
        "bit_rate": 0,
        "pixels": 0,
        "long_edge": 0,
        "probed_at": probed_at,
        "error": "",
    }
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        result["error"] = "ffprobe not found"
        return result

    def run_probe(probe_path: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                ffprobe,
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate",
                "-of", "json",
                probe_path,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            check=False,
        )

    try:
        source_path = Path(path)
        completed = run_probe(str(source_path))
        if completed.returncode != 0 and source_path.exists() and os.name == "nt":
            # Windows ffprobe can report "No such file" for a real file when
            # its Unicode/full path is too long. Probe a temporary ASCII hard
            # link on the same volume so validation does not trigger an endless
            # redownload loop for an already downloaded video.
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
                completed = run_probe(str(probe_path))
            finally:
                probe_path.unlink(missing_ok=True)
                try:
                    probe_dir.rmdir()
                except OSError:
                    pass
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or f"ffprobe exit {completed.returncode}").strip()[:500])
        payload = json.loads(completed.stdout or "{}")
        stream = (payload.get("streams") or [{}])[0]
        width = int(stream.get("width") or 0)
        height = int(stream.get("height") or 0)
        bit_rate = int(stream.get("bit_rate") or (payload.get("format") or {}).get("bit_rate") or 0)
        frame_rate_text = str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "").strip()
        frame_rate_parts = frame_rate_text.split("/", 1)
        try:
            frame_rate = float(frame_rate_parts[0]) / max(1.0, float(frame_rate_parts[1] if len(frame_rate_parts) > 1 else 1))
        except (TypeError, ValueError, ZeroDivisionError):
            frame_rate = 0.0
        if width <= 0 or height <= 0:
            raise RuntimeError("video dimensions unavailable")
        result.update(
            {
                "codec": str(stream.get("codec_name") or "").strip().lower(),
                "frame_rate": frame_rate,
                "width": width,
                "height": height,
                "bit_rate": bit_rate,
                "pixels": width * height,
                "long_edge": max(width, height),
            }
        )
    except Exception as exc:
        result["error"] = str(exc)[:500]
    return result


def expected_highest_video_dimensions(record: dict[str, Any] | None) -> tuple[int, int]:
    raw = raw_metadata_object(record or {})
    video = raw.get("video") if isinstance(raw.get("video"), dict) else {}
    candidates: list[tuple[int, int, int]] = []
    for entry in video.get("bit_rate") or []:
        if not isinstance(entry, dict):
            continue
        address = entry.get("play_addr") if isinstance(entry.get("play_addr"), dict) else {}
        width = int_or_none(address.get("width") or entry.get("width")) or 0
        height = int_or_none(address.get("height") or entry.get("height")) or 0
        bit_rate = int_or_none(entry.get("bit_rate")) or 0
        if width > 0 and height > 0:
            candidates.append((width, height, bit_rate))
    if candidates:
        width, height, _ = max(candidates, key=lambda item: (item[0] * item[1], max(item[0], item[1]), item[2]))
        return width, height
    for key in ("play_addr_h264", "play_addr_265", "play_addr_256", "play_addr"):
        address = video.get(key) if isinstance(video.get(key), dict) else {}
        width = int_or_none(address.get("width") or video.get("width")) or 0
        height = int_or_none(address.get("height") or video.get("height")) or 0
        if width > 0 and height > 0:
            return width, height
    return 0, 0


def validate_downloaded_video_quality(
    link: sqlite3.Row,
    output_dir: str,
    record: dict[str, Any] | None,
    require_source_dimensions: bool = False,
) -> tuple[bool, str, str, dict[str, Any] | None]:
    if not record:
        return True, "", "", None
    media_type = first_text(row_text(link, "media_type"), record.get("media_type")).lower()
    if media_type in {"gallery", "note", "image", "images"} or row_text(link, "kind").lower() == "note":
        return True, "", "", None
    source_path = first_existing_manifest_file(output_dir, flatten_strings(record.get("file_paths")), {"video"})
    if not source_path:
        return False, "最高画质校验失败：找不到下载后的视频文件", "", None
    actual = probe_actual_video_file(source_path)
    if actual.get("error"):
        return False, f"最高画质校验失败：{actual['error']}", "", actual
    expected_width, expected_height = expected_highest_video_dimensions(record)
    actual_width = int(actual.get("width") or 0)
    actual_height = int(actual.get("height") or 0)
    if expected_width <= 0 or expected_height <= 0:
        if require_source_dimensions:
            return False, "旧文件无法确认源最高分辨率，已改为最高画质重下", "", actual
        return True, "", f"已按最高画质下载；实际 {actual_width}x{actual_height}，源分辨率未返回", actual
    if expected_width > 0 and expected_height > 0 and actual_width * actual_height < expected_width * expected_height:
        return False, (
            f"最高画质校验未通过：期望 {expected_width}x{expected_height}，"
            f"实际 {actual_width}x{actual_height}，已重新排队"
        ), "", actual
    return True, "", f"最高画质已确认 {actual_width}x{actual_height}（源最高 {expected_width}x{expected_height}）", actual


def reused_record_with_current_source(link: sqlite3.Row, record: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(record or {})
    current = json_value(row_text(link, "metadata_json"), {})
    if not isinstance(current, dict) or not current:
        return merged
    raw = raw_metadata_object(current)
    if not raw and isinstance(current.get("video"), dict):
        raw = current
    if raw:
        merged["metadata"] = raw
    return merged
