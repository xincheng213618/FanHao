import asyncio
import hashlib
import json
import os
import re
import threading
import time
import uuid
from datetime import timezone
from email.utils import format_datetime, parsedate_to_datetime
from pathlib import Path
from typing import Any, Dict, Optional, Union

import aiofiles
import aiohttp
import httpx

from utils.logger import setup_logger
from utils.timing import elapsed_ms, timing_event
from utils.validators import sanitize_filename

logger = setup_logger("FileManager")

# sec_uid 是 [A-Za-z0-9_-] 的稳定 token，本身已是文件系统安全字符。仅替换真正
# 非法的路径字符，但【不】折叠连续下划线、不截断长度——legacy DouYin-Downloader
# 的 ``user_<sec_uid>`` 目录用的就是原始 sec_uid（含 ``__``），折叠后会对不上
# 用户已有的目录。详见 ``_AUTHOR_DIR_STYLES`` 的 ``user_sec_uid``。
_SEC_UID_ILLEGAL_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# 媒体下载的流式读取块大小。8KB 会让单流吞吐受限于 chunk 往返开销
# （视频动辄几十 MB），256KB 在内存占用与吞吐之间取平衡。
_DOWNLOAD_CHUNK_BYTES = 256 * 1024

_PARTIAL_METADATA_SCHEMA = 1
_PARTIAL_METADATA_KEYS = {
    "schema",
    "written_length",
    "expected_length",
    "original_url_sha256",
    "final_url_sha256",
    "content_type",
}
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STRONG_ETAG_RE = re.compile(r'^"[\x21\x23-\x7e\x80-\xff]*"$')


class _UnsafePartialResponse(RuntimeError):
    """The response cannot safely extend the current partial entity."""


class FileManager:
    # The sidecar shares a FileManager across concurrent jobs, but tests and
    # embedders may construct more than one instance.  Keep in-flight work at
    # class scope so every caller on the same event loop joins the same write.
    _inflight_guard = threading.Lock()
    _inflight_downloads: Dict[tuple[int, str], asyncio.Task] = {}

    _IMAGE_CONTENT_TYPE_SUFFIXES = {
        "image/gif": ".gif",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }

    # 作者目录层可选风格（与 DEFAULT_CONFIG["author_dir"]、REST SettingsPatch
    # 的 Literal、前端下拉三处保持一致）。
    _AUTHOR_DIR_STYLES = ("nickname", "sec_uid", "nickname_uid", "user_sec_uid")

    def __init__(self, base_path: str = "./Downloaded"):
        self.base_path = Path(base_path)
        self.base_path.mkdir(parents=True, exist_ok=True)

    def get_save_path(
        self,
        author_name: str,
        mode: str = None,
        aweme_title: str = None,
        aweme_id: str = None,
        folderstyle: bool = True,
        download_date: str = "",
        folder_name: Optional[str] = None,
        *,
        author_sec_uid: Optional[str] = None,
        author_dir_style: str = "nickname",
        group_by_mode: bool = True,
        collection_dir: Optional[str] = None,
    ) -> Path:
        """Compute (and create) the destination directory for a download.

        ``folder_name`` is the pre-rendered, already-sanitized leaf directory
        name produced by ``utils.naming.render_template``. When provided, it
        overrides the legacy ``{date}_{title}_{id}`` layout. When omitted we
        fall back to the historical composition so external callers and the
        sibling CLI project keep working unchanged.

        ``author_dir_style`` controls how the author-level directory is
        composed (see :data:`_AUTHOR_DIR_STYLES`). Unknown values or missing
        ``author_sec_uid`` fall back to ``nickname`` with a ``WARNING`` so
        downloads never fail on a misconfiguration.

        ``group_by_mode`` controls whether the download mode (``post`` /
        ``like`` / ``mix`` …) gets its own sub-directory under the author. When
        ``False`` the mode layer is dropped entirely, so files land directly
        under the author directory (reproducing the legacy layout with no
        ``POST`` folder). It is independent of ``folderstyle`` (the per-aweme
        sub-folder).

        ``collection_dir`` inserts one more directory between the mode layer
        and the per-aweme leaf, so each 合集 (mix) lands in its own folder
        (``base/<author>/mix/<collection>/<leaf>``). It is sanitized here;
        empty / whitespace-only values insert nothing (legacy layout).
        """
        safe_author = self._compose_author_dir(author_name, author_sec_uid, author_dir_style)

        if mode and group_by_mode:
            save_dir = self.base_path / safe_author / mode
        else:
            save_dir = self.base_path / safe_author

        # Only insert a collection layer for a genuinely non-empty name;
        # a blank/whitespace value must reproduce the legacy layout rather
        # than sanitize into an ``untitled`` folder.
        if collection_dir and str(collection_dir).strip():
            save_dir = save_dir / sanitize_filename(str(collection_dir).strip())

        if folderstyle:
            leaf = folder_name
            if leaf is None and aweme_title and aweme_id:
                safe_title = sanitize_filename(aweme_title)
                date_prefix = f"{download_date}_" if download_date else ""
                leaf = f"{date_prefix}{safe_title}_{aweme_id}"
            if leaf:
                save_dir = save_dir / leaf

        save_dir.mkdir(parents=True, exist_ok=True)
        return save_dir

    @classmethod
    def _compose_author_dir(
        cls,
        author_name: str,
        author_sec_uid: Optional[str],
        style: str,
    ) -> str:
        """Build the sanitized author-level directory name per ``style``.

        Behaviour matrix (kept in lock-step with the ``author_dir`` option
        surfaced in settings UI and ``DEFAULT_CONFIG``):

        - ``nickname``     → ``sanitize_filename(author_name)`` (legacy)
        - ``sec_uid``      → ``sanitize_filename(author_sec_uid)``;
          empty/None → fall back to nickname + ``logger.warning``.
        - ``nickname_uid`` → ``sanitize_filename(f"{author_name}_{author_sec_uid}")``;
          sec_uid missing → fall back to nickname + ``logger.warning``.
        - ``user_sec_uid`` → ``user_<raw sec_uid>`` to reproduce the legacy
          DouYin-Downloader layout. Uses the underscore-preserving
          :meth:`_sanitize_sec_uid_token` (NOT ``sanitize_filename``) so real
          sec_uids containing ``__`` keep their double underscore and match the
          user's existing ``user_MS4...__...`` directories. sec_uid missing →
          fall back to nickname + ``logger.warning``.
        - Unknown style    → fall back to nickname + ``logger.warning``.

        Never raises — a misconfiguration must degrade into a still-working
        download, not a hard failure.
        """
        nickname_dir = sanitize_filename(author_name)
        sec_uid = (author_sec_uid or "").strip()

        if style not in cls._AUTHOR_DIR_STYLES:
            logger.warning(
                "Unknown author_dir style %r, falling back to nickname (%s)",
                style,
                nickname_dir,
            )
            return nickname_dir

        if style == "nickname":
            return nickname_dir

        if style == "sec_uid":
            if not sec_uid:
                logger.warning(
                    "author_dir=sec_uid but sec_uid is missing for %r, falling back to nickname",
                    author_name,
                )
                return nickname_dir
            return sanitize_filename(sec_uid)

        if style == "user_sec_uid":
            if not sec_uid:
                logger.warning(
                    "author_dir=user_sec_uid but sec_uid is missing for %r, "
                    "falling back to nickname",
                    author_name,
                )
                return nickname_dir
            return f"user_{cls._sanitize_sec_uid_token(sec_uid)}"

        # style == "nickname_uid"
        if not sec_uid:
            logger.warning(
                "author_dir=nickname_uid but sec_uid is missing for %r, falling back to nickname",
                author_name,
            )
            return nickname_dir
        return sanitize_filename(f"{author_name}_{sec_uid}")

    @staticmethod
    def _sanitize_sec_uid_token(sec_uid: str) -> str:
        """Minimal sanitize for a sec_uid used as (part of) a directory name.

        Unlike :func:`utils.validators.sanitize_filename`, this preserves
        consecutive underscores and does not truncate — sec_uids are stable
        ``[A-Za-z0-9_-]`` tokens, and the legacy on-disk layout used them raw.
        Only genuinely illegal path characters are replaced, as defense in
        depth.
        """
        return _SEC_UID_ILLEGAL_RE.sub("_", sec_uid).strip("._- ")

    async def download_file(
        self,
        url: str,
        save_path: Path,
        session: aiohttp.ClientSession = None,
        headers: Optional[Dict[str, str]] = None,
        proxy: Optional[str] = None,
        *,
        prefer_response_content_type: bool = False,
        return_saved_path: bool = False,
    ) -> Union[bool, Path]:
        started = time.monotonic()
        loop = asyncio.get_running_loop()
        save_path = Path(save_path)
        controlled_path = self._controlled_path(save_path)
        if controlled_path is None:
            logger.warning("Rejected download path outside the configured output directory")
            return False
        single_flight_path = controlled_path
        if prefer_response_content_type:
            parent, name = os.path.split(controlled_path)
            stem, _suffix = os.path.splitext(name)
            # Gallery callers can propose different suffixes before the HTTP
            # Content-Type resolves both names to the same final file.  Group
            # those candidates by parent + stem so they cannot share a tmp.
            single_flight_path = os.path.join(parent, f"{stem}.__content_type__")
        key = (id(loop), single_flight_path)

        with self._inflight_guard:
            task = self._inflight_downloads.get(key)
            if task is None:
                task = loop.create_task(
                    self._download_file_operation(
                        url,
                        save_path,
                        session=session,
                        headers=headers,
                        proxy=proxy,
                        prefer_response_content_type=prefer_response_content_type,
                    )
                )
                self._inflight_downloads[key] = task
                task.add_done_callback(
                    lambda completed, inflight_key=key: self._forget_inflight(
                        inflight_key, completed
                    )
                )

        try:
            saved_path = await asyncio.shield(task)
            timing_event(
                "http_download_done",
                path=str(saved_path if isinstance(saved_path, Path) else save_path),
                status="complete" if saved_path else "failed",
                elapsed_ms=elapsed_ms(started),
                success=bool(saved_path),
            )
            if not saved_path:
                return False
            return saved_path if return_saved_path else True
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug("Download error for %s: %s", save_path.name, e)
            timing_event(
                "http_download_done",
                path=str(save_path),
                status="exception",
                elapsed_ms=elapsed_ms(started),
                success=False,
                error=str(e)[:1000],
            )
            return False

    @classmethod
    def _forget_inflight(cls, key: tuple[int, str], task: asyncio.Task) -> None:
        with cls._inflight_guard:
            if cls._inflight_downloads.get(key) is task:
                cls._inflight_downloads.pop(key, None)
        try:
            task.exception()
        except (asyncio.CancelledError, asyncio.InvalidStateError):
            pass

    async def _download_file_operation(
        self,
        url: str,
        save_path: Path,
        *,
        session: aiohttp.ClientSession = None,
        headers: Optional[Dict[str, str]] = None,
        proxy: Optional[str] = None,
        prefer_response_content_type: bool = False,
    ) -> Union[bool, Path]:
        should_close = False
        can_resume = not prefer_response_content_type
        if session is None:
            default_headers = headers or {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Referer": "https://www.douyin.com/",
                "Accept": "*/*",
            }
            session = aiohttp.ClientSession(headers=default_headers)
            should_close = True

        if not can_resume:
            self._discard_partial(save_path)

        try:
            # At most one unsafe resume response is retried here.  The retry is
            # deliberately a fresh request without Range, so an outer retry or
            # mirror switch can never append bytes from a rejected entity.
            for request_index in range(2):
                original_url_hash = self._url_sha256(url)
                checkpoint = self._load_checkpoint(save_path) if can_resume else None
                if (
                    checkpoint
                    and checkpoint["original_url_sha256"] != original_url_hash
                ):
                    self._discard_partial(save_path)
                    checkpoint = None
                resume_offset = int(checkpoint["written_length"]) if checkpoint else 0
                request_headers = {
                    key: value
                    for key, value in dict(headers or {}).items()
                    if str(key).casefold() not in {"range", "if-range", "accept-encoding"}
                }
                if can_resume:
                    request_headers["Accept-Encoding"] = "identity"
                if checkpoint:
                    request_headers["Range"] = f"bytes={resume_offset}-"
                    request_headers["If-Range"] = self._checkpoint_validator(checkpoint)

                retry_full = False
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=300),
                    headers=request_headers or None,
                    proxy=proxy or None,
                ) as response:
                    final_url_hash = self._url_sha256(self._response_url(response, url))

                    if response.status == 200:
                        response_validator = self._response_validator(response.headers)
                        response_checkpoint = self._build_checkpoint(
                            response_validator,
                            expected_length=self._response_content_length(response),
                            original_url_sha256=original_url_hash,
                            final_url_sha256=final_url_hash,
                            content_type=self._content_type(response.headers),
                        )
                        if not can_resume:
                            response_checkpoint = None
                        try:
                            return await self._persist_stream(
                                response.content.iter_chunked(_DOWNLOAD_CHUNK_BYTES),
                                save_path,
                                self._response_content_length(response),
                                response.headers,
                                prefer_response_content_type=prefer_response_content_type,
                                initial_size=0,
                                checkpoint=response_checkpoint,
                                keep_partial=can_resume and response_checkpoint is not None,
                            )
                        except _UnsafePartialResponse:
                            self._discard_partial(save_path)
                            return False

                    if response.status == 206:
                        range_parts = self._content_range_parts(response.headers)
                        invalid_reason = self._validate_partial_response(
                            checkpoint,
                            range_parts,
                            response.headers,
                            original_url_hash,
                            final_url_hash,
                        )
                        if invalid_reason:
                            logger.warning(
                                "Rejected unsafe range response for %s: %s",
                                save_path.name,
                                invalid_reason,
                            )
                            retry_full = checkpoint is not None and request_index == 0
                        else:
                            range_start, range_end, expected_size = range_parts
                            validator = (
                                self._checkpoint_validator_pair(checkpoint)
                                if checkpoint
                                else self._response_validator(response.headers)
                            )
                            response_checkpoint = self._build_checkpoint(
                                validator,
                                expected_length=expected_size,
                                original_url_sha256=original_url_hash,
                                final_url_sha256=final_url_hash,
                                content_type=(
                                    self._content_type(response.headers)
                                    or (checkpoint or {}).get("content_type", "")
                                ),
                            )
                            if not can_resume:
                                response_checkpoint = None
                            try:
                                return await self._persist_stream(
                                    response.content.iter_chunked(_DOWNLOAD_CHUNK_BYTES),
                                    save_path,
                                    expected_size,
                                    response.headers,
                                    prefer_response_content_type=prefer_response_content_type,
                                    initial_size=range_start,
                                    expected_body_length=range_end - range_start + 1,
                                    checkpoint=response_checkpoint,
                                    keep_partial=can_resume and response_checkpoint is not None,
                                )
                            except _UnsafePartialResponse as exc:
                                logger.warning(
                                    "Rejected overflowing range response for %s: %s",
                                    save_path.name,
                                    exc,
                                )
                                retry_full = checkpoint is not None and request_index == 0

                    elif response.status == 416 and checkpoint:
                        expected_size = self._unsatisfied_content_range_size(response.headers)
                        expected_checkpoint_size = checkpoint.get("expected_length")
                        validator_matches = self._checkpoint_matches_response(
                            checkpoint,
                            response.headers,
                            original_url_hash,
                            final_url_hash,
                            check_content_type=False,
                        )
                        if (
                            validator_matches
                            and expected_size == resume_offset
                            and (
                                expected_checkpoint_size is None
                                or expected_checkpoint_size == expected_size
                            )
                        ):
                            tmp_path, meta_path = self._partial_paths(save_path)
                            os.replace(str(tmp_path), str(save_path))
                            try:
                                meta_path.unlink(missing_ok=True)
                            except OSError as exc:
                                logger.warning(
                                    "Could not remove completed checkpoint %s: %s",
                                    meta_path.name,
                                    exc,
                                )
                            return save_path
                        retry_full = request_index == 0

                    elif response.status == 403:
                        # The httpx fallback is a new full request.  Never let it
                        # inherit an aiohttp checkpoint implicitly.
                        self._discard_partial(save_path)
                        return await self._download_via_httpx(
                            url,
                            save_path,
                            headers=headers,
                            proxy=proxy,
                            prefer_response_content_type=prefer_response_content_type,
                            return_saved_path=True,
                        )
                    else:
                        logger.debug(
                            "Download failed for %s, status=%s", save_path.name, response.status
                        )
                        return False

                if retry_full:
                    self._discard_partial(save_path)
                    continue

                self._discard_partial(save_path)
                return False
            return False
        except Exception:
            if not can_resume or self._load_checkpoint(save_path) is None:
                self._discard_partial(save_path)
            raise
        finally:
            if should_close:
                await session.close()

    @staticmethod
    def _partial_paths(save_path: Path) -> tuple[Path, Path]:
        tmp_path = save_path.with_suffix(save_path.suffix + ".tmp")
        return tmp_path, Path(str(tmp_path) + ".meta.json")

    def _controlled_path(self, save_path: Path) -> Optional[str]:
        base = os.path.normcase(os.path.abspath(os.fspath(self.base_path)))
        target = os.path.normcase(os.path.abspath(os.fspath(save_path)))
        if target == base or os.path.isdir(target):
            return None
        try:
            if os.path.commonpath((base, target)) != base:
                return None
        except ValueError:
            # Different Windows drives or UNC shares cannot share a controlled
            # output root.
            return None
        try:
            resolved_base = os.path.normcase(os.path.realpath(base))
            resolved_target = os.path.normcase(os.path.realpath(target))
            if (
                resolved_target == resolved_base
                or os.path.commonpath((resolved_base, resolved_target)) != resolved_base
            ):
                return None
        except ValueError:
            return None
        return resolved_target

    @classmethod
    def _discard_partial(cls, save_path: Path) -> None:
        tmp_path, meta_path = cls._partial_paths(save_path)
        errors = []
        # Remove trust before bytes.  A crash between the two leaves a legacy
        # tmp that the next call must discard, never a trusted stale checkpoint.
        for path in (meta_path, tmp_path):
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                errors.append((path, exc))
        if errors:
            path, exc = errors[0]
            raise OSError(f"Could not remove unsafe partial {path.name}: {exc}") from exc

    @classmethod
    def _load_checkpoint(cls, save_path: Path) -> Optional[dict[str, Any]]:
        tmp_path, meta_path = cls._partial_paths(save_path)
        try:
            tmp_size = tmp_path.stat().st_size
            raw = meta_path.read_text(encoding="utf-8")
            metadata = json.loads(raw)
        except (OSError, UnicodeError, json.JSONDecodeError):
            cls._discard_partial(save_path)
            return None

        if not cls._valid_checkpoint(metadata, tmp_size):
            cls._discard_partial(save_path)
            return None
        return metadata

    @classmethod
    def _valid_checkpoint(cls, metadata: Any, tmp_size: int) -> bool:
        if not isinstance(metadata, dict):
            return False
        validator_keys = {key for key in ("etag", "last_modified") if key in metadata}
        if len(validator_keys) != 1:
            return False
        if set(metadata) != _PARTIAL_METADATA_KEYS | validator_keys:
            return False
        if metadata.get("schema") != _PARTIAL_METADATA_SCHEMA:
            return False
        written_length = metadata.get("written_length")
        expected_length = metadata.get("expected_length")
        if (
            not isinstance(written_length, int)
            or isinstance(written_length, bool)
            or written_length <= 0
            or written_length != tmp_size
        ):
            return False
        if expected_length is not None and (
            not isinstance(expected_length, int)
            or isinstance(expected_length, bool)
            or expected_length < written_length
        ):
            return False
        for key in ("original_url_sha256", "final_url_sha256"):
            if not isinstance(metadata.get(key), str) or not _SHA256_RE.fullmatch(metadata[key]):
                return False
        content_type = metadata.get("content_type")
        if (
            not isinstance(content_type, str)
            or len(content_type) > 512
            or "\r" in content_type
            or "\n" in content_type
        ):
            return False
        if "etag" in metadata:
            return cls._strong_etag(metadata["etag"]) is not None
        return cls._canonical_http_date(metadata.get("last_modified")) is not None

    @staticmethod
    def _url_sha256(url: str) -> str:
        return hashlib.sha256(str(url).encode("utf-8", errors="surrogatepass")).hexdigest()

    @staticmethod
    def _response_url(response: Any, fallback: str) -> str:
        value = getattr(response, "url", None)
        if value is None:
            return fallback
        rendered = str(value)
        if not rendered or rendered.startswith("<"):
            return fallback
        return rendered

    @staticmethod
    def _header(response_headers: Any, name: str) -> Optional[str]:
        if not response_headers:
            return None
        value = response_headers.get(name)
        if value is not None:
            return str(value).strip()
        target = name.casefold()
        try:
            for key, candidate in response_headers.items():
                if str(key).casefold() == target:
                    return str(candidate).strip()
        except (AttributeError, TypeError):
            return None
        return None

    @classmethod
    def _strong_etag(cls, value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        candidate = value.strip()
        if candidate[:2].casefold() == "w/":
            return None
        return candidate if _STRONG_ETAG_RE.fullmatch(candidate) else None

    @staticmethod
    def _canonical_http_date(value: Any) -> Optional[str]:
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = parsedate_to_datetime(value.strip())
        except (TypeError, ValueError, OverflowError):
            return None
        if parsed is None or parsed.tzinfo is None:
            return None
        try:
            return format_datetime(parsed.astimezone(timezone.utc), usegmt=True)
        except (ValueError, OverflowError):
            return None

    @classmethod
    def _response_validator(cls, response_headers: Any) -> Optional[tuple[str, str]]:
        etag = cls._strong_etag(cls._header(response_headers, "ETag"))
        if etag is not None:
            return "etag", etag
        last_modified = cls._canonical_http_date(
            cls._header(response_headers, "Last-Modified")
        )
        if last_modified is not None:
            return "last_modified", last_modified
        return None

    @staticmethod
    def _checkpoint_validator_pair(checkpoint: dict[str, Any]) -> tuple[str, str]:
        if "etag" in checkpoint:
            return "etag", checkpoint["etag"]
        return "last_modified", checkpoint["last_modified"]

    @classmethod
    def _checkpoint_validator(cls, checkpoint: dict[str, Any]) -> str:
        return cls._checkpoint_validator_pair(checkpoint)[1]

    @classmethod
    def _build_checkpoint(
        cls,
        validator: Optional[tuple[str, str]],
        *,
        expected_length: Optional[int],
        original_url_sha256: str,
        final_url_sha256: str,
        content_type: str,
    ) -> Optional[dict[str, Any]]:
        if validator is None:
            return None
        key, value = validator
        return {
            "schema": _PARTIAL_METADATA_SCHEMA,
            "written_length": 0,
            "expected_length": expected_length,
            key: value,
            "original_url_sha256": original_url_sha256,
            "final_url_sha256": final_url_sha256,
            "content_type": content_type,
        }

    @classmethod
    def _content_type(cls, response_headers: Any) -> str:
        value = cls._header(response_headers, "Content-Type") or ""
        if len(value) > 512 or "\r" in value or "\n" in value:
            return ""
        return value

    @classmethod
    def _checkpoint_matches_response(
        cls,
        checkpoint: dict[str, Any],
        response_headers: Any,
        original_url_sha256: str,
        final_url_sha256: str,
        *,
        check_content_type: bool = True,
    ) -> bool:
        if checkpoint["original_url_sha256"] != original_url_sha256:
            return False
        validator_key, validator_value = cls._checkpoint_validator_pair(checkpoint)
        if validator_key == "etag":
            if cls._strong_etag(cls._header(response_headers, "ETag")) != validator_value:
                return False
        else:
            response_date = cls._canonical_http_date(
                cls._header(response_headers, "Last-Modified")
            )
            if response_date != validator_value:
                return False
            # Dates are only a fallback validator.  They cannot establish
            # identity after a redirect target changes.
            if checkpoint["final_url_sha256"] != final_url_sha256:
                return False
        if check_content_type and checkpoint.get("content_type"):
            if cls._content_type(response_headers) != checkpoint["content_type"]:
                return False
        return True

    @classmethod
    def _validate_partial_response(
        cls,
        checkpoint: Optional[dict[str, Any]],
        range_parts: Optional[tuple[int, int, int]],
        response_headers: Any,
        original_url_sha256: str,
        final_url_sha256: str,
    ) -> str:
        if range_parts is None:
            return "missing or malformed Content-Range"
        range_start, range_end, expected_size = range_parts
        response_length = cls._header(response_headers, "Content-Length")
        if response_length is not None:
            if not response_length.isdigit():
                return "invalid Content-Length"
            if int(response_length) != range_end - range_start + 1:
                return "Content-Length does not match Content-Range"
        if checkpoint is None:
            if range_start != 0:
                return "unsolicited partial response starts after byte zero"
            if cls._response_validator(response_headers) is None:
                return "partial response has no reusable entity validator"
            return ""
        if range_start != checkpoint["written_length"]:
            return "range offset does not match checkpoint"
        expected_checkpoint_size = checkpoint.get("expected_length")
        if expected_checkpoint_size is not None and expected_checkpoint_size != expected_size:
            return "entity total does not match checkpoint"
        if not cls._checkpoint_matches_response(
            checkpoint,
            response_headers,
            original_url_sha256,
            final_url_sha256,
        ):
            return "entity validator or identity does not match checkpoint"
        return ""

    @classmethod
    def _response_content_length(cls, response: Any) -> Optional[int]:
        header_value = cls._header(getattr(response, "headers", None), "Content-Length")
        if header_value is not None:
            return int(header_value) if header_value.isdigit() else None
        value = getattr(response, "content_length", None)
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

    @classmethod
    async def _write_checkpoint(cls, meta_path: Path, metadata: dict[str, Any]) -> None:
        scratch_path = meta_path.with_name(
            f"{meta_path.name}.{os.getpid()}.{uuid.uuid4().hex}.write"
        )
        payload = json.dumps(metadata, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
        try:
            async with aiofiles.open(scratch_path, "w", encoding="utf-8", newline="\n") as handle:
                await handle.write(payload)
                await handle.flush()
            os.replace(str(scratch_path), str(meta_path))
        finally:
            try:
                scratch_path.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _response_host(response) -> str:
        return str(getattr(getattr(response, "url", None), "host", ""))

    @staticmethod
    def _complete_content_range_size(response_headers) -> Optional[int]:
        parts = FileManager._content_range_parts(response_headers)
        if parts is None:
            return None
        start, end, total = parts
        if start != 0 or end + 1 != total:
            return None
        return total

    @staticmethod
    def _content_range_parts(response_headers) -> Optional[tuple[int, int, int]]:
        if not response_headers:
            return None
        content_range = response_headers.get("Content-Range")
        if not content_range:
            return None
        match = re.match(r"^bytes (\d+)-(\d+)/(\d+)$", content_range.strip())
        if not match:
            return None
        start, end, total = (int(part) for part in match.groups())
        if start > end or end >= total:
            return None
        return start, end, total

    @staticmethod
    def _unsatisfied_content_range_size(response_headers) -> Optional[int]:
        if not response_headers:
            return None
        content_range = response_headers.get("Content-Range")
        if not content_range:
            return None
        match = re.match(r"^bytes \*/(\d+)$", content_range.strip())
        return int(match.group(1)) if match else None

    async def _persist_stream(
        self,
        chunk_iter,
        save_path: Path,
        expected_size: Optional[int],
        response_headers,
        *,
        prefer_response_content_type: bool = False,
        initial_size: int = 0,
        expected_body_length: Optional[int] = None,
        checkpoint: Optional[dict[str, Any]] = None,
        keep_partial: bool = False,
    ) -> Union[bool, Path]:
        """Stream ``chunk_iter`` to a temp file and atomically rename it.

        Shared by the aiohttp and httpx download paths so the content-type
        resolution, size-mismatch guard, and atomic rename stay identical.
        """
        final_path = self._resolve_save_path_from_content_type(
            save_path,
            response_headers,
            prefer_response_content_type=prefer_response_content_type,
        )
        final_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path, meta_path = self._partial_paths(final_path)
        if initial_size:
            try:
                actual_size = tmp_path.stat().st_size
            except OSError as exc:
                raise _UnsafePartialResponse("checkpoint bytes disappeared before append") from exc
            if actual_size != initial_size:
                self._discard_partial(final_path)
                raise _UnsafePartialResponse("checkpoint length changed before append")
        else:
            self._discard_partial(final_path)

        written = initial_size
        body_written = 0
        mode = "ab" if initial_size else "wb"
        metadata = dict(checkpoint) if checkpoint is not None else None
        try:
            async with aiofiles.open(tmp_path, mode) as f:
                async for chunk in chunk_iter:
                    if not chunk:
                        continue
                    chunk_size = len(chunk)
                    if (
                        expected_body_length is not None
                        and body_written + chunk_size > expected_body_length
                    ):
                        raise _UnsafePartialResponse(
                            "response body exceeds its declared byte range"
                        )
                    if expected_size is not None and written + chunk_size > expected_size:
                        raise _UnsafePartialResponse("response body exceeds entity total")
                    await f.write(chunk)
                    await f.flush()
                    written += chunk_size
                    body_written += chunk_size
                    if metadata is not None:
                        metadata["written_length"] = written
                        await self._write_checkpoint(meta_path, metadata)
        except BaseException:
            if keep_partial and metadata is not None and written > 0:
                metadata["written_length"] = written
                try:
                    await self._write_checkpoint(meta_path, metadata)
                except Exception:
                    self._discard_partial(final_path)
            else:
                self._discard_partial(final_path)
            raise

        if expected_body_length is not None and body_written != expected_body_length:
            logger.warning(
                "Range body mismatch for %s: expected %d, got %d",
                final_path.name,
                expected_body_length,
                body_written,
            )
            if not keep_partial or metadata is None or written <= 0:
                self._discard_partial(final_path)
            return False

        if expected_size is not None and written != expected_size:
            logger.warning(
                "Size mismatch for %s: expected %d, got %d",
                final_path.name,
                expected_size,
                written,
            )
            if not keep_partial or metadata is None or written <= 0:
                self._discard_partial(final_path)
            return False

        os.replace(str(tmp_path), str(final_path))
        try:
            meta_path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Could not remove completed checkpoint %s: %s", meta_path.name, exc)
        return final_path

    async def _download_via_httpx(
        self,
        url: str,
        save_path: Path,
        *,
        headers: Optional[Dict[str, str]] = None,
        proxy: Optional[str] = None,
        prefer_response_content_type: bool = False,
        return_saved_path: bool = False,
    ) -> Union[bool, Path]:
        """Download an asset via httpx, whose TLS fingerprint the Douyin image
        CDN accepts when aiohttp's is rejected (403). Mirrors aiohttp's
        redirect-following and streaming-to-disk behaviour."""
        started = time.monotonic()
        request_headers = {
            key: value
            for key, value in dict(headers or {}).items()
            if str(key).casefold() not in {"range", "if-range", "accept-encoding"}
        }
        request_headers["Accept-Encoding"] = "identity"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(300.0),
                proxy=proxy or None,
                follow_redirects=True,
            ) as client:
                async with client.stream("GET", url, headers=request_headers) as response:
                    if response.status_code != 200:
                        logger.debug(
                            "httpx fallback failed for %s, status=%s",
                            save_path.name,
                            response.status_code,
                        )
                        timing_event(
                            "httpx_download_done",
                            path=str(save_path),
                            host=self._response_host(response),
                            status=response.status_code,
                            elapsed_ms=elapsed_ms(started),
                            success=False,
                        )
                        return False
                    # httpx auto-decompresses; Content-Length is the *compressed*
                    # size, so only trust it when the body isn't encoded.
                    expected_size: Optional[int] = None
                    if not response.headers.get("Content-Encoding"):
                        content_length = response.headers.get("Content-Length")
                        if content_length is not None and content_length.isdigit():
                            expected_size = int(content_length)
                    response_checkpoint = self._build_checkpoint(
                        self._response_validator(response.headers),
                        expected_length=expected_size,
                        original_url_sha256=self._url_sha256(url),
                        final_url_sha256=self._url_sha256(self._response_url(response, url)),
                        content_type=self._content_type(response.headers),
                    )
                    result = await self._persist_stream(
                        response.aiter_bytes(),
                        save_path,
                        expected_size,
                        response.headers,
                        prefer_response_content_type=prefer_response_content_type,
                        checkpoint=response_checkpoint,
                        keep_partial=(
                            not prefer_response_content_type and response_checkpoint is not None
                        ),
                    )
                    timing_event(
                        "httpx_download_done",
                        path=str(result if isinstance(result, Path) else save_path),
                        host=self._response_host(response),
                        status=response.status_code,
                        elapsed_ms=elapsed_ms(started),
                        success=bool(result),
                    )
                    if not result:
                        return False
                    return result if return_saved_path else True
        except Exception as e:
            logger.debug("httpx fallback error for %s: %s", save_path.name, e)
            timing_event(
                "httpx_download_done",
                path=str(save_path),
                status="exception",
                elapsed_ms=elapsed_ms(started),
                success=False,
                error=str(e)[:1000],
            )
            return False

    @classmethod
    def _resolve_save_path_from_content_type(
        cls,
        save_path: Path,
        response_headers,
        *,
        prefer_response_content_type: bool = False,
    ) -> Path:
        if not prefer_response_content_type:
            return save_path

        content_type = response_headers.get("Content-Type", "") if response_headers else ""
        normalized_type = content_type.split(";", 1)[0].strip().lower()
        suffix = cls._IMAGE_CONTENT_TYPE_SUFFIXES.get(normalized_type)
        if not suffix:
            return save_path
        return save_path.with_suffix(suffix)

    def file_exists(self, file_path: Path) -> bool:
        try:
            return file_path.exists() and file_path.stat().st_size > 0
        except OSError:
            return False

    def get_file_size(self, file_path: Path) -> int:
        try:
            return file_path.stat().st_size if self.file_exists(file_path) else 0
        except OSError:
            return 0
