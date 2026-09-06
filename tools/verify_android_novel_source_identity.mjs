import assert from "node:assert/strict";
import fs from "node:fs";
import { createReaderHarness, localEntry, settle } from "./fixtures/android-novel-reader-harness.mjs";

// Actual complete createNovelViews in a VM. Controlled storage/network/DOM only;
// no browser, server, real IndexedDB, media, device, or production source edits.
// Strict fixture JSON cache is keyed by a structured [URL,path] pair. Realm
// learning executes production helpers or real list/detail/reader responses.
const source = fs.readFileSync(new URL("../android-client/www/modules/novels/novel-views.js", import.meta.url), "utf8");
const URL_A = "https://library-a.invalid";
const URL_B = "https://library-b.invalid";
const REALM_A = "server:11111111-1111-4111-8111-111111111111";
const REALM_B = "server:22222222-2222-4222-8222-222222222222";
const ID = "same-upstream-book";
const REVISION = "33333333-3333-4333-8333-333333333333";
const receiptPath = "/api/novels/source-identity";
const tests = [];
const test = (name, run, mutation) => tests.push({ name, run, mutation });
const remoteBook = (realm = REALM_A, id = ID) => ({ id, ...(realm ? { sourceRealm: realm, catalogRevision: REVISION } : {}), title: `Book ${realm || "old server"}`, author: "Synthetic author", chapterCount: 2 });
const chapters = [1, 2].map((index) => ({ id: `fixture-source-chapter:${index}`, index, title: `Chapter ${index}`, content: `Synthetic body ${index}`, charCount: 16 }));
const chapterData = (realm = REALM_A, index = 1, id = ID) => ({
  ...(realm ? { sourceRealm: realm, catalogRevision: REVISION } : {}), book: remoteBook(realm, id),
  chapter: { ...chapters[index - 1], bookId: id, content: `BODY ${realm || "unbound"} ${index}` }, prev: null, next: null
});
const catalogData = (realm = REALM_A) => ({ ...(realm ? { sourceRealm: realm, catalogRevision: REVISION } : {}), bookId: ID, chapters: chapters.map(({ content, ...entry }) => entry), total: 2, filteredTotal: 2, offset: 0 });
function harness(text = source) { return createReaderHarness(text, { strictCache: true }); }
async function confirmRealm(h, url, realm) {
  assert.equal(typeof h.api.__test.rememberRemoteSourceRealm, "function", "Production realm-learning helper is required");
  await h.api.__test.rememberRemoteSourceRealm(url, { sourceRealm: realm, book: remoteBook(realm) });
  await settle();
}
async function seedBound(h, realm = REALM_A) {
  const entry = h.api.__test.createCachedRemoteBookEntry(remoteBook(realm), chapters);
  assert(entry?.book?.id, "Bound cache factory must produce an entry");
  h.books.set(entry.book.id, entry);
  await h.api.__test.loadPersistentLocalLibrary();
  return entry;
}
// Bounded driver: only resolve the actual requests the production method makes;
// a stuck flow fails instead of letting an unresolved top-level Promise exit.
async function finish(h, pending, response) {
  let done = false;
  let failure;
  pending.then(() => { done = true; }, (error) => { done = true; failure = error; });
  const seen = new Set();
  for (let round = 0; round < 40 && !done; round++) {
    await settle();
    for (const request of h.fetches) {
      if (seen.has(request)) continue;
      seen.add(request);
      try { request.wait.resolve(response(request)); }
      catch (error) { request.wait.reject(error); }
    }
  }
  await settle();
  assert(done, "Production request flow did not settle under a bounded synthetic schedule");
  if (failure) throw failure;
  return pending;
}
const offline = () => { throw new Error("synthetic offline"); };
function replaceFunction(name, replacement) {
  return (text) => {
    const pattern = new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`);
    assert(pattern.test(text), `Cannot locate production ${name}`);
    return text.replace(pattern, () => replacement);
  };
}
function replaceOnce(from, to) {
  return (text) => { assert.equal(text.split(from).length, 2, `Expected one mutation anchor: ${from}`); return text.replace(from, to); };
}
// Frozen pre-isolation helper (read from production before this feature), not
// an invented duplicate cache implementation. Used only as an executable red
// control on the identity scenario, while the rest of createNovelViews is real.
const oldUnqualifiedKey = replaceFunction("remoteCacheIdFromSourceId", `  function remoteCacheIdFromSourceId(sourceId) {
    const id = String(sourceId || "").trim();
    return id ? \`local:remote:\${id}\` : "";
  }`);
// Modern chapter routes also carry the same realm in their snapshot anchor.
// Disable both redundant checks to reproduce the old missing-realm validation.
const withoutChapterRealmCheck = (text) => replaceOnce("if (anchor.sourceRealm && realm !== anchor.sourceRealm) return false;", "if (false && anchor.sourceRealm && realm !== anchor.sourceRealm) return false;")(
  replaceOnce("if (sourceRealm !== undefined && realm !== sourceRealm) return false;", "if (false && sourceRealm !== undefined && realm !== sourceRealm) return false;")(text));
const withoutOperationGuard = replaceFunction("requireRemoteOperation", "  function requireRemoteOperation(operation) {\n    // Deliberately disabled in the negative control only.\n  }");
const withoutPayloadUseGate = replaceFunction("canUseRemotePayload", "  function canUseRemotePayload(sourceUrl, data) {\n    return true;\n  }");
const withoutPayloadBookId = replaceOnce('if (!data || String(data.book?.id || data.bookId || "") !== String(bookId)) return false;', 'if (!data) return false;');
// Catalog validation now has two independent realm checks, including the empty
// realm. Removing only canUseRemotePayload remains safe; the red control must
// disable both checks to reproduce the previously accepted foreign catalog.
const withoutCatalogRealmGuards = (text) => withoutChapterRealmCheck(withoutPayloadUseGate(text));

test("persistent cache identity separates equal book IDs in different realms", async (h) => {
  assert.notEqual(h.api.__test.remoteCacheIdFromSourceId(ID, REALM_A), h.api.__test.remoteCacheIdFromSourceId(ID, REALM_B), "realm-aware lookup keys collided");
  const a = await seedBound(h, REALM_A); const b = await seedBound(h, REALM_B);
  assert.notEqual(a.book.id, b.book.id, "different source realms collided in persistent cache identity");
  assert.equal(a.book.sourceRealm, REALM_A); assert.equal(b.book.sourceRealm, REALM_B);
  assert.equal(h.api.__test.cachedRemoteEntryForSourceId(ID, REALM_A)?.book.id, a.book.id);
  assert.equal(h.api.__test.cachedRemoteEntryForSourceId(ID, REALM_B)?.book.id, b.book.id);
  assert.equal(h.books.get(a.book.id).book.sourceRealm, REALM_A);
  assert.equal(h.books.get(b.book.id).book.sourceRealm, REALM_B);
}, oldUnqualifiedKey);
test("same realm keeps the same cache identity after an address change", async (h) => {
  h.setActiveUrl(URL_A); const a = await seedBound(h, REALM_A);
  h.setActiveUrl(URL_B); const b = h.api.__test.createCachedRemoteBookEntry(remoteBook(REALM_A), chapters);
  assert.equal(a.book.id, b.book.id, "cache identity must not be derived from server address");
  const other = h.api.__test.remoteCacheIdFromSourceId(`${ID}:suffix`, REALM_A);
  assert.notEqual(other, a.book.id, "book ID remains a part of the qualified identity");
});
test("legacy unbound cache stays explicitly readable but cannot mark current remote book", async (h) => {
  const id = `local:remote:${ID}`; const entry = localEntry(id);
  Object.assign(entry.book, { sourceType: "remote-cache", sourceBookId: ID, title: "Legacy unbound book" });
  h.books.set(id, entry); await h.api.__test.loadPersistentLocalLibrary();
  await confirmRealm(h, URL_A, REALM_A); h.setActiveUrl(URL_A);
  assert.equal(h.api.__test.cachedRemoteEntryForSourceId(ID, REALM_A), null);
  assert(!h.api.__test.markRemoteBookWithCache(remoteBook(REALM_A)).cachedLocal);
  await h.api.renderNovelReader(id, 1);
  assert.equal(h.state.book.id, id); assert(h.els.viewContent.textContent.includes("Only synthetic fixture"));
  assert.equal(h.fetches.length, 0); assert(h.books.has(id), "legacy entry must not be silently removed");
});
test("realm-specific cache marker never selects a same-ID cache from another library", async (h) => {
  const a = await seedBound(h, REALM_A);
  assert.equal(h.api.__test.markRemoteBookWithCache(remoteBook(REALM_A)).cachedLocalId, a.book.id);
  assert(!h.api.__test.markRemoteBookWithCache(remoteBook(REALM_B)).cachedLocal);
  assert(!h.api.__test.markRemoteBookWithCache(remoteBook(null)).cachedLocal);
});
test("cold unconfirmed URL never guesses a realm from local caches", async (h) => {
  const cached = await seedBound(h, REALM_A); h.setActiveUrl(URL_B);
  await finish(h, h.api.renderNovelReader(ID, 1), offline);
  assert.notEqual(h.state.book?.id, cached.book.id);
  assert(!h.els.viewContent.textContent.includes("Synthetic body 1"));
  assert(!h.storageCalls.some((call) => call.kind === "chapter" && call.id === cached.book.id));
  assert(h.books.has(cached.book.id));
});
for (const view of ["reader", "detail"]) {
  test(`${view} may reuse the same realm cache after the new URL is confirmed`, async (h) => {
    const cached = await seedBound(h, REALM_A);
    await confirmRealm(h, URL_A, REALM_A); await confirmRealm(h, URL_B, REALM_A); h.setActiveUrl(URL_B);
    const pending = view === "reader" ? h.api.renderNovelReader(ID, 1) : h.api.renderNovelDetail(ID);
    await finish(h, pending, offline);
    assert(h.els.viewContent.textContent.includes(view === "reader" ? "Synthetic body 1" : cached.book.title));
    assert(h.storageCalls.some((call) => call.kind === (view === "reader" ? "chapter" : "catalog") && call.id === cached.book.id));
  });
  test(`${view} cannot use A's same-ID cache after B realm is confirmed`, async (h) => {
    const cached = await seedBound(h, REALM_A);
    await confirmRealm(h, URL_B, REALM_B); h.setActiveUrl(URL_B);
    const pending = view === "reader" ? h.api.renderNovelReader(ID, 1) : h.api.renderNovelDetail(ID);
    await finish(h, pending, offline);
    assert(!h.storageCalls.some((call) => ["chapter", "catalog"].includes(call.kind) && call.id === cached.book.id));
    assert(!h.els.viewContent.textContent.includes("Synthetic body 1"));
  });
}
test("realm receipt is local cache metadata, never a network probe endpoint", async (h) => {
  await confirmRealm(h, URL_A, REALM_A);
  assert(h.cacheCalls.some((call) => call.kind === "write" && call.url === URL_A && call.path === receiptPath));
  assert.equal(h.fetches.length, 0, "realm helper must not add a server endpoint request");
  const key = h.cacheKey(URL_A, receiptPath); const receipt = h.cached.get(key);
  assert(receipt, "last asserted realm should be persisted for offline lookup");
  const cold = harness(); cold.cached.set(cold.cacheKey(URL_A, receiptPath), structuredClone(receipt));
  assert.equal(await cold.api.__test.readRemoteSourceRealm(URL_A), REALM_A);
  assert.equal(cold.fetches.length, 0);
});
test("cached old realm cannot overwrite a newer live assertion", async (h) => {
  await confirmRealm(h, URL_A, REALM_B);
  await h.api.__test.rememberRemoteSourceRealm(URL_A, { sourceRealm: REALM_A, book: remoteBook(REALM_A) }, { cached: true });
  assert.equal(await h.api.__test.readRemoteSourceRealm(URL_A), REALM_B);
});
test("conflicting DTO and envelope realms are rejected without replacing the prior assertion", async (h) => {
  await confirmRealm(h, URL_A, REALM_A);
  assert.throws(() => h.api.__test.rememberRemoteSourceRealm(URL_A, { sourceRealm: REALM_A, book: remoteBook(REALM_B) }));
  assert.equal(await h.api.__test.readRemoteSourceRealm(URL_A), REALM_A);
});
test("malformed realm is not accepted as a new URL or title derived identity", async (h) => {
  await confirmRealm(h, URL_A, REALM_A);
  assert.throws(() => h.api.__test.rememberRemoteSourceRealm(URL_A, { sourceRealm: URL_A, book: remoteBook(URL_A) }));
  assert.equal(await h.api.__test.readRemoteSourceRealm(URL_A), REALM_A);
});
test("live unversioned server clears previous binding rather than inheriting a realm", async (h) => {
  await confirmRealm(h, URL_A, REALM_A);
  await h.api.__test.rememberRemoteSourceRealm(URL_A, { book: remoteBook(null) });
  assert(!await h.api.__test.readRemoteSourceRealm(URL_A));
  await h.api.__test.rememberRemoteSourceRealm(URL_A, { sourceRealm: REALM_A }, { cached: true });
  assert(!await h.api.__test.readRemoteSourceRealm(URL_A), "stale cache must not revive a cleared live binding");
});
test("live list envelope learns server-issued identity without deriving it from URL", async (h) => {
  h.setActiveUrl(URL_A);
  await finish(h, h.api.renderNovelList(), () => ({ sourceRealm: REALM_B, books: [remoteBook(REALM_B)], total: 1 }));
  assert.equal(await h.api.__test.readRemoteSourceRealm(URL_A), REALM_B);
  assert(h.els.viewContent.textContent.includes(remoteBook(REALM_B).title));
});
test("a source-bound online detail renders a successfully validated catalog", async (h) => {
  h.setActiveUrl(URL_A);
  await finish(h, h.api.renderNovelDetail(ID), (request) => request.path.includes("/catalog")
    ? catalogData(REALM_A) : { sourceRealm: REALM_A, book: remoteBook(REALM_A) });
  assert(h.els.viewContent.textContent.includes("Chapter 1"));
  assert(h.els.viewContent.textContent.includes("Chapter 2"));
  assert(!h.els.viewContent.textContent.includes("目录所属书库已变化"));
  assert.equal(h.fetches.filter((request) => request.path.includes("/catalog")).length, 1);
});
test("same URL's late old-realm catalog cannot overwrite newly displayed realm detail", async (h) => {
  h.setActiveUrl(URL_A);
  const first = h.api.renderNovelDetail(ID); await settle();
  h.fetches.at(-1).wait.resolve({ sourceRealm: REALM_A, book: remoteBook(REALM_A) }); await settle();
  const oldCatalog = h.fetches.at(-1); assert(oldCatalog.path.includes("/catalog"));
  const second = h.api.renderNovelDetail(ID); await settle();
  h.fetches.at(-1).wait.resolve({ sourceRealm: REALM_B, book: remoteBook(REALM_B) }); await settle();
  const newCatalog = h.fetches.at(-1); assert(newCatalog.path.includes("/catalog")); assert.notEqual(newCatalog, oldCatalog);
  newCatalog.wait.resolve({ ...catalogData(REALM_B), chapters: [{ index: 1, title: "NEW LIBRARY CATALOG" }] }); await second;
  const current = h.els.viewContent.textContent; assert(current.includes("NEW LIBRARY CATALOG"));
  oldCatalog.wait.resolve({ ...catalogData(REALM_A), chapters: [{ index: 1, title: "OBSOLETE LIBRARY CATALOG" }] }); await first;
  assert.equal(h.els.viewContent.textContent, current);
  assert.equal(await h.api.__test.readRemoteSourceRealm(URL_A), REALM_B);
});
test("successful detail catalog's delayed scroll frame cannot scroll a different page", async (h) => {
  h.setActiveUrl(URL_A); h.window.scrollY = 137;
  await finish(h, h.api.renderNovelDetail(ID), (request) => request.path.includes("/catalog")
    ? catalogData(REALM_A) : { sourceRealm: REALM_A, book: remoteBook(REALM_A) });
  assert(h.els.viewContent.textContent.includes("Chapter 1"), "a real successful detail catalog must have rendered");
  assert(h.frameIds().length > 0, "production must have queued its scroll restoration frame");
  h.leave("music"); h.window.scrollY = 911; h.runFrames();
  assert.equal(h.window.scrollY, 911, "an obsolete detail frame scrolled the newly opened view");
  assert.equal(h.els.viewContent.innerHTML, "OTHER VIEW");
}, (text) => replaceOnce(
  '          if (!isActive() || !operation.isActive() || requestId !== detailCatalogRequestId\n            || bookId !== String(detailState.book?.id || "") || book.sourceRealm !== detailState.book?.sourceRealm) return;\n',
  ""
)(text.replaceAll("\r\n", "\n")));
test("remote progress POST carries its confirmed realm with the original source URL", async (h) => {
  h.setActiveUrl(URL_A);
  await finish(h, h.api.renderNovelReader(ID, 1), () => chapterData(REALM_A));
  h.runFrames(); h.setRatio(0.6); h.api.__test.saveReaderProgress(); await settle();
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].url, URL_A);
  assert.equal(h.posts[0].data.sourceRealm, REALM_A);
  assert.equal(h.posts[0].data.chapterIndex, 1); assert.equal(h.posts[0].data.scrollRatio, 0.6);
});
test("old server without realm can still read online but cannot create a bound whole-book cache", async (h) => {
  h.setActiveUrl(URL_A);
  await finish(h, h.api.renderNovelReader(ID, 1), () => chapterData(null));
  assert.equal(h.state.book.id, ID); assert(h.els.viewContent.textContent.includes("BODY unbound 1"));
  assert(!h.state.book.sourceRealm);
  await finish(h, h.api.__test.cacheWholeBook(remoteBook(null), chapters, { renderDetail: false, confirmLarge: false }), () => chapterData(null));
  assert.equal(h.savedEntries.length, 0, "unversioned response must not silently acquire a URL-derived stable identity");
});
test("whole-book cache validates all responses then persists one consistent realm", async (h) => {
  h.setActiveUrl(URL_A); await confirmRealm(h, URL_A, REALM_A);
  await finish(h, h.api.__test.cacheWholeBook(remoteBook(), chapters, { renderDetail: false, confirmLarge: false }), (request) => {
    assert.equal(request.url, URL_A); const index = Number(request.path.match(/chapters\/(\d+)/)?.[1]);
    assert([1, 2].includes(index)); return chapterData(REALM_A, index);
  });
  assert.equal(h.savedEntries.length, 1); const stored = h.savedEntries[0];
  assert.equal(stored.book.sourceRealm, REALM_A); assert.equal(stored.chapters.length, 2);
  assert(stored.chapters.every((chapter) => chapter.content.includes(REALM_A)));
  assert.notEqual(stored.book.id, `local:remote:${ID}`);
});
for (const invalid of ["different realm", "missing realm", "wrong book"]) {
  test(`whole-book cache refuses ${invalid} in a later chapter without partial persistence`, async (h) => {
    h.setActiveUrl(URL_A); await confirmRealm(h, URL_A, REALM_A);
    await finish(h, h.api.__test.cacheWholeBook(remoteBook(), chapters, { renderDetail: false, confirmLarge: false }), (request) => {
      const index = Number(request.path.match(/chapters\/(\d+)/)?.[1]);
      if (index === 1) return chapterData(REALM_A, 1);
      return chapterData(invalid === "different realm" ? REALM_B : invalid === "missing realm" ? null : REALM_A, 2, invalid === "wrong book" ? "other-book" : ID);
    });
    assert.equal(h.savedEntries.length, 0, "mixed or unverifiable full-book cache reached persistent storage");
  }, invalid === "different realm" ? withoutChapterRealmCheck : undefined);
}
test("switching server during whole-book download cannot fetch or write through the new URL", async (h) => {
  h.setActiveUrl(URL_A); await confirmRealm(h, URL_A, REALM_A);
  const pending = h.api.__test.cacheWholeBook(remoteBook(), chapters, { renderDetail: false, confirmLarge: false });
  await settle(); assert.equal(h.fetches.length, 1); assert.equal(h.fetches[0].url, URL_A);
  h.setActiveUrl(URL_B); await confirmRealm(h, URL_B, REALM_B);
  await finish(h, pending, (request) => chapterData(REALM_A, Number(request.path.match(/chapters\/(\d+)/)?.[1]) || 1));
  assert(h.fetches.every((request) => request.url === URL_A), "remaining chapters were fetched from a different selected server");
  assert(!h.cacheCalls.some((call) => call.kind === "write" && call.url === URL_B && call.path !== receiptPath));
  assert.equal(h.savedEntries.length, 0, "server switch should cancel persistent full-book publication");
}, withoutOperationGuard);
test("same URL changing realm during download cannot publish the old generation as new source", async (h) => {
  h.setActiveUrl(URL_A); await confirmRealm(h, URL_A, REALM_A);
  const pending = h.api.__test.cacheWholeBook(remoteBook(), chapters, { renderDetail: false, confirmLarge: false });
  await settle(); assert.equal(h.fetches.length, 1); await confirmRealm(h, URL_A, REALM_B);
  await finish(h, pending, (request) => chapterData(REALM_A, Number(request.path.match(/chapters\/(\d+)/)?.[1]) || 1));
  assert.equal(h.savedEntries.length, 0);
  assert.equal(await h.api.__test.readRemoteSourceRealm(URL_A), REALM_B, "late old task must not revert newly confirmed source realm");
});
test("known live realm suppresses mismatched and unbound JSON chapter fallbacks", async (h) => {
  for (const cachedRealm of [REALM_A, null]) {
    h.setActiveUrl(URL_B); await confirmRealm(h, URL_B, REALM_B);
    h.cached.set(h.cacheKey(URL_B, `/api/novels/${ID}/chapters/1`), { payload: chapterData(cachedRealm), updatedAt: "old" });
    await finish(h, h.api.renderNovelReader(ID, 1), offline);
    assert(!h.els.viewContent.textContent.includes(`BODY ${cachedRealm || "unbound"} 1`));
  }
});
test("an explicitly unbound live server does not revive leftover bound JSON chapters", async (h) => {
  h.setActiveUrl(URL_A); await confirmRealm(h, URL_A, REALM_A);
  h.cached.set(h.cacheKey(URL_A, `/api/novels/${ID}/chapters/1`), { payload: chapterData(REALM_A), updatedAt: "old" });
  await h.api.__test.rememberRemoteSourceRealm(URL_A, { book: remoteBook(null) }); await settle();
  await finish(h, h.api.renderNovelReader(ID, 1), offline);
  assert(!h.els.viewContent.textContent.includes(`BODY ${REALM_A} 1`));
  assert(!await h.api.__test.readRemoteSourceRealm(URL_A));
});
for (const view of ["reader", "detail"]) for (const boundary of ["live", "cached"]) {
  test(`${view} catalog rejects ${boundary} bound data after the live server explicitly has no realm`, async (h) => {
    h.setActiveUrl(URL_A);
    let pending;
    if (view === "reader") {
      await finish(h, h.api.renderNovelReader(ID, 1), () => chapterData(null));
      h.state.catalogOpen = true;
      pending = h.api.__test.loadReaderCatalog();
    } else {
      pending = h.api.renderNovelDetail(ID); await settle();
      h.fetches.at(-1).wait.resolve({ book: remoteBook(null) });
    }
    await settle();
    const request = h.fetches.at(-1); assert(request.path.includes("/catalog"));
    const foreign = { ...catalogData(REALM_A), chapters: [{ index: 1, title: "FOREIGN_BOUND_CATALOG_SENTINEL" }, { index: 2, title: "foreign second chapter" }] };
    if (boundary === "cached") {
      h.cached.set(h.cacheKey(URL_A, request.path), { payload: foreign, updatedAt: "old-bound-library" });
      request.wait.reject(new Error("synthetic catalog network failure"));
    } else request.wait.resolve(foreign);
    await pending;
    assert.equal(await h.api.__test.readRemoteSourceRealm(URL_A), "");
    assert(!h.els.viewContent.textContent.includes("FOREIGN_BOUND_CATALOG_SENTINEL"), "a known-unbound server displayed another library's catalog");
    if (view === "reader") assert(!h.state.chapters.some((chapter) => chapter.title === "FOREIGN_BOUND_CATALOG_SENTINEL"));
    // Reader catalog currently has no JSON-cache fallback at all. This fourth
    // case proves non-consumption, not effectiveness of an unused cache gate.
    if (view === "reader" && boundary === "cached") assert(!h.cacheCalls.some((call) => call.kind === "read" && call.path === request.path));
  }, view === "reader" && boundary === "cached" ? undefined : withoutCatalogRealmGuards);
}
for (const view of ["reader", "detail"]) {
  test(`${view} old-server catalog with an empty realm still rejects the wrong book ID`, async (h) => {
    h.setActiveUrl(URL_A);
    let pending;
    if (view === "reader") {
      await finish(h, h.api.renderNovelReader(ID, 1), () => chapterData(null));
      h.state.catalogOpen = true; pending = h.api.__test.loadReaderCatalog();
    } else {
      pending = h.api.renderNovelDetail(ID); await settle();
      h.fetches.at(-1).wait.resolve({ book: remoteBook(null) });
    }
    await settle(); const request = h.fetches.at(-1); assert(request.path.includes("/catalog"));
    request.wait.resolve({ ...catalogData(null), bookId: "another-book", chapters: [{ index: 1, title: "WRONG_BOOK_CATALOG_SENTINEL" }] });
    await pending;
    assert.equal(await h.api.__test.readRemoteSourceRealm(URL_A), "");
    assert(!h.els.viewContent.textContent.includes("WRONG_BOOK_CATALOG_SENTINEL"), "an empty realm must not bypass book-ID validation");
    if (view === "reader") assert(!h.state.chapters.some((chapter) => chapter.title === "WRONG_BOOK_CATALOG_SENTINEL"));
  }, withoutPayloadBookId);
}
test("invalidated whole-book completion finally cannot repaint a different page", async (h) => {
  h.setActiveUrl(URL_A);
  await finish(h, h.api.renderNovelList(), () => ({ sourceRealm: REALM_A, books: [remoteBook()], total: 1 }));
  const pending = h.api.__test.cacheWholeBook(remoteBook(), chapters, { renderDetail: true, confirmLarge: false });
  await settle(); assert(h.fetches.at(-1).path.includes("/chapters/"));
  h.leave();
  await finish(h, pending, (request) => request.path.includes("/chapters/") ? chapterData(REALM_A, Number(request.path.match(/chapters\/(\d+)/)?.[1])) : {});
  assert.equal(h.els.viewContent.innerHTML, "OTHER VIEW");
  assert.equal(h.savedEntries.length, 0);
});

let failures = 0; let controls = 0;
for (const { name, run, mutation } of tests) {
  try { await run(harness()); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
  if (mutation) {
    let mutatedHarness;
    try { mutatedHarness = harness(mutation(source)); }
    catch (error) { failures++; console.error(`FAIL negative control setup error: ${name}\n${error.stack}`); continue; }
    try { await run(mutatedHarness); failures++; console.error(`FAIL negative control survived: ${name}`); }
    catch (error) {
      if (error.code !== "ERR_ASSERTION") { failures++; console.error(`FAIL negative control infrastructure error: ${name}\n${error.stack}`); }
      else { controls++; console.log(`CONTROL rejected: ${name} (${error.message.split("\n")[0]})`); }
    }
  }
}
console.log(`Novel source identity verification: ${tests.length} current-source VM scenarios; ${controls} executable legacy/mutation controls rejected; ${failures} failures.`);
if (failures) process.exitCode = 1;
