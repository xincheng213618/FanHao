from __future__ import annotations

import unittest

from tests.test_manager_database_lifecycle import ManagerDatabaseLifecycleTests


SETUP = r'''
from manager_core.database import db, init_db
from manager_core.library_sync import migrate_library_sync
init_db()
with db() as conn:
    conn.execute("INSERT INTO profiles(id,url,sec_uid,tab,nickname,created_at,updated_at) VALUES(1,'https://example.invalid/1','author','post','Author','2026-01-01','2026-01-01')")
    conn.execute("INSERT INTO links(id,profile_id,aweme_id,kind,url,status,discovered_at,last_seen_at) VALUES(1,1,'work','video','https://example.invalid/work','downloaded','2026-01-01','2026-01-01')")
'''


class ManagerLibrarySyncTests(unittest.TestCase):
    run_isolated = ManagerDatabaseLifecycleTests.run_isolated

    def test_noop_volatile_timestamp_and_metadata_writes(self):
        self.run_isolated(SETUP + r'''
with db() as conn:
    initial = dict(conn.execute("SELECT entity,revision FROM library_sync_changes WHERE entity_key='work'").fetchall())
    conn.execute("UPDATE links SET attempts=attempts+1,last_error='retry' WHERE id=1")
    conn.execute("UPDATE links SET desc=desc WHERE id=1")
    assert dict(conn.execute("SELECT entity,revision FROM library_sync_changes WHERE entity_key='work'").fetchall()) == initial
    conn.execute("UPDATE links SET last_seen_at='2026-02-01' WHERE id=1")
    seen = dict(conn.execute("SELECT entity,revision FROM library_sync_changes WHERE entity_key='work'").fetchall())
    assert seen['membership'] > initial['membership'] and seen['work'] == initial['work']
    assert conn.execute('SELECT last_seen_at FROM library_sync_memberships WHERE link_id=1').fetchone()[0] == '2026-02-01'
    conn.execute("UPDATE links SET digg_count=42 WHERE id=1")
    assert conn.execute("SELECT revision FROM library_sync_changes WHERE entity='work' AND entity_key='work'").fetchone()[0] > initial['work']
    count = conn.execute('SELECT COUNT(*) FROM library_sync_changes').fetchone()[0]
    for i in range(100):
        conn.execute('UPDATE links SET digg_count=? WHERE id=1', (i,))
    assert conn.execute('SELECT COUNT(*) FROM library_sync_changes').fetchone()[0] == count
''')

    def test_identity_deletion_rollback_and_installation_recovery(self):
        self.run_isolated(SETUP + r'''
with db() as conn:
    generation = conn.execute('SELECT generation FROM library_sync_state').fetchone()[0]
    migrate_library_sync(conn)
    assert conn.execute('SELECT generation FROM library_sync_state').fetchone()[0] == generation
    conn.execute("UPDATE links SET id=2,aweme_id='renamed' WHERE id=1")
    projection = conn.execute('SELECT link_id,aweme_id FROM library_sync_memberships').fetchall()
    assert [tuple(row) for row in projection] == [(2,'renamed')]
    assert conn.execute("SELECT 1 FROM library_sync_changes WHERE entity='work' AND entity_key='work'").fetchone()
    assert conn.execute("SELECT 1 FROM library_sync_changes WHERE entity='work' AND entity_key='renamed'").fetchone()
    revision = conn.execute('SELECT MAX(revision) FROM library_sync_changes').fetchone()[0]
    conn.execute('SAVEPOINT rejected_download')
    conn.execute('DELETE FROM links WHERE id=2')
    conn.execute('ROLLBACK TO rejected_download')
    conn.execute('RELEASE rejected_download')
    assert conn.execute('SELECT MAX(revision) FROM library_sync_changes').fetchone()[0] == revision
    assert conn.execute('SELECT COUNT(*) FROM library_sync_memberships').fetchone()[0] == 1
    conn.execute('DELETE FROM profiles WHERE id=1')
    assert conn.execute('SELECT profile_id FROM library_sync_memberships WHERE link_id=2').fetchone()[0] is None
    conn.execute('DROP TRIGGER library_sync_link_insert')
    migrate_library_sync(conn)
    assert conn.execute('SELECT generation FROM library_sync_state').fetchone()[0] != generation
    conn.execute('DELETE FROM links WHERE id=2')
    assert conn.execute('SELECT COUNT(*) FROM library_sync_memberships').fetchone()[0] == 0
    assert conn.execute("SELECT 1 FROM library_sync_changes WHERE entity='membership' AND entity_key='renamed'").fetchone()
''')

    def test_reinitialization_preserves_journal_generation(self):
        self.run_isolated(SETUP + r'''
with db() as conn:
    generation = conn.execute('SELECT generation FROM library_sync_state').fetchone()[0]
init_db()
with db() as conn:
    assert conn.execute('SELECT generation FROM library_sync_state').fetchone()[0] == generation
    assert conn.execute('SELECT COUNT(*) FROM library_sync_memberships').fetchone()[0] == 1
''')


if __name__ == "__main__":
    unittest.main()
