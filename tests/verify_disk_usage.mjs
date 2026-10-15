import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createDiskUsageStore } from "../src/modules/fanhao/server/disk-usage/store.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";

const fixture = createFixture();
try {
  const outputPath = path.join(fixture.cacheDir, "c-fixture.sqlite");
  const result = await scanFixture(fixture.root, outputPath, fixture.allowedLinkedRoots);
  assert.equal(result.files, 6);
  assert.equal(result.directories, 4);
  assert.equal(result.bytes, 460);

  const database = new DatabaseSync(outputPath, { readOnly: true });
  try {
    const rootRow = database.prepare("SELECT * FROM nodes WHERE path = ?").get(fixture.root);
    assert.equal(rootRow.size_bytes, 460);
    assert.equal(rootRow.file_count, 6);
    assert.equal(rootRow.directory_count, 4);
  } finally {
    database.close();
  }

  const driveId = path.parse(fixture.root).root.slice(0, 1).toUpperCase();
  fs.writeFileSync(path.join(fixture.cacheDir, `${driveId.toLowerCase()}.json`), JSON.stringify({
    bytes: result.bytes,
    completedAt: result.completedAt,
    databaseFile: path.basename(outputPath),
    directories: result.directories,
    driveId,
    errors: result.errors,
    files: result.files,
    linkedRoots: fixture.allowedLinkedRoots,
    nodes: result.nodes,
    root: fixture.root,
    scanId: "fixture",
    schemaVersion: 1,
    skipped: result.skipped,
    startedAt: result.startedAt
  }), "utf8");

  const store = createDiskUsageStore({
    cacheDir: fixture.cacheDir,
    excludedNames: ["$RECYCLE.BIN"],
    sources: [{ path: fixture.root, label: "测试资料" }, { path: fixture.allowedLinkedRoots[0], label: "链接资料" }]
  });
  store.start();
  const summary = store.summary();
  assert.equal(summary.cacheOnly, true);
  assert.equal(summary.drives.length, 1);
  assert.equal(summary.drives[0].cache.scanId, "fixture");
  assert.equal(summary.drives[0].cacheNeedsRefresh, false);
  assert.deepEqual(summary.drives[0].monitoredLinks, fixture.allowedLinkedRoots);
  assert.equal(summary.drives[0].task, null, "opening the store must not start a scan");

  const tree = store.tree(driveId, fixture.root, 100, 7);
  assert.equal(tree.node.size, 460);
  assert.deepEqual(tree.children.map((item) => item.name), ["Videos", "Linked", "Images", "readme.txt"]);
  assert.deepEqual(tree.children[0].treemapChildren.map((item) => item.name), ["large.mp4", "small.mp4", "Series"]);
  assert.deepEqual(tree.children[0].treemapChildren[2].treemapChildren.map((item) => item.name), ["episode.mp4"]);
  assert.deepEqual(tree.children[1].treemapChildren.map((item) => item.name), ["linked.mp4"]);
  const nested = store.tree(driveId, path.join(fixture.root, "Videos"), 100);
  assert.deepEqual(nested.children.map((item) => item.name), ["large.mp4", "small.mp4", "Series"]);
  const search = store.search(driveId, "large", 20);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].size, 200);
  assert.throws(() => store.cachedNode(driveId, "Z:\\outside.txt"), /不在所选监控磁盘|未知的监控磁盘/);
  await store.stop();

  const staticServer = createStaticFileServer({
    publicDir: path.resolve("public"),
    mimeTypes: { ".html": "text/html" },
    normalizeExt: (value) => path.extname(value).toLowerCase(),
    notFound: () => {}
  });
  assert.equal(staticServer.publicFilePath("/disk-usage"), path.resolve("public/modules/fanhao/disk-usage/index.html"));
  console.log("disk-usage: ok");
} finally {
  fixture.cleanup();
}

function scanFixture(root, outputPath, allowedLinkedRoots = []) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../src/modules/fanhao/server/disk-usage/scan-worker.js", import.meta.url), {
      workerData: { allowedLinkedRoots, excludedNames: ["$RECYCLE.BIN"], outputPath, root, scanId: "fixture" }
    });
    worker.on("message", (message) => {
      if (message.type === "complete") resolve(message.result);
      if (message.type === "failed") reject(new Error(message.error));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`scan worker exited ${code}`));
    });
  });
}

function createFixture() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-disk-usage-"));
  const root = path.join(baseDir, "library");
  const linkedTarget = path.join(baseDir, "linked-target");
  const linkedRoot = path.join(root, "Linked");
  const cacheDir = path.join(baseDir, "cache");
  fs.mkdirSync(path.join(root, "Videos"), { recursive: true });
  fs.mkdirSync(path.join(root, "Videos", "Series"), { recursive: true });
  fs.mkdirSync(path.join(root, "Images"), { recursive: true });
  fs.mkdirSync(linkedTarget, { recursive: true });
  fs.symlinkSync(linkedTarget, linkedRoot, "junction");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(root, "Videos", "large.mp4"), Buffer.alloc(200));
  fs.writeFileSync(path.join(root, "Videos", "small.mp4"), Buffer.alloc(100));
  fs.writeFileSync(path.join(root, "Videos", "Series", "episode.mp4"), Buffer.alloc(40));
  fs.writeFileSync(path.join(root, "Images", "cover.jpg"), Buffer.alloc(50));
  fs.writeFileSync(path.join(root, "readme.txt"), Buffer.alloc(10));
  fs.writeFileSync(path.join(linkedTarget, "linked.mp4"), Buffer.alloc(60));
  const canonicalBase = fs.realpathSync.native(baseDir);
  return {
    baseDir,
    allowedLinkedRoots: [linkedRoot],
    cacheDir,
    root,
    cleanup() {
      const resolved = fs.realpathSync.native(baseDir);
      const tempRoot = fs.realpathSync.native(os.tmpdir());
      if (resolved !== canonicalBase || !resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith("fanhao-disk-usage-")) {
        throw new Error("refusing to clean an unexpected disk-usage fixture path");
      }
      fs.rmSync(resolved, { recursive: true, force: false });
    }
  };
}
