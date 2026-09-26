import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createNovelStore } from "../src/modules/novels/server/store.js";
import { routeNovelApi } from "../src/modules/novels/server/routes.js";
import { reconcileChapters } from "../src/modules/novels/server/chapter-identity.js";
import { clampReadingProgress as legacyClamp, chapterId as legacyChapterId } from "./fixtures/novel-model/legacy-clamp.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-chapter-identity-"));
const vectors = JSON.parse(fs.readFileSync(path.join(root, "tools/fixtures/novel-model/chapter-identity-vectors.json"), "utf8")).cases;
const coordinatorPath = path.join(root, "src/modules/novels/server/chapter-identity.js");
const coordinatorSource = fs.readFileSync(coordinatorPath, "utf8");
const storeSource = fs.readFileSync(path.join(root, "src/modules/novels/server/store.js"), "utf8");
const tests = []; let number = 0, checks = 0, negative = 0;
const test = (name, run) => tests.push({ name, run });
const owned = name => { const result = path.resolve(temporary, name); assert(result.startsWith(temporary + path.sep)); return result; };
const fresh = (factory = createNovelStore) => { const dbPath = owned(`library-${++number}.sqlite`); return { dbPath, store: factory({ dbPath }) }; };
const sql = (dbPath, fn) => { assert(dbPath.startsWith(temporary + path.sep)); const db = new DatabaseSync(dbPath); try { return fn(db); } finally { db.close(); } };
const snapshot = dbPath => sql(dbPath, db => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => ({...t,rows:db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()})));
const collected = chapters => ({ sourceUrl: "https://synthetic.invalid/a", title: "Synthetic", chapters });
const chapter = (title, content) => ({title,content});
const base = [chapter("A", "exact body A"), chapter("B", "exact body B"), chapter("C", "exact body C")];
function writeProgress(store, detail, index, ratio = 0.6) {
  const target = detail.chapters.find(c => c.index === index);
  return store.saveProgress(detail.book.id, { sourceRealm: detail.sourceRealm, catalogRevision: detail.catalogRevision,
    chapterId: target.id, chapterIndex: index, scrollRatio: ratio });
}
function python(code, args = [], input) {
  const result = spawnSync(process.env.PYTHON || "python", ["-B", "-c", code, ...args], { cwd: root, input, encoding: "utf8", windowsHide: true, timeout: 20000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE:"1", PYTHONIOENCODING:"utf-8" } });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout;
}
function scan(dbPath, sourceRoot, file = null) {
  const args = [path.join(root,"tools/rescan_novel_library.py"), "--db", dbPath, ...(file ? ["--file", file, "--source-root", sourceRoot] : ["--root", sourceRoot])];
  assert(args.includes("--root") || args.includes("--source-root"));
  return python("import runpy,sys; target=sys.argv[1]; sys.path.insert(0,'tools'); sys.argv=sys.argv[1:]; runpy.run_path(target,run_name='__main__')", args);
}
function vectorResult(vector, reconcile = reconcileChapters) {
  let allocated = 0;
  return reconcile({ ...structuredClone(vector), oldRevision:"r1", newRevision:"r2", allocateId:()=>`new-${++allocated}` });
}
function assertVector(vector, result) {
  assert.deepEqual(result.chapters.map(c=>c.id), vector.ids);
  assert.equal(result.progress?.status ?? null, vector.status);
  if (vector.reason) assert.equal(result.progress.reason, vector.reason);
  if (vector.status === "resolved") for (const key of ["chapterId","chapterIndex","scrollRatio"]) assert.equal(result.progress[key], vector[key]);
  if (vector.candidate) assert.deepEqual(result.progress.candidate, vector.candidate);
  if (result.progress && result.progress.status !== "resolved") assert.deepEqual(result.progress.previous, vector.progress.previous || {
    chapterId:vector.progress.chapterId,chapterIndex:vector.progress.chapterIndex,scrollRatio:vector.progress.scrollRatio,catalogRevision:vector.progress.catalogRevision
  });
}

test("shared vectors execute both full production coordinators", () => {
  const output = JSON.parse(python("import sys,json; sys.path.insert(0,'tools'); from novel_chapter_identity import reconcile_chapters; v=json.load(sys.stdin); out=[]\nfor x in v:\n n=iter(range(1,100)); out.append(reconcile_chapters(x['oldChapters'],x['incomingChapters'],'r1','r2',x['progress'],lambda:'new-'+str(next(n))))\nprint(json.dumps(out))", [], JSON.stringify(vectors)));
  vectors.forEach((vector, i) => { const result=vectorResult(vector); assertVector(vector,result); assert.deepEqual(output[i], result); checks++; });
});

test("actual collected replacement preserves IDs across insert/reorder, rotates revision and maps only exact progress", ({factory=createNovelStore}={}) => {
  const {store}=fresh(factory), old=store.importCollectedBook(collected(base)); writeProgress(store,old,2);
  const next=store.importCollectedBook(collected([chapter("Prelude","new prelude"),base[2],base[1],base[0]]));
  assert.notEqual(next.catalogRevision,old.catalogRevision); assert.equal(next.book.catalogRevision,next.catalogRevision);
  assert.deepEqual(next.chapters.slice(1).map(c=>c.id),[old.chapters[2].id,old.chapters[1].id,old.chapters[0].id]);
  assert.equal(next.book.progress.chapterId,old.chapters[1].id); assert.equal(next.book.progress.chapterIndex,3); assert.equal(next.book.progress.scrollRatio,0.6);
  assert.equal(next.book.firstChapterId,next.chapters[0].id); assert.equal(next.book.latestChapterId,next.chapters.at(-1).id);
});

test("title-only changes require review and repeated imports never silently resurrect the prior anchor", () => {
  const {store}=fresh(), old=store.importCollectedBook(collected(base)); writeProgress(store,old,2);
  const changed=store.importCollectedBook(collected([base[0],chapter("B","changed body"),base[2]]));
  assert.equal(changed.book.progress,null); assert.equal(changed.book.progressRecovery.status,"needs_review");
  assert.notEqual(changed.chapters[1].id,old.chapters[1].id); assert.equal(changed.book.progressRecovery.candidate.scrollRatio,0);
  assert.equal(changed.book.progressRecovery.candidate.title,"B"); const anchor=changed.book.progressRecovery.previous;
  const again=store.importCollectedBook(collected(base)); assert.equal(again.book.progress,null); assert.equal(again.book.progressRecovery.status,"unresolved");
  assert.deepEqual(again.book.progressRecovery.previous,anchor); assert.equal(again.book.progressRecovery.candidate,undefined);
  writeProgress(store,again,1,0); assert.equal(store.bookMeta(old.book.id).book.progressRecovery,null);
});

test("duplicate body/delete do not clamp or recover a ratio", () => {
  for (const incoming of [[base[0],base[2]],[base[0],base[1],chapter("Different title",base[1].content)]]) {
    const {store}=fresh(), old=store.importCollectedBook(collected(base)); writeProgress(store,old,2);
    const next=store.importCollectedBook(collected(incoming)); assert.equal(next.book.progress,null);
    assert.equal(next.book.progressRecovery.status,"unresolved"); assert.equal(next.book.progressRecovery.previous.chapterId,old.chapters[1].id);
  }
});

test("legacy index clients work initially, but stale/missing revisions and wrong chapter IDs cannot write after replacement", ({factory=createNovelStore}={}) => {
  const {store,dbPath}=fresh(factory), old=store.importCollectedBook(collected(base));
  store.saveProgress(old.book.id,{chapterIndex:2,scrollRatio:0.4});
  const next=store.importCollectedBook(collected([base[1],base[0],base[2]])), before=snapshot(dbPath);
  for (const body of [
    {chapterIndex:2,scrollRatio:0.9},
    {catalogRevision:old.catalogRevision,chapterId:old.chapters[1].id,chapterIndex:1,scrollRatio:0.9},
    {catalogRevision:next.catalogRevision,chapterId:next.chapters[0].id,chapterIndex:2,scrollRatio:0.9},
    {catalogRevision:next.catalogRevision,chapterId:"foreign-chapter",scrollRatio:0.9}
  ]) assert.throws(()=>store.saveProgress(old.book.id,body),e=>e.statusCode===409);
  assert.deepEqual(snapshot(dbPath),before); writeProgress(store,next,1,0.8);
  assert.equal(store.bookMeta(old.book.id).book.progress.scrollRatio,0.8);
});

test("actual chapter/catalog routes reject stale revision and ID query while legacy index reads remain available", async () => {
  const {store}=fresh(), old=store.importCollectedBook(collected(base));
  const next=store.importCollectedBook(collected([base[1],base[0],base[2]]));
  const request = async endpoint => {
    const replies=[]; await routeNovelApi({method:"GET"},{},new URL(`http://synthetic.invalid/api/novels/${old.book.id}/${endpoint}`),{
      novelStore:store, sendJson:(_res,status,body)=>replies.push({status,body}), notFound:()=>replies.push({status:404})
    }); assert.equal(replies.length,1); return replies[0];
  };
  assert.equal((await request(`chapters/1?catalogRevision=${old.catalogRevision}`)).status,409);
  assert.equal((await request(`chapters/1?catalogRevision=${next.catalogRevision}&chapterId=${old.chapters[0].id}`)).status,409);
  assert.equal((await request(`catalog?catalogRevision=${old.catalogRevision}`)).status,409);
  const good=await request(`chapters/1?catalogRevision=${next.catalogRevision}&chapterId=${next.chapters[0].id}`);
  assert.equal(good.status,200); assert.equal(good.body.catalogRevision,next.catalogRevision); assert.equal(good.body.chapter.content,base[1].content);
  assert.equal((await request("chapters/1")).status,200);
});

test("a real SQLite writer between book and chapter SELECTs cannot mix old revision with new body", ({factory=createNovelStore}={}) => {
  const {store,dbPath}=fresh(factory), old=store.importCollectedBook(collected(base));
  const writer=createNovelStore({dbPath});
  const original=DatabaseSync.prototype.prepare; let armed=true, committed=false;
  DatabaseSync.prototype.prepare=function(query,...args) {
    if(armed && /SELECT id, book_id, chapter_index, title, content, char_count, updated_at\s+FROM novel_chapters\s+WHERE book_id = \? AND chapter_index = \?/.test(query)) {
      armed=false; writer.importCollectedBook(collected([chapter("A","replacement A"),base[1],base[2]])); committed=true;
    }
    return original.call(this,query,...args);
  };
  let response;
  try { assert.doesNotThrow(()=>{response=store.chapterDetail(old.book.id,1,{catalogRevision:old.catalogRevision,chapterId:old.chapters[0].id});}); }
  finally {DatabaseSync.prototype.prepare=original;}
  assert.equal(committed,true); assert.equal(response.catalogRevision,old.catalogRevision); assert.equal(response.chapter.content,base[0].content);
  assert.notEqual(writer.bookMeta(old.book.id).book.catalogRevision,old.catalogRevision);
});

test("progress revision check and write hold one real SQLite writer transaction", () => {
  const {store,dbPath}=fresh(), detail=store.importCollectedBook(collected(base));
  const original=DatabaseSync.prototype.prepare; let armed=true, blocked=false;
  DatabaseSync.prototype.prepare=function(query,...args) {
    if(armed && query.includes("SELECT id, chapter_index FROM novel_chapters WHERE book_id = ? AND id = ?")) {
      armed=false;
      sql(dbPath,db=>{db.exec("PRAGMA busy_timeout=1"); try{db.exec("UPDATE novel_books SET catalog_revision='interleaved'");}catch(error){assert.equal(error.errcode,5);blocked=true;}});
    }
    return original.call(this,query,...args);
  };
  try {writeProgress(store,detail,1);}finally{DatabaseSync.prototype.prepare=original;}
  assert.equal(blocked,true); assert.equal(store.bookMeta(detail.book.id).book.progress.catalogRevision,detail.catalogRevision);
});

test("a failed replacement rolls back chapter IDs, revision, progress and all other rows", ({factory=createNovelStore}={}) => {
  const {store,dbPath}=fresh(factory), old=store.importCollectedBook(collected(base)); writeProgress(store,old,2);
  sql(dbPath,db=>db.exec("CREATE TRIGGER fail_chapter BEFORE INSERT ON novel_chapters BEGIN SELECT RAISE(ABORT,'injected replacement failure'); END"));
  const before=snapshot(dbPath);
  assert.throws(()=>store.importCollectedBook(collected([base[1],base[0]])),/injected replacement failure/);
  assert.deepEqual(snapshot(dbPath),before); sql(dbPath,db=>db.exec("DROP TRIGGER fail_chapter"));
  assert.equal(store.importCollectedBook(collected([base[1],base[0]])).book.progress.chapterIndex,1);
});

test("upload and text reimport use the same stable coordinator", () => {
  const {store}=fresh(), text="第一章 A\n\nexact A\n\n第二章 B\n\nexact B";
  const old=store.uploadBook({fileName:"synthetic.txt",text}); writeProgress(store,old,2);
  const next=store.reimportBook(old.book.id,{text:"序言\n\nnew prelude\n\n"+text});
  assert.equal(next.book.progress.chapterId,old.chapters[1].id); assert.equal(next.book.progress.chapterIndex,3); assert.equal(next.book.progress.scrollRatio,0.6);
});

test("real Python full scan and single reimport preserve exact chapter IDs and Node-established progress", () => {
  const {store,dbPath}=fresh(), source=owned(`source-${++number}`); fs.mkdirSync(source); const file=path.join(source,"synthetic.txt");
  const text="第一章 A\n\nexact A\n\n第二章 B\n\nexact B"; fs.writeFileSync(file,text);
  scan(dbPath,source); const list=store.listBooks(new URL("http://synthetic.invalid")); const old=store.bookDetail(list.books[0].id); writeProgress(store,old,2);
  fs.writeFileSync(file,"序言\n\nnew prelude\n\n"+text); scan(dbPath,source);
  const full=store.bookDetail(old.book.id); assert.equal(full.book.progress.chapterId,old.chapters[1].id); assert.equal(full.book.progress.chapterIndex,3);
  assert.equal(full.book.progress.scrollRatio,0.6); assert.notEqual(full.catalogRevision,old.catalogRevision);
  scan(dbPath,source,file); const single=store.bookDetail(old.book.id); assert.deepEqual(single.chapters.map(c=>c.id),full.chapters.map(c=>c.id));
  assert.notEqual(single.catalogRevision,full.catalogRevision); assert.equal(single.book.progress.scrollRatio,0.6);
});

test("Python replacement failure rolls back both full-scan and single-book paths", () => {
  for(const mode of ["full","single"]) {
    const {store,dbPath}=fresh(), source=owned(`source-${++number}`);fs.mkdirSync(source);const file=path.join(source,"synthetic.txt");
    fs.writeFileSync(file,"第一章 A\n\nexact A\n\n第二章 B\n\nexact B");scan(dbPath,source);
    const old=store.bookDetail(store.listBooks(new URL("http://synthetic.invalid")).books[0].id);writeProgress(store,old,2);
    sql(dbPath,db=>db.exec("CREATE TRIGGER fail_chapter BEFORE INSERT ON novel_chapters BEGIN SELECT RAISE(ABORT,'injected replacement failure'); END"));
    const before=snapshot(dbPath);fs.writeFileSync(file,"序言\n\nnew prelude\n\n第一章 A\n\nexact A\n\n第二章 B\n\nexact B");
    const output=python("import sys,sqlite3; from pathlib import Path; sys.path.insert(0,'tools'); from rescan_novel_library import build_book,write_record,write_records; db,source,file,mode=sys.argv[1:]; b=build_book(Path(source),Path(file))\ntry:\n (write_record(Path(db),b) if mode=='single' else write_records(Path(db),[Path(source)],[b]))\nexcept sqlite3.IntegrityError as e:\n assert 'injected replacement failure' in str(e); print('expected-rollback')",[dbPath,source,file,mode]);
    assert(output.includes("expected-rollback"));assert.deepEqual(snapshot(dbPath),before);
    sql(dbPath,db=>db.exec("DROP TRIGGER fail_chapter"));scan(dbPath,source,mode==="single"?file:null);
    assert.equal(store.bookMeta(old.book.id).book.progress.chapterIndex,3);
  }
});

function downgradeToV4(dbPath) {
  sql(dbPath,db=>{
    for(const name of ["catalog_revision","legacy_write_allowed"]) db.exec(`ALTER TABLE novel_books DROP COLUMN ${name}`);
    for(const name of ["catalog_revision","status","reason","anchor_json","candidate_json"]) db.exec(`ALTER TABLE novel_reading_state DROP COLUMN ${name}`);
    db.prepare("UPDATE novel_meta SET value='4' WHERE key='schema_version'").run();
  });
}
test("v4 migration preserves raw columns/IDs/bodies and labels prior progress unverified, identically in Node and Python", () => {
  for (const language of ["Node","Python"]) {
    const {store,dbPath}=fresh(), detail=store.importCollectedBook(collected(base)); writeProgress(store,detail,2);
    downgradeToV4(dbPath);
    sql(dbPath,db=>{
      for(const target of detail.chapters){const id=legacyChapterId(detail.book.id,target.index);db.prepare("UPDATE novel_chapters SET id=? WHERE id=?").run(id,target.id);target.id=id;}
      db.prepare("UPDATE novel_books SET first_chapter_id=?,latest_chapter_id=? WHERE id=?").run(detail.chapters[0].id,detail.chapters.at(-1).id,detail.book.id);
      db.prepare("UPDATE novel_reading_state SET chapter_id=? WHERE book_id=?").run(detail.chapters[1].id,detail.book.id);
    });
    const before=snapshot(dbPath);
    if(language==="Python") python("import sqlite3,sys; sys.path.insert(0,'tools'); from rescan_novel_library import ensure_schema; c=sqlite3.connect(sys.argv[1]); ensure_schema(c); c.close()",[dbPath]);
    const migrated=createNovelStore({dbPath}).bookDetail(detail.book.id), after=snapshot(dbPath);
    for(const table of before) {
      const current=after.find(t=>t.name===table.name); assert(current);
      if(table.name==="novel_meta") { assert.equal(current.rows.find(r=>r.key==="schema_version").value,"5"); continue; }
      assert.deepEqual(current.rows.map(row=>Object.fromEntries(Object.keys(table.rows[0]||{}).map(key=>[key,row[key]]))),table.rows.map(row=>({...row})));
    }
    assert.equal(migrated.book.progress,null); assert.equal(migrated.book.progressRecovery.reason,"legacy_unverified");
    assert.equal(migrated.book.progressRecovery.previous.catalogRevision,null); assert.deepEqual(migrated.chapters,detail.chapters);
    assert.equal(createNovelStore({dbPath}).bookDetail(detail.book.id).catalogRevision,migrated.catalogRevision);
    const prior=snapshot(dbPath);
    assert.throws(()=>createNovelStore({dbPath}).saveProgress(detail.book.id,{chapterIndex:1,scrollRatio:0}),e=>e.statusCode===409);
    assert.deepEqual(snapshot(dbPath),prior,"index-only automatic save must not clear unverified legacy anchor");
  }
});

test("explicit modern progress rejects invalid ratios without overwriting the saved anchor", () => {
  const {store,dbPath}=fresh(),detail=store.importCollectedBook(collected(base));writeProgress(store,detail,1);
  const before=snapshot(dbPath);
  for(const ratio of [NaN,Infinity,-0.1,1.1,"0.5",false]) assert.throws(()=>writeProgress(store,detail,1,ratio),e=>e.statusCode===400);
  assert.deepEqual(snapshot(dbPath),before);
});

test("Node and Python migration failures roll back DDL/version/identity and allow retry", () => {
  for(const language of ["Node","Python"]) {
    const {store,dbPath}=fresh(), detail=store.importCollectedBook(collected(base)); downgradeToV4(dbPath);
    sql(dbPath,db=>{db.prepare("DELETE FROM novel_meta WHERE key='library_id'").run();db.prepare("UPDATE novel_chapters SET book_id='missing-parent' WHERE id=?").run(detail.chapters[0].id);});
    const before=snapshot(dbPath);
    if(language==="Node") assert.throws(()=>createNovelStore({dbPath}).summary(),/升级已回滚/);
    else assert.equal(python("import sqlite3,sys; sys.path.insert(0,'tools'); from rescan_novel_library import ensure_schema; c=sqlite3.connect(sys.argv[1])\ntry: ensure_schema(c)\nexcept ValueError: print('rejected')\nfinally: c.close()",[dbPath]).trim(),"rejected");
    assert.deepEqual(snapshot(dbPath),before);
    sql(dbPath,db=>db.prepare("UPDATE novel_chapters SET book_id=? WHERE id=?").run(detail.book.id,detail.chapters[0].id));
    assert(createNovelStore({dbPath}).summary().sourceRealm.startsWith("server:"));
  }
});

test("Node and Python revalidate metadata after a real interleaved upgrade wins the writer lock", ({factory=createNovelStore}={}) => {
  for(const language of ["Node","Python"]) {
    const {store,dbPath}=fresh();store.importCollectedBook(collected(base));
    downgradeToV4(dbPath); // Initialization now needs a writer lock only for migration.
    sql(dbPath, db => db.prepare("DELETE FROM novel_meta WHERE key='library_id'").run());
    const expected=snapshot(dbPath);expected.find(t=>t.name==="novel_meta").rows.find(r=>r.key==="schema_version").value="6";
    if(language==="Node") {
      const original=DatabaseSync.prototype.exec;let armed=true;
      DatabaseSync.prototype.exec=function(statement,...args){
        if(armed&&statement==="BEGIN IMMEDIATE"){armed=false;sql(dbPath,db=>db.prepare("UPDATE novel_meta SET value='6' WHERE key='schema_version'").run());}
        return original.call(this,statement,...args);
      };
      try{assert.throws(()=>factory({dbPath}).summary(),/更新版本/);assert.equal(armed,false);}finally{DatabaseSync.prototype.exec=original;}
    } else {
      const output=python("import sqlite3,sys; sys.path.insert(0,'tools'); from rescan_novel_library import ensure_schema\nclass Interleaved(sqlite3.Connection):\n armed=True\n def execute(self,statement,*args):\n  if self.armed and statement=='BEGIN IMMEDIATE':\n   self.armed=False; w=sqlite3.connect(sys.argv[1]); w.execute(\"UPDATE novel_meta SET value='6' WHERE key='schema_version'\"); w.commit(); w.close()\n  return super().execute(statement,*args)\nc=sqlite3.connect(sys.argv[1],factory=Interleaved)\ntry: ensure_schema(c)\nexcept ValueError as e:\n assert '更新版本' in str(e); print('expected-future-rejection')\nfinally: c.close()",[dbPath]);
      assert(output.includes("expected-future-rejection"));
    }
    assert.deepEqual(snapshot(dbPath),expected);
  }
});

test("reimport refuses a deletion or newer catalog committed after its initial read but before its writer lock", ({factory=createNovelStore}={}) => {
  for(const action of ["delete","replace"]) {
    const {store,dbPath}=fresh(factory), old=store.uploadBook({fileName:"synthetic.txt",text:"第一章 A\n\noriginal body"});
    const writer=createNovelStore({dbPath}), original=DatabaseSync.prototype.exec;let locks=0, committed=null;
    DatabaseSync.prototype.exec=function(statement,...args){
      if(statement==="BEGIN IMMEDIATE" && ++locks===1) {
        if(action==="delete")writer.deleteBook(old.book.id);
        else writer.reimportBook(old.book.id,{text:"第一章 A\n\nnewer winning body"});
        committed=snapshot(dbPath);
      }
      return original.call(this,statement,...args);
    };
    try{assert.throws(()=>store.reimportBook(old.book.id,{text:"第一章 A\n\nlate stale body"}),e=>e.statusCode===409);}finally{DatabaseSync.prototype.exec=original;}
    assert(committed);assert.deepEqual(snapshot(dbPath),committed);
  }
});

try {
  for(const item of tests) { await item.run(); checks++; console.log(`PASS ${item.name}`); }
  // Execute the frozen original clamp on actual synthetic SQLite, preserving
  // the historical failure evidence instead of keeping the bug in production.
  for(const [name,expectedIndex,count] of [["insertion does not follow old body",2,2],["deletion should not clamp",null,1]]) {
    const db=new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE novel_reading_state(book_id TEXT,chapter_id TEXT,chapter_index INTEGER,scroll_ratio REAL,updated_at TEXT)");
      db.prepare("INSERT INTO novel_reading_state VALUES(?,?,?,?,?)").run("book",legacyChapterId("book",1),1,0.6,"synthetic");
      legacyClamp(db,"book",count);const row=db.prepare("SELECT * FROM novel_reading_state").get();let error;
      try{assert.equal(row?.chapter_index ?? null,expectedIndex);}catch(e){error=e;}
      assert.equal(error?.code,"ERR_ASSERTION");negative++;console.log(`CONTROL historical ${name}`);
    } finally {db.close();}
  }
  const mutants=[
    ["reuse IDs on duplicate old body", "previous?.length === 1", "previous?.length >= 1", "duplicate old"],
    ["reuse IDs on duplicate new body", "after.get(key)?.length === 1", "after.get(key)?.length >= 1", "duplicate incoming"],
    ["ignore progress revision", "progress.catalogRevision !== oldRevision", "false", "revision mismatch"],
    ["revive unresolved anchor", 'if (progress.status !== "resolved")', 'if (false)', "prior unresolved"],
  ];
  for(const [name,from,to,prefix] of mutants) {
    assert.equal(coordinatorSource.split(from).length,2); const source=coordinatorSource.replace(from,to);
    const {reconcileChapters:reconcile}=await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));
    const vector=vectors.find(v=>v.name.startsWith(prefix)); let error;
    try{assertVector(vector,vectorResult(vector,reconcile));}catch(e){error=e;}
    // The unresolved mutant needs the old fields populated to isolate its status gate.
    if(name==="revive unresolved anchor") {
      const copy=structuredClone(vector); Object.assign(copy.progress,{chapterId:"a",chapterIndex:1,scrollRatio:0.6,catalogRevision:"r1"});
      try{assertVector(copy,vectorResult(copy,reconcile));}catch(e){error=e;}
    }
    assert.equal(error?.code,"ERR_ASSERTION",name); negative++; console.log(`CONTROL rejected ${name}`);
  }
  for(const [name,from,to,prefix] of [
    ["omit coherent read transaction", "return withDb(database => inReadSnapshot(database, callback));", "return withDb(callback);", "a real SQLite writer"],
    ["allow stale revision writes", "body.catalogRevision !== book.catalog_revision", "false", "legacy index clients"],
    ["legacy index writes remain allowed after replacement", "replacement.existed ? 0 : 1", "1", "legacy index clients"],
    ["skip locked metadata revalidation", "validateExistingLibraryMetadata(db); // The writer lock may have waited behind an upgrade.", "", "Node and Python revalidate"],
    ["skip locked reimport revision check", 'if (!lockedBook || lockedBook.catalog_revision !== current.catalog_revision)', 'if (false)', "reimport refuses"]
  ]) {
    assert.equal(storeSource.split(from).length,2);
    const altered=storeSource.replace(from,to).replace('"./chapter-identity.js"',JSON.stringify(pathToFileURL(coordinatorPath).href));
    const {createNovelStore:factory}=await import("data:text/javascript;base64,"+Buffer.from(altered).toString("base64"));
    let error; try{await tests.find(t=>t.name.startsWith(prefix)).run({factory});}catch(e){error=e;}
    assert.equal(error?.code,"ERR_ASSERTION",name);negative++;console.log(`CONTROL rejected ${name}`);
  }
  console.log(`Novel chapter identity: ${tests.length} scenarios passed, including ${vectors.length} shared Node/Python vectors; ${negative} behavioral controls rejected.`);
  console.log("Boundary: real SQLite, actual store/routes/coordinators/Python scan, only generated temporary data; no production DB or HTTP server.");
} finally {
  const resolved=fs.realpathSync(temporary), parent=fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(),parent.toLowerCase()); assert(path.basename(resolved).startsWith("fanhao-chapter-identity-"));
  if(process.platform==="win32") {
    const cleanup=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command","$target=(Resolve-Path -LiteralPath $env:FANHAO_CHAPTER_TEST_DIRECTORY).Path; $parent=(Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path.TrimEnd('\\'); if ([System.IO.Path]::GetDirectoryName($target) -ne $parent -or -not ([System.IO.Path]::GetFileName($target).StartsWith('fanhao-chapter-identity-'))) { throw 'Unsafe cleanup target' }; Remove-Item -LiteralPath $target -Recurse -Force"],{windowsHide:true,encoding:"utf8",env:{...process.env,FANHAO_CHAPTER_TEST_DIRECTORY:resolved}});
    assert.ifError(cleanup.error); assert.equal(cleanup.status,0,cleanup.stderr);
  } else fs.rmSync(resolved,{recursive:true,force:true});
}
