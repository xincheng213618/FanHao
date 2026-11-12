"""Recover verified D-drive videos left with a 115Chrome download suffix."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import struct
import subprocess
import sys
from time import monotonic, sleep
from typing import NamedTuple


ROOT = Path("D:/")
CORE_DB = Path(__file__).resolve().parents[1] / "data" / "fanhao-core-v2.sqlite"
SUFFIX = re.compile(r"\.115chrome_(\d+)_\d+$", re.I)
FORMATS = {".mp4": "mp4", ".mkv": "matroska"}


class Download(NamedTuple):
    target: str
    received: int
    total: int
    state: int
    reason: int


class Candidate(NamedTuple):
    source: Path
    target: Path
    signature: tuple


def checked_command(args, timeout, allowed=(0,)):
    process = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, encoding="utf-8",
                             errors="replace", timeout=timeout)
    if process.returncode not in allowed or process.stderr.strip():
        raise ValueError(process.stderr.strip().splitlines()[0][:350] if process.stderr.strip()
                         else f"exit {process.returncode}")
    return process.stdout


def scan():
    output = checked_command(["rg", "--files", "--hidden", "--no-ignore", "-0", "-g", "*.115chrome_*",
                              "-g", "!$RECYCLE.BIN", "-g", "!System Volume Information", str(ROOT)], 60, (0, 1))
    return sorted(Path(name) for name in output.split("\0") if name and SUFFIX.search(Path(name).name))


def history_snapshot_marker(history):
    wal = Path(str(history) + "-wal")
    try:
        if wal.stat().st_size:
            return None
    except FileNotFoundError:
        pass
    # SQLite can retain the rollback journal after commit with a zeroed header.
    journal = Path(str(history) + "-journal")
    try:
        with journal.open("rb") as stream:
            if any(stream.read(8)):
                return None
    except FileNotFoundError:
        pass
    with history.open("rb") as stream:
        header = stream.read(100)
    if len(header) != 100 or header[18:20] != b"\x01\x01":
        return None
    return header, history.stat().st_mtime_ns


def read_history(history):
    def read(uri):
        with closing(sqlite3.connect(uri, uri=True, timeout=0.2)) as db:
            return {row[0]: Download(*row[1:]) for row in db.execute(
                "SELECT id,target_path,received_bytes,total_bytes,state,interrupt_reason FROM downloads WHERE target_path LIKE ?",
                (str(ROOT) + "%",))}

    uri = history.as_uri() + "?mode=ro"
    try:
        return read(uri)
    except sqlite3.OperationalError as error:
        if "locked" not in str(error).lower():
            raise
    # Check the journal and database header on both sides of the immutable read.
    deadline = monotonic() + 30
    while monotonic() < deadline:
        before = history_snapshot_marker(history)
        if before is not None:
            try:
                jobs = read(uri + "&immutable=1")
            except sqlite3.DatabaseError:
                if history_snapshot_marker(history) == before:
                    raise
            else:
                if history_snapshot_marker(history) == before:
                    return jobs
        sleep(0.25)
    raise ValueError("115 HistoryEx 正在写入，请稍后再试")


def file_signature(file):
    if not file.is_absolute() or not file.is_relative_to(ROOT) or ".." in file.parts:
        raise ValueError("路径不在 D 盘")
    for parent in file.parents:
        if parent.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("父目录是链接或挂载点")
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError("路径不是普通文件")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def candidate(file, jobs):
    match = SUFFIX.search(file.name)
    target = file.with_name(file.name[:match.start()])
    job_id = int(match[1])
    if target.suffix.lower() not in FORMATS:
        raise ValueError("仅支持 MP4 和 MKV 视频")
    if os.path.lexists(str(file) + ".cfg"):
        raise ValueError("仍有下载标记（.cfg）")
    task = jobs.get(job_id)
    if not task or not task.target or target != Path(task.target):
        raise ValueError("115 任务记录缺失或目标路径不一致")
    if task.state == 0:
        raise ValueError("115 任务仍在下载或暂停")
    signature = file_signature(file)
    if (task.state, task.reason) not in {(1, 0), (4, 107555)} or not 0 < task.received == task.total == signature[2]:
        raise ValueError("115 任务状态或字节数未通过核对")
    if os.path.lexists(target):
        raise ValueError("原文件名已存在")
    if any(key != job_id and job.state == 0 and job.target and target == Path(job.target) for key, job in jobs.items()):
        raise ValueError("同名目标仍有活动的 115 任务")
    return Candidate(file, target, signature)


def check_mp4_boxes(file, size):
    kinds = set()
    with file.open("rb") as stream:
        offset = 0
        while offset < size:
            header = stream.read(8)
            if len(header) != 8:
                raise ValueError("MP4 数据块头截断")
            length, kind = struct.unpack(">I4s", header)
            minimum = 8
            if length == 1:
                extended = stream.read(8)
                if len(extended) != 8:
                    raise ValueError("MP4 扩展块长度截断")
                length, = struct.unpack(">Q", extended)
                minimum = 16
            elif length == 0:
                length = size - offset
            if not minimum <= length <= size - offset:
                raise ValueError("MP4 数据块长度超出文件边界")
            kinds.add(kind)
            offset += length
            stream.seek(offset)
    if not {b"ftyp", b"moov", b"mdat"}.issubset(kinds):
        raise ValueError("MP4 缺少必要数据块")


def verify(item):
    file = item.source
    size = item.signature[2]
    if file_signature(file) != item.signature:
        raise ValueError("视频在校验前已改变")
    expected = FORMATS[item.target.suffix.lower()]
    if expected == "mp4":
        check_mp4_boxes(file, size)
    info = json.loads(checked_command(["ffprobe", "-v", "error", "-show_entries",
        "format=format_name,duration,size:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic",
        "-of", "json", "-i", str(file)], 45))
    video = next((s for s in info["streams"] if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    duration = float(info["format"]["duration"])
    if (not video or not video.get("width") or not video.get("height")
            or not any(s["codec_type"] == "audio" for s in info["streams"])
            or not math.isfinite(duration) or not 0 < duration < 86400
            or expected not in info["format"]["format_name"].split(",") or int(info["format"]["size"]) != size):
        raise ValueError("容器、音视频流、时长或大小未通过检查")
    base = ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode"]
    maps = ["-map", "0:V:0", "-map", "0:a"]
    video_filter = {"h264": "h264_mp4toannexb", "hevc": "hevc_mp4toannexb"}.get(video["codec_name"])
    bsf = ["-bsf:v", video_filter] if video_filter else []
    checked_command(base + ["-i", str(file)] + maps + ["-c:v", "copy"] + bsf + ["-c:a", "pcm_s16le", "-f", "null", "NUL"], 600)
    for fraction in (0, .25, .5, .75, 1):
        start = min(duration * fraction, max(0, duration - 4))
        # Keep the input time base so the null muxer does not round distinct decoded timestamps together.
        progress = checked_command(base + ["-threads", "3", "-ss", f"{start:.3f}", "-t", "3", "-i", str(file)]
                                   + maps + ["-vsync", "0", "-enc_time_base:v", "-1", "-progress", "pipe:1", "-f", "null", "NUL"], 60)
        frames = re.findall(r"^frame=\s*(\d+)", progress, re.M)
        if not frames or int(frames[-1]) == 0:
            raise ValueError("抽样位置没有可解码的视频帧")
    if file_signature(file) != item.signature or os.path.lexists(str(file) + ".cfg"):
        raise ValueError("校验过程中视频或下载状态发生变化")


def protected_paths():
    paths, packages = set(), set()
    with closing(sqlite3.connect(CORE_DB.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
        paths.update(Path(row[0]) for row in db.execute("SELECT file_path FROM local_files WHERE file_path LIKE ?", ("D:%",)) if row[0])
        tables = {name for name, in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
        if "media_intake_jobs" in tables:
            for stored, in db.execute("SELECT plan_json FROM media_intake_jobs WHERE state IN ('prepared','working','committed','blocked') OR owner<>''"):
                plan = json.loads(stored)
                for entry in [plan, *plan.get("files", [])]:
                    paths.update(Path(entry[key]) for key in ("source", "target") if entry.get(key))
                folder = (plan.get("bundle") or {}).get("folder")
                if folder:
                    packages.add(Path(folder))
    return paths, packages


def assert_unclaimed(item, protected, packages):
    if item.source in protected or item.target in protected or any(item.source.is_relative_to(folder) for folder in packages):
        raise ValueError("路径在 FanHao 索引或洗版任务中")


def apply_verified(item, jobs, protected, packages):
    assert_unclaimed(item, protected, packages)
    if candidate(item.source, jobs) != item:
        raise ValueError("校验后文件身份或目标发生变化")
    # Windows rename rejects an existing destination, even if it appeared after preflight.
    item.source.rename(item.target)
    if os.path.lexists(item.source) or file_signature(item.target)[:4] != item.signature[:4]:
        raise RuntimeError(f"改名后身份核对失败，请检查 {item.target}")


def report(status, path, detail=""):
    code = re.search(r"[A-Z]{2,}-\d{2,5}", path.name, re.I)
    print(f"{status} {code[0].upper() if code else path.name} {detail}".rstrip(), flush=True)


def restore(item, history):
    try:
        jobs = read_history(history)
        protected, packages = protected_paths()
        apply_verified(item, jobs, protected, packages)
    except (OSError, ValueError, sqlite3.Error) as error:
        report("暂缓改名", item.source, str(error))
        return False
    report("已恢复", item.target)
    return True


def recover(history, apply):
    checked, verified = set(), set()
    restored = []
    failures = set()
    for _ in range(2 if apply else 1):
        jobs = read_history(history)
        protected, packages = protected_paths()
        pending = []
        for file in scan():
            try:
                item = candidate(file, jobs)
                assert_unclaimed(item, protected, packages)
            except (OSError, ValueError) as error:
                report("跳过", file, str(error))
                continue
            if apply and item in verified:
                if restore(item, history):
                    restored.append(item)
            elif item not in checked:
                pending.append(item)
                checked.add(item)
        print(f"校验 {len(pending)} 个视频", flush=True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            requests = {pool.submit(verify, item): item for item in pending}
            for future in as_completed(requests):
                item = requests[future]
                try:
                    future.result()
                except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
                    report("校验失败", item.source, str(error))
                    failures.add(item.source)
                else:
                    report("校验通过", item.source)
                    verified.add(item)
                    if apply and restore(item, history):
                        restored.append(item)
    remaining = scan()
    result = restored if apply else verified
    total = sum(item.signature[2] for item in result)
    print(f"{'已恢复' if apply else '可恢复'} {len(result)} 个，{total / 2**30:.2f} GiB。仍带后缀 {len(remaining)} 个，其中校验失败 {len(failures.intersection(remaining))} 个。", flush=True)


def main():
    parser = argparse.ArgumentParser(description="校验 D 盘的 115Chrome 临时视频后缀。默认只检查。")
    parser.add_argument("--apply", action="store_true", help="在检查通过后原地恢复文件名")
    args = parser.parse_args()
    if os.name != "nt" or not all(shutil.which(tool) for tool in ("rg", "ffprobe", "ffmpeg")):
        parser.error("需要 Windows、rg、ffprobe 和 ffmpeg")
    history = Path(os.environ["LOCALAPPDATA"]) / "115Chrome" / "User Data" / "Default" / "HistoryEx"
    try:
        recover(history, args.apply)
    except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.TimeoutExpired) as error:
        print(f"已停止：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
