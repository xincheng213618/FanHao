import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createNovelStore as currentFactory, novelWriteOperationHash } from "../src/modules/novels/server/store.js";
import { createNovelWriteWorkerClient } from "../src/modules/novels/server/write-worker-client.js";
import { routeNovelApi } from "../src/modules/novels/server/routes.js";

// All bodies, books and databases are synthetic. No application server is started.
// --legacy executes HEAD's actual store for the original SQLite ordering proof.
const legacy = process.argv.includes("--legacy");
const factory = legacy ? await legacyFactory() : currentFactory;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-progress-order-"));
const TTL = 24 * 60 * 60 * 1000;
const text = "第一章 开始\n\n合成第一章正文。\n\n第二章 继续\n\n合成第二章正文。";
const tests = [];
const stores = new Set();
const writers = new Set();
let serial = 0;
let passed = 0;
const test = (name, run) => tests.push({ name, run });
const fresh = () => {
  const dbPath = owned(`progress-${++serial}.sqlite`);
  const store = factory({ dbPath });
  stores.add(store);
  const detail = store.uploadBook({ fileName: "synthetic.txt", text });
  return { dbPath, store, detail };
};
const sql = (dbPath, run) => {
  assert.equal(path.dirname(path.resolve(dbPath)), temporary);
  const db = new DatabaseSync(dbPath);
  try { return run(db); } finally { db.close(); }
};
const reading = (dbPath, bookId) => sql(dbPath, db => db.prepare("SELECT * FROM novel_reading_state WHERE book_id=?").get(bookId));
const hasLedger = dbPath => sql(dbPath, db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='novel_progress_sessions'").get()));
const sessions = dbPath => hasLedger(dbPath) ? sql(dbPath, db => db.prepare("SELECT * FROM novel_progress_sessions ORDER BY book_id,catalog_revision,session_id").all()) : [];
const floor = dbPath => sql(dbPath, db => Number(db.prepare("SELECT value FROM novel_meta WHERE key='progress_clock_ms'").get()?.value || 0));
const session = startedAt => ({ progressSessionId: crypto.randomUUID(), progressSessionStartedAt: startedAt });
const body = (detail, token, sequence, ratio = 0.5, index = 1) => ({
  sourceRealm: detail.sourceRealm, catalogRevision: detail.catalogRevision,
  chapterId: detail.chapters.find(chapter => chapter.index === index).id,
  chapterIndex: index, scrollRatio: ratio,
  ...token, progressSequence: sequence
});
const status = code => error => error.statusCode === code;
const save = (fixture, token, sequence, ratio, index) => fixture.store.saveProgress(fixture.detail.book.id, body(fixture.detail, token, sequence, ratio, index));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("latest keepalive arriving before 40 older normal bodies never rewinds SQLite", () => {
  const fixture = fresh();
  const token = session(Date.now());
  const latest = save(fixture, token, 99, 0.99);
  const before = reading(fixture.dbPath, fixture.detail.book.id);
  const results = [];
  for (let sequence = 1; sequence <= 40; sequence++) results.push(save(fixture, token, sequence, sequence / 100));
  // This assertion is deliberately first: HEAD fails on real persisted 40%,
  // rather than on a newly added response field or a source-text marker.
  assert.equal(reading(fixture.dbPath, fixture.detail.book.id).scroll_ratio, 0.99, "older normal writes must not overwrite the already committed keepalive");
  assert.deepEqual(reading(fixture.dbPath, fixture.detail.book.id), before);
  assert.equal(latest.applied, true);
  for (const result of results) { assert.equal(result.applied, false); assert.equal(result.scrollRatio, 0.99); assert.equal(result.updatedAt, before.updated_at); }
  assert.equal(sessions(fixture.dbPath)[0].max_sequence, 99);
});

test("metadata server clock is read-only, uses its persisted floor and keeps v5 lazy", async () => {
  const fixture = fresh();
  assert.equal(hasLedger(fixture.dbPath), false);
  assert.equal(sql(fixture.dbPath, db => db.prepare("SELECT value FROM novel_meta WHERE key='schema_version'").get().value), "5");
  await withClock(Date.now() + 10_000, async clock => {
    assert.equal(fixture.store.bookMeta(fixture.detail.book.id).serverClockMs, clock.now);
    assert.equal(floor(fixture.dbPath), 0, "metadata cannot create a clock floor");
    const futureFloor = clock.now + 1234;
    sql(fixture.dbPath, db => db.prepare("INSERT INTO novel_meta(key,value) VALUES ('progress_clock_ms',?)").run(String(futureFloor)));
    const blocker = new DatabaseSync(fixture.dbPath);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      const response = await route(fixture.store, fixture.detail.book.id, "GET", undefined);
      assert.equal(response.status, 200);
      assert.equal(response.data.serverClockMs, futureFloor);
      assert.equal(fixture.store.chapterDetail(fixture.detail.book.id, 1).serverClockMs, futureFloor);
    } finally { blocker.exec("ROLLBACK"); blocker.close(); }
    assert.equal(floor(fixture.dbPath), futureFloor);
    assert.equal(hasLedger(fixture.dbPath), false, "read paths must not create session schema");
  });
});

test("legacy bodies stay compatible while incomplete or invalid fenced fields never mutate", () => {
  const fixture = fresh();
  const legacyBody = { chapterIndex: 1, scrollRatio: 0.25 };
  assert.equal(fixture.store.saveProgress(fixture.detail.book.id, legacyBody).scrollRatio, 0.25);
  assert.equal(hasLedger(fixture.dbPath), false);
  const token = session(Date.now());
  const valid = body(fixture.detail, token, 1, 0.6);
  const invalid = [
    { ...valid, progressSessionId: undefined }, { ...valid, progressSessionId: "bad-id" },
    { ...valid, progressSessionStartedAt: "100" }, { ...valid, progressSessionStartedAt: -1 },
    { ...valid, progressSequence: 0 }, { ...valid, progressSequence: 1.5 },
    { ...valid, progressSequence: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, progressSequence: null }
  ];
  for (const field of ["progressSessionId", "progressSessionStartedAt", "progressSequence"]) { const partial = { ...valid }; delete partial[field]; invalid.push(partial); }
  const before = reading(fixture.dbPath, fixture.detail.book.id);
  for (const candidate of invalid) assert.throws(() => fixture.store.saveProgress(fixture.detail.book.id, candidate), status(400));
  const withoutRealm = { ...valid }; delete withoutRealm.sourceRealm;
  assert.throws(() => fixture.store.saveProgress(fixture.detail.book.id, withoutRealm), status(409));
  for (const patch of [{ sourceRealm: "server:wrong" }, { catalogRevision: "wrong" }, { chapterId: "wrong" }, { chapterIndex: 2 }, { scrollRatio: 1.1 }]) {
    assert.throws(() => fixture.store.saveProgress(fixture.detail.book.id, { ...valid, ...patch }), status(patch.scrollRatio ? 400 : 409));
  }
  assert.deepEqual(reading(fixture.dbPath, fixture.detail.book.id), before);
  assert.equal(hasLedger(fixture.dbPath), false);
  assert.equal(floor(fixture.dbPath), 0);
});

test("a higher sequence may intentionally read back and may move across chapters", () => {
  const fixture = fresh();
  const token = session(Date.now());
  assert.equal(save(fixture, token, 99, 0.99, 2).applied, true);
  assert.equal(save(fixture, token, 100, 0.07, 1).applied, true);
  assert.equal(reading(fixture.dbPath, fixture.detail.book.id).chapter_index, 1);
  assert.equal(reading(fixture.dbPath, fixture.detail.book.id).scroll_ratio, 0.07);
  assert.equal(save(fixture, token, 101, 0, 2).applied, true);
  assert.equal(reading(fixture.dbPath, fixture.detail.book.id).chapter_index, 2);
  assert.equal(reading(fixture.dbPath, fixture.detail.book.id).scroll_ratio, 0);
});

test("separate device sessions retain independent high-water marks and arrival policy", () => {
  const fixture = fresh();
  const a = session(Date.now());
  const b = session(Date.now());
  save(fixture, a, 99, 0.99);
  assert.equal(save(fixture, b, 1, 0.4).applied, true);
  const bState = reading(fixture.dbPath, fixture.detail.book.id);
  const oldA = save(fixture, a, 40, 0.1);
  assert.equal(oldA.applied, false); assert.equal(oldA.scrollRatio, 0.4);
  assert.deepEqual(reading(fixture.dbPath, fixture.detail.book.id), bState);
  assert.equal(save(fixture, b, 2, 0.3).applied, true);
  assert.equal(save(fixture, a, 100, 0.2).applied, true, "a genuinely new intent from another device remains legal");
  assert.equal(sessions(fixture.dbPath).length, 2);
  const other = fixture.store.uploadBook({ fileName: "another.txt", text });
  assert.equal(fixture.store.saveProgress(other.book.id, body(other, a, 1, 0.8)).applied, true, "a book has its own sequence domain");
});

test("a session start is immutable and future or expired packets leave all state intact", async () => {
  const fixture = fresh();
  await withClock(Date.now() + 10_000, async clock => {
    const a = session(clock.now);
    save(fixture, a, 4, 0.4);
    const before = state(fixture);
    assert.throws(() => save(fixture, { ...a, progressSessionStartedAt: clock.now - 1 }, 5, 0.5), status(409));
    assert.throws(() => save(fixture, session(clock.now + 1), 1, 0.9), status(400));
    assert.throws(() => save(fixture, session(clock.now - TTL), 100, 0.9), status(409));
    assert.deepEqual(state(fixture), before, "failed admission rolls back clock, ledger and cursor");
  });
});

test("only expired sessions are pruned and wall-clock rollback cannot resurrect them", async () => {
  const fixture = fresh();
  await withClock(Date.now() + 10_000, async clock => {
    const start = clock.now;
    const a = session(start);
    save(fixture, a, 99, 0.99);
    clock.now = start + TTL - 1;
    assert.equal(save(fixture, a, 1, 0.1).applied, false);
    assert.equal(sessions(fixture.dbPath).length, 1);
    clock.now = start + TTL;
    assert.throws(() => save(fixture, a, 100, 0.1), status(409), "exactly 24 hours is expired");
    const b = session(clock.now);
    save(fixture, b, 1, 0.6);
    assert.equal(sessions(fixture.dbPath).length, 1);
    assert.equal(sessions(fixture.dbPath)[0].session_id, b.progressSessionId);
    const committedFloor = floor(fixture.dbPath);
    clock.now = start + 1;
    assert.equal(fixture.store.bookMeta(fixture.detail.book.id).serverClockMs, committedFloor);
    assert.throws(() => save(fixture, a, 100, 0.1), status(409), "an old packet stays expired after pruning and wall-clock rollback");
    assert.equal(save(fixture, b, 2, 0.5).applied, true);
    assert.equal(floor(fixture.dbPath), committedFloor);
    assert.equal(sessions(fixture.dbPath).length, 1);
  });
});

test("32 live sessions in a book apply backpressure without evicting old fences", () => {
  const fixture = fresh();
  const tokens = Array.from({ length: 32 }, () => session(Date.now()));
  tokens.forEach((token, index) => save(fixture, token, 99, index / 100));
  const before = state(fixture);
  assert.throws(() => save(fixture, session(Date.now()), 1, 0.9), status(503));
  assert.deepEqual(state(fixture), before);
  assert.equal(save(fixture, tokens[0], 40, 0.1).applied, false, "the first session must not have been evicted");
  assert.equal(save(fixture, tokens[0], 100, 0.7).applied, true, "capacity applies to new sessions rather than existing ones");
  assert.equal(sessions(fixture.dbPath).length, 32);
});

test("8192 global live fences are bounded and expired capacity is safely reusable", () => {
  const fixture = fresh();
  const a = session(Date.now());
  save(fixture, a, 99, 0.99);
  seedGlobalCapacity(fixture, a.progressSessionStartedAt);
  assert.equal(sessions(fixture.dbPath).length, 8192);
  const before = state(fixture);
  assert.throws(() => save(fixture, session(Date.now()), 1, 0.8), status(503));
  assert.deepEqual(state(fixture), before);
  assert.equal(save(fixture, a, 100, 0.7).applied, true);
  assert.equal(sessions(fixture.dbPath).length, 8192);
  // Alter a private fixture row to a legitimately expired lifetime, without
  // deleting a live fence or corrupting the started_at -> expiry invariant.
  const expiredNow = Date.now();
  sql(fixture.dbPath, db => db.prepare("UPDATE novel_progress_sessions SET started_at=?,expires_at=? WHERE book_id='capacity-book-0' AND session_id=(SELECT session_id FROM novel_progress_sessions WHERE book_id='capacity-book-0' LIMIT 1)")
    .run(expiredNow - TTL, expiredNow));
  assert.equal(save(fixture, session(Date.now()), 1, 0.6).applied, true);
  assert.equal(sessions(fixture.dbPath).length, 8192);
});

test("deleted books and obsolete catalog revisions can release capacity safely", () => {
  const fixture = fresh();
  const a = session(Date.now());
  save(fixture, a, 99, 0.9);
  const replacement = fixture.store.reimportBook(fixture.detail.book.id, { text: text + "\n新的合成正文。" });
  assert.notEqual(replacement.catalogRevision, fixture.detail.catalogRevision);
  assert.throws(() => save(fixture, a, 100, 0.1), status(409));
  fixture.store.saveProgress(replacement.book.id, body(replacement, session(Date.now()), 1, 0.5));
  assert.equal(sessions(fixture.dbPath).length, 1);
  assert.equal(sessions(fixture.dbPath)[0].catalog_revision, replacement.catalogRevision);
  fixture.store.deleteBook(replacement.book.id, { sourceRealm: replacement.sourceRealm });
  const next = fixture.store.uploadBook({ fileName: "next.txt", text });
  fixture.store.saveProgress(next.book.id, body(next, session(Date.now()), 1, 0.3));
  assert.equal(sessions(fixture.dbPath).length, 1);
  assert.equal(sessions(fixture.dbPath)[0].book_id, next.book.id);
});

test("actual route delayed body cannot overwrite an already accepted keepalive", async () => {
  const fixture = fresh();
  const a = session(Date.now());
  const held = deferred();
  const entered = deferred();
  const oldTask = route(fixture.store, fixture.detail.book.id, "POST", body(fixture.detail, a, 1, 0.1), async () => { entered.resolve(); await held.promise; });
  await entered.promise;
  try {
    const newest = await route(fixture.store, fixture.detail.book.id, "POST", body(fixture.detail, a, 99, 0.99));
    assert.equal(newest.status, 200); assert.equal(newest.data.progress.applied, true);
    assert.equal(reading(fixture.dbPath, fixture.detail.book.id).scroll_ratio, 0.99);
  } finally { held.resolve(); }
  const old = await oldTask;
  assert.equal(old.status, 200); assert.equal(old.data.progress.applied, false);
  assert.equal(reading(fixture.dbPath, fixture.detail.book.id).scroll_ratio, 0.99);
});

test("real Worker restart and exact operation receipts preserve the sequence fence", async () => {
  const fixture = fresh();
  const a = session(Date.now());
  const createWriter = () => {
    const writer = createNovelWriteWorkerClient({ dbPath: fixture.dbPath, onCommitted: () => fixture.store.invalidate(),
      workerFactory: (url, options) => new Worker(url, { ...options, execArgv: [] }) });
    writers.add(writer); return writer;
  };
  let writer = createWriter();
  await writer.start();
  const args = [fixture.detail.book.id, body(fixture.detail, a, 99, 0.99)];
  const operationId = crypto.randomUUID();
  const once = await writer.write("saveProgress", args, { operationId, sourceRealm: fixture.detail.sourceRealm });
  assert.equal(once.applied, true);
  await writer.stop(); writers.delete(writer);
  writer = createWriter(); await writer.start();
  const stale = await writer.saveProgress(fixture.detail.book.id, body(fixture.detail, a, 40, 0.4));
  assert.equal(stale.applied, false); assert.equal(stale.scrollRatio, 0.99);
  const b = session(Date.now());
  await writer.saveProgress(fixture.detail.book.id, body(fixture.detail, b, 1, 0.6));
  const beforeReplay = state(fixture);
  assert.deepEqual(await writer.write("saveProgress", args, { operationId, sourceRealm: fixture.detail.sourceRealm }), once);
  assert.deepEqual(state(fixture), beforeReplay, "a durable receipt returns the original ack without replaying progress or its fence");
  const receipt = fixture.store.readWriteReceipt({ operationId, requestHash: novelWriteOperationHash("saveProgress", args), sourceRealm: fixture.detail.sourceRealm });
  assert.equal(receipt.status, "committed"); assert.deepEqual(receipt.result, once);
  await assert.rejects(writer.saveProgress(fixture.detail.book.id, { ...body(fixture.detail, a, 100, 0.1), sourceRealm: "server:wrong" }), error => error.statusCode === 409 && error.rollbackConfirmed && error.outcome === "not_committed");
  assert.deepEqual(state(fixture), beforeReplay);
  // Recovery receipts are independent of the session ledger's lifetime.
  assert.equal(sql(fixture.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM novel_write_receipts WHERE retain_receipt=0").get().n), 0, "a successful receipt replay can acknowledge the preceding private progress receipt");
  assert.equal((await writer.saveProgress(fixture.detail.book.id, body(fixture.detail, b, 2, 0.5))).applied, true);
  assert.equal(sql(fixture.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM novel_write_receipts WHERE retain_receipt=0").get().n), 1);
  await writer.stop(); writers.delete(writer);
  assert.equal(sql(fixture.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM novel_write_receipts WHERE retain_receipt=0").get().n), 0);
  assert.equal(sessions(fixture.dbPath).length, 2);
});

try {
  for (const item of legacy ? tests.slice(0, 1) : tests) {
    await item.run(); passed += 1; console.log(`PASS ${item.name}`);
  }
  console.log(`PASS novel progress order: ${passed} groups (actual store/routes/SQLite; real Worker restart)`);
} finally {
  const stopped = await Promise.allSettled([...writers].map(writer => writer.stop()));
  const failedStop = stopped.find(result => result.status === "rejected");
  if (failedStop) throw failedStop.reason;
  for (const store of stores) store.invalidate();
  // Flat temporary root: validate every exact file, unlink, then remove the
  // verified empty directory. There is no recursive filesystem operation.
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("fanhao-progress-order-"));
  for (const name of fs.readdirSync(resolved)) {
    const file = path.resolve(resolved, name);
    assert.equal(path.dirname(file), resolved); assert.ok(fs.lstatSync(file).isFile()); fs.unlinkSync(file);
  }
  fs.rmdirSync(resolved);
  assert.equal(fs.existsSync(resolved), false);
}

function owned(name) { const result = path.resolve(temporary, name); assert.equal(path.dirname(result), temporary); return result; }
function state(fixture) { return { reading: reading(fixture.dbPath, fixture.detail.book.id), sessions: sessions(fixture.dbPath), floor: floor(fixture.dbPath) }; }
async function withClock(now, run) {
  const actualNow = Date.now;
  const clock = { now };
  Date.now = () => clock.now;
  try { return await run(clock); } finally { Date.now = actualNow; }
}
async function route(store, bookId, method, payload, beforeBody = async () => {}) {
  const response = {};
  await routeNovelApi({ method }, response, new URL(`http://fixture/api/novels/${bookId}${method === "POST" ? "/progress" : "?catalog=0"}`), {
    novelStore: store,
    readJsonBody: async () => { await beforeBody(); return payload; },
    notFound: target => { target.status = 404; },
    sendJson: (target, code, data) => Object.assign(target, { status: code, data })
  });
  return response;
}
function seedGlobalCapacity(fixture, startedAt) {
  sql(fixture.dbPath, db => {
    const template = db.prepare("SELECT * FROM novel_books WHERE id=?").get(fixture.detail.book.id);
    const columns = Object.keys(template);
    const insertBook = db.prepare(`INSERT INTO novel_books (${columns.map(column => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    const insertSession = db.prepare("INSERT INTO novel_progress_sessions(book_id,catalog_revision,session_id,started_at,max_sequence,expires_at) VALUES (?,?,?,?,?,?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 256; index++) {
        const id = `capacity-book-${index}`;
        const record = { ...template, id, source_path: `synthetic-capacity:${index}` };
        insertBook.run(...columns.map(column => record[column]));
        for (let slot = 0; slot < (index === 255 ? 31 : 32); slot++) {
          insertSession.run(id, fixture.detail.catalogRevision, crypto.randomUUID(), startedAt, 99, startedAt + TTL);
        }
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}
async function legacyFactory() {
  const relative = "src/modules/novels/server/store.js";
  let source = execFileSync("git", ["show", `HEAD:${relative}`], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true });
  source = source.replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, quote) => `${prefix}${pathToFileURL(path.resolve(import.meta.dirname, "..", path.dirname(relative), specifier)).href}${quote}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).createNovelStore;
}
