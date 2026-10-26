import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { buildTasteProfile } from "../src/modules/fanhao/server/taste/profile.js";
import { analyzeTasteDatabase, readTasteWorks } from "../src/modules/fanhao/server/taste/source.js";
import { createTasteService } from "../src/modules/fanhao/server/taste/service.js";
import { createTasteRuntime } from "../src/modules/fanhao/server/taste/runtime.js";
import { seedTasteLibrary } from "./fixtures/taste-library.mjs";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temporary = createVerifiedTempDir("fanhao-taste-");
const directory = fs.realpathSync(temporary.tempDir);
const file = path.join(directory, "library.sqlite");
try {
  seedTasteLibrary(file);
  const before = fs.readFileSync(file);
  const profile = analyzeTasteDatabase(file);
  assert.deepEqual(fs.readFileSync(file), before, "analysis must not rewrite the database");
  assert.deepEqual(profile.summary, { total: 30, marked: 6, markedRate: .2, indexedRows: 31, duplicateRows: 1 });
  const people = profile.dimensions.find((dimension) => dimension.key === "people");
  assert.equal(people.favorites.length, 1);
  assert.equal(people.favorites[0].name, "收藏人物甲", "cast co-occurrence must not be interpreted as a chosen collection person");
  assert.equal(people.favorites[0].marked, 6, "redirects and duplicate editions must contribute once");
  const tags = profile.dimensions.find((dimension) => dimension.key === "tags");
  assert(tags.distinctive.some((row) => row.name === "眼镜" && row.marked === 6));
  assert(!tags.favorites.some((row) => ["含磁鏈", "4K"].includes(row.name)));
  assert.deepEqual(profile.dimensions.find((dimension) => dimension.key === "series").favorites.map((row) => row.name), ["系列甲"]);
  assert.deepEqual(profile.dimensions.find((dimension) => dimension.key === "prefixes").favorites.map((row) => row.name), ["ABC"]);
  assert(profile.recommendations.length && profile.recommendations.every((row) => Number(row.id) > 6));
  assert(profile.recommendations.every((row) => row.reasons.length));

  const db = new DatabaseSync(file);
  db.prepare("UPDATE local_works SET local_path = ? WHERE id = 7").run("X:\\[A]\\演员甲\\ABC-007");
  assert.equal(readTasteWorks(db).find((row) => row.id === 7).marked, false, "an ancestor [A] storage root is not a work rating");
  db.prepare("UPDATE local_works SET local_path = ? WHERE id = 8").run("Z:\\新位置\\收藏人物甲\\ABC-008");
  assert.equal(readTasteWorks(db).find((row) => row.id === 8).people[0].name, "收藏人物甲", "a unique exact directory name can preserve ownership after relocation");
  db.exec("ALTER TABLE works DROP COLUMN raw_text");
  assert.equal(readTasteWorks(db).length, 31, "older core schemas without optional raw text remain readable");
  db.close();

  const partial = buildTasteProfile([
    ...Array.from({ length: 10 }, (_, id) => ({ id, marked: id < 2, tags: ["共同标签"] })),
    ...Array.from({ length: 90 }, (_, n) => ({ id: n + 10, marked: false, tags: [] }))
  ]);
  const partialTags = partial.dimensions.find((dimension) => dimension.key === "tags");
  assert.equal(partialTags.known, 10);
  assert.equal(partialTags.baselineRate, .2, "missing metadata must not dilute the dimension denominator");
  assert.equal(partialTags.favorites[0].lift, 1);
  assert.equal(partialTags.distinctive.length, 0);
  assert.equal(buildTasteProfile([]).summary.total, 0);
  assert.equal(buildTasteProfile([{ id: 1, marked: false, tags: ["眼镜"] }]).recommendations.length, 0);
  const rare = buildTasteProfile(Array.from({ length: 30 }, (_, id) => ({ id, marked: id < 6, tags: [id === 0 ? "偶然" : "常见"] })));
  assert(!rare.dimensions.find((dimension) => dimension.key === "tags").distinctive.some((row) => row.name === "偶然"));

  let starts = 0;
  const service = createTasteService({ dbPath: file, workerFactory: (options) => {
    starts++; return new Worker(new URL("../src/modules/fanhao/server/taste/worker.js", import.meta.url), options);
  } });
  try {
    const [first, second] = await Promise.all([service.profile(), service.profile()]);
    assert.deepEqual(first, second); assert.equal(starts, 1, "concurrent requests must share the same worker");
    await service.profile(); assert.equal(starts, 1, "unchanged sources must reuse the bounded cache");
    const writer = new DatabaseSync(file);
    writer.prepare("UPDATE local_works SET local_path = ? WHERE id = 9").run("X:\\演员甲\\[A].ABC-009"); writer.close();
    assert.equal((await service.profile()).summary.marked, 7, "index changes must invalidate the cache");
    assert.equal(starts, 2);
  } finally { await service.stop(); }
  await assert.rejects(service.profile(), { statusCode: 503 });

  let cancelled = 0;
  const hung = createTasteService({ dbPath: file, timeoutMs: 10, workerFactory: () => {
    const worker = new EventEmitter(); worker.terminate = async () => { cancelled++; return 0; }; return worker;
  } });
  await assert.rejects(hung.profile(), { statusCode: 503 });
  assert.equal(cancelled, 1); await hung.stop();
  const stoppable = createTasteService({ dbPath: file, workerFactory: () => {
    const worker = new EventEmitter(); worker.terminate = async () => 0; return worker;
  } });
  const interrupted = stoppable.profile();
  const rejected = assert.rejects(interrupted, { statusCode: 503 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await stoppable.stop(); await rejected;

  let allowed = false, calls = 0, response;
  const runtime = createTasteRuntime({ dbPath: file, requireLocalAdmin: () => allowed,
    sendJson: (_res, status, body) => { response = { status, body }; },
    service: { profile: async () => { calls++; return profile; }, beginStop() {}, async stop() {} } });
  const req = { method: "GET" }, res = { setHeader() {} }, url = new URL("http://local/api/fanhao/taste");
  assert.equal(await runtime.routeApi(req, res, url), true); assert.equal(calls, 0);
  allowed = true; await runtime.routeApi(req, res, url); assert.equal(response.status, 200); assert.equal(calls, 1);
  await runtime.routeApi({ method: "POST" }, res, url); assert.equal(response.status, 405); assert.equal(calls, 1);
  assert.equal(await runtime.routeApi(req, res, new URL("http://local/api/other")), false);
  console.log("Taste analysis behavior checks passed: grain, coverage, ownership, evidence, read-only source, worker lifecycle and access boundary.");
} finally { temporary.cleanup(); }
