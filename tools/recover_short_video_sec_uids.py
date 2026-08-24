"""Recover full Douyin sec_uid values for truncated author directory names.

This utility is read-only with respect to media and SQLite databases.  It writes
only a small resumable progress JSON and a completed mapping report.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import random
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MEDIA_ROOT = Path(r"D:\Media\ShortVideos")
DEFAULT_REPORT = PROJECT_ROOT / "logs" / "short-video-secuid-migration-map-20260824-final.json"
DEFAULT_PROGRESS = PROJECT_ROOT / "logs" / "short-video-secuid-online-recovery-progress-20260824.json"
DEFAULT_OUTPUT = PROJECT_ROOT / "logs" / "short-video-secuid-migration-map-20260824-online-recovered.json"
FANHAO_DB = PROJECT_ROOT / "data" / "short-videos.sqlite"
MANAGER_DB = (
    PROJECT_ROOT
    / "src"
    / "modules"
    / "short-videos"
    / "download-manager"
    / "data"
    / "douyin_downloads.sqlite"
)
DOWNLOADER_ROOT = (
    PROJECT_ROOT / "src" / "modules" / "short-videos" / "download-manager" / "downloader"
)
COOKIE_JSON = (
    PROJECT_ROOT
    / "src"
    / "modules"
    / "short-videos"
    / "download-manager"
    / "data"
    / "configs"
    / ".cookies.json"
)
SIDECAR_CONFIG = (
    PROJECT_ROOT
    / "src"
    / "modules"
    / "short-videos"
    / "download-manager"
    / "data"
    / "configs"
    / "sidecar.yml"
)

AWEME_RE = re.compile(r"(?<!\d)(\d{15,20})(?!\d)")
SEC_UID_RE = re.compile(r"^MS4wLjAB[A-Za-z0-9_-]+$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--root", type=Path, default=MEDIA_ROOT)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--request-delay", type=float, default=0.35)
    parser.add_argument("--build-only", action="store_true")
    return parser.parse_args()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def normalized_root(root: Path) -> str:
    return str(root.resolve()).replace("\\", "/").rstrip("/").casefold()


def top_directory_from_path(value: str, root_key: str) -> str:
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        return ""
    folded = text.casefold()
    prefix = root_key + "/"
    if folded.startswith(prefix):
        return text[len(prefix) :].split("/", 1)[0]
    if re.match(r"^[A-Za-z]:/", text) or text.startswith("//"):
        return ""
    while text.startswith("./"):
        text = text[2:]
    return text.split("/", 1)[0]


def add_ids(target: dict[str, list[str]], source_name: str, values: Iterable[Any]) -> None:
    rows = target[source_name]
    seen = set(rows)
    for value in values:
        text = str(value or "").strip()
        if not AWEME_RE.fullmatch(text) or text in seen:
            continue
        rows.append(text)
        seen.add(text)


def collect_candidates(
    unresolved: list[dict[str, Any]], root: Path
) -> dict[str, list[str]]:
    candidates: dict[str, list[str]] = defaultdict(list)
    by_folded = {str(row["source_name"]).casefold(): str(row["source_name"]) for row in unresolved}
    root_key = normalized_root(root)

    uri = f"file:{FANHAO_DB.as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        for video_id, aweme_id, source_path in connection.execute(
            "SELECT id, aweme_id, source_path FROM short_videos"
        ):
            top = top_directory_from_path(str(source_path or ""), root_key)
            source_name = by_folded.get(top.casefold())
            if source_name:
                add_ids(candidates, source_name, (aweme_id, video_id))

    manager_uri = f"file:{MANAGER_DB.as_posix()}?mode=ro"
    with sqlite3.connect(manager_uri, uri=True) as connection:
        for aweme_id, preview_path, local_paths in connection.execute(
            "SELECT aweme_id, preview_path, local_file_paths FROM links"
        ):
            path_values: list[str] = [str(preview_path or "")]
            try:
                parsed = json.loads(local_paths) if local_paths else []
                if isinstance(parsed, list):
                    path_values.extend(str(item or "") for item in parsed)
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
            matched_names = {
                by_folded[top_directory_from_path(item, root_key).casefold()]
                for item in path_values
                if top_directory_from_path(item, root_key).casefold() in by_folded
            }
            for source_name in matched_names:
                add_ids(candidates, source_name, (aweme_id,))

    for row in unresolved:
        source_name = str(row["source_name"])
        author_dir = root / source_name
        if not author_dir.is_dir():
            continue
        discovered: list[str] = []
        for child in author_dir.iterdir():
            discovered.extend(AWEME_RE.findall(child.name))
            if child.is_dir():
                try:
                    for nested in child.iterdir():
                        discovered.extend(AWEME_RE.findall(nested.name))
                except OSError:
                    pass
        add_ids(candidates, source_name, discovered)

    return dict(candidates)


def valid_recovery(sec_uid: str, suffix: str) -> bool:
    # The historic author folder was passed through sanitize_filename(), which
    # collapses consecutive underscores before truncating to 80 characters.
    # Compare against that canonical folder form while retaining the untouched
    # API value as the new directory name.
    folder_form = re.sub(r"_+", "_", sec_uid).strip("._- ")
    return (
        bool(SEC_UID_RE.fullmatch(sec_uid))
        and len(sec_uid) in {55, 76}
        and folder_form.startswith(suffix)
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def recover_all(
    unresolved: list[dict[str, Any]],
    candidates: dict[str, list[str]],
    progress_path: Path,
    concurrency: int,
    request_delay: float,
) -> dict[str, Any]:
    if progress_path.exists():
        progress = load_json(progress_path)
    else:
        progress = {
            "started_at": utc_now(),
            "updated_at": utc_now(),
            "total": len(unresolved),
            "completed": 0,
            "succeeded": 0,
            "failed": 0,
            "results": {},
        }
    results: dict[str, Any] = dict(progress.get("results") or {})
    # Accept the richer checkpoint format produced by the initial recovery
    # audit.  Besides its confirmed successes, salvage API responses that were
    # rejected only because the old sanitizer collapsed a double underscore.
    legacy_completed = progress.get("completed")
    if not results and isinstance(legacy_completed, dict):
        for source_name, value in legacy_completed.items():
            if not isinstance(value, dict):
                continue
            suffix = str(value.get("suffix") or "")
            sec_uid = str(value.get("sec_uid") or "")
            aweme_id = str(value.get("aweme_id") or "")
            if not valid_recovery(sec_uid, suffix):
                for attempt in value.get("attempts") or []:
                    candidate = str(attempt.get("returned_sec_uid") or "")
                    if valid_recovery(candidate, suffix):
                        sec_uid = candidate
                        aweme_id = str(attempt.get("aweme_id") or "")
                        break
            if valid_recovery(sec_uid, suffix):
                results[str(source_name)] = {
                    "sec_uid": sec_uid,
                    "aweme_id": aweme_id,
                    "suffix": suffix,
                    "attempted": [aweme_id] if aweme_id else [],
                    "errors": [],
                    "updated_at": str(value.get("finished_at") or utc_now()),
                }
    semaphore = asyncio.Semaphore(max(1, min(8, concurrency)))
    write_lock = asyncio.Lock()
    counter_lock = asyncio.Lock()
    completed_this_run = 0

    sys.path.insert(0, str(DOWNLOADER_ROOT))
    from core.api_client import DouyinAPIClient  # pylint: disable=import-outside-toplevel

    from config import ConfigLoader  # pylint: disable=import-outside-toplevel

    runtime_config = ConfigLoader(str(SIDECAR_CONFIG))
    cookies = runtime_config.get_cookies()
    proxy = runtime_config.get("proxy")
    request_lock = asyncio.Lock()
    last_request_at = 0.0

    async def fetch_detail(client: Any, aweme_id: str) -> Any:
        nonlocal last_request_at
        async with request_lock:
            loop = asyncio.get_running_loop()
            remaining = request_delay - (loop.time() - last_request_at)
            if remaining > 0:
                await asyncio.sleep(remaining)
            try:
                return await asyncio.wait_for(
                    client.get_video_detail(aweme_id, suppress_error=True),
                    timeout=30.0,
                )
            finally:
                last_request_at = loop.time()

    async def checkpoint(force: bool = False) -> None:
        nonlocal completed_this_run
        async with write_lock:
            if not force and completed_this_run % 25:
                return
            successes = sum(1 for value in results.values() if value.get("sec_uid"))
            progress.update(
                {
                    "updated_at": utc_now(),
                    "total": len(unresolved),
                    "completed": len(results),
                    "succeeded": successes,
                    "failed": len(results) - successes,
                    "results": results,
                }
            )
            atomic_write_json(progress_path, progress)

    async with DouyinAPIClient(cookies, proxy=proxy) as client:

        async def recover_one(row: dict[str, Any]) -> None:
            nonlocal completed_this_run
            source_name = str(row["source_name"])
            if source_name in results and results[source_name].get("sec_uid"):
                return
            suffix = str(row.get("suffix") or "")
            attempted: list[str] = []
            errors: list[str] = []
            recovered = ""
            recovered_aweme_id = ""
            candidate_ids = candidates.get(source_name, [])[:8]
            for pass_index in range(2):
                if pass_index:
                    await asyncio.sleep(2.0 + random.random())
                for aweme_id in candidate_ids:
                    attempted.append(aweme_id)
                    try:
                        async with semaphore:
                            detail = await fetch_detail(client, aweme_id)
                        author = detail.get("author") if isinstance(detail, dict) else None
                        sec_uid = (
                            str(author.get("sec_uid") or "")
                            if isinstance(author, dict)
                            else ""
                        )
                        if valid_recovery(sec_uid, suffix):
                            recovered = sec_uid
                            recovered_aweme_id = aweme_id
                            break
                        if sec_uid:
                            errors.append(f"{aweme_id}:sec_uid_prefix_mismatch:{sec_uid}")
                        else:
                            errors.append(f"{aweme_id}:detail_unavailable")
                    except Exception as exc:  # network/API boundary
                        errors.append(f"{aweme_id}:{type(exc).__name__}:{exc}")
                if recovered:
                    break
            results[source_name] = {
                "sec_uid": recovered,
                "aweme_id": recovered_aweme_id,
                "suffix": suffix,
                "attempted": attempted,
                "errors": errors[-8:],
                "updated_at": utc_now(),
            }
            async with counter_lock:
                completed_this_run += 1
                current = len(results)
                if current % 25 == 0 or current == len(unresolved):
                    success_count = sum(1 for value in results.values() if value.get("sec_uid"))
                    print(
                        f"online recovery {current}/{len(unresolved)} "
                        f"success={success_count} failed={current - success_count}",
                        flush=True,
                    )
            await checkpoint()

        tasks = [
            asyncio.create_task(recover_one(row))
            for row in unresolved
            if not results.get(str(row["source_name"]), {}).get("sec_uid")
        ]
        for task in asyncio.as_completed(tasks):
            await task
    await checkpoint(force=True)
    return progress


def build_completed_report(
    original: dict[str, Any], progress: dict[str, Any], root: Path
) -> dict[str, Any]:
    report = copy.deepcopy(original)
    results = progress.get("results") or {}
    existing_names = {str(row["source_name"]) for row in report.get("mappings") or []}
    remaining: list[dict[str, Any]] = []
    recovered_count = 0
    for row in report.get("unresolved") or []:
        source_name = str(row["source_name"])
        recovered = results.get(source_name) or {}
        sec_uid = str(recovered.get("sec_uid") or "")
        if not sec_uid:
            remaining.append(row)
            continue
        recovered_count += 1
        if source_name not in existing_names:
            report["mappings"].append(
                {
                    "source_name": source_name,
                    "sec_uid": sec_uid,
                    "evidence": [
                        f"directory_suffix:{row.get('suffix') or ''}",
                        f"online_aweme_detail:{recovered.get('aweme_id') or ''}",
                    ],
                    "resolution": "online_aweme_detail",
                    "warnings": [],
                    "secondary_entry_count": sum(
                        1 for item in (root / source_name).iterdir() if item.is_dir()
                    ),
                }
            )
            existing_names.add(source_name)
    report["mappings"].sort(key=lambda item: str(item["source_name"]).casefold())
    report["unresolved"] = remaining
    report["generated_at"] = utc_now()

    grouped: dict[str, list[str]] = defaultdict(list)
    for item in report["mappings"]:
        grouped[str(item["sec_uid"])].append(str(item["source_name"]))
    merge_groups = [names for names in grouped.values() if len(names) > 1]
    summary = report.setdefault("summary", {})
    summary.update(
        {
            "resolved": len(report["mappings"]),
            "unresolved": len(remaining),
            "target_sec_uids": len(grouped),
            "merge_groups": len(merge_groups),
            "source_directories_in_merge_groups": sum(len(names) for names in merge_groups),
            "top_directories_eliminated": sum(len(names) - 1 for names in merge_groups),
            "online_recovery": {
                "recovered": recovered_count,
                "failed": len(remaining),
                "progress_file": str(DEFAULT_PROGRESS),
            },
        }
    )
    counts = summary.setdefault("resolution_counts", {})
    counts["online_aweme_detail"] = recovered_count
    return report


async def async_main(args: argparse.Namespace) -> int:
    root = args.root.resolve()
    if str(root).casefold() != str(MEDIA_ROOT.resolve()).casefold():
        raise RuntimeError(f"本工具只允许处理 {MEDIA_ROOT}，实际收到 {root}")
    report = load_json(args.report)
    if str(Path(report.get("root") or "").resolve()).casefold() != str(root).casefold():
        raise RuntimeError("报告 root 与媒体根目录不一致")
    unresolved = list(report.get("unresolved") or [])
    if args.build_only:
        progress = load_json(args.progress)
        if not isinstance(progress.get("results"), dict):
            raise RuntimeError("断点文件不是当前 results 格式，无法只构建报告")
        completed = build_completed_report(report, progress, root)
        atomic_write_json(args.output, completed)
        print(
            f"completed_report={args.output} "
            f"remaining_unresolved={len(completed.get('unresolved') or [])}",
            flush=True,
        )
        return 0
    if args.limit:
        unresolved = unresolved[: max(0, args.limit)]
    candidates = collect_candidates(unresolved, root)
    without_candidates = [row["source_name"] for row in unresolved if not candidates.get(row["source_name"])]
    print(
        f"unresolved={len(unresolved)} candidate_dirs={len(unresolved) - len(without_candidates)} "
        f"without_candidates={len(without_candidates)}",
        flush=True,
    )
    progress = await recover_all(
        unresolved,
        candidates,
        args.progress,
        args.concurrency,
        max(0.0, args.request_delay),
    )
    completed = build_completed_report(report, progress, root)
    atomic_write_json(args.output, completed)
    remaining = len(completed.get("unresolved") or [])
    print(f"completed_report={args.output} remaining_unresolved={remaining}", flush=True)
    return 0 if remaining == 0 else 2


def main() -> int:
    return asyncio.run(async_main(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
