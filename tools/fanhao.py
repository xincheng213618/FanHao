import re
import shutil
import filecmp
import requests
import glob
import time
import os
import stat
import logging
import sys
from dataclasses import dataclass
from typing import Any, List, Optional, Set, Tuple

try:
    from fanhao_tool_db import DEFAULT_DB_PATH, ToolDatabase
except ImportError:  # pragma: no cover - keeps the script usable when copied alone.
    DEFAULT_DB_PATH = None
    ToolDatabase = None

LOGGER = logging.getLogger("fanhao")

EXCLUDE_PREFIXES = ('.', '$', 'Config', 'System')
RESERVED_FOLDER_NAMES = {"VR", "noactor"}
FILTER_CODES = {"KFA-11", "SIS-001", "HHD-800", "COM-300", "PRESTIGEPREMIUM"}

# 额外 VR 识别提示词（不含 "VR" 但也应归类），可通过 --vr-hints 扩展
VR_HINT_TOKENS_DEFAULT = {"AQULA", "AQUCO","CAFR","AQUBE","CACA","CAPI","CBIKMV","GOPJ","SSR","FSVSS","AQUMAM"}

FC2_REGEX = re.compile(r"FC2[\s_-]*PPV[\s_-]*(\d{5,8})", re.IGNORECASE)
FC2_SIMPLE_REGEX = re.compile(r"FC2[\s_-]*(\d{5,8})", re.IGNORECASE)
STANDARD_CODE_REGEX = re.compile(r"([a-z]{2,7})[\-_﹣－–—]?([0-9]{2,5})", re.IGNORECASE)  # 兼容多种破折号
STRICT_SPLIT_REGEX = re.compile(r"([a-z]{2,7})-(\d{2,5})", re.IGNORECASE)
DATE_PREFIX_REGEX = re.compile(r"^(\d{6})_(\d{2})-([0-9A-Za-z]+)$")
ALNUM_HYPHEN_REGEX = re.compile(r'^\d+[A-Za-z]+-\d+$')
SUFFIX_CLEAN_REGEX = re.compile(r'(\.part\d+|_\d+k|_\d+)', re.IGNORECASE)
MULTI_PREFIX_PATTERN = re.compile(r'^(?:\[[^\[\]]+\](?:[._-])?)+')
REQUEST_TIMEOUT = 15
ROOT_DIR = 'D:\\'
OUTPUT_DIR = None
METADATA_DELAY_SECONDS = 10.0
METADATA_RETRIES = 1
PROCESS_ALL_CODES = False
DRY_RUN = False
RUN_CLEAN_BEFORE_ORGANIZE = False
VERBOSE_LOGGING = False
SAVE_DATABASE = True
DATABASE_PATH = str(DEFAULT_DB_PATH) if DEFAULT_DB_PATH else None

# --------- Fullwidth -> Halfwidth ---------
FULL2HALF_MAP = {ord(f): ord('0') + i for i, f in enumerate('０１２３４５６７８９')}
FULL2HALF_MAP.update({
    ord('－'): ord('-'), ord('—'): ord('-'), ord('–'): ord('-'), ord('﹣'): ord('-'),
})

def to_halfwidth(s: str) -> str:
    return s.translate(FULL2HALF_MAP)

@dataclass
class VideoMeta:
    code: str
    title: str
    actor_names: List[str]
    image_url: Optional[str]
    raw: dict

def get_non_hidden_non_readonly_items(directory: str) -> List[str]:
    items: List[str] = []
    try:
        for item in os.listdir(directory):
            if item in RESERVED_FOLDER_NAMES:
                continue
            if item.startswith(EXCLUDE_PREFIXES):
                continue
            path = os.path.join(directory, item)
            try:
                mode = os.stat(path).st_mode
            except OSError as e:
                LOGGER.warning("stat fail %s: %s", path, e)
                continue
            if (mode & stat.S_IWRITE) == 0:
                continue
            items.append(item)
    except FileNotFoundError:
        LOGGER.error("Directory not found: %s", directory)
    return items

def normalize_code(code: str) -> str:
    code = code.upper()
    if not code:
        return code
    m = re.match(r'([A-Z]{2,7})[\-_]?([0-9]{1,5})', code)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):03d}" if not code.startswith("FC2-") else code
    return code

def extract_codes(name: str) -> List[str]:
    original = name
    name = to_halfwidth(os.path.splitext(name)[0])
    codes: Set[str] = set()
    m = DATE_PREFIX_REGEX.match(name)
    if m:
        codes.add(m.group(1) + '-' + m.group(2))
    if ALNUM_HYPHEN_REGEX.match(name):
        codes.add(name.upper())
    m = FC2_REGEX.search(name)
    if m:
        codes.add(f"FC2-{int(m.group(1)):07d}")
    else:
        m = FC2_SIMPLE_REGEX.search(name)
        if m:
            codes.add(f"FC2-{int(m.group(1)):07d}")
    for m in STRICT_SPLIT_REGEX.finditer(name):
        codes.add(f"{m.group(1).upper()}-{int(m.group(2)):03d}")
    for m in STANDARD_CODE_REGEX.finditer(name):
        prefix = m.group(1).upper()
        number = int(m.group(2))
        # 忽略过短 prefix (如单字母) 避免噪声
        if len(prefix) < 2:
            continue
        codes.add(f"{prefix}-{number:03d}")
    cleaned = []
    for c in codes:
        uc = c.upper()
        if uc in FILTER_CODES:
            continue
        cleaned.append(normalize_code(c))
    cleaned.sort(key=lambda x: (0 if x.startswith('FC2-') else 1, len(x), x))
    LOGGER.debug("Extract codes from '%s' => %s", original, cleaned)
    return cleaned

def extract_multi_prefix(name: str) -> Tuple[str, str]:
    m = MULTI_PREFIX_PATTERN.match(name)
    if not m:
        return '', name
    prefix = m.group(0)
    remainder = name[len(prefix):]
    if remainder.startswith(' '):
        remainder = remainder.lstrip()
    return prefix, remainder

def http_get(url: str, retries: int = 3, backoff: float = 5.0) -> Optional[requests.Response]:
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                return resp
            LOGGER.warning("GET %s status=%s attempt=%s", url, resp.status_code, attempt)
        except Exception as e:
            LOGGER.warning("GET %s error=%s attempt=%s", url, e, attempt)
        time.sleep(backoff * attempt)
    return None

def download_picture(image_url: str, actor_folder: str, retries: int = 3) -> Optional[str]:
    resp = http_get(image_url, retries=retries)
    if not resp:
        LOGGER.warning("Download failed %s", image_url)
        return None
    filename = os.path.join(actor_folder, image_url.split('/')[-1])
    try:
        with open(filename, 'wb') as f:
            f.write(resp.content)
        LOGGER.info("Image saved %s", filename)
        return filename
    except OSError as e:
        LOGGER.error("Write image %s fail: %s", filename, e)
        return None

def sanitize_filename(filename: str) -> str:
    filename = re.sub(r'[\\/*?:"<>|]', '', filename)
    filename = filename.replace('\n', '').replace('\r', '')
    filename = filename.strip()
    return filename[:120]

def move_and_merge_folders(source_folder: str, destination_folder: str):
    if not os.path.exists(source_folder):
        return
    source_abs = os.path.abspath(source_folder)
    destination_abs = os.path.abspath(destination_folder)
    if os.path.normcase(source_abs) == os.path.normcase(destination_abs):
        LOGGER.info("Source and destination are identical; skip move %s", source_folder)
        return
    if not os.path.exists(destination_folder):
        try:
            os.rename(source_folder, destination_folder)
            LOGGER.info("Folder renamed %s -> %s", source_folder, destination_folder)
            return
        except Exception as e:
            LOGGER.debug("Rename fallback copy: %s", e)
    for root, dirs, files in os.walk(source_folder):
        rel = os.path.relpath(root, source_folder)
        dest_root = os.path.join(destination_folder, rel) if rel != '.' else destination_folder
        os.makedirs(dest_root, exist_ok=True)
        for file in files:
            src_file = os.path.join(root, file)
            dst_file = os.path.join(dest_root, file)
            if os.path.exists(dst_file):
                try:
                    if filecmp.cmp(src_file, dst_file, shallow=False):
                        os.remove(src_file)
                        continue
                except Exception:
                    pass
                base, ext = os.path.splitext(file)
                counter = 1
                while True:
                    cand = os.path.join(dest_root, f"{base}({counter}){ext}")
                    if not os.path.exists(cand):
                        dst_file = cand
                        break
                    counter += 1
            try:
                shutil.move(src_file, dst_file)
            except Exception as e:
                LOGGER.warning("Move file %s -> %s fail: %s", src_file, dst_file, e)
    try:
        shutil.rmtree(source_folder, ignore_errors=True)
    except Exception as e:
        LOGGER.debug("Remove source folder fail %s: %s", source_folder, e)

class VideoOrganizer:
    def __init__(
        self,
        root: str,
        output: str,
        sleep: float = 5.0,
        retries: int = 2,
        process_all_codes: bool = False,
        dry_run: bool = False,
        vr_hints: Optional[Set[str]] = None,
        db_path: Optional[str] = DATABASE_PATH,
        save_database: bool = SAVE_DATABASE,
    ):
        self.root = os.path.abspath(root)
        self.output = os.path.abspath(output)
        self.sleep = sleep
        self.retries = retries
        self.process_all_codes = process_all_codes
        self.dry_run = dry_run
        self.vr_hints = {t.upper() for t in (vr_hints or VR_HINT_TOKENS_DEFAULT)}
        self.vr_path = os.path.join(self.output, "VR")
        self.disabled_metadata_sources: Set[str] = set()
        self.db_client: Optional[Any] = None
        if save_database and db_path and ToolDatabase is not None:
            try:
                self.db_client = ToolDatabase(db_path)
            except Exception as exc:
                LOGGER.warning("Database recording disabled: %s", exc)
        if not self.dry_run:
            os.makedirs(self.output, exist_ok=True)
            os.makedirs(self.vr_path, exist_ok=True)

    def organize(self):
        try:
            self._prepare_mp4_folders(self.root)
            items = get_non_hidden_non_readonly_items(self.root)
            for item in items:
                full_path = os.path.join(self.root, item)
                if not os.path.isdir(full_path):
                    continue
                # 第一次解析
                codes = extract_codes(item)
                LOGGER.debug("Codes for %s => %s", item, codes)
                # 尝试前缀剥离后再次解析
                if not codes:
                    prefix, remainder = extract_multi_prefix(item)
                    if prefix:
                        codes = extract_codes(remainder)
                        LOGGER.debug("Fallback parse after prefix removal: prefix=%s remainder=%s codes=%s", prefix, remainder, codes)
                if not codes:
                    LOGGER.info("Skip (no codes): %s", item)
                    continue
                processed_any = False
                for code in codes:
                    LOGGER.debug("Fetch metadata for %s", code)
                    meta = self._fetch_meta(code)
                    if not meta:
                        continue
                    self._apply_metadata(full_path, item, meta, original_folder=item)
                    processed_any = True
                    if not self.process_all_codes:
                        break
                if not processed_any:
                    LOGGER.info("Skip (meta fetch fail): %s", item)
        finally:
            if self.db_client:
                self.db_client.close()

    def _prepare_mp4_folders(self, dir_path: str):
        items = get_non_hidden_non_readonly_items(dir_path)
        for name in items:
            p = os.path.join(dir_path, name)
            if os.path.isfile(p) and p.lower().endswith('.mp4'):
                base = os.path.basename(p)
                if base.lower().endswith('_8k.mp4'):
                    non_8k = re.sub(r'_8k\.mp4$', '.mp4', base, flags=re.IGNORECASE)
                    non_8k_path = os.path.join(dir_path, non_8k)
                    if os.path.isfile(non_8k_path):
                        if self.dry_run:
                            LOGGER.info("[DRY] Would remove non-8K duplicate %s", non_8k_path)
                            continue
                        try:
                            os.remove(non_8k_path)
                            LOGGER.info("Remove non-8K duplicate %s", non_8k_path)
                        except Exception as e:
                            LOGGER.warning("Remove non-8K fail %s: %s", non_8k_path, e)
                else:
                    eight_k = os.path.splitext(base)[0] + '_8K.mp4'
                    if os.path.isfile(os.path.join(dir_path, eight_k)):
                        LOGGER.debug("Skip non-8K %s (8K exists)", base)
                        continue
                folder_name = SUFFIX_CLEAN_REGEX.sub('', os.path.splitext(base)[0])
                folder_path = os.path.join(dir_path, folder_name)
                if self.dry_run:
                    LOGGER.info("[DRY] Would move mp4 into folder %s -> %s", p, os.path.join(folder_path, base))
                    continue
                os.makedirs(folder_path, exist_ok=True)
                target = os.path.join(folder_path, base)
                try:
                    shutil.move(p, target)
                except Exception as e:
                    LOGGER.warning("Move mp4 into folder fail %s -> %s: %s", p, target, e)

    def _fetch_meta(self, code: str) -> Optional[VideoMeta]:
        providers = (
            ("javdb", self._fetch_meta_from_javdb),
        )
        attempts = max(1, self.retries)
        for source_name, fetcher in providers:
            if source_name in self.disabled_metadata_sources:
                continue
            for attempt in range(1, attempts + 1):
                try:
                    if self.sleep:
                        time.sleep(self.sleep)
                    info = fetcher(code)
                    meta = self._build_video_meta(code, info, source_name)
                    if meta:
                        LOGGER.info(
                            "Fetched meta %s via %s title='%s' actors=%s",
                            code,
                            source_name,
                            meta.title,
                            meta.actor_names[:1],
                        )
                        return meta
                except Exception as e:
                    LOGGER.warning(
                        "Fetch meta %s via %s attempt %s fail: %s",
                        code,
                        source_name,
                        attempt,
                        e,
                    )
                    if self._should_disable_metadata_source(source_name, e):
                        self.disabled_metadata_sources.add(source_name)
                        LOGGER.warning("Disable metadata source for this run: %s", source_name)
                        break
                    if attempt < attempts and self.sleep:
                        time.sleep(self.sleep * attempt)
        return None

    def _fetch_meta_from_javdb(self, code: str) -> Optional[dict]:
        import javdb  # local import so fanhao can start even if selenium is unavailable

        return javdb.getletterinfo(code)

    def _build_video_meta(self, code: str, info: Optional[dict], source_name: str) -> Optional[VideoMeta]:
        if not info:
            return None
        title = sanitize_filename(info.get("video_title") or info.get("识别码") or code)
        actors = info.get("actor_names", []) or []
        image_url = info.get("image_url")
        if image_url:
            if image_url.startswith("//"):
                image_url = "https:" + image_url
            elif image_url.startswith("/"):
                image_url = "https://www.javlibrary.com" + image_url
        raw = dict(info)
        raw["metadata_source"] = source_name
        return VideoMeta(code=code, title=title, actor_names=actors, image_url=image_url, raw=raw)

    def _should_disable_metadata_source(self, source_name: str, error: Exception) -> bool:
        if source_name != "javdb":
            return False
        message = str(error).lower()
        startup_markers = (
            "chrome driver startup failed",
            "session not created",
            "devtoolsactiveport",
            "chrome failed to start",
            "no module named",
        )
        return any(marker in message for marker in startup_markers)

    def _is_vr(self, meta: VideoMeta, original_folder: str) -> bool:
        base_checks = [meta.code.upper(), meta.title.upper(), original_folder.upper()]
        if any('VR' in v for v in base_checks):
            return True
        for token in self.vr_hints:
            if any(token in v for v in base_checks):
                return True
        return False

    def _apply_metadata(self, full_path: str, original_name: str, meta: VideoMeta, original_folder: str):
        actor = meta.actor_names[0] if meta.actor_names else 'noactor'
        is_vr = self._is_vr(meta, original_folder)
        actor_folder = os.path.join(self.vr_path if is_vr else self.output, actor)

        prefix, _ = extract_multi_prefix(original_name)
        video_folder_name = f"{prefix}{meta.title}" if prefix else meta.title
        video_folder = os.path.join(actor_folder, video_folder_name)

        if self.dry_run:
            LOGGER.info("[DRY] Would organize %s -> %s", full_path, video_folder)
            return

        os.makedirs(actor_folder, exist_ok=True)
        os.makedirs(video_folder, exist_ok=True)

        mp4_files = glob.glob(os.path.join(full_path, '*.mp4'))
        if len(mp4_files) == 1:
            mp4_file = mp4_files[0]
            new_mp4_name = os.path.join(full_path, meta.title + '.mp4')
            if not os.path.exists(new_mp4_name):
                try:
                    os.rename(mp4_file, new_mp4_name)
                    LOGGER.info("Rename %s -> %s", mp4_file, new_mp4_name)
                except Exception as e:
                    LOGGER.warning("Rename mp4 fail %s: %s", mp4_file, e)
        elif len(mp4_files) > 1:
            LOGGER.warning("Multiple mp4 in %s; skipping rename", full_path)

        if not self.dry_run:
            move_and_merge_folders(full_path, video_folder)
        else:
            LOGGER.info("[DRY] Would move %s -> %s", full_path, video_folder)

        if meta.image_url and not self.dry_run:
            download_picture(meta.image_url, video_folder)

        info_path = os.path.join(video_folder, 'info.txt')
        if not self.dry_run:
            try:
                with open(info_path, 'w', encoding='utf-8') as f:
                    f.write(f"VR: {is_vr}\n")
                    if self.vr_hints:
                        f.write(f"VR_HINTS_USED: {','.join(sorted(self.vr_hints))}\n")
                    for k, v in meta.raw.items():
                        f.write(f"{k}: {v}\n")
                LOGGER.info("Write meta %s", info_path)
            except Exception as e:
                LOGGER.warning("Write meta file fail %s: %s", info_path, e)

        if not self.dry_run and self.db_client:
            self.db_client.upsert_video_metadata(
                code=meta.code,
                title=meta.title,
                actors=meta.actor_names,
                image_url=meta.image_url or "",
                source_name=meta.raw.get("metadata_source") or "fanhao",
                source_query=meta.code,
                source_url=meta.raw.get("detail_url") or meta.raw.get("href_value") or "",
                organized_path=video_folder,
                is_vr=is_vr,
                raw=meta.raw,
            )
            self.db_client.commit()

def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")

    logging.basicConfig(
        level=logging.DEBUG if VERBOSE_LOGGING else logging.INFO,
        format='%(asctime)s %(levelname)s %(name)s: %(message)s'
    )

    if RUN_CLEAN_BEFORE_ORGANIZE:
        try:
            import clean
            clean.delete_matching_files_and_empty_dirs(
                directory=ROOT_DIR,
                keywords=clean.DEFAULT_KEYWORDS if hasattr(clean, 'DEFAULT_KEYWORDS') else [],
                max_size=100 * 1024 * 1024,
                hash_algo='md5',
                dry_run=DRY_RUN,
                verbose=VERBOSE_LOGGING
            )
        except Exception as e:
            LOGGER.warning("Invoke clean module fail: %s", e)

    output = OUTPUT_DIR or os.path.join(ROOT_DIR, "Organized")

    organizer = VideoOrganizer(
        root=ROOT_DIR,
        output=output,
        sleep=METADATA_DELAY_SECONDS,
        retries=METADATA_RETRIES,
        process_all_codes=PROCESS_ALL_CODES,
        dry_run=DRY_RUN,
        vr_hints=VR_HINT_TOKENS_DEFAULT,
    )
    organizer.organize()

if __name__ == '__main__':
    main()
