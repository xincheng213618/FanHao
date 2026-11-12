import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createShortVideoAuthorCleanup } from "../public/modules/short-videos/author-cleanup.js";
import { routeShortVideoAuthorCleanup } from "../src/modules/short-videos/server/author-cleanup-route.js";
import { createShortVideoAuthorCleanupService } from "../src/modules/short-videos/server/author-cleanup-service.js";
import { createShortVideoAuthorDeleteService } from "../src/modules/short-videos/server/author-delete-service.js";

await verifyCleanupService();
await verifyAuthorDeleteService();
await verifyCleanupRoute();
await verifyCleanupClient();
console.log(JSON.stringify({ check: "short-video-author-cleanup", ok: true }));

async function verifyCleanupService() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE short_video_users (id TEXT PRIMARY KEY, platform TEXT, sec_uid TEXT, nickname TEXT);
    CREATE TABLE short_videos (
      id TEXT PRIMARY KEY, author_name TEXT, author_sec_uid TEXT, is_liked INTEGER,
      size_bytes INTEGER, visibility TEXT, media_type TEXT
    );
    INSERT INTO short_video_users VALUES ('douyin:author-a', 'douyin', 'author-a', '作者 A');
    INSERT INTO short_videos VALUES
      ('liked', '旧名字', 'author-a', 1, 100, 'local_only', 'video'),
      ('unliked', '旧名字', 'author-a', 0, 500, 'local_only', 'video'),
      ('unknown', '旧名字', 'author-a', NULL, 700, 'local_only', 'video'),
      ('gallery', '旧名字', 'author-a', 0, 900, 'local_only', 'gallery'),
      ('remote', '旧名字', 'author-a', 0, 1100, 'remote', 'video'),
      ('other', '其他作者', 'author-b', 0, 1300, 'local_only', 'video');
  `);
  const calls = [];
  const service = createShortVideoAuthorCleanupService({
    database: () => database,
    async deleteVideos(ids, options) {
      calls.push({ ids, options });
      return completedDeletion(ids);
    }
  });
  const preview = service.preview("author-a");
  assert.deepEqual(preview, {
    secUid: "author-a", name: "作者 A", totalCount: 3,
    likedCount: 1, likedBytes: 100, deleteCount: 2, deleteBytes: 1200
  });
  assert.equal(Object.hasOwn(preview, "deleteIds"), false, "preview must not expose server-side deletion ids");
  await assert.rejects(
    service.execute("author-a", { deleteCount: 3, likedCount: 1 }),
    (error) => error?.statusCode === 409
  );
  assert.equal(calls.length, 0, "a changed preview must stop before deletion");
  const result = await service.execute("author-a", {
    deleteCount: 2, likedCount: 1, operationId: "cleanup-test"
  });
  assert.deepEqual(calls[0], {
    ids: ["unknown", "unliked"],
    options: { deleteFiles: true, operationId: "cleanup-test" }
  }, "only non-liked local videos from the exact author may be deleted");
  assert.equal(result.deletion.logicalDeleteCommitted, true);
  database.close();
}

async function verifyAuthorDeleteService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-author-delete-"));
  const authorFolder = path.join(root, "作者 A_author-a");
  const emptyFolder = path.join(root, "author-b");
  fs.mkdirSync(authorFolder, { recursive: true });
  fs.mkdirSync(emptyFolder, { recursive: true });
  fs.writeFileSync(path.join(authorFolder, "untracked.txt"), "delete me");
  fs.writeFileSync(path.join(emptyFolder, "orphan.txt"), "delete me too");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE short_video_users (id TEXT PRIMARY KEY, platform TEXT, sec_uid TEXT, nickname TEXT);
      CREATE TABLE short_video_follows (local_user_id TEXT, target_user_id TEXT);
      CREATE TABLE short_videos (
        id TEXT PRIMARY KEY, owner_user_id TEXT, author_name TEXT, author_sec_uid TEXT,
        is_liked INTEGER, size_bytes INTEGER, visibility TEXT, media_type TEXT,
        source_path TEXT, cover_path TEXT DEFAULT '', music_path TEXT DEFAULT '', data_path TEXT DEFAULT ''
      );
      CREATE TABLE short_video_assets (id TEXT PRIMARY KEY, video_id TEXT, local_path TEXT);
      INSERT INTO short_video_users VALUES
        ('douyin:author-a', 'douyin', 'author-a', '作者 A'),
        ('douyin:author-b', 'douyin', 'author-b', '空作者');
      INSERT INTO short_video_follows VALUES ('local:self', 'douyin:author-a');
    `);
    database.prepare(`
      INSERT INTO short_videos (
        id, owner_user_id, author_name, author_sec_uid, is_liked, size_bytes,
        visibility, media_type, source_path
      ) VALUES (?, ?, ?, ?, ?, ?, 'local_only', ?, ?)
    `).run("liked", "douyin:author-a", "作者 A", "author-a", 1, 100, "video", path.join(authorFolder, "liked", "liked.mp4"));
    database.prepare(`
      INSERT INTO short_videos (
        id, owner_user_id, author_name, author_sec_uid, is_liked, size_bytes,
        visibility, media_type, source_path
      ) VALUES (?, ?, ?, ?, ?, ?, 'local_only', ?, ?)
    `).run("gallery", "douyin:author-a", "作者 A", "author-a", 0, 900, "gallery", path.join(authorFolder, "gallery", "1.jpg"));
    const calls = [];
    const service = createShortVideoAuthorDeleteService({
      database: () => database,
      roots: [root],
      async deleteVideos(ids, options) {
        calls.push({ ids, options });
        const placeholders = ids.map(() => "?").join(", ");
        database.prepare(`DELETE FROM short_videos WHERE id IN (${placeholders})`).run(...ids);
        return completedDeletion(ids);
      }
    });
    assert.deepEqual(service.preview("author-a"), {
      secUid: "author-a", name: "作者 A", totalCount: 2, totalBytes: 1000,
      likedCount: 1, galleryCount: 1, folderCount: 1
    });
    const deleted = await service.execute("author-a", { totalCount: 2, operationId: "delete-author-a" });
    assert.deepEqual(calls[0], {
      ids: ["gallery", "liked"],
      options: { deleteFiles: true, operationId: "delete-author-a" }
    });
    assert.equal(deleted.folderCleanup.complete, true);
    assert.equal(deleted.folderCleanup.removedCount, 1);
    assert.equal(fs.existsSync(authorFolder), false, "complete author deletion must remove untracked files with the author folder");
    assert.equal(service.deleteRecord("author-a").removed, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM short_video_follows").get().count, 0);

    const emptyPreview = service.preview("author-b");
    assert.equal(emptyPreview.totalCount, 0, "an empty author must still be deletable");
    assert.equal(emptyPreview.folderCount, 1);
    const emptyDelete = await service.execute("author-b", { totalCount: 0 });
    assert.equal(emptyDelete.deletion, null);
    assert.equal(emptyDelete.folderCleanup.removedCount, 1);
    assert.equal(fs.existsSync(emptyFolder), false, "an empty author's folder must be removed");
    assert.equal(service.deleteRecord("author-b").removed, true);
    assert.equal(service.deleteRecord("author-without-record").removed, false, "record cleanup must be idempotent after an orphan author's works are gone");

    database.exec(`
      INSERT INTO short_video_users VALUES
        ('douyin:author-c', 'douyin', 'author-c', '共享文件作者'),
        ('douyin:author-d', 'douyin', 'author-d', '目录变化作者'),
        ('douyin:author-e', 'douyin', 'author-e', '原目录已移除作者'),
        ('douyin:author-f', 'douyin', 'author-f', '新增目录作者'),
        ('douyin:author-g', 'douyin', 'author-g', '新增记录作者'),
        ('douyin:author-h', 'douyin', 'author-h', '大型目录作者');
    `);
    const sharedFolder = path.join(root, "共享_作者_author-c");
    const sharedFile = path.join(sharedFolder, "keep.txt");
    fs.mkdirSync(sharedFolder);
    fs.writeFileSync(sharedFile, "a reference belonging to another work");
    database.prepare("INSERT INTO short_video_assets VALUES (?, ?, ?)")
      .run("shared-asset", "another-work", ` ${sharedFile.replaceAll("\\", "/")} `);
    await assert.rejects(service.execute("author-c", { totalCount: 0 }),
      (error) => error?.code === "SHORT_VIDEO_AUTHOR_FOLDER_IN_USE");
    assert.equal(fs.readFileSync(sharedFile, "utf8"), "a reference belonging to another work");
    database.prepare("UPDATE short_video_assets SET local_path = ? WHERE id = 'shared-asset'")
      .run(sharedFolder.replaceAll("\\", "/"));
    await assert.rejects(service.execute("author-c", { totalCount: 0 }),
      (error) => error?.code === "SHORT_VIDEO_AUTHOR_FOLDER_IN_USE");
    assert.equal(fs.readFileSync(sharedFile, "utf8"), "a reference belonging to another work", "a reference to the author directory itself must also protect its contents");

    const source = path.join(root, "author-d");
    const previous = path.join(root, "previous-directory");
    const existing = path.join(root, "author-f");
    const unexpected = path.join(root, "new_author-f");
    const removedByVideoJob = path.join(root, "author-e");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "old.txt"), "original directory");
    fs.mkdirSync(removedByVideoJob);
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, "old.txt"), "confirmed sibling");
    const insertVideo = database.prepare(`
      INSERT INTO short_videos (id, owner_user_id, author_name, author_sec_uid, source_path)
      VALUES (?, ?, 'fixture', ?, ?)
    `);
    insertVideo.run("replaced-folder", "douyin:author-d", "author-d", path.join(source, "old.txt"));
    insertVideo.run("removed-folder", "douyin:author-e", "author-e", path.join(removedByVideoJob, "old.txt"));
    insertVideo.run("new-folder", "douyin:author-f", "author-f", path.join(existing, "old.txt"));
    const duringDelete = createShortVideoAuthorDeleteService({
      database: () => database,
      roots: [root],
      async deleteVideos(ids) {
        await Promise.resolve();
        if (ids[0] === "replaced-folder") {
          fs.renameSync(source, previous);
          fs.mkdirSync(source);
          fs.writeFileSync(path.join(source, "new.txt"), "replacement directory");
        } else if (ids[0] === "new-folder") {
          fs.mkdirSync(unexpected);
          fs.writeFileSync(path.join(unexpected, "new.txt"), "new sibling directory");
        } else {
          fs.rmdirSync(removedByVideoJob);
        }
        database.prepare("DELETE FROM short_videos WHERE id = ?").run(ids[0]);
        return completedDeletion(ids);
      }
    });
    await assert.rejects(duringDelete.execute("author-d", { totalCount: 1 }),
      (error) => error?.code === "SHORT_VIDEO_AUTHOR_FOLDER_CHANGED" && error.authorWorksCommitted === true);
    assert.equal(fs.readFileSync(path.join(source, "new.txt"), "utf8"), "replacement directory");
    assert.equal(fs.readFileSync(path.join(previous, "old.txt"), "utf8"), "original directory");
    await assert.rejects(duringDelete.execute("author-f", { totalCount: 1 }),
      (error) => error?.code === "SHORT_VIDEO_AUTHOR_FOLDER_CHANGED");
    assert.equal(fs.readFileSync(path.join(unexpected, "new.txt"), "utf8"), "new sibling directory");
    assert.equal(fs.readFileSync(path.join(existing, "old.txt"), "utf8"), "confirmed sibling", "unexpected discovery must abort before removing confirmed siblings");

    const alreadyRemoved = await duringDelete.execute("author-e", { totalCount: 1 });
    assert.equal(alreadyRemoved.folderCleanup.complete, true);
    assert.equal(alreadyRemoved.folderCleanup.removedCount, 0, "a folder emptied by the confirmed job can already be absent");

    database.prepare("INSERT INTO short_video_follows VALUES ('local:self', 'douyin:author-g')").run();
    const recordRace = createShortVideoAuthorDeleteService({
      database: () => ({
        prepare: database.prepare.bind(database),
        exec(sql) {
          if (sql === "BEGIN IMMEDIATE") insertVideo.run("late-work", "douyin:author-g", "other-id", "");
          database.exec(sql);
        }
      }),
      deleteVideos: () => assert.fail("record cleanup must not delete newly observed work")
    });
    assert.throws(() => recordRace.deleteRecord("author-g"),
      (error) => error?.code === "SHORT_VIDEO_AUTHOR_DELETE_HAS_WORKS");
    assert.equal(database.prepare("SELECT id FROM short_video_users WHERE sec_uid = 'author-g'").get().id, "douyin:author-g");
    assert.equal(database.prepare("SELECT target_user_id FROM short_video_follows WHERE target_user_id = 'douyin:author-g'").get().target_user_id, "douyin:author-g");

    const large = path.join(root, "author-h");
    fs.mkdirSync(large);
    database.exec("BEGIN");
    for (let index = 0; index < 5000; index++) {
      insertVideo.run(`large-${index}`, "douyin:author-h", "author-h", path.join(large, String(index), "fixture.mp4"));
    }
    database.exec("COMMIT");
    let realpathReads = 0;
    const largePreview = createShortVideoAuthorDeleteService({
      database: () => database,
      roots: [root],
      fsOps: { ...fs, realpathSync(value) { realpathReads++; return fs.realpathSync(value); } },
      deleteVideos: () => assert.fail("previews must not delete files")
    }).preview("author-h");
    assert.equal(largePreview.totalCount, 5000);
    assert.equal(largePreview.folderCount, 1);
    assert.equal(realpathReads, 2, "folder preview should resolve the root and unique directory once");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verifyCleanupRoute() {
  const calls = [];
  const store = {
    authorCleanupPreview: () => ({ secUid: "author-a", name: "作者 A", likedCount: 1, deleteCount: 2 }),
    cleanupAuthorUnliked: async (_secUid, options) => {
      calls.push(["cleanup", options]);
      return {
        preview: { secUid: "author-a", name: "作者 A", likedCount: 1, deleteCount: 2 },
        deletion: completedDeletion(["unliked", "unknown"])
      };
    },
    setAuthorFollowByUser: (secUid, options) => {
      calls.push(["follow", secUid, options]);
      return { ok: true, active: false };
    }
  };
  const managerRequest = async (pathname, options = {}) => {
    calls.push(["manager", pathname, options]);
    if (pathname.startsWith("/api/profiles?")) {
      return {
        profiles: [
          { id: 41, sec_uid: "author-a", tab: "post" },
          { id: 42, sec_uid: "author-a", tab: "like" },
          { id: 43, sec_uid: "author-b", tab: "post" }
        ]
      };
    }
    return { ok: true };
  };
  let invalidations = 0;
  const response = await callRoute({
    store,
    managerRequest,
    method: "POST",
    body: { deleteCount: 2, likedCount: 1, operationId: "route-test" },
    onMutation: () => { invalidations += 1; }
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.status, "completed");
  assert.equal(response.data.authorCleanup.followRemoved, true);
  assert.equal(response.data.authorCleanup.monitoringRemoved, true);
  assert.deepEqual(response.data.authorCleanup.removal, { removed: [41], failed: [] });
  assert.equal(invalidations, 1);
  assert(calls.some((call) => call[0] === "follow" && call[1] === "author-a"));
  assert(calls.some((call) => call[0] === "manager" && call[1] === "/api/profiles/delete" && call[2].body.profile_id === 41));
  assert(!calls.some((call) => call[0] === "manager" && call[1] === "/api/profiles/delete" && call[2].body.profile_id !== 41));

  let rollbackFollowed = false;
  const rollback = await callRoute({
    store: {
      ...store,
      cleanupAuthorUnliked: async () => ({
        preview: { secUid: "author-a", likedCount: 1, deleteCount: 2 },
        deletion: rollbackDeletion()
      }),
      setAuthorFollowByUser: () => { rollbackFollowed = true; }
    },
    managerRequest,
    method: "POST",
    body: { deleteCount: 2, likedCount: 1 }
  });
  assert.equal(rollback.status, 500);
  assert.equal(rollbackFollowed, false, "monitoring must remain when logical deletion was not committed");

  const deleteCalls = [];
  const emptyDelete = await callRoute({
    action: "delete",
    store: {
      authorDeletePreview: () => ({ secUid: "author-a", name: "作者 A", totalCount: 0, folderCount: 1 }),
      deleteAuthorAllWorks: async (_secUid, options) => {
        deleteCalls.push(["delete", options]);
        return {
          preview: { secUid: "author-a", name: "作者 A", totalCount: 0, folderCount: 1 },
          deletion: null,
          folderCleanup: { complete: true, removed: ["作者 A_author-a"], removedCount: 1 }
        };
      },
      deleteAuthorRecord: (secUid) => {
        deleteCalls.push(["record", secUid]);
        return { removed: true, userId: "douyin:author-a", followRows: 1 };
      }
    },
    managerRequest: async (pathname, options = {}) => {
      deleteCalls.push(["manager", pathname, options]);
      if (pathname.startsWith("/api/profiles?")) {
        return { profiles: [
          { id: 41, sec_uid: "author-a", tab: "post" },
          { id: 42, sec_uid: "author-a", tab: "like" }
        ] };
      }
      return { ok: true };
    },
    method: "POST",
    body: { totalCount: 0, operationId: "delete-empty-author" }
  });
  assert.equal(emptyDelete.status, 200);
  assert.equal(emptyDelete.data.status, "author_deleted");
  assert.deepEqual(emptyDelete.data.authorDelete.removal.removed, [41, 42]);
  assert(deleteCalls.some((call) => call[0] === "record"), "the local author record must be removed after manager records succeed");

  const partialCases = [
    { status: 409, error: Object.assign(new Error("作品删除已提交。作者文件夹在删除期间发生变化"), { statusCode: 409, authorWorksCommitted: true }) },
    { status: 202, deletion: { ...completedDeletion(["one"]), status: "cleanup_pending", pending: true, physicalCleanupComplete: false } }
  ];
  for (const scenario of partialCases) {
    const preview = { secUid: "author-a", totalCount: 1, folderCount: 1 };
    let mutations = 0;
    const partial = await callRoute({
      action: "delete",
      store: {
        authorDeletePreview: () => preview,
        deleteAuthorAllWorks: async () => {
          if (scenario.error) throw scenario.error;
          return { preview, deletion: scenario.deletion, folderCleanup: { complete: false } };
        },
        deleteAuthorRecord: () => assert.fail("incomplete folder cleanup must preserve the author record")
      },
      managerRequest: async pathname => {
        assert(pathname.startsWith("/api/profiles?"), "incomplete folder cleanup must preserve the monitor");
        return { profiles: [{ id: 41, sec_uid: "author-a" }] };
      },
      method: "POST",
      body: { totalCount: 1, operationId: "partial-delete-author" },
      onMutation: () => { mutations++; }
    });
    assert.equal(partial.status, scenario.status);
    assert.equal(mutations, 1, "list cache must reflect committed work deletion even when folder cleanup stops");
  }
}

async function verifyCleanupClient() {
  const requests = [];
  const tracked = [];
  const toasts = [];
  let refreshed = 0;
  const payload = {
    ...completedDeletion(["unliked", "unknown"]),
    authorCleanup: { followRemoved: true, monitoringRemoved: true, removal: { removed: [41], failed: [] } }
  };
  const api = async (path, options = {}) => {
    requests.push({ path, options });
    if (path.endsWith("/delete")) {
      if (!options.method) {
        return {
          preview: { secUid: "author-a", name: "作者 A", totalCount: 2, totalBytes: 1200, likedCount: 1, galleryCount: 1, folderCount: 1 },
          manager: { available: true, monitored: true, profileCount: 2 }
        };
      }
      return {
        status: 200,
        payload: {
          ...completedDeletion(["liked", "gallery"]),
          authorDelete: {
            folderCleanup: { complete: true, removed: ["作者 A_author-a"], removedCount: 1 },
            removal: { removed: [41, 42], failed: [] },
            record: { removed: true }
          }
        }
      };
    }
    if (!options.method) {
      return {
        preview: { secUid: "author-a", name: "作者 A", likedCount: 1, likedBytes: 100, deleteCount: 2, deleteBytes: 1200 },
        manager: { available: true, monitored: true, profileCount: 1 }
      };
    }
    return { status: 200, payload };
  };
  const prompts = [];
  const completedModes = [];
  const cleanup = createShortVideoAuthorCleanup({
    api,
    recovery: { hasPending: () => false, track: (result) => tracked.push(result) },
    showToast: (message) => toasts.push(message),
    confirmCleanup: async (message, options) => {
      prompts.push({ message, options });
      return true;
    },
    onCompleted: async ({ mode = "cleanup" }) => { refreshed += 1; completedModes.push(mode); }
  });
  const result = await cleanup.run({ secUid: "author-a" });
  assert.equal(result.committed, true);
  assert.equal(prompts[0].options.commitLabel, "删除并移除监听");
  assert.match(prompts[0].message, /保留：1 条明确点赞视频/);
  assert.match(prompts[0].message, /删除：2 条未点赞视频/);
  assert.match(prompts[0].message, /图文不会删除/);
  assert.equal(requests[1].options.body.deleteCount, 2);
  assert.equal(requests[1].options.body.likedCount, 1);
  assert.match(requests[1].options.body.operationId, /^sv-delete-op-[0-9a-f-]{36}$/);
  assert.equal(tracked.length, 1);
  assert.equal(refreshed, 1);
  assert.match(toasts.at(-1), /删除 2 条未点赞视频，并移除监听/);

  const deleted = await cleanup.runDeleteAll({ secUid: "author-a" });
  assert.equal(deleted.committed, true);
  assert.equal(prompts[1].options.commitLabel, "删除用户及全部作品");
  assert.match(prompts[1].message, /全部内容/);
  assert.match(prompts[1].message, /不会保留点赞作品/);
  assert.equal(requests.at(-1).options.body.totalCount, 2);
  assert.equal(tracked.length, 2);
  assert.deepEqual(completedModes, ["cleanup", "delete"]);
  assert.match(toasts.at(-1), /2 个作品、1 个作者文件夹和 2 条采集记录/);
}

async function callRoute({ action = "cleanup", store, managerRequest, method, body, onMutation = () => undefined }) {
  const res = {};
  const handled = await routeShortVideoAuthorCleanup({
    req: { method, body },
    res,
    url: new URL(`http://127.0.0.1/api/short-videos/authors/author-a/${action}`),
    store,
    readJsonBody: async (req) => req.body || {},
    requireLocalAdmin: () => true,
    sendJson: (target, status, data) => Object.assign(target, { status, data }),
    downloadManagerRequest: managerRequest,
    onMutation
  });
  assert.equal(handled, true);
  return res;
}

function completedDeletion(ids) {
  return {
    ok: true, accepted: true, pending: false, status: "completed",
    logicalDeleteCommitted: true, physicalCleanupComplete: true,
    jobId: "job-completed", cleanupPendingFiles: 0,
    ids: [...ids], count: ids.length, deletedFiles: []
  };
}

function rollbackDeletion() {
  return {
    ok: false, accepted: false, pending: true, status: "rollback_pending",
    recoveryRequired: true, retryable: true, manualInterventionRequired: false,
    processRestartRequired: false, logicalDeleteCommitted: false, jobId: "job-rollback"
  };
}
