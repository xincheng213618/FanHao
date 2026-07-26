"""Smart refresh policy for collected author profiles."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .common import int_or_none


MIN_REFRESH_INTERVAL_SECONDS = 6 * 60 * 60
DEFAULT_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60
MAX_REFRESH_INTERVAL_SECONDS = 30 * 24 * 60 * 60


PROFILE_LINK_STATS_SQL = """
WITH link_stats AS (
  SELECT
    profile_id,
    COUNT(*) total,
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status='downloading' THEN 1 ELSE 0 END) downloading,
    SUM(CASE WHEN status='downloaded' THEN 1 ELSE 0 END) downloaded,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
    MAX(create_time) latest_work_create_time
  FROM links
  WHERE profile_id IS NOT NULL
  GROUP BY profile_id
),
previous_work_times AS (
  SELECT
    links.profile_id,
    MAX(links.create_time) previous_work_create_time
  FROM links
  JOIN link_stats ON link_stats.profile_id=links.profile_id
  WHERE links.create_time IS NOT NULL
    AND links.create_time<link_stats.latest_work_create_time
  GROUP BY links.profile_id
)
SELECT
  link_stats.*,
  previous_work_times.previous_work_create_time
FROM link_stats
LEFT JOIN previous_work_times ON previous_work_times.profile_id=link_stats.profile_id
"""


def _timestamp_from_iso(value: Any) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _iso_from_timestamp(value: int) -> str:
    return datetime.fromtimestamp(value, timezone.utc).astimezone().isoformat(timespec="seconds")


def profile_refresh_decision(
    profile: dict[str, Any],
    *,
    now_timestamp: int | None = None,
) -> dict[str, Any]:
    """Return whether a collected profile is due for another automatic refresh.

    The three scheduling nodes are the last collection time and the two newest
    distinct work timestamps. The recent posting gap supplies the base cadence;
    a longer already-observed silence backs the cadence off for dormant authors.
    """

    now_ts = int(now_timestamp if now_timestamp is not None else datetime.now(timezone.utc).timestamp())
    tab = str(profile.get("tab") or "post").strip().lower()
    collected_ts = _timestamp_from_iso(profile.get("last_extracted_at"))
    latest_ts = int_or_none(profile.get("latest_work_create_time"))
    previous_ts = int_or_none(profile.get("previous_work_create_time"))

    if tab == "like":
        return {
            "refresh_due": 1,
            "refresh_due_at": None,
            "refresh_interval_seconds": None,
            "refresh_cadence_seconds": None,
            "refresh_silence_seconds": None,
            "refresh_basis": "like_activity",
        }

    if collected_ts is None:
        return {
            "refresh_due": 1,
            "refresh_due_at": None,
            "refresh_interval_seconds": None,
            "refresh_cadence_seconds": None,
            "refresh_silence_seconds": None,
            "refresh_basis": "never_collected",
        }

    cadence_seconds: int | None = None
    silence_seconds: int | None = None
    if latest_ts is not None:
        silence_seconds = max(0, collected_ts - latest_ts)
    if latest_ts is not None and previous_ts is not None and latest_ts > previous_ts:
        cadence_seconds = latest_ts - previous_ts

    if cadence_seconds is None:
        interval_seconds = DEFAULT_REFRESH_INTERVAL_SECONDS
        basis = "insufficient_history"
    else:
        interval_seconds = max(cadence_seconds, silence_seconds or 0)
        interval_seconds = max(
            MIN_REFRESH_INTERVAL_SECONDS,
            min(MAX_REFRESH_INTERVAL_SECONDS, interval_seconds),
        )
        basis = "posting_frequency"

    due_ts = collected_ts + interval_seconds
    return {
        "refresh_due": int(now_ts >= due_ts),
        "refresh_due_at": _iso_from_timestamp(due_ts),
        "refresh_interval_seconds": interval_seconds,
        "refresh_cadence_seconds": cadence_seconds,
        "refresh_silence_seconds": silence_seconds,
        "refresh_basis": basis,
    }


def attach_profile_refresh_decision(
    profile: dict[str, Any],
    *,
    now_timestamp: int | None = None,
) -> dict[str, Any]:
    profile.update(profile_refresh_decision(profile, now_timestamp=now_timestamp))
    return profile
