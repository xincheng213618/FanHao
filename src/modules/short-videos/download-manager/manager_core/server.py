"""Internal server responsibilities for the download manager."""

from __future__ import annotations

import os
import socket
import threading
import webbrowser
from http.server import ThreadingHTTPServer

from . import auth, runtime
from .common import normalize_int
from .collection_scheduler import automatic_collection_scheduler
from .config import DB_PATH, DEFAULT_OUTPUT_DIR, FROZEN_BUILD, MAX_CONCURRENCY
from .database import add_event, init_db, setting
from .domain_manifest import (
    backfill_download_records_from_links,
    profile_output_dir,
    sync_manifest_to_db,
)
from .download_supervisor import download_manager
from .downloader_client import free_port
from .extraction import stop_extract
from .http_api import Handler
from .runtime import acquire_single_instance, release_single_instance, write_runtime_info


class ManagerHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self) -> None:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def stop_runtime() -> None:
    try:
        automatic_collection_scheduler.stop()
    except Exception:
        pass
    try:
        stop_extract()
    except Exception:
        pass
    try:
        download_manager.stop()
    except Exception:
        pass
    with auth.cookie_login_lock:
        process = auth.cookie_login_process
        auth.cookie_login_process = None
    if process is not None and process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=5)
        except Exception:
            try:
                process.kill()
            except OSError:
                pass


def manager_server(host: str, requested_port: int) -> tuple[ThreadingHTTPServer, int]:
    try:
        return ManagerHTTPServer((host, requested_port), Handler), requested_port
    except OSError:
        if not FROZEN_BUILD or "DOUYIN_MANAGER_PORT" in os.environ:
            raise
    fallback_port = free_port()
    return ManagerHTTPServer((host, fallback_port), Handler), fallback_port


def start_automatic_downloads() -> dict[str, object]:
    """Start the permanent global watcher used by the button-free UI."""
    concurrency = normalize_int(setting("concurrency", "8"), 8, 1, MAX_CONCURRENCY)
    return download_manager.start(
        concurrency,
        retry_failed=False,
        limit=0,
        profile_id=None,
        watch_new=True,
        manual=False,
    )


def main() -> None:
    runtime.APP_QUIT_REQUESTED = False
    if not acquire_single_instance():
        return
    server: ThreadingHTTPServer | None = None
    try:
        init_db()
        output_dir = profile_output_dir(setting("output_dir", str(DEFAULT_OUTPUT_DIR)), 0)
        manifest_sync = sync_manifest_to_db(output_dir)
        link_backfill = backfill_download_records_from_links()
        if int(manifest_sync.get("imported") or 0) or int(link_backfill.get("inserted") or 0):
            add_event(
                "info",
                "下载记录同步："
                f"manifest {int(manifest_sync.get('imported') or 0)}，"
                f"数据库补全 {int(link_backfill.get('inserted') or 0)}",
            )
        add_event("info", "服务启动")
        if not download_manager.restore_failure_guard():
            start_automatic_downloads()
        host = os.environ.get("DOUYIN_MANAGER_HOST", "127.0.0.1")
        requested_port = int(os.environ.get("DOUYIN_MANAGER_PORT", "8765"))
        server, port = manager_server(host, requested_port)
        automatic_collection_scheduler.start()
        runtime.ACTIVE_SERVER = server
        url = f"http://localhost:{port}/#home"
        write_runtime_info(port, url)
        print(f"Douyin Download Manager: {url}")
        print(f"Database: {DB_PATH}")
        if FROZEN_BUILD and os.environ.get("DOUYIN_MANAGER_OPEN", "1").lower() not in {"0", "false", "no", "off"}:
            opener = threading.Timer(1.0, lambda: webbrowser.open(url))
            opener.daemon = True
            opener.start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    finally:
        if server is not None:
            stop_runtime()
            server.server_close()
        runtime.ACTIVE_SERVER = None
        release_single_instance()
