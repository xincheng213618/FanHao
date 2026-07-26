import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createNovelCollectionService } from "../src/modules/novels/server/collection-service.js";
import { createNovelCredentialService } from "../src/modules/novels/server/credential-service.js";
import { createNovelSettingsProvider } from "../src/modules/novels/server/settings.js";
import { createNovelStore } from "../src/modules/novels/server/store.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-collection-"));
const novelsDbPath = path.join(tempDir, "novels.sqlite");
const collectionDbPath = path.join(tempDir, "novel-collection.sqlite");
const outputRoot = path.join(tempDir, "jobs");
const credentialRoot = path.join(tempDir, "credentials");
const novelStore = createNovelStore({ dbPath: novelsDbPath });
let fixtureRevision = 1;
let blockResumeChapterTwo = true;
const requestCounts = new Map();
const aliceswCookieHeaders = [];

const fixtureServer = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  requestCounts.set(url.pathname, Number(requestCounts.get(url.pathname) || 0) + 1);
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
  if (url.pathname === "/resume-catalog") {
    res.end(`
      <!doctype html>
      <h1 id="book-title">断点续采回归小说</h1>
      <p class="author">作者：断点作者</p>
      <div class="chapters">
        <a class="chapter" href="/resume-chapter-1">第一章 已保存</a>
        <a class="chapter" href="/resume-chapter-2">第二章 待继续</a>
      </div>
    `);
    return;
  }
  if (url.pathname === "/resume-chapter-1") {
    res.end(`
      <!doctype html>
      <h1 class="chapter-title">第一章 已保存</h1>
      <article class="body"><p>第一章只应该请求一次。</p></article>
    `);
    return;
  }
  if (url.pathname === "/resume-chapter-2") {
    if (blockResumeChapterTwo) {
      req.on("close", () => {});
      return;
    }
    res.end(`
      <!doctype html>
      <h1 class="chapter-title">第二章 待继续</h1>
      <article class="body"><p>第二章在服务重启后完成。</p></article>
    `);
    return;
  }
  if (url.pathname === "/alicesw-catalog") {
    res.end(`
      <!doctype html>
      <h1>爱丽丝采集回归小说</h1>
      <p>作者：回归作者</p>
      <div class="warpper">
        <a href="/book/fixture/chapter-1.html">第1章</a>
      </div>
    `);
    return;
  }
  if (url.pathname === "/book/fixture/chapter-1.html") {
    aliceswCookieHeaders.push(String(req.headers.cookie || ""));
    res.end(`
      <!doctype html>
      <div id="j_readMainWrap">
        <div id="j_chapterBox">
          <div id="ajaxchapter-fixture" class="text-wrap">
            <div class="main-text-wrap">
              <div class="text-head">
                <h3>第1章</h3>
                <div class="text-info">
                  <i><span class="book-name">爱丽丝采集回归小说</span></i>
                  <i><span class="author-name">回归作者</span></i>
                  <i><span class="j_chapterWordCut">7821</span>字</i>
                  <i><span>2024-03-04 19:13</span></i>
                </div>
              </div>
              <div class="read-content j_readContent user_ad_content">
                <p>这是爱丽丝正文第一段。</p>
                <p>这是爱丽丝正文第二段。</p>
              </div>
            </div>
          </div>
        </div>
        <div class="chapter-control">上一章 下一章</div>
      </div>
    `);
    return;
  }
  if (url.pathname === "/alicesw-captcha-catalog") {
    res.end(`
      <!doctype html>
      <h1>访问验证回归小说</h1>
      <div class="warpper">
        <a href="/book/fixture/captcha.html">第1章</a>
      </div>
    `);
    return;
  }
  if (url.pathname === "/book/fixture/captcha.html") {
    res.end(`
      <!doctype html>
      <title>访问验证</title>
      <h1>访问验证</h1>
      <p>当前访问行为触发了安全验证，请输入验证码后继续阅读。</p>
    `);
    return;
  }
  res.end("<h1>not found</h1>");
});

const address = await listen(fixtureServer);
const baseUrl = `http://127.0.0.1:${address.port}`;
const fixtureCookie = "server_name_session=fixture-session; lf_user_auth=fixture-user; lf_user_auth_sign=fixture-sign";
const credentialService = createNovelCredentialService({
  credentialRoot,
  pythonPath: process.env.PYTHON || "python"
});
const settingsProvider = createNovelSettingsProvider({ credentialService });
assert.equal(settingsProvider.read().status.fields.aliceswCookie.configured, false);
settingsProvider.update({ aliceswCookie: fixtureCookie });
assert.equal(settingsProvider.read().status.fields.aliceswCookie.configured, true);
assert.deepEqual(settingsProvider.read().values, {}, "write-only Cookie must never be returned by settings");
assert.doesNotMatch(JSON.stringify(settingsProvider.read()), /fixture-session/, "settings status must not expose Cookie values");
const service = createNovelCollectionService({
  credentialService,
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
  assert.equal(initial.credentials.alicesw.configured, true);
  assert.doesNotMatch(JSON.stringify(initial), /fixture-session/, "collection snapshot must not expose Cookie values");

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

  const resumableTask = service.createTask({
    name: "断点续采回归",
    url: `${baseUrl}/resume-catalog`,
    adapterId: adapter.id,
    mode: "collect"
  }).task;
  const checkpointed = await waitForCheckpoint(service, resumableTask.id, 1);
  assert.equal(checkpointed.status, "running", "task must still be running when its first checkpoint is stored");
  const firstChapterRequests = Number(requestCounts.get("/resume-chapter-1") || 0);
  assert.equal(firstChapterRequests, 1, "the first chapter should have been fetched exactly once before restart");
  const checkpointPath = path.join(outputRoot, resumableTask.id, "checkpoint.json");
  const firstCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  assert.equal(firstCheckpoint.chapters.length, 1, "checkpoint file must persist each completed chapter immediately");

  await service.stop();
  const interrupted = service.taskDetail(resumableTask.id);
  assert.equal(interrupted.status, "failed", "stopping the service must leave the task available for retry");
  assert.equal(interrupted.checkpointCount, 1, "service restart must retain the completed chapter count");

  blockResumeChapterTwo = false;
  service.start();
  const reused = service.createTask({
    name: "断点续采回归",
    url: `${baseUrl}/resume-catalog`,
    adapterId: adapter.id,
    mode: "collect"
  });
  assert.equal(reused.task.id, resumableTask.id, "same URL and mode must reuse the original task record");
  assert.equal(reused.reused, true);
  assert.equal(reused.resumed, true, "failed task with a checkpoint must resume instead of starting over");
  const resumed = await waitForTask(service, resumableTask.id, 2);
  assert.equal(resumed.status, "succeeded", resumed.error || resumed.message);
  assert.equal(resumed.checkpointCount, 2);
  assert.equal(
    Number(requestCounts.get("/resume-chapter-1") || 0),
    firstChapterRequests,
    "resumed task must not fetch a checkpointed chapter again"
  );
  assert.equal(
    service.listTasks().tasks.filter((task) => task.startUrl === `${baseUrl}/resume-catalog` && task.mode === "collect").length,
    1,
    "repeated creation must not add duplicate cards for the same collection"
  );
  assert.match(
    fs.readFileSync(path.join(outputRoot, resumableTask.id, "collector.log"), "utf8"),
    /attempt 1 started[\s\S]*attempt 2 started/,
    "task log must retain attempt history"
  );

  const aliceswTask = service.createTask({
    name: "爱丽丝正文容器回归",
    url: `${baseUrl}/alicesw-catalog`,
    adapterId: "alicesw",
    mode: "collect"
  }).task;
  const aliceswCollected = await waitForTask(service, aliceswTask.id);
  assert.equal(aliceswCollected.status, "succeeded", aliceswCollected.error || aliceswCollected.message);
  const aliceswChapter = novelStore.chapterDetail(aliceswCollected.bookId, 1).chapter;
  assert.equal(aliceswChapter.content, "这是爱丽丝正文第一段。\n\n这是爱丽丝正文第二段。");
  assert.doesNotMatch(aliceswChapter.content, /爱丽丝采集回归小说|回归作者|7821|2024-03-04/, "AliceSW metadata must stay outside the stored body");
  assert.ok(aliceswCookieHeaders.some((value) => value.includes("server_name_session=fixture-session")), "AliceSW requests must receive the saved Cookie");
  const aliceswTaskConfig = fs.readFileSync(path.join(outputRoot, aliceswTask.id, "task.json"), "utf8");
  assert.doesNotMatch(aliceswTaskConfig, /fixture-session/, "task files must contain only the credential file path");

  const captchaTask = service.createTask({
    name: "爱丽丝访问验证识别回归",
    url: `${baseUrl}/alicesw-captcha-catalog`,
    adapterId: "alicesw",
    mode: "test"
  }).task;
  const captchaFailure = await waitForTask(service, captchaTask.id);
  assert.equal(captchaFailure.status, "failed");
  assert.match(captchaFailure.error, /访问验证码/);
  assert.doesNotMatch(captchaFailure.error, /正文容器/, "captcha pages must not be misreported as selector failures");

  assert.ok(fs.existsSync(path.join(outputRoot, collectTask.id, "collector.log")));
  assert.ok(fs.existsSync(path.join(outputRoot, collectTask.id, "result.json")));
  console.log("novel-collection: ok (credentials, captcha diagnosis, logs, checkpoint resume, task reuse)");
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

async function waitForCheckpoint(collectionService, taskId, minimumCount) {
  for (let index = 0; index < 300; index += 1) {
    const task = collectionService.taskDetail(taskId);
    if (task?.checkpointCount >= minimumCount) return task;
    if (task && ["failed", "cancelled", "succeeded"].includes(task.status)) {
      throw new Error(task.error || task.message || `task ${taskId} stopped before checkpoint`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for checkpoint on novel collection task ${taskId}`);
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
