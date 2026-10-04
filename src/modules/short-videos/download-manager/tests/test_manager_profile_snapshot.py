from __future__ import annotations

import unittest

from tests import test_manager_database_lifecycle


FIXTURE_SETUP = r'''
import sqlite3
from unittest.mock import patch
from manager_core import read_models
from manager_core.database import db, init_db

init_db()
with db() as conn:
    conn.executemany("INSERT INTO profiles(id,url,sec_uid,tab,nickname,created_at,updated_at) VALUES(?,?,?,'post',?,'2026-01-01','2026-01-01')",
                     [(1,'https://example.invalid/profile/1','fixture-1','Alpha'),
                      (2,'https://example.invalid/profile/2','fixture-2','Beta')])
    conn.executemany("INSERT INTO links(profile_id,aweme_id,kind,url,status,create_time,discovered_at,last_seen_at) VALUES(?,?,'video',?,?,?,'2026-01-01','2026-01-01')",
                     [(1,'a','https://example.invalid/a','pending',10),
                      (1,'b','https://example.invalid/b','downloaded',9),
                      (2,'c','https://example.invalid/c','failed',8)])

def assert_closed(connection):
    try:
        connection.execute('SELECT 1')
    except sqlite3.ProgrammingError:
        return
    raise AssertionError('profile read snapshot connection remained open')

def sql_text(sql):
    return ' '.join(sql.split())
'''


class ManagerProfileSnapshotTests(unittest.TestCase):
    run_isolated = test_manager_database_lifecycle.ManagerDatabaseLifecycleTests.run_isolated

    def test_aggregate_filter_and_profile_page_share_one_wal_snapshot(self):
        self.run_isolated(FIXTURE_SETUP + r'''
trace, readers, changed = [], [], [False]
def concurrent_write(sql):
    trace.append(sql)
    if sql_text(sql).startswith('SELECT COUNT(*) c FROM profiles') and not changed[0]:
        changed[0] = True
        with db() as writer:
            writer.execute("UPDATE profiles SET nickname='After update' WHERE id=1")
            writer.execute('DELETE FROM links WHERE profile_id=1')
def snapshot_db():
    connection = db()
    readers.append(connection)
    connection.set_trace_callback(concurrent_write)
    return connection
with patch.object(read_models, 'db', snapshot_db):
    result = read_models.list_profiles({'scope':['collected'], 'q':['Alpha']})
assert changed[0], 'fixture did not interleave a committed WAL writer'
assert result['total'] == len(result['profiles']) == 1, result
row = result['profiles'][0]
assert row['id'] == 1 and row['nickname'] == 'Alpha', row
assert (row['total'],row['pending'],row['downloaded']) == (2,1,1), row
assert (row['latest_work_create_time'],row['previous_work_create_time']) == (10,9), row
assert result['auto_candidate_count'] == result['eligible_count'] == 2, result
assert 'BEGIN' in trace and 'COMMIT' in trace, trace
assert_closed(readers[0])
current = read_models.list_profiles({'scope':['collected'], 'q':['After update']})
assert current['total'] == 0 and current['profiles'] == [], current
all_profiles = read_models.list_profiles({'scope':['all'], 'q':['After update']})
assert all_profiles['total'] == 1 and all_profiles['profiles'][0]['total'] == 0, all_profiles
assert all_profiles['auto_candidate_count'] == all_profiles['eligible_count'] == 1, all_profiles
''')

    def test_total_and_page_survive_author_deletion_during_the_request(self):
        self.run_isolated(FIXTURE_SETUP + r'''
trace, readers, changed = [], [], [False]
def concurrent_write(sql):
    trace.append(sql)
    if sql_text(sql).startswith('SELECT profiles.id, profiles.url, profiles.sec_uid') and not changed[0]:
        changed[0] = True
        with db() as writer:
            writer.execute('DELETE FROM profiles WHERE id=2')
def snapshot_db():
    connection = db()
    readers.append(connection)
    connection.set_trace_callback(concurrent_write)
    return connection
with patch.object(read_models, 'db', snapshot_db):
    result = read_models.list_profiles({'scope':['all'], 'limit':['1'], 'offset':['1']})
assert changed[0], 'fixture did not interleave a committed WAL writer'
assert result['total'] == 2 and [row['id'] for row in result['profiles']] == [1], result
assert 'BEGIN' in trace and 'COMMIT' in trace, trace
assert_closed(readers[0])
current = read_models.list_profiles({'scope':['all'], 'limit':['1'], 'offset':['1']})
assert current['total'] == 1 and current['profiles'] == [], current
with db() as writer:
    checkpoint = writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
    assert checkpoint[0] == 0, ('profile read retained a WAL snapshot', checkpoint)
''')

    def test_refresh_candidates_match_the_displayed_profile_settings(self):
        self.run_isolated(FIXTURE_SETUP + r'''
trace, readers, changed = [], [], [False]
def concurrent_write(sql):
    trace.append(sql)
    if sql_text(sql).startswith('SELECT profiles.tab, profiles.last_extracted_at, profiles.account_status') and not changed[0]:
        changed[0] = True
        with db() as writer:
            writer.execute("UPDATE profiles SET auto_collect_enabled=0, account_status='banned' WHERE id=1")
def snapshot_db():
    connection = db()
    readers.append(connection)
    connection.set_trace_callback(concurrent_write)
    return connection
with patch.object(read_models, 'db', snapshot_db):
    result = read_models.list_profiles({'scope':['collected']})
assert changed[0], 'fixture did not interleave a committed WAL writer'
assert all(row['auto_collect_enabled'] == 1 and row['account_status'] == 'active' for row in result['profiles']), result
assert result['paused_count'] == result['banned_count'] == 0, result
assert result['auto_candidate_count'] == result['eligible_count'] == 2, result
assert 'BEGIN' in trace and 'COMMIT' in trace, trace
assert_closed(readers[0])
current = read_models.list_profiles({'scope':['collected']})
by_id = {row['id']:row for row in current['profiles']}
assert by_id[1]['auto_collect_enabled'] == 0 and by_id[1]['refresh_due'] == 0, current
assert current['paused_count'] == 1 and current['auto_candidate_count'] == current['eligible_count'] == 1, current
''')

    def test_failed_and_interrupted_reads_rollback_and_close_the_snapshot(self):
        self.run_isolated(FIXTURE_SETUP + r'''
for failure in ['authorization', 'interrupt']:
    trace, readers, cancelled = [], [], [False]
    def failing_db():
        connection = db()
        readers.append(connection)
        def cancel_progress():
            cancelled[0] = True
            connection.set_progress_handler(None, 0)
            return 1
        def trace_read(sql):
            trace.append(sql)
            if failure == 'interrupt' and sql_text(sql).startswith('SELECT profiles.id, profiles.url, profiles.sec_uid'):
                connection.set_progress_handler(cancel_progress, 1)
        connection.set_trace_callback(trace_read)
        if failure == 'authorization':
            connection.set_authorizer(lambda action, table, *args: sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table == 'profiles' else sqlite3.SQLITE_OK)
        return connection
    with patch.object(read_models, 'db', failing_db):
        try:
            read_models.list_profiles({'scope':['collected']})
        except sqlite3.DatabaseError as error:
            if failure == 'interrupt':
                assert cancelled[0] and 'interrupted' in str(error), error
        else:
            raise AssertionError('fixture profile read should fail')
    assert 'BEGIN' in trace and 'ROLLBACK' in trace, (failure,trace)
    assert_closed(readers[0])
    with db() as writer:
        checkpoint = writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        assert checkpoint[0] == 0, ('failed read retained a WAL snapshot',checkpoint)
        writer.execute("INSERT INTO events(ts,level,message) VALUES('2026-01-01','info','fixture writer after failure')")
''')


if __name__ == '__main__':
    unittest.main()
