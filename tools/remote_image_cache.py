import hashlib
import json
import mimetypes
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import requests

from core_image_store import image_store_schema


MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)
ALLOWED_REMOTE_IMAGE_HOSTS = ("jdbstatic.com", "javdb.com")


def ensure_remote_image_schema(conn: sqlite3.Connection) -> None:
    schema = image_store_schema(conn)
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS {schema}.remote_image_cache (
          url TEXT PRIMARY KEY,
          url_hash TEXT NOT NULL,
          content_type TEXT,
          image_blob BLOB,
          byte_length INTEGER,
          status TEXT NOT NULL DEFAULT 'ok',
          error TEXT,
          fetched_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS {schema}.idx_remote_image_cache_hash ON remote_image_cache(url_hash);
        CREATE INDEX IF NOT EXISTS {schema}.idx_remote_image_cache_status ON remote_image_cache(status);
        """
    )
    ensure_column(conn, schema, "remote_image_cache", "url_hash", "TEXT")
    ensure_column(conn, schema, "remote_image_cache", "content_type", "TEXT")
    ensure_column(conn, schema, "remote_image_cache", "image_blob", "BLOB")
    ensure_column(conn, schema, "remote_image_cache", "byte_length", "INTEGER")
    ensure_column(conn, schema, "remote_image_cache", "status", "TEXT NOT NULL DEFAULT 'ok'")
    ensure_column(conn, schema, "remote_image_cache", "error", "TEXT")
    ensure_column(conn, schema, "remote_image_cache", "fetched_at", "TEXT")
    ensure_column(conn, schema, "remote_image_cache", "updated_at", "TEXT")


def ensure_column(conn: sqlite3.Connection, schema: str, table: str, column: str, definition: str) -> None:
    rows = conn.execute(f"PRAGMA {schema}.table_info({table})").fetchall()
    if not any(row[1] == column for row in rows):
        conn.execute(f"ALTER TABLE {schema}.{table} ADD COLUMN {column} {definition}")


def is_allowed_remote_image_url(url: str) -> bool:
    try:
        parsed = urlparse(str(url or "").strip())
    except Exception:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    hostname = (parsed.hostname or "").lower()
    return any(hostname == host or hostname.endswith(f".{host}") for host in ALLOWED_REMOTE_IMAGE_HOSTS)


def image_cache_stats() -> dict:
    return {"checked": 0, "cached": 0, "skipped": 0, "failed": 0}


def cached_remote_image_urls(conn: sqlite3.Connection, urls: list[str]) -> set[str]:
    normalized = [url for url in unique_remote_image_urls(urls) if url]
    if not normalized:
        return set()

    ensure_remote_image_schema(conn)
    cached = set()
    for index in range(0, len(normalized), 500):
        chunk = normalized[index : index + 500]
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"""
            SELECT url
            FROM remote_image_cache
            WHERE image_blob IS NOT NULL AND length(image_blob) > 0 AND url IN ({placeholders})
            """,
            chunk,
        ).fetchall()
        cached.update(row[0] for row in rows)
    return cached


def unique_remote_image_urls(urls) -> list[str]:
    result = []
    seen = set()
    for raw in urls or []:
        url = str(raw or "").strip()
        if not url or url in seen or not is_allowed_remote_image_url(url):
            continue
        seen.add(url)
        result.append(url)
    return result


def cache_remote_images(
    conn: sqlite3.Connection,
    urls,
    session: requests.Session | None = None,
    referer: str = "",
    force: bool = False,
    timeout: int = 30,
    limit: int = 0,
    concurrency: int = 8,
) -> dict:
    ensure_remote_image_schema(conn)
    stats = image_cache_stats()
    normalized = unique_remote_image_urls(urls)
    if limit:
        normalized = normalized[: max(0, int(limit))]

    node_stats = cache_remote_images_with_node(conn, normalized, session=session, referer=referer, timeout=timeout, concurrency=concurrency)
    if node_stats is not None:
        return node_stats

    cached = set() if force else cached_remote_image_urls(conn, normalized)
    for url in normalized:
        stats["checked"] += 1
        if url in cached:
            stats["skipped"] += 1
            continue
        try:
            blob, content_type = download_remote_image(url, session=session, referer=referer, timeout=timeout)
            upsert_remote_image(conn, url, blob, content_type)
            stats["cached"] += 1
        except Exception as error:
            upsert_remote_image_error(conn, url, error)
            stats["failed"] += 1
    return stats


def cache_remote_images_with_node(
    conn: sqlite3.Connection,
    urls: list[str],
    session: requests.Session | None = None,
    referer: str = "",
    timeout: int = 30,
    concurrency: int = 8,
) -> dict | None:
    if not urls:
        return image_cache_stats()

    db_path = main_database_path(conn)
    helper = Path(__file__).resolve().with_name("cache_remote_images_node.mjs")
    if not db_path or not helper.exists():
        return None

    try:
        conn.commit()
    except sqlite3.Error:
        pass

    user_agent = DEFAULT_USER_AGENT
    if session is not None:
        user_agent = session.headers.get("User-Agent") or user_agent

    urls_file = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
            json.dump(urls, handle, ensure_ascii=False)
            urls_file = Path(handle.name)

        result = subprocess.run(
            [
                "node",
                str(helper),
                "--db",
                db_path,
                "--urls-file",
                str(urls_file),
                "--referer",
                referer or "https://javdb.com/",
                "--timeout",
                str(timeout),
                "--concurrency",
                str(concurrency),
                "--user-agent",
                user_agent,
            ],
            capture_output=True,
            text=True,
            timeout=max(30, int(timeout or 30) * max(1, len(urls)) + 10),
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout.strip().splitlines()[-1])
    except Exception:
        return None
    finally:
        if urls_file:
            try:
                urls_file.unlink(missing_ok=True)
            except OSError:
                pass


def main_database_path(conn: sqlite3.Connection) -> str:
    try:
        for _, name, path in conn.execute("PRAGMA database_list").fetchall():
            if name == "main" and path:
                return str(path)
    except sqlite3.Error:
        return ""
    return ""


def upsert_remote_image(conn: sqlite3.Connection, url: str, blob: bytes, content_type: str = "") -> bool:
    if not url or not blob or not is_allowed_remote_image_url(url):
        return False
    ensure_remote_image_schema(conn)
    now = iso_now()
    content_type = normalize_image_mime(content_type, url)
    conn.execute(
        """
        INSERT INTO remote_image_cache (
          url, url_hash, content_type, image_blob, byte_length, status, error, fetched_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'ok', '', ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          url_hash = excluded.url_hash,
          content_type = excluded.content_type,
          image_blob = excluded.image_blob,
          byte_length = excluded.byte_length,
          status = 'ok',
          error = '',
          fetched_at = excluded.fetched_at,
          updated_at = excluded.updated_at
        """,
        (url, remote_image_hash(url), content_type, blob, len(blob), now, now),
    )
    return True


def upsert_remote_image_error(conn: sqlite3.Connection, url: str, error: Exception) -> None:
    if not url or not is_allowed_remote_image_url(url):
        return
    ensure_remote_image_schema(conn)
    now = iso_now()
    conn.execute(
        """
        INSERT INTO remote_image_cache (
          url, url_hash, content_type, image_blob, byte_length, status, error, fetched_at, updated_at
        )
        VALUES (?, ?, '', NULL, 0, 'error', ?, NULL, ?)
        ON CONFLICT(url) DO UPDATE SET
          status = 'error',
          error = excluded.error,
          updated_at = excluded.updated_at
        """,
        (url, remote_image_hash(url), str(error)[:1000], now),
    )


def download_remote_image(
    url: str,
    session: requests.Session | None = None,
    referer: str = "",
    timeout: int = 30,
) -> tuple[bytes, str]:
    if not is_allowed_remote_image_url(url):
        raise RuntimeError(f"remote image host is not allowed: {url}")

    owns_session = session is None
    session = session or requests.Session()
    headers = {
        "User-Agent": session.headers.get("User-Agent") or DEFAULT_USER_AGENT,
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
    try:
        response = session.get(url, headers=headers, timeout=timeout, stream=True)
        response.raise_for_status()
        declared_length = int(response.headers.get("Content-Length") or 0)
        if declared_length > MAX_REMOTE_IMAGE_BYTES:
            raise RuntimeError(f"remote image is too large: {declared_length}")

        chunks = []
        size = 0
        for chunk in response.iter_content(chunk_size=65536):
            if not chunk:
                continue
            size += len(chunk)
            if size > MAX_REMOTE_IMAGE_BYTES:
                raise RuntimeError(f"remote image is too large: {size}")
            chunks.append(chunk)

        blob = b"".join(chunks)
        content_type = normalize_image_mime(response.headers.get("Content-Type", ""), url)
        if not content_type.startswith("image/"):
            raise RuntimeError(f"remote response is not an image: {content_type}")
        return blob, content_type
    finally:
        if owns_session:
            session.close()


def remote_image_hash(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def normalize_image_mime(content_type: str, url: str) -> str:
    mime = str(content_type or "").split(";", 1)[0].strip().lower()
    if mime.startswith("image/"):
        return mime
    return mimetypes.guess_type(Path(urlparse(url).path).name)[0] or "image/jpeg"


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
