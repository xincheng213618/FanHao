"""Internal downloader client responsibilities for the download manager."""

from __future__ import annotations

import json
import os
import random
import re
import socket
import sqlite3
import string
import subprocess
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from .auth import parse_netscape_cookie_dict
from .common import normalize_int, normalize_proxy
from .config import (
    BASE_DIR,
    CONFIG_DIR,
    DEFAULT_COOKIE_FILE,
    DOWNLOADER_PYTHON,
    DOWNLOADER_ROOT,
    DOWNLOADER_RUN,
    downloader_root_env_value,
)
from .database import setting


def configured_downloader_paths() -> tuple[Path, Path, Path]:
    """Resolve the effective root, interpreter, and entrypoint.

    ``DOUYIN_DOWNLOADER_ROOT`` is an explicit runtime override. When it is
    present, derived paths from that root take precedence over SQLite values.
    """

    environment_root = downloader_root_env_value()
    if environment_root:
        repo_root = Path(environment_root).expanduser().resolve()
        return (
            repo_root,
            repo_root / ".venv" / "Scripts" / "python.exe",
            repo_root / "run.py",
        )
    return (
        Path(setting("downloader_root", str(DOWNLOADER_ROOT))).expanduser().resolve(),
        Path(setting("downloader_python", str(DOWNLOADER_PYTHON))).expanduser().resolve(),
        Path(setting("downloader_run", str(DOWNLOADER_RUN))).expanduser().resolve(),
    )


def downloader_command(args: list[str]) -> tuple[list[str], Path]:
    repo_root, python_exe, run_py = configured_downloader_paths()
    downloader_exe = repo_root / "douyin-downloader.exe"
    if downloader_exe.is_file():
        return [str(downloader_exe), *args], repo_root
    if not python_exe.exists() or not run_py.exists():
        raise RuntimeError("下载器路径不存在，请检查设置")
    return [str(python_exe), str(run_py), *args], repo_root


def fallback_ms_token() -> str:
    return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(182)) + "=="


def write_sidecar_config(output_dir: str, concurrency: int) -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    api_rate_limit = max(8, concurrency * 4)
    proxy = normalize_proxy(setting("download_proxy", ""))
    cookies = parse_netscape_cookie_dict(setting("cookie_file", str(DEFAULT_COOKIE_FILE)))
    if cookies and not str(cookies.get("msToken") or "").strip():
        cookies["msToken"] = fallback_ms_token()
    if cookies:
        (CONFIG_DIR / ".cookies.json").write_text(
            json.dumps(cookies, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    config_path = CONFIG_DIR / "sidecar.yml"
    body = "\n".join(
        [
            f"path: {json.dumps(output_dir, ensure_ascii=False)}",
            "auto_cookie: true",
            "music: false",
            "gallery_music: true",
            "gallery_music_required: true",
            "video_quality: highest_resolution",
            "cover: true",
            "avatar: true",
            "json: true",
            "download_pinned: false",
            "folderstyle: true",
            'filename_template: "{date}_{title}_{id}"',
            'folder_template: "{date}_{title}_{id}"',
            'author_dir: "nickname_uid"',
            "mode:",
            "  - post",
            "number:",
            "  post: 0",
            "  like: 0",
            "  allmix: 0",
            "  mix: 0",
            "  music: 0",
            "  collect: 0",
            "  collectmix: 0",
            "increase:",
            "  post: false",
            "  like: false",
            "  allmix: false",
            "  mix: false",
            "  music: false",
            f"thread: {concurrency}",
            f"rate_limit: {api_rate_limit}",
            "rate_jitter: 0.03",
            "local_dedupe: false",
            "retry_times: 3",
            f"proxy: {json.dumps(proxy, ensure_ascii=False)}",
            "database: false",
            "progress:",
            "  quiet_logs: true",
            "comments:",
            "  enabled: false",
            "transcript:",
            "  enabled: false",
            "server:",
            "  max_jobs: 2000",
            "  job_ttl_seconds: 86400",
            "",
        ]
    )
    config_path.write_text(body, encoding="utf-8")
    return config_path


def fetch_aweme_comments(payload: dict[str, Any]) -> dict[str, Any]:
    aweme_id = str(payload.get("aweme_id") or "").strip()
    if not re.fullmatch(r"\d{8,32}", aweme_id):
        return {"ok": False, "message": "需要有效的抖音作品 ID"}
    max_comments = normalize_int(payload.get("max_comments", 100), 100, 1, 500)
    include_replies = bool(payload.get("include_replies", False))
    downloader_root, downloader_python, _ = configured_downloader_paths()
    helper = BASE_DIR / "fetch-comments.py"
    if not downloader_python.is_file() or not downloader_root.is_dir() or not helper.is_file():
        return {"ok": False, "message": "评论采集依赖不完整"}
    cookies = parse_netscape_cookie_dict(setting("cookie_file", str(DEFAULT_COOKIE_FILE)))
    if not cookies:
        return {"ok": False, "message": "没有可用的抖音登录 Cookie"}
    if not str(cookies.get("msToken") or "").strip():
        cookies["msToken"] = fallback_ms_token()
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    cookie_json = CONFIG_DIR / ".comment-cookies.json"
    cookie_json.write_text(json.dumps(cookies, ensure_ascii=False), encoding="utf-8")
    cmd = [
        str(downloader_python),
        str(helper),
        "--downloader-root",
        str(downloader_root),
        "--cookie-json",
        str(cookie_json),
        "--aweme-id",
        aweme_id,
        "--max-comments",
        str(max_comments),
    ]
    if include_replies:
        cmd.append("--include-replies")
    child_env = os.environ.copy()
    child_env["PYTHONIOENCODING"] = "utf-8"
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
            env=child_env,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": "抖音评论拉取超时"}
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "评论采集失败").strip()
        return {"ok": False, "message": message[-800:]}
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        return {"ok": False, "message": "评论采集没有返回数据"}
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return {"ok": False, "message": "评论采集返回格式无效"}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def sidecar_json(port: int, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = Request(f"http://127.0.0.1:{port}{path}", data=body, headers=headers, method=method)
    with urlopen(req, timeout=10) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    return json.loads(text) if text else {}


def write_config(link: sqlite3.Row, output_dir: str, worker_id: int) -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    config_path = CONFIG_DIR / f"link-{link['id']}-worker-{worker_id}.yml"
    proxy = normalize_proxy(setting("download_proxy", ""))
    body = "\n".join(
        [
            "link:",
            f"  - {json.dumps(link['url'], ensure_ascii=False)}",
            f"path: {json.dumps(output_dir, ensure_ascii=False)}",
            "auto_cookie: true",
            "music: true",
            "cover: true",
            "avatar: true",
            "json: true",
            "video_quality: highest_resolution",
            "download_pinned: false",
            "folderstyle: true",
            'filename_template: "{date}_{title}_{id}"',
            'folder_template: "{date}_{title}_{id}"',
            'author_dir: "nickname_uid"',
            "mode:",
            "  - post",
            "number:",
            "  post: 0",
            "  like: 0",
            "  allmix: 0",
            "  mix: 0",
            "  music: 0",
            "  collect: 0",
            "  collectmix: 0",
            "increase:",
            "  post: false",
            "  like: false",
            "  allmix: false",
            "  mix: false",
            "  music: false",
            "thread: 4",
            "retry_times: 3",
            f"proxy: {json.dumps(proxy, ensure_ascii=False)}",
            "database: false",
            "progress:",
            "  quiet_logs: true",
            "comments:",
            "  enabled: false",
            "transcript:",
            "  enabled: false",
            "",
        ]
    )
    config_path.write_text(body, encoding="utf-8")
    return config_path
