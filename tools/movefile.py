import os
import shutil
import stat
import subprocess
from dataclasses import dataclass
from collections import defaultdict
from threading import Thread
from typing import List, Iterable, Dict


class FileMover:
    def __init__(self, root_dirs, source_only_roots=None):
        self.root_dirs = root_dirs
        self.source_only_roots = {
            self.normalize_root(path)
            for path in (source_only_roots or [])
        }
        self.system_hidden_names = ['system volume information', '$recycle.bin']

    @staticmethod
    def normalize_root(path):
        return os.path.normcase(os.path.abspath(path))

    def is_hidden(self, filepath):
        base = os.path.basename(filepath).lower()
        # 过滤以 . 开头的隐藏文件、系统目录
        if base.startswith('.'):
            return True
        if base in self.system_hidden_names:
            return True
        # 检查路径中是否包含系统隐藏目录
        path_lower = filepath.lower()
        for sys_name in self.system_hidden_names:
            if sys_name in path_lower:
                return True
        # Windows 下检查文件属性是否为隐藏
        try:
            attrs = os.stat(filepath).st_file_attributes
            if attrs & stat.FILE_ATTRIBUTE_HIDDEN:
                return True
            if attrs & stat.FILE_ATTRIBUTE_SYSTEM:
                return True
        except Exception:
            pass
        return False

    def remove_empty_dirs(self, path):
        if not os.path.isdir(path):
            return
        for root, dirs, files in os.walk(path, topdown=False):
            for dir in dirs:
                dir_path = os.path.join(root, dir)
                try:
                    os.rmdir(dir_path)
                    print(f"[CLEAN] Removed empty directory: {dir_path}")
                except OSError:
                    pass
        try:
            os.rmdir(path)
            print(f"[CLEAN] Removed empty directory: {path}")
        except OSError:
            pass

    def robocopy_move(self, src, dst):
        if os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            try:
                # 对于文件，强制覆盖已存在文件
                if os.path.exists(dst):
                    os.remove(dst)
                shutil.move(src, dst)
            except Exception as e:
                print(f"[ERROR] shutil.move {src} -> {dst}: {e}")
        elif os.path.isdir(src):
            os.makedirs(dst, exist_ok=True)
            # 添加 /IS /IT 强制覆盖现有文件，不论时间戳
            # /IS: Include Same files (overwrites files even if they are the same)
            # /IT: Include Tweaked files (overwrites even if destination is newer)
            cmd = ["robocopy", src, dst, "/MOVE", "/E", "/IS", "/IT", "/R:2", "/W:2"]
            result = subprocess.run(cmd, shell=False)
            if result.returncode >= 8:
                print(f"[ERROR] robocopy failed {src} -> {dst} code={result.returncode}")
        else:
            print(f"[WARN] Source missing (skip): {src}")

    # 收集任务：按原规则 i>j 且 dst 同名目录存在
    def collect_tasks(self) -> List["MoveTask"]:
        tasks: List["MoveTask"] = []
        for i, src_root in enumerate(self.root_dirs):
            if not os.path.isdir(src_root):
                print(f"[WARN] Source root not found: {src_root}")
                continue
            for j, dst_root in enumerate(self.root_dirs):
                if i <= j:
                    continue
                if not os.path.isdir(dst_root):
                    continue
                if self.normalize_root(dst_root) in self.source_only_roots:
                    continue
                try:
                    folder_names = os.listdir(src_root)
                except Exception as e:
                    print(f"[ERROR] Failed to list {src_root}: {e}")
                    continue
                for folder_name in folder_names:
                    src_folder = os.path.join(src_root, folder_name)
                    if not os.path.isdir(src_folder) or self.is_hidden(src_folder):
                        continue
                    dst_folder = os.path.join(dst_root, folder_name)
                    if not os.path.exists(dst_folder):
                        continue
                    dest_drive = os.path.splitdrive(dst_folder)[0].upper()
                    tasks.append(MoveTask(src_folder, dst_folder, dest_drive))
        # 去重
        seen = set()
        uniq = []
        for t in tasks:
            key = (t.src_folder, t.dst_folder)
            if key not in seen:
                seen.add(key)
                uniq.append(t)
        print(f"[INFO] Collected {len(uniq)} tasks from roots: {self.root_dirs}")
        return uniq

    # 按目标盘并行，同盘顺序
    def run_tasks(self, tasks: Iterable["MoveTask"], parallel=True):
        tasks = list(tasks)
        if not tasks:
            print("[INFO] No tasks to run.")
            return

        vr = sum(1 for t in tasks if t.is_vr())
        print(f"[PLAN] Total {len(tasks)} tasks (VR={vr}, NonVR={len(tasks) - vr})")

        groups: Dict[str, List["MoveTask"]] = defaultdict(list)
        for t in tasks:
            groups[t.dest_drive].append(t)

        for d, lst in groups.items():
            print(f"    Drive {d}: {len(lst)} tasks")

        if not parallel:
            for d in sorted(groups.keys()):
                print(f"[SEQ] Start drive {d}")
                for t in groups[d]:
                    t.execute(self)
                print(f"[SEQ] Done drive {d}")
            print("[ALL DONE] Sequential mode complete")
            return

        threads = []
        def worker(drive, drive_tasks):
            print(f"[THREAD] Drive {drive} start ({len(drive_tasks)} tasks)")
            for t in drive_tasks:
                t.execute(self)
            print(f"[THREAD] Drive {drive} done")

        for drive, drive_tasks in groups.items():
            th = Thread(target=worker, args=(drive, drive_tasks), daemon=True)
            th.start()
            threads.append(th)

        for th in threads:
            th.join()
        print("[ALL DONE] Parallel mode complete")

@dataclass
class MoveTask:
    src_folder: str
    dst_folder: str
    dest_drive: str

    def label(self):
        return f"{self.src_folder} => {self.dst_folder}"

    def is_vr(self):
        up = self.src_folder.upper()
        return '\\VR\\' in up or up.endswith('\\VR')

    def execute(self, mover: FileMover):
        if not os.path.isdir(self.src_folder):
            print(f"[SKIP] Source folder doesn't exist: {self.src_folder}")
            return
        if not os.path.exists(self.dst_folder):
            print(f"[SKIP] Destination folder doesn't exist: {self.dst_folder}")
            return
        print(f"[RUN] {self.label()}")
        try:
            for item in os.listdir(self.src_folder):
                src_item = os.path.join(self.src_folder, item)
                if mover.is_hidden(src_item):
                    continue
                dst_item = os.path.join(self.dst_folder, item)
                mover.robocopy_move(src_item, dst_item)
            mover.remove_empty_dirs(self.src_folder)
        except Exception as e:
            print(f"[ERROR] Task failed {self.label()}: {e}")


DEFAULT_ROOTS_NORMAL = ["G:\\", "F:\\", "O:\\[珍藏1]", "O:\\[珍藏]", "O:\\", "D:\\", "D:\\Organized"]
DEFAULT_ROOTS_VR = ["V:\\[A1]", "V:\\[A]", "V:\\AV\\VR", "D:\\VR", "D:\\Organized\\VR", "V:\\缓存\\VR"]
SOURCE_ONLY_ROOTS_NORMAL = ["D:\\Organized"]
SOURCE_ONLY_ROOTS_VR = ["D:\\Organized\\VR", "V:\\缓存\\VR"]
PARALLEL_BY_DRIVE = True


def main():
    roots_normal = DEFAULT_ROOTS_NORMAL
    roots_vr = DEFAULT_ROOTS_VR
    print("[MODE] Project move mode: parallel by target drive")

    # 常规任务
    mover_normal = FileMover(roots_normal, SOURCE_ONLY_ROOTS_NORMAL)
    tasks_normal = mover_normal.collect_tasks()
    print(f"[INFO] Collected {len(tasks_normal)} normal tasks")

    # VR 任务
    mover_vr = FileMover(roots_vr, SOURCE_ONLY_ROOTS_VR)
    tasks_vr = mover_vr.collect_tasks()
    print(f"[INFO] Collected {len(tasks_vr)} VR tasks")

    if len(tasks_vr) == 0:
        print("[WARN] No VR tasks found! Check if VR directories exist and contain valid folders")
        for dir in roots_vr:
            if os.path.exists(dir):
                print(f"  - {dir}: exists")
            else:
                print(f"  - {dir}: MISSING")

    combined = tasks_normal + tasks_vr

    all_roots = roots_normal + roots_vr
    mover_all = FileMover(all_roots, SOURCE_ONLY_ROOTS_NORMAL + SOURCE_ONLY_ROOTS_VR)
    mover_all.run_tasks(combined, parallel=PARALLEL_BY_DRIVE)


if __name__ == "__main__":
    main()
