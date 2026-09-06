import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createUserStateService } from "../src/modules/fanhao/server/collections/user-state-service.js";
import { createAccountUserStateService } from "../src/modules/fanhao/server/collections/account-user-state-service.js";
import { createFavoriteStateService } from "../src/modules/fanhao/server/collections/favorite-state-service.js";
import { createPlaybackProgressService } from "../src/modules/fanhao/server/playback/playback-progress-service.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-account-personal-state-"));
const dbPath = path.join(root, "account-user-state.sqlite");
const statePath = path.join(root, "user-state.json");
const futurePath = path.join(root, "future.sqlite");
const invalidPath = path.join(root, "invalid.sqlite");
const alice = { id: "alice", username: "ignored", password: "must-never-copy", token: "not-a-state-field" };
const bob = { id: "bob" };
const work1 = { id: "work-1", videos: [{ id: "video-1", type: "video" }] };
const work2 = { id: "work-2", videos: [{ id: "video-2", type: "video" }] };
const library = { worksById: new Map([[work1.id, work1], [work2.id, work2]]), filesById: new Map([...work1.videos, ...work2.videos].map((file) => [file.id, file])) };
const legacy = createUserStateService({ statePath, ensureDataDir: () => {}, warn: (message) => { throw new Error(message); } });
legacy.state.manualCovers[work1.id] = { imageId: "global-cover", updatedAt: "2026-01-01" };
legacy.state.favorites[work2.id] = { folderId: "default", createdAt: "2026-01-01" };
legacy.state.progress["video-2"] = { workId: work2.id, position: 8, duration: 80, updatedAt: "2026-01-01" };
legacy.save();
let service;
let observer;
let second;
const otherServices = [];

function createServices(stateService) {
  const favorites = createFavoriteStateService({
    createId: (prefix, name) => `${prefix}-${name}`,
    defaultFavoriteFolderId: "default", defaultFavoriteFolderName: "默认收藏", maxFavoriteFolders: 32,
    getLibrary: () => library, getUserState: stateService.state, userStateService: stateService
  });
  const playback = createPlaybackProgressService({
    getLibrary: () => library, publicFavoriteFolders: favorites.publicFavoriteFolders,
    recentWatchedDays: 7, getUserState: stateService.state, userStateService: stateService
  });
  return { favorites, playback };
}

try {
  const legacyPlayback = createPlaybackProgressService({ getLibrary: () => library, publicFavoriteFolders: () => [],
    recentWatchedDays: 7, userState: legacy.state, userStateService: legacy });
  assert.equal(legacyPlayback.getWorkProgress(work2).position, 8, "Legacy fixed userState injection stopped working");
  service = createAccountUserStateService({ dbPath, legacyStateService: legacy });
  const { favorites, playback } = createServices(service);
  assert.strictEqual(service.state(), legacy.state);
  assert.equal(fs.existsSync(dbPath), false, "Guest reads must not create an account database");
  assert.equal(favorites.isFavoriteWork(work2.id), true);
  assert.equal(playback.getWorkProgress(work2).position, 8);
  const beforeLegacy = fs.readFileSync(statePath, "utf8");
  const guestStamp = service.revision();

  const aliceStamp = service.runForUser(alice, () => {
    assert.deepEqual(Object.keys(service.state()).sort(), ["favoriteFolders", "favorites", "progress"]);
    assert.equal(favorites.isFavoriteWork(work2.id), false);
    assert.equal(playback.getWorkProgress(work2), null);
    return service.revision();
  });
  const bobStamp = service.runForUser(bob, () => service.revision());
  assert.equal(new Set([guestStamp, aliceStamp, bobStamp]).size, 3, "Equal revisions must retain owner identity");
  assert.throws(() => service.runForUser({ id: 123 }, () => {}), /Invalid trusted account id/);
  assert.throws(() => service.runForUser({ id: " " }, () => {}), /Invalid trusted account id/);

  let folderId;
  service.runForUser(alice, () => {
    folderId = favorites.createFavoriteFolder("  Alice   folder  ").id;
    favorites.toggleFavorite(work1.id, { folderId });
    playback.saveVideoProgress("video-1", { workId: work1.id, position: 35, duration: 100 });
    assert.equal(favorites.publicFavoriteForWork(work1.id).folderName, "Alice folder");
    assert.equal(service.normalizeFavoriteRecord({ folderId }).folderId, folderId);
    assert.equal(service.normalizeFavorites({ [work1.id]: { folderId } })[work1.id].folderId, folderId);
    assert.equal(service.normalizeFavoriteFolderId("toString"), "default", "Inherited object properties are not folders");
    assert.equal(playback.getWorkProgress(work1).position, 35);
    assert.equal(playback.saveVideoProgress("video-1", { workId: work1.id, position: 0, duration: 100 }).position, 35);
  });
  service.runForUser(bob, () => {
    assert.equal(favorites.publicFavoriteFolders().length, 1);
    assert.equal(service.normalizeFavoriteFolderId(folderId), "default");
    favorites.toggleFavorite(work2.id, { folderId });
    assert.equal(favorites.publicFavoriteForWork(work2.id).folderId, "default");
    playback.saveVideoProgress("video-1", { workId: work1.id, position: 79, duration: 100 });
    assert.equal(playback.getWorkProgress(work1).position, 79);
  });
  for (const [user, position] of [[alice, 35], [bob, 79], [alice, 35]]) service.runForUser(user, () => {
    assert.equal(playback.getWorkProgress(work1).position, position, "Shared work object cache leaked another owner's progress");
    assert.deepEqual(playback.historyWorks().map((work) => work.id), [work1.id]);
    assert.equal(playback.userStateSummary().favoriteCount, 1);
  });
  assert.equal(fs.readFileSync(statePath, "utf8"), beforeLegacy, "Account writes changed the legacy file");
  assert.equal(playback.getWorkProgress(work1), null);
  assert.equal(favorites.isFavoriteWork(work1.id), false);

  let resume;
  const bodyReady = new Promise((resolve) => { resume = resolve; });
  const pendingAlice = service.runForUser(alice, async () => {
    assert.equal(playback.getWorkProgress(work1).position, 35);
    await bodyReady;
    favorites.toggleFavorite(work2.id);
    playback.saveVideoProgress("video-2", { workId: work2.id, position: 22, duration: 80 });
    assert.equal(playback.userStateSummary().favoriteCount, 2);
    return service.revision();
  });
  service.runForUser(bob, () => {
    favorites.toggleFavorite(work1.id);
    assert.equal(playback.getWorkProgress(work2), null);
  });
  resume();
  assert.equal(JSON.parse(await pendingAlice)[0], alice.id, "Awaited request changed account scope");
  service.runForUser(bob, () => assert.equal(playback.getWorkProgress(work2), null));

  let continueSameOwner;
  const sameOwnerWait = new Promise((resolve) => { continueSameOwner = resolve; });
  const delayedAlice = service.runForUser(alice, async () => {
    await sameOwnerWait;
    favorites.moveFavoriteToFolder(work2.id, folderId);
  });
  service.runForUser(alice, () => playback.saveVideoProgress("video-1", { workId: work1.id, position: 41, duration: 100 }));
  continueSameOwner();
  await delayedAlice;
  service.runForUser(alice, () => {
    assert.equal(playback.getWorkProgress(work1).position, 41, "Delayed same-owner mutation lost an earlier update");
    assert.equal(favorites.publicFavoriteForWork(work2.id).folderId, folderId);
  });
  await service.runForUser(alice, async () => {
    await service.runAsGuest(async () => {
      await Promise.resolve();
      assert.strictEqual(service.state(), legacy.state);
    });
    assert.equal(JSON.parse(service.revision())[0], alice.id);
  });

  observer = new DatabaseSync(dbPath);
  const rows = observer.prepare("SELECT * FROM account_user_state ORDER BY account_id").all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(JSON.parse(row.state_json)).sort(), ["favoriteFolders", "favorites", "progress"]);
    assert(!/must-never-copy|not-a-state-field|global-cover|manualCovers|username/.test(row.state_json));
  }

  observer.exec(`CREATE TRIGGER reject_personal_update BEFORE UPDATE ON account_user_state
    BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END;`);
  service.runForUser(alice, () => {
    const committed = JSON.stringify(service.state());
    const stateReference = service.state();
    assert.throws(() => favorites.toggleFavorite(work1.id), /fixture persistence failure/);
    assert.equal(JSON.stringify(stateReference), committed, "Failed favorite write remained visible in memory");
    assert.equal(favorites.isFavoriteWork(work1.id), true);
    assert.throws(() => playback.saveVideoProgress("video-1", { workId: work1.id, position: 99, duration: 100 }), /fixture persistence failure/);
    assert.equal(playback.getWorkProgress(work1).position, 41, "Failed progress write polluted cached progress");
    assert.equal(JSON.stringify(service.state()), committed);
  });
  observer.exec("DROP TRIGGER reject_personal_update;");

  second = createAccountUserStateService({ dbPath, legacyStateService: legacy });
  const other = createServices(second);
  service.runForUser(alice, () => {
    const committed = service.state();
    second.runForUser(alice, () => other.playback.saveVideoProgress("video-1", { workId: work1.id, position: 57, duration: 100 }));
    assert.throws(() => favorites.toggleFavorite(work1.id), (error) => error.statusCode === 409);
    assert.equal(committed.favorites[work1.id].folderId, folderId, "Conflicting write did not roll back its own mutation");
    assert.equal(playback.getWorkProgress(work1).position, 57, "Conflict retry did not reload the committed state");
  });
  await Promise.resolve();
  second.runForUser(alice, () => other.playback.saveVideoProgress("video-1", { workId: work1.id, position: 63, duration: 100 }));
  await Promise.resolve();
  service.runForUser(alice, () => assert.equal(playback.getWorkProgress(work1).position, 63, "Next turn retained another connection's stale state"));

  const oldStamp = service.runForUser(alice, () => service.revision());
  legacy.state.manualCovers[work1.id].imageId = "updated-global-cover";
  legacy.save();
  assert.notEqual(service.runForUser(alice, () => service.revision()), oldStamp, "Global cover revision must invalidate account responses");
  for (let index = 0; index < 40; index += 1) service.runForUser({ id: `cache-${index}` }, () => service.state());
  service.runForUser(alice, () => assert.equal(playback.getWorkProgress(work1).position, 63, "LRU reload lost saved progress"));
  const folderOwner = { id: "folder-persistence" };
  let deletedFolderId, survivingFolderId, originalFavoriteTime;
  service.runForUser(folderOwner, () => {
    deletedFolderId = favorites.createFavoriteFolder("Folder before restart").id;
    favorites.toggleFavorite(work1.id, { folderId: deletedFolderId });
    originalFavoriteTime = service.state().favorites[work1.id].createdAt;
    playback.saveVideoProgress("video-1", { workId: work1.id, position: 17, duration: 100 });
    service.state().favorites["hidden-work"] = { folderId: deletedFolderId, createdAt: "2024-01-01" };
    service.save();
    favorites.renameFavoriteFolder(deletedFolderId, "Renamed before restart");
  });
  second.runForUser(folderOwner, () => assert.equal(other.favorites.publicFavoriteFolders().find((folder) => folder.id === deletedFolderId).name, "Renamed before restart"));
  service.runForUser(folderOwner, () => {
    assert.equal(favorites.deleteFavoriteFolder(deletedFolderId).movedCount, 2);
    survivingFolderId = favorites.createFavoriteFolder("Surviving folder").id;
    favorites.renameFavoriteFolder(survivingFolderId, "Renamed survives restart");
    favorites.toggleFavorite(work2.id, { folderId: survivingFolderId });
  });
  service.close();
  service = createAccountUserStateService({ dbPath, legacyStateService: legacy });
  const restarted = createServices(service);
  service.runForUser(alice, () => {
    assert.equal(restarted.playback.getWorkProgress(work1).position, 63);
    assert.equal(restarted.favorites.publicFavoriteForWork(work2.id).folderId, folderId);
  });
  service.runForUser(bob, () => assert.equal(restarted.playback.getWorkProgress(work1).position, 79));
  service.runForUser(folderOwner, () => {
    assert(!Object.hasOwn(service.state().favoriteFolders, deletedFolderId));
    assert.equal(service.state().favoriteFolders[survivingFolderId].name, "Renamed survives restart");
    assert.equal(service.state().favorites[work1.id].folderId, "default");
    assert.equal(service.state().favorites[work1.id].createdAt, originalFavoriteTime);
    assert.deepEqual(service.state().favorites["hidden-work"], { folderId: "default", createdAt: "2024-01-01" });
    assert.equal(restarted.favorites.publicFavoriteForWork(work2.id).folderId, survivingFolderId);
    assert.equal(restarted.playback.getWorkProgress(work1).position, 17);
  });
  assert.equal(legacy.state.manualCovers[work1.id].imageId, "updated-global-cover");

  const guestFolder = restarted.favorites.createFavoriteFolder("Guest strict folder");
  restarted.favorites.moveFavoriteToFolder(work2.id, guestFolder.id);
  restarted.favorites.renameFavoriteFolder(guestFolder.id, "Guest renamed");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).favoriteFolders[guestFolder.id].name, "Guest renamed");
  const guestCommitted = fs.readFileSync(statePath, "utf8");
  const guestFolderSnapshot = JSON.stringify(legacy.state.favoriteFolders);
  const guestFavoritesSnapshot = JSON.stringify(legacy.state.favorites);
  const guestProgressSnapshot = JSON.stringify(legacy.state.progress);
  const guestRevision = legacy.revision();
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = (source, target) => {
      if (path.resolve(target) !== statePath) return originalRename(source, target);
      // Model unrelated shared metadata changing while the file replacement fails.
      legacy.state.manualCovers[work1.id].imageId = "parallel-cover-change";
      throw Object.assign(new Error("fixture guest replacement failure"), { code: "EACCES" });
    };
    for (const operation of [() => restarted.favorites.renameFavoriteFolder(guestFolder.id, "Must roll back"), () => restarted.favorites.deleteFavoriteFolder(guestFolder.id)]) {
      assert.throws(operation, /fixture guest replacement failure/);
      assert.equal(fs.readFileSync(statePath, "utf8"), guestCommitted, "Failed atomic replacement damaged the legacy file");
      assert.equal(JSON.stringify(legacy.state.favoriteFolders), guestFolderSnapshot);
      assert.equal(JSON.stringify(legacy.state.favorites), guestFavoritesSnapshot);
      assert.equal(JSON.stringify(legacy.state.progress), guestProgressSnapshot);
      assert.equal(legacy.state.manualCovers[work1.id].imageId, "parallel-cover-change", "Folder rollback overwrote unrelated media state");
      assert.equal(legacy.revision(), guestRevision, "Failed strict save published a new revision");
      assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0, "Failed save left temporary files");
    }
  } finally { fs.renameSync = originalRename; }
  assert.equal(restarted.favorites.deleteFavoriteFolder(guestFolder.id).movedCount, 1);
  assert.equal(legacy.state.favorites[work2.id].folderId, "default");
  const guestAfterDelete = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert(!Object.hasOwn(guestAfterDelete.favoriteFolders, guestFolder.id));
  assert.equal(guestAfterDelete.favorites[work2.id].createdAt, JSON.parse(guestFavoritesSnapshot)[work2.id].createdAt);

  const future = new DatabaseSync(futurePath);
  future.exec("PRAGMA user_version=99;");
  future.close();
  const futureService = createAccountUserStateService({ dbPath: futurePath, legacyStateService: legacy });
  otherServices.push(futureService);
  assert.throws(() => futureService.runForUser(alice, () => futureService.state()), /newer than/);
  assert.strictEqual(futureService.state(), legacy.state);

  const invalidService = createAccountUserStateService({ dbPath: invalidPath, legacyStateService: legacy });
  otherServices.push(invalidService);
  invalidService.runForUser(alice, () => invalidService.state());
  const invalidDb = new DatabaseSync(invalidPath);
  invalidDb.prepare("INSERT INTO account_user_state VALUES(?, 1, ?)").run(alice.id, "not json");
  invalidDb.close();
  await Promise.resolve();
  assert.throws(() => invalidService.runForUser(alice, () => invalidService.state()), SyntaxError);
  assert.strictEqual(invalidService.state(), legacy.state);

  console.log("Account personal state fixtures passed: owner isolation, async scopes, caches, persistence conflicts and rollback, restart, legacy compatibility.");
} finally {
  second?.close();
  observer?.close();
  service?.close();
  for (const item of otherServices) item.close();
  for (const target of [statePath, ...[dbPath, futurePath, invalidPath].flatMap((file) => [file, `${file}-wal`, `${file}-shm`])]) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  fs.rmdirSync(root);
}
