import hashlib
from urllib.parse import parse_qsl, urlsplit

from utils.websign import SALT, add_web_signature, pick_uifid, requires_web_signature


def test_pick_uifid_uses_upstream_cookie_precedence():
    cookies = {"UIFID": "upper", "UIFID_TEMP": "temp", "uifid": "lower"}
    assert pick_uifid(cookies) == "lower"
    assert pick_uifid({"UIFID_TEMP": "temp"}) == "temp"
    assert pick_uifid({}) is None


def test_add_web_signature_matches_documented_preimage():
    source = "https://www.douyin.com/aweme/v1/web/aweme/detail/?aid=6383&a_bogus=abc%2Fdef"
    signed_url, headers = add_web_signature(
        source,
        {"UIFID_TEMP": "visitor-1", "s_v_web_id": "verify-1"},
        timestamp=1_700_000_000,
    )

    query = urlsplit(signed_url).query
    covered, separator, signature_part = query.rpartition("&x-secsdk-web-signature=")
    expected = hashlib.md5(
        f"visitor-1_1700000000_{SALT}_{covered}".encode()
    ).hexdigest()

    assert separator
    assert signature_part == expected
    assert headers == {
        "uifid": "visitor-1",
        "x-secsdk-web-signature": expected,
        "x-secsdk-web-expire": "1700000000",
    }
    assert parse_qsl(covered)[-4:] == [
        ("verifyFp", "verify-1"),
        ("fp", "verify-1"),
        ("uifid", "visitor-1"),
        ("timestamp", "1700000000"),
    ]


def test_add_web_signature_requires_visitor_cookie():
    source = "https://www.douyin.com/aweme/v1/web/aweme/detail/?aid=6383&a_bogus=abc"
    assert add_web_signature(source, {}) == (source, {})


def test_protected_path_list_covers_download_endpoints():
    assert requires_web_signature("/aweme/v1/web/aweme/detail/")
    assert requires_web_signature("https://www.douyin.com/aweme/v1/web/aweme/post/")
    assert not requires_web_signature("/aweme/v1/web/user/profile/other/")
