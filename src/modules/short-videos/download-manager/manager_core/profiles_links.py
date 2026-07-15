"""Internal profiles links responsibilities for the download manager."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .common import clean_profile_nickname, first_text, int_or_none, json_text, now_iso, parse_profile_url
from .config import TEST_PROFILE_URL
from .database import db, setting
from .domain_manifest import author_sec_uid_from_manifest, douyin_user_url, kind_from_manifest, manifest_cover_path, manifest_music_metadata, manifest_preview_path, sync_manifest_files
from .profile_domain import normalize_profile_metadata
from .queue import ensure_profile_in_download_queue


def manifest_import_row(record: dict[str, Any]) -> dict[str, Any] | None:
    aweme_id = str(record.get("aweme_id") or "").strip()
    if not aweme_id:
        return None
    kind = kind_from_manifest(record)
    preview_path = manifest_preview_path(record)
    return {
        "aweme_id": aweme_id,
        "kind": kind,
        "url": f"https://www.douyin.com/{'note' if kind == 'note' else 'video'}/{aweme_id}",
        "author_nickname": first_text(record.get("author_name")),
        "author_sec_uid": author_sec_uid_from_manifest(record),
        "author_avatar_url": first_text(record.get("author_avatar_url")),
        "author_url": first_text(record.get("author_url")),
        "desc": first_text(record.get("desc")),
        "cover_url": first_text(record.get("cover_url"), record.get("cover")),
        "create_time": int_or_none(record.get("publish_timestamp") or record.get("create_time")),
        "media_type": first_text(record.get("media_type"), "gallery" if kind == "note" else "video"),
        "local_file_names": json_text(record.get("file_names")),
        "local_file_paths": json_text(record.get("file_paths")),
        "local_cover_path": manifest_cover_path(record),
        "preview_path": preview_path,
        "metadata_json": json_text(record),
        **manifest_music_metadata(record),
        "downloaded_at": first_text(record.get("recorded_at")),
        "manifest_record": record,
    }


def import_manifest_to_db(
    profile_id: int,
    manifest_path: str | Path,
    output_dir: str | Path | None = None,
) -> dict[str, int | str]:
    path = Path(manifest_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"manifest 不存在：{path}")
    resolved_output_dir = Path(output_dir).expanduser().resolve() if output_dir else path.parent
    records: dict[str, dict[str, Any]] = {}
    total = bad = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            total += 1
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            row = manifest_import_row(record)
            if row is None:
                bad += 1
                continue
            records[row["aweme_id"]] = row

    ts = now_iso()
    inserted = updated = files_imported = 0
    with db() as conn:
        for row in records.values():
            before = conn.execute(
                "SELECT id FROM links WHERE profile_id=? AND aweme_id=?",
                (profile_id, row["aweme_id"]),
            ).fetchone()
            if before:
                updated += 1
            else:
                inserted += 1
            conn.execute(
                """
                INSERT INTO links(
                  profile_id, aweme_id, kind, url,
                  author_sec_uid, author_nickname, author_avatar_url, author_url,
                  desc, cover_url, create_time, media_type,
                  local_file_names, local_file_paths, local_cover_path, preview_path, metadata_json,
                  music_id, music_title, music_author, music_cover_url, music_play_url, local_music_path,
                  status, discovered_at, last_seen_at, downloaded_at, output_dir, last_error
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'downloaded', ?, ?, ?, ?, NULL)
                ON CONFLICT(profile_id, aweme_id) DO UPDATE SET
                  kind=excluded.kind,
                  url=excluded.url,
                  author_sec_uid=COALESCE(NULLIF(excluded.author_sec_uid, ''), links.author_sec_uid),
                  author_nickname=COALESCE(NULLIF(excluded.author_nickname, ''), links.author_nickname),
                  author_avatar_url=COALESCE(NULLIF(excluded.author_avatar_url, ''), links.author_avatar_url),
                  author_url=COALESCE(NULLIF(excluded.author_url, ''), links.author_url),
                  desc=COALESCE(NULLIF(excluded.desc, ''), links.desc),
                  cover_url=COALESCE(NULLIF(excluded.cover_url, ''), links.cover_url),
                  create_time=COALESCE(excluded.create_time, links.create_time),
                  media_type=COALESCE(NULLIF(excluded.media_type, ''), links.media_type),
                  local_file_names=COALESCE(NULLIF(excluded.local_file_names, ''), links.local_file_names),
                  local_file_paths=COALESCE(NULLIF(excluded.local_file_paths, ''), links.local_file_paths),
                  local_cover_path=COALESCE(NULLIF(excluded.local_cover_path, ''), links.local_cover_path),
                  preview_path=COALESCE(NULLIF(excluded.preview_path, ''), links.preview_path),
                  metadata_json=COALESCE(NULLIF(excluded.metadata_json, ''), links.metadata_json),
                  music_id=COALESCE(NULLIF(excluded.music_id, ''), links.music_id),
                  music_title=COALESCE(NULLIF(excluded.music_title, ''), links.music_title),
                  music_author=COALESCE(NULLIF(excluded.music_author, ''), links.music_author),
                  music_cover_url=COALESCE(NULLIF(excluded.music_cover_url, ''), links.music_cover_url),
                  music_play_url=COALESCE(NULLIF(excluded.music_play_url, ''), links.music_play_url),
                  local_music_path=COALESCE(NULLIF(excluded.local_music_path, ''), links.local_music_path),
                  status='downloaded',
                  downloaded_at=COALESCE(NULLIF(excluded.downloaded_at, ''), links.downloaded_at, ?),
                  output_dir=excluded.output_dir,
                  last_error=NULL,
                  last_seen_at=excluded.last_seen_at
                """,
                (
                    profile_id,
                    row["aweme_id"],
                    row["kind"],
                    row["url"],
                    row["author_sec_uid"],
                    row["author_nickname"],
                    row["author_avatar_url"],
                    row["author_url"],
                    row["desc"],
                    row["cover_url"],
                    row["create_time"],
                    row["media_type"],
                    row["local_file_names"],
                    row["local_file_paths"],
                    row["local_cover_path"],
                    row["preview_path"],
                    row["metadata_json"],
                    row["music_id"],
                    row["music_title"],
                    row["music_author"],
                    row["music_cover_url"],
                    row["music_play_url"],
                    row["local_music_path"],
                    ts,
                    ts,
                    row["downloaded_at"] or ts,
                    str(resolved_output_dir),
                    ts,
                ),
            )
            files_imported += sync_manifest_files(
                conn,
                profile_id,
                row["aweme_id"],
                resolved_output_dir,
                row["manifest_record"],
            )
        conn.execute("UPDATE profiles SET updated_at=? WHERE id=?", (ts, profile_id))
        conn.execute(
            "INSERT INTO events(ts, level, message) VALUES(?, 'info', ?)",
            (
                ts,
                f"manifest 同步完成：{len(records)} 条，新 {inserted}，更新 {updated}，文件 {files_imported}",
            ),
        )
    return {
        "total_lines": total,
        "unique": len(records),
        "inserted": inserted,
        "updated": updated,
        "files": files_imported,
        "duplicates": max(0, total - bad - len(records)),
        "bad": bad,
        "manifest": str(path),
        "output_dir": str(resolved_output_dir),
    }


def upsert_profile(url: str, profile_tab: Any | None = None) -> int:
    parsed = parse_profile_url(url, setting("profile_tab", "auto") if profile_tab is None else profile_tab)
    ts = now_iso()
    with db() as conn:
        row = conn.execute("SELECT id FROM profiles WHERE url=?", (parsed["url"],)).fetchone()
        if row:
            conn.execute(
                """
                UPDATE profiles
                SET sec_uid=?, tab=?, updated_at=?
                WHERE id=?
                """,
                (parsed["sec_uid"], parsed["tab"], ts, row["id"]),
            )
            return int(row["id"])
        conn.execute(
            """
            INSERT INTO profiles(url, sec_uid, tab, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(sec_uid, tab) DO UPDATE SET
              url=excluded.url,
              updated_at=excluded.updated_at
            """,
            (parsed["url"], parsed["sec_uid"], parsed["tab"], ts, ts),
        )
        row = conn.execute(
            "SELECT id FROM profiles WHERE sec_uid=? AND tab=?",
            (parsed["sec_uid"], parsed["tab"]),
        ).fetchone()
        return int(row["id"])


def current_profile_id(create: bool = False) -> int | None:
    url = setting("profile_url", TEST_PROFILE_URL).strip()
    if not url:
        return None
    parsed = parse_profile_url(url, setting("profile_tab", "auto"))
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM profiles WHERE sec_uid=? AND tab=?",
            (parsed["sec_uid"], parsed["tab"]),
        ).fetchone()
    if row:
        return int(row["id"])
    return upsert_profile(url, setting("profile_tab", "auto")) if create else None


def upsert_profile_metadata(profile_id: int, profile: dict[str, Any] | None) -> None:
    if not profile_id or not profile:
        return
    with db() as conn:
        row = conn.execute("SELECT sec_uid FROM profiles WHERE id=?", (profile_id,)).fetchone()
        fallback_sec_uid = first_text(row["sec_uid"]) if row else ""
        meta = normalize_profile_metadata(profile, fallback_sec_uid)
        if not any(meta.get(key) not in ("", None, "{}") for key in meta):
            return
        now = now_iso()
        meta["profile_collected_at"] = now
        conn.execute(
            """
            UPDATE profiles SET
              title=COALESCE(NULLIF(?, ''), title),
              uid=COALESCE(NULLIF(?, ''), uid),
              sec_uid=COALESCE(NULLIF(?, ''), sec_uid),
              nickname=COALESCE(NULLIF(?, ''), nickname),
              avatar_url=COALESCE(NULLIF(?, ''), avatar_url),
              unique_id=COALESCE(NULLIF(?, ''), unique_id),
              short_id=COALESCE(NULLIF(?, ''), short_id),
              signature=COALESCE(NULLIF(?, ''), signature),
              ip_location=COALESCE(NULLIF(?, ''), ip_location),
              following_count=COALESCE(?, following_count),
              follower_count=COALESCE(?, follower_count),
              total_favorited=COALESCE(?, total_favorited),
              aweme_count=COALESCE(?, aweme_count),
              favoriting_count=COALESCE(?, favoriting_count),
              gender=COALESCE(?, gender),
              age=COALESCE(?, age),
              verification=COALESCE(NULLIF(?, ''), verification),
              profile_raw_json=CASE WHEN ? <> '{}' THEN ? ELSE profile_raw_json END,
              profile_collected_at=?,
              updated_at=?
            WHERE id=?
            """,
            (
                meta["nickname"],
                meta["uid"],
                meta["sec_uid"],
                meta["nickname"],
                meta["avatar_url"],
                meta["unique_id"],
                meta["short_id"],
                meta["signature"],
                meta["ip_location"],
                meta["following_count"],
                meta["follower_count"],
                meta["total_favorited"],
                meta["aweme_count"],
                meta["favoriting_count"],
                meta["gender"],
                meta["age"],
                meta["verification"],
                meta["profile_raw_json"],
                meta["profile_raw_json"],
                now,
                now,
                profile_id,
            ),
        )


def upsert_following_profiles(users: list[dict[str, Any]]) -> tuple[int, int]:
    inserted = 0
    updated = 0
    ts = now_iso()
    with db() as conn:
        for user in users:
            if not isinstance(user, dict):
                continue
            meta = normalize_profile_metadata(user)
            sec_uid = first_text(meta.get("sec_uid"))
            if not sec_uid:
                continue
            existing = conn.execute(
                "SELECT id FROM profiles WHERE sec_uid=? AND tab='post'",
                (sec_uid,),
            ).fetchone()
            profile_url = first_text(meta.get("profile_url"), douyin_user_url(sec_uid))
            conn.execute(
                """
                INSERT INTO profiles (
                  url, sec_uid, tab, title, uid, nickname, avatar_url, unique_id, short_id,
                  signature, ip_location, following_count, follower_count, total_favorited,
                  aweme_count, favoriting_count, gender, age, verification, profile_raw_json,
                  profile_collected_at, is_following, following_discovered_at, created_at, updated_at
                ) VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                ON CONFLICT(sec_uid, tab) DO UPDATE SET
                  url=excluded.url,
                  title=COALESCE(NULLIF(excluded.title, ''), profiles.title),
                  uid=COALESCE(NULLIF(excluded.uid, ''), profiles.uid),
                  nickname=COALESCE(NULLIF(excluded.nickname, ''), profiles.nickname),
                  avatar_url=COALESCE(NULLIF(excluded.avatar_url, ''), profiles.avatar_url),
                  unique_id=COALESCE(NULLIF(excluded.unique_id, ''), profiles.unique_id),
                  short_id=COALESCE(NULLIF(excluded.short_id, ''), profiles.short_id),
                  signature=COALESCE(NULLIF(excluded.signature, ''), profiles.signature),
                  ip_location=COALESCE(NULLIF(excluded.ip_location, ''), profiles.ip_location),
                  following_count=COALESCE(excluded.following_count, profiles.following_count),
                  follower_count=COALESCE(excluded.follower_count, profiles.follower_count),
                  total_favorited=COALESCE(excluded.total_favorited, profiles.total_favorited),
                  aweme_count=COALESCE(excluded.aweme_count, profiles.aweme_count),
                  favoriting_count=COALESCE(excluded.favoriting_count, profiles.favoriting_count),
                  gender=COALESCE(excluded.gender, profiles.gender),
                  age=COALESCE(excluded.age, profiles.age),
                  verification=COALESCE(NULLIF(excluded.verification, ''), profiles.verification),
                  profile_raw_json=CASE WHEN excluded.profile_raw_json <> '{}' THEN excluded.profile_raw_json ELSE profiles.profile_raw_json END,
                  profile_collected_at=COALESCE(excluded.profile_collected_at, profiles.profile_collected_at),
                  is_following=1,
                  following_discovered_at=COALESCE(profiles.following_discovered_at, excluded.following_discovered_at),
                  updated_at=excluded.updated_at
                """,
                (
                    profile_url,
                    sec_uid,
                    meta["nickname"],
                    meta["uid"],
                    meta["nickname"],
                    meta["avatar_url"],
                    meta["unique_id"],
                    meta["short_id"],
                    meta["signature"],
                    meta["ip_location"],
                    meta["following_count"],
                    meta["follower_count"],
                    meta["total_favorited"],
                    meta["aweme_count"],
                    meta["favoriting_count"],
                    meta["gender"],
                    meta["age"],
                    meta["verification"],
                    meta["profile_raw_json"],
                    ts,
                    ts,
                    ts,
                    ts,
                ),
            )
            if existing:
                updated += 1
            else:
                inserted += 1
    return inserted, updated


def upsert_links(profile_id: int, works: list[dict[str, Any]]) -> tuple[int, int]:
    ts = now_iso()
    inserted = 0
    updated = 0
    profile_author_meta: dict[str, Any] | None = None
    with db() as conn:
        profile_row = conn.execute("SELECT sec_uid, tab FROM profiles WHERE id=?", (profile_id,)).fetchone()
        profile_sec_uid = first_text(profile_row["sec_uid"]) if profile_row else ""
        profile_tab = first_text(profile_row["tab"]) if profile_row else ""
        for work in works:
            aweme_id = str(work.get("aweme_id") or "")
            url = str(work.get("url") or "")
            kind = str(work.get("kind") or "video")
            author_uid = str(work.get("author_uid") or work.get("authorUid") or "")
            author_sec_uid = str(work.get("author_sec_uid") or work.get("authorSecUid") or "")
            author_nickname = str(work.get("author_nickname") or work.get("authorNickname") or "")
            if profile_tab == "post" and profile_sec_uid and author_sec_uid != profile_sec_uid:
                continue
            author_avatar_url = first_text(work.get("author_avatar_url"), work.get("authorAvatarUrl"))
            author_url = first_text(work.get("author_url"), work.get("authorUrl"))
            if not author_url and author_sec_uid:
                author_url = f"https://www.douyin.com/user/{author_sec_uid}"
            desc = first_text(work.get("desc"), work.get("title"), work.get("caption"))
            cover_url = first_text(work.get("cover_url"), work.get("coverUrl"), work.get("thumbnail"), work.get("preview_url"))
            create_time = int_or_none(work.get("create_time") or work.get("createTime"))
            duration_ms = int_or_none(work.get("duration_ms") or work.get("duration") or work.get("durationMs"))
            digg_count = int_or_none(work.get("digg_count") or work.get("diggCount") or work.get("like_count") or work.get("likeCount"))
            comment_count = int_or_none(work.get("comment_count") or work.get("commentCount"))
            share_count = int_or_none(work.get("share_count") or work.get("shareCount"))
            collect_count = int_or_none(work.get("collect_count") or work.get("collectCount"))
            media_type = first_text(work.get("media_type"), work.get("mediaType"), "gallery" if kind == "note" else "video")
            local_file_names = json_text(work.get("local_file_names") or work.get("localFileNames"))
            local_file_paths = json_text(work.get("local_file_paths") or work.get("localFilePaths"))
            preview_path = first_text(work.get("preview_path"), work.get("previewPath"))
            metadata_json = json_text(work.get("metadata"))
            if not aweme_id or not url:
                continue
            before = conn.execute(
                "SELECT id FROM links WHERE profile_id=? AND aweme_id=?",
                (profile_id, aweme_id),
            ).fetchone()
            if before:
                updated += 1
            else:
                inserted += 1
            conn.execute(
                """
                INSERT INTO links(
                  profile_id, aweme_id, kind, url,
                  author_uid, author_sec_uid, author_nickname, author_avatar_url, author_url,
                  desc, cover_url, create_time, duration_ms,
                  digg_count, comment_count, share_count, collect_count,
                  media_type, local_file_names, local_file_paths, preview_path, metadata_json,
                  status, discovered_at, last_seen_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(profile_id, aweme_id) DO UPDATE SET
                  kind=excluded.kind,
                  url=excluded.url,
                  author_uid=COALESCE(NULLIF(excluded.author_uid, ''), links.author_uid),
                  author_sec_uid=COALESCE(NULLIF(excluded.author_sec_uid, ''), links.author_sec_uid),
                  author_nickname=COALESCE(NULLIF(excluded.author_nickname, ''), links.author_nickname),
                  author_avatar_url=COALESCE(NULLIF(excluded.author_avatar_url, ''), links.author_avatar_url),
                  author_url=COALESCE(NULLIF(excluded.author_url, ''), links.author_url),
                  desc=COALESCE(NULLIF(excluded.desc, ''), links.desc),
                  cover_url=COALESCE(NULLIF(excluded.cover_url, ''), links.cover_url),
                  create_time=COALESCE(excluded.create_time, links.create_time),
                  duration_ms=COALESCE(excluded.duration_ms, links.duration_ms),
                  digg_count=COALESCE(excluded.digg_count, links.digg_count),
                  comment_count=COALESCE(excluded.comment_count, links.comment_count),
                  share_count=COALESCE(excluded.share_count, links.share_count),
                  collect_count=COALESCE(excluded.collect_count, links.collect_count),
                  media_type=COALESCE(NULLIF(excluded.media_type, ''), links.media_type),
                  local_file_names=COALESCE(NULLIF(excluded.local_file_names, ''), links.local_file_names),
                  local_file_paths=COALESCE(NULLIF(excluded.local_file_paths, ''), links.local_file_paths),
                  preview_path=COALESCE(NULLIF(excluded.preview_path, ''), links.preview_path),
                  metadata_json=COALESCE(NULLIF(excluded.metadata_json, ''), links.metadata_json),
                  last_seen_at=excluded.last_seen_at
                """,
                (
                    profile_id,
                    aweme_id,
                    kind,
                    url,
                    author_uid,
                    author_sec_uid,
                    author_nickname,
                    author_avatar_url,
                    author_url,
                    desc,
                    cover_url,
                    create_time,
                    duration_ms,
                    digg_count,
                    comment_count,
                    share_count,
                    collect_count,
                    media_type,
                    local_file_names,
                    local_file_paths,
                    preview_path,
                    metadata_json,
                    ts,
                    ts,
                ),
            )
        conn.execute(
            "UPDATE profiles SET last_extracted_at=?, updated_at=? WHERE id=?",
            (ts, ts, profile_id),
        )
        ensure_profile_in_download_queue(conn, profile_id)
        if profile_tab == "post" and profile_sec_uid:
            conn.execute(
                """
                DELETE FROM links
                WHERE profile_id=?
                  AND COALESCE(author_sec_uid, '') <> ?
                """,
                (profile_id, profile_sec_uid),
            )
            row = conn.execute(
                """
                SELECT author_uid, author_sec_uid, author_nickname, author_avatar_url, author_url, COUNT(*) c
                FROM links
                WHERE profile_id=?
                  AND author_sec_uid=?
                GROUP BY author_uid, author_sec_uid, author_nickname, author_avatar_url, author_url
                ORDER BY c DESC
                LIMIT 1
                """,
                (profile_id, profile_sec_uid),
            ).fetchone()
            if row:
                profile_author_meta = {
                    "uid": first_text(row["author_uid"]),
                    "sec_uid": profile_sec_uid,
                    "nickname": clean_profile_nickname(row["author_nickname"]),
                    "avatar_url": first_text(row["author_avatar_url"]),
                    "profile_url": first_text(row["author_url"], douyin_user_url(profile_sec_uid)),
                }
                conn.execute(
                    """
                    UPDATE profiles
                    SET uid=COALESCE(NULLIF(?, ''), uid),
                        nickname=COALESCE(NULLIF(?, ''), nickname),
                        avatar_url=COALESCE(NULLIF(?, ''), avatar_url),
                        updated_at=?
                    WHERE id=?
                    """,
                    (
                        profile_author_meta["uid"],
                        profile_author_meta["nickname"],
                        profile_author_meta["avatar_url"],
                        ts,
                        profile_id,
                    ),
                )
    return inserted, updated
