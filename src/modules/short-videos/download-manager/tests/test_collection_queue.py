from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


MODULE_DIR = Path(__file__).resolve().parents[1]


class CollectionQueueTest(unittest.TestCase):
    def run_isolated(self, code: str) -> dict:
        with tempfile.TemporaryDirectory(prefix="fanhao-collection-queue-") as temp:
            root = Path(temp)
            environment = os.environ.copy()
            environment.update(
                {
                    "PYTHONUTF8": "1",
                    "PYTHONIOENCODING": "utf-8",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "DOUYIN_MANAGER_DATA_DIR": str(root / "data"),
                    "DOUYIN_MANAGER_LOG_DIR": str(root / "logs"),
                    "LOCALAPPDATA": str(root / "local-app-data"),
                }
            )
            completed = subprocess.run(
                [sys.executable, "-c", textwrap.dedent(code)],
                cwd=MODULE_DIR,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
                check=True,
            )
            return json.loads(completed.stdout.strip())

    def test_collection_requests_run_in_order_and_deduplicate(self) -> None:
        result = self.run_isolated(
            """
            import json
            import threading
            import time

            from manager_core import extraction
            from manager_core.database import db, init_db, update_job
            from manager_core.read_models import get_activity_state

            init_db()
            started = threading.Event()
            release = threading.Event()
            executed = []

            def fake_run(job_id, url, *args, **kwargs):
                executed.append([job_id, url])
                started.set()
                if len(executed) == 1:
                    release.wait(5)
                update_job(job_id, status="complete", finished_at="done", message="fake complete")

            extraction.run_extract_job = fake_run
            first = extraction.start_extract({"url": "https://www.douyin.com/user/first"})
            assert started.wait(2)
            second = extraction.start_extract({"url": "https://www.douyin.com/user/second"})
            duplicate = extraction.start_extract({"url": "https://www.douyin.com/user/second"})
            third = extraction.start_extract({"url": "https://www.douyin.com/user/third"})
            queued_status = extraction.extract_status()
            activity_status = get_activity_state()
            release.set()
            deadline = time.time() + 5
            while extraction.extract_status()["active"] and time.time() < deadline:
                time.sleep(0.02)
            with db() as connection:
                jobs = [dict(row) for row in connection.execute("SELECT id, status FROM jobs ORDER BY id")]
            print(json.dumps({
                "first": first,
                "second": second,
                "duplicate": duplicate,
                "third": third,
                "queued_status": queued_status,
                "activity_status": activity_status,
                "final_status": extraction.extract_status(),
                "executed": executed,
                "jobs": jobs,
            }, ensure_ascii=False))
            """
        )
        self.assertFalse(result["first"]["queued"])
        self.assertTrue(result["second"]["queued"])
        self.assertEqual(result["second"]["queue_position"], 1)
        self.assertTrue(result["duplicate"]["duplicate"])
        self.assertEqual(result["duplicate"]["job_id"], result["second"]["job_id"])
        self.assertEqual(result["queued_status"]["queued"], 2)
        self.assertEqual(
            result["activity_status"]["extract"]["current"]["job_id"],
            result["first"]["job_id"],
        )
        self.assertEqual(
            [item["job_id"] for item in result["activity_status"]["extract"]["queue"]],
            [result["second"]["job_id"], result["third"]["job_id"]],
        )
        activity_jobs = {row["id"]: row for row in result["activity_status"]["jobs"]}
        self.assertEqual(activity_jobs[result["first"]["job_id"]]["status"], "running")
        self.assertEqual(activity_jobs[result["second"]["job_id"]]["status"], "queued")
        self.assertEqual(activity_jobs[result["third"]["job_id"]]["status"], "queued")
        self.assertFalse(result["final_status"]["active"])
        self.assertEqual(
            [row[0] for row in result["executed"]],
            [result["first"]["job_id"], result["second"]["job_id"], result["third"]["job_id"]],
        )
        self.assertEqual([row["status"] for row in result["jobs"]], ["complete", "complete", "complete"])

    def test_stop_cancels_waiting_collection_requests(self) -> None:
        result = self.run_isolated(
            """
            import json
            import threading
            import time

            from manager_core import extraction
            from manager_core.database import db, init_db, update_job

            init_db()
            started = threading.Event()

            def fake_run(job_id, url, *args, **kwargs):
                started.set()
                deadline = time.time() + 5
                while not extraction.extract_cancel_event.is_set() and time.time() < deadline:
                    time.sleep(0.01)
                update_job(job_id, status="stopped", finished_at="done", message="fake stopped")

            extraction.run_extract_job = fake_run
            first = extraction.start_extract({"url": "https://www.douyin.com/user/first"})
            assert started.wait(2)
            second = extraction.start_extract({"url": "https://www.douyin.com/user/second"})
            stopped = extraction.stop_extract()
            deadline = time.time() + 5
            while extraction.extract_status()["active"] and time.time() < deadline:
                time.sleep(0.02)
            with db() as connection:
                jobs = [dict(row) for row in connection.execute("SELECT id, status, message FROM jobs ORDER BY id")]
            print(json.dumps({
                "first": first,
                "second": second,
                "stopped": stopped,
                "status": extraction.extract_status(),
                "jobs": jobs,
            }, ensure_ascii=False))
            """
        )
        self.assertTrue(result["second"]["queued"])
        self.assertEqual(result["stopped"]["cancelled_queued"], 1)
        self.assertFalse(result["status"]["active"])
        self.assertEqual([row["status"] for row in result["jobs"]], ["stopped", "stopped"])
        self.assertEqual(result["jobs"][1]["message"], "采集队列已取消")

    def test_screen_reader_marker_is_repaired_from_work_author(self) -> None:
        result = self.run_isolated(
            """
            import json

            from manager_core.common import clean_profile_nickname
            from manager_core.database import db, init_db

            init_db()
            with db() as connection:
                cursor = connection.execute(
                    '''
                    INSERT INTO profiles(url, title, nickname, created_at, updated_at)
                    VALUES('https://www.douyin.com/user/author', '读屏标签已关闭', '读屏标签已关闭', 'now', 'now')
                    '''
                )
                profile_id = int(cursor.lastrowid)
                connection.execute(
                    '''
                    INSERT INTO links(
                      profile_id, aweme_id, kind, url, author_nickname,
                      discovered_at, last_seen_at
                    )
                    VALUES(?, 'work-1', 'video', 'https://www.douyin.com/video/work-1', '真实昵称', 'now', 'now')
                    ''',
                    (profile_id,),
                )
            init_db()
            with db() as connection:
                profile = dict(connection.execute(
                    "SELECT nickname, title FROM profiles WHERE id=?",
                    (profile_id,),
                ).fetchone())
            print(json.dumps({
                "profile": profile,
                "cleaned": clean_profile_nickname('读屏标签已关闭'),
            }, ensure_ascii=False))
            """
        )
        self.assertEqual(result["profile"]["nickname"], "真实昵称")
        self.assertEqual(result["profile"]["title"], "真实昵称")
        self.assertEqual(result["cleaned"], "")

    def test_periodic_collection_scheduler_submits_the_smart_collection_and_advances(self) -> None:
        result = self.run_isolated(
            """
            import json
            from datetime import datetime, timedelta, timezone

            from manager_core.collection_scheduler import AutomaticCollectionScheduler
            from manager_core.database import init_db, set_setting

            init_db()
            current = datetime(2026, 8, 23, 8, 0, tzinfo=timezone.utc)
            set_setting("automatic_collection_enabled", "1")
            set_setting("automatic_collection_interval_hours", "2")
            set_setting(
                "automatic_collection_next_run_at",
                (current - timedelta(seconds=1)).isoformat(timespec="seconds"),
            )
            submissions = []

            def submit(payload):
                submissions.append(payload)
                return {"ok": True, "job_id": 77, "queued": True, "queue_position": 1}

            scheduler = AutomaticCollectionScheduler(submit)
            due = scheduler.run_due_once(now=current)
            snapshot = scheduler.snapshot()
            waiting = scheduler.run_due_once(now=current + timedelta(hours=1))
            print(json.dumps({
                "due": due,
                "snapshot": snapshot,
                "waiting": waiting,
                "submissions": submissions,
            }, ensure_ascii=False))
            """
        )

        self.assertTrue(result["due"]["triggered"])
        self.assertEqual(result["due"]["job_id"], 77)
        self.assertTrue(result["due"]["queued"])
        self.assertEqual(result["submissions"], [{"automatic": True}])
        self.assertEqual(result["snapshot"]["interval_hours"], 2)
        self.assertEqual(result["snapshot"]["next_run_at"], result["due"]["next_run_at"])
        self.assertTrue(result["snapshot"]["last_started_at"])
        self.assertEqual(result["waiting"]["reason"], "waiting")


if __name__ == "__main__":
    unittest.main()
