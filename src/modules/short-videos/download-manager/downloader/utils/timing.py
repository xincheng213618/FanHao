from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()


def elapsed_ms(started: float | None) -> int | None:
    if started is None:
        return None
    return int((time.monotonic() - started) * 1000)


def timing_event(event: str, **fields: Any) -> None:
    timing_dir = os.environ.get("DOUYIN_TIMING_DIR")
    if not timing_dir:
        return
    try:
        path = Path(timing_dir)
        path.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "event": event,
            **fields,
        }
        log_path = path / f"sidecar-timing-{datetime.now().strftime('%Y%m%d')}.jsonl"
        with _LOCK:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, default=str))
                handle.write("\n")
    except Exception:
        pass
