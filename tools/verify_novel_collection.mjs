import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createNovelCollectionService } from "../src/modules/novels/server/collection-service.js";
import { createNovelStore } from "../src/modules/novels/server/store.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-collection-"));
const novelsDbPath = path.join(tempDir, "novels.sqlite");
const collectionDbPath = path.join(tempDir, "novel-collection.sqlite");
const outputRoot = path.join(tempDir, "jobs");
const novelStore = createNovelStore({ dbPath: novelsDbPath });
let fixtureRevision = 1;

const fixtureServer = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (url.pathname === "/catalog") {
    res.end(`
      <!doctype html>
      <h1 id="book-title">采集回归小说</h1>
      <p class="author">作者：回归作者</p>
      <div class="chapters"><a class="chapter" href="/chapter-1">第一章 开始</a></div>
      <a class="next-catalog" href="/catalog-2">下一页</a>
    `);
    return;
  }
  if (url.pathname === "/catalog-2") {
    res.end(`
      <!doctype html>
      <div class="chapters"><a class="chapter" href="/chapter-2">第二章 继续</a></div>
    `);
    return;
  }
  if (url.pathname === "/chapter-1") {
    res.end(`
      <!doctype html>
      <h1 class="chapter-title">第一章 开始</h1>
      <article class="body"><p>这是第一章正文，版本 ${fixtureRevision}。</p><div class="ad">广告应移除</div></article>
    `);
    return;
  }
  if (url.pathname === "/chapter-2" && !url.searchParams.has("page")) {
    res.end(`
      <!doctype html>
      <h1 class="chapter-title">第二章 继续</h1>
      <article class="body"><p>这是第二章上半段。</p></article>
      <a class="next-page" href="/chapter-2?page=2">下一页</a>
    `);
    return;
  }
  if (url.pathname === "/chapter-2" && url.searchParams.get("page") === "2") {
    res.end(`
      <!doctype html>
      <article class="body"><p>这是第二章下半段。</p></article>
    `);
    return;
  }
  res.end("<h1>not found</h1>");
});

const address = await listen(fixtureServer);
const baseUrl = `http://127.0.0.1:${address.port}`;
const service = createNovelCollectionService({
  dbPath: collectionDbPath,
  novelStore,
  outputRoot,
  projectRoot,
  pythonPath: process.env.PYTHON || "python"
});

try {
  service.start();
  assert.equal(service.runtimeStatus().ready, true, service.runtimeStatus().error);
  const initial = service.snapshot();
  assert.equal(initial.adapters.length, 3, "three built-in adapters must be available");

  const adapter = service.createAdapter({
    name: "本地回归站",
    description: "验证目录分页、章节分页、正文清理与结构化导入",
    matchHosts: ["127.0.0.1"],
    config: {
      bookTitleSelector: "#book-title",
      authorSelector: ".author",
      catalogSelector: ".chapters",
      chapterLinkSelector: "a.chapter",
      chapterTitleSelector: ".chapter-title",
      contentSelector: "article.body",
      removeSelectors: [".ad"],
      catalogNextSelector: "a.next-catalog",
      chapterNextSelector: "a.next-page",
      delayMs: 0,
      timeoutMs: 5000
    }
  }).adapter;
  assert.equal(adapter.driver, "generic");
  assert.equal(service.snapshot().adapters.length, 4);

  const testTask = service.createTask({
    name: "测试自定义适配",
    url: `${baseUrl}/catalog`,
    adapterId: adapter.id,
    mode: "test"
  }).task;
  const tested = await waitForTask(service, testTask.id);
  assert.equal(tested.status, "succeeded", tested.error || tested.message);
  assert.equal(tested.result.chapterCount, 1, "test mode must only fetch one chapter");
  assert.equal(novelStore.summary().totals.books, 0, "test mode must not import a book");

  const collectTask = service.createTask({
    name: "完整采集回归",
    url: `${baseUrl}/catalog`,
    adapterId: adapter.id,
    mode: "collect"
  }).task;
  const collected = await waitForTask(service, collectTask.id);
  assert.equal(collected.status, "succeeded", collected.error || collected.message);
  assert.ok(collected.bookId, "completed collection task must expose the imported book id");
  const firstBook = novelStore.bookDetail(collected.bookId);
  assert.equal(firstBook.book.title, "采集回归小说");
  assert.equal(firstBook.book.author, "回归作者");
  assert.equal(firstBook.book.chapterCount, 2);
  assert.equal(firstBook.chapters.length, 2);
  assert.match(novelStore.chapterDetail(collected.bookId, 2).chapter.content, /上半段[\s\S]*下半段/);
  assert.doesNotMatch(novelStore.chapterDetail(collected.bookId, 1).chapter.content, /广告应移除/);

  novelStore.saveProgress(collected.bookId, { chapterIndex: 2, scrollRatio: 0.4 });
  fixtureRevision = 2;
  service.runTask(collectTask.id);
  const rerun = await waitForTask(service, collectTask.id, 2);
  assert.equal(rerun.status, "succeeded", rerun.error || rerun.message);
  assert.equal(rerun.bookId, collected.bookId, "same source URL must update the existing book");
  assert.equal(novelStore.summary().totals.books, 1, "rerunning a source must not duplicate the book");
  assert.match(novelStore.chapterDetail(collected.bookId, 1).chapter.content, /版本 2/);
  assert.equal(novelStore.bookMeta(collected.bookId).book.progress.chapterIndex, 2, "collection updates must preserve reading progress");

  assert.ok(fs.existsSync(path.join(outputRoot, collectTask.id, "collector.log")));
  assert.ok(fs.existsSync(path.join(outputRoot, collectTask.id, "result.json")));
  console.log("novel-collection: ok (custom adapter, test, import, pagination, update)");
} finally {
  await service.stop();
  novelStore.invalidate();
  await closeServer(fixtureServer);
  const resolvedTemp = path.resolve(tempDir);
  if (!resolvedTemp.startsWith(path.resolve(os.tmpdir()))) {
    throw new Error(`refusing to remove unexpected temp path: ${resolvedTemp}`);
  }
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}

async function waitForTask(collectionService, taskId, minimumAttempt = 1) {
  for (let index = 0; index < 300; index += 1) {
    const task = collectionService.taskDetail(taskId);
    if (task && task.attempt >= minimumAttempt && ["succeeded", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for novel collection task ${taskId}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
