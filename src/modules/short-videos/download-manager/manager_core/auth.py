"""Internal auth responsibilities for the download manager."""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from .common import iso_from_timestamp, now_iso, tail_text
from .config import BASE_DIR, CONFIG_DIR, DATA_DIR, DEFAULT_COOKIE_FILE, LOG_DIR, NODE_EXECUTABLE
from .database import add_event, setting


cookie_login_lock = threading.Lock()


cookie_login_process: subprocess.Popen[Any] | None = None


cookie_login_state: dict[str, Any] = {
    "status": "idle",
    "message": "",
    "started_at": "",
    "finished_at": "",
}


def parse_netscape_cookie_text(text: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_") :]
        elif line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        name = parts[5].strip()
        value = "\t".join(parts[6:]).strip()
        if name:
            cookies[name] = value
    return cookies


def parse_netscape_cookie_dict(file: str) -> dict[str, str]:
    path = Path(file)
    if not path.exists():
        return {}
    try:
        return parse_netscape_cookie_text(path.read_text(encoding="utf-8-sig"))
    except OSError:
        return {}


def cookie_file_path() -> Path:
    return Path(setting("cookie_file", str(DEFAULT_COOKIE_FILE))).expanduser().resolve()


def cookie_login_snapshot() -> dict[str, Any]:
    with cookie_login_lock:
        state = dict(cookie_login_state)
        process = cookie_login_process
        state["active"] = process is not None and process.poll() is None
    return state


def cookie_auth_status() -> dict[str, Any]:
    path = cookie_file_path()
    cookies = parse_netscape_cookie_dict(str(path))
    session_names = sorted(
        name for name in ("sessionid", "sessionid_ss", "sid_guard", "sid_tt") if cookies.get(name)
    )
    exists = path.is_file()
    modified_at = ""
    size = 0
    if exists:
        try:
            stat = path.stat()
            size = stat.st_size
            modified_at = iso_from_timestamp(stat.st_mtime)
        except OSError:
            pass
    if session_names:
        status = "ready"
        message = "已读取抖音登录信息"
    elif cookies:
        status = "incomplete"
        message = "Cookie 已存在，但没有检测到登录凭证"
    else:
        status = "missing"
        message = "尚未设置抖音登录信息"
    return {
        "status": status,
        "message": message,
        "path": str(path),
        "exists": exists,
        "modified_at": modified_at,
        "size": size,
        "cookie_count": len(cookies),
        "has_session": bool(session_names),
        "has_ms_token": bool(cookies.get("msToken")),
        "session_cookie_names": session_names,
        "login": cookie_login_snapshot(),
    }


def invalidate_generated_cookies() -> None:
    try:
        (CONFIG_DIR / ".cookies.json").unlink(missing_ok=True)
    except OSError:
        pass


def import_cookie_text(content: str) -> dict[str, Any]:
    if not isinstance(content, str) or not content.strip():
        return {"ok": False, "message": "Cookie 文件内容为空"}
    if len(content.encode("utf-8")) > 2 * 1024 * 1024:
        return {"ok": False, "message": "Cookie 文件不能超过 2 MB"}
    cookies = parse_netscape_cookie_text(content)
    if not cookies:
        return {"ok": False, "message": "没有识别到 Netscape 格式 Cookie"}
    path = cookie_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.endswith("\n"):
        normalized += "\n"
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(normalized, encoding="utf-8")
    temp_path.replace(path)
    invalidate_generated_cookies()
    status = cookie_auth_status()
    add_event("info", f"已导入抖音 Cookie：{status['cookie_count']} 项")
    return {"ok": True, "message": status["message"], "auth": status}


def clear_cookie_auth() -> dict[str, Any]:
    login = cookie_login_snapshot()
    if login.get("active"):
        return {"ok": False, "message": "Edge 登录正在进行，请先完成或关闭登录窗口"}
    path = cookie_file_path()
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        return {"ok": False, "message": f"无法删除 Cookie 文件：{exc}"}
    invalidate_generated_cookies()
    profile_dir = (DATA_DIR / "browser-login-profile").resolve()
    try:
        if profile_dir.exists() and str(profile_dir).startswith(str(DATA_DIR.resolve())):
            shutil.rmtree(profile_dir)
    except OSError:
        pass
    add_event("warn", "抖音登录信息已清除")
    return {"ok": True, "message": "抖音登录信息已清除", "auth": cookie_auth_status()}


def open_cookie_folder() -> dict[str, Any]:
    path = cookie_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name != "nt" or not hasattr(os, "startfile"):
        return {"ok": False, "message": f"Cookie 目录：{path.parent}"}
    os.startfile(str(path.parent))
    return {"ok": True, "message": "已打开 Cookie 目录", "path": str(path.parent)}


def monitor_cookie_login(process: subprocess.Popen[Any], log_path: Path) -> None:
    global cookie_login_process
    code = process.wait()
    status = cookie_auth_status()
    success = code == 0 and status.get("has_session")
    message = "登录成功，Cookie 已自动保存" if success else "登录未完成"
    if not success and log_path.exists():
        tail = tail_text(log_path, 800).strip().splitlines()
        if tail:
            message = tail[-1][:300]
    with cookie_login_lock:
        if cookie_login_process is process:
            cookie_login_process = None
        cookie_login_state.update(
            {
                "status": "success" if success else "failed",
                "message": message,
                "finished_at": now_iso(),
            }
        )
    add_event("info" if success else "warn", message)


def start_cookie_login() -> dict[str, Any]:
    global cookie_login_process
    with cookie_login_lock:
        already_running = cookie_login_process is not None and cookie_login_process.poll() is None
    if already_running:
        return {"ok": True, "message": "Edge 登录窗口已经打开", "auth": cookie_auth_status()}
    node = NODE_EXECUTABLE
    if not Path(node).exists() and shutil.which(node) is None:
        return {"ok": False, "message": "未找到内置 Node.js，无法打开 Edge 登录"}
    script = BASE_DIR / "cookie-login.mjs"
    if not script.exists():
        return {"ok": False, "message": "登录助手文件不存在"}
    path = cookie_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    profile_dir = DATA_DIR / "browser-login-profile"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / "cookie-login.log"
    env = os.environ.copy()
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8:replace"})
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with log_path.open("w", encoding="utf-8", errors="replace") as log:
        process = subprocess.Popen(
            [
                node,
                str(script),
                "--out",
                str(path),
                "--profile-dir",
                str(profile_dir),
                "--timeout-seconds",
                "300",
            ],
            cwd=str(BASE_DIR),
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
            creationflags=creationflags,
        )
    with cookie_login_lock:
        cookie_login_process = process
        cookie_login_state.update(
            {
                "status": "running",
                "message": "请在 Edge 中完成抖音登录，成功后窗口会自动关闭",
                "started_at": now_iso(),
                "finished_at": "",
            }
        )
    thread = threading.Thread(target=monitor_cookie_login, args=(process, log_path), daemon=True)
    thread.start()
    add_event("info", "已打开 Edge，请完成抖音登录")
    return {"ok": True, "message": "已打开 Edge，请完成抖音登录", "auth": cookie_auth_status()}
