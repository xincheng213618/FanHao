import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";
import { auditPersonIdentities } from "../tools/audit_person_identities.mjs";
import { createPersonMergeService } from "../src/modules/fanhao/server/people/person-merge-service.js";
import { createActorProfileService } from "../src/modules/fanhao/server/people/actor-profile-service.js";
import { createWorkImageService } from "../src/modules/fanhao/server/works/image-service.js";
import { canonicalPersonId, ensurePersonIdentitySchema, findPersonByIdentity, mergePersonIdentities, previewPersonMerge, personLocations, bindPersonLocation } from "../src/modules/fanhao/server/people/person-identity.js";

const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const legacySearchSort = process.argv.includes("--legacy-search-sort");

function serverFunction(name) {
  const start = serverSource.indexOf(`\nfunction ${name}(`);
  assert(start >= 0, `actual server function must exist: ${name}`);
  const end = serverSource.indexOf("\nfunction ", start + 2);
  return serverSource.slice(start, end < 0 ? undefined : end);
}

function createSearchDb(rows, redirects = []) {
  const nextDb = new DatabaseSync(":memory:");
  try {
    nextDb.exec(`
      ATTACH DATABASE ':memory:' AS fanhao_images;
      CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT,name_search TEXT,display_name TEXT,folder_path TEXT,
        movie_count INTEGER,status TEXT,error TEXT,source TEXT,gender TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE works(id INTEGER PRIMARY KEY);
      CREATE TABLE work_people(work_id INTEGER,person_id INTEGER,role TEXT,sort_order INTEGER,source TEXT,
        created_at TEXT,updated_at TEXT,PRIMARY KEY(work_id,person_id,role));
      CREATE TABLE person_redirects(source_id INTEGER PRIMARY KEY,target_id INTEGER,operation_id TEXT,created_at TEXT);
      CREATE TABLE person_aliases(id INTEGER PRIMARY KEY,person_id INTEGER,alias TEXT,alias_search TEXT,source TEXT,
        UNIQUE(person_id,alias_search));
      CREATE INDEX aliases_person ON person_aliases(person_id);
      CREATE TABLE person_external_refs(id INTEGER PRIMARY KEY,person_id INTEGER,provider TEXT,external_key TEXT,url TEXT,
        source TEXT,created_at TEXT,updated_at TEXT,UNIQUE(provider,external_key));
      CREATE INDEX refs_person ON person_external_refs(person_id,provider);
      CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY,owner_type TEXT,owner_id INTEGER,kind TEXT,
        remote_url TEXT,local_path TEXT,mime TEXT,image_blob BLOB,source TEXT,updated_at TEXT,legacy_key TEXT);
      CREATE INDEX fanhao_images.images_owner ON images(owner_type,owner_id,kind);
      BEGIN;
    `);
    const insertPerson = nextDb.prepare("INSERT INTO people VALUES(?,?,?,?,NULL,1,'ok','','fixture',?,'v1','v1')");
    const insertAlias = nextDb.prepare("INSERT INTO person_aliases(person_id,alias,alias_search,source) VALUES(?,?,?,'fixture')");
    const insertWork = nextDb.prepare("INSERT INTO works VALUES(?)");
    for (const row of rows) {
      insertPerson.run(row.id, row.name, row.name.toLowerCase(), row.displayName ?? "", row.gender ?? "female");
      insertWork.run(row.id);
      for (const alias of row.aliases || []) insertAlias.run(row.id, alias, alias.toLowerCase());
    }
    const insertRedirect = nextDb.prepare("INSERT INTO person_redirects VALUES(?,?,'confirmed-fixture-merge','v1')");
    for (const [sourceId, targetId] of redirects) insertRedirect.run(sourceId, targetId);
    nextDb.exec("COMMIT");
    return nextDb;
  } catch (error) {
    nextDb.close();
    throw error;
  }
}

function createSearchFixture(rows, redirects = []) {
  const databases = [createSearchDb(rows, redirects)];
  let currentDb = databases[0];
  let stamp = 1;
  let sorting = false;
  let sortReadError = null;
  let displayReads = new Map();
  let sortIdentityGets = 0;
  const people = rows.map((row) => ({
    id: String(row.id), name: row.name, relativePath: `synthetic/${row.id}`,
    sourcePaths: [`synthetic/${row.id}`], works: [`work-${row.id}`],
    workCount: row.workCount ?? 1, modifiedAt: "v1"
  }));
  const library = {
    people, peopleById: new Map(people.map((person) => [person.id, person])), scannedAt: "v1",
    worksById: new Map(people.map((person) => [person.works[0], { id: person.works[0], videoCount: 1 }]))
  };
  const measuredDb = {
    prepare(sql) {
      const statement = currentDb.prepare(sql);
      return {
        get(...args) {
          if (sorting) {
            if (sortReadError) throw sortReadError;
            if (sql === "SELECT target_id FROM person_redirects WHERE source_id = ?"
              || sql === "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?") sortIdentityGets += 1;
          }
          return statement.get(...args);
        },
        all: (...args) => statement.all(...args)
      };
    }
  };
  const context = vm.createContext({ library });
  for (const name of ["normalizeSearchValue", "normalizePersonSearchValue", "cleanPersonNamePart", "uniquePersonNames",
    "parseActorAliasesJson", "actorProfileAliases", "preferredPersonDisplayName", "normalizeSourcePath", "isBracketedSearch"]) {
    vm.runInContext(serverFunction(name), context);
  }
  const profile = createActorProfileService({
    getCoreDb: () => measuredDb, getStamp: () => String(stamp)
  });
  const merge = createPersonMergeService({
    actorProfileAliases: context.actorProfileAliases, actorProfileRow: (id) => profile.row(id),
    getLibrary: () => library, getStamp: () => String(stamp),
    resolveCanonicalId: (id) => canonicalPersonId(measuredDb, id),
    normalizePersonSearchValue: context.normalizePersonSearchValue,
    normalizeSourcePath: context.normalizeSourcePath,
    preferredPersonDisplayName: context.preferredPersonDisplayName, uniquePersonNames: context.uniquePersonNames
  });
  Object.assign(context, {
    actorProfileSearchNames: (person) => merge.searchNames(person),
    mergedPersonRecord: (person) => merge.record(person), mergedPersonMembers: (id) => merge.members(id),
    actorProfileDisplayName(person) {
      displayReads.set(person, (displayReads.get(person) || 0) + 1);
      sorting = true;
      try { return merge.displayName(person); } finally { sorting = false; }
    }
  });
  const source = serverFunction("searchPeople");
  const currentComparator = "displayNameForSort(a).localeCompare(displayNameForSort(b)";
  const oldComparator = "actorProfileDisplayName(a).localeCompare(actorProfileDisplayName(b)";
  assert(source.includes(currentComparator), "search sort negative control must target the current comparator");
  const oldSource = source.replace(currentComparator, oldComparator);
  vm.runInContext(legacySearchSort ? oldSource : source, context);
  vm.runInContext(oldSource.replace("function searchPeople(", "function oldSearchPeople("), context);
  profile.rowsById();
  merge.maps();
  return {
    run(query, old = false) {
      displayReads = new Map();
      sortIdentityGets = 0;
      const payload = context[old ? "oldSearchPeople" : "searchPeople"](query);
      return {
        payload: JSON.parse(JSON.stringify(payload)), json: JSON.stringify(payload),
        displayReadCount: [...displayReads.values()].reduce((sum, count) => sum + count, 0),
        maxPersonReads: Math.max(0, ...displayReads.values()), sortIdentityGets
      };
    },
    rename(personId, displayName) {
      currentDb.prepare("UPDATE people SET display_name=? WHERE id=?").run(displayName, personId);
      stamp += 1;
    },
    merge(targetId, sourceIds) {
      mergePersonIdentities(currentDb, targetId, sourceIds);
      stamp += 1;
    },
    replaceDb(nextRows) {
      currentDb = createSearchDb(nextRows);
      databases.push(currentDb);
      stamp += 1;
    },
    makeCycle() {
      currentDb.exec("INSERT INTO person_redirects VALUES(1,2,'fixture','v1'),(2,1,'fixture','v1')");
    },
    failSortRead(error) { sortReadError = error; },
    close() { for (const connection of databases) connection.close(); }
  };
}

function verifySearchDisplayNameReuse() {
  const rows = Array.from({ length: 4000 }, (_, index) => ({
    id: index + 1, name: `Match Person ${index + 1}`, displayName: `Display ${((index + 1) * 7919) % 4000}`,
    aliases: (index + 1) % 5 === 0 ? ["Exact Alias"] : []
  }));
  const redirects = rows.filter((row) => row.id % 10 === 0).map((row) => [row.id, row.id - 1]);
  let fixture = createSearchFixture(rows, redirects);
  try {
    for (const [query, expectedPeople] of [["Match", 3600], ["Exact Alias", 400]]) {
      const before = fixture.run(query, true);
      const after = fixture.run(query);
      assert.equal(after.json, before.json, `${query}: complete actual search response must retain the old order and fields`);
      assert.equal(after.displayReadCount, expectedPeople, `${query}: tie sorting must read each participating person once`);
      assert.equal(after.maxPersonReads, 1, `${query}: exact/fuzzy must share a request-local object cache`);
      assert.equal(after.sortIdentityGets, expectedPeople * 2, `${query}: each displayed name keeps its real schema/redirect checks`);
      assert(before.displayReadCount > expectedPeople * 5, `${query}: old comparator must reproduce repeated actual profile reads`);
      console.log(`person-search-sort: query=${query}, old-display-reads=${before.displayReadCount}, current=${after.displayReadCount}, old-identity-gets=${before.sortIdentityGets}, current=${after.sortIdentityGets}`);
    }
  } finally { fixture.close(); }

  fixture = createSearchFixture(Array.from({ length: 120 }, (_, index) => ({
    id: index + 1, name: `Match ${index + 1}`, displayName: `Display ${120 - index}`, workCount: index + 1
  })));
  try {
    const before = fixture.run("Match", true), after = fixture.run("Match");
    assert.equal(after.json, before.json, "different work counts must retain descending priority");
    assert.equal(before.displayReadCount, 0);
    assert.equal(after.displayReadCount, 0, "display names must remain lazy when counts decide every comparison");
  } finally { fixture.close(); }

  for (const emptyName of [true, false]) {
    const pairedRows = [], pairedRedirects = [];
    for (let id = 1; id <= 5; id += 1) {
      pairedRows.push({ id, name: emptyName ? "" : "Match", gender: "unknown" },
        { id: id + 5, name: `Match source ${id}`, gender: "unknown" });
      pairedRedirects.push([id + 5, id]);
    }
    fixture = createSearchFixture(pairedRows, pairedRedirects);
    try {
      const before = fixture.run("Match", true), after = fixture.run("Match");
      assert.equal(after.json, before.json, "equal or empty names must retain stable complete search output");
      assert.equal(after.displayReadCount, 5, "empty strings and exact/fuzzy overlap must be cached by object reference");
      assert.equal(after.maxPersonReads, 1);
      assert.deepEqual(after.payload.fuzzy.map((person) => person.id), ["1", "2", "3", "4", "5"]);
      if (!emptyName) assert.deepEqual(after.payload.exact.map((person) => person.id), ["1", "2", "3", "4", "5"]);
    } finally { fixture.close(); }
  }

  const nextRows = [
    { id: 1, name: "Match One", displayName: "A" }, { id: 2, name: "Match Two", displayName: "B" },
    { id: 3, name: "Match Three", displayName: "C" }
  ];
  fixture = createSearchFixture(nextRows);
  try {
    assert.deepEqual(fixture.run("Match").payload.fuzzy.map((person) => person.id), ["1", "2", "3"]);
    fixture.rename(1, "Z");
    let before = fixture.run("Match", true), after = fixture.run("Match");
    assert.equal(after.json, before.json, "the next query must observe the changed profile display name");
    assert.deepEqual(after.payload.fuzzy.map((person) => person.id), ["2", "3", "1"]);
    fixture.merge(2, [1]);
    before = fixture.run("Match", true); after = fixture.run("Match");
    assert.equal(after.json, before.json, "the next query must observe a new durable confirmed merge");
    assert.deepEqual(after.payload.fuzzy.map((person) => person.id), ["2", "3"]);
    fixture.replaceDb(nextRows);
    before = fixture.run("Match", true); after = fixture.run("Match");
    assert.equal(after.json, before.json, "connection replacement must not retain query-local names or identities");
    assert.deepEqual(after.payload.fuzzy.map((person) => person.id), ["1", "2", "3"]);
    const readError = Object.assign(new Error("private fixture sort read failure"), { code: "FIXTURE_SQL_READ" });
    fixture.failSortRead(readError);
    for (const old of [true, false]) assert.throws(() => fixture.run("Match", old), (error) => error === readError);
    fixture.failSortRead(null);
    fixture.makeCycle();
    for (const old of [true, false]) assert.throws(() => fixture.run("Match", old), {
      code: "PERSON_REDIRECT_CYCLE", message: "人物合并关系存在循环"
    });
  } finally { fixture.close(); }
  console.log("Person search sorting verification passed: full old-response oracle, bounded lazy reads, empty names, shared exact/fuzzy, fresh profiles/merges/connections, cycle and SQL errors.");
}

const temp = createVerifiedTempDir("fanhao-person-identity-");
const dbPath = path.join(temp.tempDir,"identity.sqlite");
let db = new DatabaseSync(dbPath);
try {
  db.exec(`PRAGMA foreign_keys=ON;
    ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY,owner_type TEXT,owner_id INTEGER,kind TEXT,remote_url TEXT,local_path TEXT,
      mime TEXT,source TEXT,updated_at TEXT,legacy_key TEXT,image_blob BLOB);
    INSERT INTO fanhao_images.images VALUES(1,'person',6,'avatar','','','image/jpeg','manual','old','',X'010203');
    CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT,name_search TEXT,display_name TEXT,folder_path TEXT,
      movie_count INTEGER,status TEXT,error TEXT,source TEXT,gender TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE works(id INTEGER PRIMARY KEY);
    CREATE TABLE work_people(work_id INTEGER REFERENCES works(id),person_id INTEGER REFERENCES people(id),role TEXT,sort_order INTEGER,
      source TEXT,created_at TEXT,updated_at TEXT, PRIMARY KEY(work_id,person_id,role));
    CREATE TABLE person_aliases(id INTEGER PRIMARY KEY,person_id INTEGER REFERENCES people(id),alias TEXT,alias_search TEXT,source TEXT,UNIQUE(person_id,alias_search));
    CREATE TABLE person_external_refs(id INTEGER PRIMARY KEY,person_id INTEGER REFERENCES people(id),provider TEXT,external_key TEXT,url TEXT,source TEXT,created_at TEXT,updated_at TEXT,UNIQUE(provider,external_key));
    CREATE TABLE actor_profile_publications(person_id INTEGER PRIMARY KEY,operation_id TEXT);
    CREATE TABLE cross_store_aggregate_reservations(aggregate_key TEXT PRIMARY KEY,op_id TEXT);
    CREATE TABLE work_move_path_reservations(job_id TEXT,released_at TEXT);
    INSERT INTO works VALUES(309),(310),(311);
  `);
  const insert = db.prepare("INSERT INTO people VALUES(?,?,?,?,?,0,'ok',NULL,'fixture','unknown','old','old')");
  insert.run(6,"長谷川栞","長谷川栞","長谷川栞",null);
  insert.run(1735,"長谷川栞","長谷川栞","長谷川栞",null);
  insert.run(1971,"[長谷川栞] Shiori Hasegawa","[長谷川栞]shiorihasegawa","[長谷川栞] Shiori Hasegawa","G:/長谷川栞");
  insert.run(8,"Other","other","Other","G:/Other");
  db.exec(`INSERT INTO person_external_refs VALUES(1,1971,'javdb-actor','pO29','https://javdb.com/actors/pO29','fixture','old','old');
    INSERT INTO person_external_refs VALUES(2,8,'javdb-actor','OtherKey','https://javdb.com/actors/OtherKey','fixture','old','old');
    INSERT INTO person_aliases VALUES(1,1971,'長谷川栞','長谷川栞','fixture');
    INSERT INTO actor_profile_publications VALUES(6,'immutable-original-avatar');
    INSERT INTO work_people VALUES(309,6,'actor',0,'info','old','old'),(309,1735,'actor',0,'info','old','old'),
    (309,1971,'actor',1001,'actor_movies','old','old'),(310,6,'actor',1,'info','old','old'),
    (310,1971,'actor',1002,'actor_movies','old','old'),(311,1735,'actor',2,'info','old','old');`);
  ensurePersonIdentitySchema(db);
  assert.equal(auditPersonIdentities(db).summary.candidatePairs,3);
  assert.throws(()=>findPersonByIdentity(db,{name:"長谷川栞"}),{code:"PERSON_NAME_AMBIGUOUS"});
  assert.equal(findPersonByIdentity(db,{folderPath:"g:\\長谷川栞",name:"長谷川栞"}).id,1971);
  assert.equal(previewPersonMerge(db,1971,[6,1735]).workCount,3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM person_redirects").get().n,0,"preview must not write");
  assert.throws(()=>mergePersonIdentities(db,1971,[8]),{code:"PERSON_EXTERNAL_ID_CONFLICT"});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM person_identity_merges").get().n,0);
  db.exec("INSERT INTO cross_store_aggregate_reservations VALUES('person-avatar:6','pending')");
  assert.throws(()=>mergePersonIdentities(db,1971,[6]),{code:"ACTOR_PROFILE_RESERVED"});
  db.exec("DELETE FROM cross_store_aggregate_reservations; INSERT INTO work_move_path_reservations VALUES('busy','')");
  assert.throws(()=>mergePersonIdentities(db,1971,[6]),{code:"PERSON_MOVE_ACTIVE"});
  db.exec("DELETE FROM work_move_path_reservations");
  // Inject a late failure to prove the relation migration and redirect roll back together.
  db.exec("CREATE TRIGGER fail_merge BEFORE UPDATE OF status ON people WHEN NEW.id=1735 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(()=>mergePersonIdentities(db,1971,[6,1735]),/fixture failure/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM person_redirects").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM work_people WHERE person_id=6").get().n,2);
  db.exec("DROP TRIGGER fail_merge");
  const merged = mergePersonIdentities(db,1971,[6,1735],{displayName:"長谷川栞"});
  assert.deepEqual(merged.mergedPersonIds,["6","1735"]);
  for (const id of [6,1735,1971]) assert.equal(canonicalPersonId(db,id),"1971");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM work_people WHERE person_id=1971").get().n,3);
  assert.equal(db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id=6").get().operation_id,"immutable-original-avatar");
  assert.equal(db.prepare("SELECT status FROM people WHERE id=6").get().status,"merged");
  assert.equal(findPersonByIdentity(db,{name:"長谷川栞"}).id,1971);
  assert.equal(findPersonByIdentity(db,{name:"[長谷川栞] Shiori Hasegawa"}).id,1971);
  const profile = createActorProfileService({getCoreDb:()=>db,getStamp:()=>"fixture"});
  assert.equal(profile.row("1971").avatar_owner_id,6,"archived avatar remains available without reparenting its immutable owner");
  assert.equal(profile.row("6").core_person_id,1971);
  const images = createWorkImageService({getCoreDb:()=>db,hasCoreDb:()=>true});
  assert.equal(images.corePersonAvatarMetadataRow(1971).owner_id,6);
  assert.throws(()=>db.exec("UPDATE person_external_refs SET person_id=8 WHERE external_key='pO29'"),/PERSON_EXTERNAL_IDENTITY_OWNED/);
  assert.throws(()=>db.exec("INSERT INTO work_people VALUES(311,6,'actor',0,'bad','now','now')"),/PERSON_ID_REDIRECTED/);
  assert.throws(()=>bindPersonLocation(db,8,"G:/長谷川栞"),{code:"PERSON_LOCATION_OWNED"});
  assert.equal(mergePersonIdentities(db,1971,[6,1735]).alreadyMerged,true);
  assert.equal(auditPersonIdentities(db).summary.candidatePairs,0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  db.close(); db = new DatabaseSync(dbPath);
  ensurePersonIdentitySchema(db);
  assert.equal(canonicalPersonId(db,6),"1971","redirect must survive reopening");
  assert.equal(personLocations(db,6).length,1);
  const scan = spawnSync("python",["-c",`import sys, sqlite3
sys.path.insert(0, 'tools')
from full_scan_core_library import load_people, upsert_person
from person_identity import canonical_person_id, assert_external_owner
conn=sqlite3.connect(sys.argv[1]); conn.row_factory=sqlite3.Row
before=conn.execute('SELECT COUNT(*) FROM people').fetchone()[0]
conn.execute('BEGIN IMMEDIATE'); stats={'people_created':0}; people=load_people(conn)
for i in range(3):
    assert upsert_person(conn,people,'長谷川栞','G:/長谷川栞',True,stats)==1971
assert canonical_person_id(conn,6)==1971
assert stats['people_created']==0
assert conn.execute('SELECT COUNT(*) FROM people').fetchone()[0]==before
conn.rollback(); conn.close()
`,dbPath],{encoding:"utf8"});
  assert.equal(scan.status,0,scan.stdout+scan.stderr);
  // Names alone must not form runtime merge groups.
  const a={id:"1",name:"Same"}, b={id:"2",name:"Same"};
  const runtime=createPersonMergeService({getLibrary:()=>({people:[a,b],peopleById:new Map([["1",a],["2",b]])}),getStamp:()=>"1"});
  assert.equal(runtime.canonicalId("2"),"2");
  assert.deepEqual(runtime.members("1"),[a]);
  // Redirect chains are flattened when the target is merged again.
  mergePersonIdentities(db,8,[1971],{confirmDifferentExternalIds:true});
  assert.equal(canonicalPersonId(db,6),"8");
  assert.equal(db.prepare("SELECT target_id FROM person_redirects WHERE source_id=6").get().target_id,8);
  verifySearchDisplayNameReuse();
  console.log("Person identity verification passed: durable merge, rollback, reservations, conflicts, archive, scan stability, no virtual name merge.");
} finally { db.close(); temp.cleanup(); }
