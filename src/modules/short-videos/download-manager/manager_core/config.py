"""Internal config responsibilities for the download manager."""

from __future__ import annotations

import os
import sys
from pathlib import Path


FROZEN_BUILD = bool(getattr(sys, "frozen", False))


SOURCE_DIR = Path(__file__).resolve().parent.parent


INSTALL_DIR = Path(sys.executable).resolve().parent if FROZEN_BUILD else SOURCE_DIR


BASE_DIR = Path(getattr(sys, "_MEIPASS", SOURCE_DIR)).resolve()


STATIC_DIR = BASE_DIR / "static"


FANHAO_PUBLIC_DIR = (
    BASE_DIR / "fanhao-public"
    if FROZEN_BUILD
    else SOURCE_DIR.parents[3] / "public"
)


APP_STATE_DIR = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    / "DouyinDownloadManager"
)


DEFAULT_PROJECT_ROOT = APP_STATE_DIR if FROZEN_BUILD else BASE_DIR.parents[3]


DEFAULT_DATA_DIR = APP_STATE_DIR / "data" if FROZEN_BUILD else BASE_DIR / "data"


DEFAULT_LOG_DIR = APP_STATE_DIR / "logs" if FROZEN_BUILD else BASE_DIR / "logs"


PROJECT_ROOT = Path(os.environ.get("FANHAO_PROJECT_ROOT", str(DEFAULT_PROJECT_ROOT))).resolve()


DATA_DIR = Path(os.environ.get("DOUYIN_MANAGER_DATA_DIR", str(DEFAULT_DATA_DIR))).resolve()


LOG_DIR = Path(os.environ.get("DOUYIN_MANAGER_LOG_DIR", str(DEFAULT_LOG_DIR))).resolve()


CONFIG_DIR = DATA_DIR / "configs"


DB_PATH = DATA_DIR / "douyin_downloads.sqlite"


TEST_PROFILE_URL = (
    "https://www.douyin.com/user/MS4wLjABAAAA88rdHdXo8m0mJQ-FfcZnOvz73URJIwyHaAhS8KNhXj4"
    "?from_tab_name=main&vid=7646737901396451654"
)


DOUYIN_DOWNLOADER_ROOT_ENV = "DOUYIN_DOWNLOADER_ROOT"


def downloader_root_env_value() -> str:
    """Return the explicit downloader-root override, if one is configured."""

    return str(os.environ.get(DOUYIN_DOWNLOADER_ROOT_ENV, "")).strip()


DEFAULT_DOWNLOADER_ROOT = (INSTALL_DIR / "downloader").resolve()


LEGACY_DOWNLOADER_ROOT = (PROJECT_ROOT.parent / "Tool" / "douyin-downloader").resolve()


DOWNLOADER_ROOT = Path(
    downloader_root_env_value() or str(DEFAULT_DOWNLOADER_ROOT)
).resolve()


DOWNLOADER_EXE = DOWNLOADER_ROOT / "douyin-downloader.exe"


DOWNLOADER_PYTHON = DOWNLOADER_ROOT / ".venv" / "Scripts" / "python.exe"


DOWNLOADER_RUN = DOWNLOADER_ROOT / "run.py"


LEGACY_DOWNLOADER_PYTHON = LEGACY_DOWNLOADER_ROOT / ".venv" / "Scripts" / "python.exe"


LEGACY_DOWNLOADER_RUN = LEGACY_DOWNLOADER_ROOT / "run.py"


DEFAULT_COOKIE_FILE = (
    Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming")))
    / "douyin-downloader-desktop"
    / "custom-batch-douyin-cookies.txt"
)


NODE_EXECUTABLE = os.environ.get(
    "DOUYIN_MANAGER_NODE",
    str(INSTALL_DIR / "runtime" / "node.exe") if FROZEN_BUILD else "node",
)


DEFAULT_STORAGE_ROOT = Path(
    os.environ.get("FANHAO_SHORT_VIDEO_STORAGE_ROOT", r"D:\Media")
)


DEFAULT_OUTPUT_DIR = DEFAULT_STORAGE_ROOT


DEFAULT_LIBRARY_OUTPUT_DIR = DEFAULT_STORAGE_ROOT / "ShortVideos"


LIBRARY_SEC_UID = os.environ.get(
    "DOUYIN_LIBRARY_SEC_UID",
    "MS4wLjABAAAAqiW-0GYj4wFCXymqQZsgY3mF5z4cZWUopJqTUkmYx20",
)


MAX_CONCURRENCY = 24


DEFAULT_FAILURE_GUARD_THRESHOLD = 10


FAILURE_GUARD_COOLDOWN_SECONDS = 3600


DOWNLOAD_QUEUE_ORDER = """
CASE WHEN download_intent='quality_upgrade' THEN 0 ELSE 1 END,
CASE WHEN download_intent='quality_upgrade' THEN COALESCE(digg_count, 0) ELSE 0 END DESC,
CASE WHEN create_time IS NULL THEN 1 ELSE 0 END,
create_time DESC,
last_seen_at DESC,
id DESC
"""


GALLERY_MUSIC_INTENT = "gallery_music"


QUALITY_UPGRADE_INTENT = "quality_upgrade"


DOWNLOAD_GUARD_STATE_SETTING = "download_guard_state"
