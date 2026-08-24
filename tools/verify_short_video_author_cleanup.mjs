import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { createShortVideoAuthorCleanup } from "../public/modules/short-videos/author-cleanup.js";
import { routeShortVideoAuthorCleanup } from "../src/modules/short-videos/server/author-cleanup-route.js";
import { createShortVideoAuthorCleanupService } from "../src/modules/short-videos/server/author-cleanup-service.js";

await verifyCleanupService();
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
    if (!options.method) {
      return {
        preview: { secUid: "author-a", name: "作者 A", likedCount: 1, likedBytes: 100, deleteCount: 2, deleteBytes: 1200 },
        manager: { available: true, monitored: true, profileCount: 1 }
      };
    }
    return { status: 200, payload };
  };
  let prompt = "";
  const cleanup = createShortVideoAuthorCleanup({
    api,
    recovery: { hasPending: () => false, track: (result) => tracked.push(result) },
    showToast: (message) => toasts.push(message),
    confirmCleanup: async (message, options) => {
      prompt = message;
      assert.equal(options.commitLabel, "删除并移除监听");
      return true;
    },
    onCompleted: async () => { refreshed += 1; }
  });
  const result = await cleanup.run({ secUid: "author-a" });
  assert.equal(result.committed, true);
  assert.match(prompt, /保留：1 条明确点赞视频/);
  assert.match(prompt, /删除：2 条未点赞视频/);
  assert.match(prompt, /图文不会删除/);
  assert.equal(requests[1].options.body.deleteCount, 2);
  assert.equal(requests[1].options.body.likedCount, 1);
  assert.match(requests[1].options.body.operationId, /^sv-delete-op-[0-9a-f-]{36}$/);
  assert.equal(tracked.length, 1);
  assert.equal(refreshed, 1);
  assert.match(toasts.at(-1), /删除 2 条未点赞视频，并移除监听/);
}

async function callRoute({ store, managerRequest, method, body, onMutation = () => undefined }) {
  const res = {};
  const handled = await routeShortVideoAuthorCleanup({
    req: { method, body },
    res,
    url: new URL("http://127.0.0.1/api/short-videos/authors/author-a/cleanup"),
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
