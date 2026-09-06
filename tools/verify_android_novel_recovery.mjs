import assert from "node:assert/strict";
import fs from "node:fs";
import { createReaderHarness, localEntry, settle, deferred } from "./fixtures/android-novel-reader-harness.mjs";

// Execute the complete CURRENT createNovelViews. Only DOM, clocks, storage and
// native/network boundaries are controlled. No IndexedDB, device or real books.
const source = fs.readFileSync(new URL("../android-client/www/modules/novels/novel-views.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../android-client/www/modules/novels/styles.css", import.meta.url), "utf8");

// Static source contract only: this does NOT measure browser-computed colors,
// contrast ratios, cascade or screenshots. Real light/dark UI verification is
// separate. Prevent recurrence of non-existent --text/--border theme tokens.
function assertRecoveryThemeTokens(css) {
  const marker = "/* Read-only legacy text recovery: deliberately separate from the normal library. */";
  assert(css.includes(marker), "Recovery CSS section must exist");
  const recovery = css.slice(css.indexOf(marker));
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const body = recovery.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
    assert(body, `Missing recovery CSS rule: ${selector}`);
    return body;
  };
  for (const selector of [".novel-local-library-error", ".novel-local-recovery-dialog"]) {
    assert.match(rule(selector), /color:\s*var\(--ink\)/);
    assert.match(rule(selector), /background:\s*var\(--surface\)/);
  }
  const buttons = rule(".novel-local-recovery-dialog button");
  assert.match(buttons, /background:\s*var\(--surface-soft\)/);
  assert.match(buttons, /color:\s*var\(--ink\)/);
  assert.match(buttons, /border:\s*1px solid var\(--line\)/);
  assert.match(rule('.novel-local-recovery-status[role="alert"]'), /color:\s*var\(--ink\);\s*font-weight:\s*600/);
  assert.match(rule(".novel-local-recovery-list article"), /border-top:\s*1px solid var\(--line\)/);
  assert.match(rule(".novel-local-library-error button:focus-visible"), /outline:\s*3px solid var\(--mobile-accent\)/);
  assert(!/var\(--(?:text|border)\b/.test(recovery), "Recovery must use existing app theme tokens");
}
const tests = [];
const test = (name, run, mutation) => tests.push({ name, run, mutation });
const button = (h, text, scope = h.document.body) => {
  const found = scope.querySelectorAll("button").find((item) => item.textContent === text);
  assert(found, `Missing button: ${text}; DOM: ${scope.textContent}`);
  return found;
};
const panel = (h) => h.document.querySelector(".novel-local-recovery-dialog");
const card = (h) => h.els.viewContent.querySelector("[data-local-novel-error]");
const plain = (value) => structuredClone(value);
const CACHE_REALM = "server:11111111-1111-4111-8111-111111111111";
// These recovery races require an already-bound, same-library cache. Legacy
// unbound IDs no longer auto-link and are covered by the source-identity suite.
function seedSameRealmCache(h, sourceId = "remote-one") {
  const id = h.api.__test.remoteCacheIdFromSourceId(sourceId, CACHE_REALM);
  const entry = localEntry(id);
  Object.assign(entry.book, { sourceRealm: CACHE_REALM, sourceType: "remote-cache", sourceBookId: sourceId });
  h.books.set(id, entry);
  h.cached.set("/api/novels/source-identity", { payload: { sourceRealm: CACHE_REALM } });
  return id;
}
const item = (key = ["library", 7], overrides = {}) => ({ key, title: "合成旧书", fileName: "合成旧书.txt", totalChapters: 2, readableChapters: 2, omittedChapters: 0, exportable: true, ...overrides });
const page = (items = [item()], version = 1, extra = {}) => ({ version, source: "legacy-books", items, nextKey: null, hasMore: false, ...extra });
const recovered = (version = 1, extra = {}) => ({ version, source: "legacy-books", entry: { book: { title: "合成旧书", fileName: "合成旧书.txt" }, chapters: [{ index: 3, title: "序言", preamble: true, content: "合成序言正文" }, { index: 3, title: "第一章", content: "合成第一章正文" }] }, totalChapters: 2, readableChapters: 2, omittedChapters: 0, ...extra });
async function failPage(h, kind = "detail") {
  const wait = h.queueRead("local:a");
  const pending = kind === "reader" ? h.api.renderNovelReader("local:a", 1) : h.api.renderNovelDetail("local:a");
  wait.reject(new Error("合成数据库升级失败"));
  await pending;
  assert(card(h), "Read failure must expose a persistent recovery card");
}
async function openRecovery(h, data = page()) {
  const wait = h.queueRecoveryList();
  button(h, "只读取回旧库正文").click();
  assert(panel(h), "explicit entry opens the real recovery dialog");
  wait.resolve(data);
  await settle();
  return panel(h);
}
function nativeExporter(h, implementation = async () => ({ available: true, fileName: "saved.txt" })) {
  const calls = [];
  h.window.Capacitor.Plugins.FanHaoNovel.exportTextFile = (options) => { calls.push(options); return implementation(options); };
  return calls;
}
async function exportBook(h, result = recovered(), label = "取回正文并导出 TXT") {
  const wait = h.queueRecoveryEntry();
  button(h, label, panel(h)).click();
  wait.resolve(result);
  await settle();
}
function replaceOnce(from, to) {
  return (text) => { assert.equal(text.split(from).length, 2, `Mutation anchor must be unique: ${from}`); return text.replace(from, to); };
}

test("failed shelf read preserves summary and selection and survives remote render", async (h) => {
  await h.api.__test.loadPersistentLocalLibrary();
  h.api.__test.selectedLocalBookIds.add("local:a");
  const wait = h.queueListRead();
  const pending = h.api.__test.renderNovelCollection();
  wait.reject(new Error("合成本机库事务失败")); await settle();
  assert.equal(h.api.__test.localBooks.size, 2);
  assert(h.api.__test.selectedLocalBookIds.has("local:a"));
  assert(card(h));
  h.fetches.at(-1).wait.resolve({ books: [{ id: "remote:a", title: "远程仍然可读" }], total: 1 });
  await pending;
  assert(h.els.viewContent.textContent.includes("远程仍然可读"));
  assert(card(h), "remote completion erased local recovery card");
  assert(h.els.viewMeta.textContent.includes("数量未知"));
  assert.equal(h.recoveryCalls.length, 0, "normal reads must never fall back to legacy");
});
test("failed empty local shelf says unknown, never claims empty library", async (h) => {
  h.books.clear(); h.api.__test.listState.source = "local";
  const wait = h.queueListRead(); const pending = h.api.__test.renderNovelCollection();
  wait.reject(new Error("synthetic failure")); await settle();
  h.fetches.at(-1).wait.resolve({ books: [], total: 0 }); await pending;
  assert(card(h)); assert(h.els.viewMeta.textContent.includes("数量未知"));
  assert(!h.els.viewContent.textContent.includes("暂时没有小说"));
  assert(!h.els.viewMeta.textContent.includes("0 本"));
});
test("list retry is single-flight and a later remote response uses retried summaries", async (h) => {
  h.api.__test.listState.source = "local";
  const first = h.queueListRead(); const pending = h.api.__test.renderNovelCollection();
  first.reject(new Error("first failure")); await settle();
  const retry = h.queueListRead(); const trigger = button(h, "重试读取"); trigger.click(); trigger.click();
  assert.equal(h.storageCalls.filter((call) => call.kind === "summaries").length, 2);
  assert(button(h, "正在重试读取…").disabled);
  const current = localEntry("local:fresh"); current.book.title = "重试新摘要";
  retry.resolve([current]); await settle(); assert(!card(h));
  h.fetches.at(-1).wait.resolve({ books: [], total: 0 }); await pending;
  assert(h.els.viewContent.textContent.includes("重试新摘要"));
  assert.equal(h.api.__test.listState.uploading, false);
});
test("list late failure and retry after navigation do not replace another page", async (h) => {
  const wait = h.queueListRead(); const pending = h.api.renderNovelList(); h.leave();
  wait.reject(new Error("late error")); await pending;
  assert.equal(h.els.viewContent.innerHTML, "OTHER VIEW"); assert(!card(h));
  await failPage(h); const retry = h.queueRead("local:a"); button(h, "重试读取").click();
  await h.api.renderNovelDetail("local:b"); const text = h.els.viewContent.textContent;
  retry.resolve(h.books.get("local:a")); await settle();
  assert.equal(h.els.viewContent.textContent, text);
});
for (const kind of ["detail", "reader"]) {
  test(`${kind} failure is not missing and retry loads the current book`, async (h) => {
    await failPage(h, kind);
    assert(!h.els.viewContent.textContent.includes("已经不在"));
    assert(h.els.viewContent.textContent.includes("合成数据库升级失败"));
    assert.equal(h.recoveryCalls.length, 0);
    button(h, "重试读取").click(); await settle();
    assert(!card(h));
    assert(h.els.viewContent.textContent.includes(kind === "reader" ? "Only synthetic fixture" : "Book local:a"));
    assert.equal(h.api.__test.listState.uploading, false);
  });
  test(`${kind} genuine missing result is separate from storage failure`, async (h) => {
    h.books.delete("local:a");
    await (kind === "reader" ? h.api.renderNovelReader("local:a", 1) : h.api.renderNovelDetail("local:a"));
    assert(!card(h)); assert(h.els.viewContent.textContent.includes("已经不在"));
  });
  test(`${kind} failed retry remains recoverable and late error cannot cover new page`, async (h) => {
    await failPage(h, kind); const wait = h.queueRead("local:a"); button(h, "重试读取").click();
    wait.reject(new Error("retry failed")); await settle(); assert(card(h));
    assert(button(h, "重试读取"));
    const late = h.queueRead("local:a"); button(h, "重试读取").click();
    await h.api.renderNovelReader("local:b", 1); const text = h.els.viewContent.textContent;
    late.reject(new Error("obsolete")); await settle(); assert.equal(h.els.viewContent.textContent, text); assert(!card(h));
  });
}
test("explicit current-book export read failure is not misreported as deletion", async (h) => {
  await h.api.renderNovelDetail("local:a"); const calls = nativeExporter(h);
  const wait = h.queueRead("local:a"); const pending = h.api.__test.downloadBook("local:a");
  wait.reject(new Error("body read unavailable")); await pending;
  assert(card(h)); assert.equal(calls.length, 0);
  assert(!h.statuses.some(([text]) => text.includes("已经不在")));
  button(h, "重试导出").click(); await settle(); assert.equal(calls.length, 1); assert(!card(h));
});
test("mounted reader catalog failure offers recovery without losing the current chapter", async (h) => {
  await h.api.renderNovelReader("local:a", 1); const wait = h.queueRead("local:a");
  const pending = h.api.__test.loadReaderCatalog(); wait.reject(new Error("catalog transaction unavailable")); await pending;
  assert(card(h)); assert(h.els.viewContent.querySelector(".novel-reader-screen"));
  assert.equal(h.state.chapter.index, 1); button(h, "重试读取").click(); await settle();
  assert(!card(h)); assert.equal(h.state.catalogError, ""); assert.equal(h.state.chapter.index, 1);
});
for (const kind of ["reader", "detail"]) {
  test(`${kind} optional cache summary retry continues to offline local content`, async (h) => {
    const id = seedSameRealmCache(h);
    const wait = h.queueRead(id);
    const pending = kind === "reader" ? h.api.renderNovelReader("remote-one", 1) : h.api.renderNovelDetail("remote-one");
    wait.reject(new Error("cache summary unavailable")); await settle();
    h.fetches.at(-1).wait.reject(new Error("remote offline")); await pending;
    assert(card(h)); button(h, "重试读取").click(); await settle();
    assert(!card(h)); assert(h.els.viewContent.textContent.includes(kind === "reader" ? "Only synthetic fixture" : `Book ${id}`));
    assert(h.storageCalls.some((call) => call.kind === (kind === "reader" ? "chapter" : "catalog")));
  });
}
test("summary retry cannot overwrite remote content that arrives during fallback body read", async (h) => {
  const id = seedSameRealmCache(h);
  const first = h.queueRead(id); const pending = h.api.renderNovelReader("remote-one", 1);
  first.reject(new Error("summary failure")); await settle();
  const summary = h.queueRead(id); const body = h.queueRead(id); button(h, "重试读取").click(); summary.resolve(h.books.get(id)); await settle();
  h.fetches.at(-1).wait.resolve({ sourceRealm: CACHE_REALM, book: { id: "remote-one", sourceRealm: CACHE_REALM, title: "实时远程" }, chapter: { index: 1, title: "远程章节", content: "当前远程正文" } }); await pending;
  body.resolve(h.books.get(id)); await settle();
  assert.equal(h.state.book.id, "remote-one"); assert(h.els.viewContent.textContent.includes("当前远程正文"));
});
test("late remote failure cannot erase content successfully recovered by summary retry", async (h) => {
  const id = seedSameRealmCache(h);
  const first = h.queueRead(id); const pending = h.api.renderNovelReader("remote-one", 1);
  first.reject(new Error("summary failure")); await settle(); button(h, "重试读取").click(); await settle();
  assert.equal(h.state.book.id, id); h.fetches.at(-1).wait.reject(new Error("late network failure")); await pending;
  assert(h.els.viewContent.querySelector(".novel-reader-screen")); assert(!card(h));
});
// These schedules already pass before this test addition: the current detail
// catalog handler compares the requested book ID with the mounted detail book.
// The negative control removes THAT existing protection; it is not a historical
// failure reproduction or evidence of a new production fix.
const withoutDetailCatalogBookIdentity = (text) => {
  const pattern = /  async function loadRemoteDetailCatalogPage\(options = \{\}\) \{[^]*?\n  \}/;
  const body = text.match(pattern)?.[0];
  assert(body, "Existing remote-detail catalog function must be present");
  const check = ' || bookId !== String(detailState.book?.id || "")';
  assert.equal(body.split(check).length, 3, "Remove only the two existing detail book-identity checks");
  return text.replace(pattern, () => body.replaceAll(check, ""));
};
for (const outcome of ["success", "failure"]) {
  test(`existing detail identity guard rejects late catalog ${outcome} after local retry`, async (h) => {
    const localId = seedSameRealmCache(h);
    const entry = h.books.get(localId);
    Object.assign(entry.book, { title: "本地重试恢复详情", sourceType: "remote-cache", sourceBookId: "remote-one" });
    entry.chapters[0].title = "本地目录第一章";
    h.books.set(localId, entry);
    const first = h.queueRead(localId);
    const pending = h.api.renderNovelDetail("remote-one");
    first.reject(new Error("temporary summary failure")); await settle();
    assert.equal(h.fetches.length, 1, "Only remote metadata has been requested");
    h.fetches[0].wait.resolve({ sourceRealm: CACHE_REALM, book: { id: "remote-one", sourceRealm: CACHE_REALM, title: "远端元数据先返回", chapterCount: 3 } });
    await settle();
    assert.equal(h.fetches.length, 2, "Actual metadata handler must start the catalog request");
    const remoteCatalog = h.fetches[1];
    assert(remoteCatalog.path.includes("/catalog"));
    button(h, "重试读取").click(); await settle();
    assert(!card(h));
    assert.equal(h.els.viewTitle.textContent, "本地重试恢复详情");
    assert(h.els.viewContent.textContent.includes("本地目录第一章"));
    assert(h.storageCalls.some((call) => call.kind === "catalog" && call.id === localId));
    const mountedText = h.els.viewContent.textContent;
    const mountedChildren = [...h.els.viewContent.children];
    if (outcome === "success") {
      remoteCatalog.wait.resolve({ sourceRealm: CACHE_REALM, bookId: "remote-one", chapters: [{ index: 1, title: "不应出现的迟到远端目录" }], total: 3, filteredTotal: 3, offset: 0 });
    } else remoteCatalog.wait.reject(new Error("不应出现的迟到远端目录错误"));
    await pending;
    assert.equal(h.els.viewTitle.textContent, "本地重试恢复详情", "late catalog must not restore the obsolete remote book");
    assert.equal(h.els.viewContent.textContent, mountedText, "late catalog must not change local detail contents");
    assert.deepEqual(h.els.viewContent.children, mountedChildren, "late catalog must not remount the existing local DOM");
    assert.equal(h.api.__test.listState.uploading, false);
    assert.equal(h.recoveryCalls.length, 0, "normal local retry must not read the legacy recovery store");
  }, withoutDetailCatalogBookIdentity);
}
test("opening recovery reads only metadata and retains typed IDB keys and version", async (h) => {
  await failPage(h); assert.equal(h.recoveryCalls.length, 0);
  await openRecovery(h);
  assert.equal(h.recoveryCalls.length, 1); assert.equal(h.recoveryCalls[0].kind, "list");
  assert.equal(h.recoveryCalls[0].options.limit, 10);
  assert(panel(h).textContent.includes("v1：尚未升级"));
  const calls = nativeExporter(h); await exportBook(h);
  assert.deepEqual(plain(h.recoveryCalls[1].key), ["library", 7]);
  assert.deepEqual(plain(h.recoveryCalls[1].options), { expectedVersion: 1 });
  assert.equal(calls.length, 1); assert(calls[0].text.includes("合成序言正文"));
  assert(!calls[0].text.startsWith("序言\n"));
  assert.equal(h.storageCalls.filter((call) => /save|delete/i.test(call.kind)).length, 0);
  assert.equal(h.api.__test.localBooks.size, 0, "recovery must not publish old data into normal shelf");
}, replaceOnce("readLocalNovelRecoveryEntry(item.key, { expectedVersion: state.version })", "readLocalNovelRecoveryEntry(String(item.key), { expectedVersion: state.version })"));
for (const version of [2, 3]) test(`v${version} recovery explicitly labels old pre-upgrade copy, not newest contents`, async (h) => {
  await failPage(h); await openRecovery(h, page([item()], version));
  assert(panel(h).textContent.includes("升级前保留的旧副本"));
  assert(panel(h).textContent.includes("不是当前最新"));
  assert(panel(h).textContent.includes("不是包含阅读进度和元数据的完整备份"));
  const calls = nativeExporter(h); await exportBook(h, recovered(version)); assert.equal(calls.length, 1);
  assert.equal(h.recoveryCalls.at(-1).options.expectedVersion, version);
});
test("pagination carries original cursor and version and back returns the first page", async (h) => {
  await failPage(h); const cursor = ["cursor", 12];
  await openRecovery(h, page([item()], 2, { nextKey: cursor, hasMore: true }));
  const wait = h.queueRecoveryList(); button(h, "下一页", panel(h)).click();
  assert.deepEqual(plain(h.recoveryCalls.at(-1).options), { afterKey: cursor, limit: 10, expectedVersion: 2 });
  wait.resolve(page([item(12, { title: "第二页" })], 2)); await settle(); assert(panel(h).textContent.includes("第二页"));
  const back = h.queueRecoveryList(); button(h, "上一页", panel(h)).click();
  assert.equal(h.recoveryCalls.at(-1).options.afterKey, undefined);
  assert.equal(h.recoveryCalls.at(-1).options.expectedVersion, 2);
  back.resolve(page([item()], 2)); await settle(); assert(panel(h).textContent.includes("当前第 1 页"));
});
test("failed next page retains existing rows and retry uses same cursor", async (h) => {
  await failPage(h); await openRecovery(h, page([item()], 1, { nextKey: 77, hasMore: true }));
  const wait = h.queueRecoveryList(); button(h, "下一页", panel(h)).click(); wait.reject(new Error("page unavailable")); await settle();
  assert(panel(h).textContent.includes("合成旧书")); assert(panel(h).textContent.includes("page unavailable"));
  const retry = h.queueRecoveryList(); button(h, "重试读取旧库", panel(h)).click();
  assert.deepEqual(plain(h.recoveryCalls.at(-1).options), { afterKey: 77, limit: 10, expectedVersion: 1 });
  retry.resolve(page([], 1)); await settle(); assert.equal(h.api.__test.listState.uploading, false);
});
test("stale schema disables old exports until explicit reopen", async (h) => {
  await failPage(h); await openRecovery(h); const wait = h.queueRecoveryEntry();
  button(h, "取回正文并导出 TXT", panel(h)).click();
  wait.reject(Object.assign(new Error("version changed"), { code: "RECOVERY_STALE_VERSION" })); await settle();
  assert(button(h, "取回正文并导出 TXT", panel(h)).disabled);
  assert(panel(h).textContent.includes("重新打开旧库"));
  const fresh = h.queueRecoveryList(); button(h, "重新打开旧库", panel(h)).click();
  assert.equal(h.recoveryCalls.at(-1).options.expectedVersion, undefined);
  fresh.resolve(page([item()], 2)); await settle(); assert(panel(h).textContent.includes("v2："));
});
test("mismatching successful read version cannot trigger export", async (h) => {
  await failPage(h); await openRecovery(h); const calls = nativeExporter(h);
  await exportBook(h, recovered(2)); assert.equal(calls.length, 0); assert(panel(h).textContent.includes("版本已变化"));
});
test("partial body export requires actual-count confirmation and honest result", async (h) => {
  await failPage(h); await openRecovery(h, page([item(undefined, { totalChapters: 3, omittedChapters: 1 })]));
  const confirms = []; h.window.confirm = (text) => { confirms.push(text); return true; };
  const calls = nativeExporter(h); await exportBook(h, recovered(1, { totalChapters: 5, omittedChapters: 3 }), "导出可读正文（不完整，遗漏 1 章）");
  assert.equal(confirms.length, 1); assert(confirms[0].includes("2/5 章，遗漏 3 章"));
  assert(confirms[0].includes("不完整")); assert.equal(calls.length, 1);
  assert(panel(h).textContent.includes("已保存不完整的正文")); assert(panel(h).textContent.includes("遗漏 3 章"));
}, replaceOnce("if ((omitted > 0 || countsChanged) && !window.confirm", "if (false && !window.confirm"));
test("changed complete counts also require confirmation; cancel never launches SAF", async (h) => {
  await failPage(h); await openRecovery(h, page([item(undefined, { totalChapters: 1, readableChapters: 1 })]));
  const confirms = []; h.window.confirm = (text) => { confirms.push(text); return false; };
  const calls = nativeExporter(h); await exportBook(h);
  assert.equal(confirms.length, 1); assert(confirms[0].includes("数量与列表显示不同")); assert.equal(calls.length, 0);
  assert(panel(h).textContent.includes("已取消导出")); assert.equal(h.api.__test.listState.uploading, false);
});
test("unreadable rows are disabled and actual empty read never exports a blank file", async (h) => {
  await failPage(h); await openRecovery(h, page([item(1, { exportable: false, readableChapters: 0, omittedChapters: 2 })]));
  button(h, "没有可读正文", panel(h)).click(); assert.equal(h.recoveryCalls.length, 1);
  assert(button(h, "没有可读正文", panel(h)).disabled);
  button(h, "关闭取回窗口").click(); await openRecovery(h); const calls = nativeExporter(h);
  await exportBook(h, recovered(1, { entry: { book: {}, chapters: [{ content: "  " }, { content: null }] }, readableChapters: 0, omittedChapters: 2 }));
  assert.equal(calls.length, 0); assert(panel(h).textContent.includes("不能导出空白 TXT"));
});
for (const [name, result] of [["success", { available: true }], ["cancel", { canceled: true }], ["unavailable", { available: false, message: "SAF unavailable" }]]) {
  test(`native export ${name} remains distinct and always releases its busy owner`, async (h) => {
    await failPage(h); await openRecovery(h); const calls = nativeExporter(h, async () => result);
    await exportBook(h); assert.equal(calls.length, 1); assert.equal(h.api.__test.listState.uploading, false);
    assert(panel(h).textContent.includes(name === "success" ? "已保存" : name === "cancel" ? "已取消导出" : "SAF unavailable"));
    if (name !== "success") assert(!panel(h).textContent.includes("已保存"));
  });
}
test("native export rejection can be explicitly retried", async (h) => {
  await failPage(h); await openRecovery(h); let attempts = 0;
  const calls = nativeExporter(h, async () => { if (++attempts === 1) throw new Error("synthetic save failure"); return { available: true }; });
  await exportBook(h); assert(panel(h).textContent.includes("synthetic save failure"));
  const retry = h.queueRecoveryEntry(); button(h, "重试取回并导出 TXT", panel(h)).click(); retry.resolve(recovered()); await settle();
  assert.equal(calls.length, 2); assert(panel(h).textContent.includes("已保存"));
});
test("UTF-8 budget rejects multibyte body below 80MiB JS length but over bytes", async (h) => {
  await failPage(h); await openRecovery(h); const calls = nativeExporter(h);
  const content = "汉".repeat(28 * 1024 * 1024);
  await exportBook(h, recovered(1, { entry: { book: {}, chapters: [{ title: "正文", content }] }, totalChapters: 1, readableChapters: 1 }));
  assert.equal(calls.length, 0); assert(panel(h).textContent.includes("UTF-8")); assert(panel(h).textContent.includes("80 MiB"));
});
test("browser export says started, removes anchor and revokes its Blob URL", async (h) => {
  await failPage(h); await openRecovery(h); await exportBook(h);
  assert(panel(h).textContent.includes("已发起")); assert(!panel(h).textContent.includes("已保存"));
  assert.equal(h.document.body.querySelectorAll("a").length, 0);
  assert.equal(h.objectUrls.length, 1); assert.equal(h.objectUrls[0].revoked, false);
  h.runTimers(1000); assert.equal(h.objectUrls[0].revoked, true);
});
test("browser click failure still removes anchor and revokes URL without success", async (h) => {
  await failPage(h); await openRecovery(h);
  const create = h.document.createElement; h.document.createElement = (name) => { const node = create(name); if (name === "a") node.click = () => { throw new Error("download click failed"); }; return node; };
  await exportBook(h); assert(panel(h).textContent.includes("download click failed")); assert(!panel(h).textContent.includes("已发起"));
  assert.equal(h.document.body.querySelectorAll("a").length, 0); h.runTimers(1000); assert.equal(h.objectUrls[0].revoked, true);
});
test("closing a pending list restores focus and old callback cannot affect a reopened panel", async (h) => {
  await failPage(h); const trigger = button(h, "只读取回旧库正文"); const old = h.queueRecoveryList(); trigger.click();
  button(h, "关闭取回窗口", panel(h)).click(); assert.equal(h.document.activeElement, trigger);
  await openRecovery(h, page([item(9, { title: "新窗口" })], 2));
  old.resolve(page([item(1, { title: "旧窗口迟到" })], 1)); await settle();
  assert(panel(h).textContent.includes("新窗口")); assert(!panel(h).textContent.includes("旧窗口迟到"));
});
test("closing during body read prevents a later unsolicited export", async (h) => {
  await failPage(h); await openRecovery(h); const calls = nativeExporter(h); const wait = h.queueRecoveryEntry();
  button(h, "取回正文并导出 TXT", panel(h)).click(); button(h, "关闭取回窗口", panel(h)).click();
  wait.resolve(recovered()); await settle(); assert.equal(calls.length, 0); assert(!panel(h)); assert.equal(h.api.__test.listState.uploading, false);
}, replaceOnce("return recoveryPanel === state && state.page.isActive() && state.overlay.isConnected;", "return true;"));
test("navigation invalidates pending recovery list and body without touching new DOM", async (h) => {
  await failPage(h); const wait = h.queueRecoveryList(); button(h, "只读取回旧库正文").click(); h.leave();
  wait.reject(new Error("obsolete old-list error")); await settle(); assert(!panel(h)); assert.equal(h.els.viewContent.innerHTML, "OTHER VIEW");
  await failPage(h); await openRecovery(h); const calls = nativeExporter(h); const body = h.queueRecoveryEntry(); button(h, "取回正文并导出 TXT", panel(h)).click();
  h.leave(); body.resolve(recovered()); await settle(); assert.equal(calls.length, 0); assert(!panel(h)); assert.equal(h.els.viewContent.innerHTML, "OTHER VIEW");
});
test("late SAF completion cannot replace reopened modal or release another busy owner", async (h) => {
  await failPage(h); await openRecovery(h); const saved = deferred(); nativeExporter(h, () => saved.promise); await exportBook(h);
  button(h, "关闭取回窗口", panel(h)).click(); await openRecovery(h, page([item(2, { title: "新恢复窗口" })]));
  assert(button(h, "取回正文并导出 TXT", panel(h)).disabled, "a still-open native save must not launch twice");
  const owner = h.api.__test.setNovelBusy("picker"); saved.resolve({ available: true, fileName: "old-save.txt" }); await settle();
  assert(h.api.__test.listState.uploading); assert(!panel(h).textContent.includes("old-save.txt"));
  assert(!button(h, "取回正文并导出 TXT", panel(h)).disabled); h.api.__test.clearNovelBusy(owner);
});
test("Escape closes modal and restores focus without reading any body", async (h) => {
  await failPage(h); const trigger = button(h, "只读取回旧库正文"); await openRecovery(h);
  h.window.dispatchEvent(h.event("keydown", { key: "Escape" }));
  assert(!panel(h)); assert.equal(h.document.activeElement, trigger); assert.equal(h.recoveryCalls.filter((call) => call.kind === "entry").length, 0);
});

let failures = 0; let mutations = 0;
let themeContracts = 0;
try {
  assertRecoveryThemeTokens(styles);
  assert.throws(() => assertRecoveryThemeTokens(styles.replaceAll("color: var(--ink);", "color: var(--text, #242424);")), { code: "ERR_ASSERTION" });
  themeContracts = 1;
  console.log("PASS static recovery CSS theme-token contract; invalid --text mutation rejected (not a rendered-color test)");
} catch (error) { failures++; console.error(`FAIL recovery CSS theme-token contract\n${error.stack}`); }
for (const { name, run, mutation } of tests) {
  try { await run(createReaderHarness(source)); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
  if (mutation) {
    try { await run(createReaderHarness(mutation(source))); failures++; console.error(`FAIL mutant survived: ${name}`); }
    catch (error) {
      if (error.code !== "ERR_ASSERTION") { failures++; console.error(`FAIL mutant infrastructure error: ${name}\n${error.stack}`); }
      else { mutations++; console.log(`CONTROL rejected: ${name} (${error.message.split("\n")[0]})`); }
    }
  }
}
console.log(`Novel recovery verification: ${tests.length} current-source scenarios, ${mutations} executable mutation controls rejected; ${themeContracts} static CSS token contract; ${failures} failures.`);
if (failures) process.exitCode = 1;
