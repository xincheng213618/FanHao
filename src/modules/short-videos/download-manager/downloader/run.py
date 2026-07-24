#!/usr/bin/env python3
import os
import sys
from pathlib import Path

project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))
os.chdir(project_root)


def disable_windows_wmi_platform_probe() -> None:
    """Keep Python 3.14 platform detection from blocking on broken Windows WMI."""
    if os.name != "nt":
        return

    import platform

    # Python 3.14 asks WMI before using its normal Win32 fallback. If WMI is
    # unhealthy, importing aiohttp can block here indefinitely. Disabling the
    # optional private helper preserves accurate fallback detection and lets the
    # local sidecar start normally.
    if hasattr(platform, "_wmi"):
        platform._wmi = None


disable_windows_wmi_platform_probe()

if __name__ == "__main__":
    from cli.main import main

    main()
