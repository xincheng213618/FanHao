from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_DIR = Path(__file__).resolve().parents[1]


class ManagerReadPerformanceTests(unittest.TestCase):
    def test_large_history_keeps_queue_and_profile_reads_bounded_and_fresh(self):
        with tempfile.TemporaryDirectory(prefix="fanhao-manager-reads-") as root:
            environment = os.environ.copy()
            environment["DOUYIN_MANAGER_DATA_DIR"] = str(Path(root) / "data")
            environment["DOUYIN_MANAGER_LOG_DIR"] = str(Path(root) / "logs")
            script = r'''
from unittest.mock import patch
from manager_core.database import db, init_db, migrate_link_preview_columns
from manager_core.profile_refresh_policy import PROFILE_LINK_STATS_SQL
from manager_core.queue import list_download_queue
from manager_core import read_models

init_db()
with db() as conn:
    for pid in range(1, 5):
        conn.execute("INSERT INTO profiles(id,url,sec_uid,tab,nickname,created_at,updated_at) VALUES(?,?,?,'post',?,'2026-01-01','2026-01-01')",
                     (pid, f'https://example.invalid/{pid}', f'profile-{pid}', f'Profile {pid}'))
        conn.execute("INSERT INTO profile_download_queue(profile_id,sort_order,enabled,created_at,updated_at) VALUES(?,?,1,'2026-01-01','2026-01-01')", (pid, pid * 100))
    conn.executemany("INSERT INTO links(profile_id,aweme_id,kind,url,status,create_time,discovered_at,last_seen_at) VALUES(?,?,'video',?,'downloaded',?,'2026-01-01','2026-01-02')",
                     ((i % 3 + 1, str(i), f'https://example.invalid/work/{i}', (i // 2) if i > 3 else None) for i in range(12000)))
    # Repeated migration must preserve data and query indexes.
    migrate_link_preview_columns(conn)
    migrate_link_preview_columns(conn)
    ticks = [0]
    def progress():
        ticks[0] += 1
        return 0
    conn.set_progress_handler(progress, 100)
    assert list_download_queue(conn) == []
    conn.set_progress_handler(None, 0)
    assert ticks[0] < 30, ('idle queue scanned downloaded history', ticks)
    stats = {row['profile_id']: dict(row) for row in conn.execute(PROFILE_LINK_STATS_SQL)}
    for pid in range(1, 4):
        expected = conn.execute('SELECT DISTINCT create_time FROM links WHERE profile_id=? AND create_time IS NOT NULL ORDER BY create_time DESC LIMIT 2', (pid,)).fetchall()
        assert stats[pid]['total'] == 4000
        assert stats[pid]['latest_work_create_time'] == expected[0][0]
        assert stats[pid]['previous_work_create_time'] == expected[1][0]
    for expression in ['COALESCE(downloaded_at, last_started_at, last_seen_at, discovered_at)', 'COALESCE(downloaded_at, last_started_at, last_seen_at)']:
        plan = ' '.join(row['detail'] for row in conn.execute(f"EXPLAIN QUERY PLAN SELECT id FROM links WHERE status=? ORDER BY {expression} DESC, id DESC LIMIT 100", ('downloaded',)))
        assert 'TEMP B-TREE' not in plan, plan
    # Active profiles still include historical totals, while disabled and
    # completed profiles remain excluded. Quality upgrades retain priority.
    conn.execute("UPDATE links SET status='pending' WHERE id=1")
    conn.execute("UPDATE links SET status='pending',download_intent='quality_upgrade',digg_count=100 WHERE id=2")
    conn.execute("UPDATE links SET status='downloading' WHERE id=3")
    conn.execute("UPDATE profile_download_queue SET enabled=0 WHERE profile_id=3")
    queue = list_download_queue(conn)
    assert [row['profile_id'] for row in queue] == [2, 1], queue
    assert queue[0]['total'] == 4000 and queue[0]['downloaded'] == 3999
    assert queue[0]['quality_pending'] == 1 and queue[1]['pending'] == 1

trace = []
def traced_db():
    connection = db()
    connection.set_trace_callback(trace.append)
    return connection
with patch.object(read_models, 'db', traced_db):
    first = read_models.list_profiles({'scope': ['collected'], 'limit': ['2']})
assert first['total'] == 3 and len(first['profiles']) == 2
assert sum('FROM links' in sql and 'GROUP BY profile_id' in sql for sql in trace) == 1, trace
with db() as conn:
    conn.execute('DELETE FROM links WHERE profile_id=1')
second = read_models.list_profiles({'scope': ['collected'], 'q': ['Profile 1']})
assert second['total'] == 0 and second['profiles'] == [], second
all_profiles = read_models.list_profiles({'scope': ['all'], 'q': ['Profile 4']})
assert all_profiles['total'] == 1 and all_profiles['profiles'][0]['total'] == 0
print('Large-history query, ordering, aggregate and freshness checks passed.')
'''
            result = subprocess.run(
                [sys.executable, "-c", script], cwd=MODULE_DIR, env=environment,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
