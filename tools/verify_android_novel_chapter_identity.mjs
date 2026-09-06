import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as mediaNavigationState from "../android-client/www/js/media-navigation-state.js";
import { createChannelHistoryState } from "../android-client/www/js/channel-history-state.js";
import { createReaderHarness, localEntry, settle } from "./fixtures/android-novel-reader-harness.mjs";

// The complete current createNovelViews executes in the VM. Only DOM, clocks,
// navigation, network, and storage boundaries are controlled. These tests do not
// infer chapter identity or pretend the storage double is IndexedDB; production
// storage/server reconciliation is covered by their independent suites.
// All books and body strings below are synthetic; no server/browser/DB is opened.
const source = fs.readFileSync(new URL("../android-client/www/modules/novels/novel-views.js", import.meta.url), "utf8");
const moduleSource = fs.readFileSync(new URL("../android-client/www/modules/novels/android-module.js", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../android-client/www/app.js", import.meta.url), "utf8");
const SERVER = "https://chapter-identity.invalid";
const REALM = "server:11111111-1111-4111-8111-111111111111";
const OTHER_REALM = "server:22222222-2222-4222-8222-222222222222";
const REV_OLD = "10000000-0000-4000-8000-000000000001";
const REV = "10000000-0000-4000-8000-000000000002";
const REV_NEW = "10000000-0000-4000-8000-000000000003";
const LOCAL = "local:stable-chapter-fixture";
const REMOTE = "stable-chapter-fixture";
const FIRST = "opaque-chapter-first";
const SECOND = "opaque-chapter-second";
const tests = [];
const test = (name, run, mutation, options) => tests.push({ name, run, mutation, options });
const clone = (value) => structuredClone(value);
const near = (actual, expected, name) => assert(Math.abs(actual - expected) < 1e-9, `${name}: ${actual} != ${expected}`);

function modernEntry({ id = LOCAL, revision = REV, recovery = null, ratio = 0.63 } = {}) {
  const entry = localEntry(id, ratio);
  entry.generation = `generation:${revision}`;
  entry.book.localGeneration = entry.generation;
  entry.book.catalogRevision = revision;
  entry.chapters.forEach((chapter, index) => { chapter.id = index ? SECOND : FIRST; });
  entry.book.progress = recovery ? null : { chapterId: SECOND, chapterIndex: 2, scrollRatio: ratio, catalogRevision: revision };
  entry.book.progressRecovery = recovery;
  return entry;
}
function recovery(status = "needs_review") {
  return {
    status, reason: status === "needs_review" ? "title_changed" : "chapter_missing",
    previous: { chapterId: "old-removed-chapter", chapterIndex: 7, title: "Previous synthetic anchor", scrollRatio: 0.63, catalogRevision: REV_OLD },
    ...(status === "needs_review" ? { candidate: { chapterId: SECOND, chapterIndex: 2, title: "Chapter 2", scrollRatio: 0, catalogRevision: REV } } : {})
  };
}
function remoteBook({ revision = REV, progressRecovery = null, progress } = {}) {
  return { id: REMOTE, sourceRealm: REALM, catalogRevision: revision, title: "Synthetic remote book", author: "Fixture author", chapterCount: 2,
    progress: progress === undefined ? progressRecovery ? null : { chapterId: SECOND, chapterIndex: 2, scrollRatio: 0.63, catalogRevision: revision } : progress,
    progressRecovery };
}
function chapterRows() {
  return [FIRST, SECOND].map((id, offset) => ({ id, bookId: REMOTE, index: offset + 1, title: `Chapter ${offset + 1}`, charCount: 100 }));
}
function catalog(book = remoteBook()) {
  return { sourceRealm: REALM, catalogRevision: book.catalogRevision, bookId: REMOTE,
    chapters: chapterRows(), total: 2, filteredTotal: 2, offset: 0 };
}
function payload(index = 1, book = remoteBook(), extra = {}) {
  return { sourceRealm: REALM, catalogRevision: book.catalogRevision, book: clone(book),
    chapter: { ...chapterRows()[index - 1], content: `SYNTHETIC BODY ${book.catalogRevision} ${index}` },
    prev: null, next: null, ...extra };
}
function anchor(index = 1, revision = REV, extra = {}) {
  return { chapterId: index === 1 ? FIRST : SECOND, catalogRevision: revision, sourceRealm: REALM, ...extra };
}
function harness(text = source, options = {}) {
  const h = createReaderHarness(text, { strictCache: true, ...options });
  h.books.clear(); h.setActiveUrl(SERVER);
  return h;
}
function button(h, text) {
  const buttons = h.els.viewContent.querySelectorAll("button").filter((item) => item.textContent === text);
  assert.equal(buttons.length, 1, `Expected one rendered button: ${text}`);
  return buttons[0];
}
function route(h) {
  const value = h.navigations.at(-1);
  assert(value, "A real click/open action must have reached navigation");
  return { view: value[0], params: value[1], options: value[2] };
}
async function finish(h, pending, respond) {
  let done = false; let error;
  pending.then(() => { done = true; }, (value) => { done = true; error = value; });
  const seen = new Set();
  for (let round = 0; round < 60 && !done; round++) {
    await settle();
    for (const request of h.fetches) {
      if (seen.has(request)) continue;
      seen.add(request);
      try { request.wait.resolve(respond(request)); } catch (value) { request.wait.reject(value); }
    }
  }
  await settle();
  assert(done, "Bounded synthetic request schedule did not finish");
  if (error) throw error;
  return pending;
}
async function remoteDetail(h, book) {
  await finish(h, h.api.renderNovelDetail(REMOTE), (request) => request.path.includes("/catalog")
    ? catalog(book) : { sourceRealm: REALM, book });
}
async function remoteReader(h, index = 1, book = remoteBook(), options = {}) {
  await finish(h, h.api.renderNovelReader(REMOTE, index, () => true, options), () => payload(index, book));
}
function assertAnchor(actual, index, revision = REV, { realm = true } = {}) {
  assert.equal(actual.chapterId, index === 1 ? FIRST : SECOND, "stable chapter ID must cross the UI boundary");
  assert.equal(actual.catalogRevision, revision, "the read snapshot revision must cross the UI boundary");
  if (realm) assert.equal(actual.sourceRealm, REALM);
}
function pathAnchor(request, index, revision = REV) {
  const query = new URL(request.path, SERVER).searchParams;
  assertAnchor(Object.fromEntries(query), index, revision);
  assert(!query.has("confirmProgress"), "UI confirmation intent is not a server-side query precondition");
}

for (const status of ["needs_review", "unresolved"]) {
  test(`local ${status} detail keeps the old anchor visible and continue does not guess a chapter`, async (h) => {
    const entry = modernEntry({ recovery: recovery(status) }); h.books.set(LOCAL, entry);
    await h.api.renderNovelDetail(LOCAL);
    assert(h.els.viewContent.textContent.includes("Previous synthetic anchor"), "recovery detail lost the previous anchor title");
    assert(h.els.viewContent.textContent.includes("63"), "recovery detail lost the previous ratio");
    button(h, "选择续读位置").click();
    assert.equal(route(h).view, "novelDetail", "uncertain continue must enter detail, not an arbitrary reader");
    assert.equal(route(h).params.id, LOCAL);
    assert.equal(h.saves.length, 0); assert.equal(h.posts.length, 0);
    assert(!h.storageCalls.some((call) => call.kind === "chapter"), "a detail decision must not read an arbitrary body");
    assert.deepEqual(h.books.get(LOCAL).book.progressRecovery, entry.book.progressRecovery);
  });
  test(`remote ${status} continue is also a visible decision, not an ordinal fallback`, async (h) => {
    const book = remoteBook({ progressRecovery: recovery(status) }); await remoteDetail(h, book);
    assert(h.els.viewContent.textContent.includes("Previous synthetic anchor"));
    button(h, "选择续读位置").click();
    assert.equal(route(h).view, "novelDetail"); assert.equal(route(h).params.id, REMOTE);
    assert.equal(h.posts.length, 0);
    assert(!h.fetches.some((call) => call.path.includes("/chapters/")));
  });
}

test("explicit local catalog choice carries its exact snapshot and only then clears recovery on save", async (h) => {
  h.books.set(LOCAL, modernEntry({ recovery: recovery() })); await h.api.renderNovelDetail(LOCAL);
  const choices = h.els.viewContent.querySelectorAll(".novel-mobile-chapter");
  assert.equal(choices.length, 2); choices[1].click();
  const selected = route(h); assert.equal(selected.view, "novelReader");
  assertAnchor(selected.params, 2, REV, { realm: false }); assert.equal(selected.params.confirmProgress, "1");
  assert.equal(h.saves.length, 0, "merely choosing navigation must not save before a successful body read");
  await h.api.renderNovelReader(LOCAL, selected.params.chapterIndex, () => true, selected.params);
  const read = h.storageCalls.find((call) => call.kind === "chapter");
  assertAnchor(read.options, 2, REV, { realm: false });
  h.runFrames(); near(h.api.__test.captureReaderRatio(), 0, "confirmed changed body starts at chapter head");
  h.runTimers(80); await settle();
  assert.equal(h.saves.length, 1); assertAnchor(h.saves[0].progress, 2, REV, { realm: false });
  assert.equal(h.saves[0].options.expectedGeneration, `generation:${REV}`);
  assert.equal(h.books.get(LOCAL).book.progressRecovery, null);
  assert.equal(h.books.get(LOCAL).book.progress.chapterId, SECOND);
});

test("explicit remote catalog choice includes chapter identity, revision and realm", async (h) => {
  await remoteDetail(h, remoteBook({ progressRecovery: recovery() }));
  h.els.viewContent.querySelectorAll(".novel-mobile-chapter")[1].click();
  const selected = route(h); assert.equal(selected.view, "novelReader"); assertAnchor(selected.params, 2);
  assert.equal(selected.params.confirmProgress, "1");
});

test("the rendered candidate button is an explicit chapter-head choice, not automatic recovery", async (h) => {
  h.books.set(LOCAL, modernEntry({ recovery: recovery() })); await h.api.renderNovelDetail(LOCAL);
  const candidate = h.els.viewContent.querySelectorAll("button").filter((item) => item.textContent.includes("查看候选"));
  assert.equal(candidate.length, 1); assert(candidate[0].textContent.includes("章首"));
  assert.equal(h.saves.length, 0); candidate[0].click();
  assert.equal(route(h).view, "novelReader"); assertAnchor(route(h).params, 2, REV, { realm: false });
  assert.equal(route(h).params.confirmProgress, "1"); assert.equal(h.saves.length, 0);
});

test("a carried recovery candidate from an older catalog is visible only as history, not a current jump", async (h) => {
  const uncertain = recovery(); uncertain.candidate.catalogRevision = REV_OLD;
  h.books.set(LOCAL, modernEntry({ recovery: uncertain })); await h.api.renderNovelDetail(LOCAL);
  assert(h.els.viewContent.textContent.includes("Previous synthetic anchor"));
  assert(!h.els.viewContent.querySelectorAll("button").some((item) => item.textContent.includes("查看候选")));
  assert.equal(h.saves.length, 0);
});

test("opening an unconfirmed recovery reader never auto-saves away the uncertainty", async (h) => {
  const entry = modernEntry({ recovery: recovery() }); h.books.set(LOCAL, entry);
  await h.api.renderNovelReader(LOCAL, 2, () => true, { chapterId: SECOND, catalogRevision: REV });
  h.runFrames(); h.runTimers(80); h.runTimers(600); await settle();
  assert.equal(h.saves.length, 0, "a restored URL is not explicit confirmation of a changed-body candidate");
  assert.deepEqual(h.books.get(LOCAL).book.progressRecovery, entry.book.progressRecovery);
});

test("modern local progress is restored by chapter ID and revision after reorder", async (h) => {
  const entry = modernEntry(); entry.chapters.reverse().forEach((chapter, offset) => { chapter.index = offset + 1; });
  entry.book.progress.chapterIndex = 1; h.books.set(LOCAL, entry);
  await h.api.renderNovelReader(LOCAL, 1, () => true, { chapterId: SECOND, catalogRevision: REV });
  h.runFrames(); assert.equal(h.state.chapter.id, SECOND);
  near(h.api.__test.captureReaderRatio(), 0.63, "same exact chapter retained its ratio after moving ordinal");
});
for (const mismatch of ["chapter", "revision"]) {
  test(`same ordinal does not restore a modern progress with mismatched ${mismatch}`, async (h) => {
    const entry = modernEntry();
    if (mismatch === "chapter") entry.book.progress.chapterId = "different-chapter";
    else entry.book.progress.catalogRevision = REV_OLD;
    h.books.set(LOCAL, entry); await h.api.renderNovelReader(LOCAL, 2); h.runFrames();
    near(h.api.__test.captureReaderRatio(), 0, "wrong modern anchor ratio must not move to this body");
  });
}

for (const stale of ["revision", "chapter"]) {
  test(`local route with stale ${stale} cannot read or save the replacement at the same index`, async (h) => {
    h.books.set(LOCAL, modernEntry());
    const options = { chapterId: stale === "chapter" ? "old-chapter" : SECOND, catalogRevision: stale === "revision" ? REV_OLD : REV, confirmProgress: "1" };
    await h.api.renderNovelReader(LOCAL, 2, () => true, options); h.runFrames(); h.runTimers(80); await settle();
    assert.equal(h.els.viewContent.querySelector(".novel-reader-screen"), null);
    assert.equal(h.saves.length, 0);
    const read = h.storageCalls.find((call) => call.kind === "chapter");
    assert.equal(read.options.chapterId, options.chapterId); assert.equal(read.options.catalogRevision, options.catalogRevision);
  });
}

test("remote read and subsequent progress carry the body snapshot, not a later metadata version", async (h) => {
  await remoteReader(h, 2, remoteBook(), anchor(2));
  const request = h.fetches.find((call) => call.path.includes("/chapters/")); pathAnchor(request, 2);
  h.runFrames(); h.setRatio(0.42); h.api.__test.saveReaderProgress(); await settle();
  assert.equal(h.posts.length, 1); assertAnchor(h.posts[0].data, 2);
  assert.equal(h.posts[0].url, SERVER); near(h.posts[0].data.scrollRatio, 0.42, "actual visible position saved");
});
for (const mismatch of ["chapter", "revision", "envelope"]) {
  test(`remote exact route rejects ${mismatch} mismatch at a still-valid ordinal`, async (h) => {
    const data = payload(2);
    if (mismatch === "chapter") data.chapter.id = "different-chapter";
    if (mismatch === "revision") { data.book.catalogRevision = REV_NEW; data.catalogRevision = REV_NEW; }
    if (mismatch === "envelope") data.catalogRevision = REV_NEW;
    await finish(h, h.api.renderNovelReader(REMOTE, 2, () => true, anchor(2)), () => data);
    h.runFrames(); h.runTimers(80); await settle();
    assert.equal(h.els.viewContent.querySelector(".novel-reader-screen"), null);
    assert.equal(h.posts.length, 0);
    assert(!h.cacheCalls.some((call) => call.kind === "write" && call.path.includes("/chapters/") && call.payload.chapter?.id === data.chapter.id));
  });
}

test("same-source later catalog revision cannot be painted into an earlier detail snapshot", async (h) => {
  const book = remoteBook();
  await finish(h, h.api.renderNovelDetail(REMOTE), (request) => request.path.includes("/catalog")
    ? { ...catalog(remoteBook({ revision: REV_NEW })), chapters: [{ id: "new-body", index: 1, title: "WRONG REVISION CATALOG" }] }
    : { sourceRealm: REALM, book });
  assert(!h.els.viewContent.textContent.includes("WRONG REVISION CATALOG"));
  const request = h.fetches.find((call) => call.path.includes("/catalog"));
  const query = new URL(request.path, SERVER).searchParams;
  assert.equal(query.get("catalogRevision"), REV); assert.equal(query.get("sourceRealm"), REALM);
});

test("same-source reader catalog revision is checked against the body already being read", async (h) => {
  await remoteReader(h, 1, remoteBook(), anchor()); h.state.catalogOpen = true;
  await finish(h, h.api.__test.loadReaderCatalog(), (request) => request.path.includes("/catalog")
    ? { ...catalog(remoteBook({ revision: REV_NEW })), chapters: [{ id: "foreign-revision", index: 1, title: "WRONG READER CATALOG" }] }
    : payload());
  assert(!h.state.chapters.some((chapter) => chapter.title === "WRONG READER CATALOG"));
  assert(!h.els.viewContent.textContent.includes("WRONG READER CATALOG"));
});

test("whole-book publication retains source chapter IDs and its single source catalog revision", async (h) => {
  const book = remoteBook();
  await finish(h, h.api.__test.cacheWholeBook(book, chapterRows(), { renderDetail: false, confirmLarge: false }), (request) => payload(Number(request.path.match(/chapters\/(\d+)/)?.[1])));
  assert.equal(h.savedEntries.length, 1);
  const saved = h.savedEntries[0];
  assert.equal(saved.book.sourceCatalogRevision, REV);
  assert.deepEqual(saved.chapters.map((chapter) => chapter.sourceChapterId), [FIRST, SECOND]);
  assert(saved.chapters.every((chapter) => chapter.sourceCatalogRevision === REV));
  for (const request of h.fetches) pathAnchor(request, Number(request.path.match(/chapters\/(\d+)/)?.[1]));
});
for (const mismatch of ["revision", "chapter", "missing-revision"]) {
  test(`whole-book cache refuses later ${mismatch} without publishing mixed bodies`, async (h) => {
    await finish(h, h.api.__test.cacheWholeBook(remoteBook(), chapterRows(), { renderDetail: false, confirmLarge: false }), (request) => {
      const index = Number(request.path.match(/chapters\/(\d+)/)?.[1]); const data = payload(index);
      if (index === 2) {
        if (mismatch === "revision") { data.book.catalogRevision = REV_NEW; data.catalogRevision = REV_NEW; }
        if (mismatch === "chapter") data.chapter.id = "other-chapter-same-index";
        if (mismatch === "missing-revision") { delete data.book.catalogRevision; delete data.catalogRevision; }
      }
      return data;
    });
    assert.equal(h.savedEntries.length, 0, "a mixed/unverified source snapshot reached persistent publication");
  });
}

test("reimport uses the actual old generation as CAS, while a fresh import is insert-only", async (h) => {
  const file = { fileName: "synthetic.txt", sourceUri: "content://fixture/chapter-identity", text: "第一章 开始\nOnly synthetic body." };
  const fresh = await h.api.__test.saveLocalTextFile(file);
  assert.equal(h.storageCalls.find((call) => call.kind === "saveEntry").options.expectedGeneration, null);
  await h.api.__test.saveLocalTextFile({ ...file, text: `${file.text}\nA revision.` });
  assert.equal(h.storageCalls.filter((call) => call.kind === "saveEntry")[1].options.expectedGeneration, fresh.generation);
});

test("local rejected generation save preserves recovery and visibly blocks further obsolete writes", async (h) => {
  const entry = modernEntry({ recovery: recovery() }); h.books.set(LOCAL, entry);
  await h.api.renderNovelReader(LOCAL, 2, () => true, { chapterId: SECOND, catalogRevision: REV, confirmProgress: "1" });
  h.runFrames(); h.setRatio(0.2); h.api.__test.saveReaderProgress(); await settle();
  assert.equal(h.saves.length, 1);
  assert.deepEqual(clone(h.state.book.progressRecovery), entry.book.progressRecovery, "pending save is not a committed confirmation");
  const replacement = modernEntry({ revision: REV_NEW, recovery: recovery("unresolved") }); h.books.set(LOCAL, replacement);
  await h.resolveSave(0);
  assert.equal(h.state.progressBlocked, true);
  assert(h.statuses.some(([text, level]) => level === "error" && text.includes("未覆盖")), "stale local save failure was invisible");
  assert.deepEqual(h.books.get(LOCAL), replacement, "a stale old-body write changed the replacement");
  assert.deepEqual(clone(h.state.book.progressRecovery), entry.book.progressRecovery);
  h.api.__test.saveReaderProgress(); await settle(); assert.equal(h.saves.length, 1);
}, undefined, { deferSaves: true });

test("local ordinary save failure retains recovery, exposes failure and allows an explicit retry", async (h) => {
  const entry = modernEntry({ recovery: recovery() }); h.books.set(LOCAL, entry);
  await h.api.renderNovelReader(LOCAL, 2, () => true, { chapterId: SECOND, catalogRevision: REV, confirmProgress: "1" });
  h.runFrames(); h.api.__test.saveReaderProgress(); await settle();
  h.saves[0].wait.reject(new Error("synthetic transaction abort")); await settle();
  assert(h.statuses.some(([text, level]) => level === "error" && text.includes("synthetic transaction abort")));
  assert.deepEqual(h.books.get(LOCAL).book.progressRecovery, entry.book.progressRecovery);
  assert.deepEqual(clone(h.state.book.progressRecovery), entry.book.progressRecovery);
  h.api.__test.saveReaderProgress(); await settle(); assert.equal(h.saves.length, 2);
  await h.resolveSave(1); assert.equal(h.books.get(LOCAL).book.progressRecovery, null);
}, undefined, { deferSaves: true });

test("remote 409 save keeps recovery visible and does not keep posting obsolete snapshots", async (h) => {
  const book = remoteBook({ progressRecovery: recovery() });
  await remoteReader(h, 2, book, anchor(2, REV, { confirmProgress: "1" })); h.runFrames();
  h.api.__test.saveReaderProgress(); await settle(); assert.equal(h.posts.length, 1);
  assert.deepEqual(clone(h.state.book.progressRecovery), book.progressRecovery);
  h.posts[0].wait.reject(Object.assign(new Error("synthetic stale catalog"), { status: 409 })); await settle();
  assert.equal(h.state.progressBlocked, true);
  assert(h.statuses.some(([text, level]) => level === "error" && text.includes("未覆盖")));
  assert.deepEqual(clone(h.state.book.progressRecovery), book.progressRecovery);
  h.api.__test.saveReaderProgress(); await settle(); assert.equal(h.posts.length, 1);
}, undefined, { deferPosts: true });

for (const outcome of ["success", "409"]) {
  test(`late remote ${outcome} from an old revision cannot resolve or block the newly opened revision`, async (h) => {
    await remoteReader(h, 2, remoteBook({ progressRecovery: recovery() }), anchor(2, REV, { confirmProgress: "1" }));
    h.runFrames(); h.api.__test.saveReaderProgress(); await settle(); assert.equal(h.posts.length, 1);
    const nextRecovery = recovery("unresolved"); nextRecovery.previous.title = "NEW RECOVERY ANCHOR";
    await remoteReader(h, 2, remoteBook({ revision: REV_NEW, progressRecovery: nextRecovery }), anchor(2, REV_NEW, { confirmProgress: "1" }));
    const statuses = h.statuses.length;
    if (outcome === "success") h.posts[0].wait.resolve({ progress: { chapterId: SECOND, chapterIndex: 2, catalogRevision: REV, scrollRatio: 0.9 } });
    else h.posts[0].wait.reject(Object.assign(new Error("obsolete rejection"), { status: 409 }));
    await settle();
    assert.equal(h.state.book.catalogRevision, REV_NEW);
    assert.deepEqual(clone(h.state.book.progressRecovery), nextRecovery);
    assert.equal(h.state.progressBlocked, false); assert.equal(h.statuses.length, statuses);
  }, undefined, { deferPosts: true });
}

test("old and new same-source prefetch requests are independently keyed by catalog revision", async (h) => {
  const first = h.api.renderNovelReader(REMOTE, 1, () => true, anchor()); await settle();
  h.fetches[0].wait.resolve(payload(1, remoteBook(), { next: chapterRows()[1] })); await first; await settle();
  const oldPrefetch = h.fetches.find((request) => request.path.includes("/chapters/2")); assert(oldPrefetch);
  pathAnchor(oldPrefetch, 2, REV);
  const second = h.api.renderNovelReader(REMOTE, 1, () => true, anchor(1, REV_NEW)); await settle();
  const newFirst = h.fetches.find((request) => request.path.includes("/chapters/1") && request.path.includes(REV_NEW)); assert(newFirst);
  newFirst.wait.resolve(payload(1, remoteBook({ revision: REV_NEW }), { next: chapterRows()[1] })); await second; await settle();
  const prefetches = h.fetches.filter((request) => request.path.includes("/chapters/2"));
  assert.equal(prefetches.length, 2, "new revision reused the old revision's in-flight next-chapter request");
  pathAnchor(prefetches[1], 2, REV_NEW);
  prefetches[1].wait.resolve(payload(2, remoteBook({ revision: REV_NEW })));
  oldPrefetch.wait.resolve(payload(2)); await settle();
  const fetchCount = h.fetches.length;
  await finish(h, h.api.renderNovelReader(REMOTE, 2, () => true, anchor(2, REV_NEW)), () => { throw new Error("Unexpected replacement fetch"); });
  assert.equal(h.fetches.length, fetchCount, "the already-prefetched matching revision was not used");
  assert.equal(h.state.book.catalogRevision, REV_NEW);
  assert(h.state.chapter.content.includes(REV_NEW));
  assert(!h.state.chapter.content.includes(REV_OLD));
});

test("an obsolete JSON body cached under a modern request path is still rejected", async (h) => {
  const query = new URLSearchParams({ catalogRevision: REV, chapterId: SECOND, sourceRealm: REALM });
  h.cached.set(h.cacheKey(SERVER, `/api/novels/${REMOTE}/chapters/2?${query}`), { payload: payload(2, remoteBook({ revision: REV_OLD })), updatedAt: "synthetic" });
  await finish(h, h.api.renderNovelReader(REMOTE, 2, () => true, anchor(2)), () => { throw new Error("synthetic offline"); });
  assert.equal(h.els.viewContent.querySelector(".novel-reader-screen"), null);
  assert.equal(h.posts.length, 0);
});

test("a source chapter selection maps to the matching local chapter ID, never the source ordinal", async (h) => {
  const id = h.api.__test.remoteCacheIdFromSourceId(REMOTE, REALM);
  const entry = modernEntry({ id });
  Object.assign(entry.book, { sourceRealm: REALM, sourceType: "remote-cache", sourceBookId: REMOTE, sourceCatalogRevision: REV });
  entry.book.catalogRevision = "local-catalog-revision";
  entry.book.progress = null;
  entry.chapters.forEach((chapter, index) => { chapter.sourceChapterId = index ? FIRST : SECOND; chapter.sourceCatalogRevision = REV; });
  h.books.set(id, entry);
  await h.api.__test.rememberRemoteSourceRealm(SERVER, { sourceRealm: REALM, book: remoteBook() });
  await h.api.renderNovelReader(REMOTE, 2, () => true, anchor(2, REV, { confirmProgress: "1" }));
  assert.equal(h.state.book.id, id); assert.equal(h.state.chapter.index, 1);
  assert.equal(h.state.chapter.sourceChapterId, SECOND);
  const read = h.storageCalls.find((call) => call.kind === "chapter");
  assert.equal(read.options.chapterId, FIRST); assert.equal(read.options.catalogRevision, "local-catalog-revision");
  assert.equal(h.fetches.length, 0);
});

test("a later server edition cannot silently fall back to an older full local cache", async (h) => {
  const id = h.api.__test.remoteCacheIdFromSourceId(REMOTE, REALM); const entry = modernEntry({ id });
  Object.assign(entry.book, { sourceRealm: REALM, sourceType: "remote-cache", sourceBookId: REMOTE, sourceCatalogRevision: REV_OLD });
  entry.chapters.forEach((chapter, index) => { chapter.sourceChapterId = index ? SECOND : FIRST; chapter.sourceCatalogRevision = REV_OLD; });
  h.books.set(id, entry); await h.api.__test.rememberRemoteSourceRealm(SERVER, { sourceRealm: REALM, book: remoteBook() });
  await finish(h, h.api.renderNovelReader(REMOTE, 2, () => true, anchor(2)), () => { throw new Error("synthetic offline"); });
  assert(!h.storageCalls.some((call) => call.kind === "chapter"));
  assert.equal(h.els.viewContent.querySelector(".novel-reader-screen"), null);
  assert(h.books.has(id), "rejecting a stale automatic fallback must not delete the older cache");
});

test("cloned chapter IDs and catalog revisions cannot let B cache answer an explicit A source anchor", async (h) => {
  const id = h.api.__test.remoteCacheIdFromSourceId(REMOTE, OTHER_REALM);
  const entry = modernEntry({ id });
  Object.assign(entry.book, { sourceRealm: OTHER_REALM, sourceType: "remote-cache", sourceBookId: REMOTE, sourceCatalogRevision: REV });
  entry.chapters.forEach((chapter, index) => {
    chapter.sourceChapterId = index ? SECOND : FIRST; chapter.sourceCatalogRevision = REV;
    chapter.content = "WRONG LIBRARY B CACHED BODY";
  });
  h.books.set(id, entry);
  await h.api.__test.rememberRemoteSourceRealm(SERVER, { sourceRealm: OTHER_REALM, book: { ...remoteBook(), sourceRealm: OTHER_REALM } });
  await finish(h, h.api.renderNovelReader(REMOTE, 1, () => true, anchor(1, REV, { confirmProgress: "1" })), () => { throw new Error("synthetic offline"); });
  assert(!h.els.viewContent.textContent.includes("WRONG LIBRARY B CACHED BODY"), "a source-A route displayed cloned source-B cached text");
  assert(!h.storageCalls.some((call) => call.kind === "chapter" && call.id === id), "mismatched source anchor reached B's body store");
  assert(h.books.has(id), "rejecting an automatic source mismatch must not remove the cache");
  assert.equal(h.saves.length, 0);
});

test("same-URI reimport refuses a replacement committed while the old snapshot read was pending", async (h) => {
  const file = { fileName: "synthetic-cas.txt", sourceUri: "content://fixture/chapter-cas", text: "第一章\nOnly synthetic old body." };
  const raw = h.api.__test.createLocalBookEntry(file); const old = modernEntry({ id: raw.book.id }); h.books.set(raw.book.id, old);
  const read = h.queueRead(raw.book.id); const pending = h.api.__test.saveLocalTextFile(file); await settle();
  const replacement = modernEntry({ id: raw.book.id, revision: REV_NEW }); h.books.set(raw.book.id, replacement);
  read.resolve(old); await assert.rejects(pending, /其他操作|更新|覆盖/);
  const call = h.storageCalls.find((call) => call.kind === "saveEntry");
  assert.equal(call.options.expectedGeneration, old.generation);
  assert.deepEqual(h.books.get(raw.book.id), replacement);
});

function mutateFunction(name, from, to, { all = false } = {}) {
  return (text) => {
    const pattern = new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`);
    const body = text.match(pattern)?.[0];
    assert(body?.includes(from), `Missing exact production mutation anchor in ${name}: ${from}`);
    if (!all) assert.equal(body.split(from).length, 2, `Ambiguous production mutation in ${name}`);
    const changed = all ? body.split(from).join(to) : body.replace(from, to);
    return text.replace(pattern, () => changed);
  };
}
function control(name, mutation) {
  const item = tests.find((item) => item.name === name);
  assert(item, `Cannot attach safety control: ${name}`); assert(!item.mutation);
  item.mutation = mutation;
}
const noRevisionValidation = mutateFunction("matchesRemotePayload", "if (anchor.catalogRevision && revision !== anchor.catalogRevision) return false;", "// Negative control: ignores the requested catalog revision.");
control("local needs_review detail keeps the old anchor visible and continue does not guess a chapter",
  mutateFunction("openReader", "if (!options.exactChapter && target.progressRecovery)", "if (false && !options.exactChapter && target.progressRecovery)"));
control("opening an unconfirmed recovery reader never auto-saves away the uncertainty",
  mutateFunction("renderNovelReaderData", "if (book.progressRecovery && !readerState.session.confirmProgress)", "if (false && book.progressRecovery && !readerState.session.confirmProgress)"));
for (const mismatch of ["chapter", "revision"]) control(`same ordinal does not restore a modern progress with mismatched ${mismatch}`,
  mutateFunction("progressMatchesChapter", "if (book.catalogRevision) return progress.catalogRevision === book.catalogRevision && progress.chapterId === chapter.id;", "if (book.catalogRevision) return Number(progress.chapterIndex) === Number(chapter.index);"));
control("local route with stale revision cannot read or save the replacement at the same index",
  mutateFunction("renderLocalNovelReader", "readLocalNovelChapter(bookId, Math.max(1, Number(chapterIndex || 1)), anchor)", "readLocalNovelChapter(bookId, Math.max(1, Number(chapterIndex || 1)))"));
control("remote exact route rejects revision mismatch at a still-valid ordinal", noRevisionValidation);
control("remote exact route rejects chapter mismatch at a still-valid ordinal",
  mutateFunction("matchesRemotePayload", "if (anchor.chapterId && data.chapter?.id !== anchor.chapterId) return false;", "// Negative control: ignores requested chapter identity."));
control("whole-book cache refuses later revision without publishing mixed bodies", noRevisionValidation);
control("remote read and subsequent progress carry the body snapshot, not a later metadata version",
  mutateFunction("saveReaderProgress", "...(catalogRevision ? { chapterId, catalogRevision } : {}),", "", { all: true }));
control("reimport uses the actual old generation as CAS, while a fresh import is insert-only",
  mutateFunction("saveLocalTextFile", "saveLocalNovelEntry(entry, { expectedGeneration: existing?.generation ?? null })", "saveLocalNovelEntry(entry)"));
control("local rejected generation save preserves recovery and visibly blocks further obsolete writes",
  mutateFunction("saveReaderProgress", "if (!entry && isCurrentReaderSession(session))", "if (false && !entry && isCurrentReaderSession(session))"));
control("remote 409 save keeps recovery visible and does not keep posting obsolete snapshots",
  mutateFunction("queueRemoteReaderProgress", "if (error.status === 409 || error.statusCode === 409)", "if (false && (error.status === 409 || error.statusCode === 409))"));
control("old and new same-source prefetch requests are independently keyed by catalog revision",
  mutateFunction("remoteChapterPrefetchKey", "if (catalogRevision) tuple.push(catalogRevision);", "// Negative control: source identity without content revision."));
control("a carried recovery candidate from an older catalog is visible only as history, not a current jump",
  mutateFunction("createProgressRecoveryPanel", "candidate?.chapterId && candidate.catalogRevision === book.catalogRevision", "candidate?.chapterId"));
control("cloned chapter IDs and catalog revisions cannot let B cache answer an explicit A source anchor",
  mutateFunction("renderCachedReader", "if (anchor.sourceRealm && normalizeSourceRealm(entry.book.sourceRealm) !== anchor.sourceRealm) return false;", "// Negative control: cloned source IDs/revisions are accepted across realms."));

// Execute the complete Android module adapter, with the already-created real
// novel views instance as its factory boundary. This checks actual route dispatch
// (not a regex-only wiring claim); no Android shell or WebView is being simulated.
function actualModule(h, text) {
  const noop = () => {};
  const host = { els: h.els, getActiveUrl: () => SERVER,
    navigation: { showView: noop, goBack: noop },
    ui: { setActiveBottom: noop, renderCurrentView: noop, renderCurrentViewPreservingScroll: noop, setStatus: noop, refreshChrome: noop } };
  const context = vm.createContext({ window: h.window, document: h.document, createNovelViews: () => h.api,
    openMobileActionSheet: async () => null });
  vm.runInContext(text.replace(/^import .*;\r?\n/gm, "").replace("export function createAndroidModule", "function createAndroidModule"), context);
  return context.createAndroidModule({ host });
}
async function verifyModuleRoute(text) {
  const h = harness(); h.books.set(LOCAL, modernEntry());
  const module = actualModule(h, text);
  const reader = module.routes.find((item) => item.view === "novelReader"); assert(reader);
  const params = { id: LOCAL, chapterIndex: "2", chapterId: SECOND, catalogRevision: REV, confirmProgress: "1" };
  await reader.render(params, () => true);
  const read = h.storageCalls.find((item) => item.kind === "chapter"); assert(read);
  assertAnchor(read.options, 2, REV, { realm: false });
  assert.equal(h.state.session.confirmProgress, true);
}

function shellFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing actual shell function ${name}`);
  const remaining = text.slice(start);
  const next = /\r?\n(?:async )?function\s/.exec(remaining);
  assert(next, `Missing full-function boundary for ${name}`);
  return remaining.slice(0, next.index);
}
// These are complete real shell functions, not a copied sanitizer. Unrelated
// chrome and the browser history/localStorage backends are explicit doubles.
const SHELL_METHODS = ["sanitizeViewParams", "shouldRememberView", "defaultViewState", "readLastViewState", "rememberViewState",
  "viewRouteHash", "readViewStateFromHash", "showView", "routeHistoryState", "rememberCurrentScrollInHistory",
  "pushViewHistory", "replaceCurrentHistory", "returnToStackView", "restoreFromHistoryState", "openNativeLibraryRoute", "decodeRouteSegment",
  "captureChannelRange", "restoreChannelRange", "sameViewParams"];
async function verifyShellRoutes(text) {
  const h = harness(); h.books.set(LOCAL, modernEntry()); const module = actualModule(h, moduleSource);
  const storage = new Map(); const renders = []; const queued = []; const noop = () => {};
  const context = vm.createContext({ ...mediaNavigationState, URL, URLSearchParams, Date, Map, Set, activeUrl: SERVER,
    channelLimit: 40, channelHistoryState: createChannelHistoryState(),
    DEFAULT_VIEW: "novels", LAST_VIEW_STORAGE_KEY: "synthetic-chapter-route", HISTORY_MARKER: "fanhao-android",
    currentView: "novelDetail", currentViewParams: { id: LOCAL }, viewStack: [], searchSurfaceExpanded: false,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { location: { hash: "" }, history: { state: null, length: 1,
      pushState(state, _title, hash) { this.state = clone(state); this.length++; context.window.location.hash = hash; },
      replaceState(state, _title, hash) { this.state = clone(state); context.window.location.hash = hash; }, back: noop } },
    currentScrollY: () => 137, shouldPreserveShortVideoHome: () => false,
    rememberHomeMode: noop, rememberGalleryMode: noop, rememberReadingMode: noop,
    closeHomeModePicker: noop, closeGalleryModePicker: noop, closeReadingModePicker: noop,
    resetViewLimitsForView: noop, queueScrollRestore: noop, hideSettingsSurface: noop, showSettings: noop,
    mediaViewer: null,
    renderCurrentView() {
      renders.push({ view: context.currentView, params: clone(context.currentViewParams) });
      if (context.currentView === "novelReader") queued.push(module.routes.find((item) => item.view === "novelReader").render(context.currentViewParams, () => true));
    }
  });
  const views = text.match(/^const RESTORABLE_VIEWS = .*;\r?$/m)?.[0]; assert(views, "Actual restorable-view declaration is required");
  vm.runInContext(`${views}\n${SHELL_METHODS.map((name) => shellFunction(text, name)).join("\n")}`, context, { filename: "actual-novel-shell-routing.js" });
  const params = { id: LOCAL, chapterIndex: "2", ...anchor(2), confirmProgress: "1", unknown: "not-a-route-parameter" };
  const expected = { ...params }; delete expected.unknown;
  assert.deepEqual(clone(context.sanitizeViewParams("novelReader", params)), expected, "shell sanitizer removed the selected chapter anchor");
  const invalid = context.sanitizeViewParams("novelReader", { id: LOCAL, chapterIndex: 2, chapterId: {}, catalogRevision: 12, sourceRealm: [], confirmProgress: true });
  assert.deepEqual(clone(invalid), { id: LOCAL, chapterIndex: "2" }, "non-string identity or implicit confirmation must not enter restored routes");

  context.showView("novelReader", params, { push: true }); await Promise.all(queued.splice(0));
  assert.deepEqual(clone(context.currentViewParams), expected);
  assert.deepEqual(clone(context.window.history.state.params), expected, "history state lost the selected anchor");
  assert.deepEqual(clone(context.readLastViewState().params), expected, "persisted last-view state lost the selected anchor");
  assert.deepEqual(clone(context.readViewStateFromHash().params), expected, "hash round-trip lost the selected anchor");
  assertAnchor(h.storageCalls.find((call) => call.kind === "chapter").options, 2);
  assert.equal(h.state.session.confirmProgress, true);

  context.showView("novelDetail", { id: LOCAL }, { push: true });
  assert.equal(context.returnToStackView(), true); await Promise.all(queued.splice(0));
  assert.deepEqual(clone(context.currentViewParams), expected, "in-app back stack lost the prior body snapshot");
  assert.deepEqual(renders.at(-1).params, expected);
  const history = context.routeHistoryState("novelReader", params, 233);
  context.showView("novelDetail", { id: LOCAL }, { skipHistory: true });
  context.restoreFromHistoryState(history); await Promise.all(queued.splice(0));
  assert.deepEqual(clone(context.currentViewParams), expected, "popstate restoration lost the prior body snapshot");
  context.window.location.hash = context.viewRouteHash("novelReader", params);
  context.restoreFromHistoryState(null); await Promise.all(queued.splice(0));
  assert.deepEqual(clone(context.currentViewParams), expected, "hash-only restoration lost the chapter identity");
  assert.equal(h.state.chapter.id, SECOND);

  h.leave(); await settle(); h.books.set(LOCAL, modernEntry({ recovery: recovery() })); h.api.__test.localBooks.clear();
  const beforeNativeSaves = h.saves.length;
  for (const prefix of ["novels", "novel"]) {
    const query = new URLSearchParams({ ...anchor(2), confirmProgress: "1" });
    assert.equal(context.openNativeLibraryRoute({ path: `/${prefix}/${encodeURIComponent(LOCAL)}/2?${query}` }), true);
    await Promise.all(queued.splice(0));
    assertAnchor(context.currentViewParams, 2);
    assert(!Object.hasOwn(context.currentViewParams, "confirmProgress"), "an external link asserted a user review decision");
    assertAnchor(h.storageCalls.filter((call) => call.kind === "chapter").at(-1).options, 2);
    assert.equal(h.state.session.confirmProgress, false);
    assert.equal(h.els.viewContent.querySelector(".novel-reader-screen"), null);
    h.runFrames(); h.runTimers(80); await settle();
    assert.equal(h.saves.length, beforeNativeSaves, "external links must not auto-confirm changed-body recovery");
  }
}

let passed = 0; let controls = 0; let failures = 0;
for (const item of tests) {
  try { await item.run(harness(source, item.options)); passed++; console.log(`PASS ${item.name}`); }
  catch (error) { failures++; console.error(`FAIL ${item.name}\n${error.stack}`); }
  if (!item.mutation) continue;
  let h;
  try { h = harness(item.mutation(source), item.options); }
  catch (error) { failures++; console.error(`FAIL control setup ${item.name}\n${error.stack}`); continue; }
  try { await item.run(h); failures++; console.error(`FAIL control survived ${item.name}`); }
  catch (error) {
    if (error.code === "ERR_ASSERTION") { controls++; console.log(`CONTROL rejected ${item.name}: ${error.message.split("\n")[0]}`); }
    else { failures++; console.error(`FAIL control infrastructure ${item.name}\n${error.stack}`); }
  }
}
let routePassed = false; let shellPassed = false;
try {
  await verifyModuleRoute(moduleSource);
  const from = "novelViews.renderNovelReader(params.id, params.chapterIndex, guard, params)";
  assert.equal(moduleSource.split(from).length, 2, "Exact route-dispatch negative-control anchor is required");
  try {
    await verifyModuleRoute(moduleSource.replace(from, "novelViews.renderNovelReader(params.id, params.chapterIndex, guard)"));
    assert.fail("Disconnected route anchor survived the actual adapter test");
  } catch (error) {
    if (error.code !== "ERR_ASSERTION" || error.message.includes("Disconnected route anchor survived")) throw error;
  }
  console.log("PASS actual Android module route adapter; omitted-anchor dispatch control rejected (not Android/WebView execution)");
  routePassed = true;
} catch (error) { failures++; console.error(`FAIL actual module route adapter\n${error.stack}`); }
try {
  await verifyShellRoutes(appSource);
  for (const [from, to] of [
    ['for (const key of ["chapterId", "catalogRevision", "sourceRealm"])', "for (const key of [])"],
    ['if (params.confirmProgress === "1") result.confirmProgress = "1";', "// Negative control: loses explicit confirmation."]
  ]) {
    const body = shellFunction(appSource, "sanitizeViewParams");
    assert.equal(body.split(from).length, 2, "Exact sanitizer control anchor is required");
    const changed = appSource.replace(body, () => body.replace(from, to));
    try { await verifyShellRoutes(changed); assert.fail("Shell sanitizer control survived"); }
    catch (error) { if (error.code !== "ERR_ASSERTION" || error.message.includes("Shell sanitizer control survived")) throw error; }
  }
  for (const [from, to] of [
    ['for (const key of ["chapterId", "catalogRevision", "sourceRealm"])', "for (const key of [])"],
    ["const anchor = {};", 'const anchor = { confirmProgress: query.get("confirmProgress") };']
  ]) {
    const body = shellFunction(appSource, "openNativeLibraryRoute");
    assert.equal(body.split(from).length, 2, "Exact native-route control anchor is required");
    try { await verifyShellRoutes(appSource.replace(body, () => body.replace(from, to))); assert.fail("Native route control survived"); }
    catch (error) { if (error.code !== "ERR_ASSERTION" || error.message.includes("Native route control survived")) throw error; }
  }
  shellPassed = true;
  console.log(`PASS ${SHELL_METHODS.length} real shell functions: sanitize/showView/history/hash/last-view/back-stack/native-link routing; 2 sanitizer + 2 native-link controls rejected`);
} catch (error) { failures++; console.error(`FAIL actual shell route preservation\n${error.stack}`); }
console.log(`Android novel chapter identity: ${passed}/${tests.length} complete-module VM scenarios; ${controls} safety controls rejected; ${routePassed ? 1 : 0} real module-adapter scenario/control; ${shellPassed ? 1 : 0} real shell-routing scenario/4 controls; ${failures} failures.`);
if (failures) process.exitCode = 1;
