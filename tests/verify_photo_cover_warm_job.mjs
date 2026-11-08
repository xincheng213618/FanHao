import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPhotoCoverWarmJob } from "../src/modules/photos/server/photo-cover-warm-job.js";
import { routePhotosApi } from "../src/modules/photos/server/routes.js";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE photo_cover_warm_job (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
const started = [];
const firstBatch = Promise.withResolvers();
const shutdownBatch = Promise.withResolvers();
const plan = [
  { title: "第一辑", albums: ["a", "b", "c"] },
  { title: "第二辑", albums: ["d", "e"] }
];
const config = {
  getDb: () => db,
  buildPlan: () => plan,
  async warmCover(id, signal) {
    started.push(id);
    if (id === "a" || id === "b") await firstBatch.promise;
    if (id === "d") {
      shutdownBatch.resolve();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    }
    return { a: "cached", b: "generated", c: "skipped", d: "generated", e: "missing" }[id];
  }
};
const first = createPhotoCoverWarmJob(config);

async function request(job, action = "", allowed = true) {
  let result;
  const url = new URL(`http://fixture/api/photo-cover-warm${action ? `/${action}` : ""}`);
  const handled = await routePhotosApi({ method: action ? "POST" : "GET" }, {}, url, {
    coverWarmJob: job,
    requireLocalAdmin: () => allowed,
    sendJson: (_res, status, payload) => {
      assert.equal(status, 200);
      result = payload;
    }
  });
  assert.equal(handled, true);
  return result;
}

try {
  assert.equal(await request(first, "start", false), undefined);
  assert.deepEqual(await request(first), { status: "idle" });
  const running = await request(first, "start");
  assert.equal(running.total, 5);
  assert.equal(running.collection.title, "第一辑");
  assert.equal((await request(first, "start")).status, "running");
  assert.deepEqual(started, ["a", "b"], "starting twice must not dispatch another batch");
  const pausing = await request(first, "pause");
  assert.equal(pausing.status, "pausing");
  assert.equal(pausing.done, 0);
  assert.equal((await request(first, "resume")).status, "pausing");
  firstBatch.resolve();
  await first.stop();
  assert.deepEqual(started, ["a", "b"], "pause drains only the already dispatched batch");

  const reopened = createPhotoCoverWarmJob(config);
  const paused = await request(reopened);
  assert.equal(paused.status, "paused");
  assert.equal(paused.done, 2);
  assert.equal(paused.remaining, 3);
  assert.deepEqual(paused.collection, { title: "第一辑", index: 1, done: 2, total: 3 });
  await request(reopened, "resume");
  await shutdownBatch.promise;
  reopened.beginStop();
  await reopened.stop();

  const afterShutdown = createPhotoCoverWarmJob({ ...config, warmCover: async id => {
    started.push(id);
    return id === "d" ? "generated" : "missing";
  } });
  const interrupted = await request(afterShutdown);
  assert.equal(interrupted.status, "paused");
  assert.equal(interrupted.done, 3);
  assert.equal(interrupted.collection.title, "第二辑");
  await request(afterShutdown, "resume");
  await afterShutdown.stop();
  const complete = await request(afterShutdown);
  assert.equal(complete.status, "complete");
  assert.equal(complete.done, 5);
  assert.equal(complete.remaining, 0);
  assert.deepEqual(complete.counts, { cached: 1, generated: 2, skipped: 1, missing: 1, failed: 0 });
  assert.deepEqual(started, ["a", "b", "c", "d", "e", "d", "e"]);
  console.log("Photo cover warm job passed (admin access, pause, resume, checkpoint and restart)");
} finally {
  firstBatch.resolve();
  db.close();
}
