import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createShortVideoLocalActions } from "../src/modules/short-videos/server/local-actions.js";
import { routeShortVideoLocalActionApi } from "../src/modules/short-videos/server/local-action-routes.js";
import { createShortVideosRuntime } from "../src/modules/short-videos/server/runtime.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-local-actions-"));
const libraryRoot = path.join(tempRoot, "ShortVideos");
const authorRoot = path.join(libraryRoot, "MS4wLjAB-test-sec-uid");
const workRoot = path.join(authorRoot, "2026-08-24_test_7677261409160852073");
const sourcePath = path.join(workRoot, "7677261409160852073.mp4");
const opened = [];

try {
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(sourcePath, "original-video");

  const files = new Map([
    ["7677261409160852073", {
      id: "7677261409160852073",
      path: sourcePath,
      fileName: "7677261409160852073.mp4",
      type: "video"
    }]
  ]);
  const actions = createShortVideoLocalActions({
    roots: [libraryRoot],
    getVideoFile(id, options = {}) {
      assert.equal(options.allowMissing, true);
      return files.get(String(id)) || null;
    },
    delayMs: 0,
    openTarget(target) {
      opened.push(target);
    }
  });

  const original = actions.sourceFile("7677261409160852073");
  assert.equal(original.path, sourcePath, "download must resolve the original catalog file, not a playback cache");

  const reveal = actions.schedule("7677261409160852073", "reveal");
  assert.deepEqual(reveal, {
    action: "reveal",
    path: "MS4wLjAB-test-sec-uid/2026-08-24_test_7677261409160852073/7677261409160852073.mp4",
    type: "file"
  });
  const author = actions.schedule("7677261409160852073", "open-author-folder");
  assert.deepEqual(author, {
    action: "open-author-folder",
    path: "MS4wLjAB-test-sec-uid",
    type: "folder"
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(opened, [
    { action: "reveal", path: sourcePath, type: "file" },
    { action: "open-author-folder", path: authorRoot, type: "folder" }
  ], "local actions must open only server-resolved targets");

  const routeDeps = {
    localActions: actions,
    readJsonBody: async (req) => req.body || {},
    requireLocalAdmin(_req, res) {
      if (res.allowAdmin) return true;
      res.status = 403;
      res.data = { error: "forbidden" };
      return false;
    },
    sendJson(res, status, data) {
      res.status = status;
      res.data = data;
    }
  };
  const denied = { allowAdmin: false };
  assert.equal(await routeShortVideoLocalActionApi(
    { method: "POST", body: { action: "reveal" } },
    denied,
    new URL("http://127.0.0.1/api/short-videos/7677261409160852073/local-action"),
    routeDeps
  ), true);
  assert.equal(denied.status, 403, "local file actions must require a local administrator");
  assert.equal(opened.length, 2, "a rejected request must not schedule an operating-system action");

  const allowed = { allowAdmin: true };
  await routeShortVideoLocalActionApi(
    { method: "POST", body: { action: "open-author-folder" } },
    allowed,
    new URL("http://127.0.0.1/api/short-videos/7677261409160852073/local-action"),
    routeDeps
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.data, {
    ok: true,
    action: "open-author-folder",
    path: "MS4wLjAB-test-sec-uid",
    type: "folder"
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(opened.at(-1), { action: "open-author-folder", path: authorRoot, type: "folder" });

  assert.throws(
    () => actions.schedule("7677261409160852073", "delete"),
    (error) => error?.code === "SHORT_VIDEO_LOCAL_ACTION_INVALID" && error?.statusCode === 400
  );
  assert.throws(
    () => actions.sourceFile("missing"),
    (error) => error?.code === "SHORT_VIDEO_LOCAL_FILE_NOT_FOUND" && error?.statusCode === 404
  );

  const outsidePath = path.join(tempRoot, "outside.mp4");
  fs.writeFileSync(outsidePath, "outside");
  files.set("outside", { id: "outside", path: outsidePath, fileName: "outside.mp4", type: "video" });
  assert.throws(
    () => actions.sourceFile("outside"),
    (error) => error?.code === "SHORT_VIDEO_LOCAL_FILE_OUTSIDE_ROOT" && error?.statusCode === 400
  );

  const directPath = path.join(libraryRoot, "direct.mp4");
  fs.writeFileSync(directPath, "direct");
  files.set("direct", { id: "direct", path: directPath, fileName: "direct.mp4", type: "video" });
  assert.throws(
    () => actions.schedule("direct", "open-author-folder"),
    (error) => error?.code === "SHORT_VIDEO_AUTHOR_FOLDER_UNAVAILABLE" && error?.statusCode === 409
  );

  const escapedRoot = path.join(tempRoot, "escaped-author");
  const escapedFile = path.join(escapedRoot, "work", "escaped.mp4");
  fs.mkdirSync(path.dirname(escapedFile), { recursive: true });
  fs.writeFileSync(escapedFile, "escaped");
  const linkRoot = path.join(libraryRoot, "linked-author");
  try {
    fs.symlinkSync(escapedRoot, linkRoot, process.platform === "win32" ? "junction" : "dir");
    files.set("escaped", {
      id: "escaped",
      path: path.join(linkRoot, "work", "escaped.mp4"),
      fileName: "escaped.mp4",
      type: "video"
    });
    assert.throws(
      () => actions.sourceFile("escaped"),
      (error) => error?.statusCode === 400 && /逃出/.test(error?.message || "")
    );
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }

  const runtimeDbPath = path.join(tempRoot, "runtime.sqlite");
  const runtimeOpened = [];
  let downloaded = null;
  const runtime = createShortVideosRuntime({
    dbPath: runtimeDbPath,
    downloadManagerDbPath: "",
    downloadManagerSyncMs: 0,
    ffmpegPath: "ffmpeg",
    roots: [libraryRoot],
    mediaResponseService: { serveImage() {} },
    mediaStreamService: { serveVideo() {} },
    notFound(res) { res.status = 404; },
    readJsonBody: async (req) => req.body || {},
    requireLocalAdmin: () => true,
    sendJson(res, status, data) { res.status = status; res.data = data; },
    serveDownloadFile(_req, res, file, fileName) {
      downloaded = { file, fileName };
      res.status = 200;
      return true;
    },
    sharedCache: {
      rootDir: path.join(tempRoot, "cache"),
      scheduleCleanup() {},
      touch() {}
    },
    runtimeTestHooks: {
      openLocalTarget(target) { runtimeOpened.push(target); }
    }
  });
  try {
    runtime.store.warm();
    const database = new DatabaseSync(runtimeDbPath);
    try {
      const timestamp = "2026-08-24T00:00:00.000Z";
      database.prepare(`
        INSERT INTO short_videos(id, source_path, file_name, media_type, visibility, imported_at, updated_at)
        VALUES(?, ?, ?, 'video', 'local_only', ?, ?)
      `).run("7677261409160852073", sourcePath, path.basename(sourcePath), timestamp, timestamp);
    } finally {
      database.close();
    }

    const localResponse = {};
    assert.equal(await runtime.routeApi(
      { method: "POST", body: { action: "open-author-folder" } },
      localResponse,
      new URL("http://127.0.0.1/api/short-videos/7677261409160852073/local-action")
    ), true);
    assert.equal(localResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(runtimeOpened, [
      { action: "open-author-folder", path: authorRoot, type: "folder" }
    ], "runtime API wiring must schedule the server-resolved author directory");

    const downloadResponse = {};
    assert.equal(await runtime.routeMedia(
      { method: "GET", headers: {} },
      downloadResponse,
      new URL("http://127.0.0.1/media/short-video/7677261409160852073?download=1")
    ), true);
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloaded?.file?.path, sourcePath, "attachment route must bypass playback renditions and return the original source");
    assert.equal(downloaded?.fileName, path.basename(sourcePath));
  } finally {
    await runtime.stop();
    runtime.store.close();
  }

  console.log(JSON.stringify({
    check: "short-video-local-actions",
    authorFolder: author.path,
    ok: true,
    opened: opened.length
  }, null, 2));
} finally {
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  const relative = path.relative(resolvedSystemTemp, resolvedTempRoot);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    fs.rmSync(resolvedTempRoot, { recursive: true, force: true });
  }
}
