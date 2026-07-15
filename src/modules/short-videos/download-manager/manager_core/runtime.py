"""Internal runtime responsibilities for the download manager."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
import webbrowser
from datetime import datetime
from http.server import ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .common import now_iso
from .config import APP_STATE_DIR, FROZEN_BUILD, LOG_DIR


download_timing_lock = threading.Lock()


ACTIVE_SERVER: ThreadingHTTPServer | None = None


APP_QUIT_LOCK = threading.Lock()


APP_QUIT_REQUESTED = False


APP_LOCK_FILE: Any = None


RUNTIME_INFO_PATH = APP_STATE_DIR / "runtime.json"


def download_timing(event: str, **fields: Any) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        record = {"ts": now_iso(), "event": event, **fields}
        path = LOG_DIR / f"download-timing-{datetime.now().strftime('%Y%m%d')}.jsonl"
        with download_timing_lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, default=str))
                handle.write("\n")
    except Exception:
        pass


def activate_application() -> dict[str, Any]:
    try:
        payload = json.loads(RUNTIME_INFO_PATH.read_text(encoding="utf-8"))
        url = str(payload.get("url") or "")
    except (OSError, ValueError, json.JSONDecodeError):
        url = ""
    if not url:
        return {"ok": False, "message": "没有找到管理页面地址"}
    opener = threading.Timer(0.05, lambda: webbrowser.open(url))
    opener.daemon = True
    opener.start()
    return {"ok": True, "message": "已在浏览器中打开"}


def request_application_quit() -> dict[str, Any]:
    global APP_QUIT_REQUESTED
    with APP_QUIT_LOCK:
        if APP_QUIT_REQUESTED:
            return {"ok": True, "message": "程序正在退出"}
        APP_QUIT_REQUESTED = True

    def close() -> None:
        time.sleep(0.15)
        server = ACTIVE_SERVER
        if server is not None:
            server.shutdown()

    threading.Thread(target=close, daemon=True).start()
    return {"ok": True, "message": "程序正在退出"}


def activate_existing_instance() -> bool:
    last_url = ""
    for _ in range(30):
        try:
            payload = json.loads(RUNTIME_INFO_PATH.read_text(encoding="utf-8"))
            last_url = str(payload.get("url") or "")
            if last_url:
                base_url = last_url.split("/#", 1)[0].rstrip("/")
                request = Request(
                    f"{base_url}/api/app/activate",
                    data=b"{}",
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request, timeout=0.8) as response:
                    result = json.loads(response.read().decode("utf-8") or "{}")
                if result.get("ok"):
                    return True
        except (OSError, ValueError, HTTPError, URLError, json.JSONDecodeError):
            pass
        time.sleep(0.15)
    if last_url:
        webbrowser.open(last_url)
    return False


def acquire_single_instance() -> bool:
    global APP_LOCK_FILE
    single_instance_enabled = os.environ.get("DOUYIN_MANAGER_SINGLE_INSTANCE", "1").lower() not in {
        "0",
        "false",
        "no",
        "off",
    }
    if os.name != "nt" or not FROZEN_BUILD or not single_instance_enabled:
        return True
    import msvcrt

    APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
    handle = (APP_STATE_DIR / "app.lock").open("a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        handle.close()
        activate_existing_instance()
        return False
    APP_LOCK_FILE = handle
    return True


def write_runtime_info(port: int, url: str) -> None:
    if not FROZEN_BUILD:
        return
    APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = RUNTIME_INFO_PATH.with_name(f".{RUNTIME_INFO_PATH.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(
        json.dumps({"pid": os.getpid(), "port": port, "url": url}, ensure_ascii=False),
        encoding="utf-8",
    )
    temp_path.replace(RUNTIME_INFO_PATH)


def release_single_instance() -> None:
    global APP_LOCK_FILE
    try:
        if RUNTIME_INFO_PATH.exists():
            payload = json.loads(RUNTIME_INFO_PATH.read_text(encoding="utf-8"))
            if int(payload.get("pid") or 0) == os.getpid():
                RUNTIME_INFO_PATH.unlink(missing_ok=True)
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    handle = APP_LOCK_FILE
    APP_LOCK_FILE = None
    if handle is None:
        return
    try:
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    handle.close()
