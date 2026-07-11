from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


MODULE_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = Path(os.environ.get("FANHAO_PROJECT_ROOT", str(MODULE_DIR.parents[3]))).resolve()
BASE = os.environ.get("DOUYIN_MANAGER_URL", "http://localhost:8765").rstrip("/")
DOWNLOAD_DB = Path(
    os.environ.get("DOUYIN_MANAGER_DB", str(MODULE_DIR / "data" / "douyin_downloads.sqlite"))
).resolve()
FANHAO_DB = Path(
    os.environ.get("FANHAO_SHORT_VIDEO_DB", str(PROJECT_ROOT / "data" / "short-videos.sqlite"))
).resolve()
EXTRACT_SCROLLS = 30000
EXTRACT_IDLE_ROUNDS = 220
DOWNLOAD_WATCHDOG_SECONDS = 600
MAX_DOWNLOAD_RESTARTS_PER_PROFILE = 6
AUTO_POLL_SECONDS = 60


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def sec_from_url(url: str) -> str:
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 2 and parts[0] == "user":
        return parts[1].strip()
    raise ValueError(f"不是抖音用户主页: {url}")


class BatchRunner:
    def __init__(self, urls: list[str], log_path: Path) -> None:
        self.urls = urls
        self.log_path = log_path
        self.backed_up = False
        self.skip_extract = False

    def log(self, message: str) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{now()}] {message}\n")

    def api(self, path: str, payload: dict | None = None, timeout: int = 30) -> dict:
        data = None
        method = "GET"
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            method = "POST"
        request = urllib.request.Request(
            BASE + path,
            data=data,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"ok": False, "message": raw or str(exc)}

    def wait_extract_idle(self) -> dict:
        while True:
            state = self.api("/api/state")
            if not (state.get("extract") or {}).get("active"):
                return state
            jobs = state.get("jobs") or []
            message = jobs[0].get("message", "") if jobs else ""
            self.log(f"采集中: {message}")
            time.sleep(10)

    def wait_download_quiet_and_stop(self) -> None:
        last_watchdog_key: tuple | None = None
        last_watchdog_at = time.monotonic()
        while True:
            state = self.api("/api/state")
            download = state.get("download") or {}
            if not download.get("active"):
                return
            jobs = state.get("jobs") or []
            active_job_id = download.get("job_id")
            job = next((item for item in jobs if item.get("id") == active_job_id), jobs[0] if jobs else {})
            message = job.get("message", "")
            inflight = int(download.get("inflight") or 0)
            if download.get("watch_new") and inflight == 0 and "等待新链接" in message:
                self.log("当前动态下载已进入等待新链接，停止它以切换作者")
                self.api("/api/download/stop", {})
                while (self.api("/api/state").get("download") or {}).get("active"):
                    time.sleep(2)
                return
            key = (
                job.get("id"),
                job.get("total"),
                job.get("processed"),
                job.get("success"),
                job.get("failed"),
            )
            now_mono = time.monotonic()
            if last_watchdog_key is None:
                last_watchdog_key = key
                last_watchdog_at = now_mono
            elif now_mono - last_watchdog_at >= DOWNLOAD_WATCHDOG_SECONDS:
                if key == last_watchdog_key:
                    self.stop_active_download(
                        f"等待已有下载时 10 分钟无进展，停止以便接管: job={active_job_id}, key={key}"
                    )
                    return
                self.log(f"等待已有下载 10 分钟检查通过，有进展: old={last_watchdog_key}, new={key}")
                last_watchdog_key = key
                last_watchdog_at = now_mono
            self.log(f"等待当前下载收尾: inflight={inflight} {message}")
            time.sleep(10)

    def save_current(self, url: str) -> None:
        result = self.api(
            "/api/settings",
            {
                "profile_url": url,
                "profile_tab": "post",
                "scrolls": str(EXTRACT_SCROLLS),
                "idle_rounds": str(EXTRACT_IDLE_ROUNDS),
                "concurrency": "2",
            },
        )
        if result.get("ok") is False:
            raise RuntimeError(result.get("message") or "保存设置失败")

    def start_extract(self, url: str) -> None:
        self.wait_extract_idle()
        self.save_current(url)
        result = self.api(
            "/api/extract/start",
            {
                "url": url,
                "profile_tab": "post",
                "max": 0,
                "scrolls": EXTRACT_SCROLLS,
                "idle_rounds": EXTRACT_IDLE_ROUNDS,
            },
        )
        if result.get("ok") is False:
            raise RuntimeError(result.get("message") or "采集启动失败")
        job_id = result.get("job_id")
        self.log(f"开始采集 #{job_id}: {url}")
        while True:
            state = self.api("/api/state")
            if not (state.get("extract") or {}).get("active"):
                job = next((item for item in state.get("jobs", []) if item.get("id") == job_id), None)
                status = job.get("status") if job else "unknown"
                message = job.get("message") if job else ""
                self.log(f"采集结束 #{job_id}: {status} {message}")
                return
            time.sleep(10)

    def profile_for(self, sec_uid: str) -> dict | None:
        state = self.api("/api/state")
        for profile in state.get("profiles") or []:
            if profile.get("sec_uid") == sec_uid and profile.get("tab") == "post":
                return profile
        return None

    def next_unfinished_profile(self) -> dict | None:
        state = self.api("/api/state")
        current_id = (state.get("current_profile") or {}).get("id")
        profiles = state.get("profiles") or []
        candidates = []
        for profile in profiles:
            if profile.get("tab") != "post":
                continue
            pending = int(profile.get("pending") or 0)
            downloading = int(profile.get("downloading") or 0)
            if pending + downloading <= 0:
                continue
            candidates.append(profile)
        if not candidates:
            return None
        current = next((profile for profile in candidates if profile.get("id") == current_id), None)
        if current:
            return current
        return candidates[0]

    def backup_fanhao_once(self) -> None:
        if self.backed_up:
            return
        backup = FANHAO_DB.with_name(
            FANHAO_DB.name + ".bak-target-merge-" + datetime.now().strftime("%Y%m%d-%H%M%S")
        )
        source = sqlite3.connect(FANHAO_DB)
        dest = sqlite3.connect(backup)
        source.backup(dest)
        dest.close()
        source.close()
        self.backed_up = True
        self.log(f"FanHao 合并前备份: {backup}")

    def merge_fanhao_target(self, sec_uid: str) -> None:
        con = sqlite3.connect(FANHAO_DB)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA busy_timeout=10000")
        rows = con.execute(
            """
            SELECT u.sec_uid, u.uid, u.nickname, COUNT(v.id) videos
            FROM short_video_users u
            LEFT JOIN short_videos v ON v.author_sec_uid=u.sec_uid
            WHERE u.sec_uid LIKE 'MS4w%'
              AND (? LIKE u.sec_uid || '%' OR u.sec_uid LIKE ? || '%')
            GROUP BY u.sec_uid, u.uid, u.nickname
            """,
            (sec_uid, sec_uid),
        ).fetchall()
        target = next((row for row in rows if row["sec_uid"] == sec_uid), None)
        if not target:
            con.close()
            return
        target_uid = (target["uid"] or "").strip()
        target_name = (target["nickname"] or "").strip()
        candidates: list[sqlite3.Row] = []
        for row in rows:
            short_sec = (row["sec_uid"] or "").strip()
            if short_sec == sec_uid or not sec_uid.startswith(short_sec):
                continue
            uid = (row["uid"] or "").strip()
            name = (row["nickname"] or "").strip()
            if len(short_sec) < 24:
                continue
            same_uid = bool(target_uid and uid == target_uid)
            same_name_missing_uid = bool(target_name and name == target_name and not uid)
            if same_uid or same_name_missing_uid:
                candidates.append(row)
        if not candidates:
            con.close()
            return

        self.backup_fanhao_once()
        timestamp = now()
        con.execute("BEGIN IMMEDIATE")
        updated = 0
        deleted = 0
        for row in candidates:
            short_sec = row["sec_uid"]
            cur = con.execute(
                """
                UPDATE short_videos
                SET author_sec_uid=?, owner_user_id=?, updated_at=?
                WHERE author_sec_uid=? OR owner_user_id=?
                """,
                (sec_uid, f"douyin:{sec_uid}", timestamp, short_sec, f"douyin:{short_sec}"),
            )
            updated += max(cur.rowcount or 0, 0)
            cur = con.execute(
                "DELETE FROM short_video_users WHERE sec_uid=? AND id<>?",
                (short_sec, f"douyin:{sec_uid}"),
            )
            deleted += max(cur.rowcount or 0, 0)
        con.commit()
        con.close()
        self.log(
            f"FanHao 归并 {target_name or sec_uid}: {len(candidates)} 个旧 sec_uid, "
            f"更新视频 {updated}, 删除作者 {deleted}"
        )

    def wait_download_inactive(self) -> None:
        while (self.api("/api/state").get("download") or {}).get("active"):
            time.sleep(2)

    def stop_active_download(self, reason: str) -> None:
        self.log(reason)
        self.api("/api/download/stop", {})
        self.wait_download_inactive()

    def start_download(self, url: str, sec_uid: str) -> None:
        self.wait_download_quiet_and_stop()
        restarts = 0
        while restarts <= MAX_DOWNLOAD_RESTARTS_PER_PROFILE:
            self.save_current(url)
            state_for_settings = self.api("/api/state")
            try:
                configured_concurrency = int(
                    (state_for_settings.get("settings") or {}).get("concurrency") or 6
                )
            except (TypeError, ValueError):
                configured_concurrency = 6
            configured_concurrency = max(1, min(configured_concurrency, 24))
            profile = self.profile_for(sec_uid)
            if profile:
                self.log(
                    f"准备下载 {profile.get('nickname') or sec_uid}: "
                    f"total={profile.get('total')} pending={profile.get('pending')} "
                    f"failed={profile.get('failed')} downloaded={profile.get('downloaded')} "
                    f"concurrency={configured_concurrency}"
                )
            result = self.api(
                "/api/download/start",
                {
                    "concurrency": configured_concurrency,
                    "retry_failed": restarts == 0,
                    "limit": 0,
                    "watch_new": False,
                },
            )
            if result.get("ok") is False:
                self.log(f"下载跳过/未启动 {sec_uid}: {result.get('message')}")
                return
            job_id = result.get("job_id")
            self.log(
                f"开始下载 #{job_id}: {sec_uid}, pending={result.get('pending')}, "
                f"run_total={result.get('run_total')}, restart={restarts}"
            )
            last_watchdog_key: tuple | None = None
            last_watchdog_at = time.monotonic()
            restart_needed = False
            while True:
                state = self.api("/api/state")
                download = state.get("download") or {}
                if not download.get("active"):
                    job = next((item for item in state.get("jobs", []) if item.get("id") == job_id), None)
                    status = job.get("status") if job else "unknown"
                    message = job.get("message") if job else ""
                    self.log(f"下载结束 #{job_id}: {status} {message}")
                    return
                jobs = state.get("jobs") or []
                active_job_id = download.get("job_id")
                job = next((item for item in jobs if item.get("id") == active_job_id), jobs[0] if jobs else {})
                key = (
                    job.get("id"),
                    job.get("total"),
                    job.get("processed"),
                    job.get("success"),
                    job.get("failed"),
                )
                self.log(
                    f"下载中 #{active_job_id}: {job.get('message', '')} "
                    f"processed={job.get('processed')} success={job.get('success')} failed={job.get('failed')} "
                    f"inflight={(download or {}).get('inflight')}"
                )
                now_mono = time.monotonic()
                if last_watchdog_key is None:
                    last_watchdog_key = key
                    last_watchdog_at = now_mono
                elif now_mono - last_watchdog_at >= DOWNLOAD_WATCHDOG_SECONDS:
                    if key == last_watchdog_key:
                        self.stop_active_download(
                            f"10 分钟无进展，重启当前作者下载: {sec_uid}, job={active_job_id}, key={key}"
                        )
                        restart_needed = True
                        restarts += 1
                        break
                    self.log(f"10 分钟检查通过，有进展: old={last_watchdog_key}, new={key}")
                    last_watchdog_key = key
                    last_watchdog_at = now_mono
                time.sleep(20)
            if not restart_needed:
                return
        self.log(f"下载重启超过上限，跳过当前作者: {sec_uid}")

    def run(self) -> None:
        targets: list[tuple[str, str]] = []
        seen: set[str] = set()
        for url in self.urls:
            sec_uid = sec_from_url(url)
            if sec_uid in seen:
                continue
            seen.add(sec_uid)
            targets.append((url, sec_uid))

        self.log(f"批量作者采集下载开始: {len(targets)} 个主页")
        if not self.skip_extract:
            for url, sec_uid in targets:
                try:
                    self.start_extract(url)
                    self.merge_fanhao_target(sec_uid)
                except Exception as exc:
                    self.log(f"采集失败 {sec_uid}: {exc}")
        else:
            self.log("跳过采集阶段，只继续下载")
        for url, sec_uid in targets:
            try:
                self.start_download(url, sec_uid)
                self.merge_fanhao_target(sec_uid)
            except Exception as exc:
                self.log(f"下载流程失败 {sec_uid}: {exc}")
        self.log("批量作者采集下载结束")

    def run_extract_only(self) -> None:
        targets: list[tuple[str, str]] = []
        seen: set[str] = set()
        for url in self.urls:
            sec_uid = sec_from_url(url)
            if sec_uid in seen:
                continue
            seen.add(sec_uid)
            targets.append((url, sec_uid))

        self.log(f"批量作者只采集开始: {len(targets)} 个主页")
        for url, sec_uid in targets:
            try:
                self.start_extract(url)
                self.merge_fanhao_target(sec_uid)
            except Exception as exc:
                self.log(f"采集失败 {sec_uid}: {exc}")
        self.log("批量作者只采集结束")

    def run_auto_unfinished(self) -> None:
        self.log("自动未完成主页下载守护开始：扫描所有 post 主页，不使用写死 URL")
        quiet_logged_at = 0.0
        while True:
            try:
                self.wait_download_quiet_and_stop()
                profile = self.next_unfinished_profile()
                if not profile:
                    if time.monotonic() - quiet_logged_at > DOWNLOAD_WATCHDOG_SECONDS:
                        self.log("当前没有未完成的作者作品主页，继续等待新入库主页")
                        quiet_logged_at = time.monotonic()
                    time.sleep(AUTO_POLL_SECONDS)
                    continue
                url = profile.get("url") or f"https://www.douyin.com/user/{profile.get('sec_uid')}"
                sec_uid = profile.get("sec_uid") or sec_from_url(url)
                self.log(
                    f"自动切换到未完成主页 #{profile.get('id')} {profile.get('nickname') or sec_uid}: "
                    f"pending={profile.get('pending')} downloading={profile.get('downloading')} "
                    f"downloaded={profile.get('downloaded')} failed={profile.get('failed')}"
                )
                self.start_download(url, sec_uid)
                self.merge_fanhao_target(sec_uid)
            except KeyboardInterrupt:
                self.log("自动未完成主页下载守护停止")
                raise
            except Exception as exc:
                self.log(f"自动未完成主页下载守护异常：{exc}")
                time.sleep(AUTO_POLL_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True)
    parser.add_argument("--skip-extract", action="store_true")
    parser.add_argument("--extract-only", action="store_true")
    parser.add_argument("--auto-unfinished", action="store_true")
    parser.add_argument("urls", nargs="*")
    args = parser.parse_args()
    runner = BatchRunner(args.urls, Path(args.log))
    runner.skip_extract = bool(args.skip_extract)
    if args.auto_unfinished:
        runner.run_auto_unfinished()
    elif args.extract_only:
        if not args.urls:
            parser.error("需要传入主页 URL")
        runner.run_extract_only()
    else:
        if not args.urls:
            parser.error("需要传入主页 URL，或使用 --auto-unfinished")
        runner.run()


if __name__ == "__main__":
    main()
