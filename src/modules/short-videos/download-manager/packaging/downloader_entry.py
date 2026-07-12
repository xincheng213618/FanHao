"""PyInstaller entrypoint for the bundled douyin-downloader sidecar."""

from __future__ import annotations

import os
import sys


os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8:replace")
os.environ.setdefault("PYTHONLEGACYWINDOWSSTDIO", "0")

for stream in (sys.stdout, sys.stderr):
    if stream is not None and hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


if __name__ == "__main__":
    from cli.main import main

    main()
