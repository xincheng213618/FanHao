"""Loopback contract tests for entity-safe HTTP download resumption.

This module intentionally uses only :mod:`unittest` from the test framework
side.  The embedded runtime verifier executes it explicitly, so a machine
without pytest cannot silently skip the resume safety gate.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from storage.file_manager import FileManager

STRONG_V1 = '"entity-v1"'
STRONG_V2 = '"entity-v2"'
LAST_MODIFIED_V1 = "Wed, 12 Aug 2026 00:00:00 GMT"
LAST_MODIFIED_V2 = "Wed, 12 Aug 2026 00:01:00 GMT"
V1 = b"AAAAA11111"
V2 = b"BBBBB22222"
META_KEYS = {
    "schema",
    "written_length",
    "expected_length",
    "original_url_sha256",
    "final_url_sha256",
    "content_type",
}


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _tmp_path(target: Path) -> Path:
    return target.with_suffix(target.suffix + ".tmp")


def _meta_path(target: Path) -> Path:
    return Path(f"{_tmp_path(target)}.meta.json")


def _write_checkpoint(
    target: Path,
    body: bytes,
    *,
    original_url: str,
    final_url: str | None = None,
    expected_length: int | None = None,
    etag: str | None = STRONG_V1,
    last_modified: str | None = None,
    content_type: str = "video/mp4",
) -> None:
    _tmp_path(target).parent.mkdir(parents=True, exist_ok=True)
    _tmp_path(target).write_bytes(body)
    metadata = {
        "schema": 1,
        "written_length": len(body),
        "expected_length": expected_length,
        "original_url_sha256": _sha256(original_url),
        "final_url_sha256": _sha256(final_url or original_url),
        "content_type": content_type,
    }
    if etag is not None:
        metadata["etag"] = etag
    elif last_modified is not None:
        metadata["last_modified"] = last_modified
    else:
        raise ValueError("a strong ETag or valid Last-Modified checkpoint is required")
    _meta_path(target).write_text(
        json.dumps(metadata, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )


def _send(
    handler: BaseHTTPRequestHandler,
    status: int,
    body: bytes = b"",
    *,
    headers: dict[str, str] | None = None,
    advertised_length: int | None = None,
    disconnect_after_body: bool = False,
    chunked: bool = False,
) -> None:
    response_headers = dict(headers or {})
    if chunked:
        response_headers["Transfer-Encoding"] = "chunked"
    elif not any(key.lower() == "content-length" for key in response_headers):
        response_headers["Content-Length"] = str(
            len(body) if advertised_length is None else advertised_length
        )
    response_headers.setdefault("Connection", "close")
    handler.send_response(status)
    for name, value in response_headers.items():
        handler.send_header(name, value)
    handler.end_headers()
    try:
        if body:
            if chunked:
                handler.wfile.write(f"{len(body):X}\r\n".encode("ascii"))
                handler.wfile.write(body + b"\r\n0\r\n\r\n")
            else:
                handler.wfile.write(body)
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    if disconnect_after_body:
        # Give the async client a deterministic chance to yield the received
        # prefix before the socket reports the deliberately truncated body.
        time.sleep(0.1)
        handler.close_connection = True
        try:
            handler.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        self.server.fixture.dispatch(self)  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _LoopbackFixture:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.routes: dict[str, object] = {}
        self.calls: list[dict[str, object]] = []
        self.errors: list[str] = []
        self.active_requests = 0
        self.max_active_requests = 0
        self._route_counts: dict[str, int] = {}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.daemon_threads = True
        self.server.fixture = self  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def configure(self, routes: dict[str, object]) -> None:
        with self._lock:
            self.routes = dict(routes)
            self.calls = []
            self.errors = []
            self.active_requests = 0
            self.max_active_requests = 0
            self._route_counts = {}

    def url(self, path: str) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}{path}"

    def dispatch(self, handler: BaseHTTPRequestHandler) -> None:
        path = urlsplit(handler.path).path
        with self._lock:
            route_count = self._route_counts.get(path, 0) + 1
            self._route_counts[path] = route_count
            record = {
                "path": path,
                "raw_path": handler.path,
                "headers": {name.lower(): value for name, value in handler.headers.items()},
                "route_count": route_count,
            }
            self.calls.append(record)
            self.active_requests += 1
            self.max_active_requests = max(self.max_active_requests, self.active_requests)
            route = self.routes.get(path)
        try:
            if route is None:
                _send(handler, 404)
            else:
                route(handler, record)  # type: ignore[operator]
        except Exception as exc:  # pragma: no cover - surfaced through ``errors``
            with self._lock:
                self.errors.append(f"{path}: {type(exc).__name__}: {exc}")
            try:
                _send(handler, 500)
            except OSError:
                pass
        finally:
            with self._lock:
                self.active_requests -= 1

    def calls_for(self, path: str) -> list[dict[str, object]]:
        with self._lock:
            return [dict(call) for call in self.calls if call["path"] == path]


def _headers(call: dict[str, object]) -> dict[str, str]:
    return call["headers"]  # type: ignore[return-value]


def _range_start(call: dict[str, object]) -> int:
    value = _headers(call).get("range", "")
    if not value.startswith("bytes=") or not value.endswith("-"):
        raise AssertionError(f"expected open-ended byte range, got {value!r}")
    return int(value.removeprefix("bytes=").removesuffix("-"))


class DownloadResumeContractTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.loopback = _LoopbackFixture()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.loopback.close()

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="fanhao-resume-contract-")
        self.root = Path(self.temp_dir.name)
        self.loopback.configure({})

    def tearDown(self) -> None:
        errors = list(self.loopback.errors)
        self.temp_dir.cleanup()
        self.assertEqual(errors, [], f"loopback handler errors: {errors}")

    def target(self, name: str = "media.mp4") -> Path:
        return self.root / "nested output" / "中文" / name

    def assert_checkpoint(
        self,
        target: Path,
        *,
        body: bytes,
        expected_length: int | None,
        etag: str | None,
        last_modified: str | None,
        original_url: str,
        final_url: str | None = None,
        content_type: str = "video/mp4",
    ) -> dict[str, object]:
        self.assertEqual(_tmp_path(target).read_bytes(), body)
        raw = _meta_path(target).read_text(encoding="utf-8")
        payload = json.loads(raw)
        validator_key = "etag" if etag is not None else "last_modified"
        self.assertEqual(set(payload), META_KEYS | {validator_key})
        self.assertEqual(payload["schema"], 1)
        self.assertEqual(payload["written_length"], len(body))
        self.assertEqual(payload["expected_length"], expected_length)
        self.assertEqual(payload.get("etag"), etag)
        self.assertEqual(payload.get("last_modified"), last_modified)
        self.assertEqual(payload["original_url_sha256"], _sha256(original_url))
        self.assertEqual(payload["final_url_sha256"], _sha256(final_url or original_url))
        self.assertEqual(payload["content_type"], content_type)
        for digest_key in ("original_url_sha256", "final_url_sha256"):
            self.assertRegex(str(payload[digest_key]), r"^[0-9a-f]{64}$")
        self.assertNotIn(original_url, raw)
        if final_url:
            self.assertNotIn(final_url, raw)
        return payload

    def assert_no_checkpoint(self, target: Path) -> None:
        self.assertFalse(_tmp_path(target).exists())
        self.assertFalse(_meta_path(target).exists())

    async def test_strong_etag_interruption_creates_private_pair_then_resumes(self) -> None:
        target = self.target()
        url = self.loopback.url("/strong?signature=must-not-be-persisted")
        prefix = V1[:5]

        def route(handler: BaseHTTPRequestHandler, call: dict[str, object]) -> None:
            request_headers = _headers(call)
            if not request_headers.get("range"):
                _send(
                    handler,
                    200,
                    prefix,
                    headers={"Content-Type": "video/mp4", "ETag": STRONG_V1},
                    advertised_length=len(V1),
                    disconnect_after_body=True,
                )
                return
            start = _range_start(call)
            _send(
                handler,
                206,
                V1[start:],
                headers={
                    "Content-Type": "video/mp4",
                    "Content-Range": f"bytes {start}-{len(V1) - 1}/{len(V1)}",
                    "ETag": STRONG_V1,
                },
            )

        self.loopback.configure({"/strong": route})
        manager = FileManager(str(self.root))

        self.assertFalse(await manager.download_file(url, target))
        self.assert_checkpoint(
            target,
            body=prefix,
            expected_length=len(V1),
            etag=STRONG_V1,
            last_modified=None,
            original_url=url,
        )
        raw_meta = _meta_path(target).read_text(encoding="utf-8")
        self.assertNotIn("signature", raw_meta)
        self.assertNotIn("must-not-be-persisted", raw_meta)

        self.assertTrue(await manager.download_file(url, target))
        self.assertEqual(target.read_bytes(), V1)
        self.assert_no_checkpoint(target)
        calls = self.loopback.calls_for("/strong")
        self.assertEqual(len(calls), 2)
        self.assertEqual(_headers(calls[1]).get("range"), f"bytes={len(prefix)}-")
        self.assertEqual(_headers(calls[1]).get("if-range"), STRONG_V1)
        self.assertEqual(_headers(calls[1]).get("accept-encoding"), "identity")

    async def test_weak_etag_uses_valid_last_modified_fallback(self) -> None:
        target = self.target("last-modified.mp4")
        url = self.loopback.url("/last-modified")
        prefix = V1[:5]

        def route(handler: BaseHTTPRequestHandler, call: dict[str, object]) -> None:
            request_headers = _headers(call)
            common = {
                "Content-Type": "video/mp4",
                "ETag": 'W/"weak-entity-v1"',
                "Last-Modified": LAST_MODIFIED_V1,
            }
            if not request_headers.get("range"):
                _send(
                    handler,
                    200,
                    prefix,
                    headers=common,
                    advertised_length=len(V1),
                    disconnect_after_body=True,
                )
                return
            start = _range_start(call)
            _send(
                handler,
                206,
                V1[start:],
                headers={
                    **common,
                    "Content-Range": f"bytes {start}-{len(V1) - 1}/{len(V1)}",
                },
            )

        self.loopback.configure({"/last-modified": route})
        manager = FileManager(str(self.root))
        self.assertFalse(await manager.download_file(url, target))
        self.assert_checkpoint(
            target,
            body=prefix,
            expected_length=len(V1),
            etag=None,
            last_modified=LAST_MODIFIED_V1,
            original_url=url,
        )

        self.assertTrue(await manager.download_file(url, target))
        self.assertEqual(target.read_bytes(), V1)
        calls = self.loopback.calls_for("/last-modified")
        self.assertEqual(_headers(calls[-1]).get("if-range"), LAST_MODIFIED_V1)
        self.assert_no_checkpoint(target)

    async def test_weak_missing_or_invalid_validators_never_leave_resumable_bytes(self) -> None:
        cases = {
            "weak": {"ETag": 'W/"weak-only"'},
            "missing": {},
            "invalid-last-modified": {
                "ETag": 'W/"weak-only"',
                "Last-Modified": "not-an-http-date",
            },
        }
        for name, validator_headers in cases.items():
            with self.subTest(name=name):
                target = self.target(f"{name}.mp4")
                path = f"/{name}"
                url = self.loopback.url(path)

                def route(
                    handler: BaseHTTPRequestHandler,
                    call: dict[str, object],
                    validators: dict[str, str] = validator_headers,
                ) -> None:
                    if int(call["route_count"]) == 1:
                        _send(
                            handler,
                            200,
                            V1[:3],
                            headers={"Content-Type": "video/mp4", **validators},
                            advertised_length=len(V1),
                            disconnect_after_body=True,
                        )
                    else:
                        _send(
                            handler,
                            200,
                            V1,
                            headers={"Content-Type": "video/mp4", **validators},
                        )

                self.loopback.configure({path: route})
                manager = FileManager(str(self.root))
                self.assertFalse(await manager.download_file(url, target))
                self.assert_no_checkpoint(target)
                self.assertTrue(await manager.download_file(url, target))
                self.assertEqual(target.read_bytes(), V1)
                calls = self.loopback.calls_for(path)
                self.assertNotIn("range", _headers(calls[-1]))
                self.assertNotIn("if-range", _headers(calls[-1]))

    async def test_legacy_or_malformed_checkpoint_is_discarded_before_request(self) -> None:
        cases = ("legacy", "malformed")
        for name in cases:
            with self.subTest(name=name):
                target = self.target(f"{name}.mp4")
                path = f"/{name}-checkpoint"
                url = self.loopback.url(path)
                _tmp_path(target).parent.mkdir(parents=True, exist_ok=True)
                _tmp_path(target).write_bytes(b"stale-prefix")
                if name == "malformed":
                    _meta_path(target).write_text('{"schema":1}', encoding="utf-8")

                def route(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
                    _send(
                        handler,
                        200,
                        V2,
                        headers={"Content-Type": "video/mp4", "ETag": STRONG_V2},
                    )

                self.loopback.configure({path: route})
                self.assertTrue(await FileManager(str(self.root)).download_file(url, target))
                self.assertEqual(target.read_bytes(), V2)
                request_headers = _headers(self.loopback.calls_for(path)[0])
                self.assertNotIn("range", request_headers)
                self.assertNotIn("if-range", request_headers)
                self.assert_no_checkpoint(target)

    async def test_if_range_rejected_with_200_replaces_same_length_entity(self) -> None:
        target = self.target("same-length-200.mp4")
        url = self.loopback.url("/same-length-200")
        _write_checkpoint(
            target,
            V1[:5],
            original_url=url,
            expected_length=len(V1),
        )

        def route(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            _send(
                handler,
                200,
                V2,
                headers={"Content-Type": "video/mp4", "ETag": STRONG_V2},
            )

        self.loopback.configure({"/same-length-200": route})
        self.assertTrue(await FileManager(str(self.root)).download_file(url, target))
        self.assertEqual(target.read_bytes(), V2)
        call = self.loopback.calls_for("/same-length-200")[0]
        self.assertEqual(_headers(call).get("range"), "bytes=5-")
        self.assertEqual(_headers(call).get("if-range"), STRONG_V1)
        self.assert_no_checkpoint(target)

    async def test_malicious_different_entity_206_retries_full_in_same_operation(self) -> None:
        target = self.target("malicious-206.mp4")
        url = self.loopback.url("/malicious-206")
        _write_checkpoint(
            target,
            V1[:5],
            original_url=url,
            expected_length=len(V1),
        )

        def route(handler: BaseHTTPRequestHandler, call: dict[str, object]) -> None:
            if _headers(call).get("range"):
                _send(
                    handler,
                    206,
                    V2[5:],
                    headers={
                        "Content-Type": "video/mp4",
                        "Content-Range": f"bytes 5-{len(V2) - 1}/{len(V2)}",
                        "ETag": STRONG_V2,
                    },
                )
            else:
                _send(
                    handler,
                    200,
                    V2,
                    headers={"Content-Type": "video/mp4", "ETag": STRONG_V2},
                )

        self.loopback.configure({"/malicious-206": route})
        self.assertTrue(await FileManager(str(self.root)).download_file(url, target))
        self.assertEqual(target.read_bytes(), V2)
        self.assertNotEqual(target.read_bytes(), V1[:5] + V2[5:])
        calls = self.loopback.calls_for("/malicious-206")
        self.assertEqual(len(calls), 2)
        self.assertEqual(_headers(calls[0]).get("if-range"), STRONG_V1)
        self.assertNotIn("range", _headers(calls[1]))
        self.assertNotIn("if-range", _headers(calls[1]))
        self.assert_no_checkpoint(target)

    async def test_redirect_stable_target_resumes_same_strong_entity(self) -> None:
        target = self.target("redirect-stable.mp4")
        original_url = self.loopback.url("/redirect-stable")
        final_url = self.loopback.url("/redirect-final")
        _write_checkpoint(
            target,
            V1[:4],
            original_url=original_url,
            final_url=final_url,
            expected_length=len(V1),
        )

        def redirect(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            _send(handler, 302, headers={"Location": final_url})

        def final(handler: BaseHTTPRequestHandler, call: dict[str, object]) -> None:
            start = _range_start(call)
            _send(
                handler,
                206,
                V1[start:],
                headers={
                    "Content-Type": "video/mp4",
                    "Content-Range": f"bytes {start}-{len(V1) - 1}/{len(V1)}",
                    "ETag": STRONG_V1,
                },
            )

        self.loopback.configure({"/redirect-stable": redirect, "/redirect-final": final})
        self.assertTrue(await FileManager(str(self.root)).download_file(original_url, target))
        self.assertEqual(target.read_bytes(), V1)
        final_call = self.loopback.calls_for("/redirect-final")[0]
        self.assertEqual(_headers(final_call).get("range"), "bytes=4-")
        self.assertEqual(_headers(final_call).get("if-range"), STRONG_V1)

    async def test_redirect_target_change_requires_strong_identity(self) -> None:
        # A changed final URL is still reusable with the exact same strong ETag.
        strong_target = self.target("redirect-changed-strong.mp4")
        strong_original = self.loopback.url("/redirect-changed-strong")
        old_final = self.loopback.url("/old-mirror")
        new_final = self.loopback.url("/new-mirror-strong")
        _write_checkpoint(
            strong_target,
            V1[:4],
            original_url=strong_original,
            final_url=old_final,
            expected_length=len(V1),
        )

        def strong_redirect(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            _send(handler, 302, headers={"Location": new_final})

        def strong_final(handler: BaseHTTPRequestHandler, call: dict[str, object]) -> None:
            start = _range_start(call)
            _send(
                handler,
                206,
                V1[start:],
                headers={
                    "Content-Type": "video/mp4",
                    "Content-Range": f"bytes {start}-{len(V1) - 1}/{len(V1)}",
                    "ETag": STRONG_V1,
                },
            )

        self.loopback.configure(
            {
                "/redirect-changed-strong": strong_redirect,
                "/new-mirror-strong": strong_final,
            }
        )
        self.assertTrue(
            await FileManager(str(self.root)).download_file(strong_original, strong_target)
        )
        self.assertEqual(strong_target.read_bytes(), V1)

        # Last-Modified alone cannot carry a partial across a changed target.
        lm_target = self.target("redirect-changed-last-modified.mp4")
        lm_original = self.loopback.url("/redirect-changed-last-modified")
        lm_final = self.loopback.url("/new-mirror-last-modified")
        _write_checkpoint(
            lm_target,
            V1[:4],
            original_url=lm_original,
            final_url=old_final,
            expected_length=len(V1),
            etag=None,
            last_modified=LAST_MODIFIED_V1,
        )

        def lm_redirect(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            _send(handler, 302, headers={"Location": lm_final})

        def lm_final_route(handler: BaseHTTPRequestHandler, call: dict[str, object]) -> None:
            if _headers(call).get("range"):
                start = _range_start(call)
                _send(
                    handler,
                    206,
                    V1[start:],
                    headers={
                        "Content-Type": "video/mp4",
                        "Content-Range": f"bytes {start}-{len(V1) - 1}/{len(V1)}",
                        "Last-Modified": LAST_MODIFIED_V1,
                    },
                )
            else:
                _send(
                    handler,
                    200,
                    V2,
                    headers={
                        "Content-Type": "video/mp4",
                        "Last-Modified": LAST_MODIFIED_V2,
                    },
                )

        self.loopback.configure(
            {
                "/redirect-changed-last-modified": lm_redirect,
                "/new-mirror-last-modified": lm_final_route,
            }
        )
        self.assertTrue(await FileManager(str(self.root)).download_file(lm_original, lm_target))
        self.assertEqual(lm_target.read_bytes(), V2)
        final_calls = self.loopback.calls_for("/new-mirror-last-modified")
        self.assertGreaterEqual(len(final_calls), 2)
        self.assertIn("range", _headers(final_calls[0]))
        self.assertNotIn("range", _headers(final_calls[-1]))

    async def test_cross_original_url_never_reuses_partial_even_with_same_strong_etag(
        self,
    ) -> None:
        old_url = self.loopback.url("/cross-mirror-old")

        strong_target = self.target("cross-mirror-strong.mp4")
        strong_url = self.loopback.url("/cross-mirror-strong")
        _write_checkpoint(
            strong_target,
            V1[:5],
            original_url=old_url,
            final_url=old_url,
            expected_length=len(V1),
        )

        def strong_route(handler: BaseHTTPRequestHandler, call: dict[str, object]) -> None:
            if _headers(call).get("range"):
                start = _range_start(call)
                _send(
                    handler,
                    206,
                    V2[start:],
                    headers={
                        "Content-Type": "video/mp4",
                        "Content-Range": f"bytes {start}-{len(V2) - 1}/{len(V2)}",
                        # Deliberately collide across two unrelated URLs.
                        "ETag": STRONG_V1,
                    },
                )
            else:
                _send(
                    handler,
                    200,
                    V2,
                    headers={"Content-Type": "video/mp4", "ETag": STRONG_V1},
                )

        self.loopback.configure({"/cross-mirror-strong": strong_route})
        self.assertTrue(await FileManager(str(self.root)).download_file(strong_url, strong_target))
        self.assertEqual(strong_target.read_bytes(), V2)
        self.assertNotEqual(strong_target.read_bytes(), V1[:5] + V2[5:])
        strong_calls = self.loopback.calls_for("/cross-mirror-strong")
        self.assertEqual(len(strong_calls), 1)
        self.assertNotIn("range", _headers(strong_calls[0]))
        self.assertNotIn("if-range", _headers(strong_calls[0]))

        lm_target = self.target("cross-mirror-last-modified.mp4")
        lm_url = self.loopback.url("/cross-mirror-last-modified")
        _write_checkpoint(
            lm_target,
            V1[:3],
            original_url=old_url,
            final_url=old_url,
            expected_length=len(V1),
            etag=None,
            last_modified=LAST_MODIFIED_V1,
        )

        def lm_route(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            call = _call
            if _headers(call).get("range"):
                start = _range_start(call)
                _send(
                    handler,
                    206,
                    V1[start:],
                    headers={
                        "Content-Type": "video/mp4",
                        "Content-Range": f"bytes {start}-{len(V1) - 1}/{len(V1)}",
                        "Last-Modified": LAST_MODIFIED_V1,
                    },
                )
            else:
                _send(
                    handler,
                    200,
                    V2,
                    headers={
                        "Content-Type": "video/mp4",
                        "Last-Modified": LAST_MODIFIED_V2,
                    },
                )

        self.loopback.configure({"/cross-mirror-last-modified": lm_route})
        self.assertTrue(await FileManager(str(self.root)).download_file(lm_url, lm_target))
        self.assertEqual(lm_target.read_bytes(), V2)
        lm_calls = self.loopback.calls_for("/cross-mirror-last-modified")
        self.assertEqual(len(lm_calls), 1)
        self.assertNotIn("range", _headers(lm_calls[0]))
        self.assertNotIn("if-range", _headers(lm_calls[0]))

    async def test_416_promotes_only_matching_validator_and_length(self) -> None:
        matching_target = self.target("matching-416.mp4")
        matching_url = self.loopback.url("/matching-416")
        _write_checkpoint(
            matching_target,
            V1,
            original_url=matching_url,
            expected_length=len(V1),
        )

        def matching_route(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            _send(
                handler,
                416,
                headers={
                    "Content-Range": f"bytes */{len(V1)}",
                    "ETag": STRONG_V1,
                },
            )

        self.loopback.configure({"/matching-416": matching_route})
        self.assertTrue(
            await FileManager(str(self.root)).download_file(matching_url, matching_target)
        )
        self.assertEqual(matching_target.read_bytes(), V1)
        self.assert_no_checkpoint(matching_target)

        cases = {
            "missing-validator": {
                "Content-Range": f"bytes */{len(V1)}",
            },
            "changed-validator": {
                "Content-Range": f"bytes */{len(V1)}",
                "ETag": STRONG_V2,
            },
            "changed-total": {
                "Content-Range": f"bytes */{len(V1) + 1}",
                "ETag": STRONG_V1,
            },
        }
        for name, first_headers in cases.items():
            with self.subTest(name=name):
                target = self.target(f"{name}.mp4")
                path = f"/{name}-416"
                url = self.loopback.url(path)
                _write_checkpoint(
                    target,
                    V1,
                    original_url=url,
                    expected_length=len(V1),
                )

                def route(
                    handler: BaseHTTPRequestHandler,
                    call: dict[str, object],
                    bad_headers: dict[str, str] = first_headers,
                ) -> None:
                    if _headers(call).get("range"):
                        _send(handler, 416, headers=bad_headers)
                    else:
                        _send(
                            handler,
                            200,
                            V2,
                            headers={"Content-Type": "video/mp4", "ETag": STRONG_V2},
                        )

                self.loopback.configure({path: route})
                self.assertTrue(await FileManager(str(self.root)).download_file(url, target))
                self.assertEqual(target.read_bytes(), V2)
                calls = self.loopback.calls_for(path)
                self.assertEqual(len(calls), 2)
                self.assertIn("range", _headers(calls[0]))
                self.assertNotIn("range", _headers(calls[1]))
                self.assert_no_checkpoint(target)

    async def test_invalid_206_offset_total_shape_or_overflow_retries_full(self) -> None:
        cases = {
            "malformed": ("not-a-content-range", V2[5:]),
            "offset": (f"bytes 4-{len(V1) - 1}/{len(V1)}", V2[4:]),
            "total": (f"bytes 5-{len(V1)}/{len(V1) + 1}", V2[5:] + b"X"),
            "overflow": (f"bytes 5-{len(V1) - 1}/{len(V1)}", V2[5:] + b"X"),
        }
        for name, (content_range, bad_body) in cases.items():
            with self.subTest(name=name):
                target = self.target(f"bad-206-{name}.mp4")
                path = f"/bad-206-{name}"
                url = self.loopback.url(path)
                _write_checkpoint(
                    target,
                    V1[:5],
                    original_url=url,
                    expected_length=len(V1),
                )

                def route(
                    handler: BaseHTTPRequestHandler,
                    call: dict[str, object],
                    bad_range: str = content_range,
                    body: bytes = bad_body,
                    use_chunked: bool = name == "overflow",
                ) -> None:
                    if _headers(call).get("range"):
                        _send(
                            handler,
                            206,
                            body,
                            headers={
                                "Content-Type": "video/mp4",
                                "Content-Range": bad_range,
                                "ETag": STRONG_V1,
                            },
                            chunked=use_chunked,
                        )
                    else:
                        _send(
                            handler,
                            200,
                            V2,
                            headers={"Content-Type": "video/mp4", "ETag": STRONG_V2},
                        )

                self.loopback.configure({path: route})
                self.assertTrue(await FileManager(str(self.root)).download_file(url, target))
                self.assertEqual(target.read_bytes(), V2)
                calls = self.loopback.calls_for(path)
                self.assertEqual(len(calls), 2)
                self.assertIn("range", _headers(calls[0]))
                self.assertNotIn("range", _headers(calls[1]))
                self.assert_no_checkpoint(target)

    async def test_truncated_206_preserves_updated_pair_and_next_call_resumes(self) -> None:
        target = self.target("truncated-206.mp4")
        url = self.loopback.url("/truncated-206")
        initial = V1[:3]
        delivered = V1[3:6]
        _write_checkpoint(
            target,
            initial,
            original_url=url,
            expected_length=len(V1),
        )

        def route(handler: BaseHTTPRequestHandler, call: dict[str, object]) -> None:
            start = _range_start(call)
            if int(call["route_count"]) == 1:
                _send(
                    handler,
                    206,
                    delivered,
                    headers={
                        "Content-Type": "video/mp4",
                        "Content-Range": f"bytes {start}-{len(V1) - 1}/{len(V1)}",
                        "ETag": STRONG_V1,
                    },
                    advertised_length=len(V1) - start,
                    disconnect_after_body=True,
                )
            else:
                _send(
                    handler,
                    206,
                    V1[start:],
                    headers={
                        "Content-Type": "video/mp4",
                        "Content-Range": f"bytes {start}-{len(V1) - 1}/{len(V1)}",
                        "ETag": STRONG_V1,
                    },
                )

        self.loopback.configure({"/truncated-206": route})
        manager = FileManager(str(self.root))
        self.assertFalse(await manager.download_file(url, target))
        self.assert_checkpoint(
            target,
            body=initial + delivered,
            expected_length=len(V1),
            etag=STRONG_V1,
            last_modified=None,
            original_url=url,
        )
        self.assertTrue(await manager.download_file(url, target))
        self.assertEqual(target.read_bytes(), V1)
        calls = self.loopback.calls_for("/truncated-206")
        self.assertEqual(_headers(calls[-1]).get("range"), f"bytes={len(initial + delivered)}-")
        self.assert_no_checkpoint(target)

    async def test_content_type_preference_never_resumes_or_leaves_metadata(self) -> None:
        target = self.target("gallery.jpg")
        url = self.loopback.url("/gallery")
        _write_checkpoint(
            target,
            b"stale-jpeg-prefix",
            original_url=url,
            expected_length=999,
        )
        png_body = b"\x89PNG\r\n\x1a\nfixture"

        def route(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            _send(
                handler,
                200,
                png_body,
                headers={"Content-Type": "image/png", "ETag": STRONG_V2},
            )

        self.loopback.configure({"/gallery": route})
        result = await FileManager(str(self.root)).download_file(
            url,
            target,
            prefer_response_content_type=True,
            return_saved_path=True,
        )
        expected_path = target.with_suffix(".png")
        self.assertEqual(result, expected_path)
        self.assertEqual(expected_path.read_bytes(), png_body)
        request_headers = _headers(self.loopback.calls_for("/gallery")[0])
        self.assertNotIn("range", request_headers)
        self.assertNotIn("if-range", request_headers)
        self.assert_no_checkpoint(target)
        self.assert_no_checkpoint(expected_path)

    async def test_same_final_path_is_single_flight_across_manager_instances(self) -> None:
        target = self.target("single-flight.mp4")
        url = self.loopback.url("/single-flight")

        def route(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            time.sleep(0.2)
            _send(
                handler,
                200,
                V1,
                headers={"Content-Type": "video/mp4", "ETag": STRONG_V1},
            )

        self.loopback.configure({"/single-flight": route})
        first = FileManager(str(self.root))
        second = FileManager(str(self.root))
        results = await asyncio.gather(
            first.download_file(url, target),
            second.download_file(url, target),
        )
        self.assertTrue(all(results), results)
        self.assertEqual(target.read_bytes(), V1)
        self.assertEqual(self.loopback.max_active_requests, 1)
        self.assertEqual(len(self.loopback.calls_for("/single-flight")), 1)
        self.assert_no_checkpoint(target)

        gallery_body = b"\x89PNG\r\n\x1a\nshared-gallery-fixture"

        def gallery_route(handler: BaseHTTPRequestHandler, _call: dict[str, object]) -> None:
            time.sleep(0.2)
            _send(
                handler,
                200,
                gallery_body,
                headers={"Content-Type": "image/png", "ETag": STRONG_V2},
            )

        self.loopback.configure(
            {
                "/gallery-flight-a": gallery_route,
                "/gallery-flight-b": gallery_route,
            }
        )
        gallery_jpg = self.target("gallery-flight.jpg")
        gallery_webp = self.target("gallery-flight.webp")
        gallery_results = await asyncio.gather(
            first.download_file(
                self.loopback.url("/gallery-flight-a"),
                gallery_jpg,
                prefer_response_content_type=True,
                return_saved_path=True,
            ),
            second.download_file(
                self.loopback.url("/gallery-flight-b"),
                gallery_webp,
                prefer_response_content_type=True,
                return_saved_path=True,
            ),
        )
        resolved_gallery = self.target("gallery-flight.png")
        self.assertEqual(gallery_results, [resolved_gallery, resolved_gallery])
        self.assertEqual(resolved_gallery.read_bytes(), gallery_body)
        gallery_calls = len(self.loopback.calls_for("/gallery-flight-a")) + len(
            self.loopback.calls_for("/gallery-flight-b")
        )
        self.assertEqual(gallery_calls, 1)
        self.assert_no_checkpoint(resolved_gallery)


if __name__ == "__main__":
    unittest.main()
