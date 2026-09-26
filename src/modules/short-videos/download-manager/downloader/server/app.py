"""FastAPI REST 服务入口。

HTTP 层薄封装：
- 接收 URL，创建 job，返回 job_id
- 实际下载委托给 cli.main.download_url 的简化复用

fastapi/uvicorn 是**可选**依赖。若未安装，导入本模块会 ImportError。
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from auth import CookieManager
from config import ConfigLoader
from control import QueueManager, RateLimiter, RetryHandler
from core import DouyinAPIClient, DownloaderFactory, LoginRequiredError, URLParser
from server.jobs import JobManager, ServerProgressReporter
from storage import FileManager
from utils.logger import setup_logger
from utils.timing import elapsed_ms, timing_event
from utils.validators import is_short_url, normalize_short_url

logger = setup_logger("REST")


class DownloadRequest(BaseModel):
    url: str


class DetailProbeRequest(BaseModel):
    aweme_id: str


class JobResponse(BaseModel):
    job_id: str
    status: str
    url: str


class _ServerDeps:
    """跨请求复用的重量级依赖。

    REST 服务在进程生命周期内只需要一份 FileManager / RateLimiter / RetryHandler /
    QueueManager / CookieManager；每个请求重新构造既浪费又会触发文件系统 mkdir。
    DouyinAPIClient 由于持有 aiohttp.ClientSession，依旧按请求创建，避免跨请求泄漏
    连接状态或触发 "Session is closed" 错误。
    """

    def __init__(self, config: ConfigLoader):
        self.config = config
        # Resolve the cookie file path relative to the config file's directory
        # so the sidecar can find it regardless of its working directory (which
        # on macOS is often '/' when launched by Electron).
        if config.config_path:
            from pathlib import Path

            cookie_file = str(Path(config.config_path).resolve().parent / ".cookies.json")
        else:
            cookie_file = ".cookies.json"
        self.cookie_manager = CookieManager(cookie_file=cookie_file)
        # Load cookies from the config (env var / YAML cookie key) first, then
        # fall back to whatever is already on disk in the cookie file. This
        # ensures that cookies saved by a previous session are picked up on
        # restart even when the config doesn't embed them inline.
        initial_cookies = config.get_cookies()
        if initial_cookies:
            self.cookie_manager.set_cookies(initial_cookies)
        else:
            # Trigger a load from disk so get_cookies() returns the persisted
            # session without requiring a fresh login on every app restart.
            self.cookie_manager.get_cookies()
        self.file_manager = FileManager(config.get("path"))
        self.rate_limiter = RateLimiter(max_per_second=float(config.get("rate_limit", 2) or 2))
        self.retry_handler = RetryHandler(max_retries=int(config.get("retry_times", 3) or 3))
        self.queue_manager = QueueManager(max_workers=int(config.get("thread", 5) or 5))


async def _execute_download(
    url: str,
    deps: "_ServerDeps",
    progress_reporter: Any = None,
) -> Dict[str, Any]:
    """简化版 download_url：只负责执行并返回成功/失败计数。

    有意不复用 cli.main.download_url —— 后者绑定了 progress_display 的 rich 状态。
    API client 仍按请求创建（aiohttp session 不跨请求复用）；其余重量级依赖从
    _ServerDeps 共享。
    """
    started = time.monotonic()
    original_url = url
    timing_event("sidecar_execute_begin", url=original_url)
    # proxy 与 cli.main.download_url 对齐:API 请求、短链解析和 CDN 媒体
    # 下载(downloader_base 读 api_client.proxy)统一走配置代理。
    try:
        async with DouyinAPIClient(
            deps.cookie_manager.get_cookies(),
            proxy=deps.config.get("proxy"),
        ) as api_client:
            if is_short_url(url):
                resolve_started = time.monotonic()
                resolved = await api_client.resolve_short_url(normalize_short_url(url))
                timing_event(
                    "sidecar_short_resolve",
                    url=original_url,
                    resolved=resolved or "",
                    elapsed_ms=elapsed_ms(resolve_started),
                )
                if not resolved:
                    raise RuntimeError(f"Failed to resolve short URL: {url}")
                url = resolved

            parsed = URLParser.parse(url)
            if not parsed:
                raise RuntimeError(f"Unsupported URL: {url}")
            timing_event(
                "sidecar_url_parsed",
                url=url,
                url_type=parsed.get("type"),
                aweme_id=parsed.get("aweme_id"),
                sec_uid=parsed.get("sec_uid"),
            )

            downloader = DownloaderFactory.create(
                parsed["type"],
                deps.config,
                api_client,
                deps.file_manager,
                deps.cookie_manager,
                None,  # database 不在 server 场景里启用，避免单例冲突
                deps.rate_limiter,
                deps.retry_handler,
                deps.queue_manager,
                progress_reporter=progress_reporter,
            )
            if downloader is None:
                raise RuntimeError(f"No downloader for url_type={parsed['type']}")

            result = await downloader.download(parsed)
            completed_records = list(getattr(downloader, "completed_manifest_records", []))
            payload = {
                "total": result.total,
                "success": result.success,
                "failed": result.failed,
                "skipped": result.skipped,
                "error": result.error_summary(),
                # The manager submits one work URL per job. Keep a bounded result
                # for standalone batch callers so the polling response cannot grow
                # without limit.
                "records": completed_records[-100:],
                "records_truncated": max(0, len(completed_records) - 100),
            }
            timing_event(
                "sidecar_execute_done",
                url=original_url,
                resolved_url=url,
                elapsed_ms=elapsed_ms(started),
                total=result.total,
                success=result.success,
                failed=result.failed,
                skipped=result.skipped,
                error=result.error_summary(),
                records=len(completed_records),
            )
            return payload
    except Exception as exc:
        timing_event(
            "sidecar_execute_error",
            url=original_url,
            elapsed_ms=elapsed_ms(started),
            error=f"{type(exc).__name__}: {exc}"[:1000],
        )
        raise


DETAIL_PROBE_ENDPOINT = "/aweme/v1/web/aweme/detail/"


def _probe_diagnostic(
    *,
    kind: str,
    http_status: int | None,
    error: str = "",
    filter_reason: str = "",
) -> Dict[str, str]:
    """Turn a probe result into an operator-facing reason code.

    Rule names mirror the upstream response classifier where the same signal
    exists. The label and action stay localised for the download-manager UI.
    """

    normalized_kind = str(kind or "").strip().lower()
    normalized_error = " ".join(str(error or "").split())
    lowered = normalized_error.lower()
    normalized_filter = str(filter_reason or "").strip()

    signature_markers = (
        (
            "uifid not found",
            "访客身份缺失",
            "Cookie 中缺少签名所需的 UIFID；请重新获取 Cookie，切换 VPN 不能补齐它。",
        ),
        (
            "signature not found",
            "签名参数缺失",
            "请求没有携带完整的 WebSign；需要更新签名实现，而不是更换 Cookie。",
        ),
        (
            "sign invalid",
            "签名校验失败",
            "签名已被识别但内容不匹配；检查算法、User-Agent 与已编码 URL 是否保持一致。",
        ),
        (
            "sign expired",
            "签名已过期",
            "检查系统时间，并重新生成签名后再测试。",
        ),
    )
    for marker, label, action in signature_markers:
        if marker in lowered:
            return {
                "outcome": "risk_control",
                "rule": "signature.refused",
                "label": label,
                "detail": marker,
                "action": action,
            }

    if normalized_kind == "success":
        return {
            "outcome": "ok",
            "rule": "default.ok",
            "label": "接口正常",
            "detail": "作品详情载荷完整",
            "action": "可以继续下载。",
        }
    if normalized_kind == "login_required":
        return {
            "outcome": "business_error",
            "rule": "identity.login_required",
            "label": "Cookie 登录失效",
            "detail": "平台要求重新登录",
            "action": "在配置页重新登录或导入最新 Cookie，然后重新测试。",
        }
    if normalized_kind == "network":
        return {
            "outcome": "network_error",
            "rule": "network.exception",
            "label": "网络连接失败",
            "detail": normalized_error or "没有收到平台响应",
            "action": "检查 VPN、代理、DNS 和本机网络后重新测试。",
        }
    if normalized_filter:
        if normalized_filter == "status_self_see":
            label = "作品仅自己可见"
            action = "这是作品权限结果，不要更换签名或反复重试。"
        elif normalized_filter == "core_dep":
            label = "作品不存在"
            action = "核对作品 ID；这是业务结果，不会触发下载保护。"
        else:
            label = "平台说明作品不可用"
            action = "根据原始 filter_reason 判断内容状态，不要当作网络故障。"
        return {
            "outcome": "business_error",
            "rule": "payload.explained",
            "label": label,
            "detail": f"filter_reason={normalized_filter}",
            "action": action,
        }
    if http_status in {401, 403, 405, 412, 429, 444}:
        label = "请求频率受限" if http_status == 429 else "平台拒绝当前请求"
        action = (
            "等待冷却后再测试，并适当降低请求频率。"
            if http_status == 429
            else "检查当前出口、Cookie 和请求指纹；保留原始响应用于继续诊断。"
        )
        return {
            "outcome": "risk_control",
            "rule": "http.risk_status",
            "label": label,
            "detail": f"http {http_status}",
            "action": action,
        }
    if normalized_kind in {"anti_bot", "detail_missing"} and http_status == 200:
        return {
            "outcome": "risk_control",
            "rule": "payload.withheld",
            "label": "详情载荷被隐藏",
            "detail": "empty aweme_detail",
            "action": "平台响应正常但未给详情；检查 Cookie、出口与浏览器指纹一致性。",
        }
    if http_status is not None and http_status >= 500:
        return {
            "outcome": "network_error",
            "rule": "http.network_status",
            "label": "上游服务暂不可用",
            "detail": f"http {http_status}",
            "action": "稍后重新测试；若持续出现，再检查代理出口。",
        }
    return {
        "outcome": "business_error",
        "rule": "probe.unclassified",
        "label": "接口返回异常",
        "detail": normalized_error or normalized_kind or "unknown",
        "action": "查看原始响应，并按 HTTP 状态和作品状态继续诊断。",
    }


async def _probe_aweme_detail(aweme_id: str, deps: "_ServerDeps") -> Dict[str, Any]:
    """Probe the exact signed detail request used before a work is downloaded.

    The probe performs one request and never creates a download job or writes
    downloader history.  A received HTTP response is reported separately from
    download readiness so an anti-bot 403 is not mistaken for a network outage.
    """

    started = time.monotonic()
    try:
        async with DouyinAPIClient(
            deps.cookie_manager.get_cookies(),
            proxy=deps.config.get("proxy"),
        ) as api_client:
            params = await api_client._default_query()
            params.update({"aweme_id": aweme_id, "aid": "6383"})
            data = await api_client._request_json(
                DETAIL_PROBE_ENDPOINT,
                params,
                suppress_error=True,
                max_retries=1,
            )
            detail = data.get("aweme_detail") if isinstance(data, dict) else None
            error = str(api_client.last_error or "").strip()
            kind = str(api_client.last_error_kind or "").strip()
    except LoginRequiredError as exc:
        error = str(exc)
        return {
            "ok": True,
            "endpoint": DETAIL_PROBE_ENDPOINT,
            "aweme_id": aweme_id,
            "transport_ok": True,
            "download_ready": False,
            "http_status": 200,
            "kind": "login_required",
            "message": "已连接抖音，但当前 Cookie 需要重新登录",
            "error": error,
            "diagnostic": _probe_diagnostic(
                kind="login_required",
                http_status=200,
                error=error,
            ),
            "elapsed_ms": elapsed_ms(started),
        }
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"[:500]
        return {
            "ok": True,
            "endpoint": DETAIL_PROBE_ENDPOINT,
            "aweme_id": aweme_id,
            "transport_ok": False,
            "download_ready": False,
            "http_status": None,
            "kind": "network",
            "message": "未能连接抖音详情接口",
            "error": error,
            "diagnostic": _probe_diagnostic(
                kind="network",
                http_status=None,
                error=error,
            ),
            "elapsed_ms": elapsed_ms(started),
        }

    http_status = 200 if not error else None
    if error.startswith("HTTP "):
        raw_status = error.split(":", 1)[0].removeprefix("HTTP ").strip()
        http_status = int(raw_status) if raw_status.isdigit() else None

    if isinstance(detail, dict) and detail:
        author = detail.get("author") if isinstance(detail.get("author"), dict) else {}
        return {
            "ok": True,
            "endpoint": DETAIL_PROBE_ENDPOINT,
            "aweme_id": aweme_id,
            "transport_ok": True,
            "download_ready": True,
            "http_status": 200,
            "kind": "success",
            "message": "作品详情接口测试通过，可以继续下载",
            "title": str(detail.get("desc") or "")[:120],
            "author": str(author.get("nickname") or "")[:80],
            "error": "",
            "diagnostic": _probe_diagnostic(
                kind="success",
                http_status=200,
            ),
            "elapsed_ms": elapsed_ms(started),
        }

    filter_detail = data.get("filter_detail") if isinstance(data, dict) else None
    filter_reason = (
        str(filter_detail.get("filter_reason") or "").strip()
        if isinstance(filter_detail, dict)
        else ""
    )
    if filter_reason:
        kind = "content_unavailable" if filter_reason == "status_self_see" else "filtered"
        error = f"filter_reason={filter_reason}"

    transport_ok = http_status is not None
    if kind == "anti_bot" and http_status == 403:
        message = "已连接抖音，但详情接口仍被平台保护拒绝"
    elif transport_ok:
        message = "详情接口已响应，但没有返回可下载的作品信息"
    else:
        message = "未能连接抖音详情接口"
    return {
        "ok": True,
        "endpoint": DETAIL_PROBE_ENDPOINT,
        "aweme_id": aweme_id,
        "transport_ok": transport_ok,
        "download_ready": False,
        "http_status": http_status,
        "kind": kind or "detail_missing",
        "message": message,
        "error": error or "详情接口未返回作品信息",
        "diagnostic": _probe_diagnostic(
            kind=kind or "detail_missing",
            http_status=http_status,
            error=error or "详情接口未返回作品信息",
            filter_reason=filter_reason,
        ),
        "elapsed_ms": elapsed_ms(started),
    }


def build_app(config: ConfigLoader) -> FastAPI:
    deps = _ServerDeps(config)

    async def executor(url: str, progress_reporter: Any = None) -> Dict[str, Any]:
        return await _execute_download(url, deps, progress_reporter)

    server_cfg = config.get("server") or {}
    if not isinstance(server_cfg, dict):
        server_cfg = {}
    manager = JobManager(
        executor=executor,
        max_concurrency=int(config.get("thread", 2) or 2),
        max_jobs=int(server_cfg.get("max_jobs") or JobManager.DEFAULT_MAX_JOBS),
        job_ttl_seconds=float(
            server_cfg.get("job_ttl_seconds") or JobManager.DEFAULT_JOB_TTL_SECONDS
        ),
        progress_reporter_factory=ServerProgressReporter,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await manager.shutdown()

    app = FastAPI(
        title="Douyin Downloader API",
        version="1.0",
        description="REST API for dispatching Douyin download jobs.",
        lifespan=lifespan,
    )
    app.state.job_manager = manager
    app.state.deps = deps
    app.state.probe_aweme_detail = lambda aweme_id: _probe_aweme_detail(aweme_id, deps)

    @app.get("/api/v1/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/probe/detail")
    async def probe_detail(req: DetailProbeRequest) -> Dict[str, Any]:
        aweme_id = str(req.aweme_id or "").strip()
        if not (8 <= len(aweme_id) <= 32 and aweme_id.isdigit()):
            raise HTTPException(status_code=400, detail="valid aweme_id is required")
        return await app.state.probe_aweme_detail(aweme_id)

    @app.post("/api/v1/download", response_model=JobResponse)
    async def create_job(req: DownloadRequest) -> JobResponse:
        if not req.url:
            raise HTTPException(status_code=400, detail="url is required")
        job = await manager.submit(req.url)
        return JobResponse(job_id=job.job_id, status=job.status, url=job.url)

    @app.get("/api/v1/jobs/{job_id}")
    async def get_job(job_id: str) -> Dict[str, Any]:
        job = await manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job.to_dict()

    @app.get("/api/v1/jobs")
    async def list_jobs() -> Dict[str, List[Dict[str, Any]]]:
        jobs = await manager.list_jobs()
        return {"jobs": [j.to_dict() for j in jobs]}

    return app


async def run_server(config: ConfigLoader, *, host: str, port: int) -> None:
    import uvicorn

    app = build_app(config)
    uv_config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(uv_config)
    await server.serve()
