import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createNovelCollectionService } from "../src/modules/novels/server/collection-service.js";
import { createNovelCollectionStore } from "../src/modules/novels/server/collection-store.js";
import { createNovelCollectionWorkerClient } from "../src/modules/novels/server/collection-worker-client.js";
import { createNovelsRuntime } from "../src/modules/novels/server/runtime.js";
import { routeNovelApi } from "../src/modules/novels/server/routes.js";

// Baseline fixture: all stores and the write-lock holder use synthetic data.
// The optimized cases spawn controlled Node children and random-loopback HTTP.
// No Python, real application service, real data/credentials or online fetch.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-collection-worker-"));
const dbPath = path.join(temporary, "collection.sqlite");
const service = createNovelCollectionService({
  dbPath, outputRoot: path.join(temporary, "jobs"), projectRoot: path.resolve(import.meta.dirname, ".."),
  novelStore: { importCollectedBook() { assert.fail("baseline must not dispatch a collector import"); } }
});
const store = createNovelCollectionStore({ dbPath });
const adapterBody = { name: "synthetic adapter", matchHosts: ["fixture.invalid"], config: { contentSelector: ".body" } };
const observed = [];
let lockHolder;

try {
  const adapter = service.createAdapter(adapterBody).adapter;
  const task = service.createTask({ url: "https://fixture.invalid/book", adapterId: adapter.id, mode: "test" }).task;
  for (const [name, mutate] of [
    ["adapter", () => service.createAdapter({ ...adapterBody, name: "locked adapter" })],
    ["task", () => service.createTask({ url: "https://fixture.invalid/second", adapterId: adapter.id, mode: "test" })],
    ["progress", () => store.updateProgress(task.id, { current: 1, total: 2, message: "synthetic progress" })]
  ]) {
    lockHolder = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.dbPath);
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      setTimeout(() => { db.exec('ROLLBACK'); db.close(); parentPort.close(); }, 250);
    `, { eval: true, workerData: { dbPath } });
    await new Promise((resolve, reject) => {
      lockHolder.once("message", resolve);
      lockHolder.once("error", reject);
    });
    let timerRan = false;
    const start = performance.now();
    const timerDone = new Promise((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 10));
    mutate();
    const elapsed = performance.now() - start;
    assert.equal(timerRan, false, `${name}: synchronous SQLite blocked the health/timer turn`);
    assert.ok(elapsed >= 180, `${name}: fixture did not reproduce the held write lock (${elapsed}ms)`);
    await timerDone;
    assert.equal(timerRan, true, `${name}: overdue timer resumes only after the SQLite wait`);
    observed.push(`${name}=${Math.round(elapsed)}ms`);
    await lockHolder.terminate();
    lockHolder = null;
  }
  assert.equal(service.taskDetail(task.id).progressCurrent, 1);
  console.log(`novel-collection-worker baseline: synchronous adapter/task/progress lock blocks timer (${observed.join(", ")})`);
  await verifyWorkerLockAndReplacement();
  await verifyOwnedChildLifecycle();
  await verifyImportDrainAndRuntime();
  await verifyUnknownOutcome();
  await verifyUnconfirmedClose();
  await verifyShutdownRaces();
  await verifyRuntimeStartFence();
  await verifyProbeOutputBound();
  await verifyImportUnknownReload();
  await verifyResultBudget();
  await verifyDurableImportIntent();
  await verifyCollectorOutputBound();
  console.log("novel-collection-worker: lock/health, adapter/task/progress/checkpoint, bounds, replacement, real child close, stop/start, import drain, runtime/routes, unknown outcome and fail-closed passed");
} finally {
  if (lockHolder) await lockHolder.terminate();
  await service.stop();
  store.close();
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("fanhao-collection-worker-"));
  removeOwnedTree(resolved);
}

function clientOptions(name, extra = {}) {
  const root = path.join(temporary, name);
  fs.mkdirSync(root, { recursive: true });
  return { dbPath: path.join(root, "collection.sqlite"), credentialRoot: path.join(root, "credentials"),
    outputRoot: path.join(root, "jobs"), projectRoot: process.cwd(),
    importCollectedBook() { assert.fail("test-mode collector must not import"); }, ...extra };
}
async function holdLock(file, milliseconds = 300) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.file);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); parentPort.close(); }, workerData.milliseconds);
  `, { eval: true, workerData: { file, milliseconds } });
  await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  return worker;
}
async function verifyWorkerLockAndReplacement() {
  const options = clientOptions("lock");
  const client = createNovelCollectionWorkerClient({ ...options, maxPending: 2, maxPendingBytes: 1024 });
  const server = http.createServer((_req, res) => { res.end("healthy"); });
  await listen(server);
  let holder;
  try {
    const adapter = (await client.createAdapter(adapterBody)).adapter;
    for (const [label, operation] of [
      ["adapter", () => client.updateAdapter(adapter.id, { ...adapterBody, name: "updated" })],
      ["task", () => client.createTask({ url: "https://fixture.invalid/lock", adapterId: adapter.id, mode: "test" })]
    ]) {
      holder = await holdLock(options.dbPath);
      let finished = false;
      const start = performance.now();
      const writing = operation().then((data) => { finished = true; return data; });
      const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      assert.equal(await health.text(), "healthy");
      assert.equal(finished, false, `${label}: health must finish while the DB write is waiting`);
      const healthMs = Math.round(performance.now() - start);
      await writing;
      assert.ok(performance.now() - start >= 180);
      console.log(`novel-collection-worker ${label}: health=${healthMs}ms while write lock waits`);
      await holder.terminate(); holder = null;
    }
    holder = await holdLock(options.dbPath);
    const first = client.createAdapter({ ...adapterBody, name: "capacity one" });
    const second = client.listAdapters();
    await assert.rejects(client.listTasks(), { code: "NOVEL_COLLECTION_QUEUE_FULL" });
    await assert.rejects(client.createAdapter({ ...adapterBody, description: "x".repeat(2048) }), { code: "NOVEL_COLLECTION_QUEUE_FULL" });
    const rejectedSecond = assert.rejects(second, { code: "NOVEL_COLLECTION_STOPPED" });
    const stopping = client.stop();
    await rejectedSecond;
    // A request already inside SQLite is allowed to finish its known outcome.
    await first; await stopping;
    await holder.terminate(); holder = null;
    await assert.rejects(client.listAdapters(), { code: "NOVEL_COLLECTION_STOPPED" });
    await client.start();
    assert.equal((await client.listAdapters()).adapters.some((item) => item.name === "capacity one"), true);
    await client.stop();

    const replacement = path.join(path.dirname(options.dbPath), "replacement.sqlite");
    const alternate = createNovelCollectionStore({ dbPath: replacement });
    const replacementAdapter = alternate.createAdapter({ ...adapterBody, name: "replacement identity" });
    alternate.close();
    // No running task in this case. Every RPC releases its connection before ack.
    const reader = createNovelCollectionWorkerClient(options);
    try {
      await reader.listAdapters();
      fs.renameSync(options.dbPath, options.dbPath + ".old");
      fs.renameSync(replacement, options.dbPath);
      const adapters = (await reader.listAdapters()).adapters;
      assert.equal(adapters.some((item) => item.id === replacementAdapter.id), true);
      assert.equal(adapters.some((item) => item.name === "capacity one"), false);
    } finally { await reader.stop(); }
  } finally { if (holder) await holder.terminate(); await client.stop(); await closeServer(server); }
}

// Actual ChildProcess handles live only in the parent. These scripts use fixture
// files as gates and never interpret/fetch the synthetic HTTPS task URL.
function childSource() { return String.raw`
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(process.argv[1]);
if (input.probe) { setTimeout(() => process.stdout.write('ok'), 20); }
else {
  const config = JSON.parse(fs.readFileSync(input.config, 'utf8'));
  process.stdout.write('fixture-ready\n');
  const timer = setInterval(() => {
    if (!fs.existsSync(input.gate)) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({event:'progress',current:1,total:2,message:'fixture progress'})+'\n');
    process.stdout.write(JSON.stringify({event:'checkpoint',saved:1,total:2,message:'fixture checkpoint'})+'\n');
    if (input.hold) { setInterval(() => {}, 1000); return; }
    const result={status:'ok', book:{title:'Synthetic collected book',sourceUrl:config.url,chapters:[{title:'Chapter',url:config.url+'/1',content:'Synthetic content for worker fixture.'}]}};
    fs.writeFileSync(input.result, JSON.stringify(result));
  }, 10);
}`; }
function controlledChildren({ hold = false, autoRelease = false } = {}) {
  const records = [];
  const spawnProcess = (_command, args, options) => {
    const probe = args.includes("-c");
    const result = args[args.indexOf("--result") + 1];
    const gate = probe ? "" : path.join(path.dirname(result), "fixture-go");
    const config = args[args.indexOf("--config") + 1];
    const child = spawn(process.execPath, ["-e", childSource(), JSON.stringify({ probe, result, gate, config, hold })], options);
    const record = { child, probe, gate, closed: false, ready: false, output: "" };
    records.push(record);
    child.stdout.on("data", (chunk) => { record.output += chunk.toString(); record.ready ||= record.output.includes("fixture-ready"); });
    child.stderr.on("data", (chunk) => { record.output += chunk.toString(); });
    child.once("close", (code) => { record.closed = true; record.code = code; });
    if (autoRelease && !probe) fs.writeFileSync(gate, "go");
    return child;
  };
  return { records, spawnProcess, runner: () => records.findLast((item) => !item.probe),
    assertClosed() { assert.equal(records.every((item) => item.closed), true, "all owned Node children must emit close before stop resolves"); } };
}
async function verifyOwnedChildLifecycle() {
  const controlled = controlledChildren({ hold: true });
  const options = clientOptions("progress", { spawnProcess: controlled.spawnProcess });
  const client = createNovelCollectionWorkerClient(options);
  let holder;
  try {
    const adapter = (await client.createAdapter(adapterBody)).adapter;
    const task = (await client.createTask({ url: "https://fixture.invalid/progress", adapterId: adapter.id, mode: "test" })).task;
    await client.start();
    await waitFor(() => { if (controlled.runner()?.closed) assert.fail(JSON.stringify(controlled.records.map(({ probe, output, code }) => ({ probe, output, code })))); return controlled.runner()?.ready; });
    // The background pump/quiet child must release SQLite without a read RPC.
    fs.renameSync(options.dbPath, options.dbPath + ".quiet");
    fs.renameSync(options.dbPath + ".quiet", options.dbPath);
    holder = await holdLock(options.dbPath, 450);
    fs.writeFileSync(controlled.runner().gate, "go");
    await waitFor(() => controlled.runner().output.includes('"event":"progress"'));
    let returned = false;
    const detail = client.taskDetail(task.id).then((data) => { returned = true; return data; });
    await delay(20);
    assert.equal(returned, false, "progress update owns the Worker write lock, rather than blocking the parent");
    assert.equal(client.diagnostics().children, 1);
    await detail;
    await holder.terminate(); holder = null;
    const progress = await client.taskDetail(task.id);
    assert.equal(progress.progressCurrent, 1); assert.equal(progress.checkpointCount, 1);
    await client.cancelTask(task.id);
    await waitFor(() => controlled.runner().closed);
    await waitForAsync(async () => (await client.taskDetail(task.id)).status === "cancelled");
    await client.runTask(task.id);
    await waitFor(() => controlled.records.filter((item) => !item.probe).length === 2 && controlled.runner().ready);
    const stopping = client.stop();
    await assert.rejects(client.createTask({ url: "https://fixture.invalid/late", adapterId: adapter.id }), { code: "NOVEL_COLLECTION_STOPPED" });
    await stopping; controlled.assertClosed();
    const persisted = createNovelCollectionStore({ dbPath: options.dbPath });
    const failed = persisted.getTask(task.id);
    assert.equal(failed.status, "failed");
    const stamp = JSON.stringify(failed); await delay(50);
    assert.equal(JSON.stringify(persisted.getTask(task.id)), stamp, "there must be no late child progress/write after stop");
    persisted.close();
    await client.start(); assert.equal((await client.runtimeStatus()).ready, true);
    await client.stop(); controlled.assertClosed();
  } finally { if (holder) await holder.terminate(); await client.stop(); }

  const owned = controlledChildren({ hold: true });
  const failing = createNovelCollectionWorkerClient(clientOptions("worker-exit", { spawnProcess: owned.spawnProcess,
    workerFactory: (_url, options) => new Worker(new URL("./fixtures/novel-collection-worker-fault.mjs", import.meta.url), { ...options, workerData: { ...options.workerData, fixtureFault: "exit-with-child" } }) }));
  try {
    const adapter = (await failing.createAdapter(adapterBody)).adapter;
    await failing.createTask({ url: "https://fixture.invalid/exit", adapterId: adapter.id, mode: "test" });
    const starting = failing.start();
    // start may acknowledge before the background pump asks for its runner.
    await starting.catch((error) => assert.equal(error.code, "NOVEL_COLLECTION_WORKER_UNAVAILABLE"));
    await waitFor(() => owned.records.some((item) => !item.probe));
    await waitFor(() => owned.records.every((item) => item.closed));
    await failing.stop(); owned.assertClosed();
  } finally { await failing.stop(); }
}

async function verifyImportDrainAndRuntime() {
  const controlled = controlledChildren({ autoRelease: true });
  const entered = deferred(), release = deferred();
  let imports = 0;
  const client = createNovelCollectionWorkerClient(clientOptions("import", { spawnProcess: controlled.spawnProcess,
    importCollectedBook: async () => { imports += 1; entered.resolve(); await release.promise; return { book: { id: "synthetic-book", title: "Synthetic collected book" } }; } }));
  let stopping;
  try {
    const adapter = (await client.createAdapter(adapterBody)).adapter;
    const task = (await client.createTask({ url: "https://fixture.invalid/import", adapterId: adapter.id, mode: "collect" })).task;
    await client.start(); await entered.promise;
    let stopped = false;
    stopping = client.stop().then(() => { stopped = true; });
    await delay(60); assert.equal(stopped, false, "stop must wait for the one dispatched import outcome");
    release.resolve(); await stopping; controlled.assertClosed();
    assert.equal(imports, 1);
    const persisted = createNovelCollectionStore({ dbPath: path.join(temporary, "import", "collection.sqlite") });
    assert.equal(persisted.getTask(task.id).bookId, "synthetic-book"); persisted.close();
  } finally { release.resolve(); await stopping; await client.stop(); }

  const runtimeChildren = controlledChildren({ autoRelease: true });
  const runtimeRoot = path.join(temporary, "runtime"); fs.mkdirSync(runtimeRoot);
  let body = adapterBody;
  const runtime = createNovelsRuntime({ dbPath: path.join(runtimeRoot, "novels.sqlite"), projectRoot: process.cwd(),
    readJsonBody: async () => body, sendJson: (res, status, data) => { res.status = status; res.data = data; },
    notFound: (res) => { res.status = 404; }, collectionServiceOptions: { spawnProcess: runtimeChildren.spawnProcess } });
  const route = async (method, pathname) => { const res = {}; assert.equal(await runtime.routeApi({ method }, res, new URL(`http://fixture${pathname}`)), true); return res; };
  try {
    await runtime.start();
    const adapter = await route("POST", "/api/novels/collection/adapters"); assert.equal(adapter.status, 201);
    body = { url: "https://fixture.invalid/runtime", adapterId: adapter.data.adapter.id, mode: "collect" };
    const created = await route("POST", "/api/novels/collection/tasks"); assert.equal(created.status, 201);
    await waitForAsync(async () => (await route("GET", `/api/novels/collection/tasks/${created.data.task.id}`)).data.task.status === "succeeded");
    const books = runtime.store.listBooks(new URL("http://fixture/api/novels"));
    assert.equal(books.books.length, 1); assert.equal(books.books[0].title, "Synthetic collected book");
    const adapters = await route("GET", "/api/novels/collection/adapters"); assert.ok(Array.isArray(adapters.data.adapters));
    const tasks = await route("GET", "/api/novels/collection/tasks"); assert.ok(Array.isArray(tasks.data.tasks));
    const snapshot = await route("GET", "/api/novels/collection"); assert.equal(snapshot.data.runtime.ready, true);
    assert.equal((await route("GET", "/api/novels/collection/tasks/missing")).status, 404);
    const disconnected = { destroyed: true };
    await runtime.routeApi({ method: "GET" }, disconnected, new URL("http://fixture/api/novels/collection"));
    assert.equal(disconnected.status, undefined);
    await runtime.beginStop();
    assert.equal((await route("POST", "/api/novels/collection/tasks")).status, 503);
    await runtime.stop(); runtimeChildren.assertClosed();
    await runtime.start(); assert.equal((await route("GET", "/api/novels/collection")).status, 200);
  } finally { await runtime.stop(); runtimeChildren.assertClosed(); }
}

async function verifyUnknownOutcome() {
  const options = clientOptions("unknown");
  let workers = 0;
  const client = createNovelCollectionWorkerClient({ ...options,
    workerFactory: (_url, opts) => { workers += 1; return new Worker(new URL("./fixtures/novel-collection-worker-fault.mjs", import.meta.url), { ...opts, workerData: { ...opts.workerData, fixtureFault: "commit-no-reply" } }); } });
  try {
    const adapter = (await client.createAdapter(adapterBody)).adapter;
    await assert.rejects(client.createTask({ url: "https://fixture.invalid/unknown", adapterId: adapter.id, mode: "test" }), (error) => error.code === "NOVEL_COLLECTION_OUTCOME_UNKNOWN" && error.outcome === "unknown" && Boolean(error.operationId));
    await assert.rejects(client.createTask({ url: "https://fixture.invalid/unknown", adapterId: adapter.id }), { code: "NOVEL_COLLECTION_STOPPED" });
    assert.equal(workers, 1, "a dispatched mutation must not be automatically replayed on a replacement Worker");
    await client.stop();
    const persisted = createNovelCollectionStore({ dbPath: options.dbPath });
    assert.equal(persisted.listTasks().length, 1, "the committed task exists once despite the missing reply"); persisted.close();
  } finally { await client.stop(); }
}

async function verifyUnconfirmedClose() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = 0, terminated = 0, generation;
  child.kill = () => { killed += 1; return true; };
  const worker = new EventEmitter();
  worker.postMessage = (message) => {
    if (message.type === "request") queueMicrotask(() => {
      if (message.method === "start") worker.emit("message", { type: "child-spawn", generation, id: 1, command: "fixture", args: [], options: {} });
      worker.emit("message", { type: "result", generation, id: message.id, ok: true });
    });
    if (message.type === "begin-stop") queueMicrotask(() => worker.emit("message", { type: "stopped", generation }));
  };
  worker.terminate = async () => { terminated += 1; worker.emit("exit", 0); };
  const client = createNovelCollectionWorkerClient(clientOptions("unconfirmed", { stopTimeoutMs: 30, spawnProcess: () => child,
    workerFactory: (_url, options) => { generation = options.workerData.generation; queueMicrotask(() => worker.emit("message", { type: "ready", generation })); return worker; } }));
  try {
    await client.start();
    await assert.rejects(client.stop(), { code: "NOVEL_COLLECTION_WORKER_UNAVAILABLE" });
    assert.equal(killed, 1); assert.equal(terminated, 0, "Worker termination cannot substitute for owned child close");
    assert.equal(client.diagnostics().children, 1);
    await assert.rejects(client.start(), { code: "NOVEL_COLLECTION_WORKER_UNAVAILABLE" });
    await assert.rejects(client.createTask({}), { code: "NOVEL_COLLECTION_STOPPED" });
  } finally { child.stdout.end(); child.stderr.end(); child.emit("close", null, "SIGKILL"); worker.emit("exit", 0); }
}
async function verifyShutdownRaces() {
  let generation, imports = 0, terminating = false, rejectedImport;
  const terminate = deferred();
  const worker = new EventEmitter();
  worker.postMessage = (message) => {
    if (message.type === "request") queueMicrotask(() => worker.emit("message", { type: "result", generation, id: message.id, ok: true }));
    if (message.type === "import-result" && message.id === 12) rejectedImport = message;
  };
  worker.terminate = () => { terminating = true; return terminate.promise; };
  const client = createNovelCollectionWorkerClient(clientOptions("late-import", {
    maxImportBytes: 32,
    importCollectedBook() { imports += 1; return Promise.resolve({ book: { id: "never" } }); },
    workerFactory: (_url, options) => { generation = options.workerData.generation; queueMicrotask(() => worker.emit("message", { type: "ready", generation })); return worker; }
  }));
  try {
    await client.start();
    worker.emit("message", { type: "import", generation: "prior-generation", id: 10, book: {} });
    worker.emit("message", { type: "child-spawn", generation: "prior-generation", id: 10, command: "must-not-spawn", args: [], options: {} });
    assert.equal(imports, 0); assert.equal(client.diagnostics().children, 0);
    worker.emit("message", { type: "import", generation, id: 12, book: { title: "x".repeat(64) } });
    assert.equal(rejectedImport.code, "NOVEL_COLLECTION_QUEUE_FULL"); assert.equal(imports, 0);
    worker.emit("message", { type: "worker-error", generation, error: "fixture failure", statusCode: 503 });
    await waitFor(() => terminating);
    worker.emit("message", { type: "import", generation, id: 11, book: {} });
    await delay(10); assert.equal(imports, 0, "late import after failure must never dispatch a new business write");
    let stopped = false;
    const stopping = client.stop().then(() => { stopped = true; });
    await delay(10); assert.equal(stopped, false);
    worker.emit("exit", 1); terminate.resolve(1); await stopping;
    assert.equal(imports, 0);
  } finally { worker.emit("exit", 1); terminate.resolve(1); await client.stop(); }

  let current, holdStop = true;
  const stopReady = deferred();
  const restart = createNovelCollectionWorkerClient(clientOptions("start-fence", {
    workerFactory: (_url, options) => {
      const ownedGeneration = options.workerData.generation;
      const fake = new EventEmitter(); current = fake;
      fake.postMessage = (message) => {
        if (message.type === "request") queueMicrotask(() => fake.emit("message", { type: "result", generation: ownedGeneration, id: message.id, ok: true }));
        if (message.type === "begin-stop") {
          const complete = () => fake.emit("message", { type: "stopped", generation: ownedGeneration });
          if (holdStop) void stopReady.promise.then(complete); else queueMicrotask(complete);
        }
        if (message.type === "close") queueMicrotask(() => fake.emit("exit", 0));
      };
      fake.terminate = async () => { fake.emit("exit", 0); return 0; };
      queueMicrotask(() => fake.emit("message", { type: "ready", generation: ownedGeneration }));
      return fake;
    }
  }));
  try {
    await restart.start();
    const stopping = restart.stop();
    const staleStart = assert.rejects(restart.start(), { code: "NOVEL_COLLECTION_STOPPED" });
    restart.beginStop(); stopReady.resolve(); await stopping; await staleStart;
    await assert.rejects(restart.snapshot(), { code: "NOVEL_COLLECTION_STOPPED" });
    holdStop = false; await restart.start(); await restart.stop();
  } finally { holdStop = false; stopReady.resolve(); current?.emit("exit", 0); await restart.stop(); }

  const unconfirmed = new EventEmitter(); let failedGeneration;
  unconfirmed.postMessage = (message) => {
    if (message.type === "request") queueMicrotask(() => unconfirmed.emit("message", { type: "result", generation: failedGeneration, id: message.id, ok: true }));
  };
  unconfirmed.terminate = () => Promise.reject(new Error("fixture terminate unavailable"));
  const failed = createNovelCollectionWorkerClient(clientOptions("terminate-fence", {
    workerFactory: (_url, options) => { failedGeneration = options.workerData.generation; queueMicrotask(() => unconfirmed.emit("message", { type: "ready", generation: failedGeneration })); return unconfirmed; }
  }));
  try {
    await failed.start();
    unconfirmed.emit("error", new Error("fixture Worker failure"));
    await assert.rejects(failed.stop());
    assert.equal(failed.diagnostics().exited, false);
    await assert.rejects(failed.start());
    await assert.rejects(failed.snapshot(), { code: "NOVEL_COLLECTION_STOPPED" });
  } finally { unconfirmed.emit("exit", 1); }
}
async function verifyRuntimeStartFence() {
  const root = path.join(temporary, "runtime-fence"); fs.mkdirSync(root);
  const workers = []; let automaticReady = false, collectionStarts = 0;
  const runtime = createNovelsRuntime({ dbPath: path.join(root, "novels.sqlite"), projectRoot: process.cwd(),
    readJsonBody: async () => ({}), sendJson() {}, notFound() {},
    collectionServiceFactory: () => ({ start: async () => { collectionStarts += 1; }, beginStop() {}, stop: async () => {} }),
    writeWorkerOptions: { workerFactory: () => {
      const worker = new EventEmitter(); workers.push(worker);
      worker.postMessage = () => {};
      worker.terminate = async () => { worker.emit("exit", 0); return 0; };
      if (automaticReady) queueMicrotask(() => worker.emit("message", { type: "ready", sourceRealm: "fixture" }));
      return worker;
    } }
  });
  try {
    const stale = assert.rejects(runtime.start(), (error) => error.statusCode === 503);
    await waitFor(() => workers.length === 1);
    await runtime.beginStop();
    workers[0].emit("message", { type: "ready", sourceRealm: "fixture" });
    await stale; assert.equal(collectionStarts, 0, "a stale runtime start must not reopen collection after beginStop");
    await runtime.stop();
    automaticReady = true;
    await runtime.start(); assert.equal(collectionStarts, 1);
  } finally { await runtime.stop(); }
}
async function verifyProbeOutputBound() {
  const records = [];
  const client = createNovelCollectionWorkerClient(clientOptions("probe-bound", {
    spawnProcess(_command, args, options) {
      assert.equal(args.includes("-c"), true);
      const child = spawn(process.execPath, ["-e", "for(let i=0;i<48;i++){process.stdout.write(Buffer.alloc(64*1024-1,120));process.stdout.write(String.fromCharCode(10));} setInterval(()=>{},1000);"], options);
      const record = { closed: false }; records.push(record);
      child.once("close", () => { record.closed = true; });
      return child;
    }
  }));
  try {
    await client.start();
    const runtime = await client.runtimeStatus();
    assert.equal(runtime.ready, false); assert.match(runtime.error, /探测输出过大/);
    assert.equal(records.every((item) => item.closed), true, "probe failure waits for the actual pipe/process close");
  } finally { await client.stop(); }
}
async function verifyImportUnknownReload() {
  const controlled = controlledChildren({ autoRelease: true });
  let imports = 0;
  let operationId;
  const options = clientOptions("import-unknown", { spawnProcess: controlled.spawnProcess,
    importCollectedBook: async (_book, operation) => {
      imports += 1;
      operationId = operation.operationId;
      assert.match(operationId, /^[0-9a-f-]{36}$/);
      throw Object.assign(new Error("synthetic import outcome unknown"), { code: "NOVEL_WRITE_OUTCOME_UNKNOWN", statusCode: 503, outcome: "unknown", operationId });
    }
  });
  let client = createNovelCollectionWorkerClient(options);
  try {
    const adapter = (await client.createAdapter(adapterBody)).adapter;
    const body = { url: "https://fixture.invalid/import-unknown", adapterId: adapter.id, mode: "collect" };
    const task = (await client.createTask(body)).task;
    await client.start();
    await waitForAsync(async () => (await client.taskDetail(task.id)).status === "failed");
    assert.equal((await client.taskDetail(task.id)).result.operationId, operationId);
    await client.stop(); controlled.assertClosed();
    client = createNovelCollectionWorkerClient(options);
    await client.start();
    const restored = await client.taskDetail(task.id);
    assert.deepEqual(restored.result, { outcome: "unknown", operationId, code: "NOVEL_WRITE_OUTCOME_UNKNOWN" });
    for (const pathname of [`/api/novels/collection/tasks/${task.id}/run`, "/api/novels/collection/tasks"]) {
      const res = {};
      await routeNovelApi({ method: "POST" }, res, new URL(`http://fixture${pathname}`), {
        collectionService: client, readJsonBody: async () => body,
        notFound: () => assert.fail("unknown result must be an explicit conflict"),
        sendJson: (target, status, data) => { target.status = status; target.data = data; }
      });
      assert.equal(res.status, 409); assert.equal(res.data.outcome, "unknown"); assert.equal(res.data.operationId, operationId);
    }
    assert.equal(imports, 1, "reload, run and task reuse must not replay an unknown import");
    assert.equal((await client.listTasks()).tasks.length, 1);
    await client.stop();
    const history = createNovelCollectionStore({ dbPath: options.dbPath });
    const newer = history.createTask(body); history.failTask(newer.id, "ordinary later failure");
    for (let i = 0; i < 205; i += 1) {
      const ordinary = history.createTask({ ...body, url: `https://fixture.invalid/history-${i}` });
      history.failTask(ordinary.id, "ordinary history");
    }
    assert.equal(history.getTask(task.id).result.operationId, operationId, "automatic history pruning must retain unknown intents");
    assert.equal(history.findReusableTask(body).id, task.id, "a newer ordinary task must not hide the unknown replay guard");
    assert.equal(history.listTasks().some((item) => item.id === task.id), true, "protected unknown tasks remain visible for existing management actions");
    history.close();
  } finally { await client.stop(); controlled.assertClosed(); }
}
async function verifyResultBudget() {
  const worker = new EventEmitter(); let generation, imports = 0, reply;
  worker.postMessage = (message) => {
    if (message.type === "request") queueMicrotask(() => worker.emit("message", { type: "result", generation, id: message.id, ok: true }));
    if (message.type === "import-result") reply = message;
    if (message.type === "begin-stop") queueMicrotask(() => worker.emit("message", { type: "stopped", generation }));
    if (message.type === "close") queueMicrotask(() => worker.emit("exit", 0));
  };
  worker.terminate = async () => { worker.emit("exit", 0); return 0; };
  const contentBytes = 96 * 1024 * 1024 - 1024;
  const client = createNovelCollectionWorkerClient(clientOptions("result-budget", {
    importCollectedBook: async (book) => { imports += 1; assert.equal(book.chapters[0].content.length, contentBytes); return { book: { id: "budget-book" } }; },
    workerFactory: (_url, options) => { generation = options.workerData.generation; queueMicrotask(() => worker.emit("message", { type: "ready", generation })); return worker; }
  }));
  try {
    await client.start();
    // Repeated ASCII uses a synthetic rope string. No huge file/real DB is read.
    worker.emit("message", { type: "import", generation, id: 1, book: { title: "budget", chapters: [{ content: "x".repeat(contentBytes) }] } });
    await waitFor(() => reply);
    assert.equal(reply.ok, true); assert.equal(imports, 1, "the 96 MiB UTF-8 result contract fits the default conservative byte budget");
  } finally { await client.stop(); }
}
async function verifyDurableImportIntent() {
  for (const fault of ["exit-on-import", "complete-fails", "known-rollback"]) {
    const controlled = controlledChildren({ autoRelease: true });
    let imports = 0, taskId, operationId;
    const options = clientOptions(`intent-${fault}`, { spawnProcess: controlled.spawnProcess,
      importCollectedBook: async (_book, operation) => {
        imports += 1; operationId = operation.operationId;
        const persisted = createNovelCollectionStore({ dbPath: options.dbPath });
        const intent = persisted.getTask(taskId).result; persisted.close();
        assert.equal(intent.outcome, "unknown"); assert.equal(intent.operationId, operationId, "intent must commit before business import dispatch");
        if (fault === "known-rollback") throw Object.assign(new Error("synthetic confirmed rollback"), { outcome: "not_committed", rollbackConfirmed: true });
        return { book: { id: "intent-book", title: "Synthetic collected book" } };
      }
    });
    let client = createNovelCollectionWorkerClient({ ...options,
      ...(fault === "exit-on-import" ? { workerFactory: (_url, opts) => new Worker(new URL("./fixtures/novel-collection-worker-fault.mjs", import.meta.url), { ...opts, workerData: { ...opts.workerData, fixtureFault: fault } }) } : {}) });
    try {
      const adapter = (await client.createAdapter(adapterBody)).adapter;
      const body = { url: `https://fixture.invalid/intent-${fault}`, adapterId: adapter.id, mode: "collect" };
      taskId = (await client.createTask(body)).task.id;
      if (fault === "complete-fails") {
        const db = new DatabaseSync(options.dbPath);
        db.exec("CREATE TRIGGER fixture_block_complete BEFORE UPDATE OF status ON novel_collection_tasks WHEN NEW.status='succeeded' BEGIN SELECT RAISE(FAIL,'synthetic completion failed'); END");
        db.close();
      }
      await client.start().catch((error) => assert.equal(error.code, "NOVEL_COLLECTION_WORKER_UNAVAILABLE"));
      await waitFor(() => imports === 1);
      if (fault === "exit-on-import") await waitFor(() => client.diagnostics().exited);
      else await waitForAsync(async () => (await client.taskDetail(taskId)).status === "failed");
      await client.stop(); controlled.assertClosed();
      client = createNovelCollectionWorkerClient(options);
      await client.start();
      const restored = await client.taskDetail(taskId);
      assert.equal(restored.status, "failed");
      if (fault === "known-rollback") assert.deepEqual(restored.result, {}, "only a definite not-committed result clears the intent");
      else {
        assert.equal(restored.result.outcome, "unknown"); assert.equal(restored.result.operationId, operationId);
        for (const action of [() => client.runTask(taskId), () => client.createTask(body)]) {
          await assert.rejects(action(), (error) => error.statusCode === 409 && error.outcome === "unknown" && error.operationId === operationId);
        }
        assert.equal(imports, 1, "Worker exit or failed completion must not replay a dispatched import after reload");
      }
    } finally { await client.stop(); controlled.assertClosed(); }
  }
}
async function verifyCollectorOutputBound() {
  const probes = controlledChildren();
  const runners = [];
  const client = createNovelCollectionWorkerClient(clientOptions("output-bound", {
    spawnProcess(command, args, options) {
      if (args.includes("-c")) return probes.spawnProcess(command, args, options);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const record = { child, killed: false, closed: false }; runners.push(record);
      child.kill = () => { record.killed = true; return true; };
      child.once("close", () => { record.closed = true; });
      void (async () => {
        for (let i = 0; i < 17; i += 1) {
          if (!child.stdout.write(Buffer.alloc(64 * 1024, 120))) await once(child.stdout, "drain");
        }
      })();
      return child;
    }
  }));
  const server = http.createServer((_req, res) => res.end("healthy")); await listen(server);
  let stopping;
  try {
    const adapter = (await client.createAdapter(adapterBody)).adapter;
    const first = (await client.createTask({ url: "https://fixture.invalid/long-first", adapterId: adapter.id, mode: "test" })).task;
    await client.createTask({ url: "https://fixture.invalid/long-second", adapterId: adapter.id, mode: "test" });
    await client.start(); await waitFor(() => runners[0]?.killed);
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).text(), "healthy");
    await delay(30);
    assert.equal(runners.length, 1, "output overflow must not release the kernel slot before actual child close");
    assert.equal(client.diagnostics().children, 1);
    let stopped = false;
    stopping = client.stop().then(() => { stopped = true; });
    await delay(20); assert.equal(stopped, false);
    runners[0].child.stdout.end(); runners[0].child.stderr.end(); runners[0].child.emit("close", null, "SIGKILL");
    await stopping; assert.equal(runners.length, 1); assert.equal(runners[0].closed, true); probes.assertClosed();
    const persisted = createNovelCollectionStore({ dbPath: path.join(temporary, "output-bound", "collection.sqlite") });
    const failed = persisted.getTask(first.id); persisted.close();
    assert.equal(failed.status, "failed"); assert.match(failed.error, /单行输出超过 1 MiB/);
  } finally {
    for (const record of runners) if (!record.closed) { record.child.stdout.end(); record.child.stderr.end(); record.child.emit("close", null, "SIGKILL"); }
    await stopping; await client.stop(); await closeServer(server);
  }
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate) { for (let n = 0; !predicate(); n += 1) { assert.ok(n < 300, "controlled fixture phase timed out"); await delay(10); } }
async function waitForAsync(predicate) { for (let n = 0; !await predicate(); n += 1) { assert.ok(n < 300, "controlled async fixture phase timed out"); await delay(10); } }
async function listen(server) { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
async function closeServer(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
function removeOwnedTree(directory) {
  const root = fs.realpathSync(directory);
  assert.equal(path.dirname(root).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(root).startsWith("fanhao-collection-worker-"));
  if (process.platform === "win32") {
    const script = "$taskRoot=(Resolve-Path -LiteralPath $env:FANHAO_COLLECTION_FIXTURE_ROOT).Path; $taskTemp=(Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd([IO.Path]::DirectorySeparatorChar); if(([IO.Path]::GetDirectoryName($taskRoot) -ne $taskTemp) -or -not ([IO.Path]::GetFileName($taskRoot).StartsWith('fanhao-collection-worker-'))){throw 'fixture cleanup target rejected'}; Remove-Item -LiteralPath $taskRoot -Recurse -Force -ErrorAction Stop";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, encoding: "utf8", env: { ...process.env, FANHAO_COLLECTION_FIXTURE_ROOT: root }
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } else fs.rmSync(root, { recursive: true });
}
