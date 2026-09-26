from __future__ import annotations

from threading import RLock
from unittest.mock import patch

from manager_core import connectivity
from manager_core.http_api import Handler
from manager_core.sidecar_runtime import SidecarRuntimeMixin


def test_probe_download_api_uses_read_only_target_and_preserves_result() -> None:
    target = {
        "id": 42,
        "aweme_id": "7666425128226856563",
        "url": "https://www.douyin.com/video/7666425128226856563",
        "status": "pending",
    }
    probe_result = {
        "ok": True,
        "endpoint": "/aweme/v1/web/aweme/detail/",
        "transport_ok": True,
        "download_ready": True,
        "http_status": 200,
    }

    with (
        patch.object(connectivity, "select_detail_probe_target", return_value=target),
        patch.object(
            connectivity.download_manager,
            "probe_aweme_detail",
            return_value=probe_result,
        ) as probe,
    ):
        result = connectivity.probe_download_api()

    probe.assert_called_once_with("7666425128226856563")
    assert result["download_ready"] is True
    assert result["target"] == {
        "link_id": 42,
        "aweme_id": "7666425128226856563",
        "status": "pending",
        "url": "https://www.douyin.com/video/7666425128226856563",
    }


def test_http_get_exposes_download_probe_json() -> None:
    handler = Handler.__new__(Handler)
    handler.path = "/api/download/probe"
    captured = []
    handler.send_json = captured.append
    expected = {
        "ok": True,
        "endpoint": "/aweme/v1/web/aweme/detail/",
        "download_ready": False,
    }

    with patch("manager_core.http_api.probe_download_api", return_value=expected) as probe:
        Handler.do_GET(handler)

    probe.assert_called_once_with()
    assert captured == [expected]


def test_probe_reports_busy_runtime_as_not_tested() -> None:
    runtime = SidecarRuntimeMixin()
    runtime.lock = RLock()
    runtime.active = True

    result = runtime.probe_aweme_detail("7666425128226856563")

    assert result["ok"] is False
    assert result["kind"] == "busy"
    assert result["diagnostic"] == {
        "outcome": "not_tested",
        "rule": "runtime.busy",
        "label": "自动下载运行中",
        "detail": "当前监听器正在占用下载 Sidecar，本次没有向抖音发起测试请求。",
        "action": "无需处理；发生异常保护暂停后，再用测试按钮验证新的 VPN、代理或 Cookie。",
    }
