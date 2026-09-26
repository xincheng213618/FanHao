import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createFileWorkflowService } from "../src/modules/fanhao/server/workflows/file-workflow-service.js";
import { routeFileWorkflows } from "../src/modules/fanhao/server/workflows/routes.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temporary = createVerifiedTempDir("fanhao-file-workflows-");
const root = temporary.tempDir;
const source = path.join(root, "incoming"), target = path.join(root, "organized"), state = path.join(root, "state");
fs.mkdirSync(source); fs.mkdirSync(target);
const indexed = [];
const service = createFileWorkflowService({ dataDir: state, roots: [source, target], indexedPaths: () => indexed });
const write = (name, data) => { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
async function settle(id, owner = service) {
  for (let i = 0; i < 200; i++) { const job = owner.detail(id); if (!["running", "stopping"].includes(job.status)) return job; await delay(20); }
  throw new Error("Workflow did not settle");
}
try {
  write("ABC-123-U.mp4", "fixture-video");
  write("XYZ-456/part.mp4", "unfinished"); write("XYZ-456/part.mp4.aria2", "download-marker");
  write("readme.txt", "unrecognized");
  const indexedFile = write("DEF-222.mp4", "indexed"); indexed.push(indexedFile);
  const preview = await service.preview({ kind: "organize", source, target });
  assert.equal(preview.totalFiles, 1);
  assert.equal(preview.skippedFiles, 4);
  assert.equal(fs.readdirSync(target).length, 0, "preview must not write media");
  assert(fs.existsSync(path.join(source, "ABC-123-U.mp4")));
  service.run(preview.id); service.run(preview.id);
  const completed = await settle(preview.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completedFiles, 1);
  assert.equal(fs.readFileSync(path.join(target, "ABC-123", "ABC-123-U.mp4"), "utf8"), "fixture-video");
  assert(!fs.existsSync(path.join(source, "ABC-123-U.mp4")));
  assert(fs.existsSync(indexedFile));
  assert.equal(service.run(preview.id).status, "completed", "completed commands are idempotent");

  const drift = write("GHI-789.mp4", "before");
  const driftPlan = await service.preview({ kind: "organize", source, target });
  fs.appendFileSync(drift, " changed");
  service.run(driftPlan.id);
  assert.equal((await settle(driftPlan.id)).status, "blocked");
  assert(fs.existsSync(drift), "source drift must never remove the source");

  const conflictPlan = await service.preview({ kind: "organize", source, target });
  const conflict = path.join(target, "GHI-789", "GHI-789.mp4");
  fs.mkdirSync(path.dirname(conflict), { recursive: true }); fs.writeFileSync(conflict, "existing");
  service.run(conflictPlan.id);
  assert.equal((await settle(conflictPlan.id)).status, "blocked");
  assert.equal(fs.readFileSync(conflict, "utf8"), "existing");
  assert(fs.existsSync(drift));

  await assert.rejects(service.preview({ kind: "migrate", source, target: source }), /包含/);
  await assert.rejects(service.preview({ kind: "migrate", source, target: path.join(root, "outside") }), /允许/);
  const restored = createFileWorkflowService({ dataDir: state, roots: [source, target] });
  assert.equal(restored.detail(preview.id).status, "completed");
  assert(restored.list().length >= 3);
  await restored.close();

  let forbidden = false, status = 0;
  await routeFileWorkflows({ method: "POST" }, {}, new URL("http://fixture/api/fanhao/file-workflows/preview"), {
    service: { preview() { throw new Error("must not be called"); } },
    requireLocalAdmin() { forbidden = true; return false; }, readJsonBody() { throw new Error("must not read body"); }, sendJson() {}
  });
  assert(forbidden, "all workflow routes require local administration");
  await routeFileWorkflows({ method: "DELETE" }, {}, new URL(`http://fixture/api/fanhao/file-workflows/${preview.id}`), {
    service, requireLocalAdmin: () => true, sendJson(_res, code) { status = code; }
  });
  assert.equal(status, 405);
  await assert.rejects(service.preview({ kind: "migrate", source: {}, target }), /完整路径/);
  for (const phase of ["copying", "copied", "published", "source-removed", "done"]) await verifyRecovery(phase);
  await verifyStopAndLocks();
  await verifyLinkedPaths();
  verifyCliIndexedGuard();
  console.log("file-workflows: preview, verified move, conflict, drift, indexed guard, authorization, crash recovery, pause/resume and lock exclusion passed");
} finally {
  await service.close();
  temporary.cleanup();
}

async function verifyLinkedPaths() {
  const fixture = path.join(root, "links"), incoming = path.join(fixture, "incoming"), destination = path.join(fixture, "destination"), alias = path.join(fixture, "alias");
  fs.mkdirSync(incoming, { recursive: true }); fs.mkdirSync(destination);
  const file = path.join(incoming, "ABC-123.mp4"); fs.writeFileSync(file, "indexed-real-path");
  fs.symlinkSync(incoming, alias, process.platform === "win32" ? "junction" : "dir");
  const owner = createFileWorkflowService({ dataDir: path.join(fixture, "state"), roots: [alias, destination], indexedPaths: () => [file] });
  try {
    const plan = await owner.preview({ kind: "migrate", source: alias, target: destination });
    assert.equal(plan.totalFiles, 0, "a root alias must not bypass the indexed-file guard");
    assert(plan.items[0].reason.includes("已入库"));
  } finally { await owner.close(); fs.unlinkSync(alias); }
}

function verifyCliIndexedGuard() {
  const fixture = path.join(root, "cli"), incoming = path.join(fixture, "incoming"), destination = path.join(fixture, "destination"), data = path.join(fixture, "state");
  fs.mkdirSync(incoming, { recursive: true }); fs.mkdirSync(destination);
  const file = path.join(incoming, "ABC-123.mp4"); fs.writeFileSync(file, "indexed-cli-fixture");
  const database = path.join(fixture, "core.sqlite"), db = new DatabaseSync(database);
  db.exec("CREATE TABLE local_files(file_path TEXT)"); db.prepare("INSERT INTO local_files VALUES (?)").run(file); db.close();
  const cli = fileURLToPath(new URL("./fanhao_file_workflows.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [cli, "--data-dir", data, "--core-db", database, "--root", incoming, "--root", destination, "--source", incoming, "--target", destination], { encoding: "utf8", windowsHide: true });
  assert.equal(JSON.parse(output).totalFiles, 0); assert(fs.existsSync(file));
}

async function verifyRecovery(phase) {
  const fixture = path.join(root, phase), incoming = path.join(fixture, "incoming"), destination = path.join(fixture, "destination"), dataDir = path.join(fixture, "state");
  fs.mkdirSync(incoming, { recursive: true }); fs.mkdirSync(destination);
  const file = path.join(incoming, "fixture.txt"); fs.writeFileSync(file, "recovery-fixture");
  const options = { dataDir, roots: [incoming, destination] };
  const planner = createFileWorkflowService(options);
  const plan = await planner.preview({ kind: "migrate", source: incoming, target: destination }); await planner.close();
  const journal = path.join(dataDir, "file-workflows", `${plan.id}.json`);
  const job = JSON.parse(fs.readFileSync(journal, "utf8")), item = job.items[0];
  const temporaryFile = `${item.target}.fanhao-${plan.id}-0.partial`;
  fs.copyFileSync(file, temporaryFile);
  item.hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  item.phase = phase === "source-removed" ? "published" : phase;
  if (phase !== "copying") fs.linkSync(temporaryFile, item.target);
  if (["source-removed", "done"].includes(phase)) fs.unlinkSync(file);
  job.status = "running"; fs.writeFileSync(journal, JSON.stringify(job));
  const recovered = createFileWorkflowService(options);
  try {
    assert.equal(recovered.detail(plan.id).status, "interrupted");
    recovered.run(plan.id);
    assert.equal((await settle(plan.id, recovered)).status, "completed", phase);
    assert.equal(fs.readFileSync(item.target, "utf8"), "recovery-fixture");
    assert(!fs.existsSync(file)); assert(!fs.existsSync(temporaryFile), `${phase} must clean its publication link`);
  } finally { await recovered.close(); }
}

async function verifyStopAndLocks() {
  const fixture = path.join(root, "pause"), incoming = path.join(fixture, "incoming"), destination = path.join(fixture, "destination"), dataDir = path.join(fixture, "state");
  fs.mkdirSync(incoming, { recursive: true }); fs.mkdirSync(destination);
  for (const name of ["one.txt", "two.txt"]) fs.writeFileSync(path.join(incoming, name), "pause-fixture");
  const indexedNow = [];
  const options = { dataDir, roots: [incoming, destination], indexedPaths: () => indexedNow };
  const first = createFileWorkflowService(options), second = createFileWorkflowService(options);
  try {
    const planning = first.preview({ kind: "migrate", source: incoming, target: destination });
    await assert.rejects(first.preview({ kind: "migrate", source: incoming, target: destination }), /已有任务/);
    const plan = await planning;
    first.run(plan.id); assert.throws(() => second.run(plan.id), /另一个服务/);
    first.stop(plan.id);
    const stopped = await settle(plan.id, first);
    assert.equal(stopped.status, "interrupted"); assert(stopped.completedFiles <= 1);
    const remaining = stopped.items.find((item) => item.phase !== "done"); indexedNow.push(remaining.source);
    first.run(plan.id); assert.equal((await settle(plan.id, first)).status, "blocked");
    assert(fs.existsSync(remaining.source), "newly indexed source must be kept"); indexedNow.length = 0;
    first.run(plan.id); assert.equal((await settle(plan.id, first)).status, "completed");
  } finally { await first.close(); await second.close(); }
}
