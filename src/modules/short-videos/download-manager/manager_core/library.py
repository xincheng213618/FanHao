"""Internal library responsibilities for the download manager."""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import first_text, flatten_strings, int_or_none, normalize_int, row_int, row_text
from .database import db
from .domain_manifest import downloaded_record_from_link, file_kind, json_value, manifest_file_rows, resolve_manifest_file


def library_files_for_link(link: sqlite3.Row) -> dict[str, Any] | None:
    output_dir = row_text(link, "output_dir")
    stored_paths = flatten_strings(json_value(row_text(link, "local_file_paths"), []))
    if output_dir and stored_paths:
        metadata = json_value(row_text(link, "metadata_json"), {})
        record = dict(metadata) if isinstance(metadata, dict) else {}
        record.setdefault("aweme_id", row_text(link, "aweme_id"))
        record.setdefault("url", row_text(link, "url"))
        record.setdefault("desc", row_text(link, "desc"))
        record.setdefault("media_type", row_text(link, "media_type"))
        record["file_paths"] = stored_paths
        record["file_names"] = flatten_strings(json_value(row_text(link, "local_file_names"), []))
    else:
        resolved = downloaded_record_from_link(link)
        if not resolved:
            return None
        output_dir, record = resolved
    media_type = first_text(row_text(link, "media_type"), record.get("media_type")).lower()
    is_gallery = media_type in {"gallery", "note", "image", "images"} or row_text(link, "kind").lower() == "note"
    file_rows = manifest_file_rows(record, output_dir)
    files: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in file_rows:
        if not row.get("exists_on_disk") or row.get("kind") not in {"video", "image", "audio"}:
            continue
        path = Path(str(row.get("absolute_path") or ""))
        try:
            resolved_path = path.resolve()
        except OSError:
            continue
        key = str(resolved_path).lower()
        if key in seen or not resolved_path.is_file():
            continue
        seen.add(key)
        files.append({**row, "path": resolved_path})

    cover: Path | None = None
    local_cover = row_text(link, "local_cover_path")
    if local_cover:
        candidate = resolve_manifest_file(output_dir, local_cover)
        try:
            if candidate.is_file() and file_kind(str(candidate)) == "image":
                cover = candidate.resolve()
        except OSError:
            pass
    if cover is None:
        cover_row = next((row for row in files if row.get("role") == "cover" and row.get("kind") == "image"), None)
        cover = cover_row["path"] if cover_row else None

    if is_gallery:
        assets = [row for row in files if row.get("kind") in {"image", "video"} and row.get("role") != "cover"]
        if not assets and cover is not None:
            assets = [{"kind": "image", "role": "image", "path": cover}]
    else:
        assets = [row for row in files if row.get("kind") == "video"]
        if not assets:
            assets = [row for row in files if row.get("kind") == "image" and row.get("role") != "cover"]

    if cover is None and is_gallery:
        image = next((row for row in assets if row.get("kind") == "image"), None)
        cover = image["path"] if image else None
    music_row = next((row for row in files if row.get("kind") == "audio"), None)
    return {
        "output_dir": output_dir,
        "record": record,
        "is_gallery": is_gallery,
        "assets": assets[:80],
        "cover": cover,
        "music": music_row["path"] if music_row else None,
    }


def library_item_from_row(row: sqlite3.Row) -> dict[str, Any] | None:
    media = library_files_for_link(row)
    if not media or not media["assets"]:
        return None
    link_id = int(row["id"])
    desc = first_text(row_text(row, "desc"), media["record"].get("desc"), row_text(row, "aweme_id"))
    assets = [
        {
            "kind": str(asset.get("kind") or "file"),
            "url": f"/api/library/media?id={link_id}&index={index}",
        }
        for index, asset in enumerate(media["assets"])
    ]
    cover_url = f"/api/library/media?id={link_id}&role=cover" if media["cover"] else row_text(row, "cover_url")
    return {
        "id": link_id,
        "aweme_id": row_text(row, "aweme_id"),
        "title": desc.splitlines()[0][:160] if desc else row_text(row, "aweme_id"),
        "description": desc,
        "author": first_text(row_text(row, "author_nickname"), "未知作者"),
        "author_id": first_text(row_text(row, "author_sec_uid"), row_text(row, "author_uid")),
        "downloaded_at": row_text(row, "downloaded_at"),
        "create_time": row_int(row, "create_time"),
        "media_type": "gallery" if media["is_gallery"] else "video",
        "cover_url": cover_url,
        "assets": assets,
        "asset_count": len(assets),
        "music_url": f"/api/library/media?id={link_id}&role=music" if media["music"] else "",
        "_media": media,
    }


def list_library(query: dict[str, list[str]]) -> dict[str, Any]:
    search = (query.get("q") or [""])[0].strip()
    limit = normalize_int((query.get("limit") or ["48"])[0], 48, 1, 120)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    where = ["links.status='downloaded'"]
    params: list[Any] = []
    if search:
        where.append(
            "(links.aweme_id LIKE ? OR links.desc LIKE ? OR links.author_nickname LIKE ? "
            "OR links.author_uid LIKE ? OR links.author_sec_uid LIKE ?)"
        )
        like = f"%{search}%"
        params.extend([like, like, like, like, like])
    where_sql = " AND ".join(where)
    with db() as conn:
        total = int(conn.execute(f"SELECT COUNT(*) c FROM links WHERE {where_sql}", params).fetchone()["c"])
        rows = conn.execute(
            f"""
            SELECT links.*
            FROM links
            WHERE {where_sql}
            ORDER BY COALESCE(links.downloaded_at, links.last_started_at, links.last_seen_at) DESC,
                     links.id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()

    items: list[dict[str, Any]] = []
    for row in rows:
        item = library_item_from_row(row)
        if item:
            item.pop("_media", None)
            items.append(item)
    next_offset = offset + len(rows)
    return {
        "ok": True,
        "total": total,
        "items": items,
        "limit": limit,
        "offset": offset,
        "next_offset": next_offset,
        "has_more": next_offset < total,
    }


def shared_player_video_from_row(row: sqlite3.Row) -> dict[str, Any] | None:
    item = library_item_from_row(row)
    if not item:
        return None
    media = item.pop("_media")
    record = media.get("record") if isinstance(media.get("record"), dict) else {}
    assets = item["assets"]
    has_video = any(asset.get("kind") == "video" for asset in assets)
    media_type = "gallery" if item["media_type"] == "gallery" or not has_video else "video"
    gallery_items = [
        {
            "index": index,
            "type": "video" if asset.get("kind") == "video" else "image",
            "url": asset["url"],
        }
        for index, asset in enumerate(assets)
    ] if media_type == "gallery" else []
    stream_url = next(
        (asset["url"] for asset in assets if asset.get("kind") == "video"),
        "",
    ) if media_type == "video" else ""
    sec_uid = row_text(row, "author_sec_uid")
    author_uid = row_text(row, "author_uid")
    author_id = f"douyin:{sec_uid}" if sec_uid else (f"douyin:{author_uid}" if author_uid else "")
    create_time = row_int(row, "create_time") or int_or_none(record.get("publish_timestamp"))
    published_at = ""
    if create_time:
        try:
            published_at = datetime.fromtimestamp(create_time, timezone.utc).isoformat().replace("+00:00", "Z")
        except (OSError, OverflowError, ValueError):
            published_at = ""
    fanhao_media = record.get("fanhaoMedia") if isinstance(record.get("fanhaoMedia"), dict) else {}
    size = 0
    for asset in media.get("assets") or []:
        try:
            size += int(asset["path"].stat().st_size)
        except (KeyError, OSError, TypeError, ValueError):
            pass
    tags = record.get("tags") if isinstance(record.get("tags"), list) else []
    music_url = item.get("music_url") or ""
    sound = None
    if music_url:
        music = record.get("music") if isinstance(record.get("music"), dict) else {}
        sound = {
            "key": first_text(row_text(row, "music_id"), music.get("id_str"), f"local:{item['id']}"),
            "id": first_text(row_text(row, "music_id"), music.get("id_str")),
            "title": first_text(row_text(row, "music_title"), music.get("title"), "作品原声"),
            "author": first_text(row_text(row, "music_author"), music.get("author"), item["author"]),
            "coverUrl": first_text(row_text(row, "music_cover_url")),
            "previewUrl": music_url,
            "previewSource": "local",
            "localAvailable": True,
            "original": bool(music.get("is_original_sound")),
        }
    first_media = (media.get("assets") or [{}])[0]
    return {
        "id": str(item["id"]),
        "awemeId": item["aweme_id"],
        "ownerUserId": author_id,
        "origin": "douyin_download_manager",
        "status": "normal",
        "visibility": "local_only",
        "mediaType": media_type,
        "galleryCount": len(gallery_items),
        "galleryItems": gallery_items,
        "galleryImages": [entry for entry in gallery_items if entry["type"] == "image"],
        "title": item["title"],
        "description": item["description"],
        "tags": [str(tag) for tag in tags if str(tag).strip()][:24],
        "author": {
            "id": author_id,
            "secUid": sec_uid,
            "uid": author_uid,
            "name": item["author"],
            "avatarUrl": row_text(row, "author_avatar_url"),
            "profileUrl": first_text(row_text(row, "author_url"), f"https://www.douyin.com/user/{sec_uid}" if sec_uid else ""),
            "following": False,
        },
        "publishedAt": published_at,
        "likedAt": item["downloaded_at"],
        "durationMs": row_int(row, "duration_ms"),
        "width": int_or_none(fanhao_media.get("width")) or int_or_none(record.get("width")),
        "height": int_or_none(fanhao_media.get("height")) or int_or_none(record.get("height")),
        "stats": {
            "known": any(row_int(row, key) is not None for key in ("digg_count", "comment_count", "collect_count", "share_count")),
            "likes": row_int(row, "digg_count") or 0,
            "comments": row_int(row, "comment_count") or 0,
            "collects": row_int(row, "collect_count") or 0,
            "shares": row_int(row, "share_count") or 0,
            "plays": 0,
        },
        "actions": {"liked": False, "collected": False, "disliked": False},
        "watch": {"progressMs": 0, "completedCount": 0, "completed": False, "lastWatchedAt": ""},
        "recommendation": {"score": 0, "reason": "本机已下载"},
        "sound": sound,
        "shareUrl": row_text(row, "url"),
        "originalUrl": row_text(row, "url"),
        "streamUrl": stream_url,
        "coverUrl": item["cover_url"],
        "coverSource": "local" if str(item["cover_url"]).startswith("/api/") else "remote",
        "fileName": first_text(first_media.get("file_name"), Path(str(first_media.get("path") or "")).name),
        "relativePath": "",
        "size": size,
    }


def shared_player_row(video_id: str | int) -> sqlite3.Row | None:
    key = str(video_id or "").strip()
    if not key:
        return None
    with db() as conn:
        if key.isdigit():
            row = conn.execute("SELECT * FROM links WHERE id=? AND status='downloaded'", (int(key),)).fetchone()
            if row:
                return row
        return conn.execute(
            "SELECT * FROM links WHERE aweme_id=? AND status='downloaded' ORDER BY id DESC LIMIT 1",
            (key,),
        ).fetchone()


def shared_player_neighbor(row: sqlite3.Row, direction: int) -> dict[str, Any] | None:
    current_order = first_text(
        row_text(row, "downloaded_at"),
        row_text(row, "last_started_at"),
        row_text(row, "last_seen_at"),
    )
    current_id = int(row["id"])
    if direction < 0:
        comparison = "(COALESCE(downloaded_at, last_started_at, last_seen_at, '') > ? OR (COALESCE(downloaded_at, last_started_at, last_seen_at, '') = ? AND id > ?))"
        order = "COALESCE(downloaded_at, last_started_at, last_seen_at, '') ASC, id ASC"
    else:
        comparison = "(COALESCE(downloaded_at, last_started_at, last_seen_at, '') < ? OR (COALESCE(downloaded_at, last_started_at, last_seen_at, '') = ? AND id < ?))"
        order = "COALESCE(downloaded_at, last_started_at, last_seen_at, '') DESC, id DESC"
    with db() as conn:
        candidates = conn.execute(
            f"SELECT * FROM links WHERE status='downloaded' AND {comparison} ORDER BY {order} LIMIT 32",
            (current_order, current_order, current_id),
        ).fetchall()
    for candidate in candidates:
        video = shared_player_video_from_row(candidate)
        if video:
            return video
    return None


def shared_player_detail(video_id: str) -> dict[str, Any] | None:
    row = shared_player_row(video_id)
    if not row:
        return None
    video = shared_player_video_from_row(row)
    if not video:
        return None
    previous = shared_player_neighbor(row, -1)
    next_video = shared_player_neighbor(row, 1)
    return {
        "video": video,
        "prevId": previous["id"] if previous else "",
        "nextId": next_video["id"] if next_video else "",
        "neighbors": {
            "previous": [previous] if previous else [],
            "next": [next_video] if next_video else [],
        },
    }


def shared_player_list(query: dict[str, list[str]]) -> dict[str, Any]:
    search = (query.get("q") or [""])[0].strip()
    author = (query.get("author") or [""])[0].strip()
    media_filter = (query.get("media") or ["all"])[0].strip().lower()
    limit = normalize_int((query.get("limit") or ["48"])[0], 48, 1, 120)
    offset = normalize_int((query.get("offset") or ["0"])[0], 0, 0, 1000000)
    where = ["status='downloaded'"]
    params: list[Any] = []
    if search:
        like = f"%{search}%"
        where.append("(aweme_id LIKE ? OR desc LIKE ? OR author_nickname LIKE ?)")
        params.extend([like, like, like])
    if author and author != "all":
        normalized_author = author.removeprefix("douyin:")
        where.append("(author_sec_uid=? OR author_uid=?)")
        params.extend([normalized_author, normalized_author])
    if media_filter in {"video", "gallery"}:
        if media_filter == "gallery":
            where.append("(LOWER(COALESCE(media_type, ''))='gallery' OR LOWER(COALESCE(kind, ''))='note')")
        else:
            where.append("NOT (LOWER(COALESCE(media_type, ''))='gallery' OR LOWER(COALESCE(kind, ''))='note')")
    where_sql = " AND ".join(where)
    with db() as conn:
        total = int(conn.execute(f"SELECT COUNT(*) c FROM links WHERE {where_sql}", params).fetchone()["c"])
        rows = conn.execute(
            f"""
            SELECT * FROM links
            WHERE {where_sql}
            ORDER BY COALESCE(downloaded_at, last_started_at, last_seen_at, '') DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()
    videos = [video for row in rows if (video := shared_player_video_from_row(row))]
    return {
        "summary": None,
        "total": total,
        "relationshipTotal": total,
        "limit": limit,
        "offset": offset,
        "hasMore": offset + len(rows) < total,
        "query": search,
        "topic": "",
        "sound": "",
        "author": author,
        "media": media_filter if media_filter in {"video", "gallery"} else "all",
        "source": "liked",
        "sort": "published",
        "stats": None,
        "authors": [],
        "videos": videos,
    }


def shared_player_summary() -> dict[str, Any]:
    with db() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) videos,
                   COUNT(DISTINCT COALESCE(NULLIF(author_sec_uid, ''), NULLIF(author_uid, ''), NULLIF(author_nickname, ''))) authors,
                   COALESCE(SUM(duration_ms), 0) duration_ms
            FROM links
            WHERE status='downloaded'
            """
        ).fetchone()
    return {
        "totals": {
            "videos": int(row["videos"] or 0),
            "authors": int(row["authors"] or 0),
            "bytes": 0,
            "durationMs": int(row["duration_ms"] or 0),
        },
        "topAuthors": [],
    }


def resolve_library_media(link_id: int, role: str = "", index: int = 0) -> Path | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM links WHERE id=? AND status='downloaded'", (link_id,)).fetchone()
    if not row:
        return None
    media = library_files_for_link(row)
    if not media:
        return None
    if role == "cover":
        return media["cover"]
    if role == "music":
        return media["music"]
    assets = media["assets"]
    if index < 0 or index >= len(assets):
        return None
    return assets[index]["path"]


def open_library_folder(link_id: int) -> dict[str, Any]:
    path = resolve_library_media(link_id)
    if path is None:
        return {"ok": False, "message": "没有找到本地文件"}
    folder = path.parent
    if os.name == "nt" and hasattr(os, "startfile"):
        os.startfile(str(folder))
        return {"ok": True, "message": "已打开下载目录"}
    return {"ok": False, "message": f"下载目录：{folder}"}
