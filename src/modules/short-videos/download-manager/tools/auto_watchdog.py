from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_DIR = Path(__file__).resolve().parent.parent
LOG_DIR = BASE_DIR / "logs"
STATE_PATH = LOG_DIR / "auto-watchdog-state.json"
RUN_LOG = LOG_DIR / "auto-watchdog-run.log"
ESCALATION_LOG = LOG_DIR / "auto-watchdog-escalation.log"
ESCALATION_STATE = LOG_DIR / "auto-watchdog-escalation.json"

API_BASE = os.environ.get("DOUYIN_MANAGER_URL", "http://localhost:8765").rstrip("/")
STATE_URL = f"{API_BASE}/api/state"
STOP_URL = f"{API_BASE}/api/download/stop"
TIMEOUT_SEC = 5
PROFILE_GUARD_PATTERN = "tools\\batch_profile_download.py"


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S.%f%z")


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_run_log(line: str) -> None:
    RUN_LOG.parent.mkdir(parents=True, exist_ok=True)
    with RUN_LOG.open("a", encoding="utf-8") as fp:
        fp.write(line + "\n")


def append_escalation(line: str) -> None:
    ESCALATION_LOG.parent.mkdir(parents=True, exist_ok=True)
    with ESCALATION_LOG.open("a", encoding="utf-8") as fp:
        fp.write(line + "\n")


def call_api_state() -> tuple[bool, dict | None, str]:
    req = Request(STATE_URL)
    try:
        with urlopen(req, timeout=TIMEOUT_SEC) as response:
            raw = response.read().decode("utf-8")
            return True, json.loads(raw or "{}"), ""
    except Exception as exc:  # noqa: BLE001
        return False, None, str(exc)


def get_latest_profile_log() -> Path | None:
    files = sorted(LOG_DIR.glob("profile-auto-unfinished-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def read_log_tail(path: Path | None, lines: int = 20) -> str:
    if not path or not path.exists():
        return ""
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as fp:
            all_lines = fp.readlines()
        return "".join(all_lines[-lines:]).strip()
    except Exception:
        return ""


def parse_active_job(state: dict) -> tuple[int | None, dict]:
    download = state.get("download") or {}
    job_id = download.get("job_id")
    jobs = state.get("jobs") or []
    if not isinstance(jobs, list):
        jobs = []
    job = next((j for j in jobs if j.get("id") == job_id), jobs[0] if jobs else {})
    return (int(job_id) if job_id is not None else None, job if isinstance(job, dict) else {})


def summarize_post_links(state: dict) -> dict[str, int]:
    profiles = [p for p in (state.get("profiles") or []) if (p or {}).get("tab") == "post"]
    pending_profiles = 0
    pending_total = 0
    downloading_profiles = 0
    failed_profiles = 0
    for p in profiles:
        pending = int(p.get("pending") or 0)
        downloading = int(p.get("downloading") or 0)
        failed = int(p.get("failed") or 0)
        if pending:
            pending_profiles += 1
            pending_total += pending
        if downloading:
            downloading_profiles += 1
        if failed:
            failed_profiles += 1
    return {
        "post_profiles": len(profiles),
        "pending_profiles": pending_profiles,
        "pending_total": pending_total,
        "downloading_profiles": downloading_profiles,
        "failed_profiles": failed_profiles,
    }


def detect_guard_process() -> tuple[bool | None, bool]:
    """Return (running, command_line_verified). running=None means permission/access unknown."""
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
            ],
            stderr=subprocess.DEVNULL,
            timeout=3,
        ).decode("utf-8", errors="ignore").strip()
        if not out:
            return False, True
        try:
            payload = json.loads(out)
        except Exception:
            return None, False
        if isinstance(payload, dict):
            payload = [payload]
        for item in payload or []:
            cmd = (item.get("CommandLine") or "").lower()
            if PROFILE_GUARD_PATTERN.lower() in cmd and "--auto-unfinished" in cmd:
                return True, True
        return False, True
    except Exception:
        return None, False


def start_guard(log_path: Path) -> tuple[bool, str]:
    try:
        subprocess.Popen(
            [
                sys.executable,
                str(BASE_DIR / "tools" / "batch_profile_download.py"),
                "--auto-unfinished",
                "--skip-extract",
                "--log",
                str(log_path),
            ],
            cwd=str(BASE_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            shell=False,
            creationflags=0x08000000,
        )
        return True, "guard_started"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def call_stop_download() -> None:
    req = Request(
        STOP_URL,
        data=b"{}",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(req, timeout=TIMEOUT_SEC):
            pass
    except Exception:
        return


def suspicious_state(state: dict) -> list[str]:
    reasons = []
    for event in state.get("events") or []:
        msg = str((event or {}).get("message") or "").lower()
        if not msg:
            continue
        if any(
            k in msg
            for k in (
                "database is locked",
                "database locked",
                "corrupt",
                "syntax error",
                "traceback",
                "sidecar",
                "schema",
                "sqlite",
                "db lock",
            )
        ):
            reasons.append(msg[:180])
    return reasons


def can_escalate(now_dt: datetime, incident_key: str, last_state: dict | None) -> bool:
    last_key = (last_state or {}).get("last_incident_key", "")
    if last_key != incident_key:
        return True
    last_time_str = (last_state or {}).get("last_incident_time", "")
    try:
        last_time = datetime.strptime(last_time_str, "%Y-%m-%d %H:%M:%S")
        return (now_dt - last_time) > timedelta(minutes=30)
    except Exception:
        return True


def mark_escalation(payload: dict, reason: str, summary: str, incident_key: str, mark_unavailable: bool = False) -> bool:
    now_dt = datetime.now()
    state = read_json(ESCALATION_STATE, {})
    if not can_escalate(now_dt, incident_key, state):
        append_run_log(f"ESCALATION_SUPPRESSED incident_key={incident_key} reason={reason}")
        return False

    state.update(
        {
            "last_incident_key": incident_key,
            "last_incident_time": now_dt.strftime("%Y-%m-%d %H:%M:%S"),
            "last_incident_reason": reason,
            "incident_summary": summary,
        }
    )
    write_json(ESCALATION_STATE, state)

    append_escalation(
        f"{now()} {reason} incident_key={incident_key} summary={summary}"
    )
    if mark_unavailable:
        append_run_log(f"ESCALATION_TRIGGERED incident_key={incident_key} reason={reason} ESCALATION_TOOL_UNAVAILABLE")
    else:
        append_run_log(f"ESCALATION_TRIGGERED incident_key={incident_key} reason={reason}")
    return True


def main() -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    previous = read_json(STATE_PATH, {})
    prev = previous if isinstance(previous, dict) else {}

    reachable, state, err = call_api_state()
    latest_profile_log = get_latest_profile_log()
    latest_profile_tail = read_log_tail(latest_profile_log)
    latest_log_mtime = latest_profile_log.stat().st_mtime if latest_profile_log else None

    guard_running, cmdline_verified = detect_guard_process()

    if not reachable:
        current = {
            "time": now_iso(),
            "api_reachable": False,
            "author": "",
            "author_uid": "",
            "profile_id": None,
            "job_id": None,
            "total": 0,
            "processed": 0,
            "success": 0,
            "failed": 0,
            "inflight": 0,
            "post_profiles": 0,
            "pending_profiles": 0,
            "pending_total": 0,
            "downloading_profiles": 0,
            "failed_profiles": 0,
            "action": "none",
            "repaired": False,
            "guard_running": False,
            "guard_verified": False,
            "latest_profile_log": str(latest_profile_log) if latest_profile_log else "",
            "latest_profile_log_mtime": latest_log_mtime,
            "notes": f"state_unreachable: {err[:240]}",
            "reason": "api_unreachable",
            "api_unreachable_count": int(prev.get("api_unreachable_count", 0)) + 1,
            "no_progress_inflight0_count": int(prev.get("no_progress_inflight0_count", 0)),
            "repair_attempt_count": int(prev.get("repair_attempt_count", 0)),
            "escalated": False,
            "escalation_reason": None,
            "snapshot_pair": [
                [int(prev.get("total", -1)), int(prev.get("processed", -1)), int(prev.get("success", -1)), int(prev.get("failed", -1))],
                [0, 0, 0, 0],
            ],
        }
        write_json(STATE_PATH, current)
        append_run_log(
            f"[{now()}] API=unreachable action=none repaired=False author= uid= job= total={current['total']} processed={current['processed']} success={current['success']} failed={current['failed']} inflight=0"
        )
        if current["api_unreachable_count"] >= 2:
            incident_key = f"api_unreachable_2x|{prev.get('job_id')}|{prev.get('profile_id')}"
            if mark_escalation(current, "api_unreachable_2x", f"连续两次 /api/state 不可达: {err[:200]}", incident_key, True):
                current["escalated"] = True
                current["escalation_reason"] = "api_unreachable_2x"
                write_json(STATE_PATH, current)
        return 0

    download = state.get("download") or {}
    job_id, job = parse_active_job(state)
    active = bool(download.get("active"))
    summary = summarize_post_links(state)
    current_profile = state.get("current_profile") or {}
    author = current_profile.get("nickname") or current_profile.get("sec_uid") or "Nil"
    author_uid = str(current_profile.get("uid") or str(current_profile.get("sec_uid") or ""))
    profile_id = current_profile.get("id")

    current = {
        "time": now_iso(),
        "api_reachable": True,
        "author": author,
        "author_uid": author_uid,
        "profile_id": profile_id,
        "job_id": job_id,
        "total": int(job.get("total") or 0),
        "processed": int(job.get("processed") or 0),
        "success": int(job.get("success") or 0),
        "failed": int(job.get("failed") or 0),
        "inflight": int(download.get("inflight") or 0),
        "post_profiles": summary["post_profiles"],
        "pending_profiles": summary["pending_profiles"],
        "pending_total": summary["pending_total"],
        "downloading_profiles": summary["downloading_profiles"],
        "failed_profiles": summary["failed_profiles"],
        "action": "none",
        "repaired": False,
        "guard_running": bool(guard_running) if guard_running is not None else False,
        "guard_verified": bool(cmdline_verified),
        "latest_profile_log": str(latest_profile_log) if latest_profile_log else "",
        "latest_profile_log_mtime": latest_log_mtime,
        "notes": "",
        "reason": None,
        "api_unreachable_count": 0,
        "no_progress_inflight0_count": int(prev.get("no_progress_inflight0_count", 0)),
        "repair_attempt_count": int(prev.get("repair_attempt_count", 0)),
        "escalated": False,
        "escalation_reason": None,
        "snapshot_pair": [
            [int(prev.get("total", -1)), int(prev.get("processed", -1)), int(prev.get("success", -1)), int(prev.get("failed", -1))],
            [int(job.get("total") or 0), int(job.get("processed") or 0), int(job.get("success") or 0), int(job.get("failed") or 0)],
        ],
    }

    has_progress = current["snapshot_pair"][0] != current["snapshot_pair"][1]

    if has_progress:
        current["repair_attempt_count"] = 0
    else:
        current["repair_attempt_count"] = int(prev.get("repair_attempt_count", 0))

    # 进程存在性判定：命令行读取失败时，结合下载状态与日志追加判断
    log_mtime_advancing = False
    if latest_log_mtime is not None:
        try:
            prev_mtime = float(prev.get("latest_profile_log_mtime") or 0)
            log_mtime_advancing = latest_log_mtime > prev_mtime
        except Exception:
            log_mtime_advancing = False

    if guard_running is None:
        if active and (current["inflight"] > 0 or has_progress or log_mtime_advancing):
            guard_present = True
        else:
            guard_present = False
    else:
        guard_present = bool(guard_running)

    reasons = suspicious_state(state)
    if reasons:
        current["reason"] = "suspicious_state"
        current["notes"] = "; ".join(reasons[:2])
        incident_key = f"suspicious_state|{job_id}|{profile_id}|{abs(hash('|'.join(reasons[:1])))}"
        if mark_escalation(
            current,
            "suspicious_state",
            f"state事件疑似异常: {reasons[0][:180]}；latest_tail={latest_profile_tail[:400]}",
            incident_key,
            True,
        ):
            current["escalated"] = True
            current["escalation_reason"] = "suspicious_state"

    total_pending = summary["pending_total"]

    if total_pending > 0 and not guard_present:
        log_path = LOG_DIR / f"profile-auto-unfinished-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
        ok, msg = start_guard(log_path)
        current["repair_attempt_count"] = int(prev.get("repair_attempt_count", 0)) + 1
        if ok:
            current["action"] = "start_guard"
            current["repaired"] = True
            current["notes"] = f"guard_started:{log_path}"
            current["guard_running"] = True
            current["guard_verified"] = False
            current["escalation_reason"] = None
        else:
            current["action"] = "start_guard_failed"
            current["repaired"] = False
            current["notes"] = f"guard_start_failed:{msg}"
            incident_key = f"guard_start_failed|{job_id}|{author_uid}|{total_pending}"
            if mark_escalation(
                current,
                "guard_start_failed",
                f"启动守护失败，未完成 post 仍有 {total_pending}: {msg}",
                incident_key,
                True,
            ):
                current["escalated"] = True
                current["escalation_reason"] = "guard_start_failed"

    if (
        active
        and total_pending > 0
        and not has_progress
        and (current["inflight"] > 0 or guard_present)
    ):
        call_stop_download()
        log_path = LOG_DIR / f"profile-auto-unfinished-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
        ok, msg = start_guard(log_path)
        current["repair_attempt_count"] = int(current["repair_attempt_count"]) + 1
        if ok:
            current["action"] = "restart_download"
            current["repaired"] = True
            current["notes"] = "no_progress_restart"
            current["guard_running"] = True
            current["guard_verified"] = False
            current["no_progress_inflight0_count"] = 0
        else:
            current["notes"] = f"restart_failed:{msg}"
            incident_key = f"guard_restart_failed|{job_id}|{author_uid}|{total_pending}"
            if mark_escalation(
                current,
                "guard_restart_failed",
                f"无进展 stop+restart 失败，未完成 post 仍有 {total_pending}",
                incident_key,
                True,
            ):
                current["escalated"] = True
                current["action"] = "escalation"
                current["escalation_reason"] = "guard_restart_failed"

    if active and current["inflight"] == 0 and total_pending > 0 and not has_progress:
        if int(prev.get("no_progress_inflight0_count", 0)) + 1 >= 2:
            call_stop_download()
            log_path = LOG_DIR / f"profile-auto-unfinished-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
            ok, msg = start_guard(log_path)
            current["repair_attempt_count"] = int(current["repair_attempt_count"]) + 1
            if ok:
                current["action"] = "restart_download_inflight0"
                current["repaired"] = True
                current["notes"] = "inflight0_2x_no_progress_restart"
                current["guard_running"] = True
                current["guard_verified"] = False
                current["no_progress_inflight0_count"] = 0
            else:
                current["notes"] = f"inflight0_restart_failed:{msg}"
                incident_key = f"inflight0_restart_failed|{job_id}|{author_uid}|{total_pending}"
                if mark_escalation(
                    current,
                    "guard_restart_failed",
                    f"inflight=0 且连续2次无进展，重启失败: {msg}",
                    incident_key,
                    True,
                ):
                    current["escalated"] = True
                    current["action"] = "escalation"
                    current["escalation_reason"] = "inflight0_restart_failed"
        else:
            current["no_progress_inflight0_count"] = int(prev.get("no_progress_inflight0_count", 0)) + 1
    else:
        current["no_progress_inflight0_count"] = 0

    if has_progress:
        current["repair_attempt_count"] = 0

    if current["repair_attempt_count"] >= 2 and not has_progress:
        incident_key = f"repeated_repair_no_progress|{job_id}|{author_uid}|{profile_id}|{total_pending}"
        if mark_escalation(
            current,
            "repeated_repair_no_progress",
            f"连续两次自愈后仍无进展；latest_tail={latest_profile_tail[:260]}",
            incident_key,
            True,
        ):
            current["escalated"] = True
            current["action"] = "escalation"
            current["escalation_reason"] = "repeated_repair_no_progress"

    if (not active) and total_pending > 0 and not guard_present:
        status = (job.get("status") or "").lower()
        if status in {"complete", "stopped"}:
            incident_key = f"complete_stopped_pending|{job_id}|{author_uid}|{profile_id}|{total_pending}"
            if mark_escalation(
                current,
                "complete_stopped_pending",
                f"下载任务 {status}，仍有 pending={summary['pending_profiles']}，未自动切换下一个作者",
                incident_key,
                True,
            ):
                current["escalated"] = True
                current["action"] = "escalation"
                current["escalation_reason"] = "complete_stopped_pending"

    write_json(STATE_PATH, current)

    append_run_log(
        f"[{now()}] api_state reachable=5s author={current['author']} uid={current['author_uid']} job={current['job_id']} "
        f"total={current['total']} processed={current['processed']} success={current['success']} failed={current['failed']} "
        f"inflight={current['inflight']} pending_posts={current['pending_profiles']}/{current['pending_total']} action={current['action']} "
        f"repaired={str(current['repaired']).lower()} guard_running={str(current['guard_running']).lower()} "
        f"commandline_check={'ok' if current['guard_verified'] else ('denied(assumed)' if guard_running is None else 'failed')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
