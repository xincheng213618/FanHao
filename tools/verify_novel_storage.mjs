import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNovelStore } from "../src/modules/novels/server/store.js";

const root = path.resolve(import.meta.dirname, "..");
const storePath = path.join(root, "src", "modules", "novels", "server", "store.js");
const rescanPath = path.join(root, "tools", "rescan_novel_library.py");
const clientPath = path.join(root, "public", "modules", "novels", "novel-page.js");
const clientStylesPath = path.join(root, "public", "modules", "novels", "styles.css");
const routerPath = path.join(root, "public", "js", "router.js");
const dbPath = path.join(root, "data", "novels.sqlite");
const storeSource = fs.readFileSync(storePath, "utf8");
const rescanSource = fs.readFileSync(rescanPath, "utf8");
const clientSource = fs.readFileSync(clientPath, "utf8");
const clientStyles = fs.readFileSync(clientStylesPath, "utf8");
const routerSource = fs.readFileSync(routerPath, "utf8");

assert.ok(!storeSource.includes("CREATE VIRTUAL TABLE IF NOT EXISTS novel_search"), "server must not recreate the retired novel FTS table");
assert.ok(!storeSource.includes("INSERT INTO novel_search"), "browser uploads must not maintain the retired novel FTS table");
assert.ok(!storeSource.includes("novel_search MATCH"), "book listing must not query the retired chapter-title FTS index");
assert.ok(!rescanSource.includes("CREATE VIRTUAL TABLE novel_search"), "full rescans must not recreate the retired novel FTS table");
assert.ok(!rescanSource.includes("INSERT INTO novel_search"), "full rescans must not populate the retired novel FTS table");
assert.ok(clientSource.includes('correct.textContent = "校正信息"'), "book details must expose metadata correction");
assert.ok(clientSource.includes('["books", "书库"], ["mine", "我的"], ["authors", "作者"], ["search", "搜索"], ["rankings", "排行"], ["manage", "管理"]'), "novel navigation must include library, mine, authors, search, rankings, and management");
assert.ok(routerSource.includes('/novels/authors/${encodeRouteSegment(route.novelAuthor)}'), "author profiles must use standalone paths");
assert.ok(clientSource.includes("new IntersectionObserver"), "novel lists must continue loading near the bottom");
assert.ok(!clientSource.includes("shell.append(pagination)"), "novel lists must not render previous/next pagination");
assert.ok(clientSource.includes('font: ["yahei", "simsun", "kaiti"].includes(input.font) ? input.font : "yahei"'), "reader font must default to Microsoft YaHei");
assert.ok(clientSource.includes('["yahei", "雅黑"]'), "reader settings must expose the YaHei font choice");
assert.ok(clientStyles.includes("var(--novel-font-family"), "reader content must apply the selected font family");
assert.ok(clientStyles.includes("position: sticky"), "novel section navigation must behave like a sticky menu bar");
assert.ok(clientStyles.includes("width: 100vw"), "novel section navigation must span the viewport");
assert.ok(clientStyles.includes("overflow: visible"), "novel view must not trap the sticky menu inside a non-scrolling container");
assert.ok(clientSource.includes('deleteButton.textContent = "删除小说"'), "book correction dialog must expose deletion");
assert.ok(clientSource.includes('deleteButton.textContent = "确认删除"'), "book deletion must require a second confirmation");
assert.ok(rescanSource.includes("DELETE FROM novel_books WHERE id IN (SELECT book_id FROM novel_book_deletions)"), "full rescans must preserve manual deletions");
assert.ok(clientSource.includes('row.addEventListener("click", () => openBook(book.id))'), "clicking a novel row must open book details");
assert.ok(clientSource.includes("openChapter(book.id, book.chapterCount, { restoreProgress: false })"), "latest chapter links must open the newest chapter");
assert.ok(!clientSource.includes('row.addEventListener("dblclick"'), "novel rows must not require a double click");
assert.ok(!clientSource.includes('state.novel.mode === "books" ? renderRecent'), "library home must not show continue reading");
assert.ok(clientSource.includes('state.novel.mode === "mine" ? renderRecent(entries)'), "mine page must own continue reading");

globalThis.window = { location: { href: "http://127.0.0.1:29998/novels", search: "", hash: "" } };
const { routeFromUrl, routeUrl } = await import("../public/js/router.js");
const authorRoute = routeFromUrl("http://127.0.0.1:29998/novels/authors/%E4%B8%81%E5%A2%A8");
assert.equal(authorRoute.novelMode, "author");
assert.equal(authorRoute.novelAuthor, "丁墨");
assert.equal(routeUrl(authorRoute), "/novels/authors/%E4%B8%81%E5%A2%A8");
const manageRoute = routeFromUrl("http://127.0.0.1:29998/novels/manage");
assert.equal(manageRoute.novelMode, "manage");
assert.equal(routeUrl(manageRoute), "/novels/manage");
const searchRoute = routeFromUrl("http://127.0.0.1:29998/novels/search?q=%E5%A4%A7%E6%98%8E");
assert.equal(searchRoute.novelMode, "search");
assert.equal(searchRoute.novelQuery, "大明");
assert.equal(routeUrl(searchRoute), "/novels/search?q=%E5%A4%A7%E6%98%8E");
const rankingsRoute = routeFromUrl("http://127.0.0.1:29998/novels/rankings");
assert.equal(rankingsRoute.novelMode, "rankings");
assert.equal(rankingsRoute.novelSort, "chars");
assert.equal(routeUrl(rankingsRoute), "/novels/rankings");
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
  const mine = tempStore.listBooks(new URL("http://127.0.0.1/api/novels?reading=1&sort=progress&limit=10"));
  assert.equal(mine.readingOnly, true);
  assert.equal(mine.total, 1);
  assert.equal(mine.books[0].id, uploaded.book.id, "mine page must include only books with reading progress");
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
  assert.equal(Number(tempDb.prepare("SELECT COUNT(*) AS value FROM novel_book_deletions").get().value), 2, "deleted books must leave rescan tombstones");
  tempDb.close();
} finally {
  tempStore.invalidate();
  fs.rmSync(tempDir, { recursive: true, force: true });
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
