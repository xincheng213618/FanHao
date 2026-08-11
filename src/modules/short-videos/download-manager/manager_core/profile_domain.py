"""Internal profile domain responsibilities for the download manager."""

from __future__ import annotations

from typing import Any

from .common import clean_profile_nickname, first_text, int_or_none, json_text
from .domain_manifest import douyin_user_url, first_url_any


def normalize_profile_metadata(profile: dict[str, Any] | None, fallback_sec_uid: str = "") -> dict[str, Any]:
    profile = profile or {}
    raw = profile.get("raw_json") if isinstance(profile.get("raw_json"), (dict, list, str)) else profile
    sec_uid = first_text(fallback_sec_uid, profile.get("sec_uid"), profile.get("secUid"))
    uid = first_text(profile.get("uid"), profile.get("user_id"), profile.get("userId"))
    nickname = clean_profile_nickname(profile.get("nickname"), profile.get("name"))
    unique_id = first_text(profile.get("unique_id"), profile.get("uniqueId"))
    short_id = first_text(profile.get("short_id"), profile.get("shortId"))
    if unique_id == "0":
        unique_id = ""
    if short_id == "0":
        short_id = ""
    douyin_id = first_text(unique_id, short_id)
    if douyin_id and douyin_id.isdigit() and not short_id:
        short_id = douyin_id
    profile_url = first_text(profile.get("profile_url"), profile.get("profileUrl"), douyin_user_url(sec_uid))
    raw_json = raw if isinstance(raw, str) else json_text(raw)
    aweme_count_value = (
        profile.get("aweme_count")
        if profile.get("aweme_count") is not None
        else profile.get("awemeCount")
    )
    account_status = first_text(profile.get("account_status"), profile.get("accountStatus")).lower()
    if account_status not in {"active", "banned"}:
        account_status = ""
    return {
        "uid": uid,
        "sec_uid": sec_uid,
        "nickname": nickname,
        "avatar_url": first_url_any(profile.get("avatar_url"), profile.get("avatarUrl"), profile.get("avatar")),
        "unique_id": unique_id,
        "short_id": short_id,
        "signature": first_text(profile.get("signature"), profile.get("bio"), profile.get("description")),
        "ip_location": first_text(profile.get("ip_location"), profile.get("ipLocation")).replace("IP属地：", "").replace("IP属地:", ""),
        "following_count": int_or_none(profile.get("following_count") or profile.get("followingCount")),
        "follower_count": int_or_none(profile.get("follower_count") or profile.get("followerCount")),
        "total_favorited": int_or_none(profile.get("total_favorited") or profile.get("totalFavorited")),
        "aweme_count": int_or_none(aweme_count_value),
        "favoriting_count": int_or_none(profile.get("favoriting_count") or profile.get("favoritingCount")),
        "gender": int_or_none(profile.get("gender")),
        "age": int_or_none(profile.get("age")),
        "verification": first_text(profile.get("verification"), profile.get("custom_verify"), profile.get("customVerify")),
        "account_status": account_status,
        "account_status_reason": first_text(
            profile.get("account_status_reason"),
            profile.get("accountStatusReason"),
        ),
        "profile_url": profile_url,
        "profile_raw_json": raw_json if raw_json else "{}",
    }
