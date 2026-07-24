"""Internal http api responsibilities for the download manager."""

from __future__ import annotations

import json
import mimetypes
import re
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .auth import clear_cookie_auth, cookie_auth_status, import_cookie_text, open_cookie_folder, start_cookie_login
from .common import first_text, int_or_none, normalize_int, normalize_profile_tab, normalize_proxy, now_iso, parse_profile_url, work_id_from_url
from .config import BASE_DIR, DEFAULT_FAILURE_GUARD_THRESHOLD, DEFAULT_OUTPUT_DIR, FANHAO_PUBLIC_DIR, MAX_CONCURRENCY, STATIC_DIR, TEST_PROFILE_URL
from .database import add_event, db, set_setting, setting
from .domain_manifest import profile_output_dir
from .download_supervisor import download_manager
from .downloader_client import fetch_aweme_comments
from .extraction import start_extract, start_following_import, start_refresh_profiles, stop_extract
from .library import list_library, open_library_folder, resolve_library_media, shared_player_detail, shared_player_list, shared_player_neighbor, shared_player_row, shared_player_summary, shared_player_video_from_row
from .maintenance import delete_empty_failed_links, delete_failed_links, delete_link, delete_profile, queue_gallery_music_backfill, reset_failed_links
from .profiles_links import current_profile_id, import_manifest_to_db, upsert_links, upsert_profile
from .queue import ensure_profile_in_download_queue, move_download_queue_item, sort_download_queue_by_pending
from .read_models import get_state, list_links, list_profiles
from .runtime import activate_application, request_application_quit


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self.send_json({"ok": True, "paths": {"base": str(BASE_DIR)}})
        if parsed.path == "/api/state":
            return self.send_json(get_state())
        if parsed.path == "/api/short-videos/summary":
            return self.send_json(shared_player_summary())
        if parsed.path == "/api/short-videos/suggestions":
            return self.send_json({"query": (parse_qs(parsed.query).get("q") or [""])[0], "suggestions": []})
        if parsed.path == "/api/short-videos/authors":
            return self.send_json({"authors": [], "total": 0, "scopeTotal": 0, "unlikedTotal": 0, "hasMore": False})
        if parsed.path == "/api/short-videos":
            return self.send_json(shared_player_list(parse_qs(parsed.query)))
        adjacent_match = re.fullmatch(r"/api/short-videos/([^/]+)/adjacent", parsed.path)
        if adjacent_match:
            row = shared_player_row(adjacent_match.group(1))
            direction = -1 if (parse_qs(parsed.query).get("direction") or [""])[0] == "prev" else 1
            video = shared_player_neighbor(row, direction) if row else None
            if not video:
                return self.send_error(HTTPStatus.NOT_FOUND, "Adjacent video not found")
            return self.send_json({"video": video})
        comments_match = re.fullmatch(r"/api/short-videos/([^/]+)/comments", parsed.path)
        if comments_match:
            return self.send_json({"videoId": comments_match.group(1), "total": 0, "comments": []})
        related_match = re.fullmatch(r"/api/short-videos/([^/]+)/related", parsed.path)
        if related_match:
            return self.send_json({"videoId": related_match.group(1), "total": 0, "videos": []})
        detail_match = re.fullmatch(r"/api/short-videos/([^/]+)", parsed.path)
        if detail_match:
            detail = shared_player_detail(detail_match.group(1))
            if not detail:
                return self.send_error(HTTPStatus.NOT_FOUND, "Short video not found")
            return self.send_json(detail)
        if parsed.path == "/api/library":
            return self.send_json(list_library(parse_qs(parsed.query)))
        if parsed.path == "/api/library/media":
            query = parse_qs(parsed.query)
            link_id = normalize_int((query.get("id") or ["0"])[0], 0, 0, 1000000000)
            index = normalize_int((query.get("index") or ["0"])[0], 0, 0, 100000)
            role = (query.get("role") or [""])[0].strip().lower()
            path = resolve_library_media(link_id, role, index)
            if path is None:
                return self.send_error(HTTPStatus.NOT_FOUND, "Local media not found")
            return self.serve_media(path)
        if parsed.path == "/api/auth/status":
            return self.send_json({"ok": True, "auth": cookie_auth_status()})
        if parsed.path == "/api/profiles":
            return self.send_json(list_profiles(parse_qs(parsed.query)))
        if parsed.path == "/api/links":
            return self.send_json(list_links(parse_qs(parsed.query)))
        if parsed.path == "/api/export/links.txt":
            profile_id = current_profile_id(create=False)
            if profile_id is None:
                return self.send_text("", "text/plain; charset=utf-8")
            with db() as conn:
                urls = [
                    row["url"]
                    for row in conn.execute(
                        "SELECT url FROM links WHERE profile_id=? ORDER BY id",
                        (profile_id,),
                    )
                ]
            return self.send_text("\n".join(urls) + ("\n" if urls else ""), "text/plain; charset=utf-8")
        if parsed.path == "/" or parsed.path == "/index.html":
            return self.serve_file(STATIC_DIR / "index.html")
        if re.fullmatch(r"/short-videos(?:/[^/?#]+)?", parsed.path):
            return self.serve_file(STATIC_DIR / "shared-player.html")
        if parsed.path.startswith("/fanhao/"):
            shared_path = (FANHAO_PUBLIC_DIR / parsed.path.removeprefix("/fanhao/")).resolve()
            if str(shared_path).startswith(str(FANHAO_PUBLIC_DIR.resolve())) and shared_path.exists():
                return self.serve_file(shared_path)
        static_path = (STATIC_DIR / parsed.path.lstrip("/")).resolve()
        if str(static_path).startswith(str(STATIC_DIR.resolve())) and static_path.exists():
            return self.serve_file(static_path)
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            if self.handle_shared_player_mutation(parsed.path, payload):
                return
            if parsed.path == "/api/settings":
                return self.handle_settings(payload)
            if parsed.path == "/api/auth/cookie/import":
                return self.send_json(import_cookie_text(str(payload.get("content") or "")))
            if parsed.path == "/api/auth/cookie/clear":
                return self.send_json(clear_cookie_auth())
            if parsed.path == "/api/auth/cookie/open-folder":
                return self.send_json(open_cookie_folder())
            if parsed.path == "/api/auth/login/start":
                return self.send_json(start_cookie_login())
            if parsed.path == "/api/library/open-folder":
                link_id = normalize_int(payload.get("id", 0), 0, 0, 1000000000)
                return self.send_json(open_library_folder(link_id))
            if parsed.path == "/api/app/activate":
                return self.send_json(activate_application())
            if parsed.path == "/api/app/quit":
                return self.send_json(request_application_quit())
            if parsed.path == "/api/extract/start":
                return self.send_json(start_extract(payload))
            if parsed.path == "/api/profiles/refresh":
                return self.send_json(start_refresh_profiles(payload))
            if parsed.path == "/api/profiles/delete":
                return self.send_json(delete_profile(payload))
            if parsed.path == "/api/comments/fetch":
                return self.send_json(fetch_aweme_comments(payload))
            if parsed.path == "/api/profiles/following/import":
                return self.send_json(start_following_import(payload))
            if parsed.path == "/api/extract/stop":
                return self.send_json(stop_extract())
            if parsed.path == "/api/download/start":
                concurrency = normalize_int(payload.get("concurrency", setting("concurrency", "8")), 8, 1, MAX_CONCURRENCY)
                set_setting("concurrency", str(concurrency))
                limit = normalize_int(payload.get("limit", 0), 0, 0, 1000000)
                watch_raw = payload.get("watch_new", True)
                watch_new = str(watch_raw).lower() not in {"0", "false", "no", "off"}
                return self.send_json(
                    download_manager.start(
                        concurrency,
                        bool(payload.get("retry_failed")),
                        limit,
                        current_profile_id(create=False),
                        watch_new,
                    )
                )
            if parsed.path == "/api/download/stop":
                return self.send_json(download_manager.stop())
            if parsed.path == "/api/download-queue/add":
                profile_id = normalize_int(payload.get("profile_id", current_profile_id(create=False) or 0), 0, 0, 1000000)
                if profile_id <= 0:
                    return self.send_json({"ok": False, "message": "当前主页还没有入库"})
                with db() as conn:
                    ensure_profile_in_download_queue(conn, profile_id)
                return self.send_json({"ok": True, "state": get_state()})
            if parsed.path == "/api/download-queue/remove":
                profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
                with db() as conn:
                    conn.execute(
                        "UPDATE profile_download_queue SET enabled=0, updated_at=? WHERE profile_id=?",
                        (now_iso(), profile_id),
                    )
                return self.send_json({"ok": True, "state": get_state()})
            if parsed.path == "/api/download-queue/move":
                profile_id = normalize_int(payload.get("profile_id", 0), 0, 0, 1000000)
                direction = str(payload.get("direction") or "").strip()
                if direction not in {"up", "down", "top"}:
                    return self.send_json({"ok": False, "message": "方向只能是 up/down/top"})
                changed = move_download_queue_item(profile_id, direction)
                return self.send_json({"ok": True, "changed": changed, "state": get_state()})
            if parsed.path == "/api/download-queue/sort":
                mode = str(payload.get("mode") or "pending_asc").strip()
                if mode != "pending_asc":
                    return self.send_json({"ok": False, "message": "目前只支持 pending_asc"})
                changed = sort_download_queue_by_pending()
                return self.send_json({"ok": True, "changed": changed, "state": get_state()})
            if parsed.path == "/api/manifest/import":
                return self.handle_manifest_import(payload)
            if parsed.path == "/api/links/reset-failed":
                return self.send_json(reset_failed_links(payload))
            if parsed.path == "/api/links/backfill-gallery-music":
                return self.send_json(queue_gallery_music_backfill(payload))
            if parsed.path == "/api/links/delete-empty-failed":
                return self.send_json(delete_empty_failed_links(payload))
            if parsed.path == "/api/links/delete-failed":
                return self.send_json(delete_failed_links(payload))
            if parsed.path == "/api/links/delete":
                return self.send_json(delete_link(payload))
            if parsed.path == "/api/links/import":
                return self.handle_import(payload)
        except Exception as exc:
            return self.send_json({"ok": False, "message": str(exc)}, status=500)
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            if self.handle_shared_player_mutation(parsed.path, payload):
                return
        except Exception as exc:
            return self.send_json({"ok": False, "message": str(exc)}, status=500)
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def handle_shared_player_mutation(self, path: str, payload: dict[str, Any]) -> bool:
        watch_match = re.fullmatch(r"/api/short-videos/([^/]+)/watch", path)
        if watch_match:
            progress = max(0, normalize_int(payload.get("progressMs", 0), 0, 0, 2147483647))
            completed = bool(payload.get("completed"))
            self.send_json(
                {
                    "ok": True,
                    "videoId": watch_match.group(1),
                    "watch": {
                        "progressMs": progress,
                        "completedCount": 1 if completed else 0,
                        "completed": completed,
                        "lastWatchedAt": now_iso(),
                    },
                }
            )
            return True
        action_match = re.fullmatch(r"/api/short-videos/([^/]+)/actions/(like|collect|dislike)", path)
        if action_match:
            active = bool(payload.get("active"))
            row = shared_player_row(action_match.group(1))
            video = shared_player_video_from_row(row) if row else None
            if video:
                key = {"like": "liked", "collect": "collected", "dislike": "disliked"}[action_match.group(2)]
                video["actions"][key] = active
            self.send_json({"ok": True, "active": active, "video": video})
            return True
        follow_match = re.fullmatch(r"/api/short-videos/(?:authors/)?([^/]+)/(?:author-follow|follow)", path)
        if follow_match:
            active = bool(payload.get("active"))
            target = follow_match.group(1).removeprefix("douyin:")
            self.send_json({"ok": True, "active": active, "targetUserId": follow_match.group(1), "secUid": target})
            return True
        comments_match = re.fullmatch(r"/api/short-videos/([^/]+)/comments", path)
        if comments_match:
            self.send_json({"ok": True, "videoId": comments_match.group(1), "total": 0, "comments": []})
            return True
        return False

    def handle_settings(self, payload: dict[str, Any]) -> None:
        allowed = {
            "profile_url",
            "profile_tab",
            "output_dir",
            "concurrency",
            "scrolls",
            "idle_rounds",
            "incremental_stop_existing",
            "profile_refresh_recent_days",
            "download_cycle_limit",
            "download_cycle_cooldown_minutes",
            "failure_guard_threshold",
            "library_output_dir",
            "cookie_file",
            "download_proxy",
            "downloader_root",
            "downloader_python",
            "downloader_run",
        }
        if "profile_url" in payload or "profile_tab" in payload:
            profile_tab = normalize_profile_tab(payload.get("profile_tab", setting("profile_tab", "auto")))
            raw_profile_url = str(payload.get("profile_url") if "profile_url" in payload else setting("profile_url", TEST_PROFILE_URL)).strip()
            if raw_profile_url:
                parsed_profile = parse_profile_url(raw_profile_url, profile_tab)
                set_setting("profile_url", parsed_profile["url"])
            set_setting("profile_tab", profile_tab)
        for key, value in payload.items():
            if key not in allowed:
                continue
            if key in {"profile_url", "profile_tab"}:
                continue
            if key == "concurrency":
                value = str(normalize_int(value, 8, 1, MAX_CONCURRENCY))
            if key == "incremental_stop_existing":
                value = str(normalize_int(value, 12, 0, 1000))
            if key == "profile_refresh_recent_days":
                value = str(normalize_int(value, 30, 0, 3650))
            if key == "download_cycle_limit":
                value = str(normalize_int(value, 350, 0, 1000000))
            if key == "download_cycle_cooldown_minutes":
                value = str(normalize_int(value, 30, 1, 1440))
            if key == "failure_guard_threshold":
                value = str(normalize_int(value, DEFAULT_FAILURE_GUARD_THRESHOLD, 0, 1000))
            if key == "download_proxy":
                value = normalize_proxy(value)
            set_setting(key, str(value))
        add_event("info", "设置已保存")
        return self.send_json({"ok": True, "state": get_state()})

    def handle_manifest_import(self, payload: dict[str, Any]) -> None:
        profile_id = current_profile_id(create=True)
        if profile_id is None:
            return self.send_json({"ok": False, "message": "当前主页还没有入库"})
        default_output_dir = profile_output_dir(setting("output_dir", str(DEFAULT_OUTPUT_DIR)), profile_id)
        manifest_path = str(payload.get("manifest_path") or "").strip()
        if not manifest_path:
            manifest_path = str(Path(default_output_dir) / "download_manifest.jsonl")
        output_dir = str(payload.get("output_dir") or "").strip() or str(Path(manifest_path).parent)
        result = import_manifest_to_db(profile_id, manifest_path, output_dir)
        return self.send_json({"ok": True, **result, "state": get_state()})

    def handle_import(self, payload: dict[str, Any]) -> None:
        profile_url = str(payload.get("profile_url") or "manual").strip()
        profile_tab = normalize_profile_tab(payload.get("profile_tab") or setting("profile_tab", "auto"))
        profile_id = upsert_profile(profile_url, profile_tab)
        raw_works = payload.get("works")
        works = []
        if isinstance(raw_works, list):
            for work in raw_works:
                if not isinstance(work, dict):
                    continue
                url = str(work.get("url") or "")
                aweme_id = str(work.get("aweme_id") or work.get("awemeId") or work_id_from_url(url) or "")
                if not aweme_id:
                    continue
                kind = str(work.get("kind") or ("note" if "/note/" in url or "/gallery/" in url or "/slides/" in url else "video"))
                if not url:
                    url = f"https://www.douyin.com/{'note' if kind == 'note' else 'video'}/{aweme_id}"
                works.append(
                    {
                        "aweme_id": aweme_id,
                        "kind": kind,
                        "url": url,
                        "author_uid": str(work.get("author_uid") or work.get("authorUid") or ""),
                        "author_sec_uid": str(work.get("author_sec_uid") or work.get("authorSecUid") or ""),
                        "author_nickname": str(work.get("author_nickname") or work.get("authorNickname") or ""),
                        "author_avatar_url": first_text(work.get("author_avatar_url"), work.get("authorAvatarUrl")),
                        "author_url": first_text(work.get("author_url"), work.get("authorUrl")),
                        "desc": first_text(work.get("desc"), work.get("title"), work.get("caption")),
                        "cover_url": first_text(work.get("cover_url"), work.get("coverUrl"), work.get("thumbnail")),
                        "create_time": int_or_none(work.get("create_time") or work.get("createTime")),
                        "duration_ms": int_or_none(work.get("duration_ms") or work.get("duration") or work.get("durationMs")),
                        "digg_count": int_or_none(work.get("digg_count") or work.get("diggCount") or work.get("like_count") or work.get("likeCount")),
                        "comment_count": int_or_none(work.get("comment_count") or work.get("commentCount")),
                        "share_count": int_or_none(work.get("share_count") or work.get("shareCount")),
                        "collect_count": int_or_none(work.get("collect_count") or work.get("collectCount")),
                        "media_type": first_text(work.get("media_type"), work.get("mediaType"), "gallery" if kind == "note" else "video"),
                    }
                )
        else:
            text = str(payload.get("text") or "")
            for line in text.splitlines():
                url = line.strip()
                if not url:
                    continue
                aweme_id = work_id_from_url(url)
                if not aweme_id:
                    continue
                kind = "note" if "/note/" in url or "/gallery/" in url or "/slides/" in url else "video"
                works.append({"aweme_id": aweme_id, "kind": kind, "url": url})
        inserted, updated = upsert_links(profile_id, works)
        add_event("info", f"手动导入 {len(works)} 条，新 {inserted}，已存在 {updated}")
        return self.send_json({"ok": True, "count": len(works), "inserted": inserted, "updated": updated})

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text: str, content_type: str) -> None:
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, path: Path) -> None:
        if path.is_dir():
            path = path / "index.html"
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if content_type.startswith("text/") or path.suffix in {".js", ".css"}:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_media(self, path: Path) -> None:
        try:
            resolved = path.resolve()
            size = resolved.stat().st_size
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Local media not found")
            return
        start = 0
        end = max(0, size - 1)
        status = HTTPStatus.OK
        range_header = self.headers.get("Range", "").strip()
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not match:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            raw_start, raw_end = match.groups()
            if raw_start:
                start = int(raw_start)
                end = int(raw_end) if raw_end else end
            elif raw_end:
                suffix = min(size, int(raw_end))
                start = max(0, size - suffix)
            if start >= size or end < start:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            end = min(end, size - 1)
            status = HTTPStatus.PARTIAL_CONTENT
        content_length = max(0, end - start + 1)
        content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("Content-Length", str(content_length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with resolved.open("rb") as handle:
                handle.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
