from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_DIR = Path(__file__).resolve().parents[1]


class ProfileHistoryTest(unittest.TestCase):
    def test_history_backfill_only_uses_links_from_the_same_author(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-profile-history-backfill-") as root:
            environment = os.environ.copy()
            environment["DOUYIN_MANAGER_DATA_DIR"] = str(Path(root) / "data")
            environment["DOUYIN_MANAGER_LOG_DIR"] = str(Path(root) / "logs")
            script = r'''
import json
from manager_core.database import db, init_db, migrate_profile_observation_history

init_db()
with db() as connection:
    cursor = connection.execute(
        "INSERT INTO profiles(url, sec_uid, tab, nickname, created_at, updated_at) VALUES(?, ?, 'post', ?, ?, ?)",
        ("https://www.douyin.com/user/source-author", "source-author", "current-name", "2026-08-01", "2026-08-01"),
    )
    profile_id = int(cursor.lastrowid)
    for aweme_id, sec_uid, nickname in [
        ("work-other", "other-author", "unrelated-name"),
        ("work-source", "source-author", "legacy-name"),
    ]:
        connection.execute(
            "INSERT INTO links(profile_id, aweme_id, kind, url, author_sec_uid, author_nickname, discovered_at, last_seen_at) "
            "VALUES(?, ?, 'video', ?, ?, ?, '2026-07-01', '2026-08-01')",
            (profile_id, aweme_id, f"https://www.douyin.com/video/{aweme_id}", sec_uid, nickname),
        )
    connection.execute("DELETE FROM settings WHERE key='profile_observation_history_backfill_version'")
    migrate_profile_observation_history(connection)
    history = json.loads(connection.execute(
        "SELECT nickname_history_json FROM profiles WHERE id=?", (profile_id,)
    ).fetchone()["nickname_history_json"])
print(json.dumps([item["value"] for item in history], ensure_ascii=False))
'''
            probe = subprocess.run(
                [sys.executable, "-c", script],
                cwd=MODULE_DIR,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            )
            self.assertCountEqual(json.loads(probe.stdout.strip()), ["legacy-name", "current-name"])

    def test_metadata_refresh_preserves_names_likes_and_old_name_search(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-profile-history-") as root:
            environment = os.environ.copy()
            environment["DOUYIN_MANAGER_DATA_DIR"] = str(Path(root) / "data")
            environment["DOUYIN_MANAGER_LOG_DIR"] = str(Path(root) / "logs")
            script = r'''
import json
from manager_core.database import db, init_db
from manager_core.profiles_links import upsert_following_profiles, upsert_profile_metadata
from manager_core.read_models import list_profiles

init_db()
with db() as connection:
    cursor = connection.execute(
        "INSERT INTO profiles(url, sec_uid, tab, created_at, updated_at) VALUES(?, ?, 'post', ?, ?)",
        ("https://www.douyin.com/user/history-author", "history-author", "2026-08-01T00:00:00+08:00", "2026-08-01T00:00:00+08:00"),
    )
    profile_id = int(cursor.lastrowid)
upsert_profile_metadata(profile_id, {"nickname": "legacy-name", "total_favorited": 12000})
upsert_profile_metadata(profile_id, {"nickname": "current-name", "total_favorited": 15800})
upsert_profile_metadata(profile_id, {"nickname": "current-name", "total_favorited": 15800})
upsert_following_profiles([{"sec_uid": "followed-history", "nickname": "followed-old", "total_favorited": 300}])
upsert_following_profiles([{"sec_uid": "followed-history", "nickname": "followed-new", "total_favorited": 450}])
result = list_profiles({"scope": ["all"], "q": ["legacy-name"], "limit": ["20"]})
profile = result["profiles"][0]
followed = list_profiles({"scope": ["all"], "q": ["followed-old"], "limit": ["20"]})["profiles"][0]
print(json.dumps({
    "total": result["total"],
    "nickname": profile["nickname"],
    "names": json.loads(profile["nickname_history_json"]),
    "likes": json.loads(profile["total_favorited_history_json"]),
    "followed_names": json.loads(followed["nickname_history_json"]),
    "followed_likes": json.loads(followed["total_favorited_history_json"]),
}, ensure_ascii=False))
'''
            probe = subprocess.run(
                [sys.executable, "-c", script],
                cwd=MODULE_DIR,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            )
            result = json.loads(probe.stdout.strip())
            self.assertEqual(result["total"], 1)
            self.assertEqual(result["nickname"], "current-name")
            self.assertCountEqual([item["value"] for item in result["names"]], ["legacy-name", "current-name"])
            self.assertCountEqual([item["value"] for item in result["likes"]], [12000, 15800])
            self.assertCountEqual([item["value"] for item in result["followed_names"]], ["followed-old", "followed-new"])
            self.assertCountEqual([item["value"] for item in result["followed_likes"]], [300, 450])


if __name__ == "__main__":
    unittest.main()
