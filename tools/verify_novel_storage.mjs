import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNovelStore } from "../src/modules/novels/server/store.js";
import { paginateNovelCollectionHistory } from "../public/modules/novels/collection-admin.js";

const root = path.resolve(import.meta.dirname, "..");
const storePath = path.join(root, "src", "modules", "novels", "server", "store.js");
const rescanPath = path.join(root, "tools", "rescan_novel_library.py");
const clientPath = path.join(root, "public", "modules", "novels", "novel-page.js");
const collectionClientPath = path.join(root, "public", "modules", "novels", "collection-admin.js");
const clientStylesPath = path.join(root, "public", "modules", "novels", "styles.css");
const routerPath = path.join(root, "public", "js", "router.js");
const dbPath = path.join(root, "data", "novels.sqlite");
const storeSource = fs.readFileSync(storePath, "utf8");
const rescanSource = fs.readFileSync(rescanPath, "utf8");
const clientSource = fs.readFileSync(clientPath, "utf8");
const collectionClientSource = fs.readFileSync(collectionClientPath, "utf8");
const clientStyles = fs.readFileSync(clientStylesPath, "utf8");
const routerSource = fs.readFileSync(routerPath, "utf8");

assert.ok(!storeSource.includes("CREATE VIRTUAL TABLE IF NOT EXISTS novel_search"), "server must not recreate the retired novel FTS table");
assert.ok(!storeSource.includes("INSERT INTO novel_search"), "browser uploads must not maintain the retired novel FTS table");
assert.ok(!storeSource.includes("novel_search MATCH"), "book listing must not query the retired chapter-title FTS index");
assert.ok(!rescanSource.includes("CREATE VIRTUAL TABLE novel_search"), "full rescans must not recreate the retired novel FTS table");
assert.ok(!rescanSource.includes("INSERT INTO novel_search"), "full rescans must not populate the retired novel FTS table");
assert.ok(clientSource.includes('correct.textContent = "校正信息"'), "book details must expose metadata correction");
assert.ok(clientSource.includes('["books", "书库"], ["mine", "我的"], ["rankings", "排行榜"], ["manage", "管理"]'), "novel navigation must keep only primary library destinations");
assert.ok(!clientSource.includes('["authors", "作者"]') && !clientSource.includes('["search", "搜索"]'), "author index and standalone search must not remain as navigation destinations");
assert.ok(clientSource.includes('search.className = "novel-section-search"') && clientSource.includes('input.setAttribute("aria-label", "搜索小说")'), "novel navigation must expose a direct search field");
assert.ok(clientSource.includes('renderHomeLoading("正在读取小说书库")'), "novel section loading must keep the home shell instead of replacing it with a bare loading state");
assert.match(clientSource, /function renderHomeLoading\(message\)[\s\S]*?shell\.append\(renderNovelMenu\(\)\)/, "novel section loading must preserve the top menu");
assert.ok(routerSource.includes('/novels/authors/${encodeRouteSegment(route.novelAuthor)}'), "author profiles must use standalone paths");
assert.ok(clientSource.includes("new IntersectionObserver"), "novel lists must continue loading near the bottom");
assert.ok(clientSource.includes('table.className = "novel-ranking-table"'), "rankings must use a compact list table");
assert.ok(clientSource.includes('["updated", "按日期"') && clientSource.includes('["chars", "按字数"'), "rankings must support date and character-count sorting");
assert.ok(clientSource.includes("rankingPaginationPages(pageCount, page)"), "rankings must expose numbered list pagination");
assert.ok(routerSource.includes('params.set("page", String(next.novelPage + 1))'), "novel list pages must persist in the URL");
assert.ok(clientSource.includes('font: ["yahei", "simsun", "kaiti"].includes(input.font) ? input.font : "yahei"'), "reader font must default to Microsoft YaHei");
assert.ok(clientSource.includes('["yahei", "雅黑"]'), "reader settings must expose the YaHei font choice");
assert.ok(clientSource.includes('stepper("width", 760, 1080, 20'), "reader settings must expose the wider desktop reading range");
assert.ok(clientSource.includes("legacyWidth + 140") && clientSource.includes("widthVersion: 2"), "legacy reader widths must migrate to the wider layout");
assert.ok(clientStyles.includes("var(--novel-font-family"), "reader content must apply the selected font family");
assert.ok(clientStyles.includes("position: sticky"), "novel section navigation must behave like a sticky menu bar");
assert.ok(clientStyles.includes("width: 100vw"), "novel section navigation must span the viewport");
assert.ok(clientStyles.includes("overflow: visible"), "novel view must not trap the sticky menu inside a non-scrolling container");
assert.ok(clientSource.includes('deleteButton.textContent = "删除小说"'), "book correction dialog must expose deletion");
assert.ok(clientSource.includes('deleteButton.textContent = "确认删除"'), "book deletion must require a second confirmation");
assert.ok(clientSource.includes('reimport.textContent = "重新导入"'), "book details must expose single-book reimport");
assert.ok(clientSource.includes('/reimport`'), "the reimport dialog must call the single-book endpoint");
assert.ok(clientSource.includes('all: "1"'), "book details must request the complete catalog");
assert.ok(!clientSource.includes('range.setAttribute("aria-label", "目录分段")'), "chapter catalogs must not expose segmented pagination");
assert.ok(!clientSource.includes('previous.textContent = "上一段"'), "chapter catalogs must not render previous-segment controls");
assert.ok(!clientSource.includes('next.textContent = "下一段"'), "chapter catalogs must not render next-segment controls");
assert.ok(rescanSource.includes('parser.add_argument("--file"'), "the scanner must support a non-destructive single-file reimport mode");
assert.ok(rescanSource.includes("def write_record("), "single-file reimport must update one book without rebuilding the library");
assert.ok(rescanSource.includes("DELETE FROM novel_books WHERE id IN (SELECT book_id FROM novel_book_deletions)"), "full rescans must preserve manual deletions");
assert.ok(clientSource.includes('row.addEventListener("click", () => openBook(book.id))'), "clicking a novel row must open book details");
assert.ok(clientSource.includes("openChapter(book.id, book.chapterCount, { restoreProgress: false })"), "latest chapter links must open the newest chapter");
assert.ok(!clientSource.includes('row.addEventListener("dblclick"'), "novel rows must not require a double click");
assert.ok(!clientSource.includes('state.novel.mode === "books" ? renderRecent'), "library home must not show continue reading");
assert.ok(clientSource.includes('state.novel.mode === "mine" ? renderRecent(entries)'), "mine page must own continue reading");
assert.ok(collectionClientSource.includes("const TASK_HISTORY_PAGE_SIZE = 8"), "collection history must use a bounded page size");
assert.ok(collectionClientSource.includes("activeTasks") && collectionClientSource.includes("historyTasks"), "active collection tasks must stay separate from paged history");
assert.ok(collectionClientSource.includes('section.className = "novel-collection-task-page"'), "collection management must keep creation above the task list");
assert.ok(collectionClientSource.includes('listPanel.className = "novel-collection-panel novel-collection-task-list-panel"'), "collection history must use a dedicated bounded list panel");
assert.ok(collectionClientSource.includes("renderTaskListItem(task)"), "collection history must use compact task list records");
assert.ok(collectionClientSource.includes("expandedTaskIds: new Set()"), "collection state must remember expanded task details");
assert.ok(collectionClientSource.includes("details.open = Boolean(taskId && collection.expandedTaskIds.has(taskId))"), "task detail expansion must survive polling renders");
assert.ok(collectionClientSource.includes('details.addEventListener("toggle"'), "task detail toggles must update persistent collection state");
assert.ok(collectionClientSource.includes("taskLogViews: new Map()"), "collection state must remember each task log viewport");
assert.ok(collectionClientSource.includes("followLatest: maxScrollTop - log.scrollTop <= 24"), "task logs must follow new lines only while the reader remains near the bottom");
assert.ok(collectionClientSource.includes("queueMicrotask(restoreTaskLogView)"), "expanded task logs must restore their viewport after polling renders");
assert.ok(collectionClientSource.includes("function patchPolledTaskRows(collection)"), "collection polling must patch existing task rows");
assert.ok(collectionClientSource.includes("log.append(document.createTextNode(nextText.slice(currentText.length)))"), "collection polling must append new log text when the tail is continuous");
assert.ok(collectionClientSource.includes("function updateFactValue(item, value)"), "collection polling must update progress facts without rebuilding task details");
assert.match(collectionClientSource, /if \(canPatchPolledTasks\(previousTasks, collection\.tasks\)\) \{\s*patchPolledTaskRows\(collection\);\s*\} else \{\s*rerender\(\);/, "collection polling must rebuild only when task structure changes");
assert.ok(collectionClientSource.includes('listDescription.textContent = `共 ${formatNumber(collection.tasks.length)} 条任务记录'), "task list must show the total record count");
assert.ok(collectionClientSource.includes('aria-label", "任务记录分页"'), "collection history must expose accessible pagination");
assert.ok(collectionClientSource.includes('actionButton("打开验证页"'), "AliceSW captcha failures must expose the manual verification page");
assert.ok(collectionClientSource.includes('openAliceswCredentialEditor({') && collectionClientSource.includes("retryTaskId: task.id"), "AliceSW captcha failures must connect credential setup to the original task");
assert.ok(collectionClientSource.includes('await mutateTask(retryTaskId, "run")'), "successful AliceSW credential checks must resume the original task");
assert.ok(collectionClientSource.includes("function aliceswVerificationUrl(task = {})"), "collection tasks must diagnose AliceSW verification failures before offering retry");
assert.ok(collectionClientSource.includes('renderAdapters(collection, { embedded: true })'), "configuration must render adapters in its own primary section");
assert.ok(clientSource.includes('overview.className = "novel-management-overview"'), "novel management maintenance actions must use a compact overview");
assert.ok(clientStyles.includes(".novel-collection-task-list-section.active .novel-collection-task-list-rows"), "active task queues must stay height-bounded");
assert.ok(clientSource.includes('shell.className = "novel-management-console"'), "novel management must use a dedicated console shell");
assert.ok(clientSource.includes("shell.append(sidebar, main)"), "management navigation must stay left of the independently scrolling content pane");
assert.ok(clientSource.includes('nav.setAttribute("aria-label", "小说管理功能")'), "novel management must expose accessible primary navigation");
assert.ok(clientSource.includes('["upload", "01", "书库上传"') && clientSource.includes('["collect", "02", "采集任务"') && clientSource.includes('["config", "03", "站点配置"'), "management navigation must separate upload, collection, and configuration");
assert.ok(clientStyles.includes("grid-template-columns: 238px minmax(0, 1fr)"), "desktop management must keep fixed navigation left and flexible content right");
assert.match(clientStyles, /\.novel-management-main\s*\{[\s\S]*?overflow-y: auto;/, "management scrolling must belong to the right content pane");

const historyFixtures = Array.from({ length: 21 }, (_, index) => ({
  id: `task-${index + 1}`,
  name: index === 10 ? "目标任务" : `采集任务 ${index + 1}`,
  adapterName: index % 2 ? "通用适配器" : "内置适配器",
  startUrl: `https://example.com/book/${index + 1}`,
  status: index % 3 === 0 ? "failed" : "succeeded"
}));
historyFixtures.push({ id: "task-active", name: "执行中任务", status: "running" });
const secondHistoryPage = paginateNovelCollectionHistory(historyFixtures, { page: 1 });
assert.equal(secondHistoryPage.total, 21, "active collection tasks must not enter history pagination");
assert.equal(secondHistoryPage.pageCount, 3, "21 history tasks must produce three pages at eight records per page");
assert.equal(secondHistoryPage.tasks.length, 8, "middle history pages must stay bounded to eight records");
const searchedHistory = paginateNovelCollectionHistory(historyFixtures, { query: "目标任务" });
assert.equal(searchedHistory.total, 1, "history search must match task names");
assert.equal(searchedHistory.tasks[0].id, "task-11");
const failedHistory = paginateNovelCollectionHistory(historyFixtures, { filter: "failed" });
assert.equal(failedHistory.total, 7, "history status filters must apply before pagination");

globalThis.window = { location: { href: "http://127.0.0.1:29998/novels", search: "", hash: "" } };
const { routeFromUrl, routeUrl } = await import("../public/js/router.js");
const authorRoute = routeFromUrl("http://127.0.0.1:29998/novels/authors/%E4%B8%81%E5%A2%A8");
assert.equal(authorRoute.novelMode, "author");
assert.equal(authorRoute.novelAuthor, "丁墨");
assert.equal(routeUrl(authorRoute), "/novels/authors/%E4%B8%81%E5%A2%A8");
const removedAuthorIndexRoute = routeFromUrl("http://127.0.0.1:29998/novels/authors");
assert.equal(removedAuthorIndexRoute.novelMode, "books");
assert.equal(removedAuthorIndexRoute.novelAuthor, "");
assert.equal(routeUrl(removedAuthorIndexRoute), "/novels");
const manageRoute = routeFromUrl("http://127.0.0.1:29998/novels/manage");
assert.equal(manageRoute.novelMode, "manage");
assert.equal(routeUrl(manageRoute), "/novels/manage");
const searchRoute = routeFromUrl("http://127.0.0.1:29998/novels/search?q=%E5%A4%A7%E6%98%8E");
assert.equal(searchRoute.novelMode, "books");
assert.equal(searchRoute.novelQuery, "大明");
assert.equal(routeUrl(searchRoute), "/novels?q=%E5%A4%A7%E6%98%8E");
const rankingsRoute = routeFromUrl("http://127.0.0.1:29998/novels/rankings");
assert.equal(rankingsRoute.novelMode, "rankings");
assert.equal(rankingsRoute.novelSort, "chars");
assert.equal(routeUrl(rankingsRoute), "/novels/rankings");
const datedRankingsRoute = routeFromUrl("http://127.0.0.1:29998/novels/rankings?sort=updated&page=34");
assert.equal(datedRankingsRoute.novelMode, "rankings");
assert.equal(datedRankingsRoute.novelSort, "updated");
assert.equal(datedRankingsRoute.novelPage, 33);
assert.equal(routeUrl(datedRankingsRoute), "/novels/rankings?sort=updated&page=34");
const mineRoute = routeFromUrl("http://127.0.0.1:29998/novels/mine");
assert.equal(mineRoute.novelMode, "mine");
assert.equal(mineRoute.novelSort, "progress");
assert.equal(routeUrl(mineRoute), "/novels/mine");
delete globalThis.window;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-storage-"));
const tempDbPath = path.join(tempDir, "novels.sqlite");
const tempStore = createNovelStore({ dbPath: tempDbPath });
try {
  const uploaded = tempStore.uploadBook({
    fileName: "回归测试.txt",
    author: "测试作者",
    text: "第一章 开始\n\n这是第一章。\n\n第二章 继续\n\n这是第二章。"
  });
  assert.equal(uploaded.book.title, "回归测试");
  assert.equal(uploaded.book.author, "测试作者");
  assert.equal(uploaded.book.chapterCount, 2);
  assert.equal(uploaded.chapters.length, 2);
  tempStore.saveProgress(uploaded.book.id, { chapterIndex: 1, scrollRatio: 0.5 });
  const corrected = tempStore.updateBookMetadata(uploaded.book.id, {
    title: "校正后的书名",
    author: "校正作者",
    category: "校正分类",
    summary: "人工校正简介"
  });
  assert.equal(corrected.title, "校正后的书名");
  assert.equal(corrected.author, "校正作者");
  tempStore.saveProgress(uploaded.book.id, { chapterIndex: 2, scrollRatio: 0.75 });
  const reimported = tempStore.reimportBook(uploaded.book.id, {
    fileName: "回归测试.txt",
    text: "第一章 重新导入\n\n这是重新导入后的正文。"
  });
  assert.equal(reimported.book.id, uploaded.book.id, "browser TXT reimport must keep the original book ID");
  assert.equal(reimported.book.chapterCount, 1);
  assert.equal(reimported.book.title, "校正后的书名", "reimport must retain corrected title");
  assert.equal(reimported.book.author, "校正作者", "reimport must retain corrected author");
  assert.equal(reimported.book.category, "校正分类", "reimport must retain corrected category");
  assert.equal(reimported.book.summary, "人工校正简介", "reimport must retain corrected summary");
  assert.equal(reimported.book.progress.chapterIndex, 1, "reimport must clamp progress when the new catalog is shorter");
  assert.equal(reimported.book.progress.scrollRatio, 0, "clamped reimport progress must start at the surviving chapter");
  const authorPage = tempStore.authorDetail("校正作者", new URL("http://127.0.0.1/api/novels/authors/%E6%A0%A1%E6%AD%A3%E4%BD%9C%E8%80%85?limit=48"));
  assert.equal(authorPage.author.bookCount, 1);
  assert.equal(authorPage.books[0].id, uploaded.book.id);
  const download = tempStore.openDownload(uploaded.book.id);
  assert.equal(download.header, "校正后的书名\n\n", "TXT export header must contain only the title");
  let exported = download.header;
  for (let chunk = download.nextChunk(); chunk !== null; chunk = download.nextChunk()) exported += chunk;
  download.close();
  assert.ok(!exported.includes("作者："), "TXT export must not prepend author metadata");
  assert.ok(!exported.includes("分类："), "TXT export must not prepend category metadata");
  const longer = tempStore.uploadBook({
    fileName: "长篇回归.txt",
    author: "长篇作者",
    text: `第一章 长篇\n\n${"较长正文".repeat(500)}`
  });
  const rankings = tempStore.listBooks(new URL("http://127.0.0.1/api/novels?sort=chars&limit=10"));
  assert.equal(rankings.sort, "chars");
  assert.equal(rankings.books[0].id, longer.book.id, "character ranking must put the longest book first");
  const catalogBook = tempStore.uploadBook({
    fileName: "完整目录回归.txt",
    text: Array.from(
      { length: 245 },
      (_, index) => `第 ${index + 1} 章 目录回归 ${index + 1}\n\n这是正文 ${index + 1}。`
    ).join("\n\n")
  });
  const completeCatalog = tempStore.catalog(
    catalogBook.book.id,
    new URL(`http://127.0.0.1/api/novels/${catalogBook.book.id}/catalog?all=1`)
  );
  assert.equal(completeCatalog.all, true);
  assert.equal(completeCatalog.total, 245);
  assert.equal(completeCatalog.chapters.length, 245, "complete catalog mode must return every chapter without segmentation");
  assert.equal(completeCatalog.offset, 0);
  const mine = tempStore.listBooks(new URL("http://127.0.0.1/api/novels?reading=1&sort=progress&limit=10"));
  assert.equal(mine.readingOnly, true);
  assert.equal(mine.total, 1);
  assert.equal(mine.books[0].id, uploaded.book.id, "mine page must include only books with reading progress");

  const localRoot = path.join(tempDir, "local-library");
  const localSource = path.join(localRoot, "本地重新导入.txt");
  fs.mkdirSync(localRoot, { recursive: true });
  fs.writeFileSync(localSource, "第一章 初始\n\n初始正文。\n\n第二章 继续\n\n后续正文。", "utf8");
  const localBookId = crypto
    .createHash("sha1")
    .update(path.resolve(localSource).replaceAll("\\", "/").toLowerCase())
    .digest("hex")
    .slice(0, 20);
  tempStore.invalidate();
  const pythonCommand = process.env.PYTHON || "python";
  const firstImport = spawnSync(
    pythonCommand,
    [
      rescanPath,
      "--db",
      tempDbPath,
      "--file",
      localSource,
      "--source-root",
      localRoot,
      "--book-id",
      localBookId
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      windowsHide: true
    }
  );
  assert.equal(firstImport.status, 0, firstImport.stderr || firstImport.stdout);
  assert.equal(tempStore.bookMeta(localBookId).book.chapterCount, 2);
  tempStore.saveProgress(localBookId, { chapterIndex: 2, scrollRatio: 0.6 });
  tempStore.updateBookMetadata(localBookId, {
    title: "本地校正书名",
    author: "本地校正作者",
    category: "本地校正分类",
    summary: "本地人工简介"
  });
  fs.writeFileSync(localSource, "第一章 更新\n\n更新后的正文。", "utf8");
  tempStore.invalidate();
  const secondImport = spawnSync(
    pythonCommand,
    [
      rescanPath,
      "--db",
      tempDbPath,
      "--file",
      localSource,
      "--source-root",
      localRoot,
      "--book-id",
      localBookId
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      windowsHide: true
    }
  );
  assert.equal(secondImport.status, 0, secondImport.stderr || secondImport.stdout);
  const localReimported = tempStore.bookMeta(localBookId).book;
  assert.equal(localReimported.id, localBookId);
  assert.equal(localReimported.chapterCount, 1, "single-file reimport must replace the old catalog");
  assert.equal(localReimported.title, "本地校正书名", "single-file reimport must retain metadata overrides");
  assert.equal(localReimported.progress.chapterIndex, 1, "single-file reimport must clamp reading progress");
  assert.equal(localReimported.progress.scrollRatio, 0);
  tempStore.deleteBook(localBookId);

  tempStore.deleteBook(catalogBook.book.id);
  const deleted = tempStore.deleteBook(uploaded.book.id);
  assert.equal(deleted.id, uploaded.book.id);
  assert.equal(tempStore.bookMeta(uploaded.book.id), null, "deleted books must disappear from the library");
  tempStore.deleteBook(longer.book.id);
  assert.equal(tempStore.summary().totals.books, 0, "deleted books must leave summary totals");
  tempStore.invalidate();
  const tempDb = new DatabaseSync(tempDbPath, { readOnly: true });
  assert.equal(tempDb.prepare("SELECT name FROM sqlite_master WHERE name = 'novel_search'").get(), undefined, "new databases must not create the retired FTS table");
  assert.equal(Number(tempDb.prepare("SELECT COUNT(*) AS value FROM novel_books").get().value), 0, "deleted books must be removed");
  assert.equal(Number(tempDb.prepare("SELECT COUNT(*) AS value FROM novel_chapters").get().value), 0, "deleted book chapters must be removed");
  assert.equal(Number(tempDb.prepare("SELECT COUNT(*) AS value FROM novel_book_overrides").get().value), 0, "deleted book corrections must be removed");
  assert.equal(Number(tempDb.prepare("SELECT COUNT(*) AS value FROM novel_book_deletions").get().value), 4, "deleted books must leave rescan tombstones");
  tempDb.close();
} finally {
  tempStore.invalidate();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let database = null;
let counts = null;
if (fs.existsSync(dbPath)) {
  database = new DatabaseSync(dbPath, { readOnly: true });
  const legacy = database.prepare("SELECT name FROM sqlite_master WHERE name = 'novel_search'").get();
  assert.equal(legacy, undefined, "live novel database must not retain the retired novel FTS table");
  counts = {
    books: Number(database.prepare("SELECT COUNT(*) AS value FROM novel_books").get().value || 0),
    chapters: Number(database.prepare("SELECT COUNT(*) AS value FROM novel_chapters").get().value || 0)
  };
  database.close();
}

console.log(`novel-storage: ok${counts ? ` (${counts.books} books, ${counts.chapters} chapters, no FTS)` : " (source only)"}`);
