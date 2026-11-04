// Offline full Python owners and native SQLite. No server, downloader, or real media.
// Timings are diagnostics; unchanged SQL, DTOs, query plans and VM work are gates.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manager = path.join(root, "src/modules/short-videos/download-manager");
const beforeCommit = "bfb83068aea34aa4972ceda0a0cbeca1162b08d9";
const owners = {
  "database.py": "666887e42e7795b000ed0bab8de0b8c56e04b10e389daba667873284eb4a62e4",
  "library.py": "3593268c9c0dcf5435bae50a3c1a10b1ec4b64ef90e594fb95dacc14524c17cb"
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manager-player-order-"));
const python = String.raw`
import contextlib, hashlib, importlib.util, json, os, sqlite3, statistics, sys, time, types
from pathlib import Path
from unittest.mock import patch

root, manager = Path(sys.argv[1]), Path(sys.argv[2])
negative = sys.argv[3] == 'legacy'
sys.path.insert(0, str(manager))
from manager_core import database, library

INDEX = 'idx_links_shared_player_order'
DDL_BLOCK = '''        conn.execute(
            "CREATE INDEX IF NOT EXISTS main.idx_links_shared_player_order ON links(status, "
            "COALESCE(downloaded_at, last_started_at, last_seen_at, '') DESC, id DESC) "
            "WHERE status='downloaded' AND COALESCE(media_type, '') <> 'article' "
            "AND COALESCE(kind, '') <> 'article'"
        )'''
current_source = (manager / 'manager_core/database.py').read_text(encoding='utf-8')
assert current_source.count(DDL_BLOCK) == 1, 'negative must remove exactly the new index DDL'

def module_from_source(name, source, file):
    module = types.ModuleType(name)
    module.__file__, module.__package__ = str(file), 'manager_core'
    sys.modules[name] = module
    exec(compile(source, str(file), 'exec'), module.__dict__)
    return module

before_db = module_from_source('manager_core._frozen_database', (root/'before-database.py').read_text(encoding='utf-8'), manager/'manager_core/database.py')
before = module_from_source('manager_core._frozen_library', (root/'before-library.py').read_text(encoding='utf-8'), manager/'manager_core/library.py')
without_index = module_from_source('manager_core._without_player_index', current_source.replace(DDL_BLOCK, '        pass  # fixture: omit only the new DDL'), manager/'manager_core/database.py')
active_db = module_from_source('manager_core._negative_player_index', current_source.replace(DDL_BLOCK, '        pass  # fixture: omit only the new DDL'), manager/'manager_core/database.py') if negative else database
before.db = before_db.db
library.db = active_db.db
contracts, failures = 0, 0

def connect(module, file):
    module.DB_PATH = file
    return module.db

def wire(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

def compare(call, *args, **kwargs):
    global contracts
    expected = getattr(before, call)(*args, **kwargs)
    actual = getattr(library, call)(*args, **kwargs)
    assert actual == expected, (call, args, kwargs, actual, expected)
    assert wire(actual) == wire(expected), ('wire/order', call, args)
    contracts += 1
    return actual

def compare_error(call, *args):
    global failures
    results = []
    for owner in (before, library):
        try:
            wire(getattr(owner, call)(*args))
        except Exception as error:
            results.append((type(error).__name__, str(error)))
        else:
            raise AssertionError(('expected native/serialization failure', call))
    assert results[0] == results[1], results
    failures += 1

files = {'synthetic.mp4': b'\0', 'synthetic.jpg': b'\0', 'synthetic.mp3': b'\0'}
for name, data in files.items(): (root/name).write_bytes(data)

def populate(module, count, padding=0, varied=False):
    module.init_db()
    with module.db() as conn:
        conn.execute("INSERT INTO profiles(id,url,sec_uid,tab,nickname,created_at,updated_at) VALUES(1,'https://example.invalid/p','author','post','Synthetic','2026-01-01','2026-01-01')")
        rows = []
        for i in range(1, count+1):
            media = ('gallery' if i%7 == 0 else 'video') if varied else 'video'
            kind = 'note' if media == 'gallery' else 'video'
            status = 'downloaded'
            stamp = f'2026-01-{i%28+1:02d}'
            downloaded, started, seen = stamp, None, stamp
            paths = ['synthetic.jpg'] if media == 'gallery' else ['synthetic.mp4']
            cover = 'synthetic.jpg'
            record = {'desc':f'Synthetic item {i}', 'fanhaoMedia':{'type':media,'width':640,'height':360}, 'tags':['tag', '中文'], 'padding':str(i).ljust(padding,'x')}
            metadata = json.dumps(record, ensure_ascii=False, separators=(',',':'))
            if varied:
                if i%13 == 0: media, kind = 'article', 'article'
                if i%17 == 0: status = 'pending'
                if i%19 == 0: paths = ['missing.mp4']; cover = ''
                if i%11 == 0: downloaded, started, seen = None, stamp, ''
                if i%23 == 0: downloaded, started, seen = None, None, ''
                if i%29 == 0: metadata = '{broken json'
                if i%31 == 0: metadata = '[1,2]'
                if i%37 == 0: media = 'ARTICLE' # Existing exact-case exclusion is intentional.
                if i%41 == 0: paths = ['synthetic.jpg','synthetic.jpg','synthetic.mp4','synthetic.mp3']
                if i%43 == 0: media = None
                if i%47 == 0: kind = ''
                if i%53 == 0: downloaded = ' '
                if i%59 == 0: downloaded = '2026-01-01\0suffix'
            rows.append((i,str(i),kind,f'https://example.invalid/{i}',status,i,seen,downloaded,started,str(root),json.dumps(paths),json.dumps([Path(p).name for p in paths]),media,metadata,cover,'author' if i%2 else 'other'))
        conn.executemany('''INSERT INTO links(id,profile_id,aweme_id,kind,url,status,create_time,discovered_at,last_seen_at,downloaded_at,last_started_at,output_dir,local_file_paths,local_file_names,media_type,metadata_json,local_cover_path,author_sec_uid)
          VALUES(?,1,?,?,?,?,?,'2026-01-01',?,?,?,?,?,?,?,?,?,?)''', rows)

before_path, current_path = root/'data/before.sqlite', root/'data/current.sqlite'
connect(before_db, before_path); connect(active_db, current_path)
populate(before_db, 88, varied=True); populate(active_db, 88, varied=True)
queries = [ {}, {'limit':['1']}, {'limit':['9'],'offset':['8']}, {'offset':['88']}, {'offset':['9999']}, {'q':['Synthetic item 2']}, {'q':['not present']}, {'author':['douyin:author']}, {'author':['other']}, {'author':['missing']}, {'media':['video']}, {'media':['gallery']}, {'media':['unknown']}, {'media':['gallery'],'author':['author'],'limit':['8']}, {'limit':['bad'],'offset':['-1']} ]
for query in queries: compare('shared_player_list', query)
for key in ('1','7','19','23','37','41','88','9999','invalid','0',' 2 '): compare('shared_player_detail', key)
compare('list_library', {'limit':['9'],'offset':['5']})
compare('shared_player_summary')
for key in ('1','7','23'):
    for direction in (-1,1):
        expected_row, actual_row = before.shared_player_row(key), library.shared_player_row(key)
        assert dict(actual_row) == dict(expected_row)
        expected, actual = before.shared_player_neighbor(expected_row,direction), library.shared_player_neighbor(actual_row,direction)
        assert actual == expected and wire(actual) == wire(expected)
        contracts += 1

# Timestamp nulls/numeric storage, metadata null/BLOB/primitive, legacy columns and
# unknown columns keep the full SELECT * path. Unsafe SQLite integers remain Python ints.
updates = [
    ("UPDATE links SET downloaded_at=0,last_started_at=NULL,last_seen_at='' WHERE id=2",()),
    ("UPDATE links SET metadata_json=NULL WHERE id=3",()),
    ("UPDATE links SET metadata_json=? WHERE id=4",(b'{"desc":"blob"}',)),
    ("UPDATE links SET metadata_json='null' WHERE id=5",()),
    ("UPDATE links SET create_time=9223372036854775807 WHERE id=6",()),
    ("ALTER TABLE links ADD COLUMN fixture_unused INTEGER",()),
    ("UPDATE links SET fixture_unused=9223372036854775807 WHERE id=8",())
]
for sql, params in updates:
    for owner in (before_db, active_db):
        with owner.db() as conn: conn.execute(sql,params)
    compare('shared_player_list', {'limit':['12']})
    compare('shared_player_detail','8')

# An external WAL writer changes membership, timestamps and metadata between calls;
# the next actual reader sees committed values, and a rolled-back change stays hidden.
for file in (before_path,current_path):
    with sqlite3.connect(file) as conn:
        conn.execute("UPDATE links SET status='pending' WHERE id=1")
        conn.execute("UPDATE links SET downloaded_at='2099-01-01',metadata_json=? WHERE id=2",(json.dumps({'tags':['changed']}),))
compare('shared_player_list', {})
assert compare('shared_player_detail','1') is None
compare('shared_player_detail','2')
for file in (before_path,current_path):
    conn=sqlite3.connect(file)
    conn.execute("UPDATE links SET status='failed' WHERE id=2")
    conn.rollback(); conn.close()
compare('shared_player_detail','2')

for owner in (before_db,active_db):
    with owner.db() as conn:conn.execute("UPDATE links SET downloaded_at=? WHERE id=2",(b'opaque-time',))
compare('shared_player_detail','2')
for owner in (before_db,active_db):
    with owner.db() as conn:conn.execute("UPDATE links SET downloaded_at='2026-01-02' WHERE id=2")
for owner in (before_db,active_db):
    with owner.db() as conn:conn.execute("UPDATE links SET metadata_json=CAST(X'80' AS TEXT) WHERE id=2")
compare_error('shared_player_detail','2')
for owner in (before_db,active_db):
    with owner.db() as conn:conn.execute("UPDATE links SET metadata_json='{}' WHERE id=2")
compare('shared_player_detail','2')

def initialization_contracts():
    global contracts
    migration = root/'data/migration.sqlite'
    connect(before_db,migration); before_db.init_db()
    with before_db.db() as conn:
        assert conn.execute('SELECT 1 FROM sqlite_schema WHERE name=?',(INDEX,)).fetchone() is None
        old_schema = [tuple(r) for r in conn.execute("SELECT type,name,sql FROM sqlite_schema WHERE name<>? ORDER BY name",(INDEX,))]
    connect(database,migration)
    database.init_db(); database.init_db()
    with database.db() as conn:
        assert conn.execute('SELECT 1 FROM sqlite_schema WHERE name=?',(INDEX,)).fetchone()
        assert [tuple(r) for r in conn.execute("SELECT type,name,sql FROM sqlite_schema WHERE name<>? ORDER BY name",(INDEX,))] == old_schema
        conn.execute('DROP INDEX '+INDEX)
        database.migrate_link_preview_columns(conn)
        assert conn.execute('SELECT 1 FROM sqlite_schema WHERE name=?',(INDEX,)).fetchone()
        conn.execute('DROP INDEX '+INDEX)
        conn.commit()
        conn.execute('BEGIN')
        conn.execute("UPDATE settings SET value='fixture-rollback' WHERE key='concurrency'")
        database.migrate_link_preview_columns(conn)
        assert conn.in_transaction
        conn.rollback()
        assert conn.execute('SELECT 1 FROM sqlite_schema WHERE name=?',(INDEX,)).fetchone() is None
        assert conn.execute("SELECT value FROM settings WHERE key='concurrency'").fetchone()[0] != 'fixture-rollback'
        # IF NOT EXISTS preserves an existing name, including an independently
        # installed different index; this migration never silently replaces it.
        conn.execute('CREATE INDEX '+INDEX+' ON links(id)')
        before_sql=conn.execute('SELECT sql FROM sqlite_schema WHERE name=?',(INDEX,)).fetchone()[0]
        database.migrate_link_preview_columns(conn)
        assert conn.execute('SELECT sql FROM sqlite_schema WHERE name=?',(INDEX,)).fetchone()[0] == before_sql
        conn.execute('DROP INDEX '+INDEX)
        conn.execute('CREATE INDEX fixture_other_index ON links(id)')
        database.migrate_link_preview_columns(conn)
        assert conn.execute("SELECT 1 FROM sqlite_schema WHERE name='fixture_other_index'").fetchone()
        conn.execute('DROP INDEX '+INDEX)
        conn.execute('CREATE TABLE '+INDEX+'(id INTEGER)')
        conn.commit()
        try:database.migrate_link_preview_columns(conn)
        except sqlite3.OperationalError as error:assert 'already a table' in str(error),str(error)
        else:raise AssertionError('index build failure was swallowed')
    contracts += 8

    # An existing writer can reject real index construction. The error remains
    # visible and a subsequent migration retries after that writer releases.
    with database.db() as reader:
        reader.execute('DROP TABLE '+INDEX)
        reader.commit()
        reader.execute('PRAGMA busy_timeout=0')
        writer=sqlite3.connect(migration)
        try:
            writer.execute('BEGIN IMMEDIATE')
            try:database.migrate_link_preview_columns(reader)
            except sqlite3.OperationalError as error:assert 'locked' in str(error),str(error)
            else:raise AssertionError('index writer-lock error was swallowed')
        finally:writer.rollback();writer.close()
        database.migrate_link_preview_columns(reader)
        assert reader.execute('SELECT 1 FROM sqlite_schema WHERE name=?',(INDEX,)).fetchone()
    contracts+=1

    with database.db() as conn:
        conn.execute('DROP INDEX main.'+INDEX)
        conn.execute('CREATE TEMP TABLE links AS SELECT * FROM main.links')
        conn.execute('CREATE INDEX temp.'+INDEX+' ON links(id)')
        database.migrate_link_preview_columns(conn)
        assert conn.execute('SELECT 1 FROM main.sqlite_schema WHERE name=?',(INDEX,)).fetchone()
        assert conn.execute('SELECT 1 FROM temp.sqlite_schema WHERE name=?',(INDEX,)).fetchone()
    contracts+=1

    # The preexisting initializer tolerates older libraries lacking kind. The
    # new optional index must not turn that tolerated schema into a startup error.
    missing_kind=root/'data/missing-kind.sqlite'
    connect(before_db,missing_kind);before_db.init_db()
    with before_db.db() as conn:
        for row in conn.execute("SELECT name FROM sqlite_schema WHERE type='trigger'").fetchall():
            conn.execute('DROP TRIGGER "'+row[0].replace('"','""')+'"')
        conn.execute('ALTER TABLE links DROP COLUMN kind')
    before_db.init_db()
    connect(database,missing_kind);database.init_db();database.init_db()
    with database.db() as conn:
        assert conn.execute('SELECT 1 FROM sqlite_schema WHERE name=?',(INDEX,)).fetchone() is None
        assert 'kind' not in {row['name'] for row in conn.execute('PRAGMA main.table_info(links)')}
    contracts+=1

initialization_contracts()

# Use the same current initializer with precisely one DDL removed for the work
# baseline: optimization measurements do not mix in any historical behavior.
connect(without_index,root/'data/scale-before.sqlite')
connect(active_db,root/'data/scale-current.sqlite')
before.db=without_index.db; library.db=active_db.db
populate(without_index,20000,padding=4096); populate(active_db,20000,padding=4096)

class CursorProbe:
    def __init__(self,cursor,sql,args,stats):self.cursor,self.sql,self.args,self.stats=cursor,sql,args,stats
    def finish(self,result):
        rows=result if isinstance(result,list) else [result]
        if self.sql.lstrip().upper().startswith('SELECT'):
            self.stats['sql'].append((self.sql,self.args))
            self.stats['rows']+=len(rows)
            for row in rows:
                if row is None:continue
                for value in row:
                    if isinstance(value,str):self.stats['textBytes']+=len(value.encode('utf-8'))
                    elif isinstance(value,bytes):self.stats['textBytes']+=len(value)
        return result
    def fetchone(self):return self.finish(self.cursor.fetchone())
    def fetchall(self):return self.finish(self.cursor.fetchall())

class ConnectionProbe:
    def __init__(self,creator,stats):
        self.conn,self.stats=creator(),stats
        self.conn.set_progress_handler(self.tick,100)
    def tick(self):self.stats['vm']+=100;return 0
    def __enter__(self):self.conn.__enter__();return self
    def __exit__(self,*args):return self.conn.__exit__(*args)
    def execute(self,sql,*args):return CursorProbe(self.conn.execute(sql,*args),sql,args,self.stats)

def measure(owner, creator, call, *args):
    stats={'rows':0,'textBytes':0,'vm':0,'stats':0,'sql':[]}
    original_stat=Path.stat
    def count_stat(p,*a,**kw):
        if p.name in files:stats['stats']+=1
        return original_stat(p,*a,**kw)
    with patch.object(owner,'db',lambda:ConnectionProbe(creator,stats)),patch.object(Path,'stat',count_stat):
        result=getattr(owner,call)(*args)
    with creator() as conn:
        plans=[[row['detail'] for row in conn.execute('EXPLAIN QUERY PLAN '+sql,*args)] for sql,args in stats['sql']]
    stats['plans']=plans
    return result,stats

budgets=[]; diagnostic={}
for call,args in [('shared_player_list',({},)),('shared_player_detail',('10000',))]:
    old,old_stats=measure(before,without_index.db,call,*args)
    actual,new_stats=measure(library,active_db.db,call,*args)
    assert actual==old and wire(actual)==wire(old)
    assert new_stats['rows']==old_stats['rows']
    assert new_stats['textBytes']==old_stats['textBytes'] # Index only: no bridge-copy claim.
    assert new_stats['stats']==old_stats['stats'] # All filesystem validity checks remain.
    assert new_stats['sql']==old_stats['sql'] # Exact production query semantics.
    contracts+=1
    timings={'before':[],'current':[]}
    for _ in range(5):
        for label,owner in [('before',before),('current',library)]:
            start=time.perf_counter();value=getattr(owner,call)(*args)
            timings[label].append((time.perf_counter()-start)*1000)
            assert wire(value)==wire(old)
    diagnostic[call]={'medianMs':{k:round(statistics.median(v),2) for k,v in timings.items()},'before':old_stats,'current':new_stats}
    budgets.append((call,old_stats,new_stats))

# Representative batch writes and index size are diagnostics, not timing gates.
write_times={'before':[],'current':[]}
for write_round in range(3):
    rows=[(f'2026-0{write_round+2}-{i%28+1:02d}',json.dumps({'fanhaoMedia':{'type':'video'},'padding':str(i+write_round*20000).ljust(4096,'x')}),i) for i in range(1,1001)]
    for label,module in [('before',without_index),('current',active_db)]:
        with module.db() as conn:
            started=time.perf_counter()
            conn.executemany("UPDATE links SET downloaded_at=?,metadata_json=? WHERE id=?",rows)
            conn.commit();write_times[label].append((time.perf_counter()-started)*1000)
write_ms={k:round(statistics.median(v),2) for k,v in write_times.items()}

print(json.dumps({'contracts':contracts,'errors':failures,'diagnostic':diagnostic,'write1000MedianMs':write_ms},ensure_ascii=False),flush=True)
# Every functional, error and byte/row/stat contract precedes the narrow negative.
for call,old_stats,new_stats in budgets:
    assert any('TEMP B-TREE' in line for plan in old_stats['plans'] for line in plan),('baseline missing sorting work',call)
    assert not any('TEMP B-TREE' in line for plan in new_stats['plans'] for line in plan),('shared player must not sort the library',call,new_stats['plans'])
    assert new_stats['vm'] < old_stats['vm'] * .4,('VM work budget',call,old_stats['vm'],new_stats['vm'])
print('Download manager shared-player index: complete contracts and native plan/work budgets passed.',flush=True)
`;

try {
  for (const [name, expectedHash] of Object.entries(owners)) {
    const source = execFileSync("git", ["show", `${beforeCommit}:src/modules/short-videos/download-manager/manager_core/${name}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).replace(/\r\n/g, "\n");
    assert.equal(crypto.createHash("sha256").update(source).digest("hex"), expectedHash);
    fs.writeFileSync(path.join(temp, `before-${name}`), source);
  }
  const script = path.join(temp, "fixture.py");
  fs.writeFileSync(script, python);
  execFileSync(process.env.PYTHON || "python", ["-B", script, temp, manager, process.argv.includes("--legacy-player-order") ? "legacy" : "current"], {
    cwd: root, stdio: "inherit", timeout: 180000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", DOUYIN_MANAGER_DATA_DIR: path.join(temp, "data"), DOUYIN_MANAGER_LOG_DIR: path.join(temp, "logs"), FANHAO_PROJECT_ROOT: temp }
  });
  const db = new DatabaseSync(path.join(temp, "data/scale-current.sqlite"), { readOnly: true });
  try {
    console.log("Shared-player index storage diagnostic:", JSON.stringify(db.prepare("SELECT COALESCE(SUM(pgsize), 0) AS indexBytes FROM dbstat WHERE name = 'idx_links_shared_player_order'").get()));
  } finally { db.close(); }
} finally {
  // The fixture owns only these flat files and empty directories. Never recurse.
  for (const name of ["before-database.py", "before-library.py", "fixture.py", "synthetic.mp4", "synthetic.jpg", "synthetic.mp3"]) fs.rmSync(path.join(temp, name), { force: true });
  for (const name of ["before.sqlite", "current.sqlite", "migration.sqlite", "missing-kind.sqlite", "scale-before.sqlite", "scale-current.sqlite"])
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(temp, "data", name + suffix), { force: true });
  for (const name of ["data/configs", "data", "logs", ""]) {
    const target = path.resolve(temp, name);
    assert.ok(target === temp || target.startsWith(temp + path.sep));
    if (fs.existsSync(target)) fs.rmdirSync(target);
  }
}
