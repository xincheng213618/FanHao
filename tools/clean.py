import os
import re
import hashlib
import argparse
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

# 默认关键字列表（可通过 --keywords 或 --keywords-file 覆盖/追加）
DEFAULT_KEYWORDS = [
    "美女荷官","杏吧","社区最新情报","妹妹在精彩表演","manko.fun","sex8.cc","u u r","UUE","offkab@sukebei","tuu32.com",
    "新片首发 每天更新 同步日韩","[资源推荐]！下载地址","#第一会所sis001.com最新地址",".gif","最 新 位 址 獲 取 ","1024草榴社區","2048",".apk",
    "18+游戏大全","x u u ","uur9 3.com","新 片 首 發","有趣的台湾妹妹直播",".chm",".html",".mht",".url",
    "有 趣 的 臺 灣 妹 妹 直 播","1063715@18p2p.com.txt","三 上 悠 亚 想 要 跟 你 决 胜 负","电 竞 直 播 平台"," 福 利 机 置","安卓二维码",
    "最新地址.png","最新地址获取.txt","苍 老 师 强 力 推 荐.mp4","女神在线视频","最新网址","更多高清影片访问","18+游戏大全",
    "聚 合 全 網 H 直 播","社 區 最 新 情 報","最 新 位 址 獲 取.txt","台 妹 子 線 上 現 場 直 播 各 式 花 式 表 演.mp4",
    "489155.com","uuu33.com","uuu55.com","9898dh.com","收藏网址","新网址","youivcom","gmail.com","约会神器","约會神器",
]

SUFFIX_DUP_PATTERN = re.compile(r'（\d+）')  # 带全角括号 + 数字 的重复文件标记
VALID_MATCH_SCOPES = {"name", "relative", "full"}
LOGGER = logging.getLogger("clean")

# 番号识别正则
VIDEO_CODE_PATTERNS = [
    re.compile(r'(FC2PPV[- ]\d+)', re.IGNORECASE),           # FC2: FC2PPV 4888356
    re.compile(r'([A-Z]{2,10}[- ]\d{3,6}(?:-[A-Z])?)', re.IGNORECASE),  # 标准: ABF-353, CAWD-919, ALDN-304-C
    re.compile(r'(\d{6}[- _]\d{2,4})'),                      # Caribbean: 090120_001
    re.compile(r'(C[- ]\d{3,5})', re.IGNORECASE),            # 单字母: C-2853
]

# 广告相关关键字（用于判断文件是否为广告）
AD_INDICATORS = [
    "489155.com", "uuu33.com", "uuu55.com", "9898dh.com", "hgame69", "sogo9.cc",
    "twojav.com", "4k2.me", "收藏网址", "最新地址", "最新网址", "美女荷官",
    "杏吧", "直播", "游戏大全", "二维码", "女神在线", "草榴", "1024",
    "2048", "manko.fun", "sex8.cc", "offkab", "tuu32.com",
]

# 多分段文件名模式
MULTI_PART_PATTERN = re.compile(r'(?:part|cd|disc|disk)[\s._-]*(\d+)', re.IGNORECASE)
MULTI_PART_NUM_PATTERN = re.compile(r'^.*?(\d+)\s*\.mp4$', re.IGNORECASE)
# 站点前缀多分段模式：site@code_N_resolution.mp4
SITE_PART_PATTERN = re.compile(r'@\w+_(\d+)_\d+[kp]\.mp4$', re.IGNORECASE)

# 系统/特殊目录，跳过不扫描
SKIP_DIRS = {"$RECYCLE.BIN", "System Volume Information", ".git", "node_modules", "__pycache__"}

# 元数据文件，不参与重复检测和关键字匹配
PRESERVE_FILENAMES = {"info.txt", "info.nfo", "movie.nfo"}
PRESERVE_EXTENSIONS = {".nfo"}

# 快速哈希：读取首尾各多少字节做预筛
QUICK_HASH_SIZE = 4096


@dataclass
class CleanConfig:
    directory: str
    keywords: List[str]
    max_size: int
    hash_algo: str
    match_scope: str = "full"
    dry_run: bool = False
    verbose: bool = False
    quick_hash: bool = True  # 使用首尾快速哈希预筛
    video_code_mode: bool = False  # 番号识别清理模式


@dataclass
class CleanStats:
    total_scanned: int = 0
    dup_deleted: int = 0
    matched_deleted: int = 0
    dirs_processed: int = 0
    duplicate_groups: int = 0
    duplicate_files_considered: int = 0
    empty_dirs_deleted: int = 0
    skipped_large: int = 0
    skipped_dirs: int = 0

    @property
    def total_deleted(self) -> int:
        return self.dup_deleted + self.matched_deleted


def _logger_has_effective_handler(logger: logging.Logger) -> bool:
    current: Optional[logging.Logger] = logger
    while current is not None:
        if current.handlers:
            return True
        if not current.propagate:
            return False
        current = current.parent
    return False


def configure_logging(verbose: bool = False) -> logging.Logger:
    level = logging.DEBUG if verbose else logging.INFO
    LOGGER.setLevel(level)
    if not LOGGER.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        LOGGER.addHandler(handler)
        LOGGER.propagate = False
    for handler in LOGGER.handlers:
        handler.setLevel(level)
    return LOGGER


def _emit(message: str, level: int = logging.INFO, verbose_only: bool = False, verbose: bool = False) -> None:
    if verbose_only and not verbose:
        return
    if _logger_has_effective_handler(LOGGER):
        LOGGER.log(level, message)
        return
    print(message)


def _normalize_match_scope(match_scope: str) -> str:
    return (match_scope or "full").strip().lower()


def _build_match_target(file_path: str, root_directory: str, match_scope: str) -> str:
    if match_scope == "name":
        return os.path.basename(file_path).lower()
    if match_scope == "relative":
        return os.path.relpath(file_path, root_directory).lower()
    return file_path.lower()


def quick_file_hash(path: str, algo: str = "md5") -> Optional[str]:
    """快速哈希：只读取文件首尾各 QUICK_HASH_SIZE 字节，用于预筛。"""
    try:
        file_size = os.path.getsize(path)
        h = hashlib.new(algo)
        with open(path, 'rb') as f:
            head = f.read(QUICK_HASH_SIZE)
            h.update(head)
            if file_size > QUICK_HASH_SIZE * 2:
                f.seek(-QUICK_HASH_SIZE, 2)
                tail = f.read(QUICK_HASH_SIZE)
                h.update(tail)
        h.update(str(file_size).encode())
        return h.hexdigest()
    except (OSError, ValueError):
        return None


def file_hash(path: str, chunk_size: int = 4 * 1024 * 1024, algo: str = "md5") -> Optional[str]:
    """计算完整文件哈希。"""
    try:
        h = hashlib.new(algo)
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(chunk_size), b''):
                h.update(chunk)
        return h.hexdigest()
    except (OSError, ValueError) as e:
        _emit(f"[WARN] Hash failed {path}: {e}", level=logging.WARNING)
        return None


def _build_keyword_first_chars(keywords_lower: List[str]) -> Set[str]:
    """构建关键字首字符集合，用于快速预筛。"""
    chars = set()
    for kw in keywords_lower:
        if kw:
            chars.add(kw[0])
    return chars


def load_keywords(base: List[str], extra_inline: Optional[str], file_path: Optional[str], lowercase: bool = True) -> List[str]:
    kws = list(base)
    if file_path:
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        kws.append(line)
        except OSError as e:
            _emit(f"[WARN] Cannot read keywords file {file_path}: {e}", level=logging.WARNING)
    if extra_inline:
        for part in re.split(r'[;,\n]|\s{2,}', extra_inline):
            p = part.strip()
            if p:
                kws.append(p)
    seen = set()
    dedup = []
    for k in kws:
        lk = k.lower() if lowercase else k
        if lk not in seen:
            seen.add(lk)
            dedup.append(lk if lowercase else k)
    return dedup


def should_delete(match_target_lower: str, keywords_lower: List[str], first_chars: Set[str]) -> bool:
    """关键字匹配，带首字符预筛加速。"""
    # 快速预筛：如果文件名中不包含任何关键字的首字符，直接跳过
    if not any(c in match_target_lower for c in first_chars):
        return False
    return any(k in match_target_lower for k in keywords_lower)


def _print_run_configuration(directory: str, config: CleanConfig, keyword_count: int) -> None:
    if not config.verbose:
        return
    _emit("[INFO] ==== Run Configuration ====")
    _emit(f"[INFO] Root directory : {directory}")
    _emit(f"[INFO] Keywords count : {keyword_count}")
    _emit(f"[INFO] Max size (del) : {config.max_size} bytes")
    _emit(f"[INFO] Hash algorithm  : {config.hash_algo}")
    _emit(f"[INFO] Dry run mode    : {config.dry_run}")
    _emit(f"[INFO] Match scope     : {config.match_scope}")
    _emit(f"[INFO] Quick hash      : {config.quick_hash}")
    _emit(f"[INFO] Video code mode : {config.video_code_mode}")
    _emit(f"[INFO] Skip dirs       : {', '.join(SKIP_DIRS)}")
    _emit(f"[INFO] ============================")


def _should_skip_dir(dir_name: str) -> bool:
    """判断是否跳过该目录。"""
    return dir_name in SKIP_DIRS


def _is_preserve_file(file_path: str) -> bool:
    """判断文件是否为元数据文件（不参与重复检测和关键字匹配）。"""
    basename = os.path.basename(file_path).lower()
    if basename in PRESERVE_FILENAMES:
        return True
    ext = os.path.splitext(basename)[1]
    return ext in PRESERVE_EXTENSIONS


def _collect_all_files(directory: str, verbose: bool, stats: CleanStats) -> Tuple[Dict[str, int], Dict[int, List[str]]]:
    """全局收集所有文件的大小信息，同时跳过系统目录。"""
    file_sizes: Dict[str, int] = {}
    size_to_files: Dict[int, List[str]] = {}

    for root, dirs, files in os.walk(directory, topdown=True):
        # 原地修改 dirs 列表来跳过不需要的目录
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

        skipped = len(dirs) + len([d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)) and d in SKIP_DIRS]) if False else 0

        stats.dirs_processed += 1
        if verbose and stats.dirs_processed % 100 == 0:
            _emit(f"[PROGRESS] dirs={stats.dirs_processed} files={len(file_sizes)}", level=logging.DEBUG)

        for file_name in files:
            file_path = os.path.join(root, file_name)
            if _is_preserve_file(file_path):
                continue
            try:
                size = os.path.getsize(file_path)
            except OSError:
                continue
            file_sizes[file_path] = size
            size_to_files.setdefault(size, []).append(file_path)

    return file_sizes, size_to_files


def _choose_duplicate_keep(files_with_same_hash: List[str]) -> str:
    with_suffix: List[str] = []
    without_suffix: List[str] = []
    for file_path in files_with_same_hash:
        if SUFFIX_DUP_PATTERN.search(os.path.basename(file_path)):
            with_suffix.append(file_path)
        else:
            without_suffix.append(file_path)
    candidates = without_suffix if without_suffix else with_suffix
    candidates.sort()
    return candidates[0]


def _delete_file(file_path: str, dry_run: bool, verbose: bool, dry_label: str, delete_label: str, warn_label: str) -> bool:
    if dry_run:
        _emit(f"[DRY][{dry_label}] {file_path}")
        return False
    try:
        os.remove(file_path)
    except OSError as e:
        _emit(f"[WARN] {warn_label} {file_path}: {e}", level=logging.WARNING)
        return False
    if verbose:
        _emit(f"[{delete_label}] {file_path}", level=logging.DEBUG)
    return True


def _process_duplicate_files(
    size_to_files: Dict[int, List[str]],
    file_sizes: Dict[str, int],
    max_size: int,
    config: CleanConfig,
    stats: CleanStats,
) -> Set[str]:
    """跨目录重复文件检测。先按大小分组，再用哈希确认。"""
    handled_files: Set[str] = set()

    for same_size, all_paths in size_to_files.items():
        if len(all_paths) <= 1:
            continue

        # 过滤掉超过 max_size 的文件（大文件不做哈希）
        paths = [p for p in all_paths if file_sizes.get(p, 0) <= max_size]
        skipped = len(all_paths) - len(paths)
        if skipped:
            stats.skipped_large += skipped
        if len(paths) <= 1:
            continue

        if config.dry_run:
            # dry-run 模式：不计算哈希，只报告大小相同的文件组
            stats.duplicate_groups += 1
            stats.duplicate_files_considered += len(paths)
            keep = _choose_duplicate_keep(paths)
            if config.verbose:
                _emit(f"[DUP][GROUP] size={same_size} files={len(paths)} keep={keep}", level=logging.DEBUG)
            for file_path in paths:
                if file_path == keep:
                    continue
                handled_files.add(file_path)
                _emit(f"[DRY][DUP][DEL] {file_path}")
                stats.dup_deleted += 1
            continue

        # 非 dry-run：先快速哈希预筛，再全量哈希确认
        quick_hash_to_files: Dict[str, List[str]] = {}
        for file_path in paths:
            if config.quick_hash:
                digest = quick_file_hash(file_path, algo=config.hash_algo)
            else:
                digest = file_hash(file_path, algo=config.hash_algo)
            if digest:
                quick_hash_to_files.setdefault(digest, []).append(file_path)

        for digest, quick_match_files in quick_hash_to_files.items():
            if len(quick_match_files) <= 1:
                continue

            # 如果不用快速哈希，直接用全量哈希结果
            if not config.quick_hash:
                stats.duplicate_groups += 1
                stats.duplicate_files_considered += len(quick_match_files)
                keep = _choose_duplicate_keep(quick_match_files)
                if config.verbose:
                    _emit(f"[DUP][GROUP] hash={digest} files={len(quick_match_files)} keep={keep}", level=logging.DEBUG)
                for file_path in quick_match_files:
                    if file_path == keep:
                        continue
                    handled_files.add(file_path)
                    deleted = _delete_file(
                        file_path=file_path,
                        dry_run=False,
                        verbose=config.verbose,
                        dry_label="DUP][DEL",
                        delete_label="DEL][DUP",
                        warn_label="Delete dup fail",
                    )
                    if deleted:
                        stats.dup_deleted += 1
                continue

            # 快速哈希匹配后，做全量哈希二次确认
            full_hash_to_files: Dict[str, List[str]] = {}
            for file_path in quick_match_files:
                full_digest = file_hash(file_path, algo=config.hash_algo)
                if full_digest:
                    full_hash_to_files.setdefault(full_digest, []).append(file_path)

            for full_digest, confirmed_files in full_hash_to_files.items():
                if len(confirmed_files) <= 1:
                    continue
                stats.duplicate_groups += 1
                stats.duplicate_files_considered += len(confirmed_files)
                keep = _choose_duplicate_keep(confirmed_files)
                if config.verbose:
                    _emit(f"[DUP][GROUP] hash={full_digest} files={len(confirmed_files)} keep={keep}", level=logging.DEBUG)
                for file_path in confirmed_files:
                    if file_path == keep:
                        continue
                    handled_files.add(file_path)
                    deleted = _delete_file(
                        file_path=file_path,
                        dry_run=False,
                        verbose=config.verbose,
                        dry_label="DUP][DEL",
                        delete_label="DEL][DUP",
                        warn_label="Delete dup fail",
                    )
                    if deleted:
                        stats.dup_deleted += 1

    return handled_files


def _process_keyword_matches(
    file_sizes: Dict[str, int],
    keywords_lower: List[str],
    first_chars: Set[str],
    handled_files: Set[str],
    config: CleanConfig,
    stats: CleanStats,
) -> None:
    """关键字匹配扫描所有文件。"""
    for file_path, size in file_sizes.items():
        stats.total_scanned += 1
        if file_path in handled_files:
            continue
        match_target = _build_match_target(file_path, config.directory, config.match_scope)
        if should_delete(match_target, keywords_lower, first_chars):
            if size > config.max_size:
                if config.verbose:
                    _emit(f"[SKIP][SIZE>{config.max_size}] {file_path}", level=logging.DEBUG)
                continue
            deleted = _delete_file(
                file_path=file_path,
                dry_run=config.dry_run,
                verbose=config.verbose,
                dry_label="MATCH][DEL",
                delete_label="DEL][MATCH",
                warn_label="Delete fail",
            )
            if deleted:
                stats.matched_deleted += 1
        elif config.verbose and stats.total_scanned % 500 == 0:
            _emit(f"[PROGRESS] scanned={stats.total_scanned} dup_del={stats.dup_deleted} match_del={stats.matched_deleted}", level=logging.DEBUG)


def _extract_video_code(name: str) -> Optional[str]:
    """从文件夹名中提取番号。支持站点前缀格式（如 ccc11.cc@FC2PPV 4888356）。"""
    # 去掉站点前缀
    if '@' in name:
        name = name.split('@', 1)[1]
    for pattern in VIDEO_CODE_PATTERNS:
        m = pattern.search(name)
        if m:
            return m.group(1).strip()
    return None


def _is_ad_file(filename: str) -> bool:
    """判断文件名是否包含广告关键字。"""
    lower = filename.lower()
    return any(indicator in lower for indicator in AD_INDICATORS)


def _is_multi_part(files: List[str]) -> bool:
    """判断一组 mp4 文件是否为多分段视频。"""
    if len(files) <= 1:
        return False

    # 方式1：文件名含 part/cd/disc/disk
    for f in files:
        basename = os.path.basename(f).lower()
        if MULTI_PART_PATTERN.search(basename):
            return True

    # 方式2：站点前缀多分段模式 site@code_N_resolution.mp4
    for f in files:
        basename = os.path.basename(f)
        if SITE_PART_PATTERN.search(basename):
            return True

    # 方式3：多个大文件（>1GB）视为多分段
    large_count = 0
    for f in files:
        try:
            if os.path.getsize(f) > 1_000_000_000:
                large_count += 1
        except OSError:
            pass
    if large_count >= 2:
        return True

    return False


def _clean_video_code_folder(
    folder_path: str,
    video_code: str,
    config: CleanConfig,
    stats: CleanStats,
) -> None:
    """清理一个番号文件夹：只保留主视频 + 封面图，删除其余。"""
    all_files: List[str] = []
    all_dirs: List[str] = []

    for root, dirs, files in os.walk(folder_path):
        for f in files:
            all_files.append(os.path.join(root, f))
        for d in dirs:
            all_dirs.append(os.path.join(root, d))

    if not all_files:
        return

    # 分类文件
    mp4_files: List[str] = []
    cover_files: List[str] = []
    other_files: List[str] = []
    code_lower = video_code.lower().replace(' ', '').replace('-', '')

    for f in all_files:
        ext = os.path.splitext(f)[1].lower()
        basename = os.path.basename(f)
        basename_lower = basename.lower()

        if ext == '.mp4':
            mp4_files.append(f)
        elif ext in ('.jpg', '.jpeg', '.png', '.bmp'):
            # 封面图：文件名包含番号，或文件夹中唯一的图片
            basename_no_ext = os.path.splitext(basename)[0].lower().replace(' ', '').replace('-', '')
            if code_lower in basename_no_ext or _extract_video_code(basename):
                cover_files.append(f)
            elif _is_ad_file(basename_lower):
                other_files.append(f)
            else:
                cover_files.append(f)  # 非广告图片默认当作封面
        elif basename_lower in ('info.txt', 'info.nfo', 'movie.nfo') or ext == '.nfo':
            cover_files.append(f)  # 元数据文件，保留
        else:
            other_files.append(f)

    # 确定要保留的文件
    keep_files: Set[str] = set()

    # 保留主视频
    if mp4_files:
        if _is_multi_part(mp4_files):
            # 多分段：识别真正的分段文件（大文件），删除小广告 mp4
            part_files = []
            ad_mp4s = []
            for f in mp4_files:
                try:
                    size = os.path.getsize(f)
                except OSError:
                    continue
                basename = os.path.basename(f)
                # 真正的分段：匹配分段命名 或 文件足够大（>500MB）
                if SITE_PART_PATTERN.search(basename) or MULTI_PART_PATTERN.search(basename) or size > 500_000_000:
                    part_files.append(f)
                else:
                    ad_mp4s.append(f)
            keep_files.update(part_files)
            # ad_mp4s 会被加入删除列表
        else:
            # 单文件：保留最大的
            largest = max(mp4_files, key=lambda p: os.path.getsize(p))
            keep_files.add(largest)

    # 保留封面图
    keep_files.update(cover_files)

    # 如果没有识别到封面图，把 other_files 中唯一的小图片当作封面
    if not cover_files:
        small_images = [f for f in other_files if os.path.splitext(f)[1].lower() in ('.jpg', '.jpeg', '.png', '.bmp') and os.path.getsize(f) < 500_000]
        if len(small_images) == 1:
            keep_files.add(small_images[0])
            other_files.remove(small_images[0])

    # 删除不在保留列表中的文件
    for f in all_files:
        if f in keep_files:
            continue
        stats.total_scanned += 1
        _delete_file(
            file_path=f,
            dry_run=config.dry_run,
            verbose=config.verbose,
            dry_label="VCODE][DEL",
            delete_label="DEL][VCODE",
            warn_label="Delete vcode file fail",
        )
        stats.matched_deleted += 1

    # 删除子目录（自底向上）
    for d in sorted(all_dirs, key=len, reverse=True):
        if config.dry_run:
            try:
                if not os.listdir(d):
                    _emit(f"[DRY][EMPTY-DIR] {d}")
                    stats.empty_dirs_deleted += 1
            except OSError:
                pass
        else:
            try:
                if not os.listdir(d):
                    os.rmdir(d)
                    stats.empty_dirs_deleted += 1
                    if config.verbose:
                        _emit(f"[DEL][EMPTY-DIR] {d}", level=logging.DEBUG)
            except OSError:
                pass


def _process_video_code_folders(
    directory: str,
    config: CleanConfig,
    stats: CleanStats,
) -> None:
    """递归扫描所有子目录，识别番号文件夹并清理。"""
    code_folders_found = [0]

    def _recurse(dir_path: str) -> None:
        dir_name = os.path.basename(dir_path)
        dir_code = _extract_video_code(dir_name)
        if dir_code:
            code_folders_found[0] += 1
            if config.verbose:
                _emit(f"[VCODE] {dir_name} -> code={dir_code}", level=logging.DEBUG)
            _clean_video_code_folder(dir_path, dir_code, config, stats)
            try:
                if not os.listdir(dir_path):
                    if config.dry_run:
                        _emit(f"[DRY][EMPTY-DIR] {dir_path}")
                        stats.empty_dirs_deleted += 1
                    else:
                        os.rmdir(dir_path)
                        stats.empty_dirs_deleted += 1
            except OSError:
                pass
            return

        try:
            entries = os.listdir(dir_path)
        except OSError:
            return

        for entry in entries:
            full_path = os.path.join(dir_path, entry)
            if not os.path.isdir(full_path) or entry in SKIP_DIRS:
                continue
            _recurse(full_path)

    _recurse(directory)
    _emit(f"[PHASE 5] Found {code_folders_found[0]} video code folders")


def _remove_empty_dirs(directory: str, config: CleanConfig, stats: CleanStats) -> None:
    """自底向上删除空目录。"""
    for root, dirs, files in os.walk(directory, topdown=False):
        if root == directory:
            continue
        if _should_skip_dir(os.path.basename(root)):
            continue
        try:
            is_empty = not os.listdir(root)
        except OSError:
            continue
        if not is_empty:
            continue
        if config.dry_run:
            _emit(f"[DRY][EMPTY-DIR] {root}")
            stats.empty_dirs_deleted += 1
            continue
        try:
            os.rmdir(root)
            stats.empty_dirs_deleted += 1
            if config.verbose:
                _emit(f"[DEL][EMPTY-DIR] {root}", level=logging.DEBUG)
        except OSError as e:
            if config.verbose:
                _emit(f"[WARN] Rmdir fail {root}: {e}", level=logging.WARNING)


def _print_summary(stats: CleanStats) -> None:
    _emit("[SUMMARY] ===== Execution Result =====")
    _emit(f"[SUMMARY] Directories processed : {stats.dirs_processed}")
    _emit(f"[SUMMARY] Files scanned         : {stats.total_scanned}")
    _emit(f"[SUMMARY] Skipped (large)       : {stats.skipped_large}")
    _emit(f"[SUMMARY] Duplicate groups      : {stats.duplicate_groups}")
    _emit(f"[SUMMARY] Duplicate files seen  : {stats.duplicate_files_considered}")
    _emit(f"[SUMMARY] Deleted (duplicates)  : {stats.dup_deleted}")
    _emit(f"[SUMMARY] Deleted (matched)     : {stats.matched_deleted}")
    _emit(f"[SUMMARY] Empty dirs deleted    : {stats.empty_dirs_deleted}")
    _emit(f"[SUMMARY] Total deleted         : {stats.total_deleted}")
    _emit("[SUMMARY] =================================")


def run_clean(config: CleanConfig) -> Optional[CleanStats]:
    """执行清理逻辑并返回统计结果。"""
    # 清理路径：去掉首尾引号和末尾分隔符
    raw = config.directory.strip().strip('"').strip("'")
    raw = raw.rstrip(os.sep)
    directory = os.path.abspath(raw)
    if not os.path.isdir(directory):
        _emit(f"[ERROR] Not a directory: {directory}", level=logging.ERROR)
        return None
    config.directory = directory
    config.match_scope = _normalize_match_scope(config.match_scope)
    if config.match_scope not in VALID_MATCH_SCOPES:
        _emit(f"[ERROR] Invalid match scope: {config.match_scope}. Choose from: name, relative, full", level=logging.ERROR)
        return None

    keywords_lower = [keyword.lower() for keyword in config.keywords]
    first_chars = _build_keyword_first_chars(keywords_lower)
    stats = CleanStats()

    _print_run_configuration(directory, config, len(keywords_lower))

    # 阶段1：全局收集文件大小（跳过系统目录）
    _emit("[PHASE 1] Collecting file sizes...")
    file_sizes, size_to_files = _collect_all_files(directory, config.verbose, stats)
    _emit(f"[PHASE 1] Found {len(file_sizes)} files in {stats.dirs_processed} directories")

    # 阶段2：跨目录重复文件检测
    _emit("[PHASE 2] Detecting duplicates...")
    handled_files = _process_duplicate_files(size_to_files, file_sizes, config.max_size, config, stats)
    _emit(f"[PHASE 2] Found {stats.duplicate_groups} duplicate groups, deleted {stats.dup_deleted} files")

    # 阶段3：关键字匹配
    _emit("[PHASE 3] Keyword matching...")
    _process_keyword_matches(file_sizes, keywords_lower, first_chars, handled_files, config, stats)
    _emit(f"[PHASE 3] Deleted {stats.matched_deleted} matched files")

    # 阶段4：番号识别清理（可选）
    if config.video_code_mode:
        _emit("[PHASE 5] Video code folder cleanup...")
        _process_video_code_folders(directory, config, stats)
        _emit(f"[PHASE 5] Video code cleanup done")

    # 阶段4：删除空目录
    _emit("[PHASE 4] Removing empty directories...")
    _remove_empty_dirs(directory, config, stats)
    _emit(f"[PHASE 4] Removed {stats.empty_dirs_deleted} empty directories")

    _print_summary(stats)
    return stats


def delete_matching_files_and_empty_dirs(directory: str, keywords: List[str], max_size: int, hash_algo: str, dry_run: bool = False, verbose: bool = False, match_scope: str = "full", quick_hash: bool = True, video_code_mode: bool = False):
    config = CleanConfig(
        directory=directory,
        keywords=keywords,
        max_size=max_size,
        hash_algo=hash_algo,
        match_scope=match_scope,
        dry_run=dry_run,
        verbose=verbose,
        quick_hash=quick_hash,
        video_code_mode=video_code_mode,
    )
    return run_clean(config)


def parse_args(argv: Optional[List[str]] = None):
    p = argparse.ArgumentParser(description="清理匹配关键字/重复文件的工具")
    p.add_argument('-d', '--directory', required=True, help='要清理的目标根目录')
    p.add_argument('--keywords', help='额外关键字，逗号/分号/多个空格/换行分隔')
    p.add_argument('--keywords-file', help='包含关键字的文本文件，每行一个，# 开头忽略')
    p.add_argument('--max-size', type=int, default=100 * 1024 * 1024, help='仅删除 <= 该大小(字节) 的匹配文件，默认100MB')
    p.add_argument('--hash-algo', default='md5', choices=hashlib.algorithms_available, help='重复文件检测使用的哈希算法，默认md5')
    p.add_argument('--match-scope', default='full', choices=sorted(VALID_MATCH_SCOPES), help='关键字匹配范围：name=文件名，relative=相对路径，full=完整路径')
    p.add_argument('--dry-run', action='store_true', help='演练模式，只显示将删除的内容')
    p.add_argument('-v', '--verbose', action='store_true', help='详细输出')
    p.add_argument('--no-default-keywords', action='store_true', help='不使用内置默认关键字，只用自定义的')
    p.add_argument('--full-hash', action='store_true', help='禁用快速哈希预筛，始终计算完整哈希（更准确但更慢）')
    p.add_argument('--no-video-code', action='store_true', help='禁用番号识别模式（默认启用）')
    p.add_argument('--skip-dirs', help='额外要跳过的目录名，逗号分隔')
    return p.parse_args(argv)


def main():
    args = parse_args()
    configure_logging(verbose=args.verbose)

    # 处理额外跳过目录
    if args.skip_dirs:
        for d in re.split(r'[;,]', args.skip_dirs):
            d = d.strip()
            if d:
                SKIP_DIRS.add(d)

    base_list = [] if args.no_default_keywords else DEFAULT_KEYWORDS
    keywords = load_keywords(base_list, args.keywords, args.keywords_file, lowercase=True)
    if not keywords:
        _emit('[ERROR] 没有任何关键字，退出。', level=logging.ERROR)
        return
    if args.verbose:
        _emit(f"[INFO] Using {len(keywords)} keywords.", level=logging.DEBUG)
    delete_matching_files_and_empty_dirs(
        directory=args.directory,
        keywords=keywords,
        max_size=args.max_size,
        hash_algo=args.hash_algo,
        dry_run=args.dry_run,
        verbose=args.verbose,
        match_scope=args.match_scope,
        quick_hash=not args.full_hash,
        video_code_mode=not args.no_video_code,
    )


if __name__ == "__main__":
    main()
