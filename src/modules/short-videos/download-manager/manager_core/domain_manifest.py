"""Internal domain manifest responsibilities for the download manager."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any

from .common import first_text, flatten_strings, int_or_none, json_text, now_iso, row_int, row_text, safe_path_segment
from .config import LIBRARY_SEC_UID
from .database import db, setting


manifest_import_lock = threading.RLock()


def profile_output_dir(base_output_dir: str, profile_id: int) -> str:
    try:
        custom = setting("library_output_dir", "")
    except sqlite3.Error:
        custom = ""
    if custom.strip():
        return str(Path(custom).expanduser())
    base = Path(base_output_dir)
    # 文件只存一份；“我的喜欢 / 作者作品”是数据库关系，不再靠目录区分。
    return str(base / "likes" / safe_path_segment(LIBRARY_SEC_UID))


def manifest_has(output_dir: str, aweme_id: str) -> bool:
    return manifest_record(output_dir, aweme_id) is not None


def json_value(value: Any, fallback: Any = None) -> Any:
    if value in ("", None):
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def download_record_from_db(aweme_id: str) -> dict[str, Any] | None:
    aweme_id = str(aweme_id or "").strip()
    if not aweme_id:
        return None
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT record_json FROM download_records WHERE aweme_id=?",
                (aweme_id,),
            ).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    record = json_value(row["record_json"], {})
    return record if isinstance(record, dict) else None


def download_record_hash(record: dict[str, Any]) -> str:
    payload = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def sync_download_record_files(
    conn: sqlite3.Connection,
    aweme_id: str,
    output_dir: str | Path,
    record: dict[str, Any],
    recorded_at: str,
) -> int:
    conn.execute("DELETE FROM download_files WHERE aweme_id=?", (aweme_id,))
    rows = manifest_file_rows(record, output_dir)
    for row in rows:
        conn.execute(
            """
            INSERT INTO download_files(
              aweme_id, role, kind, file_name, file_path, absolute_path,
              size_bytes, exists_on_disk, recorded_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(aweme_id, file_path) DO UPDATE SET
              role=excluded.role,
              kind=excluded.kind,
              file_name=excluded.file_name,
              absolute_path=excluded.absolute_path,
              size_bytes=excluded.size_bytes,
              exists_on_disk=excluded.exists_on_disk,
              recorded_at=excluded.recorded_at
            """,
            (
                aweme_id,
                row["role"],
                row["kind"],
                row["file_name"],
                row["file_path"],
                row["absolute_path"],
                row["size_bytes"],
                row["exists_on_disk"],
                recorded_at,
            ),
        )
    return len(rows)


def persist_download_record(
    conn: sqlite3.Connection,
    output_dir: str | Path,
    record: dict[str, Any],
    *,
    source: str,
    manifest_path: str = "",
    manifest_offset: int | None = None,
) -> bool:
    aweme_id = str(record.get("aweme_id") or "").strip()
    if not aweme_id:
        return False
    recorded_at = first_text(record.get("recorded_at")) or now_iso()
    record_json = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    content_hash = download_record_hash(record)
    ts = now_iso()
    cursor = conn.execute(
        """
        INSERT INTO download_records(
          aweme_id, output_dir, media_type, record_json, recorded_at,
          content_hash, source, manifest_path, manifest_offset, created_at, updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(aweme_id) DO UPDATE SET
          output_dir=excluded.output_dir,
          media_type=excluded.media_type,
          record_json=excluded.record_json,
          recorded_at=excluded.recorded_at,
          content_hash=excluded.content_hash,
          source=excluded.source,
          manifest_path=excluded.manifest_path,
          manifest_offset=excluded.manifest_offset,
          updated_at=excluded.updated_at
        WHERE download_records.source='links-backfill'
           OR COALESCE(excluded.recorded_at, '') >= COALESCE(download_records.recorded_at, '')
        """,
        (
            aweme_id,
            str(Path(output_dir)),
            first_text(record.get("media_type")),
            record_json,
            recorded_at,
            content_hash,
            source,
            manifest_path or None,
            manifest_offset,
            ts,
            ts,
        ),
    )
    if cursor.rowcount == 0:
        return False
    sync_download_record_files(conn, aweme_id, output_dir, record, recorded_at)
    return True


def _write_manifest_import_state(
    conn: sqlite3.Connection,
    manifest_path: str,
    byte_offset: int,
    file_size: int,
    file_mtime_ns: int,
    imported_records: int,
    bad_lines: int,
) -> None:
    conn.execute(
        """
        INSERT INTO manifest_import_state(
          manifest_path, byte_offset, file_size, file_mtime_ns,
          imported_records, bad_lines, updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(manifest_path) DO UPDATE SET
          byte_offset=excluded.byte_offset,
          file_size=excluded.file_size,
          file_mtime_ns=excluded.file_mtime_ns,
          imported_records=excluded.imported_records,
          bad_lines=excluded.bad_lines,
          updated_at=excluded.updated_at
        """,
        (
            manifest_path,
            byte_offset,
            file_size,
            file_mtime_ns,
            imported_records,
            bad_lines,
            now_iso(),
        ),
    )


def sync_manifest_to_db(output_dir: str | Path) -> dict[str, Any]:
    resolved_output_dir = Path(output_dir).expanduser().resolve()
    manifest = resolved_output_dir / "download_manifest.jsonl"
    result: dict[str, Any] = {
        "manifest": str(manifest),
        "database_ready": True,
        "imported": 0,
        "bad": 0,
        "byte_offset": 0,
        "file_size": 0,
    }
    if not manifest.exists():
        return result
    try:
        stat = manifest.stat()
    except OSError:
        return result

    manifest_path = str(manifest)
    with manifest_import_lock:
        try:
            with db() as conn:
                state = conn.execute(
                    "SELECT * FROM manifest_import_state WHERE manifest_path=?",
                    (manifest_path,),
                ).fetchone()
                byte_offset = int(state["byte_offset"] or 0) if state else 0
                imported_total = int(state["imported_records"] or 0) if state else 0
                bad_total = int(state["bad_lines"] or 0) if state else 0
                if byte_offset > stat.st_size:
                    byte_offset = imported_total = bad_total = 0
                if byte_offset == stat.st_size:
                    if not state or int(state["file_mtime_ns"] or 0) != int(stat.st_mtime_ns):
                        _write_manifest_import_state(
                            conn,
                            manifest_path,
                            byte_offset,
                            stat.st_size,
                            stat.st_mtime_ns,
                            imported_total,
                            bad_total,
                        )
                    result.update(
                        {
                            "byte_offset": byte_offset,
                            "file_size": stat.st_size,
                            "imported_total": imported_total,
                            "bad_total": bad_total,
                        }
                    )
                    return result

                imported = bad = processed = 0
                committed_offset = byte_offset
                with manifest.open("rb") as handle:
                    handle.seek(byte_offset)
                    while True:
                        line_start = handle.tell()
                        raw = handle.readline()
                        if not raw:
                            break
                        line_end = handle.tell()
                        if not raw.endswith(b"\n"):
                            # The sidecar writes JSON and the newline separately. Do not
                            # consume a temporarily incomplete tail.
                            handle.seek(line_start)
                            break
                        committed_offset = line_end
                        processed += 1
                        try:
                            record = json.loads(raw.decode("utf-8", errors="replace"))
                        except json.JSONDecodeError:
                            bad += 1
                        else:
                            if isinstance(record, dict) and str(record.get("aweme_id") or "").strip():
                                if persist_download_record(
                                    conn,
                                    resolved_output_dir,
                                    record,
                                    source="manifest",
                                    manifest_path=manifest_path,
                                    manifest_offset=line_end,
                                ):
                                    imported += 1
                            else:
                                bad += 1
                        if processed % 500 == 0:
                            _write_manifest_import_state(
                                conn,
                                manifest_path,
                                committed_offset,
                                stat.st_size,
                                stat.st_mtime_ns,
                                imported_total + imported,
                                bad_total + bad,
                            )
                            conn.commit()

                latest_stat = manifest.stat()
                _write_manifest_import_state(
                    conn,
                    manifest_path,
                    committed_offset,
                    latest_stat.st_size,
                    latest_stat.st_mtime_ns,
                    imported_total + imported,
                    bad_total + bad,
                )
                result.update(
                    {
                        "imported": imported,
                        "bad": bad,
                        "byte_offset": committed_offset,
                        "file_size": latest_stat.st_size,
                        "imported_total": imported_total + imported,
                        "bad_total": bad_total + bad,
                    }
                )
                return result
        except sqlite3.Error as exc:
            result["database_ready"] = False
            result["error"] = str(exc)
            return result
        except OSError as exc:
            result["error"] = str(exc)
            return result


def backfill_download_records_from_links() -> dict[str, int]:
    inserted = files = 0
    try:
        with db() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM (
                  SELECT links.*,
                    ROW_NUMBER() OVER(
                      PARTITION BY aweme_id
                      ORDER BY COALESCE(downloaded_at, last_started_at, last_seen_at) DESC, id DESC
                    ) row_number
                  FROM links
                  WHERE status='downloaded'
                    AND (COALESCE(metadata_json, '') <> '' OR COALESCE(local_file_paths, '') <> '')
                ) ranked_links
                WHERE row_number=1
                  AND NOT EXISTS(
                    SELECT 1
                    FROM download_records
                    WHERE download_records.aweme_id=ranked_links.aweme_id
                  )
                """
            ).fetchall()
            for row in rows:
                record = json_value(row_text(row, "metadata_json"), {})
                if not isinstance(record, dict):
                    record = {}
                record = dict(record)
                record.setdefault("aweme_id", row_text(row, "aweme_id"))
                record.setdefault("desc", row_text(row, "desc"))
                record.setdefault("media_type", row_text(row, "media_type"))
                create_time = row_int(row, "create_time")
                if create_time is not None:
                    record.setdefault("publish_timestamp", create_time)
                record.setdefault(
                    "file_names",
                    flatten_strings(json_value(row_text(row, "local_file_names"), [])),
                )
                record.setdefault(
                    "file_paths",
                    flatten_strings(json_value(row_text(row, "local_file_paths"), [])),
                )
                record.setdefault("recorded_at", row_text(row, "downloaded_at") or now_iso())
                if persist_download_record(
                    conn,
                    row_text(row, "output_dir"),
                    record,
                    source="links-backfill",
                ):
                    inserted += 1
                    files += len(record.get("file_paths") or [])
    except sqlite3.Error:
        return {"inserted": 0, "files": 0}
    return {"inserted": inserted, "files": files}


def _legacy_manifest_record(output_dir: str, aweme_id: str) -> dict[str, Any] | None:
    manifest = Path(output_dir) / "download_manifest.jsonl"
    if not manifest.exists():
        return None
    found: dict[str, Any] | None = None
    try:
        # A sidecar can be terminated while appending, leaving one partial UTF-8
        # line behind. Keep valid manifest records usable instead of blocking the
        # entire download queue on that damaged tail.
        with manifest.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if aweme_id not in line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(row.get("aweme_id")) == str(aweme_id):
                    found = row
    except OSError:
        return None
    return found


def manifest_record(output_dir: str, aweme_id: str) -> dict[str, Any] | None:
    sync = sync_manifest_to_db(output_dir)
    record = download_record_from_db(aweme_id)
    if record is not None:
        return record
    if not sync.get("database_ready"):
        return _legacy_manifest_record(output_dir, aweme_id)
    return None


def downloaded_record_from_link(row: sqlite3.Row) -> tuple[str, dict[str, Any]] | None:
    aweme_id = row_text(row, "aweme_id")
    output_dir = row_text(row, "output_dir")
    if not aweme_id or not output_dir:
        return None
    record = manifest_record(output_dir, aweme_id)
    if record:
        return output_dir, record

    paths = flatten_strings(json_value(row_text(row, "local_file_paths"), []))
    if not paths:
        return None
    if not first_existing_manifest_file(output_dir, paths, {"video", "image"}):
        return None
    names = flatten_strings(json_value(row_text(row, "local_file_names"), []))
    metadata = json_value(row_text(row, "metadata_json"), {})
    record = metadata if isinstance(metadata, dict) else {}
    record = dict(record)
    record.setdefault("aweme_id", aweme_id)
    record.setdefault("url", row_text(row, "url"))
    record.setdefault("desc", row_text(row, "desc"))
    record.setdefault("media_type", row_text(row, "media_type"))
    create_time = row_int(row, "create_time")
    if create_time is not None:
        record.setdefault("publish_timestamp", create_time)
    record["file_names"] = names
    record["file_paths"] = paths
    return output_dir, record


def existing_downloaded_work(aweme_id: str, exclude_link_id: int | None = None) -> dict[str, Any] | None:
    aweme_id = str(aweme_id or "").strip()
    if not aweme_id:
        return None
    with db() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM links
            WHERE aweme_id=?
              AND status='downloaded'
              AND id<>?
              AND COALESCE(output_dir, '') <> ''
            ORDER BY COALESCE(downloaded_at, '') DESC, id DESC
            LIMIT 24
            """,
            (aweme_id, int(exclude_link_id or 0)),
        ).fetchall()
    for row in rows:
        resolved = downloaded_record_from_link(row)
        if not resolved:
            continue
        output_dir, record = resolved
        return {
            "output_dir": output_dir,
            "record": record,
            "source_link_id": int(row["id"]),
            "source_profile_id": int(row["profile_id"] or 0),
        }
    return None


def manifest_preview_path(record: dict[str, Any]) -> str:
    paths = record.get("file_paths")
    if not isinstance(paths, list):
        return ""
    media_type = str(record.get("media_type") or "")
    suffix_groups = (
        (".mp4", ".mov", ".webm", ".m4v"),
        (".jpg", ".jpeg", ".png", ".webp", ".gif"),
    )
    if media_type == "gallery":
        suffix_groups = (suffix_groups[1], suffix_groups[0])
    for suffixes in suffix_groups:
        for path in paths:
            text = str(path or "")
            if text.lower().endswith(suffixes):
                return text
    return str(paths[0] or "") if paths else ""


def manifest_cover_path(record: dict[str, Any]) -> str:
    paths = record.get("file_paths")
    if not isinstance(paths, list):
        return ""
    image_suffixes = (".jpg", ".jpeg", ".png", ".webp", ".gif")
    for path in paths:
        text = str(path or "")
        name = Path(text).name.lower()
        if name.endswith(image_suffixes) and ("_cover." in name or "cover" in name):
            return text
    return ""


def file_kind(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext in {".mp4", ".mov", ".webm", ".m4v"}:
        return "video"
    if ext in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return "image"
    if ext in {".mp3", ".m4a", ".aac", ".wav", ".flac"}:
        return "audio"
    if ext == ".json":
        return "json"
    return "file"


def file_role(path: str) -> str:
    name = Path(path).name.lower()
    kind = file_kind(path)
    if kind == "json":
        return "metadata"
    if kind == "audio":
        return "music"
    if kind == "image" and ("_cover." in name or "cover" in name):
        return "cover"
    if kind == "image":
        return "image"
    if kind == "video":
        return "video"
    return "file"


def file_stat(output_dir: str | Path, path: str) -> tuple[str, int | None, int]:
    raw = Path(str(path))
    absolute = raw if raw.is_absolute() else Path(output_dir) / raw
    try:
        resolved = absolute.resolve()
        stat = resolved.stat()
        return str(resolved), int(stat.st_size), 1 if resolved.is_file() else 0
    except OSError:
        return str(absolute), None, 0


def manifest_file_rows(record: dict[str, Any], output_dir: str | Path) -> list[dict[str, Any]]:
    names = record.get("file_names")
    paths = record.get("file_paths")
    if not isinstance(paths, list):
        return []
    rows = []
    for index, raw_path in enumerate(paths):
        text = str(raw_path or "").strip()
        if not text:
            continue
        fallback_name = Path(text).name
        file_name = ""
        if isinstance(names, list) and index < len(names):
            file_name = str(names[index] or "")
        absolute_path, size_bytes, exists_on_disk = file_stat(output_dir, text)
        rows.append(
            {
                "role": file_role(text),
                "kind": file_kind(text),
                "file_name": file_name or fallback_name,
                "file_path": text,
                "absolute_path": absolute_path,
                "size_bytes": size_bytes,
                "exists_on_disk": exists_on_disk,
            }
        )
    return rows


def sync_manifest_files(
    conn: sqlite3.Connection,
    profile_id: int,
    aweme_id: str,
    output_dir: str | Path,
    record: dict[str, Any],
) -> int:
    persist_download_record(
        conn,
        output_dir,
        record,
        source="manager",
    )
    link = conn.execute(
        "SELECT id FROM links WHERE profile_id=? AND aweme_id=?",
        (profile_id, aweme_id),
    ).fetchone()
    if not link:
        return 0
    ts = now_iso()
    link_id = int(link["id"])
    conn.execute(
        "DELETE FROM link_files WHERE profile_id=? AND aweme_id=?",
        (profile_id, aweme_id),
    )
    rows = manifest_file_rows(record, output_dir)
    for row in rows:
        conn.execute(
            """
            INSERT INTO link_files(
              link_id, profile_id, aweme_id, role, kind, file_name, file_path,
              absolute_path, size_bytes, exists_on_disk, recorded_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(profile_id, aweme_id, file_path) DO UPDATE SET
              link_id=excluded.link_id,
              role=excluded.role,
              kind=excluded.kind,
              file_name=excluded.file_name,
              absolute_path=excluded.absolute_path,
              size_bytes=excluded.size_bytes,
              exists_on_disk=excluded.exists_on_disk,
              recorded_at=excluded.recorded_at
            """,
            (
                link_id,
                profile_id,
                aweme_id,
                row["role"],
                row["kind"],
                row["file_name"],
                row["file_path"],
                row["absolute_path"],
                row["size_bytes"],
                row["exists_on_disk"],
                ts,
            ),
        )
    return len(rows)


def manifest_music_metadata(record: dict[str, Any] | None, output_dir: str | Path = "") -> dict[str, str]:
    if not isinstance(record, dict):
        return {
            "music_id": "",
            "music_title": "",
            "music_author": "",
            "music_cover_url": "",
            "music_play_url": "",
            "local_music_path": "",
        }
    music = record.get("music") if isinstance(record.get("music"), dict) else {}
    local_music_path = first_text(music.get("local_file_path"))
    if not local_music_path:
        local_music_path = next(
            (path for path in flatten_strings(record.get("file_paths")) if file_kind(path) == "audio"),
            "",
        )
    if local_music_path and output_dir:
        resolved = resolve_manifest_file(output_dir, local_music_path)
        try:
            local_music_path = str(resolved.resolve()) if resolved.is_file() else str(resolved)
        except OSError:
            local_music_path = str(resolved)
    return {
        "music_id": first_text(music.get("id_str"), music.get("mid"), music.get("id")),
        "music_title": first_text(music.get("title")),
        "music_author": first_text(music.get("author")),
        "music_cover_url": first_url_any(music.get("cover_medium"), music.get("cover_thumb")),
        "music_play_url": first_url(music.get("play_url")),
        "local_music_path": local_music_path,
    }


def manifest_has_gallery_music(record: dict[str, Any] | None) -> bool:
    return bool(manifest_music_metadata(record).get("local_music_path"))


def work_metadata_from_record(record: dict[str, Any], output_dir: str | Path = "") -> dict[str, Any]:
    publish_ts = int_or_none(record.get("publish_timestamp"))
    return {
        "desc": first_text(record.get("desc")),
        "media_type": first_text(record.get("media_type")),
        "create_time": publish_ts,
        "local_file_names": json_text(record.get("file_names")),
        "local_file_paths": json_text(record.get("file_paths")),
        "local_cover_path": manifest_cover_path(record),
        "preview_path": manifest_preview_path(record),
        "metadata_json": json_text(record),
        **manifest_music_metadata(record, output_dir),
    }


def manifest_work_metadata(output_dir: str, aweme_id: str) -> dict[str, Any]:
    record = manifest_record(output_dir, aweme_id)
    return work_metadata_from_record(record, output_dir) if record else {}


def resolve_manifest_file(output_dir: str | Path, file_path: str) -> Path:
    raw = Path(str(file_path))
    return raw if raw.is_absolute() else Path(output_dir) / raw


def first_existing_manifest_file(output_dir: str | Path, paths: list[str], kinds: set[str]) -> str:
    for file_path in paths:
        if file_kind(file_path) not in kinds:
            continue
        resolved = resolve_manifest_file(output_dir, file_path)
        try:
            if resolved.is_file():
                return str(resolved.resolve())
        except OSError:
            continue
    return ""


def first_manifest_cover(output_dir: str | Path, paths: list[str]) -> str:
    cover = ""
    for file_path in paths:
        if file_kind(file_path) != "image":
            continue
        name = Path(file_path).name.lower()
        if "_cover." in name or "cover" in name or "封面" in name:
            cover = file_path
            break
    if not cover:
        cover = next((p for p in paths if file_kind(p) == "image"), "")
    if not cover:
        return ""
    resolved = resolve_manifest_file(output_dir, cover)
    try:
        return str(resolved.resolve()) if resolved.is_file() else ""
    except OSError:
        return ""


def resolved_existing_manifest_image(output_dir: str | Path, file_path: str) -> str:
    if not file_path or file_kind(file_path) != "image":
        return ""
    resolved = resolve_manifest_file(output_dir, file_path)
    try:
        return str(resolved.resolve()) if resolved.is_file() else ""
    except OSError:
        return ""


def raw_metadata_object(record: dict[str, Any]) -> dict[str, Any]:
    raw = record.get("metadata")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def first_url(value: Any) -> str:
    if isinstance(value, str) and value.strip().lower().startswith(("http://", "https://")):
        return value.strip()
    if isinstance(value, dict):
        urls = value.get("url_list")
        if isinstance(urls, list):
            return first_text(*urls)
    if isinstance(value, list):
        for item in value:
            url = first_url(item)
            if url:
                return url
    return ""


def first_url_any(*values: Any) -> str:
    for value in values:
        url = first_url(value)
        if url:
            return url
    return ""


def douyin_video_url(aweme_id: Any) -> str:
    text = first_text(aweme_id)
    return f"https://www.douyin.com/video/{text}" if re.fullmatch(r"\d{8,}", text) else ""


def douyin_user_url(sec_uid: Any) -> str:
    text = first_text(sec_uid)
    return f"https://www.douyin.com/user/{text}" if text else ""


def kind_from_manifest(record: dict[str, Any]) -> str:
    media_type = str(record.get("media_type") or "").lower()
    return "note" if media_type in {"gallery", "note", "image"} else "video"


def author_sec_uid_from_manifest(record: dict[str, Any]) -> str:
    for path in record.get("file_paths") or []:
        head = str(path or "").replace("/", "\\").split("\\", 1)[0]
        match = re.search(r"(MS4w[^\\/_\s]+)", head)
        if match:
            return match.group(1)
    return ""
