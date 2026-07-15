"""Internal queue responsibilities for the download manager."""

from __future__ import annotations

import sqlite3
from typing import Any

from .common import now_iso
from .database import db


def link_stats(conn: sqlite3.Connection, profile_id: int | None = None) -> dict[str, int]:
    if profile_id is None:
        rows = []
    else:
        rows = conn.execute(
            "SELECT status, COUNT(*) c FROM links WHERE profile_id=? GROUP BY status",
            (profile_id,),
        ).fetchall()
    stats = {"total": 0, "pending": 0, "downloading": 0, "downloaded": 0, "failed": 0}
    for row in rows:
        status = row["status"]
        count = int(row["c"])
        stats["total"] += count
        if status in stats:
            stats[status] = count
    return stats


def ensure_profile_in_download_queue(conn: sqlite3.Connection, profile_id: int) -> None:
    if profile_id <= 0:
        return
    row = conn.execute("SELECT tab FROM profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return
    has_pending = conn.execute(
        "SELECT 1 FROM links WHERE profile_id=? AND status='pending' LIMIT 1",
        (profile_id,),
    ).fetchone()
    if not has_pending:
        return
    ts = now_iso()
    next_order = int(
        conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 100 v FROM profile_download_queue").fetchone()["v"]
    )
    conn.execute(
        """
        INSERT INTO profile_download_queue(profile_id, sort_order, enabled, created_at, updated_at)
        VALUES(?, ?, 1, ?, ?)
        ON CONFLICT(profile_id) DO NOTHING
        """,
        (profile_id, next_order, ts, ts),
    )


def seed_download_queue(conn: sqlite3.Connection) -> None:
    for row in conn.execute(
        """
        SELECT profiles.id
        FROM profiles
        WHERE EXISTS (
            SELECT 1 FROM links
            WHERE links.profile_id=profiles.id
          )
        ORDER BY profiles.updated_at, profiles.id
        """
    ).fetchall():
        ensure_profile_in_download_queue(conn, int(row["id"]))


def sync_download_queue(conn: sqlite3.Connection) -> None:
    seed_download_queue(conn)


def queue_pending_count(conn: sqlite3.Connection) -> int:
    sync_download_queue(conn)
    row = conn.execute(
        """
        SELECT COUNT(*) c
        FROM links
        JOIN profile_download_queue q ON q.profile_id=links.profile_id
        WHERE q.enabled=1 AND links.status='pending'
        """
    ).fetchone()
    return int(row["c"] if row else 0)


def list_download_queue(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    sync_download_queue(conn)
    rows = conn.execute(
        """
        SELECT
          q.profile_id,
          q.sort_order,
          q.enabled,
          profiles.url,
          profiles.tab,
          profiles.title,
          profiles.nickname,
          profiles.short_id,
          profiles.unique_id,
          profiles.aweme_count,
          COUNT(links.id) total,
          SUM(CASE WHEN links.status='pending' THEN 1 ELSE 0 END) pending,
          SUM(CASE WHEN links.status='downloading' THEN 1 ELSE 0 END) downloading,
          SUM(CASE WHEN links.status='downloaded' THEN 1 ELSE 0 END) downloaded,
          SUM(CASE WHEN links.status='failed' THEN 1 ELSE 0 END) failed,
          SUM(CASE WHEN links.status='pending' AND links.download_intent='quality_upgrade' THEN 1 ELSE 0 END) quality_pending,
          MAX(CASE WHEN links.status='pending' AND links.download_intent='quality_upgrade' THEN COALESCE(links.digg_count, 0) ELSE 0 END) quality_max_digg_count
        FROM profile_download_queue q
        JOIN profiles ON profiles.id=q.profile_id
        LEFT JOIN links ON links.profile_id=profiles.id
        WHERE q.enabled=1
        GROUP BY q.profile_id
        HAVING pending > 0 OR downloading > 0
        ORDER BY
          CASE WHEN quality_pending > 0 THEN 0 ELSE 1 END,
          quality_max_digg_count DESC,
          q.sort_order,
          q.profile_id
        """
    ).fetchall()
    return [dict(row) for row in rows]


def next_download_queue_profile(conn: sqlite3.Connection, current_profile_id: int | None = None) -> int | None:
    params: list[Any] = []
    extra = ""
    if current_profile_id is not None:
        extra = "AND q.profile_id<>?"
        params.append(current_profile_id)
    row = conn.execute(
        f"""
        SELECT q.profile_id
        FROM profile_download_queue q
        JOIN profiles ON profiles.id=q.profile_id
        WHERE q.enabled=1
          {extra}
          AND EXISTS (
            SELECT 1 FROM links
            WHERE links.profile_id=q.profile_id AND links.status='pending'
          )
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1 FROM links quality_links
            WHERE quality_links.profile_id=q.profile_id
              AND quality_links.status='pending'
              AND quality_links.download_intent='quality_upgrade'
          ) THEN 0 ELSE 1 END,
          COALESCE((
            SELECT MAX(COALESCE(quality_links.digg_count, 0))
            FROM links quality_links
            WHERE quality_links.profile_id=q.profile_id
              AND quality_links.status='pending'
              AND quality_links.download_intent='quality_upgrade'
          ), 0) DESC,
          q.sort_order,
          q.profile_id
        LIMIT 1
        """,
        params,
    ).fetchone()
    return int(row["profile_id"]) if row else None


def move_download_queue_item(profile_id: int, direction: str) -> bool:
    with db() as conn:
        sync_download_queue(conn)
        current = conn.execute(
            """
            SELECT q.profile_id, q.sort_order
            FROM profile_download_queue q
            WHERE q.profile_id=? AND q.enabled=1
              AND EXISTS (
                SELECT 1 FROM links
                WHERE links.profile_id=q.profile_id
                  AND links.status IN ('pending', 'downloading')
              )
            """,
            (profile_id,),
        ).fetchone()
        if not current:
            return False
        if direction == "top":
            other = conn.execute(
                """
                SELECT q.profile_id, q.sort_order
                FROM profile_download_queue q
                WHERE q.enabled=1
                  AND EXISTS (
                    SELECT 1 FROM links
                    WHERE links.profile_id=q.profile_id
                      AND links.status IN ('pending', 'downloading')
                  )
                ORDER BY q.sort_order ASC, q.profile_id ASC
                LIMIT 1
                """
            ).fetchone()
            if not other or int(other["profile_id"]) == int(current["profile_id"]):
                return False
            conn.execute(
                "UPDATE profile_download_queue SET sort_order=?, updated_at=? WHERE profile_id=?",
                (int(other["sort_order"]) - 100, now_iso(), current["profile_id"]),
            )
            return True
        if direction == "up":
            other = conn.execute(
                """
                SELECT q.profile_id, q.sort_order
                FROM profile_download_queue q
                WHERE q.enabled=1
                  AND (q.sort_order < ? OR (q.sort_order = ? AND q.profile_id < ?))
                  AND EXISTS (
                    SELECT 1 FROM links
                    WHERE links.profile_id=q.profile_id
                      AND links.status IN ('pending', 'downloading')
                  )
                ORDER BY q.sort_order DESC, q.profile_id DESC
                LIMIT 1
                """,
                (current["sort_order"], current["sort_order"], current["profile_id"]),
            ).fetchone()
        elif direction == "down":
            other = conn.execute(
                """
                SELECT q.profile_id, q.sort_order
                FROM profile_download_queue q
                WHERE q.enabled=1
                  AND (q.sort_order > ? OR (q.sort_order = ? AND q.profile_id > ?))
                  AND EXISTS (
                    SELECT 1 FROM links
                    WHERE links.profile_id=q.profile_id
                      AND links.status IN ('pending', 'downloading')
                  )
                ORDER BY q.sort_order ASC, q.profile_id ASC
                LIMIT 1
                """,
                (current["sort_order"], current["sort_order"], current["profile_id"]),
            ).fetchone()
        else:
            return False
        if not other:
            return False
        ts = now_iso()
        conn.execute(
            "UPDATE profile_download_queue SET sort_order=?, updated_at=? WHERE profile_id=?",
            (other["sort_order"], ts, current["profile_id"]),
        )
        conn.execute(
            "UPDATE profile_download_queue SET sort_order=?, updated_at=? WHERE profile_id=?",
            (current["sort_order"], ts, other["profile_id"]),
        )
    return True


def sort_download_queue_by_pending() -> int:
    with db() as conn:
        sync_download_queue(conn)
        rows = conn.execute(
            """
            SELECT
              q.profile_id,
              SUM(CASE WHEN links.status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN links.status='downloading' THEN 1 ELSE 0 END) downloading,
              COUNT(links.id) total
            FROM profile_download_queue q
            JOIN links ON links.profile_id=q.profile_id
            WHERE q.enabled=1
            GROUP BY q.profile_id
            HAVING pending > 0 OR downloading > 0
            ORDER BY pending ASC, downloading DESC, total ASC, q.sort_order ASC, q.profile_id ASC
            """
        ).fetchall()
        ts = now_iso()
        for index, row in enumerate(rows, start=1):
            conn.execute(
                "UPDATE profile_download_queue SET sort_order=?, updated_at=? WHERE profile_id=?",
                (index * 100, ts, row["profile_id"]),
            )
    return len(rows)
