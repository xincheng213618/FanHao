from __future__ import annotations

import os
import sqlite3
from pathlib import Path


IMAGE_STORE_SCHEMA = "fanhao_images"
DEFAULT_IMAGE_DB_NAME = "fanhao-core-images.sqlite"


def attach_core_image_store(
    conn: sqlite3.Connection,
    core_db_path: Path | str,
    image_db_path: Path | str | None = None,
) -> Path:
    attached = {str(row[1]) for row in conn.execute("PRAGMA database_list").fetchall()}
    target = Path(
        image_db_path
        or os.environ.get("FANHAO_CORE_IMAGE_DB")
        or Path(core_db_path).resolve().with_name(DEFAULT_IMAGE_DB_NAME)
    ).resolve()
    if IMAGE_STORE_SCHEMA not in attached:
        target.parent.mkdir(parents=True, exist_ok=True)
        conn.execute(f"ATTACH DATABASE ? AS {IMAGE_STORE_SCHEMA}", (str(target),))
    return target


def image_store_schema(conn: sqlite3.Connection) -> str:
    attached = {str(row[1]) for row in conn.execute("PRAGMA database_list").fetchall()}
    return IMAGE_STORE_SCHEMA if IMAGE_STORE_SCHEMA in attached else "main"
