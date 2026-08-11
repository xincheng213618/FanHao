from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import py7zr
import rarfile


DEFAULT_INPUT_ROOT = Path("D:/")
DEFAULT_LIBRARY_ROOT = Path(r"T:\微密圈")
DEFAULT_REPORT = DEFAULT_LIBRARY_ROOT / "_catalog" / "latest.json"
DEFAULT_LEGACY_CSV = Path.home() / "Desktop" / "Tool" / "data" / "artfilepath.csv"
DEFAULT_LEGACY_UNZIP = Path.home() / "Desktop" / "Tool" / "unzip.py"
DEFAULT_STAGING_ROOT = Path(r"D:\Taotu\.staging")
DEFAULT_MANIFEST_ROOT = Path(r"D:\Taotu\manifests")
DEFAULT_WINRAR = Path(r"C:\Program Files\WinRAR\WinRAR.exe")
DEFAULT_UNRAR = Path(r"C:\Program Files\WinRAR\UnRAR.exe")

ROOT_RE = re.compile(r"^(?P<number>\d+)[A-Za-z]?$")
LOCAL_NO_RE = re.compile(r"(?i)\bNO[.\s_-]*(\d+)")
LOCAL_PREFIX_RE = re.compile(r"^\s*(\d{1,4})(?=\.)")
TRAILING_COPY_RE = re.compile(r"\(\d+\)$")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
VIDEO_EXTENSIONS = {
    ".mp4",
    ".m4v",
    ".mov",
    ".avi",
    ".mkv",
    ".wmv",
    ".flv",
    ".webm",
    ".ts",
    ".m2ts",
    ".iso",
}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
JUNK_EXTENSIONS = {".url", ".txt"}


class ImportSafetyError(RuntimeError):
    pass


@dataclass(frozen=True)
class SourceArchive:
    root_name: str
    code_number: int
    sequence: int
    path: Path
    size: int
    mtime_ns: int
    duplicate_paths: tuple[str, ...] = ()


@dataclass
class RootPlan:
    root_name: str
    legacy_code: str
    post_id: str
    status: str
    destination_name: str
    destination: Path
    source_count: int
    unique_source_count: int
    duplicate_count: int
    existing_rar_count: int
    existing_sequence_count: int
    overlap_count: int
    candidate_count: int
    source_sequences: list[int] = field(default_factory=list)
    existing_sequences: list[int] = field(default_factory=list)
    duplicate_files: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ImportTask:
    root_name: str
    legacy_code: str
    post_id: str
    destination_name: str
    destination: Path
    sequence: int
    source_path: Path
    source_size: int
    source_mtime_ns: int


@dataclass
class ImportResult:
    root_name: str
    legacy_code: str
    post_id: str
    sequence: int
    source_path: str
    destination: str
    status: str
    rar_path: str = ""
    bytes: int = 0
    image_count: int = 0
    conflict_path: str = ""
    error: str = ""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def natural_key(value: str) -> list[object]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        stream.write(serialized)
        temp_path = Path(stream.name)
    try:
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def parse_root_number(name: str) -> int:
    match = ROOT_RE.fullmatch(name.strip())
    if not match:
        raise ImportSafetyError(f"下载目录名不是编号格式: {name}")
    return int(match.group("number"))


def parse_source_sequence(path: Path, code_number: int) -> int:
    pattern = re.compile(rf"(?i)^B{code_number}(\d+)(?:\(\d+\))?$", re.IGNORECASE)
    match = pattern.fullmatch(path.stem)
    if not match:
        raise ImportSafetyError(f"7z 文件名与目录编号不匹配: {path}")
    return int(match.group(1))


def parse_local_sequence(name: str) -> int | None:
    match = LOCAL_NO_RE.search(name) or LOCAL_PREFIX_RE.match(name)
    return int(match.group(1)) if match else None


def normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.abspath(os.path.realpath(path)))


def require_within(path: Path, root: Path, label: str) -> Path:
    resolved_path = os.path.abspath(os.path.realpath(path))
    resolved_root = os.path.abspath(os.path.realpath(root))
    try:
        common = os.path.commonpath([resolved_path, resolved_root])
    except ValueError as error:
        raise ImportSafetyError(f"{label} 不在允许根目录内: {path}") from error
    if os.path.normcase(common) != os.path.normcase(resolved_root):
        raise ImportSafetyError(f"{label} 不在允许根目录内: {path}")
    return Path(resolved_path)


def safe_remove_tree(path: Path, root: Path) -> None:
    resolved = require_within(path, root, "临时目录")
    if normalized_path(resolved) == normalized_path(root):
        raise ImportSafetyError("拒绝删除 staging 根目录")
    if resolved.exists():
        def clear_readonly_and_retry(function, failing_path, error) -> None:
            if not isinstance(error, PermissionError):
                raise error
            safe_path = require_within(Path(failing_path), resolved, "只读临时文件")
            safe_path.chmod(safe_path.stat().st_mode | stat.S_IWRITE)
            function(failing_path)

        shutil.rmtree(resolved, onexc=clear_readonly_and_retry)


def load_legacy_password(legacy_unzip: Path, env_name: str) -> str:
    from_env = os.environ.get(env_name, "").strip()
    if from_env:
        return from_env
    if not legacy_unzip.is_file():
        raise ImportSafetyError(f"找不到密码来源脚本: {legacy_unzip}")
    tree = ast.parse(legacy_unzip.read_text(encoding="utf-8"), filename=str(legacy_unzip))
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if not any(isinstance(target, ast.Name) and target.id == "DEFAULT_PASSWORD" for target in targets):
            continue
        value = node.value
        if isinstance(value, ast.Constant) and isinstance(value.value, str) and value.value:
            return value.value
    raise ImportSafetyError("旧 unzip.py 中没有可读取的 DEFAULT_PASSWORD")


def read_legacy_rows(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise ImportSafetyError(f"找不到旧映射 CSV: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def legacy_row_for_code(rows: list[dict[str, str]], code_number: int) -> dict[str, str]:
    matches: list[dict[str, str]] = []
    for row in rows:
        code = str(row.get("Girl Nums") or "")
        number_match = re.search(r"\d+", code)
        if number_match and int(number_match.group()) == code_number:
            matches.append(row)
    if len(matches) != 1:
        raise ImportSafetyError(f"B{code_number} 在旧 CSV 中应唯一，实际 {len(matches)} 条")
    if not str(matches[0].get("Path") or "").strip():
        raise ImportSafetyError(f"B{code_number} 的旧 CSV 目标路径为空")
    return matches[0]


def post_id_from_url(value: str) -> str:
    match = re.search(r"/(\d+)\.html", value or "")
    return match.group(1) if match else ""


def read_report(path: Path) -> dict:
    if not path.is_file():
        raise ImportSafetyError(f"找不到同步报告: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload.get("items"), list):
        raise ImportSafetyError(f"同步报告格式不正确: {path}")
    return payload


def report_item_for_code(report: dict, legacy_code: str, fallback_post_id: str) -> dict:
    matches = [item for item in report["items"] if legacy_code in (item.get("legacy_codes") or [])]
    if len(matches) == 1:
        return matches[0]
    if fallback_post_id:
        by_post = [item for item in report["items"] if str(item.get("post_id") or "") == fallback_post_id]
        if len(by_post) == 1:
            return by_post[0]
    raise ImportSafetyError(f"{legacy_code} 在 latest.json 中无法唯一定位")


def choose_destination(item: dict, legacy_destination: Path, library_root: Path) -> Path:
    proposed = Path(str(item.get("proposed_destination") or legacy_destination))
    local_directories = [Path(str(value)) for value in (item.get("local_directories") or []) if str(value).strip()]
    existing_locals = [path for path in local_directories if path.is_dir()]

    # The curated CSV/proposed directory is canonical when it already exists.
    # Otherwise keep using one discovered historical alias instead of splitting
    # the same person into bracketed and unbracketed directories.
    if proposed.is_dir():
        destination = proposed
    elif len(existing_locals) == 1:
        destination = existing_locals[0]
    elif not existing_locals:
        destination = proposed
    else:
        choices = ", ".join(str(path) for path in existing_locals)
        raise ImportSafetyError(f"人物存在多个非规范本地目录，无法自动选择: {choices}")
    return require_within(destination, library_root, "T 盘目标")


def collect_existing_sequences(destination: Path) -> tuple[list[Path], set[int]]:
    if not destination.exists():
        return [], set()
    archives = sorted(destination.glob("*.rar"), key=lambda path: natural_key(path.name))
    parsed: set[int] = set()
    unparsed: list[str] = []
    for archive in archives:
        sequence = parse_local_sequence(archive.stem)
        if sequence is None:
            unparsed.append(archive.name)
        else:
            parsed.add(sequence)
    if unparsed:
        preview = ", ".join(unparsed[:5])
        raise ImportSafetyError(f"目标目录存在无法识别序号的 RAR: {destination} ({preview})")
    return archives, parsed


def deduplicate_sources(root: Path, root_name: str, code_number: int) -> tuple[list[SourceArchive], list[str]]:
    all_files = sorted((path for path in root.rglob("*") if path.is_file()), key=lambda path: natural_key(str(path)))
    if not all_files:
        raise ImportSafetyError(f"下载目录为空: {root}")
    invalid = [path for path in all_files if path.suffix.casefold() != ".7z" or path.stat().st_size <= 0]
    if invalid:
        raise ImportSafetyError(f"下载目录含非 7z 或零字节文件: {invalid[0]}")

    groups: dict[int, list[Path]] = {}
    for path in all_files:
        groups.setdefault(parse_source_sequence(path, code_number), []).append(path)

    sources: list[SourceArchive] = []
    duplicate_files: list[str] = []
    for sequence, paths in sorted(groups.items()):
        preferred = sorted(paths, key=lambda path: (bool(TRAILING_COPY_RE.search(path.stem)), natural_key(path.name)))[0]
        preferred_stat = preferred.stat()
        duplicates: list[str] = []
        if len(paths) > 1:
            expected_hash = sha256_file(preferred)
            for duplicate in paths:
                if duplicate == preferred:
                    continue
                if duplicate.stat().st_size != preferred_stat.st_size or sha256_file(duplicate) != expected_hash:
                    raise ImportSafetyError(
                        f"同编号 7z 内容不同，拒绝自动选择: {preferred} / {duplicate}"
                    )
                duplicates.append(str(duplicate))
                duplicate_files.append(str(duplicate))
        sources.append(
            SourceArchive(
                root_name=root_name,
                code_number=code_number,
                sequence=sequence,
                path=preferred,
                size=preferred_stat.st_size,
                mtime_ns=preferred_stat.st_mtime_ns,
                duplicate_paths=tuple(duplicates),
            )
        )
    return sources, duplicate_files


def build_plan(
    input_root: Path,
    root_names: list[str],
    library_root: Path,
    legacy_csv: Path,
    report_path: Path,
    max_items: int = 0,
) -> tuple[list[RootPlan], list[ImportTask], dict]:
    input_root = require_within(input_root, input_root, "下载根目录")
    library_root = require_within(library_root, library_root, "图库根目录")
    rows = read_legacy_rows(legacy_csv)
    report = read_report(report_path)
    seen_roots: set[str] = set()
    seen_destinations: dict[str, str] = {}
    root_plans: list[RootPlan] = []
    tasks: list[ImportTask] = []

    for root_name in root_names:
        if root_name.casefold() in seen_roots:
            raise ImportSafetyError(f"重复指定下载目录: {root_name}")
        seen_roots.add(root_name.casefold())
        code_number = parse_root_number(root_name)
        source_root = require_within(input_root / root_name, input_root, "下载目录")
        if source_root.parent != input_root or not source_root.is_dir():
            raise ImportSafetyError(f"下载目录必须是输入根目录的直接子目录: {source_root}")

        legacy_row = legacy_row_for_code(rows, code_number)
        legacy_code = f"B{code_number}"
        fallback_post_id = post_id_from_url(str(legacy_row.get("URL") or ""))
        item = report_item_for_code(report, legacy_code, fallback_post_id)
        destination = choose_destination(item, Path(str(legacy_row["Path"])), library_root)
        destination_key = normalized_path(destination)
        previous_root = seen_destinations.get(destination_key)
        if previous_root:
            raise ImportSafetyError(f"下载目录 {previous_root} 与 {root_name} 映射到同一目标: {destination}")
        seen_destinations[destination_key] = root_name

        sources, duplicate_files = deduplicate_sources(source_root, root_name, code_number)
        existing_archives, existing_sequences = collect_existing_sequences(destination)
        source_sequences = {source.sequence for source in sources}
        candidate_sources = [source for source in sources if source.sequence not in existing_sequences]
        warnings: list[str] = []
        if source_sequences:
            max_sequence = max(source_sequences)
            remote_count = int(item.get("remote_count") or 0)
            if remote_count and max_sequence != remote_count:
                warnings.append(f"远端显示末号 {remote_count}，下载包最大序号 {max_sequence}")
            gaps = sorted(set(range(min(source_sequences), max_sequence + 1)) - source_sequences)
            if gaps:
                warnings.append("下载序号缺口: " + ",".join(str(value) for value in gaps))

        root_plans.append(
            RootPlan(
                root_name=root_name,
                legacy_code=legacy_code,
                post_id=str(item.get("post_id") or fallback_post_id),
                status=str(item.get("status") or ""),
                destination_name=str(item.get("destination_name") or ""),
                destination=destination,
                source_count=len(sources) + len(duplicate_files),
                unique_source_count=len(sources),
                duplicate_count=len(duplicate_files),
                existing_rar_count=len(existing_archives),
                existing_sequence_count=len(existing_sequences),
                overlap_count=len(source_sequences & existing_sequences),
                candidate_count=len(candidate_sources),
                source_sequences=sorted(source_sequences),
                existing_sequences=sorted(existing_sequences),
                duplicate_files=duplicate_files,
                warnings=warnings,
            )
        )
        for source in candidate_sources:
            tasks.append(
                ImportTask(
                    root_name=root_name,
                    legacy_code=legacy_code,
                    post_id=str(item.get("post_id") or fallback_post_id),
                    destination_name=str(item.get("destination_name") or ""),
                    destination=destination,
                    sequence=source.sequence,
                    source_path=source.path,
                    source_size=source.size,
                    source_mtime_ns=source.mtime_ns,
                )
            )

    tasks.sort(key=lambda task: (task.source_size, task.root_name.casefold(), task.sequence))
    total_candidates = len(tasks)
    if max_items > 0:
        tasks = tasks[:max_items]
    totals = {
        "roots": len(root_plans),
        "source_7z": sum(plan.source_count for plan in root_plans),
        "unique_7z": sum(plan.unique_source_count for plan in root_plans),
        "duplicate_7z": sum(plan.duplicate_count for plan in root_plans),
        "existing_rars": sum(plan.existing_rar_count for plan in root_plans),
        "overlap_sequences": sum(plan.overlap_count for plan in root_plans),
        "candidate_count": total_candidates,
        "selected_count": len(tasks),
        "limited_out_count": total_candidates - len(tasks),
        "selected_bytes": sum(task.source_size for task in tasks),
    }
    return root_plans, tasks, totals


def safe_archive_member(name: str) -> bool:
    normalized = str(name or "").replace("\\", "/")
    pure = PurePosixPath(normalized)
    return bool(normalized) and not pure.is_absolute() and ".." not in pure.parts and not re.match(r"^[A-Za-z]:", normalized)


def run_process(command: list[str], password: str = "") -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        error = (result.stderr or result.stdout).decode("utf-8", errors="replace")
        if password:
            error = error.replace(password, "<redacted>")
        raise ImportSafetyError(error.strip() or f"外部工具失败，退出码 {result.returncode}")
    return result


def remove_junk_files(folder: Path, work_root: Path) -> None:
    require_within(folder, work_root, "清理目录")
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix.casefold() in JUNK_EXTENSIONS:
            path.chmod(path.stat().st_mode | stat.S_IWRITE)
            path.unlink()


def extracted_payload(zip_output: Path) -> tuple[Path, str]:
    children = [path for path in zip_output.iterdir()]
    directories = [path for path in children if path.is_dir()]
    files = [path for path in children if path.is_file()]
    if len(directories) == 1 and not files:
        return directories[0], directories[0].name
    if not directories and files:
        return zip_output, zip_output.name
    raise ImportSafetyError(
        f"内层 ZIP 解压后应只有一个顶层目录，实际目录={len(directories)} 文件={len(files)}"
    )


def validate_output_stem(rar_stem: str, expected_sequence: int) -> str:
    if not rar_stem.strip() or any(character in rar_stem for character in '<>:"/\\|?*'):
        raise ImportSafetyError(f"输出 RAR 名不安全: {rar_stem!r}")
    actual_sequence = parse_local_sequence(rar_stem)
    if actual_sequence is None:
        raise ImportSafetyError(f"输出 RAR 名无法识别序号: {rar_stem!r}")
    if actual_sequence != expected_sequence:
        raise ImportSafetyError(
            f"输出 RAR 序号与源包不一致: 源={expected_sequence:03d} 输出={actual_sequence:03d} 名称={rar_stem!r}"
        )
    return rar_stem


def normalize_member_name(value: str) -> str:
    return value.replace("\\", "/").strip("/").casefold()


def rar_manifest(path: Path) -> tuple[tuple[tuple[str, int, int], ...], int]:
    members: list[tuple[str, int, int]] = []
    image_count = 0
    with rarfile.RarFile(path) as archive:
        for info in archive.infolist():
            if info.isdir():
                continue
            name = normalize_member_name(info.filename)
            if not safe_archive_member(name):
                raise ImportSafetyError(f"RAR 含不安全成员路径: {info.filename}")
            size = int(info.file_size or 0)
            crc = int(getattr(info, "CRC", 0) or 0)
            members.append((name, size, crc))
            if Path(name).suffix.casefold() in IMAGE_EXTENSIONS:
                image_count += 1
    members.sort()
    return tuple(members), image_count


def validate_rar(path: Path, unrar_path: Path) -> tuple[tuple[tuple[str, int, int], ...], int]:
    run_process([str(unrar_path), "t", "-inul", "-p-", "-cfg-", str(path)])
    manifest, image_count = rar_manifest(path)
    if not manifest:
        raise ImportSafetyError(f"RAR 为空: {path}")
    media_count = sum(1 for name, _size, _crc in manifest if Path(name).suffix.casefold() in MEDIA_EXTENSIONS)
    if media_count < 1:
        raise ImportSafetyError(f"RAR 内没有可识别图片或视频: {path}")
    return manifest, image_count


def source_unchanged(task: ImportTask) -> bool:
    try:
        stat = task.source_path.stat()
    except FileNotFoundError:
        return False
    return stat.st_size == task.source_size and stat.st_mtime_ns == task.source_mtime_ns


def import_one(
    task: ImportTask,
    run_id: str,
    run_staging: Path,
    password: str,
    winrar_path: Path,
    unrar_path: Path,
) -> ImportResult:
    base_result = ImportResult(
        root_name=task.root_name,
        legacy_code=task.legacy_code,
        post_id=task.post_id,
        sequence=task.sequence,
        source_path=str(task.source_path),
        destination=str(task.destination),
        status="error",
    )
    work_dir = run_staging / "work" / f"{task.root_name}-{task.sequence:04d}"
    try:
        if not source_unchanged(task):
            raise ImportSafetyError("源 7z 在预检后发生变化")
        safe_remove_tree(work_dir, run_staging)
        outer_output = work_dir / "outer"
        zip_output = work_dir / "unzipped"
        candidate_dir = work_dir / "candidate"
        outer_output.mkdir(parents=True)
        zip_output.mkdir(parents=True)
        candidate_dir.mkdir(parents=True)

        with py7zr.SevenZipFile(task.source_path, mode="r", password=password) as archive:
            names = archive.getnames()
            if len(names) != 1 or not names[0].casefold().endswith(".zip") or not safe_archive_member(names[0]):
                raise ImportSafetyError(f"外层 7z 应只有一个安全 ZIP，实际: {names}")
            archive.extract(path=outer_output, targets=names)
        inner_zips = [path for path in outer_output.rglob("*") if path.is_file() and path.suffix.casefold() == ".zip"]
        if len(inner_zips) != 1:
            raise ImportSafetyError(f"外层 7z 解压后 ZIP 数量不是 1: {len(inner_zips)}")
        inner_zip = inner_zips[0]

        run_process(
            [
                str(winrar_path),
                "x",
                "-ibck",
                "-y",
                "-o+",
                f"-p{password}",
                str(inner_zip),
                str(zip_output) + os.sep,
            ],
            password=password,
        )
        remove_junk_files(zip_output, work_dir)
        payload_folder, rar_stem = extracted_payload(zip_output)
        validate_output_stem(rar_stem, task.sequence)
        candidate_rar = candidate_dir / f"{rar_stem}.rar"
        run_process(
            [
                str(winrar_path),
                "a",
                "-ibck",
                "-y",
                "-ma5",
                "-m0",
                "-r",
                "-ep1",
                str(candidate_rar),
                str(payload_folder),
            ]
        )
        if not candidate_rar.is_file() or candidate_rar.stat().st_size <= 0:
            raise ImportSafetyError("WinRAR 未生成有效候选 RAR")
        candidate_manifest, image_count = validate_rar(candidate_rar, unrar_path)
        if not source_unchanged(task):
            raise ImportSafetyError("源 7z 在转换过程中发生变化")

        task.destination.mkdir(parents=True, exist_ok=True)
        final_path = task.destination / candidate_rar.name
        if final_path.exists():
            existing_manifest, existing_images = validate_rar(final_path, unrar_path)
            if existing_manifest == candidate_manifest:
                base_result.status = "identical_existing"
                base_result.rar_path = str(final_path)
                base_result.bytes = final_path.stat().st_size
                base_result.image_count = existing_images
                return base_result
            conflict_dir = run_staging / "conflicts" / task.root_name / f"{task.sequence:04d}"
            conflict_dir.mkdir(parents=True, exist_ok=True)
            conflict_path = conflict_dir / candidate_rar.name
            shutil.move(str(candidate_rar), conflict_path)
            base_result.status = "conflict"
            base_result.rar_path = str(final_path)
            base_result.conflict_path = str(conflict_path)
            base_result.bytes = conflict_path.stat().st_size
            base_result.image_count = image_count
            return base_result

        temp_target = task.destination / f".{candidate_rar.name}.{run_id}.importing"
        if temp_target.exists():
            temp_target.unlink()
        try:
            shutil.copy2(candidate_rar, temp_target)
            if temp_target.stat().st_size != candidate_rar.stat().st_size:
                raise ImportSafetyError("复制到 T 盘后的文件大小不一致")
            if sha256_file(temp_target) != sha256_file(candidate_rar):
                raise ImportSafetyError("复制到 T 盘后的 SHA-256 不一致")
            if final_path.exists():
                raise ImportSafetyError(f"提交时目标文件突然出现，拒绝覆盖: {final_path}")
            os.rename(temp_target, final_path)
        finally:
            temp_target.unlink(missing_ok=True)

        base_result.status = "imported"
        base_result.rar_path = str(final_path)
        base_result.bytes = final_path.stat().st_size
        base_result.image_count = image_count
        return base_result
    except Exception as error:
        base_result.error = str(error).replace(password, "<redacted>") if password else str(error)
        return base_result
    finally:
        try:
            safe_remove_tree(work_dir, run_staging)
        except Exception:
            pass


def serializable_plan(root_plans: list[RootPlan], tasks: list[ImportTask], totals: dict) -> dict:
    return {
        "totals": totals,
        "roots": [
            {
                **asdict(plan),
                "destination": str(plan.destination),
            }
            for plan in root_plans
        ],
        "selected": [
            {
                **asdict(task),
                "destination": str(task.destination),
                "source_path": str(task.source_path),
            }
            for task in tasks
        ],
    }


def print_plan(root_plans: list[RootPlan], totals: dict) -> None:
    print(
        "预检完成: "
        f"目录={totals['roots']} 7z={totals['source_7z']} 唯一={totals['unique_7z']} "
        f"重复={totals['duplicate_7z']} 已有序号={totals['overlap_sequences']} "
        f"待导入={totals['candidate_count']} 本次选择={totals['selected_count']} "
        f"约={totals['selected_bytes'] / 1024**3:.3f} GiB"
    )
    for plan in root_plans:
        warnings = f"；{'；'.join(plan.warnings)}" if plan.warnings else ""
        print(
            f"[{plan.root_name}] {plan.destination_name} -> {plan.destination} "
            f"唯一包={plan.unique_source_count} 已有={plan.existing_sequence_count} "
            f"新增={plan.candidate_count} 重复下载={plan.duplicate_count}{warnings}"
        )


def execute_plan(
    root_plans: list[RootPlan],
    tasks: list[ImportTask],
    totals: dict,
    args: argparse.Namespace,
) -> int:
    if not tasks:
        print("没有需要导入的新序号。")
        return 0
    for executable in (args.winrar, args.unrar):
        if not executable.is_file():
            raise ImportSafetyError(f"找不到外部工具: {executable}")
    password = load_legacy_password(args.legacy_unzip, args.password_env)
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_staging = require_within(args.staging_root / run_id, args.staging_root, "本次 staging")
    run_staging.mkdir(parents=True, exist_ok=False)
    manifest_path = args.manifest_root / f"tuimzz-import-{run_id}.json"
    manifest = {
        "schema_version": 1,
        "run_id": run_id,
        "started_at": utc_now(),
        "completed_at": "",
        "complete": False,
        "source_retained": True,
        "cleanup_status": "pending",
        "warnings": [],
        "plan": serializable_plan(root_plans, tasks, totals),
        "results": [],
        "summary": {"imported": 0, "identical_existing": 0, "conflict": 0, "error": 0},
    }
    atomic_write_json(manifest_path, manifest)
    print(f"执行清单: {manifest_path}")

    lock = threading.Lock()
    completed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_map = {
            executor.submit(
                import_one,
                task,
                run_id,
                run_staging,
                password,
                args.winrar,
                args.unrar,
            ): task
            for task in tasks
        }
        for future in as_completed(future_map):
            task = future_map[future]
            try:
                result = future.result()
            except Exception as error:
                result = ImportResult(
                    root_name=task.root_name,
                    legacy_code=task.legacy_code,
                    post_id=task.post_id,
                    sequence=task.sequence,
                    source_path=str(task.source_path),
                    destination=str(task.destination),
                    status="error",
                    error=str(error).replace(password, "<redacted>"),
                )
            with lock:
                completed += 1
                manifest["results"].append(asdict(result))
                manifest["summary"][result.status] = manifest["summary"].get(result.status, 0) + 1
                atomic_write_json(manifest_path, manifest)
            detail = result.rar_path or result.error
            print(f"[{completed}/{len(tasks)}] {task.root_name}/{task.sequence:03d} {result.status}: {detail}", flush=True)

    manifest["completed_at"] = utc_now()
    manifest["complete"] = manifest["summary"].get("error", 0) == 0 and manifest["summary"].get("conflict", 0) == 0
    if manifest["complete"]:
        try:
            safe_remove_tree(run_staging, args.staging_root)
            manifest["cleanup_status"] = "removed"
        except Exception as error:
            manifest["cleanup_status"] = "warning"
            manifest["warnings"].append(f"staging 清理失败，已保留供人工复核: {error}")
    else:
        manifest["cleanup_status"] = "retained"
    atomic_write_json(manifest_path, manifest)
    print(f"导入结束: {json.dumps(manifest['summary'], ensure_ascii=False)}")
    for warning in manifest["warnings"]:
        print(f"警告: {warning}")
    print(f"源 7z 已保留；清单: {manifest_path}")
    return 0 if manifest["complete"] else 2


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="安全导入 tuimzz/5280 下载：7z -> ZIP -> 无密码 RAR；默认只预览，永不删除源文件。"
    )
    parser.add_argument("--input-root", type=Path, default=DEFAULT_INPUT_ROOT)
    parser.add_argument("--roots", nargs="+", action="extend", required=True, help="明确指定编号目录，如 285 389A")
    parser.add_argument("--library-root", type=Path, default=DEFAULT_LIBRARY_ROOT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--legacy-csv", type=Path, default=DEFAULT_LEGACY_CSV)
    parser.add_argument("--legacy-unzip", type=Path, default=DEFAULT_LEGACY_UNZIP)
    parser.add_argument("--password-env", default="TAOTU_ARCHIVE_PASSWORD")
    parser.add_argument("--staging-root", type=Path, default=DEFAULT_STAGING_ROOT)
    parser.add_argument("--manifest-root", type=Path, default=DEFAULT_MANIFEST_ROOT)
    parser.add_argument("--winrar", type=Path, default=DEFAULT_WINRAR)
    parser.add_argument("--unrar", type=Path, default=DEFAULT_UNRAR)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--max-items", type=int, default=0, help="只选择最小的前 N 个候选，0 表示不限。")
    parser.add_argument("--execute", action="store_true", help="实际转换并写入 T 盘；不指定时仅预览。")
    args = parser.parse_args(argv)
    if not 1 <= args.workers <= 8:
        parser.error("--workers 必须在 1..8")
    if args.max_items < 0:
        parser.error("--max-items 不能小于 0")
    return args


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    args = parse_args(argv)
    try:
        root_plans, tasks, totals = build_plan(
            args.input_root,
            args.roots,
            args.library_root,
            args.legacy_csv,
            args.report,
            max_items=args.max_items,
        )
        print_plan(root_plans, totals)
        if not args.execute:
            print("仅预览：没有解压、写入 T 盘或删除下载原件。加 --execute 才会执行。")
            return 0
        return execute_plan(root_plans, tasks, totals, args)
    except ImportSafetyError as error:
        print(f"安全检查失败: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("已中断；源 7z 保留，可重新运行继续。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
