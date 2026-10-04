from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_DIR = Path(__file__).resolve().parents[1]


class ManagerDatabaseLifecycleTests(unittest.TestCase):
    def run_isolated(self, script: str) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-manager-database-") as root:
            environment = os.environ.copy()
            environment["DOUYIN_MANAGER_DATA_DIR"] = str(Path(root) / "data")
            environment["DOUYIN_MANAGER_LOG_DIR"] = str(Path(root) / "logs")
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            result = subprocess.run(
                [sys.executable, "-B", "-c", script], cwd=MODULE_DIR, env=environment,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_connections_close_after_commit_rollback_and_initialization_failure(self):
        self.run_isolated(r'''
import sqlite3
from unittest.mock import patch
from manager_core import database

database.init_db()
def assert_closed(connection):
    try:
        connection.execute('SELECT 1')
    except sqlite3.ProgrammingError:
        return
    raise AssertionError('database connection remained open')

with database.db() as committed:
    committed.execute("INSERT INTO settings(key,value) VALUES('lifecycle-fixture','committed')")
assert_closed(committed)
with database.db() as reader:
    assert reader.execute("SELECT value FROM settings WHERE key='lifecycle-fixture'").fetchone()[0] == 'committed'

try:
    with database.db() as rolled_back:
        rolled_back.execute("UPDATE settings SET value='should-rollback' WHERE key='lifecycle-fixture'")
        raise RuntimeError('fixture operation failed')
except RuntimeError as error:
    assert str(error) == 'fixture operation failed'
assert_closed(rolled_back)
with database.db() as reader:
    assert reader.execute("SELECT value FROM settings WHERE key='lifecycle-fixture'").fetchone()[0] == 'committed'
    reader.executescript('CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(parent_id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);')

try:
    with database.db() as commit_failed:
        commit_failed.execute('INSERT INTO fixture_child(parent_id) VALUES(999)')
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError('deferred foreign key commit should fail')
assert_closed(commit_failed)
with database.db() as reader:
    assert reader.execute('SELECT COUNT(*) FROM fixture_child').fetchone()[0] == 0

# Direct callers keep a real SQLite connection and can still close it explicitly.
direct = database.db()
assert isinstance(direct, sqlite3.Connection)
assert direct.execute('SELECT 1').fetchone()[0] == 1
direct.close()

class SetupFailure(database.ManagedConnection):
    def execute(self, sql, *args, **kwargs):
        if sql == 'PRAGMA foreign_keys=ON':
            raise sqlite3.OperationalError('fixture initialization failed')
        return super().execute(sql, *args, **kwargs)
initialization_failed = sqlite3.connect(':memory:', factory=SetupFailure)
with patch.object(database.sqlite3, 'connect', return_value=initialization_failed):
    try:
        database.db()
    except sqlite3.OperationalError as error:
        assert str(error) == 'fixture initialization failed'
    else:
        raise AssertionError('connection initialization should fail')
assert_closed(initialization_failed)
''')

    def test_link_count_summary_and_page_share_a_short_wal_snapshot(self):
        self.run_isolated(r'''
import sqlite3
from unittest.mock import patch
from manager_core.database import db, init_db
from manager_core import read_models

init_db()
for mutation in ['insert', 'delete']:
    with db() as conn:
        conn.execute('DELETE FROM links')
        conn.execute("INSERT INTO links(aweme_id,kind,url,status,discovered_at,last_seen_at) VALUES('original','video','https://example.invalid/original','pending','2026-01-01','2026-01-01')")
    trace, readers, changed = [], [], [False]
    def concurrent_write(sql):
        trace.append(sql)
        if sql.lstrip().startswith('SELECT links.status, COUNT(*)') and not changed[0]:
            changed[0] = True
            with db() as writer:
                if mutation == 'insert':
                    writer.execute("UPDATE links SET status='downloaded' WHERE aweme_id='original'")
                    writer.execute("INSERT INTO links(aweme_id,kind,url,status,discovered_at,last_seen_at) VALUES('new','video','https://example.invalid/new','pending','2026-01-01','2026-01-01')")
                else:
                    writer.execute("DELETE FROM links WHERE aweme_id='original'")
    def snapshot_db():
        connection = db()
        readers.append(connection)
        connection.set_trace_callback(concurrent_write)
        return connection
    query = {'status': ['pending'], 'view': ['manager'], 'include_summary': ['1']}
    with patch.object(read_models, 'db', snapshot_db):
        result = read_models.list_links(query)
    assert changed[0], 'fixture did not interleave a committed writer'
    assert result['total'] == result['summary']['pending'] == result['summary']['all'] == len(result['links']) == 1, result
    assert result['links'][0]['aweme_id'] == 'original' and result['links'][0]['status'] == 'pending'
    assert 'BEGIN' in trace and 'COMMIT' in trace, trace
    try:
        readers[0].execute('SELECT 1')
    except sqlite3.ProgrammingError:
        pass
    else:
        raise AssertionError('read snapshot connection remained open')
    current = read_models.list_links(query)
    assert current['total'] == (1 if mutation == 'insert' else 0), current
    if mutation == 'insert':
        assert current['links'][0]['aweme_id'] == 'new' and current['summary']['downloaded'] == 1
    without_summary = read_models.list_links({'view': ['manager']})
    assert 'summary' not in without_summary
    assert without_summary['total'] == len(without_summary['links'])
''')

    def test_link_read_failure_rolls_back_and_closes_the_snapshot(self):
        self.run_isolated(r'''
import sqlite3
from unittest.mock import patch
from manager_core.database import db, init_db
from manager_core import read_models

init_db()
trace, readers = [], []
def failing_db():
    connection = db()
    readers.append(connection)
    connection.set_trace_callback(trace.append)
    connection.set_authorizer(lambda action, table, *args: sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table == 'profiles' else sqlite3.SQLITE_OK)
    return connection
with patch.object(read_models, 'db', failing_db):
    try:
        read_models.list_links({'view': ['manager'], 'include_summary': ['1']})
    except sqlite3.DatabaseError:
        pass
    else:
        raise AssertionError('fixture page read should fail')
assert 'BEGIN' in trace and 'ROLLBACK' in trace, trace
try:
    readers[0].execute('SELECT 1')
except sqlite3.ProgrammingError:
    pass
else:
    raise AssertionError('failed read snapshot connection remained open')
with db() as writer:
    writer.execute("INSERT INTO events(ts,level,message) VALUES('2026-01-01','info','fixture writer after failure')")
''')


if __name__ == "__main__":
    unittest.main()
