import argparse
import json
import re
import sqlite3
from pathlib import Path

from code_parser import code_key, stored_code_key


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "data" / "actor-profiles.sqlite"
DEFAULT_LIBRARY_INDEX = PROJECT_ROOT / "data" / "library-index.json"
DEFAULT_SOURCE_PREFIXES = ["G:/"]


def main() -> None:
    args = parse_args()
    library = json.loads(args.library_index.read_text(encoding="utf-8"))
    people = scoped_people(library, args.source_prefix or DEFAULT_SOURCE_PREFIXES)
    works_by_id = {work.get("id"): work for work in library.get("works", []) if work.get("id")}
    global_local_keys = all_local_code_keys(library.get("works", []))

    with sqlite3.connect(args.db) as conn:
        if not table_exists(conn, "actor_movies"):
            print("actor_movies 缓存为空：请先跑 backfill_javdb_actor_page.py --refresh-actor --write")
            return
        actor_rows = load_actor_movies(conn)
        profile_counts = load_actor_profile_counts(conn)

    totals = {
        "people": len(people),
        "cached_people": 0,
        "remote_codes": 0,
        "local_codes": 0,
        "missing": 0,
        "rough_remote_total": 0,
        "rough_missing": 0,
    }
    rows = []
    for person in people:
        person_local_keys = local_code_keys(person, works_by_id)
        remote_keys = {
            stored_code_key(row.get("code_key")) or code_key(row.get("code"))
            for row in actor_rows.get(person.get("id"), [])
            if stored_code_key(row.get("code_key")) or code_key(row.get("code"))
        }
        missing_keys = sorted(remote_keys - global_local_keys)
        profile_total = int(profile_counts.get(person.get("id")) or 0)
        rough_missing = max(0, profile_total - len(person_local_keys)) if profile_total else 0

        totals["local_codes"] = len(global_local_keys)
        totals["remote_codes"] += len(remote_keys)
        totals["missing"] += len(missing_keys)
        totals["rough_remote_total"] += profile_total
        totals["rough_missing"] += rough_missing
        if remote_keys:
            totals["cached_people"] += 1

        if missing_keys or rough_missing or args.all_people:
            rows.append(
                {
                    "name": person.get("name") or "",
                    "local": len(remote_keys & global_local_keys) if remote_keys else len(person_local_keys),
                    "remote": len(remote_keys),
                    "missing": len(missing_keys),
                    "profile_total": profile_total,
                    "rough_missing": rough_missing,
                }
            )

    rows.sort(key=lambda item: (-item["missing"], -item["rough_missing"], item["name"]))
    print(
        "精确缓存: "
        f"人物={totals['people']} 已缓存={totals['cached_people']} "
        f"JavDB番号={totals['remote_codes']} 本地番号={totals['local_codes']} 未下载={totals['missing']}"
    )
    if totals["cached_people"] < totals["people"]:
        print(
            "粗略估算: "
            f"JavDB作品数={totals['rough_remote_total']} 本地番号={totals['local_codes']} "
            f"估算未下载={totals['rough_missing']}（actor_movies 没跑满前仅供参考）"
        )
    print()
    print("Top:")
    for row in rows[: args.limit]:
        missing_text = row["missing"] if row["remote"] else f"未缓存，估算 {row['rough_missing']}"
        print(
            f"{row['name']}: 未下载={missing_text} "
            f"本地={row['local']} JavDB缓存={row['remote']} JavDB资料={row['profile_total']}"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Report actor-page movies missing from local source folders.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--library-index", type=Path, default=DEFAULT_LIBRARY_INDEX)
    parser.add_argument("--source-prefix", action="append", default=[], help="默认 G:/；可重复。")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--all-people", action="store_true")
    return parser.parse_args()


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone()
    return bool(row)


def load_actor_movies(conn: sqlite3.Connection) -> dict[str, list[dict]]:
    rows_by_person: dict[str, list[dict]] = {}
    for row in conn.execute("SELECT person_id, code, code_key FROM actor_movies").fetchall():
        person_id, code, key = row
        rows_by_person.setdefault(person_id, []).append({"code": code, "code_key": key})
    return rows_by_person


def load_actor_profile_counts(conn: sqlite3.Connection) -> dict[str, int]:
    rows = conn.execute("SELECT person_id, movie_count FROM actor_profiles WHERE status = 'ok'").fetchall()
    return {person_id: int(movie_count or 0) for person_id, movie_count in rows}


def scoped_people(library: dict, prefixes: list[str]) -> list[dict]:
    people = []
    for person in library.get("people", []):
        paths = [person.get("relativePath") or "", *(person.get("sourcePaths") or [])]
        if any(source_path_matches(path, prefix) for path in paths for prefix in prefixes):
            people.append(person)
    return people


def source_path_matches(path: str, prefix: str) -> bool:
    normalized_path = normalize_source_path(path)
    normalized_prefix = normalize_source_path(prefix)
    return bool(
        normalized_path
        and normalized_prefix
        and (normalized_path == normalized_prefix or normalized_path.startswith(normalized_prefix + "/"))
    )


def normalize_source_path(value: str) -> str:
    path = str(value or "").strip().replace("\\", "/").lower()
    path = re.sub(r"/+$", "", path)
    if re.fullmatch(r"[a-z]", path):
        path = f"{path}:"
    return path


def local_code_keys(person: dict, works_by_id: dict[str, dict]) -> set[str]:
    keys = set()
    for work_id in person.get("works") or []:
        work = works_by_id.get(work_id)
        if not work:
            continue
        values = [
            work.get("title"),
            work.get("directoryName"),
            work.get("relativePath"),
            *[video.get("name") for video in work.get("videos") or []],
            *[video.get("title") for video in work.get("videos") or []],
        ]
        for value in values:
            key = code_key(value)
            if key:
                keys.add(key)
    return keys


def all_local_code_keys(works: list[dict]) -> set[str]:
    keys = set()
    for work in works:
        values = [
            work.get("title"),
            work.get("directoryName"),
            work.get("relativePath"),
            *[video.get("name") for video in work.get("videos") or []],
            *[video.get("title") for video in work.get("videos") or []],
        ]
        for value in values:
            key = code_key(value)
            if key:
                keys.add(key)
    return keys


if __name__ == "__main__":
    main()
