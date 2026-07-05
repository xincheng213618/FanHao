from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "fanhao-tools.sqlite"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def code_key(value: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", str(value or "")).lower()


def sha1_text(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8", errors="ignore")).hexdigest()


class ToolDatabase:
    def __init__(self, db_path: str | Path | None = None, enabled: bool = True):
        self.enabled = enabled
        self.db_path = Path(db_path or DEFAULT_DB_PATH)
        self.conn: Optional[sqlite3.Connection] = None
        self.records_written = 0
        if self.enabled:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self.conn = sqlite3.connect(self.db_path, timeout=30)
            self.conn.execute("PRAGMA busy_timeout = 5000")
            self.conn.execute("PRAGMA journal_mode = WAL")
            self.ensure_schema()

    def ensure_schema(self) -> None:
        if not self.conn:
            return
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tool_video_metadata (
              code_key TEXT PRIMARY KEY,
              code TEXT NOT NULL,
              title TEXT,
              actors_json TEXT,
              image_url TEXT,
              source_name TEXT,
              source_query TEXT,
              source_url TEXT,
              organized_path TEXT,
              is_vr INTEGER NOT NULL DEFAULT 0,
              raw_json TEXT,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tool_video_metadata_code
              ON tool_video_metadata(code);
            """
        )
        self.conn.commit()

    def upsert_video_metadata(
        self,
        code: str,
        title: str = "",
        actors: list[str] | None = None,
        image_url: str = "",
        source_name: str = "",
        source_query: str = "",
        source_url: str = "",
        organized_path: str = "",
        is_vr: bool = False,
        raw: Any = None,
    ) -> None:
        if not self.conn:
            return
        key = code_key(code) or sha1_text(f"{source_name}:{source_query}:{title}")[:24]
        self.conn.execute(
            """
            INSERT INTO tool_video_metadata (
              code_key, code, title, actors_json, image_url, source_name,
              source_query, source_url, organized_path, is_vr, raw_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code_key) DO UPDATE SET
              code = excluded.code,
              title = excluded.title,
              actors_json = excluded.actors_json,
              image_url = excluded.image_url,
              source_name = excluded.source_name,
              source_query = excluded.source_query,
              source_url = excluded.source_url,
              organized_path = excluded.organized_path,
              is_vr = excluded.is_vr,
              raw_json = excluded.raw_json,
              updated_at = excluded.updated_at
            """,
            (
                key,
                code,
                title,
                json_dumps(actors or []),
                image_url,
                source_name,
                source_query,
                source_url,
                organized_path,
                1 if is_vr else 0,
                json_dumps(raw or {}),
                utc_now(),
            ),
        )
        self.records_written += 1

    def commit(self) -> None:
        if self.conn:
            self.conn.commit()

    def close(self) -> None:
        if self.conn:
            self.conn.commit()
            self.conn.close()
            self.conn = None
