from __future__ import annotations

import unittest

from tests import test_manager_database_lifecycle


class ManagerLinkCursorTests(unittest.TestCase):
    run_isolated = test_manager_database_lifecycle.ManagerDatabaseLifecycleTests.run_isolated

    def test_http_routes_reject_invalid_cursor_and_refresh_ids(self):
        self.run_isolated(r'''
from http import HTTPStatus
from unittest.mock import MagicMock
from manager_core.http_api import Handler

for path in ['/api/links?paging=cursor&cursor=broken', '/api/links/refresh?ids=0']:
    handler=object.__new__(Handler)
    handler.path=path
    handler.send_json=MagicMock()
    handler.do_GET()
    payload,status=handler.send_json.call_args.args
    assert status == HTTPStatus.BAD_REQUEST and payload['ok'] is False and payload['message'],(path,payload,status)
''')

    def test_cursor_page_uses_indexed_keyset_without_offset_or_temporary_sort(self):
        self.run_isolated(r'''
from unittest.mock import patch
from manager_core import read_models
from manager_core.database import db, init_db

init_db()
with db() as conn:
    conn.executemany("INSERT INTO links(aweme_id,kind,url,status,discovered_at,last_seen_at,downloaded_at) VALUES(?,'video',?,'downloaded','2026-01-01','2026-01-01',?)",
                     ((str(i),f'https://example.invalid/{i}',f'2026-01-{i%9+1:02}') for i in range(12000)))
query={'view':['manager'],'paging':['cursor'],'status':['downloaded'],'limit':['100']}
page=read_models.list_links(query)
for _ in range(52): page=read_models.list_links({**query,'cursor':[page['next_cursor']]})
trace=[]
def traced_db():
    conn=db(); conn.set_trace_callback(trace.append); return conn
with patch.object(read_models,'db',traced_db):
    next_page=read_models.list_links({**query,'cursor':[page['next_cursor']]})
page_statements=[sql for sql in trace if 'profiles.url profile_url' in sql]
assert len(page_statements) == 2 and len(next_page['links']) == 100,page_statements
with db() as conn:
    for page_sql in page_statements:
        assert 'OFFSET' not in page_sql,page_sql
        plan=' '.join(row['detail'] for row in conn.execute('EXPLAIN QUERY PLAN '+page_sql))
        assert 'idx_links_downloaded_order' in plan and 'TEMP B-TREE' not in plan,plan
        ticks=[0]
        def progress(): ticks[0]+=1; return 0
        conn.set_progress_handler(progress,100)
        conn.execute(page_sql).fetchall()
        conn.set_progress_handler(None,0)
        assert ticks[0] < 200,('cursor page scanned consumed rows',ticks,page_sql)
print('Deep downloaded cursor: expression index, no OFFSET or temporary sort.')
''')

    def test_id_cursor_survives_head_insertion_and_status_removal(self):
        self.run_isolated(r'''
from manager_core.database import db, init_db
from manager_core.read_models import list_links, refresh_links

init_db()
with db() as conn:
    conn.executemany("INSERT INTO links(id,aweme_id,kind,url,status,discovered_at,last_seen_at) VALUES(?,?,'video',?,'pending','2026-01-01','2026-01-01')",
                     [(i, str(i), f'https://example.invalid/{i}') for i in range(1,206)])
query = {'status':['pending'], 'view':['manager'], 'paging':['cursor'], 'include_summary':['1']}
first = list_links(query)
assert [r['id'] for r in first['links']] == list(range(205,105,-1)), first
with db() as conn:
    conn.execute("INSERT INTO links(id,aweme_id,kind,url,status,discovered_at,last_seen_at) VALUES(206,'new','video','https://example.invalid/new','pending','2026-01-01','2026-01-01')")
    conn.execute("UPDATE links SET status='downloaded' WHERE id=205")
second = list_links({**query,'cursor':[first['next_cursor']]})
assert [r['id'] for r in second['links']] == list(range(105,5,-1)), second
last = list_links({**query,'cursor':[second['next_cursor']]})
assert [r['id'] for r in last['links']] == [5,4,3,2,1] and not last['has_more'] and last['next_cursor'] is None, last
ids = [r['id'] for p in [first,second,last] for r in p['links']]
assert len(ids) == len(set(ids)) == 205 and set(ids) == set(range(1,206))
assert second['total'] == 204 and second['summary']['pending'] == 205
refreshed = refresh_links({**query,'cursor':[second['page_cursor']], 'ids':['205,105,206']})
assert [r['id'] for r in refreshed['links']] == [105] and refreshed['missing_ids'] == [205,206], refreshed
assert list_links(query)['links'][0]['id'] == 206, 'active reset must obtain a new watermark'
legacy = list_links({'status':['pending'],'limit':['3'],'offset':['1']})
assert [r['id'] for r in legacy['links']] == [204,203,202] and 'next_cursor' not in legacy
''')

    def test_downloaded_cursor_matches_null_fallback_and_tied_time_order(self):
        self.run_isolated(r'''
from manager_core.database import db, init_db
from manager_core.read_models import DOWNLOAD_TIME_SQL, list_links, refresh_links

init_db()
with db() as conn:
    for i in range(1,16):
        conn.execute("INSERT INTO links(id,aweme_id,kind,url,status,discovered_at,last_seen_at,last_started_at,downloaded_at) VALUES(?,?,'video',?,'downloaded',?,?,?,?)",
                     (i,str(i),f'https://example.invalid/{i}','2026-01-01', '2026-01-02' if i%3 else '',
                      '2026-01-03' if i%4 else None, '2026-01-04' if i%2 else None))
    expected = [r[0] for r in conn.execute(f'SELECT links.id FROM links ORDER BY {DOWNLOAD_TIME_SQL} DESC, links.id DESC')]
query = {'status':['downloaded'], 'view':['manager'], 'paging':['cursor'], 'limit':['3']}
page = list_links(query)
seen = [r['id'] for r in page['links']]
with db() as conn:
    conn.execute("INSERT INTO links(id,aweme_id,kind,url,status,discovered_at,last_seen_at,downloaded_at) VALUES(16,'new','video','https://example.invalid/new','downloaded','2026-01-01','2026-01-01','2026-01-05')")
while page['has_more']:
    page = list_links({**query,'cursor':[page['next_cursor']]})
    seen.extend(r['id'] for r in page['links'])
assert seen == expected and len(set(seen)) == len(seen), (seen,expected)
assert all('_cursor_time' not in r for r in page['links'])
# A row moving ahead of the consumed boundary is intentionally seen on reset.
first = list_links(query)
moving = expected[-1]
with db() as conn:
    conn.execute("UPDATE links SET downloaded_at='2026-01-06' WHERE id=?",(moving,))
next_page = list_links({**query,'cursor':[first['next_cursor']]})
assert moving not in [r['id'] for r in next_page['links']]
assert list_links(query)['links'][0]['id'] == moving
refreshed = refresh_links({**query,'cursor':[first['page_cursor']],'ids':[str(moving)]})
assert refreshed['missing_ids'] == [moving], refreshed
''')

    def test_cursor_validation_bounded_refresh_and_short_snapshot(self):
        self.run_isolated(r'''
import base64, json, sqlite3
from unittest.mock import patch
from manager_core import read_models
from manager_core.database import db, init_db

init_db()
with db() as conn:
    conn.execute("INSERT INTO links(id,aweme_id,kind,url,status,discovered_at,last_seen_at) VALUES(1,'1','video','https://example.invalid/1','pending','2026-01-01','2026-01-01')")
query = {'view':['manager'],'paging':['cursor'],'include_summary':['1']}
page = read_models.list_links(query)
raw = page['page_cursor']
cursor = json.loads(base64.urlsafe_b64decode(raw+'='*(-len(raw)%4)))
def token(value): return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
bad_queries = [{**query,'cursor':[raw],'q':['different']}, {**query,'cursor':[raw],'status':['failed']},
               {**query,'cursor':[raw],'view':['full']}, {**query,'cursor':[raw],'profile_id':['2']},
               {**query,'cursor':[raw],'offset':['1']}, {**query,'cursor':['bad']},
               {**query,'cursor':[token({**cursor,'bound':True})]},
               {**query,'cursor':[token({**cursor,'after':['',2]})]},
               {**query,'cursor':[token({**cursor,'head':['wrong-order',1]})]}]
for bad in bad_queries:
    try: read_models.list_links(bad)
    except ValueError: pass
    else: raise AssertionError(bad)
for ids in ['0','-1','1,2x',','.join(str(i) for i in range(1,102))]:
    try: read_models.refresh_links({**query,'ids':[ids]})
    except ValueError: pass
    else: raise AssertionError(ids)
trace, readers, changed = [], [], [False]
def concurrent_write(sql):
    trace.append(sql)
    if sql.lstrip().startswith('SELECT links.status, COUNT(*)') and not changed[0]:
        changed[0] = True
        with db() as writer: writer.execute("UPDATE links SET status='downloaded' WHERE id=1")
def snapshot_db():
    conn=db(); readers.append(conn); conn.set_trace_callback(concurrent_write); return conn
with patch.object(read_models,'db',snapshot_db):
    result=read_models.refresh_links({**query,'status':['pending'],'ids':['1,1']})
assert result['total'] == result['summary']['pending'] == len(result['links']) == 1 and result['missing_ids']==[],result
assert 'BEGIN' in trace and 'COMMIT' in trace,trace
try: readers[0].execute('SELECT 1')
except sqlite3.ProgrammingError: pass
else: raise AssertionError('refresh snapshot remained open')
assert read_models.refresh_links({**query,'status':['pending'],'ids':['1']})['missing_ids']==[1]
''')


if __name__ == "__main__":
    unittest.main()
