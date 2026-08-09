"""Collection-count history and one-shot full-scan reconciliation."""

from __future__ import annotations

from typing import Any

from .common import int_or_none, now_iso
from .database import db


COUNT_DROP_MIN_ABSOLUTE = 10
COUNT_DROP_MIN_RATIO = 0.10


def significant_count_drop(baseline: int | None, observed: int | None) -> tuple[bool, int, float | None]:
    if baseline is None or observed is None or baseline <= 0 or observed < 0:
        return False, 0, None
    drop = max(0, baseline - observed)
    ratio = drop / baseline
    return drop >= COUNT_DROP_MIN_ABSOLUTE and ratio >= COUNT_DROP_MIN_RATIO, drop, ratio


def record_profile_collection(
    profile_id: int,
    *,
    job_id: int | None,
    full_scan: bool,
    full_scan_confirmed: bool,
    seen_count: int,
    inserted_count: int,
    existing_count: int,
    started_at: str,
    message: str = "",
) -> dict[str, Any]:
    """Record one completed collection and update the pending reconcile state.

    A quick collection can arm one full scan when the official count drops
    materially. A confirmed full scan clears that pending bit and becomes the
    new baseline, so the same deletion gap does not schedule full scans forever.
    """

    finished_at = now_iso()
    with db() as conn:
        profile = conn.execute(
            """
            SELECT
              id, tab, aweme_count, has_deleted_works,
              full_scan_required, full_scan_reason, full_scan_required_at,
              last_full_scan_at, last_full_scan_aweme_count
            FROM profiles
            WHERE id=?
            """,
            (profile_id,),
        ).fetchone()
        if profile is None:
            return {"recorded": False, "reason": "profile_not_found"}

        observed = int_or_none(profile["aweme_count"])
        local_link_count = int(
            conn.execute(
                "SELECT COUNT(*) c FROM links WHERE profile_id=?",
                (profile_id,),
            ).fetchone()["c"]
            or 0
        )
        previous = conn.execute(
            """
            SELECT observed_aweme_count
            FROM profile_collection_history
            WHERE profile_id=?
              AND status='complete'
              AND observed_aweme_count IS NOT NULL
            ORDER BY id DESC
            LIMIT 1
            """,
            (profile_id,),
        ).fetchone()
        previous_count = int_or_none(previous["observed_aweme_count"]) if previous else None
        baseline_count = previous_count
        baseline_source = "history"
        if (
            baseline_count is None
            and not str(profile["last_full_scan_at"] or "").strip()
            and not int(profile["has_deleted_works"] or 0)
        ):
            baseline_count = local_link_count
            baseline_source = "local"

        dropped, count_drop, count_drop_ratio = significant_count_drop(baseline_count, observed)
        pending = int(profile["full_scan_required"] or 0)
        reason = str(profile["full_scan_reason"] or "").strip()
        required_at = str(profile["full_scan_required_at"] or "").strip()
        history_status = "complete"

        if full_scan:
            if full_scan_confirmed:
                pending = 0
                reason = ""
                required_at = ""
                conn.execute(
                    """
                    UPDATE profiles
                    SET full_scan_required=0,
                        full_scan_reason=NULL,
                        full_scan_required_at=NULL,
                        last_full_scan_at=?,
                        last_full_scan_aweme_count=?,
                        last_full_scan_link_total=?
                    WHERE id=?
                    """,
                    (finished_at, observed, local_link_count, profile_id),
                )
            else:
                history_status = "incomplete"
        elif str(profile["tab"] or "post") == "post" and dropped:
            pending = 1
            required_at = required_at or finished_at
            percentage = round((count_drop_ratio or 0) * 100)
            if baseline_source == "history":
                reason = (
                    f"主页作品数从上次采集 {baseline_count} 降到 {observed}"
                    f"（少 {count_drop}，{percentage}%），下次执行一次全量确认"
                )
            else:
                reason = (
                    f"主页作品数 {observed}，比本地入库 {baseline_count} 少 {count_drop} 条"
                    f"（{percentage}%），下次执行一次全量确认"
                )
            conn.execute(
                """
                UPDATE profiles
                SET full_scan_required=1,
                    full_scan_reason=?,
                    full_scan_required_at=?
                WHERE id=?
                """,
                (reason, required_at, profile_id),
            )

        cursor = conn.execute(
            """
            INSERT INTO profile_collection_history (
              profile_id, job_id, mode, status,
              observed_aweme_count, previous_aweme_count, local_link_count,
              seen_count, inserted_count, existing_count,
              count_drop, count_drop_ratio, full_scan_required,
              message, started_at, finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                profile_id,
                job_id,
                "full" if full_scan else "quick",
                history_status,
                observed,
                previous_count,
                local_link_count,
                max(0, int(seen_count or 0)),
                max(0, int(inserted_count or 0)),
                max(0, int(existing_count or 0)),
                count_drop,
                count_drop_ratio,
                pending,
                str(message or "")[:2000],
                started_at or finished_at,
                finished_at,
            ),
        )
    return {
        "recorded": True,
        "history_id": int(cursor.lastrowid),
        "status": history_status,
        "observed_aweme_count": observed,
        "previous_aweme_count": previous_count,
        "local_link_count": local_link_count,
        "count_drop": count_drop,
        "count_drop_ratio": count_drop_ratio,
        "full_scan_required": pending,
        "full_scan_reason": reason,
    }
