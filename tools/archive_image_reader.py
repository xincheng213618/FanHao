import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
RAR_EXTS = {".rar"}
ZIP_EXTS = {".zip", ".cbz"}


def natural_key(value):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", str(value))]


def json_exit(payload, code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.write("\n")
    raise SystemExit(code)


def safe_member_name(name):
    raw = str(name or "").replace("\\", "/").strip("/")
    if not raw:
        return ""
    parts = [part for part in raw.split("/") if part]
    if any(part in {".", ".."} for part in parts):
        return ""
    if os.path.isabs(raw) or re.match(r"^[A-Za-z]:", raw):
        return ""
    return "/".join(parts)


def is_image_member(name):
    return Path(str(name)).suffix.lower() in IMAGE_EXTS


def decode_process_output(data):
    if not data:
        return ""
    nul_count = data[:200].count(b"\x00")
    if nul_count > 20:
        for encoding in ("utf-16le", "utf-16"):
            try:
                return data.decode(encoding, errors="replace")
            except Exception:
                pass
    for encoding in ("utf-8", "mbcs", "gbk", sys.getfilesystemencoding() or "utf-8"):
        try:
            return data.decode(encoding, errors="replace")
        except LookupError:
            continue
    return data.decode("utf-8", errors="replace")


def default_unrar_path():
    candidates = [
        os.environ.get("UNRAR_PATH"),
        r"C:\Program Files\WinRAR\UnRAR.exe",
        r"C:\Program Files (x86)\WinRAR\UnRAR.exe",
        shutil.which("unrar"),
        shutil.which("rar"),
    ]
    return next((item for item in candidates if item and Path(item).exists()), "")


def list_zip(archive_path):
    images = []
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            safe_name = safe_member_name(info.filename)
            if not safe_name or not is_image_member(safe_name):
                continue
            images.append(
                {
                    "path": safe_name,
                    "name": Path(safe_name).name,
                    "bytes": int(info.file_size or 0),
                    "compressedBytes": int(info.compress_size or 0),
                }
            )
    images.sort(key=lambda item: natural_key(item["path"]))
    return images


def list_rar(archive_path, unrar_path):
    if not unrar_path:
        raise RuntimeError("UnRAR.exe not found")
    cmd = [unrar_path, "lb", "-scu", "-p-", "-cfg-", str(archive_path)]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    output = decode_process_output(result.stdout)
    if result.returncode != 0 or not output.strip():
        fallback = subprocess.run([unrar_path, "lb", "-p-", "-cfg-", str(archive_path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        output = decode_process_output(fallback.stdout)
        if fallback.returncode != 0:
            error = decode_process_output(fallback.stderr or result.stderr).strip()
            raise RuntimeError(error or f"unrar list failed: {fallback.returncode}")

    images = []
    for line in output.splitlines():
        safe_name = safe_member_name(line)
        if not safe_name or not is_image_member(safe_name):
            continue
        images.append({"path": safe_name, "name": Path(safe_name).name, "bytes": 0, "compressedBytes": 0})
    images.sort(key=lambda item: natural_key(item["path"]))
    return images


def list_archive(archive_path, limit=0, unrar_path=""):
    archive_path = Path(archive_path)
    ext = archive_path.suffix.lower()
    if ext in ZIP_EXTS:
        images = list_zip(archive_path)
        archive_type = "zip"
    elif ext in RAR_EXTS:
        images = list_rar(archive_path, unrar_path or default_unrar_path())
        archive_type = "rar"
    else:
        raise RuntimeError(f"unsupported archive: {ext}")

    total = len(images)
    if limit and limit > 0:
        images = images[:limit]
    return {"ok": True, "archiveType": archive_type, "imageCount": total, "images": images}


def atomic_output_path(output_path):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=str(output_path.parent))
    os.close(fd)
    return Path(temp_name)


def extract_zip_member(archive_path, member, output_path):
    normalized = safe_member_name(member)
    with zipfile.ZipFile(archive_path) as archive:
        info = None
        for item in archive.infolist():
            if safe_member_name(item.filename) == normalized and not item.is_dir():
                info = item
                break
        if not info:
            raise RuntimeError("archive member not found")
        temp_path = atomic_output_path(output_path)
        try:
            with archive.open(info, "r") as source, temp_path.open("wb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            os.replace(temp_path, output_path)
        finally:
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)


def extract_rar_member(archive_path, member, output_path, unrar_path):
    if not unrar_path:
        raise RuntimeError("UnRAR.exe not found")
    normalized = safe_member_name(member)
    temp_path = atomic_output_path(output_path)
    last_error = ""
    patterns = [normalized.replace("/", "\\")]
    base_name = Path(normalized).name
    if "/" in normalized and base_name:
        patterns.append(f"*\\{base_name}")
    try:
        for pattern in patterns:
            temp_path.write_bytes(b"")
            try:
                with temp_path.open("wb") as target:
                    cmd = [unrar_path, "p", "-inul", "-p-", "-cfg-", str(archive_path), pattern]
                    result = subprocess.run(cmd, stdout=target, stderr=subprocess.PIPE, check=False)
            except UnicodeEncodeError as error:
                last_error = str(error)
                continue
            if result.returncode == 0 and temp_path.stat().st_size > 0:
                break
            error = decode_process_output(result.stderr).strip()
            last_error = error or f"unrar extract failed: {result.returncode}"
        else:
            raise RuntimeError(last_error or "empty extracted image")
        os.replace(temp_path, output_path)
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


def extract_archive(archive_path, member, output_path, unrar_path=""):
    archive_path = Path(archive_path)
    output_path = Path(output_path)
    normalized = safe_member_name(member)
    if not normalized or not is_image_member(normalized):
        raise RuntimeError("unsafe or unsupported archive member")
    ext = archive_path.suffix.lower()
    if ext in ZIP_EXTS:
        extract_zip_member(archive_path, normalized, output_path)
        archive_type = "zip"
    elif ext in RAR_EXTS:
        extract_rar_member(archive_path, normalized, output_path, unrar_path or default_unrar_path())
        archive_type = "rar"
    else:
        raise RuntimeError(f"unsupported archive: {ext}")
    return {"ok": True, "archiveType": archive_type, "member": normalized, "output": str(output_path), "bytes": output_path.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description="List and extract image members from archives.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("archive")
    list_parser.add_argument("--limit", type=int, default=0)
    list_parser.add_argument("--unrar", default="")

    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("archive")
    extract_parser.add_argument("member")
    extract_parser.add_argument("output")
    extract_parser.add_argument("--unrar", default="")

    args = parser.parse_args()
    try:
        if args.command == "list":
            json_exit(list_archive(args.archive, limit=args.limit, unrar_path=args.unrar))
        if args.command == "extract":
            json_exit(extract_archive(args.archive, args.member, args.output, unrar_path=args.unrar))
    except Exception as error:
        json_exit({"ok": False, "error": str(error)}, code=1)


if __name__ == "__main__":
    main()
