import argparse
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent


def main() -> None:
    args = parse_args()
    python = sys.executable

    if not args.no_import_actors:
        run_step(
            "1/3 actor页映射",
            [
                python,
                str(SCRIPT_DIR / "batch_import_javdb_actors.py"),
                "--db",
                str(args.db),
                "--library-index",
                str(args.library_index),
                "--profile-dir",
                str(args.profile_dir),
                "--chrome-binary",
                str(args.chrome_binary),
                "--sleep",
                str(args.sleep),
                "--jitter",
                str(args.jitter),
                "--min-work-count",
                str(args.min_work_count),
                *repeat_args("--source-prefix", args.source_prefix),
                *optional_path_args("--driver-path", args.driver_path),
                *optional_value_args("--proxy", args.proxy if not args.no_proxy else ""),
                *flag_args("--no-proxy", args.no_proxy),
                *flag_args("--headless", args.headless),
                *flag_args("--all-sources", args.all_sources),
                *flag_args("--fast", args.fast),
                *flag_args("--refresh", args.refresh_actor),
                *flag_args("--include-special", args.include_special),
                *flag_args("--cache-covers", args.cache_covers_during_actor_import),
            ],
        )

    if not args.no_backfill:
        run_step(
            "2/3 actor页补评分/封面",
            [
                python,
                str(SCRIPT_DIR / "backfill_javdb_actor_page.py"),
                "--db",
                str(args.db),
                "--library-index",
                str(args.library_index),
                "--profile-dir",
                str(args.profile_dir),
                "--chrome-binary",
                str(args.chrome_binary),
                "--write",
                "--mode",
                args.mode,
                "--sleep",
                str(args.sleep),
                "--jitter",
                str(args.jitter),
                *repeat_args("--source-prefix", args.source_prefix),
                *optional_path_args("--driver-path", args.driver_path),
                *optional_value_args("--proxy", args.proxy if not args.no_proxy else ""),
                *optional_int_args("--limit", args.limit),
                *optional_int_args("--limit-people", args.limit_people),
                *optional_int_args("--max-pages", args.max_pages),
                *flag_args("--no-proxy", args.no_proxy),
                *flag_args("--headless", args.headless),
                *flag_args("--fast", args.fast),
                *flag_args("--refresh", args.refresh),
                *flag_args("--refresh-actor", args.refresh_actor),
                *flag_args("--include-special", args.include_special),
                *flag_args("--no-cache-images", args.no_cache_images),
                *flag_args("--no-write-files", args.no_write_files),
                *flag_args("--overwrite-files", args.overwrite_files),
            ],
        )

    if not args.no_sync:
        run_step(
            "3/3 回写 info/cover 到文件夹",
            [
                python,
                str(SCRIPT_DIR / "sync_javdb_sidecars.py"),
                "--db",
                str(args.db),
                "--library-index",
                str(args.library_index),
                *repeat_args("--source-prefix", args.source_prefix),
                *flag_args("--all-sources", args.all_sources),
                *flag_args("--overwrite", args.overwrite_files),
                *flag_args("--write", not args.no_write_files),
            ],
        )


def parse_args() -> argparse.Namespace:
    project_root = SCRIPT_DIR.parent
    parser = argparse.ArgumentParser(description="Run JavDB actor import, metadata backfill, and sidecar sync in one command.")
    parser.add_argument("--db", type=Path, default=project_root / "data" / "actor-profiles.sqlite")
    parser.add_argument("--library-index", type=Path, default=project_root / "data" / "library-index.json")
    parser.add_argument("--profile-dir", type=Path, default=Path(r"C:\Users\17917\Desktop\Tool\data\selenium_user_data"))
    parser.add_argument("--chrome-binary", type=Path, default=Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"))
    parser.add_argument("--driver-path", type=Path, default=None)
    parser.add_argument("--proxy", default="http://127.0.0.1:10809")
    parser.add_argument("--no-proxy", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--source-prefix", action="append", default=[], help="可重复。例：--source-prefix F:/ --source-prefix O:/")
    parser.add_argument("--all-sources", action="store_true", help="只影响最终 sidecar 同步；普通场景建议用 --source-prefix。")
    parser.add_argument("--include-special", action="store_true")
    parser.add_argument("--mode", choices=["missing", "info", "cover", "both"], default="missing")
    parser.add_argument("--min-work-count", type=int, default=1)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--limit-people", type=int, default=0)
    parser.add_argument("--max-pages", type=int, default=0, help="0 表示 actor 页翻到没有下一页。")
    parser.add_argument("--sleep", type=float, default=8.0)
    parser.add_argument("--jitter", type=float, default=4.0)
    parser.add_argument("--fast", action="store_true")
    parser.add_argument("--refresh", action="store_true", help="重新抓作品信息/封面。")
    parser.add_argument("--refresh-actor", action="store_true", help="重新搜索/刷新 actor 页映射。")
    parser.add_argument("--cache-covers-during-actor-import", action="store_true")
    parser.add_argument("--no-cache-images", action="store_true", help="actor页补全时不下载远端封面/预览图到 remote_image_cache。")
    parser.add_argument("--no-write-files", action="store_true")
    parser.add_argument("--overwrite-files", action="store_true")
    parser.add_argument("--no-import-actors", action="store_true")
    parser.add_argument("--no-backfill", action="store_true")
    parser.add_argument("--no-sync", action="store_true")
    return parser.parse_args()


def run_step(label: str, command: list[str]) -> None:
    cleaned = [item for item in command if item != ""]
    print(f"\n=== {label} ===", flush=True)
    print(" ".join(quote_arg(item) for item in cleaned), flush=True)
    subprocess.run(cleaned, cwd=SCRIPT_DIR.parent, check=True)


def repeat_args(name: str, values: list[str]) -> list[str]:
    output = []
    for value in values:
        output.extend([name, value])
    return output


def optional_path_args(name: str, value: Path | None) -> list[str]:
    return [name, str(value)] if value else []


def optional_value_args(name: str, value: str) -> list[str]:
    return [name, value] if value else []


def optional_int_args(name: str, value: int) -> list[str]:
    return [name, str(value)] if value else []


def flag_args(name: str, enabled: bool) -> list[str]:
    return [name] if enabled else []


def quote_arg(value: str) -> str:
    if not value or any(char.isspace() for char in value):
        return '"' + value.replace('"', '\\"') + '"'
    return value


if __name__ == "__main__":
    main()
