from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


QUALITY_UPGRADE_INTENT = "quality_upgrade"


def iso_now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def quality_counts(manager_db: Path) -> dict[str, int]:
    counts = {"pending": 0, "downloading": 0, "failed": 0}
    with sqlite3.connect(str(manager_db), timeout=30) as conn:
        for status, count in conn.execute(
            "SELECT status, COUNT(*) FROM links WHERE download_intent=? GROUP BY status",
            (QUALITY_UPGRADE_INTENT,),
        ):
            counts[str(status)] = int(count)
    return counts


def stop_download(api_url: str) -> None:
    request = Request(
        api_url.rstrip("/") + "/api/download/stop",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        response.read()


def write_marker(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    manager_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Stop after the quality-upgrade queue drains, then verify it.")
    parser.add_argument("--manager-db", type=Path, default=manager_root / "data" / "douyin_downloads.sqlite")
    parser.add_argument("--api-url", default="http://127.0.0.1:8765")
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument(
        "--marker",
        type=Path,
        default=manager_root / "data" / "quality-upgrade-monitor-complete.json",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manager_db = args.manager_db.resolve()
    report = args.report.resolve()
    marker = args.marker.resolve()
    audit_script = Path(__file__).resolve().with_name("audit_video_quality.py")
    started_at = iso_now()
    last_heartbeat = 0.0
    while True:
        counts = quality_counts(manager_db)
        active = counts.get("pending", 0) + counts.get("downloading", 0)
        now = time.time()
        if now - last_heartbeat >= 60:
            print(json.dumps({"at": iso_now(), "quality": counts}, ensure_ascii=False), flush=True)
            last_heartbeat = now
        if active <= 0:
            try:
                stop_download(str(args.api_url))
            except Exception as exc:
                print(f"stop request failed: {exc}", file=sys.stderr, flush=True)
            time.sleep(max(1.0, float(args.poll_seconds)))
            command = [
                sys.executable,
                "-u",
                "-B",
                str(audit_script),
                "--verify-existing-report",
                str(report),
                "--concurrency",
                str(max(1, int(args.concurrency))),
            ]
            completed = subprocess.run(
                command,
                cwd=str(audit_script.parents[5]),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            final_counts = quality_counts(manager_db)
            payload = {
                "started_at": started_at,
                "completed_at": iso_now(),
                "quality": final_counts,
                "verification_exit_code": int(completed.returncode),
                "verification_stdout": completed.stdout.strip(),
                "verification_stderr": completed.stderr.strip(),
                "report": str(report),
            }
            write_marker(marker, payload)
            print(json.dumps(payload, ensure_ascii=False), flush=True)
            return int(completed.returncode)
        time.sleep(max(0.5, float(args.poll_seconds)))


if __name__ == "__main__":
    raise SystemExit(main())
