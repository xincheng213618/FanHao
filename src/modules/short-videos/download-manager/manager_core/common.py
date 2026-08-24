"""Internal common responsibilities for the download manager."""

from __future__ import annotations

import json
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config import LIBRARY_SEC_UID


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def iso_from_timestamp(value: float | None) -> str:
    if not value:
        return ""
    return datetime.fromtimestamp(value, timezone.utc).astimezone().isoformat(timespec="seconds")


def elapsed_ms(started: float | None) -> int | None:
    if started is None:
        return None
    return int((time.monotonic() - started) * 1000)


def tail_text(path: Path, limit: int) -> str:
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    return data[-limit:].decode("utf-8", errors="replace")


def normalize_int(value: Any, default: int, min_value: int, max_value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(min_value, min(max_value, parsed))


def normalize_proxy(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if "://" not in text:
        text = f"http://{text}"
    return text


def normalize_profile_tab(value: Any) -> str:
    tab = str(value or "auto").strip().lower()
    return tab if tab in {"auto", "like", "post"} else "auto"


def parse_profile_url(url: str, profile_tab: Any = "auto") -> dict[str, str]:
    raw = (url or "").strip()
    selected_tab = normalize_profile_tab(profile_tab)
    try:
        parsed = urlparse(raw)
        path_match = re.search(r"/user/([^/?#]+)", parsed.path)
        sec_uid = path_match.group(1) if path_match else raw
        if sec_uid.lower() == "self":
            sec_uid = LIBRARY_SEC_UID
        query = parse_qs(parsed.query)
        show_tab = (query.get("showTab") or [""])[0].lower()
        tab = selected_tab if selected_tab in {"like", "post"} else ("like" if show_tab == "like" else "post")
        canonical = f"https://www.douyin.com/user/{sec_uid}"
        if tab == "like":
            canonical += "?showTab=like"
        return {
            "sec_uid": sec_uid,
            "tab": tab,
            "url": canonical,
            "raw_url": raw,
        }
    except Exception:
        return {
            "sec_uid": raw,
            "tab": selected_tab if selected_tab in {"like", "post"} else "post",
            "url": raw,
            "raw_url": raw,
        }


def tab_label(tab: str) -> str:
    return {"like": "喜欢", "post": "作品"}.get(tab, tab or "作品")


def work_id_from_url(url: str) -> str | None:
    match = re.search(r"/(?:video|note|gallery|slides)/(\d{16,22})(?:\D|$)", url or "")
    return match.group(1) if match else None


def safe_path_segment(value: str) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", (value or "").strip())
    text = text.rstrip(" .")
    return text[:120] or "unknown"


def row_text(row: sqlite3.Row | dict[str, Any], key: str) -> str:
    try:
        return first_text(row[key])
    except (KeyError, IndexError):
        return ""


def row_int(row: sqlite3.Row | dict[str, Any], key: str) -> int | None:
    try:
        return int_or_none(row[key])
    except (KeyError, IndexError):
        return None


def flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value] if value.strip() else []
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, list):
            out.extend(flatten_strings(item))
        elif isinstance(item, str) and item.strip():
            out.append(item.strip())
    return out


def iso_from_create_time(value: Any) -> str:
    ts = int_or_none(value)
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (OSError, OverflowError, ValueError):
        return ""


def first_text(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def int_or_none(value: Any) -> int | None:
    try:
        if value in ("", None):
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def first_int(*values: Any) -> int | None:
    for value in values:
        parsed = int_or_none(value)
        if parsed is not None:
            return parsed
    return None


def json_text(value: Any) -> str:
    if value in ("", None):
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return ""


def clean_profile_nickname(*values: Any) -> str:
    text = first_text(*values)
    if not text or len(text) > 32:
        return ""
    lowered = text.lower()
    if "captcha" in lowered or lowered.endswith((".zip", ".rar", ".7z")):
        return ""
    if text in {"搜索", "推荐", "关注", "粉丝", "获赞", "作品", "读屏标签已关闭", "读屏标签已开启"}:
        return ""
    return text
