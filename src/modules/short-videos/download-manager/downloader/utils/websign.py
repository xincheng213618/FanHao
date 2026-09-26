"""Douyin ``x-secsdk-web-signature`` support for protected web APIs.

The algorithm and protected-path list follow the current upstream
Douyin_TikTok_Download_API native signer.  The query is serialized exactly like
``URLSearchParams.toString()`` because those bytes are part of the signature.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Iterable, Mapping, Sequence
from urllib.parse import quote, unquote, urlsplit, urlunsplit

SALT = "A96D855A08C0A9707F8BEF0D9A527E4E"
SIGNATURE_PARAM = "x-secsdk-web-signature"
EXPIRE_HEADER = "x-secsdk-web-expire"
VERIFY_FP_COOKIE = "s_v_web_id"
UIFID_COOKIE_NAMES = (
    "uifid",
    "uifid_temp",
    "uifidtemp",
    "UIFID",
    "UIFID_TEMP",
    "UIFIDTEMP",
)
DOUYIN_SIGNED_PATHS = frozenset(
    {
        "/aweme/v1/web/aweme/detail/",
        "/aweme/v1/web/aweme/post/",
        "/aweme/v1/web/aweme/favorite/",
        "/aweme/v1/web/aweme/listcollection/",
        "/aweme/v1/web/mix/aweme/",
        "/aweme/v1/web/tab/feed/",
        "/aweme/v1/web/mix/list/",
        "/aweme/v1/web/music/aweme/",
        "/aweme/v1/web/music/list/",
        "/aweme/v1/web/mix/detail/",
        "/aweme/v1/web/mix/listcollection/",
        "/aweme/v1/web/music/detail/",
        "/aweme/v1/web/collects/list/",
        "/aweme/v1/web/collects/video/list/",
    }
)


def pick_uifid(cookies: Mapping[str, str] | None) -> str | None:
    for name in UIFID_COOKIE_NAMES:
        value = str((cookies or {}).get(name) or "").strip()
        if value:
            return value
    return None


def requires_web_signature(path: str) -> bool:
    normalized = urlsplit(path).path
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    if not normalized.endswith("/"):
        normalized = f"{normalized}/"
    return normalized in DOUYIN_SIGNED_PATHS


def encode_pairs(pairs: Iterable[tuple[str, str]]) -> str:
    return "&".join(
        f"{quote(name, safe='*-._')}={quote(value, safe='*-._')}"
        for name, value in pairs
    )


def sign_pairs(
    pairs: Sequence[tuple[str, str]],
    uifid: str,
    *,
    timestamp: int | None = None,
) -> tuple[str, str, dict[str, str]]:
    stamp = str(int(time.time() if timestamp is None else timestamp))
    covered = list(pairs)
    if not any(name == "uifid" for name, _value in covered):
        covered.append(("uifid", uifid))
    covered.append(("timestamp", stamp))
    query = encode_pairs(covered)
    signature = hashlib.md5(f"{uifid}_{stamp}_{SALT}_{query}".encode()).hexdigest()
    headers = {
        "uifid": uifid,
        SIGNATURE_PARAM: signature,
        EXPIRE_HEADER: stamp,
    }
    return f"{query}&{SIGNATURE_PARAM}={signature}", signature, headers


def add_web_signature(
    url: str,
    cookies: Mapping[str, str] | None,
    *,
    timestamp: int | None = None,
) -> tuple[str, dict[str, str]]:
    """Add visitor parameters and the web signature to a signed Douyin URL."""

    uifid = pick_uifid(cookies)
    if not uifid:
        return url, {}

    parts = urlsplit(url)
    pairs = []
    for item in parts.query.split("&"):
        if not item:
            continue
        name, _, value = item.partition("=")
        pairs.append((unquote(name), unquote(value)))

    verify_fp = str((cookies or {}).get(VERIFY_FP_COOKIE) or "").strip()
    if verify_fp:
        pairs.extend((("verifyFp", verify_fp), ("fp", verify_fp)))

    query, _signature, headers = sign_pairs(pairs, uifid, timestamp=timestamp)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment)), headers


__all__ = [
    "DOUYIN_SIGNED_PATHS",
    "EXPIRE_HEADER",
    "SIGNATURE_PARAM",
    "SALT",
    "UIFID_COOKIE_NAMES",
    "VERIFY_FP_COOKIE",
    "add_web_signature",
    "encode_pairs",
    "pick_uifid",
    "requires_web_signature",
    "sign_pairs",
]
