import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";
import { createWorkMoveReservationService } from "../src/modules/fanhao/server/works/work-move-reservation-service.js";
import { createPersonOrganizationService, organizeGroup, reserveOrganizationPaths, releaseOrganizationPaths,
  organizationFolderName, publicPlan, saveOrganizationPlan, writeOrganizationSidecar, cleanupOrganizationSidecars, cleanupOrganizationWorkCovers, setOrganizationFolderReleaseDate } from "../src/modules/fanhao/server/people/person-organization-service.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";
import { createAdminMaintenanceTaskService } from "../src/modules/fanhao/server/admin/admin-maintenance-task-service.js";

const temporary = createVerifiedTempDir("fanhao-person-organization-");
const root = temporary.tempDir;
const source = path.join(root, "Person");
const dbPath = path.join(root, "fixture.sqlite");
const imageDbPath = path.join(root, "images.sqlite");
const stateDir = path.join(root, "state");
fs.mkdirSync(source);
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,title TEXT,updated_at TEXT,
  raw_text TEXT,fields_json TEXT,release_date TEXT,duration_minutes INTEGER,rating REAL,rating_count INTEGER,director TEXT);
  CREATE TABLE work_people(work_id INTEGER,person_id INTEGER);
  CREATE TABLE work_external_refs(work_id INTEGER,provider TEXT,url TEXT);
  CREATE TABLE local_works(id INTEGER PRIMARY KEY,work_id INTEGER,local_path TEXT,source_info_path TEXT,updated_at TEXT);
  CREATE TABLE local_files(id INTEGER PRIMARY KEY,local_work_id INTEGER,work_id INTEGER,file_path TEXT,file_type TEXT,relative_path TEXT,updated_at TEXT,name TEXT,size INTEGER,modified_at TEXT);
  CREATE TABLE video_probe_cache(file_path TEXT,updated_at TEXT);
  CREATE TABLE favorites(work_id INTEGER);
  CREATE TABLE progress(work_id INTEGER,position INTEGER);`);
attachCoreImageStore(db, { dbPath: imageDbPath });
createWorkMoveReservationService({ getCoreDb: () => db });
const person = { id: "1", name: "Person", sourcePaths: [source] };
const service = createPersonOrganizationService({ getCoreDb: () => db, resolvePerson: () => person,
  sourcePathToAbsolute: (p) => p, roots: [root], stateDir });
let fileId = 0;
function seed(id, code, title, directory, names) {
  fs.mkdirSync(directory, { recursive: true });
  db.prepare("INSERT INTO works(id,code,title,updated_at,raw_text) VALUES(?,?,?,'',?)")
    .run(id, code, title, `番号: ${code}\n标题: ${title}\n封面: https://c0.jdbstatic.com/covers/synthetic.jpg`);
  db.prepare("INSERT INTO work_people VALUES(?,1)").run(id);
  db.prepare("INSERT INTO local_works VALUES(?,?,?,'','')").run(id, id, directory);
  for (const name of names) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `synthetic:${name}`);
    const stat = fs.statSync(file);
    db.prepare("INSERT INTO local_files VALUES(?,?,?,?,?,?,'',?,?,?)").run(++fileId, id, id, file,
      name.endsWith(".mp4") ? "video" : name.endsWith(".txt") ? "info" : "image", file, path.basename(file), stat.size, stat.mtime.toISOString());
  }
}

try {
  seed(1, "ABC-123", "ABC-123 Synthetic", source, ["ABC-123-CD1-U.mp4", "ABC-123-CD2 TV 1730.mp4"]);
  seed(2, "DEF-456", "DEF-456 Nested", path.join(source, "Old DEF-456"),
    ["disc/DEF-456.mp4", "cover.jpg", "1def456pl.jpg", "synthetic.jpg", "scene.jpg", "poster.png", "info.txt"]);
  seed(3, "GHI-789", "GHI-789 Conflict", path.join(source, "Old GHI-789"), ["GHI-789.mp4"]);
  fs.mkdirSync(path.join(source, "GHI-789 Conflict"));
  seed(4, "JKL-111", "JKL-111 Pending", path.join(source, "JKL-111"), ["JKL-111.mp4", "download.aria2"]);
  seed(5, "MNO-222", "MNO-222 Mixed", path.join(source, "MNO-222"), ["MNO-222.mp4", "PQR-333.mp4"]);
  seed(7, "TABC-555", "TABC-555 Synthetic 生写真3枚付き", path.join(source, "TABC-555 Synthetic 生写真3枚付き"),
    ["ABC-555 Synthetic.mp4", "h_1681abc555pl.jpg"]);
  seed(8, "TDEF-556", "TDEF-556 Ordinary", path.join(source, "TDEF-556 Ordinary"), ["DEF-556.mp4"]);
  db.prepare("INSERT INTO works(id,code,title,updated_at,release_date) VALUES(9,'ABC-555','ABC-555 Synthetic','','2023-12-28')").run();
  db.prepare("INSERT INTO work_people VALUES(9,1)").run();
  db.prepare("UPDATE works SET release_date = '2024-01-05' WHERE id = 7").run();
  seed(10, "UVW-555", "[A].UVW-555 Marked VR", path.join(source, "UVW-555 [A].UVW-555 Marked VR"), ["UVW-555-1.mp4", "UVW-555-2.mp4", "cover.jpg", "info.txt"]);
  seed(11, "WXY-556", "WXY-556 Plain title", path.join(source, "[A].WXY-556 Legacy"), ["WXY-556.mp4"]);
  seed(12, "XYZ-557", "[A].XYZ-557 Title flag", path.join(source, "XYZ-557 Unmarked"), ["XYZ-557.mp4"]);
  db.prepare("DELETE FROM local_files WHERE file_path = ?").run(path.join(source, "MNO-222", "PQR-333.mp4"));
  fs.writeFileSync(path.join(source, "cover.jpg"), "person-cover");
  fs.writeFileSync(path.join(source, "info.txt"), "person-info");
  db.exec("INSERT INTO favorites VALUES(1);INSERT INTO progress VALUES(1,123)");
  const videoPath = path.join(source, "ABC-123-CD1-U.mp4");
  db.prepare("INSERT INTO video_probe_cache VALUES(?,'')").run(videoPath);
  db.prepare(`INSERT INTO fanhao_images.images(owner_type,owner_id,kind,source_type,local_path)
    VALUES('work',2,'cover','local',?)`).run(path.join(source, "Old DEF-456", "cover.jpg"));
  db.prepare(`INSERT INTO fanhao_images.images(owner_type,owner_id,kind,source_type,local_path)
    VALUES('work',2,'cover','local',?)`).run(path.join(source, "Old DEF-456", "synthetic.jpg"));
  db.prepare(`INSERT INTO fanhao_images.images(owner_type,owner_id,kind,source_type,local_path)
    VALUES('person',99,'portrait','local',?)`).run(path.join(source, "Old DEF-456", "poster.png"));

  assert.equal(organizationFolderName("ABC-123", "ABC-123 Synthetic.mp4"), "ABC-123 Synthetic");
  assert.equal(organizationFolderName("FC2-PPV-1234567", "FC2-1234567 Title"), "FC2-PPV-1234567 Title");
  assert.equal(organizationFolderName("FC2-PPV-1234567", "FC2 PPV 1234567 Title"), "FC2-PPV-1234567 Title");
  assert.equal(organizationFolderName("ABC-123", "A title mentioning ABC-123"), "ABC-123 A title mentioning ABC-123");
  assert.equal(organizationFolderName("TKWA-269", "491TKWA-269.mp4"), "TKWA-269");
  assert.equal(organizationFolderName("UVW-555", "[A].UVW-555 Marked VR"), "[A].UVW-555 Marked VR");
  assert.equal(organizationFolderName("UVW-555", "UVW-555 [A].UVW-555 Marked VR"), "[A].UVW-555 Marked VR");
  assert.equal(organizationFolderName("UVW-555", "[A] UVW-555 Marked VR.mp4"), "[A].UVW-555 Marked VR");
  assert.equal(organizationFolderName("XYZ-557", "[A].XYZ-557 Title flag", "XYZ-557 Unmarked"), "XYZ-557 Title flag");
  const preview = service.preview("1");
  assert.equal(preview.workCount, 6);
  assert.equal(preview.skipped.length, 4);
  assert(preview.groups.some((g) => g.code === "TABC-555"), "explicit bonus edition retains its indexed base video");
  assert(preview.skipped.some((g) => g.code === "TDEF-556"), "a prefix mismatch without edition evidence stays blocked");
  const editionVideo = path.join(source, "TABC-555 Synthetic 生写真3枚付き", "ABC-555 Synthetic.mp4");
  db.prepare("UPDATE local_files SET size = size + 1 WHERE file_path = ?").run(editionVideo);
  assert(service.preview("1").skipped.some((g) => g.code === "TABC-555"), "edition compatibility requires unchanged indexed video identity");
  db.prepare("UPDATE local_files SET size = size - 1 WHERE file_path = ?").run(editionVideo);
  const unindexedEditionVideo = path.join(path.dirname(editionVideo), "ABC-555 extra.mp4");
  fs.writeFileSync(unindexedEditionVideo, "synthetic-unindexed-video");
  assert(service.preview("1").skipped.some((g) => g.code === "TABC-555"), "an unindexed base-code video cannot use edition compatibility");
  fs.unlinkSync(unindexedEditionVideo);
  assert(fs.existsSync(videoPath), "preview never moves files");
  const plan = service.read(preview.id);
  assert.equal(plan.groups.find((g) => g.code === "TABC-555").obsoleteCovers.length, 1, "vendor-prefixed edition cover is recognized");
  assert.equal(path.basename(plan.groups.find((g) => g.workId === 10).target), "[A].UVW-555 Marked VR", "repair the duplicated prefix and preserve A");
  assert.equal(path.basename(plan.groups.find((g) => g.workId === 11).target), "[A].WXY-556 Plain title", "the local marker survives an unmarked database title");
  assert.equal(path.basename(plan.groups.find((g) => g.workId === 12).target), "XYZ-557 Title flag", "a stale database title cannot enable a removed local marker");
  plan.status = "running";
  saveOrganizationPlan(service.planPath(plan.id), plan);
  reserveOrganizationPaths(db, plan);
  assert.throws(() => db.prepare("UPDATE local_works SET updated_at = 'other' WHERE id = 1").run(), /reserved/);
  assert.throws(() => service.assertIdle("1"), /尚未完成/);
  for (const group of plan.groups) await organizeGroup(db, group, plan, service.planPath(plan.id));
  assert.equal(publicPlan(plan).moveCount, 0, "a metadata retry does not report completed directory moves as pending");
  const target = path.join(source, "ABC-123 Synthetic");
  assert.equal(fs.readFileSync(path.join(target, "ABC-123-CD1-U.mp4"), "utf8"), "synthetic:ABC-123-CD1-U.mp4");
  assert.equal(fs.readFileSync(path.join(target, "ABC-123-CD2 TV 1730.mp4"), "utf8"), "synthetic:ABC-123-CD2 TV 1730.mp4");
  assert.equal(db.prepare("SELECT file_path FROM video_probe_cache").get().file_path, path.join(target, "ABC-123-CD1-U.mp4"));
  assert.equal(db.prepare("SELECT local_path FROM fanhao_images.images").get().local_path, path.join(source, "DEF-456 Nested", "cover.jpg"));
  assert(fs.existsSync(path.join(source, "DEF-456 Nested", "disc", "DEF-456.mp4")));
  const markedTarget = path.join(source, "[A].UVW-555 Marked VR");
  assert.equal(db.prepare("SELECT local_path FROM local_works WHERE id = 10").get().local_path, markedTarget);
  assert.equal(db.prepare("SELECT count(*) n FROM local_files WHERE local_work_id = 10 AND file_path LIKE ?").get(`${markedTarget}%`).n, 4, "all multipart video and sidecar paths follow the corrected marked directory");
  assert.equal(fs.readFileSync(path.join(markedTarget, "UVW-555-2.mp4"), "utf8"), "synthetic:UVW-555-2.mp4");
  assert.equal(fs.readFileSync(path.join(source, "cover.jpg"), "utf8"), "person-cover");
  assert.equal(fs.readFileSync(path.join(source, "info.txt"), "utf8"), "person-info");
  assert.equal(db.prepare("SELECT work_id FROM favorites").get().work_id, 1);
  assert.equal(db.prepare("SELECT position FROM progress").get().position, 123);
  // A crash after commit but before marking the group done must be safe to replay.
  plan.groups[0].done = false;
  await organizeGroup(db, plan.groups[0], plan, service.planPath(plan.id));
  releaseOrganizationPaths(db, plan);
  const group = plan.groups[1], info = path.join(group.target, "info.txt");
  writeOrganizationSidecar(group, info, "fresh-info");
  assert.equal(fs.readFileSync(info, "utf8"), "fresh-info");
  writeOrganizationSidecar(group, info, "second-info");
  assert(!fs.existsSync(path.join(root, "backups")), "no backup requested or created");
  assert.throws(() => writeOrganizationSidecar(group, path.join(root, "escape.txt"), "bad"), /根目录/);
  plan.refreshMetadata = true;
  assert.equal(cleanupOrganizationSidecars(db, plan).removed.length, 0, "failed metadata retains obsolete files");
  assert.equal(cleanupOrganizationWorkCovers(db, group, plan).removed.length, 0, "failed cover download retains old covers");
  for (const g of plan.groups) g.metadataDone = true;
  writeOrganizationSidecar(group, path.join(group.target, "cover.jpg"), "fresh-cover");
  const covers = cleanupOrganizationWorkCovers(db, group, plan);
  assert.equal(covers.removed.length, 2, "old catalogue filename and stored cover URL basename are removed");
  assert.equal(covers.retained.length, 1, "a portrait reference protects the file");
  assert(fs.existsSync(path.join(group.target, "scene.jpg")), "samples remain untouched");
  assert.equal(db.prepare("SELECT count(*) n FROM local_files WHERE file_path LIKE '%synthetic.jpg'").get().n, 0);
  assert.equal(db.prepare("SELECT local_path FROM fanhao_images.images WHERE owner_type='work' AND owner_id=2 ORDER BY id DESC LIMIT 1").get().local_path, path.join(group.target, "cover.jpg"));
  assert.equal(cleanupOrganizationWorkCovers(db, group, plan).removed.length, 0, "cover cleanup is idempotent");
  const editionGroup = plan.groups.find((g) => g.workId === 7);
  writeOrganizationSidecar(editionGroup, path.join(editionGroup.target, "cover.jpg"), "fresh-edition-cover");
  assert.equal(cleanupOrganizationWorkCovers(db, editionGroup, plan).removed.length, 1, "vendor-prefixed base cover is cleaned after the edition cover succeeds");
  assert.equal(publicPlan(plan).obsoleteCoverCount, 1, "retry preview excludes removed covers and retains the protected existing portrait");
  group.releaseDate = "2023-10-27";
  const video = path.join(group.target, "disc", "DEF-456.mp4"), videoMtime = fs.statSync(video).mtimeMs;
  assert.equal(setOrganizationFolderReleaseDate(group), true);
  assert.equal(fs.statSync(group.target).mtimeMs, new Date("2023-10-27T00:00:00").getTime());
  assert.equal(fs.statSync(video).mtimeMs, videoMtime, "only the folder date changes");
  for (const invalid of ["", "2023-02-30"]) {
    group.releaseDate = invalid;
    assert.equal(setOrganizationFolderReleaseDate(group), false);
    assert.equal(fs.statSync(group.target).mtimeMs, new Date("2023-10-27T00:00:00").getTime());
  }
  const cleanup = cleanupOrganizationSidecars(db, plan);
  assert.equal(cleanup.removed.length, 2);
  assert(!fs.existsSync(path.join(source, "cover.jpg")));
  plan.status = "done";
  saveOrganizationPlan(service.planPath(plan.id), plan);
  assert.equal(service.preview("1").groups.find((g) => g.code === "UVW-555").target, markedTarget, "repeated organization keeps one marker and one code");

  // Check both pre-preview conflict and drift after a valid preview.
  seed(6, "STU-444", "STU-444 Drift", source, ["STU-444.mp4"]);
  const driftPlan = service.read(service.preview("1").id);
  const driftGroup = driftPlan.groups.find((g) => g.workId === 6);
  fs.appendFileSync(path.join(source, "STU-444.mp4"), "changed");
  reserveOrganizationPaths(db, driftPlan);
  await assert.rejects(organizeGroup(db, driftGroup, driftPlan, service.planPath(driftPlan.id)), /发生变化/);
  assert(fs.existsSync(path.join(source, "STU-444.mp4")));
  assert.equal(db.prepare("SELECT local_path FROM local_works WHERE id = 6").get().local_path, source);
  releaseOrganizationPaths(db, driftPlan);

  // Exercise the actual task executable against the same isolated database.
  const cliPlan = service.read(service.preview("1").id);
  cliPlan.refreshMetadata = false;
  saveOrganizationPlan(service.planPath(cliPlan.id), cliPlan);
  const child = spawnSync(process.execPath, ["tools/organize_person_library.mjs", "--plan", service.planPath(cliPlan.id),
    "--db", dbPath, "--image-db", imageDbPath], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(service.read(cliPlan.id).status, "done");
  assert.equal(db.prepare("SELECT work_id FROM local_works WHERE id = 7").get().work_id, 7, "edition binding is preserved");
  assert.equal(db.prepare("SELECT count(*) n FROM works WHERE id IN (7,9)").get().n, 2, "ordinary and bonus catalogue entries remain separate");
  assert.equal(fs.statSync(editionGroup.target).mtimeMs, new Date("2024-01-05T00:00:00").getTime(), "the bound edition's release date is used");
  assert.equal(db.prepare("SELECT count(*) n FROM work_move_path_reservations WHERE released_at = ''").get().n, 0);
  // The real completion hook must contain reload/read failures and refuse false success.
  let captured, reloads = 0, syncs = 0, readFailure = false;
  const maintenance = createAdminMaintenanceTaskService({
    resolveLibraryPersonByPublicId: () => person, nodeCommand: process.execPath, coreDbPath: dbPath, coreImageDbPath: imageDbPath,
    personOrganizationService: { ...service, read: (id) => { if (readFailure) throw new Error("fixture read failure"); return service.read(id); } },
    adminTaskService: { list: () => [], publicTask: (task) => task, startProcessTask: (options) => { captured = options; return { id: "fixture", logs: [] }; } },
    setLocalWorkCachesDirty: () => {}, clearSearchSourceCaches: () => {}, setWorkInfoCache: () => {},
    refreshLibrary: () => { reloads++; return {}; }, syncPersonLocal: () => { syncs++; return {}; }
  });
  Object.assign(cliPlan, service.read(cliPlan.id));
  cliPlan.status = "preview";
  saveOrganizationPlan(service.planPath(cliPlan.id), cliPlan);
  maintenance.organizePersonPayload({ personId: "1", planId: cliPlan.id, refreshMetadata: false });
  const completed = { status: "done", logs: [] };
  captured.onStdout(completed, "PERSON_ORGANIZATION_PATHS_");
  captured.onStdout(completed, "SYNCED\n");
  assert.equal(reloads, 1, "split stdout marker reloads paths before metadata finishes");
  captured.onDone(completed);
  assert.equal(syncs, 1);
  readFailure = true;
  assert.doesNotThrow(() => captured.onDone(completed));
  assert.equal(completed.status, "error");
  assert(completed.logs.some((line) => line.includes("fixture read failure")));
  console.log("person-organization: preview, multipart, nested folders, conflicts, incomplete downloads, mixed codes, path reservations, replay, drift, no-backup replacement, safe obsolete cleanup, identities and real task executable passed (synthetic files only)");
} finally { db.close(); temporary.cleanup(); }
