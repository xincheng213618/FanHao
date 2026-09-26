"""FastAPI 服务测试：验证 job 生命周期与 HTTP 接口。

仅测试 HTTP 层 + JobManager 抽象；不触达真实 Douyin API。
"""

import asyncio
from typing import Dict

import pytest

try:
    from fastapi.testclient import TestClient  # type: ignore
except ImportError:  # pragma: no cover
    pytest.skip("fastapi not installed", allow_module_level=True)


from config import ConfigLoader
from server.app import _probe_diagnostic, build_app
from server.jobs import JobManager, ServerProgressReporter


@pytest.mark.asyncio
async def test_job_manager_runs_executor(tmp_path):
    async def fake_executor(url: str) -> dict:
        return {
            "total": 1,
            "success": 1,
            "failed": 0,
            "skipped": 0,
            "records": [{"aweme_id": "7666425128226856563", "file_paths": ["one.mp4"]}],
            "records_truncated": 0,
        }

    manager = JobManager(executor=fake_executor, max_concurrency=2)
    job = await manager.submit("https://example/one")
    assert job.status == "pending"

    # 等待后台任务跑完
    await asyncio.wait_for(job._task, timeout=2.0)
    fetched = await manager.get(job.job_id)
    assert fetched is not None
    assert fetched.status == "success"
    assert fetched.success == 1
    assert fetched.to_dict()["records"][0]["aweme_id"] == "7666425128226856563"


@pytest.mark.asyncio
async def test_job_manager_marks_failure_on_executor_error(tmp_path):
    async def boom(url: str) -> Dict[str, int]:
        raise RuntimeError("bad url")

    manager = JobManager(executor=boom)
    job = await manager.submit("x")
    await asyncio.wait_for(job._task, timeout=2.0)
    fetched = await manager.get(job.job_id)
    assert fetched is not None
    assert fetched.status == "failed"
    assert fetched.error is not None
    assert "bad url" in fetched.error


@pytest.mark.asyncio
async def test_job_manager_exposes_phase_and_transfer_progress():
    async def fake_executor(url: str, reporter: ServerProgressReporter) -> Dict[str, int]:
        reporter.update_step("下载视频", "fixture.mp4")
        reporter.on_transfer(
            {
                "current_file": "fixture.mp4",
                "bytes_downloaded": 5 * 1024 * 1024,
                "bytes_total": 10 * 1024 * 1024,
                "speed_bytes_per_second": 250000,
            }
        )
        return {"total": 1, "success": 1, "failed": 0, "skipped": 0}

    manager = JobManager(
        executor=fake_executor,
        progress_reporter_factory=ServerProgressReporter,
    )
    job = await manager.submit("https://example/progress")
    await asyncio.wait_for(job._task, timeout=2.0)

    progress = job.to_dict()["progress"]
    assert progress["phase"] == "下载视频"
    assert progress["bytes_downloaded"] == 5 * 1024 * 1024
    assert progress["bytes_total"] == 10 * 1024 * 1024
    assert progress["speed_bytes_per_second"] == 250000
    assert progress["current_file"] == "fixture.mp4"


def test_health_endpoint(tmp_path):
    config = ConfigLoader(None)
    config.update(path=str(tmp_path))
    app = build_app(config)

    with TestClient(app) as client:
        resp = client.get("/api/v1/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


def test_detail_probe_endpoint_rejects_invalid_aweme_id(tmp_path):
    config = ConfigLoader(None)
    config.update(path=str(tmp_path))
    app = build_app(config)

    with TestClient(app) as client:
        resp = client.post("/api/v1/probe/detail", json={"aweme_id": "bad-id"})
        assert resp.status_code == 400


def test_detail_probe_endpoint_returns_probe_result(tmp_path):
    config = ConfigLoader(None)
    config.update(path=str(tmp_path))
    app = build_app(config)

    async def fake_probe(aweme_id: str) -> Dict[str, object]:
        return {
            "ok": True,
            "endpoint": "/aweme/v1/web/aweme/detail/",
            "aweme_id": aweme_id,
            "transport_ok": True,
            "download_ready": True,
            "http_status": 200,
        }

    app.state.probe_aweme_detail = fake_probe
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/probe/detail",
            json={"aweme_id": "7666425128226856563"},
        )
        assert resp.status_code == 200
        assert resp.json()["download_ready"] is True
        assert resp.json()["endpoint"] == "/aweme/v1/web/aweme/detail/"


@pytest.mark.asyncio
async def test_detail_probe_uses_exact_download_api_and_proxy(tmp_path, monkeypatch):
    from server import app as server_app

    seen: Dict[str, object] = {}

    class FakeApiClient:
        def __init__(self, _cookies, proxy=None):
            seen["proxy"] = proxy
            self.last_error = ""
            self.last_error_kind = ""

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def _default_query(self):
            return {"msToken": "test"}

        async def _request_json(self, path, params, **kwargs):
            seen.update({"path": path, "params": params, "kwargs": kwargs})
            return {
                "status_code": 0,
                "aweme_detail": {
                    "aweme_id": params["aweme_id"],
                    "desc": "probe work",
                    "author": {"nickname": "probe author"},
                },
            }

    config = ConfigLoader(None)
    config.update(path=str(tmp_path), proxy="http://127.0.0.1:7890")
    deps = server_app._ServerDeps(config)
    monkeypatch.setattr(server_app, "DouyinAPIClient", FakeApiClient)

    result = await server_app._probe_aweme_detail("7666425128226856563", deps)

    assert result["download_ready"] is True
    assert result["http_status"] == 200
    assert seen["proxy"] == "http://127.0.0.1:7890"
    assert seen["path"] == "/aweme/v1/web/aweme/detail/"
    assert seen["params"]["aid"] == "6383"
    assert seen["kwargs"] == {"suppress_error": True, "max_retries": 1}


@pytest.mark.asyncio
async def test_detail_probe_reports_antibot_403_as_reached_but_not_ready(tmp_path, monkeypatch):
    from server import app as server_app

    class FakeApiClient:
        def __init__(self, _cookies, proxy=None):
            self.last_error = "HTTP 403: ArgusSecurityPlugin Signature Not Found"
            self.last_error_kind = "anti_bot"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def _default_query(self):
            return {}

        async def _request_json(self, _path, _params, **_kwargs):
            return {}

    config = ConfigLoader(None)
    config.update(path=str(tmp_path))
    deps = server_app._ServerDeps(config)
    monkeypatch.setattr(server_app, "DouyinAPIClient", FakeApiClient)

    result = await server_app._probe_aweme_detail("7666425128226856563", deps)

    assert result["transport_ok"] is True
    assert result["download_ready"] is False
    assert result["http_status"] == 403
    assert result["kind"] == "anti_bot"
    assert result["diagnostic"] == {
        "outcome": "risk_control",
        "rule": "signature.refused",
        "label": "签名参数缺失",
        "detail": "signature not found",
        "action": "请求没有携带完整的 WebSign；需要更新签名实现，而不是更换 Cookie。",
    }


@pytest.mark.parametrize(
    ("error", "expected_label", "expected_detail"),
    [
        (
            "HTTP 403: Blocked by ArgusSecurityPlugin Uifid Not Found",
            "访客身份缺失",
            "uifid not found",
        ),
        (
            "HTTP 403: Blocked by ArgusSecurityPlugin Sign Invalid",
            "签名校验失败",
            "sign invalid",
        ),
        (
            "HTTP 403: Blocked by ArgusSecurityPlugin Sign Expired",
            "签名已过期",
            "sign expired",
        ),
    ],
)
def test_probe_diagnostic_names_signature_refusal(error, expected_label, expected_detail):
    result = _probe_diagnostic(kind="anti_bot", http_status=403, error=error)

    assert result["outcome"] == "risk_control"
    assert result["rule"] == "signature.refused"
    assert result["label"] == expected_label
    assert result["detail"] == expected_detail


def test_probe_diagnostic_keeps_explained_absence_out_of_risk_control():
    result = _probe_diagnostic(
        kind="content_unavailable",
        http_status=200,
        error="filter_reason=status_self_see",
        filter_reason="status_self_see",
    )

    assert result["outcome"] == "business_error"
    assert result["rule"] == "payload.explained"
    assert result["label"] == "作品仅自己可见"


def test_download_endpoint_creates_job(tmp_path, monkeypatch):
    config = ConfigLoader(None)
    config.update(path=str(tmp_path))
    app = build_app(config)

    # 替换 job executor 为 fake（不去触达 Douyin）
    async def fake_executor(url: str) -> Dict[str, int]:
        return {"total": 0, "success": 0, "failed": 0, "skipped": 0}

    app.state.job_manager.executor = fake_executor

    with TestClient(app) as client:
        resp = client.post("/api/v1/download", json={"url": "https://www.douyin.com/video/123"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] in ("pending", "running", "success")
        assert data["url"] == "https://www.douyin.com/video/123"
        assert len(data["job_id"]) > 0

        job_id = data["job_id"]
        # job 列表应包含该 id
        list_resp = client.get("/api/v1/jobs")
        assert list_resp.status_code == 200
        ids = [j["job_id"] for j in list_resp.json()["jobs"]]
        assert job_id in ids

        # 详情接口
        detail = client.get(f"/api/v1/jobs/{job_id}")
        assert detail.status_code == 200
        assert detail.json()["job_id"] == job_id


def test_download_endpoint_rejects_empty_url(tmp_path):
    config = ConfigLoader(None)
    config.update(path=str(tmp_path))
    app = build_app(config)
    with TestClient(app) as client:
        resp = client.post("/api/v1/download", json={"url": ""})
        assert resp.status_code == 400


def test_get_unknown_job_returns_404(tmp_path):
    config = ConfigLoader(None)
    config.update(path=str(tmp_path))
    app = build_app(config)
    with TestClient(app) as client:
        resp = client.get("/api/v1/jobs/unknown-id")
        assert resp.status_code == 404


def test_build_app_shares_deps_across_requests(tmp_path):
    """重请求应复用同一个 FileManager / RateLimiter 等（避免每次重建）。"""
    config = ConfigLoader(None)
    config.update(path=str(tmp_path))
    app = build_app(config)

    deps = app.state.deps
    assert deps.file_manager is not None
    assert deps.rate_limiter is not None
    assert deps.retry_handler is not None
    assert deps.queue_manager is not None
    assert deps.cookie_manager is not None

    # 构建第二次 app 时应该是完全独立的 deps 实例，但同一 app 内是共享的
    app2 = build_app(config)
    assert app2.state.deps is not app.state.deps
    assert app.state.deps.file_manager is app.state.deps.file_manager  # identity


@pytest.mark.asyncio
async def test_job_manager_prunes_by_max_jobs():
    """max_jobs 超限时应优先淘汰最老的终态 job，保留 in-flight。"""

    async def fast_executor(url: str) -> Dict[str, int]:
        return {"total": 0, "success": 0, "failed": 0, "skipped": 0}

    manager = JobManager(executor=fast_executor, max_jobs=3, job_ttl_seconds=0.0)
    jobs = []
    for i in range(5):
        j = await manager.submit(f"u{i}")
        jobs.append(j)
        await asyncio.wait_for(j._task, timeout=1.0)

    remaining = await manager.list_jobs()
    # max_jobs=3：新任务 submit 时先剪裁，最终存量 ≤ max_jobs
    assert len(remaining) <= 3
    # 最新的那一批一定在，最早的那几个被淘汰
    ids_remaining = {j.job_id for j in remaining}
    assert jobs[-1].job_id in ids_remaining


@pytest.mark.asyncio
async def test_job_manager_prunes_by_ttl():
    """TTL 过期的终态 job 应在下次 submit 时被清理。"""

    async def fast_executor(url: str) -> Dict[str, int]:
        return {"total": 0, "success": 0, "failed": 0, "skipped": 0}

    manager = JobManager(executor=fast_executor, max_jobs=100, job_ttl_seconds=0.01)
    old_job = await manager.submit("old")
    await asyncio.wait_for(old_job._task, timeout=1.0)

    # 等 TTL 过期
    await asyncio.sleep(0.05)

    new_job = await manager.submit("new")
    await asyncio.wait_for(new_job._task, timeout=1.0)

    remaining_ids = {j.job_id for j in await manager.list_jobs()}
    assert old_job.job_id not in remaining_ids
    assert new_job.job_id in remaining_ids
