import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createActorAvatarService } from "../src/modules/fanhao/server/people/actor-avatar-service.js";
import { createActorProfileService } from "../src/modules/fanhao/server/people/actor-profile-service.js";
import { createAdminActorAvatarService } from "../src/modules/fanhao/server/admin/admin-actor-avatar-service.js";
import { routeAdminApi } from "../src/modules/system/server/admin/routes.js";

// All source files are real. Avatar files, stat results and descriptors are
// controlled in memory, and both attached SQLite databases are :memory:.
// No real avatar, database, temporary directory or production server is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src/modules/fanhao/server/people/actor-avatar-service.js");
const filter = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7) || "";
let factory = createActorAvatarService;
const wholeTree = process.argv.includes("--legacy-whole-tree");
const unbounded = process.argv.includes("--legacy-unbounded");
const noYield = process.argv.includes("--legacy-no-yield");
if (wholeTree || unbounded || noYield) {
  let source = fs.readFileSync(sourcePath, "utf8");
  if (wholeTree) {
    const marker = "const { entry, snapshot } = await selectedEntry(rootPath, cleanRelPath, options);";
    assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, "const { entries, snapshot } = await entriesFromFiletree(rootPath, options);\n    const entry = entries.find((item) => item.relPath === cleanRelPath);\n    if (!entry) throw candidateUnavailable();");
  }
  if (unbounded) {
    const marker = "async function avatarBuffer(entry, snapshot, signal) {";
    assert.equal(source.split(marker).length, 2);
    // The old unchecked whole-file read, retaining the current transaction,
    // profile, identity and publication guards. The negative must store too
    // many actual bytes rather than fail a source-text check.
    source = source.replace(marker, marker + "\n    return fileSystem.readFile(entry.fullPath);");
  }
  if (noYield) {
    const marker = "if (count % yieldEvery === 0) await new Promise((resolve) => setImmediate(resolve));";
    assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, "");
  }
  for (const name of ["actor-profile-mutation-guard.js", "person-identity.js"]) source = source.replace('from "./' + name + '"', "from " + JSON.stringify(pathToFileURL(path.join(path.dirname(sourcePath), name)).href));
  factory = (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).createActorAvatarService;
}

let checks = 0;
async function run(name, test) { if (filter && !name.includes(filter)) return; await test(); checks++; console.log("PASS " + name); }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function error(code) { return Object.assign(new Error("controlled " + code), { code }); }

class ControlledFiles {
  constructor() {
    this.root = path.resolve("X:/synthetic-avatar-fixture");
    this.content = path.join(this.root, "Content");
    this.tree = path.join(this.root, "Filetree.json");
    this.files = new Map(); this.directories = new Set([this.root, this.content]); this.nextInode = 1;
    this.calls = { stat: [], open: [], read: [], readFile: [], close: [] }; this.live = new Set(); this.onPhase = null;
  }
  put(file, value, overrides = {}) {
    const target = path.resolve(file), buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const node = { target, buffer, size: buffer.length, dev: 1, ino: this.nextInode++, mtimeMs: 1, ctimeMs: 1, ...overrides };
    this.files.set(target, node); return node;
  }
  avatar(name, value = Buffer.from([1, 2, 3, 4]), overrides = {}) { return this.put(path.join(this.content, "Actors", name), value, overrides); }
  filetree(mapping) { return this.put(this.tree, JSON.stringify({ Content: mapping })); }
  snapshot(node) { return { dev: node.dev, ino: node.ino, size: node.size, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs, isFile: () => true, isDirectory: () => false }; }
  async phase(name, value) { await this.onPhase?.(name, value); }
  async stat(file) {
    const target = path.resolve(file); this.calls.stat.push(target); await this.phase("path-stat", target);
    if (this.directories.has(target)) return { isFile: () => false, isDirectory: () => true };
    const node = this.files.get(target); if (!node) throw error("ENOENT"); return this.snapshot(node);
  }
  async readFile(file, options) {
    const target = path.resolve(file); this.calls.readFile.push(target); await this.phase("read-file", target);
    if (options?.signal?.aborted) throw error("ABORT_ERR");
    const node = this.files.get(target); if (!node) throw error("ENOENT");
    return options?.encoding === "utf8" || options === "utf8" ? node.buffer.toString("utf8") : Buffer.from(node.buffer);
  }
  async open(file, flags) {
    const target = path.resolve(file); assert.equal(flags, "r"); this.calls.open.push(target);
    await this.phase("open", target); const node = this.files.get(target); if (!node) throw error("ENOENT");
    const owner = this; const handle = {
      async stat() { await owner.phase("handle-stat", target); return owner.snapshot(node); },
      async read(buffer, offset, length, position) {
        owner.calls.read.push({ target, length, position }); await owner.phase("read", target);
        const bytesRead = Math.max(0, Math.min(length, node.buffer.length - position));
        node.buffer.copy(buffer, offset, position, position + bytesRead); return { bytesRead, buffer };
      },
      async close() { owner.calls.close.push(target); try { await owner.phase("close", target); } finally { owner.live.delete(handle); } }
    }; this.live.add(handle); return handle;
  }
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT,display_name TEXT,gender TEXT,movie_count INTEGER,source TEXT,status TEXT,error TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE person_external_refs(id INTEGER PRIMARY KEY,person_id INTEGER,provider TEXT,external_key TEXT,url TEXT);
    CREATE TABLE person_aliases(person_id INTEGER,alias TEXT);
    CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY,owner_type TEXT,owner_id INTEGER,kind TEXT,source_type TEXT,local_path TEXT,remote_url TEXT,mime TEXT,image_blob BLOB,byte_size INTEGER,sort_order INTEGER,status TEXT,source TEXT,legacy_table TEXT,legacy_key TEXT,created_at TEXT,updated_at TEXT,UNIQUE(owner_type,owner_id,kind,source_type,local_path,sort_order));
    CREATE TABLE actor_profile_publications(person_id INTEGER PRIMARY KEY,operation_id TEXT,intent_sha256 TEXT);
    CREATE TABLE actor_profile_image_revocations(person_id INTEGER,operation_id TEXT,intent_sha256 TEXT);
    CREATE TABLE cross_store_operation_state(op_id TEXT,status TEXT);
    CREATE TABLE cross_store_main_receipts(op_id TEXT,step TEXT,intent_sha256 TEXT);
    CREATE TABLE cross_store_aggregate_reservations(aggregate_key TEXT PRIMARY KEY,op_id TEXT);
    CREATE TABLE fanhao_images.actor_profile_image_staging(operation_id TEXT,person_id INTEGER,intent_sha256 TEXT,remote_url TEXT,local_path TEXT,mime TEXT,image_blob BLOB,source TEXT,updated_at TEXT,legacy_key TEXT);
    CREATE TABLE fanhao_images.cross_store_receipts(op_id TEXT);
  `); return db;
}

function fixture(names = ["Alice"], mapping) {
  const files = new ControlledFiles();
  const people = names.map((name, index) => ({ id: String(index + 1), name }));
  files.filetree(mapping || { Actors: Object.fromEntries(names.map((name) => [name, name + ".jpg"])) });
  for (const name of names) files.avatar(name + ".jpg");
  const dbs = [database()]; let currentDb = dbs[0], stamp = 0, invalidations = 0;
  const profile = createActorProfileService({
    getCoreDb: () => currentDb, getStamp: () => String(stamp), actorProfileAliases: () => [], actorProfileJavdbRefs: () => [], mergedPersonAliasNames: () => [],
    normalizePersonGender: (value) => value, preferredPersonDisplayName: (row, fallback) => row.display_name || fallback, uniquePersonNames: (values) => [...new Set(values)],
    coreImageUrl: (row) => row.has_image_blob || row.actor_profile_operation_id ? "/media/actor/" + row.owner_id + "/avatar" + (row.actor_profile_operation_id ? "?v=" + row.actor_profile_operation_id : "") : row.remote_url || row.local_path || ""
  });
  const insertPerson = (db, person) => db.prepare("INSERT INTO people VALUES(?,?,?,'unknown',0,'synthetic','ok',NULL,'old','old')").run(Number(person.id), person.name, person.name);
  for (const person of people) insertPerson(currentDb, person);
  const service = factory({
    avatarExts: new Set([".jpg", ".jpeg", ".png", ".webp"]), fileBase: (value) => path.basename(value, path.extname(value)), fileSystem: files,
    getCoreDb: () => currentDb, getPeople: () => people, getPersonById: (id) => people.find((person) => person.id === id) || null,
    getProfileRow: (id) => profile.row(id), getPublicProfile: (id) => profile.publicProfile(profile.row(id)), getSearchNames: (person) => [person.name, ...(person.aliases || [])],
    invalidateProfiles: () => { invalidations++; stamp++; profile.invalidate(); }, localAvatarSource: "local-avatar", maxBytes: 64,
    normalizeExt: (value) => path.extname(value).toLowerCase(), publicPerson: (person) => person
  });
  return { files, people, profile, service, get db() { return currentDb; }, get invalidations() { return invalidations; },
    rows: () => currentDb.prepare("SELECT * FROM fanhao_images.images ORDER BY id").all(),
    allDatabaseRows: () => dbs.map((db) => db.prepare("SELECT * FROM fanhao_images.images ORDER BY id").all()),
    switchDatabase() { currentDb = database(); dbs.push(currentDb); for (const person of people) insertPerson(currentDb, person); stamp++; profile.invalidate(); },
    changed() { stamp++; profile.invalidate(); }, close() { assert.equal(files.live.size, 0, "every descriptor must be closed"); for (const db of dbs) { assert.equal(db.isTransaction, false); db.close(); } }
  };
}

function existingImage(f, id, source, { remote = null, blob = true } = {}) {
  f.db.prepare("INSERT INTO fanhao_images.images(owner_type,owner_id,kind,source_type,local_path,remote_url,mime,image_blob,byte_size,status,source,updated_at) VALUES('person',?,'avatar','local',?,?, 'image/jpeg',?,1,'ok',?,'old')").run(id, "existing-" + id, remote, blob ? Buffer.from([9]) : null, source); f.changed();
}
function publication(f, id, { revoked = false } = {}) {
  const operation = "publication-" + id;
  f.db.prepare("INSERT INTO actor_profile_publications VALUES(?,?,?)").run(id, operation, "hash");
  f.db.prepare("INSERT INTO cross_store_operation_state VALUES(?,'completed')").run(operation);
  f.db.prepare("INSERT INTO cross_store_main_receipts VALUES(?,'visibility_switch','hash')").run(operation);
  f.db.prepare("INSERT INTO fanhao_images.actor_profile_image_staging VALUES(?,?,'hash','https://synthetic.invalid/avatar','', 'image/jpeg',?,'actor_profiles','old','')").run(operation, id, Buffer.from([8]));
  if (revoked) f.db.prepare("INSERT INTO actor_profile_image_revocations VALUES(?,?,'hash')").run(id, operation);
  f.changed(); return operation;
}

await run("selected entry avoids unrelated file stats and yields a long metadata walk", async () => {
  const count = 30000, mapping = Object.fromEntries(Array.from({ length: count }, (_, index) => [index === count - 1 ? "Alice" : "Unknown " + index, index + ".jpg"]));
  const f = fixture(["Alice"], { Actors: mapping }); f.files.avatar((count - 1) + ".jpg");
  try {
    let fired = false; const timer = setTimeout(() => { fired = true; }, 0); const start = performance.now();
    await f.service.importCandidate(f.files.root, "1", "Content/Actors/" + (count - 1) + ".jpg"); clearTimeout(timer);
    assert(f.files.calls.stat.length <= 12, "one apply must not stat 30000 unrelated candidate files");
    assert.equal(f.files.calls.open.length, 1); assert.equal(f.rows().length, 1); assert(fired, "long metadata matching must yield to timers before committing");
    console.log(JSON.stringify({ mode: "selected-avatar", entries: count, statCalls: f.files.calls.stat.length, avatarOpens: 1, elapsedMs: +(performance.now() - start).toFixed(2), timerRanBeforeCommit: fired }));
  } finally { f.close(); }
});

await run("full preview yields, retains summary counts and sees immediate source edits", async () => {
  const count = 1200, mapping = Object.fromEntries(Array.from({ length: count }, (_, index) => [index ? "Unknown " + index : "Alice", index + ".jpg"]));
  const f = fixture(["Alice"], { Actors: mapping }); f.files.avatar("0.jpg");
  try {
    let fired = false; const timer = setTimeout(() => { fired = true; }, 0);
    const first = await f.service.candidatesFromFiletree(f.files.root, { personId: "1", limit: 1 }); clearTimeout(timer);
    assert(fired, "large preview must yield to the event loop"); assert.equal(first.filetreeItems, count); assert.equal(first.missingFiles, count - 1); assert.equal(first.returnedPeople, 1);
    f.files.files.delete(path.join(f.files.content, "Actors", "0.jpg"));
    const second = await f.service.candidatesFromFiletree(f.files.root, { personId: "1", limit: 1 }); assert.equal(second.returnedPeople, 0); assert.equal(second.missingFiles, count);
    f.files.avatar("0.jpg", Buffer.alloc(65)); const third = await f.service.candidatesFromFiletree(f.files.root); assert.equal(third.tooLarge, 1); assert.equal(third.returnedPeople, 0);
  } finally { f.close(); }
});

await run("first duplicate mapping, ambiguous names and lexical allowlist stay intact", async () => {
  const f = fixture(["Alice", "Beth"], { Actors: { Alice: "shared.jpg", Beth: "shared.jpg", "../Unsafe": "../../escaped.jpg", Wrong: "file.svg" }, "../outside": { Other: "outside.jpg" } }); f.files.avatar("shared.jpg");
  try {
    await assert.rejects(f.service.importCandidate(f.files.root, "2", "Content/Actors/shared.jpg"), (err) => err.statusCode === 400);
    await f.service.importCandidate(f.files.root, "1", "Content/Actors/shared.jpg", { dryRun: true }); assert.equal(f.files.calls.open.length, 0);
    f.people[1].aliases = ["Alice"];
    await assert.rejects(f.service.importCandidate(f.files.root, "1", "Content/Actors/shared.jpg"), (err) => err.statusCode === 409);
    await assert.rejects(f.service.importCandidate(f.files.root, "1", "../escaped.jpg"), (err) => err.statusCode === 404);
    assert.equal(f.rows().length, 0);
  } finally { f.close(); }
});

await run("effective manual, local and published BLOB avatars skip all image reads and writes", async () => {
  const f = fixture(["Alice", "Beth", "Cara"]); existingImage(f, 1, "manual_upload"); existingImage(f, 2, "local-avatar"); publication(f, 3);
  try {
    for (const person of f.people) assert(f.profile.publicProfile(f.profile.row(person.id)).avatarUrl);
    const summary = await f.service.importFromFiletree(f.files.root, { replace: false });
    assert.equal(summary.imported, 0); assert.equal(summary.skippedExisting, 3); assert.equal(f.files.calls.open.length, 0); assert.equal(f.files.calls.read.length, 0);
    assert.equal(f.rows().length, 2); assert.equal(f.invalidations, 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_publications").get().n, 1);
  } finally { f.close(); }
});

await run("revoked publication is unavailable and a new import preserves durable revocation", async () => {
  const f = fixture(); publication(f, 1, { revoked: true });
  try {
    assert.equal(f.profile.row("1"), null);
    const summary = await f.service.importFromFiletree(f.files.root); assert.equal(summary.imported, 1); assert.equal(summary.skippedExisting, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_publications").get().n, 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_image_revocations").get().n, 1);
    assert.equal(f.profile.row("1").avatar_source, "local-avatar");
  } finally { f.close(); }
});

await run("explicit apply keeps manual priority and retires only the publication pointer", async () => {
  const f = fixture(); existingImage(f, 1, "manual_upload"); publication(f, 1); f.db.prepare("INSERT INTO actor_profile_image_revocations VALUES(1,'older-revoked','hash')").run();
  try {
    await f.service.importCandidate(f.files.root, "1", "Content/Actors/Alice.jpg");
    assert.equal(f.profile.row("1").avatar_source, "manual_upload"); assert.equal(f.rows().length, 2); assert.equal(f.invalidations, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_publications").get().n, 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_image_revocations").get().n, 1);
  } finally { f.close(); }
});

await run("bounded handle rejects actual growth beyond metadata maxBytes without any commit", async () => {
  const f = fixture(); f.files.avatar("Alice.jpg", Buffer.alloc(65), { size: 8 });
  try {
    await assert.rejects(f.service.importCandidate(f.files.root, "1", "Content/Actors/Alice.jpg"), (err) => err.code === "ACTOR_AVATAR_SOURCE_CHANGED");
    assert.equal(f.rows().length, 0); assert.equal(f.invalidations, 0); assert(f.files.calls.read.every((call) => call.length <= 65));
  } finally { f.close(); }
});

await run("empty and exact maximum avatars use one handle and close before publishing", async () => {
  for (const size of [0, 64]) {
    const f = fixture(); f.files.avatar("Alice.jpg", Buffer.alloc(size));
    try { await f.service.importCandidate(f.files.root, "1", "Content/Actors/Alice.jpg"); assert.equal(f.rows()[0].byte_size, size); assert.equal(f.files.calls.open.length, 1); assert.equal(f.files.calls.close.length, 1); assert(f.files.calls.read.every((call) => call.length <= 65)); } finally { f.close(); }
  }
});

for (const change of ["avatar", "filetree", "database", "identity", "alias", "abort", "reservation"]) await run("close boundary rejects " + change + " before any transaction", async () => {
  const f = fixture(), controller = new AbortController(); publication(f, 1); let applied = false;
  f.files.onPhase = async (phase) => {
    if (phase !== "close" || applied) return; applied = true;
    if (change === "avatar") f.files.avatar("Alice.jpg", Buffer.from([5, 6, 7, 8]));
    if (change === "filetree") f.files.filetree({ Actors: { Beth: "Alice.jpg" } });
    if (change === "database") f.switchDatabase();
    if (change === "identity") f.people.splice(0, 1);
    if (change === "alias") f.people[0].name = "Different person";
    if (change === "abort") controller.abort();
    if (change === "reservation") f.db.prepare("INSERT INTO cross_store_aggregate_reservations VALUES('person-avatar:1','pending')").run();
  };
  try {
    await assert.rejects(f.service.importCandidate(f.files.root, "1", "Content/Actors/Alice.jpg", { signal: controller.signal }));
    assert.equal(f.rows().length, 0); assert.equal(f.invalidations, 0); assert.equal(f.db.isTransaction, false);
    assert(f.allDatabaseRows().every((rows) => rows.length === 0));
    if (change !== "database") assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_publications").get().n, 1);
  } finally { f.close(); }
});

await run("durable redirect to a target without a profile cannot publish to the old identity", async () => {
  const f = fixture(["Alice", "Beth"]); publication(f, 1);
  const before = f.db.prepare("SELECT * FROM people ORDER BY id").all();
  f.files.onPhase = async (phase) => {
    if (phase !== "close") return;
    f.db.exec("CREATE TABLE person_redirects(source_id INTEGER PRIMARY KEY,target_id INTEGER); INSERT INTO person_redirects VALUES(1,2);");
    f.changed();
    assert.equal(f.profile.row("1"), null, "canonical target has no profile, so profile presence alone cannot fence identity");
  };
  try {
    await assert.rejects(f.service.importCandidate(f.files.root, "1", "Content/Actors/Alice.jpg"), (err) => err.code === "ACTOR_AVATAR_SOURCE_CHANGED");
    assert.equal(f.rows().length, 0); assert.equal(f.invalidations, 0); assert.deepEqual(f.db.prepare("SELECT * FROM people ORDER BY id").all(), before);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_publications").get().n, 1);
  } finally { f.close(); }
});

await run("bulk rejects a newly ambiguous alias owned by another person after the read", async () => {
  const f = fixture(["Alice", "Beth"], { Actors: { Alice: "Alice.jpg" } }); publication(f, 1);
  const before = f.db.prepare("SELECT * FROM people ORDER BY id").all();
  f.files.onPhase = async (phase) => { if (phase === "close") { f.people[1].aliases = ["Alice"]; f.changed(); } };
  try {
    await assert.rejects(f.service.importFromFiletree(f.files.root, { replace: true }), (err) => err.statusCode === 409);
    assert.equal(f.rows().length, 0); assert.equal(f.invalidations, 0); assert.deepEqual(f.db.prepare("SELECT * FROM people ORDER BY id").all(), before);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_publications").get().n, 1);
  } finally { f.close(); }
});

await run("read and close failures leave no partial avatar, display name or publication", async () => {
  for (const stage of ["read", "close"]) {
    const f = fixture(); publication(f, 1); f.files.onPhase = async (phase) => { if (phase === stage) throw error("EIO"); };
    try { await assert.rejects(f.service.importCandidate(f.files.root, "1", "Content/Actors/Alice.jpg")); assert.equal(f.rows().length, 0); assert.equal(f.invalidations, 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_publications").get().n, 1); assert.equal(f.db.prepare("SELECT updated_at FROM people").get().updated_at, "old"); } finally { f.close(); }
  }
});

await run("failed database transaction rolls back the publication and person together", async () => {
  const f = fixture(); publication(f, 1); f.db.exec("CREATE TRIGGER fanhao_images.reject_avatar BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT,'controlled insert failure'); END;");
  try { await assert.rejects(f.service.importCandidate(f.files.root, "1", "Content/Actors/Alice.jpg"), /controlled insert failure/); assert.equal(f.rows().length, 0); assert.equal(f.db.prepare("SELECT updated_at FROM people").get().updated_at, "old"); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM actor_profile_publications").get().n, 1); assert.equal(f.invalidations, 0); } finally { f.close(); }
});

await run("bulk partial success invalidates prior commits and stops on cancellation", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(["Alice", "Beth"]), controller = new AbortController();
    if (cancel) f.files.onPhase = async (phase, target) => { if (phase === "read" && target.endsWith("Beth.jpg")) controller.abort(); };
    else f.db.exec("CREATE TRIGGER fanhao_images.reject_second BEFORE INSERT ON images WHEN NEW.owner_id=2 BEGIN SELECT RAISE(ABORT,'second insert failure'); END;");
    try { await assert.rejects(f.service.importFromFiletree(f.files.root, { signal: controller.signal })); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].owner_id, 1); assert.equal(f.invalidations, 1); assert.equal(f.db.prepare("SELECT updated_at FROM people WHERE id=2").get().updated_at, "old"); } finally { f.close(); }
  }
});

await run("admin routes await DTOs, preserve local authorization and cancel a disconnected read", async () => {
  const f = fixture(), config = { actorAvatarDataPath: f.files.root }; const admin = createAdminActorAvatarService({ actorAvatarService: f.service, appConfigService: { current: () => config, set: (value) => Object.assign(config, value), publicConfig: () => ({ ...config }) }, clampInteger: (value, fallback) => Number(value) || fallback, resolveLibraryPersonByPublicId: (id) => f.people.find((person) => person.id === id) });
  function request() { return Object.assign(new EventEmitter(), { method: "POST", aborted: false }); }
  function response() { return Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }); }
  try {
    const req = request(), res = response(), sent = [];
    const deps = { adminActorAvatarService: admin, readJsonBody: async () => ({ personId: "1", relPath: "Content/Actors/Alice.jpg" }), requireLocalAdmin: () => true, sendJson: (_res, status, payload) => { sent.push({ status, payload }); res.writableEnded = true; } };
    await routeAdminApi(req, res, new URL("http://synthetic/api/admin/actor-avatar-candidates"), deps); assert.equal(sent[0].status, 200); assert.equal(sent[0].payload.summary.returnedPeople, 1); assert.equal(req.listenerCount("aborted"), 0); assert.equal(res.listenerCount("close"), 0);
    const reads = f.files.calls.readFile.length; await routeAdminApi(request(), response(), new URL("http://synthetic/api/admin/import-actor-avatars"), { ...deps, requireLocalAdmin: () => false }); assert.equal(f.files.calls.readFile.length, reads);
    const gate = deferred(), entered = deferred(); f.files.onPhase = async (phase) => { if (phase === "read") { entered.resolve(); await gate.promise; } };
    const disconnectedReq = request(), disconnectedRes = response(); const task = routeAdminApi(disconnectedReq, disconnectedRes, new URL("http://synthetic/api/admin/apply-actor-avatar-candidate"), deps);
    await entered.promise; disconnectedRes.destroyed = true; disconnectedRes.emit("close"); gate.resolve(); assert.equal(await task, true);
    assert.equal(f.rows().length, 0); assert.equal(sent.length, 1); assert.equal(disconnectedReq.listenerCount("aborted"), 0); assert.equal(disconnectedRes.listenerCount("close"), 0);
    const abortedGate = deferred(), abortedEntered = deferred(); f.files.onPhase = async (phase) => { if (phase === "read") { abortedEntered.resolve(); await abortedGate.promise; } };
    const abortedReq = request(), intactRes = response(); const abortedTask = routeAdminApi(abortedReq, intactRes, new URL("http://synthetic/api/admin/apply-actor-avatar-candidate"), deps);
    await abortedEntered.promise; abortedReq.aborted = true; abortedReq.emit("aborted"); abortedGate.resolve(); assert.equal(await abortedTask, true);
    assert.equal(intactRes.destroyed, false); assert.equal(f.rows().length, 0); assert.equal(sent.length, 1); assert.equal(abortedReq.listenerCount("aborted"), 0); assert.equal(intactRes.listenerCount("close"), 0);
  } finally { f.close(); }
});

assert(checks > 0, "case filter must execute an actual behavior scenario");
console.log(`PASS actor avatar import: ${checks} controlled-file/actual-SQLite scenarios`);
