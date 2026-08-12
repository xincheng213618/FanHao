from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import MethodType
from unittest.mock import patch


MODULE_DIR = Path(__file__).resolve().parents[1]
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from manager_core.http_api import Handler  # noqa: E402


class HttpRangeContractTests(unittest.TestCase):
    def test_full_range_if_range_and_unsatisfied_contract(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-manager-range-contract-") as temp:
            media_path = Path(temp) / "fixture.mp4"
            media_path.write_bytes(b"0123456789")
            fixed_ns = 1_725_000_000_123_456_700
            os.utime(media_path, ns=(fixed_ns, fixed_ns))

            full = serve_media(media_path)
            self.assertEqual(full.status, 200)
            self.assertEqual(full.body, b"0123456789")
            self.assertEqual(full.headers["Content-Length"], "10")
            self.assertEqual(full.headers["Accept-Ranges"], "bytes")
            self.assertRegex(full.headers["ETag"], r'^W/"[0-9a-f]+-[0-9a-f]+"$')
            self.assertTrue(full.headers["Last-Modified"].endswith(" GMT"))

            ranged = serve_media(
                media_path,
                headers={"Range": "bytes=3-5"},
            )
            self.assertEqual(ranged.status, 206)
            self.assertEqual(ranged.body, b"345")
            self.assertEqual(ranged.headers["Content-Range"], "bytes 3-5/10")
            self.assertEqual(ranged.headers["ETag"], full.headers["ETag"])

            for date_validator in (
                full.headers["Last-Modified"],
                "Fri, 31 Dec 9999 23:59:59 GMT",
            ):
                with self.subTest(date_validator=date_validator):
                    ranged_by_date = serve_media(
                        media_path,
                        headers={"Range": "bytes=8-", "If-Range": date_validator},
                    )
                    self.assertEqual(ranged_by_date.status, 200)
                    self.assertEqual(ranged_by_date.body, b"0123456789")
                    self.assertNotIn("Content-Range", ranged_by_date.headers)

            for stale_validator in ('"stale"', full.headers["ETag"], "not-a-date"):
                with self.subTest(stale_validator=stale_validator):
                    stale = serve_media(
                        media_path,
                        headers={"Range": "bytes=3-", "If-Range": stale_validator},
                    )
                    self.assertEqual(stale.status, 200)
                    self.assertEqual(stale.body, b"0123456789")
                    self.assertNotIn("Content-Range", stale.headers)

            stale_unsatisfied = serve_media(
                media_path,
                headers={"Range": "bytes=99-", "If-Range": '"stale"'},
            )
            self.assertEqual(stale_unsatisfied.status, 200)
            self.assertEqual(stale_unsatisfied.body, b"0123456789")

            unsatisfied = serve_media(media_path, headers={"Range": "bytes=10-"})
            self.assertEqual(unsatisfied.status, 416)
            self.assertEqual(unsatisfied.body, b"")
            self.assertEqual(unsatisfied.headers["Content-Range"], "bytes */10")
            self.assertEqual(unsatisfied.headers["Content-Length"], "0")
            self.assertEqual(unsatisfied.headers["ETag"], full.headers["ETag"])
            self.assertEqual(unsatisfied.headers["Last-Modified"], full.headers["Last-Modified"])

            for ignored_range in ("items=0-1", "bytes=0-1,3-4", "bytes=invalid"):
                with self.subTest(ignored_range=ignored_range):
                    ignored = serve_media(media_path, headers={"Range": ignored_range})
                    self.assertEqual(ignored.status, 200)
                    self.assertEqual(ignored.body, b"0123456789")
                    self.assertNotIn("Content-Range", ignored.headers)

            reversed_range = serve_media(media_path, headers={"Range": "bytes=5-3"})
            self.assertEqual(reversed_range.status, 416)
            self.assertEqual(reversed_range.headers["Content-Range"], "bytes */10")

            oversized_range = serve_media(media_path, headers={"Range": f"bytes={'9' * 5000}-"})
            self.assertEqual(oversized_range.status, 416)
            self.assertEqual(oversized_range.headers["Content-Range"], "bytes */10")

    def test_head_has_get_status_and_headers_without_body(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-manager-range-contract-") as temp:
            media_path = Path(temp) / "fixture.mp4"
            media_path.write_bytes(b"0123456789")

            get_full = serve_media(media_path)
            head_full = serve_media(media_path, command="HEAD")
            self.assertEqual(head_full.status, get_full.status)
            self.assertEqual(head_full.headers, get_full.headers)
            self.assertEqual(head_full.body, b"")

            get_range = serve_media(media_path, headers={"Range": "bytes=2-4"})
            head_range = serve_media(media_path, command="HEAD", headers={"Range": "bytes=2-4"})
            self.assertEqual(get_range.status, 206)
            self.assertEqual(head_range.status, 200)
            self.assertEqual(head_range.headers, get_full.headers)
            self.assertNotIn("Content-Range", head_range.headers)
            self.assertEqual(head_range.body, b"")

            handler, state = capture_handler("HEAD")
            handler.path = "/api/library/media?id=7&role=video&index=0"
            with patch("manager_core.http_api.resolve_library_media", return_value=media_path):
                Handler.do_HEAD(handler)
            routed_head = captured_response(handler, state)
            self.assertEqual(routed_head.status, 200)
            self.assertEqual(routed_head.headers, get_full.headers)
            self.assertEqual(routed_head.body, b"")

    def test_empty_entity_is_full_200_but_any_range_is_416(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-manager-range-contract-") as temp:
            media_path = Path(temp) / "empty.mp4"
            media_path.write_bytes(b"")

            full = serve_media(media_path)
            self.assertEqual(full.status, 200)
            self.assertEqual(full.headers["Content-Length"], "0")
            self.assertEqual(full.body, b"")

            ranged = serve_media(media_path, headers={"Range": "bytes=0-"})
            self.assertEqual(ranged.status, 416)
            self.assertEqual(ranged.headers["Content-Range"], "bytes */0")

    def test_same_length_replacement_changes_etag_within_the_same_second(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-manager-range-contract-") as temp:
            media_path = Path(temp) / "fixture.mp4"
            media_path.write_bytes(b"v1-data")
            first_ns = 1_725_000_000_000_000_000
            os.utime(media_path, ns=(first_ns, first_ns))
            first = serve_media(media_path)

            media_path.write_bytes(b"v2-data")
            second_ns = first_ns + 500_000_000
            os.utime(media_path, ns=(second_ns, second_ns))
            second = serve_media(media_path)

            self.assertNotEqual(first.headers["ETag"], second.headers["ETag"])
            self.assertEqual(first.headers["Last-Modified"], second.headers["Last-Modified"])
            resumed_by_ambiguous_date = serve_media(
                media_path,
                headers={"Range": "bytes=2-", "If-Range": first.headers["Last-Modified"]},
            )
            self.assertEqual(resumed_by_ambiguous_date.status, 200)
            self.assertEqual(resumed_by_ambiguous_date.body, b"v2-data")
            self.assertNotIn("Content-Range", resumed_by_ambiguous_date.headers)


class CapturedResponse:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body


def serve_media(path: Path, command: str = "GET", headers: dict[str, str] | None = None) -> CapturedResponse:
    handler, state = capture_handler(command, headers)
    Handler.serve_media(handler, path)
    return captured_response(handler, state)


def capture_handler(
    command: str,
    headers: dict[str, str] | None = None,
) -> tuple[Handler, dict[str, object]]:
    handler = Handler.__new__(Handler)
    handler.command = command
    handler.headers = Message()
    for name, value in (headers or {}).items():
        handler.headers[name] = value
    handler.wfile = io.BytesIO()
    state: dict[str, object] = {"status": 0, "headers": {}}

    def send_response(_self: Handler, status: int, _message: str | None = None) -> None:
        state["status"] = int(status)

    def send_header(_self: Handler, name: str, value: str) -> None:
        captured_headers = state["headers"]
        assert isinstance(captured_headers, dict)
        captured_headers[name] = str(value)

    handler.send_response = MethodType(send_response, handler)
    handler.send_header = MethodType(send_header, handler)
    handler.end_headers = MethodType(lambda _self: None, handler)
    return handler, state


def captured_response(handler: Handler, state: dict[str, object]) -> CapturedResponse:
    status = state["status"]
    headers = state["headers"]
    assert isinstance(status, int)
    assert isinstance(headers, dict)
    return CapturedResponse(status, headers, handler.wfile.getvalue())


if __name__ == "__main__":
    unittest.main()
