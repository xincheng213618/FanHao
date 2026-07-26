#!/usr/bin/env python3
"""Compatibility entry point for the unified FanHao novel collector."""

from pathlib import Path
import sys


COLLECTOR_DIR = Path(__file__).resolve().parents[1] / "src" / "modules" / "novels" / "collectors"
if str(COLLECTOR_DIR) not in sys.path:
    sys.path.insert(0, str(COLLECTOR_DIR))

from runner import main  # noqa: E402


if __name__ == "__main__":
    main()
