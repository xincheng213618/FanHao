import assert from "node:assert/strict";
import test from "node:test";
import { createNovelProgressWriter } from "../public/modules/novels/progress-writer.js";

// Pure transport scheduling with synthetic records. No server, media, SQLite,
// browser, credentials, session clock or production library is used.
const SESSION = "00000000-0000-4000-8000-000000000001";
const tick = () => new Promise(resolve => setImmediate(resolve));
function record(sequence, { bookId = "A", realm = "local", revision = "rev-1", chapter = 1, ratio = sequence / 10000 } = {}) {
  return {
    bookId, sourceRealm: realm, catalogRevision: revision, owner: 1, revision: sequence,
    body: { sourceRealm: realm, catalogRevision: revision, chapterId: `${bookId}-${chapter}`, chapterIndex: chapter,
      scrollRatio: ratio, progressSessionId: SESSION, progressSessionStartedAt: 1800000000000, progressSequence: sequence }
  };
}
function fixture(options = {}) {
  const normal = [], keepalive = [], results = [], errors = [], settled = [];
  const writer = createNovelProgressWriter({
    send(value) { return new Promise((resolve, reject) => normal.push({ record: value, resolve, reject })); },
    sendKeepalive(value) { keepalive.push(value); return Promise.resolve({ applied: true, progress: value.body }); },
    onResult(value, data) { results.push({ record: value, data }); },
    onError(value, error) { errors.push({ record: value, error }); },
    onSettled(value) { settled.push(value); },
    ...options
  });
  return { writer, normal, keepalive, results, errors, settled };
}
const acknowledge = async entry => { entry.resolve({ applied: true, progress: entry.record.body }); await tick(); };

test("10,000 automatic saves retain one active request and only the latest pending position", async () => {
  const f = fixture();
  for (let sequence = 1; sequence <= 10000; sequence++) assert.equal(f.writer.save(record(sequence)), undefined);
  assert.equal(f.normal.length, 1);
  await acknowledge(f.normal[0]);
  assert.equal(f.normal.length, 2);
  assert.equal(f.normal[1].record.body.progressSequence, 10000);
  await acknowledge(f.normal[1]);
  assert.equal(f.normal.length, 2);
  assert.equal(f.results.length, 2);
  assert.equal(f.settled.length, 2);
});

test("records freeze scalar identities without retaining caller objects or chapter bodies", async () => {
  const f = fixture(), original = record(1, { chapter: 7, ratio: 0.7 });
  f.writer.save(original);
  original.bookId = "B"; original.owner = 999; original.body.chapterId = "changed";
  original.body.progressSequence = 999; original.body.scrollRatio = 0;
  const sent = f.normal[0].record;
  assert.notEqual(sent, original); assert.notEqual(sent.body, original.body);
  assert(Object.isFrozen(sent)); assert(Object.isFrozen(sent.body));
  assert.equal(sent.bookId, "A"); assert.equal(sent.owner, 1);
  assert.equal(sent.body.chapterId, "A-7"); assert.equal(sent.body.scrollRatio, 0.7);
  assert.equal(sent.body.progressSessionId, SESSION);
  assert.equal(sent.body.progressSessionStartedAt, 1800000000000);
  assert.equal(sent.body.progressSequence, 1);
  assert.throws(() => f.writer.save({ ...record(2), chapter: { content: "must not be retained" } }), /scalar/);
  await acknowledge(f.normal[0]);
});

test("automatic coalescing keeps distinct books, source realms and catalog revisions", async () => {
  const f = fixture();
  f.writer.save(record(1));
  f.writer.save(record(2, { chapter: 2 }));
  f.writer.save(record(3, { chapter: 3, ratio: 0.2 }));
  f.writer.save(record(4, { bookId: "B" }));
  f.writer.save(record(5, { realm: "server:other" }));
  f.writer.save(record(6, { revision: "rev-2" }));
  for (let index = 0; index < 5; index++) await acknowledge(f.normal[index]);
  assert.deepEqual(f.normal.map(entry => [entry.record.bookId, entry.record.sourceRealm, entry.record.catalogRevision, entry.record.body.progressSequence]), [
    ["A", "local", "rev-1", 1], ["A", "local", "rev-1", 3], ["B", "local", "rev-1", 4],
    ["A", "server:other", "rev-1", 5], ["A", "local", "rev-2", 6]
  ]);
  assert.equal(f.normal[1].record.body.chapterId, "A-3");
  assert.equal(f.normal[1].record.body.scrollRatio, 0.2, "a later intention to reread may have a smaller ratio");
});

test("explicit recovery waits for its actual receipt and is not replaced by an automatic save", async () => {
  const f = fixture();
  f.writer.save(record(1));
  const confirmation = f.writer.save(record(2), { explicit: true });
  let completed = false; void confirmation.then(() => { completed = true; });
  f.writer.save(record(3));
  assert.equal(completed, false);
  await acknowledge(f.normal[0]);
  assert.equal(f.normal[1].record.explicit, true);
  const receipt = { applied: true, progress: f.normal[1].record.body };
  f.normal[1].resolve(receipt);
  assert.equal(await confirmation, receipt);
  await tick();
  assert.equal(f.normal[2].record.body.progressSequence, 3);
  await acknowledge(f.normal[2]);
});

test("separate explicit requests all settle even when they share one automatic key", async () => {
  const f = fixture();
  const first = f.writer.save(record(1), { explicit: true });
  const second = f.writer.save(record(2), { explicit: true });
  await acknowledge(f.normal[0]); await first;
  await acknowledge(f.normal[1]); await second;
  assert.deepEqual(f.normal.map(entry => entry.record.body.progressSequence), [1, 2]);
});

test("explicit capacity includes the active confirmation and rejects overflow clearly", async () => {
  const f = fixture({ maxExplicit: 2 });
  const first = f.writer.save(record(1), { explicit: true });
  const second = f.writer.save(record(2), { explicit: true });
  await assert.rejects(f.writer.save(record(3), { explicit: true }), { code: "NOVEL_PROGRESS_QUEUE_FULL" });
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].record.body.progressSequence, 3);
  assert.equal(f.normal.length, 1);
  await acknowledge(f.normal[0]); await first;
  await acknowledge(f.normal[1]); await second;
  assert.equal(f.normal.length, 2);
});

test("automatic capacity never silently replaces another book and allows same-key updates", async () => {
  const f = fixture({ maxPendingKeys: 2 });
  f.writer.save(record(1));
  f.writer.save(record(2, { bookId: "B" }));
  f.writer.save(record(3, { bookId: "C" }));
  f.writer.save(record(4, { bookId: "D" }));
  f.writer.save(record(5, { bookId: "C", chapter: 2 }));
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].record.bookId, "D");
  assert.equal(f.errors[0].error.code, "NOVEL_PROGRESS_QUEUE_FULL");
  for (let index = 0; index < 3; index++) await acknowledge(f.normal[index]);
  assert.deepEqual(f.normal.map(entry => [entry.record.bookId, entry.record.body.progressSequence]), [["A", 1], ["B", 2], ["C", 5]]);
});

test("an old failure cannot requeue its position over the latest pending record", async () => {
  const f = fixture();
  f.writer.save(record(1)); f.writer.save(record(2));
  const error = new Error("old transport failed");
  f.normal[0].reject(error); await tick();
  assert.equal(f.errors[0].record.revision, 1); assert.equal(f.errors[0].error, error);
  assert.equal(f.normal[1].record.revision, 2);
  await acknowledge(f.normal[1]);
  assert.equal(f.normal.length, 2, "unknown outcomes must not create automatic retries");
});

test("an explicit transport failure rejects its receipt and permits a fresh attempt", async () => {
  const f = fixture();
  const pending = f.writer.save(record(1), { explicit: true });
  const rejected = assert.rejects(pending, /synthetic failure/);
  f.normal[0].reject(new Error("synthetic failure")); await rejected;
  const retry = f.writer.save(record(2), { explicit: true });
  await acknowledge(f.normal[1]); await retry;
  assert.deepEqual(f.normal.map(entry => entry.record.body.progressSequence), [1, 2]);
});

test("synchronous transport and callback failures cannot strand the queue or confirmation", async () => {
  const f = fixture({
    send: value => { if (value.body.progressSequence === 1) throw new Error("sync failure"); return { applied: true }; },
    onResult() { throw new Error("view failed"); }, onSettled() { throw new Error("view settled failed"); }
  });
  f.writer.save(record(1));
  const receipt = await f.writer.save(record(2), { explicit: true });
  assert.equal(receipt.applied, true);
  assert.equal(f.errors[0].error.message, "sync failure");
});

test("keepalive synchronously sends every latest automatic key and pauses older normal drain", async () => {
  const f = fixture();
  f.writer.save(record(1)); f.writer.save(record(2)); f.writer.save(record(3));
  f.writer.save(record(4, { bookId: "B" })); f.writer.save(record(5, { bookId: "C" }));
  const explicit = f.writer.save(record(7, { bookId: "D" }), { explicit: true });
  let confirmed = false; void explicit.then(() => { confirmed = true; });
  assert.equal(f.writer.flushKeepalive(record(6)), undefined);
  assert.deepEqual(f.keepalive.map(value => [value.bookId, value.body.progressSequence]), [["A", 6], ["B", 4], ["C", 5]]);
  assert(f.keepalive.every(value => !value.explicit));
  assert(f.keepalive.every(value => value.body.progressSessionId === SESSION && value.body.progressSessionStartedAt === 1800000000000));
  await acknowledge(f.normal[0]);
  assert.equal(f.normal.length, 1); assert.equal(confirmed, false);
  f.writer.resume();
  assert.equal(f.normal.length, 2); assert.equal(f.normal[1].record.body.progressSequence, 7);
  await acknowledge(f.normal[1]); await explicit;
  assert.equal(f.normal.length, 2, "positions handed to keepalive must not later return to normal drain");
});

test("keepalive chooses the higher same-session sequence without changing its identity", async () => {
  const f = fixture(); f.writer.save(record(1)); f.writer.save(record(3));
  f.writer.flushKeepalive(record(2));
  assert.equal(f.keepalive[0].body.progressSequence, 3);
  assert.equal(f.keepalive[0].body.progressSessionStartedAt, 1800000000000);
  await acknowledge(f.normal[0]);
});

test("a fresh save resumes after pagehide while explicit work still receives its own receipt", async () => {
  const f = fixture(); f.writer.save(record(1));
  const explicit = f.writer.save(record(2, { bookId: "B" }), { explicit: true });
  f.writer.flushKeepalive(record(3)); await acknowledge(f.normal[0]);
  f.writer.save(record(4, { bookId: "C" }));
  assert.equal(f.normal[1].record.bookId, "B");
  await acknowledge(f.normal[1]); await explicit;
  assert.equal(f.normal[2].record.bookId, "C"); await acknowledge(f.normal[2]);
});

test("same-session server fencing protects a latest keepalive from an unavoidable old active POST", async () => {
  let highest = 0, persisted = null;
  const apply = value => {
    if (value.body.progressSequence <= highest) return { progress: { ...persisted, applied: false } };
    highest = value.body.progressSequence; persisted = value.body;
    return { progress: { ...persisted, applied: true } };
  };
  const f = fixture({ sendKeepalive: value => { f.keepalive.push(value); return apply(value); } });
  f.writer.save(record(1, { ratio: 0.01 })); f.writer.save(record(40, { ratio: 0.4 }));
  f.writer.flushKeepalive(record(99, { ratio: 0.99 }));
  assert.equal(persisted.scrollRatio, 0.99);
  f.normal[0].resolve(apply(f.normal[0].record)); await tick();
  assert.equal(persisted.scrollRatio, 0.99);
  assert.equal(f.normal.length, 1); assert(f.results.some(value => value.data.progress.applied === false));
  assert.equal(highest, 99);
});

test("keepalive failures preserve their record identity and do not restart an obsolete drain", async () => {
  const f = fixture({ sendKeepalive() { throw new Error("keepalive unavailable"); } });
  f.writer.save(record(1)); f.writer.save(record(2, { bookId: "B" }));
  f.writer.flushKeepalive(record(3));
  assert.deepEqual(f.errors.map(value => value.record.bookId), ["A", "B"]);
  await acknowledge(f.normal[0]); assert.equal(f.normal.length, 1);
  f.writer.save(record(4)); await acknowledge(f.normal[1]);
  assert.equal(f.normal[1].record.body.progressSequence, 4);
});

test("invalid capacities and nested bodies fail before they can be retained", () => {
  assert.throws(() => fixture({ maxPendingKeys: 0 }), RangeError);
  assert.throws(() => fixture({ maxExplicit: 1.5 }), RangeError);
  const f = fixture();
  assert.throws(() => f.writer.save({ ...record(1), body: { chapter: { content: "large body" } } }), /scalar/);
  assert.throws(() => f.writer.save({ ...record(1), body: { scrollRatio: NaN } }), /number/);
  assert.equal(f.normal.length, 0);
});

test("keepalive includes an active automatic record from another book without auto-confirming an explicit request", async () => {
  const f = fixture(); f.writer.save(record(1));
  f.writer.flushKeepalive(record(2, { bookId: "B" }));
  assert.deepEqual(f.keepalive.map(value => [value.bookId, value.body.progressSequence]), [["A", 1], ["B", 2]]);
  await acknowledge(f.normal[0]);
  const explicit = f.writer.save(record(3), { explicit: true });
  f.writer.flushKeepalive(record(4, { bookId: "B" }));
  assert.deepEqual(f.keepalive.slice(2).map(value => value.bookId), ["B"]);
  await acknowledge(f.normal[1]); await explicit;
});

test("an explicit stale receipt remains applied:false for the page to verify", async () => {
  const f = fixture();
  const confirmation = f.writer.save(record(1), { explicit: true });
  const stale = { progress: { chapterId: "A-1", catalogRevision: "rev-1", scrollRatio: 0.99, applied: false } };
  f.normal[0].resolve(stale);
  assert.equal(await confirmation, stale);
  assert.equal(f.results[0].data.progress.applied, false);
  assert.equal(f.results[0].record.explicit, true);
  assert.equal(f.settled.length, 1);
});
