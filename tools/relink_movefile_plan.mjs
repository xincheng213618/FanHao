import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createPersonFolderMutationService } from "../src/modules/fanhao/server/people/person-folder-mutation-service.js";
import { canonicalPersonId, personLocations } from "../src/modules/fanhao/server/people/person-identity.js";

const planPath = path.resolve(process.argv[process.argv.indexOf("--plan") + 1]);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8").replace(/^\uFEFF/, ""));
assert.equal(plan.version, 1);
const stateRoot = path.join(path.dirname(planPath), plan.id + ".state");
assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, "status.json"), "utf8").replace(/^\uFEFF/, "")).state, "completed");
const db = new DatabaseSync(plan.dbPath);
db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
const imageDb = path.join(path.dirname(plan.dbPath), "fanhao-core-images.sqlite");
assert.ok(fs.existsSync(imageDb), "An initialized image database is required");
db.prepare("ATTACH DATABASE ? AS fanhao_images").run(imageDb);
const normalized = value => path.resolve(value).toLowerCase();
const within = (value, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const approved = plan.tasks.flatMap(task => [task.source, task.target]);
const service = createPersonFolderMutationService({
  hasCoreDb: () => true, getCoreDb: () => db,
  ensureLibraryDirectoryPath: value => {
    assert.ok(approved.some(root => within(value, root)), "Metadata path is outside the verified plan");
    return path.resolve(value);
  },
  relativeFromRoot: value => value.replaceAll("\\", "/"),
  sourcePathToAbsolute: value => value ? path.resolve(value) : "",
  resolveLibraryPersonByPublicId: id => {
    const row = db.prepare("SELECT id,folder_path FROM people WHERE id=?").get(Number(id));
    return row ? { id: String(row.id), relativePath: row.folder_path, sourcePaths: personLocations(db, id).map(location => location.path) } : null;
  }
});
const results = [];
function relink(personId, source, target) {
  assert.ok(!fs.existsSync(source), `Source still exists: ${source}`);
  assert.ok(fs.statSync(target).isDirectory());
  const receipt = db.prepare("SELECT operation_id FROM person_folder_operations WHERE person_id=? AND source_path=? AND target_path=? AND status='completed' ORDER BY created_at DESC LIMIT 1").get(String(personId), source, target);
  if (receipt) return { personId, source, target, alreadyApplied: true, operationId: receipt.operation_id };
  return { personId, source, target, ...service.relinkPersonFolder({ personId, sourcePath: source, targetPath: target }) };
}
try {
  // Initialize the existing operation schema before looking up receipts.
  for (const id of new Set(plan.tasks.map(task => String(task.personId)))) service.recoverPendingOperations({ personId: id });
  for (const task of plan.tasks) {
    assert.equal(canonicalPersonId(db, task.personId), String(task.personId), "Person identity changed during the move");
    assert.equal(normalized(fs.realpathSync.native(task.target)), normalized(task.targetPhysical), "Target physical identity changed");
    for (const unit of task.units) if (unit.indexed) results.push(relink(task.personId, unit.source, unit.target));
    const locations = personLocations(db, task.personId);
    const row = db.prepare("SELECT folder_path FROM people WHERE id=?").get(task.personId);
    if (locations.some(location => normalized(location.path) === normalized(task.source)) || (row.folder_path && normalized(row.folder_path) === normalized(task.source))) {
      results.push(relink(task.personId, task.source, task.target));
    }
    // Repair a missing former primary directory only when its persisted
    // registration belongs to this same person and a formal target is verified.
    const primary = db.prepare("SELECT folder_path FROM people WHERE id=?").get(task.personId)?.folder_path;
    if (task.kind === "normal" && primary && !fs.existsSync(primary) && personLocations(db, task.personId).some(location => normalized(location.path) === normalized(primary))) {
      approved.push(primary);
      results.push(relink(task.personId, primary, task.target));
    }
    fs.writeFileSync(path.join(stateRoot, "metadata-results.json"), JSON.stringify(results, null, 2));
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
} finally { db.close(); }

const incomingTargets = [...new Set(plan.tasks.filter(task => task.units.some(unit => !unit.indexed)).map(task => task.target))];
if (incomingTargets.length) {
  const args = [path.join(import.meta.dirname, "import_movefile_plan.py"), "--plan", planPath];
  const scan = spawnSync("python", args, { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1", FANHAO_CORE_IMAGE_DB: imageDb } });
  fs.writeFileSync(path.join(stateRoot, "import.log"), (scan.stdout || "") + (scan.stderr || ""));
  assert.equal(scan.status, 0, "Directed local import failed; see import.log");
  const infoArgs = [path.join(import.meta.dirname, "sync_core_info_metadata.mjs"), "--db", plan.dbPath, "--write"];
  for (const task of plan.tasks) for (const unit of task.units) if (!unit.indexed && unit.directory) infoArgs.push("--person-dir", unit.target);
  const metadata = spawnSync("node", infoArgs, { encoding: "utf8" });
  fs.writeFileSync(path.join(stateRoot, "import-metadata.log"), (metadata.stdout || "") + (metadata.stderr || ""));
  assert.equal(metadata.status, 0, "Imported info metadata synchronization failed");
}
const response = await fetch("http://127.0.0.1:29998/api/rescan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
assert.ok(response.ok, "Library reload failed after metadata commit");
fs.writeFileSync(path.join(stateRoot, "library-refresh.json"), JSON.stringify(await response.json(), null, 2));
fs.writeFileSync(path.join(stateRoot, "completed.json"), JSON.stringify({ state: "completed", relocatedUnits: results.length, importedDirectories: incomingTargets, finishedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ completed: true, relocatedUnits: results.length, importedDirectories: incomingTargets }));
