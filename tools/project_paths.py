import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = PROJECT_ROOT / "data"
SHARED_BROWSER_PROFILE_DIRNAME = "selenium_user_data"
SHARED_BROWSER_PROFILE_ENV = "JAV_BROWSER_PROFILE_DIR"


def ensure_data_dir() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR


def legacy_root_path(name: str) -> Path:
    return PROJECT_ROOT / name


def data_path(name: str) -> Path:
    return DATA_DIR / name


def resolve_local_file(name: str) -> Path:
    preferred = data_path(name)
    if preferred.exists():
        return preferred
    legacy = legacy_root_path(name)
    if legacy.exists():
        return legacy
    return preferred


def resolve_writable_data_file(name: str) -> Path:
    ensure_data_dir()
    return data_path(name)


def resolve_local_dir(name: str) -> Path:
    preferred = data_path(name)
    if preferred.exists():
        return preferred
    legacy = legacy_root_path(name)
    if legacy.exists():
        return legacy
    return preferred


def resolve_writable_data_dir(name: str) -> Path:
    target = data_path(name)
    target.mkdir(parents=True, exist_ok=True)
    return target


def resolve_shared_browser_profile_dir() -> Path:
    override = os.environ.get(SHARED_BROWSER_PROFILE_ENV)
    if override:
        target = Path(override).expanduser()
        target.mkdir(parents=True, exist_ok=True)
        return target
    return resolve_writable_data_dir(SHARED_BROWSER_PROFILE_DIRNAME)
