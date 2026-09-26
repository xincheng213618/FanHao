import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";
import { auditPersonIdentities } from "./audit_person_identities.mjs";
import { createPersonMergeService } from "../src/modules/fanhao/server/people/person-merge-service.js";
import { createActorProfileService } from "../src/modules/fanhao/server/people/actor-profile-service.js";
import { createWorkImageService } from "../src/modules/fanhao/server/works/image-service.js";
import { canonicalPersonId, ensurePersonIdentitySchema, findPersonByIdentity, mergePersonIdentities, previewPersonMerge, personLocations, bindPersonLocation } from "../src/modules/fanhao/server/people/person-identity.js";

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
  console.log("Person identity verification passed: durable merge, rollback, reservations, conflicts, archive, scan stability, no virtual name merge.");
} finally { db.close(); temp.cleanup(); }
