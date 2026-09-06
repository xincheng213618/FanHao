import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createReaderHarness, localEntry, settle } from "./fixtures/android-novel-reader-harness.mjs";

// No browser, Android installation, or real IndexedDB is used. The full production
// module runs in a VM; only imports, clocks, storage/network edges and DOM are faked.
// The historical fixture is executable code, not a string-absence assertion.
const sourcePath = fileURLToPath(new URL("../android-client/www/modules/novels/novel-views.js", import.meta.url));
const source = fs.readFileSync(sourcePath, "utf8");
const historical = JSON.parse(fs.readFileSync(new URL("./fixtures/android-novel-reader-before-session.json", import.meta.url), "utf8"));
const tests = [];
const test = (name, run, defect = false) => tests.push({ name, run, defect });
const assertNear = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const mutate = (from, to) => (text) => {
  assert.equal(text.split(from).length, 2, `Expected one layered-storage mutation anchor: ${from}`);
  return text.replace(from, to);
};

test("local reader mounts real chapter DOM and restores/saves its own progress", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  assert.equal(h.state.book.id, "local:a");
  assert.equal(h.state.chapter.index, 1);
  assert.equal(h.els.viewTitle.textContent, "Chapter 1");
  assert(h.els.viewContent.querySelector(".novel-reader-content").textContent.includes("local:a"));
  h.runFrames();
  assertNear(h.api.__test.captureReaderRatio(), 0.25, "saved initial ratio restored");
  h.setRatio(0.45);
  h.window.dispatchEvent(h.event("scroll"));
  h.runTimers(600);
  await settle();
  assert.equal(h.saves.at(-1)?.id, "local:a");
  assertNear(h.saves.at(-1).progress.scrollRatio, 0.45, "visible scroll saved");
});

test("late local read cannot replace a newer book", async (h) => {
  const older = h.queueRead("local:a");
  let active = true;
  const pending = h.api.renderNovelReader("local:a", 1, () => active);
  await settle();
  active = false;
  await h.api.renderNovelReader("local:b", 1);
  older.resolve(localEntry("local:a"));
  await pending;
  assert.equal(h.state.book.id, "local:b", "old local result overwrote the new book");
  assert.equal(h.els.viewKicker.textContent, "Book local:b");
}, true);

test("same-book chapter requests stay ordered even with the default guard", async (h) => {
  const first = h.queueRead("local:a");
  const second = h.queueRead("local:a");
  const older = h.api.renderNovelReader("local:a", 1);
  await settle();
  const newer = h.api.renderNovelReader("local:a", 2);
  await settle();
  second.resolve(localEntry("local:a"));
  await newer;
  first.resolve(localEntry("local:a"));
  await older;
  assert.equal(h.state.chapter.index, 2, "old request reopened chapter one");
  assert.equal(h.els.viewTitle.textContent, "Chapter 2");
}, true);

test("leaving while local lookup is pending prevents a late reader mount", async (h) => {
  const read = h.queueRead("local:a");
  const pending = h.api.renderNovelReader("local:a", 1);
  await settle();
  h.leave();
  read.resolve(localEntry("local:a"));
  await pending;
  assert.equal(h.els.viewContent.innerHTML, "OTHER VIEW", "late local read replaced the non-reader view");
  assert.equal(h.state.active, false);
  assert.equal(h.els.viewContent.querySelector(".novel-reader-screen"), null);
}, true);

test("late failed local lookup cannot replace a newer reader with an error", async (h) => {
  const older = h.queueRead("local:a");
  let active = true;
  const pending = h.api.renderNovelReader("local:a", 1, () => active);
  await settle();
  active = false;
  await h.api.renderNovelReader("local:b", 1);
  older.reject(new Error("Synthetic missing local book"));
  await pending;
  assert(h.els.viewContent.querySelector(".novel-reader-screen"), "stale missing-book error removed the current screen");
  assert.equal(h.state.book.id, "local:b");
}, true);

test("late local progress completion cannot change current book identity", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  h.setRatio(0.6);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.saves[0].id, "local:a");
  await h.api.renderNovelReader("local:b", 1);
  await h.resolveSave(0);
  assert.equal(h.state.book.id, "local:b", "late save response replaced current book");
  assert.equal(h.state.chapter.bookId, "local:b");
}, true);

test("late save from previous chapter cannot regress the current chapter progress", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  h.setRatio(0.7);
  h.api.__test.saveReaderProgress();
  await settle();
  await h.api.renderNovelReader("local:a", 2);
  h.runFrames();
  h.setRatio(0.3);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.state.book.progress.chapterIndex, 2);
  await h.resolveSave(0);
  assert.equal(h.state.chapter.index, 2);
  assert.equal(h.state.book.progress.chapterIndex, 2, "old chapter save regressed visible progress");
  assertNear(h.state.book.progress.scrollRatio, 0.3, "newer visible ratio retained");
}, true);

test("local progress responses retain the newest ratio when completed in reverse order", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  h.setRatio(0.2);
  h.api.__test.saveReaderProgress();
  await settle();
  h.setRatio(0.8);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.saves.length, 2, "both progress snapshots reached the local storage boundary");
  await h.resolveSave(1);
  await h.resolveSave(0);
  // Disk ordering belongs to the IndexedDB transaction tests. At the view edge,
  // deliberately reverse completions to exercise response-identity protection.
  assertNear(h.state.book.progress.scrollRatio, 0.8, "newest current ratio");
  assertNear(h.api.__test.localBooks.get("local:a").book.progress.scrollRatio, 0.8, "newest in-memory library ratio");
}, true);

test("a stale restoration frame cannot scroll a newer book", async (h) => {
  h.books.set("local:a", localEntry("local:a", 0.8));
  h.books.set("local:b", localEntry("local:b", 0.2));
  await h.api.renderNovelReader("local:a", 1);
  const obsolete = h.frameIds();
  assert(obsolete.length > 0, "render should schedule scroll restoration");
  await h.api.renderNovelReader("local:b", 1);
  const before = h.window.scrollY;
  // Also execute canceled callbacks, modelling an already-dispatched late rAF.
  for (const id of obsolete) h.runFrame(id, true);
  assert.equal(h.window.scrollY, before, "stale frame scrolled the new chapter DOM");
  h.runFrames();
  assertNear(h.api.__test.captureReaderRatio(), 0.2, "current book still restores normally");
}, true);

test("a restoration frame cannot scroll after leaving the reader", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  const obsolete = h.frameIds();
  h.leave();
  const before = h.scrolls.length;
  for (const id of obsolete) h.runFrame(id, true);
  assert.equal(h.scrolls.length, before);
  assert.equal(h.els.viewContent.innerHTML, "OTHER VIEW");
});

test("backgrounding flushes the current ratio before the scroll debounce", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  h.setRatio(0.55);
  h.window.dispatchEvent(h.event("scroll"));
  h.hide();
  await settle();
  assert(h.saves.length > 0, "visibilitychange did not flush pending progress");
  assert.equal(h.saves.at(-1).id, "local:a");
  assertNear(h.saves.at(-1).progress.scrollRatio, 0.55, "background ratio captured while mounted");
}, true);

test("pagehide flushes the mounted chapter and deactivates reading", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  h.setRatio(0.65);
  h.window.dispatchEvent(h.event("pagehide"));
  await settle();
  assert.equal(h.state.active, false);
  assert.equal(h.saves.at(-1)?.id, "local:a");
  assertNear(h.saves.at(-1).progress.scrollRatio, 0.65, "pagehide flush");
});

test("loading another chapter cannot write a fabricated zero for the old book", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  h.setRatio(0.6);
  const read = h.queueRead("local:b");
  const next = h.api.renderNovelReader("local:b", 1);
  await settle();
  assert.equal(h.els.viewContent.querySelector(".novel-reader-screen"), null);
  h.window.dispatchEvent(h.event("scroll"));
  h.api.__test.saveReaderProgress();
  h.api.__test.flushReaderProgress();
  h.hide();
  await settle();
  assert(!h.saves.some((save) => save.id === "local:a" && save.progress.scrollRatio === 0), "loading placeholder overwrote old progress with zero");
  read.resolve(localEntry("local:b"));
  await next;
}, true);

test("horizontal reading mode saves and restores its own content scroll", async (h) => {
  h.state.settings.readingMode = "page";
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  assertNear(h.api.__test.captureReaderRatio(), 0.25, "horizontal restore");
  h.setRatio(0.75);
  h.api.__test.saveReaderProgress();
  await settle();
  assertNear(h.saves.at(-1).progress.scrollRatio, 0.75, "horizontal save");
});

test("ordinary remote success uses the live chapter and can save progress", async (h) => {
  const pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  const entry = localEntry("remote-one");
  entry.book.local = false;
  h.fetches[0].wait.resolve({ book: entry.book, chapter: entry.chapters[0], chapters: entry.chapters });
  await pending;
  assert.equal(h.state.book.id, "remote-one");
  h.runFrames();
  h.setRatio(0.4);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.posts.at(-1).path, "/api/novels/remote-one/progress");
  assertNear(h.posts.at(-1).data.scrollRatio, 0.4, "remote progress ratio");
});

test("remote progress writes serialize and retain the latest sample after a failure", async (h) => {
  const pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  const entry = localEntry("remote-one");
  h.fetches[0].wait.resolve({ book: entry.book, chapter: entry.chapters[0], chapters: entry.chapters });
  await pending;
  h.runFrames();
  h.setRatio(0.2);
  h.api.__test.saveReaderProgress();
  h.setRatio(0.5);
  h.api.__test.saveReaderProgress();
  h.setRatio(0.8);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.posts.length, 1, "multiple in-flight remote writes can finish in reverse order");
  h.posts[0].wait.reject(new Error("Synthetic failed earlier progress write"));
  await settle();
  assert.equal(h.posts.length, 2, "failed progress write did not drain the latest sample");
  assertNear(h.posts[1].data.scrollRatio, 0.8, "intermediate sample coalesced into latest");
  await h.resolvePost(1);
}, true);

test("remote progress timeout is finite and its rejection drains the latest sample", async (h) => {
  const pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  const entry = localEntry("remote-one");
  h.fetches[0].wait.resolve({ book: entry.book, chapter: entry.chapters[0], chapters: entry.chapters });
  await pending;
  h.runFrames();
  h.setRatio(0.2);
  h.api.__test.saveReaderProgress();
  await settle();
  const first = h.posts[0];
  assert(first, "reader should issue the first progress request");
  assert(Number.isFinite(first.options.timeoutMs) && first.options.timeoutMs > 0,
    "a serialized progress queue must not use an unbounded request timeout");
  assert.equal(first.options.method, "POST");
  h.setRatio(0.8);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.posts.length, 1, "progress request remains singly in flight until timeout");
  // The API boundary owns the timer. Deliver its timeout rejection while a newer
  // sample is queued, rather than waiting for real time or opening a connection.
  first.wait.reject(Object.assign(new Error("Synthetic request timed out"), { name: "TimeoutError" }));
  await settle();
  assert.equal(h.posts.length, 2, "timed-out first request permanently stalled the queue");
  assertNear(h.posts[1].data.scrollRatio, 0.8, "latest ratio sent after timeout");
  assert(Number.isFinite(h.posts[1].options.timeoutMs) && h.posts[1].options.timeoutMs > 0,
    "subsequent progress requests also need a finite timeout");
  await h.resolvePost(1);
}, true);

test("remote refresh preserves the visible cached chapter position", async (h) => {
  const entry = localEntry("remote-one", 0.25);
  const chapter = entry.chapters[0];
  h.cached.set("/api/novels/remote-one/chapters/1", { updatedAt: "2026-01-01", payload: { book: entry.book, chapter, chapters: entry.chapters } });
  const pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  assert(h.els.viewContent.querySelector(".novel-reader-screen"), "cached chapter should render before network settles");
  h.runFrames();
  h.setRatio(0.6);
  h.fetches[0].wait.resolve({ book: { ...entry.book, progress: { chapterIndex: 1, scrollRatio: 0.1 } }, chapter, chapters: entry.chapters });
  await pending;
  h.runFrames();
  assertNear(h.api.__test.captureReaderRatio(), 0.6, "network refresh reset a chapter the user was already reading");
}, true);

test("remote progress queues are isolated by service URL and keep the session destination", async (h) => {
  const entry = localEntry("remote-one");
  const data = { book: entry.book, chapter: entry.chapters[0], chapters: entry.chapters };
  h.setActiveUrl("http://first.synthetic.invalid");
  let pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  h.fetches[0].wait.resolve(data);
  await pending;
  h.runFrames();
  h.setRatio(0.2);
  h.api.__test.saveReaderProgress();
  await settle();
  h.setActiveUrl("http://second.synthetic.invalid");
  pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  h.fetches[1].wait.resolve(data);
  await pending;
  h.runFrames();
  h.setRatio(0.7);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.posts.filter((post) => post.url === "http://first.synthetic.invalid").length, 1, "first service must have only one write in flight");
  const second = h.posts.findIndex((post) => post.url === "http://second.synthetic.invalid");
  assert(second >= 0, "unfinished first service write blocked the independent second service");
  h.setActiveUrl("http://third.synthetic.invalid");
  h.setRatio(0.8);
  h.api.__test.saveReaderProgress();
  await settle();
  assert(!h.posts.some((post) => post.url === "http://third.synthetic.invalid"), "changing selected server retargeted an existing reader session's progress");
  assert.equal(h.posts.filter((post) => post.url === "http://second.synthetic.invalid").length, 1, "second service issued concurrent writes");
  await h.resolvePost(second);
  const secondPosts = h.posts.filter((post) => post.url === "http://second.synthetic.invalid");
  assert.equal(secondPosts.length, 2, "second service did not drain its latest independent sample");
  assertNear(secondPosts[1].data.scrollRatio, 0.8, "second service latest ratio");
}, true);

test("network refresh before the first frame retains cached saved restoration ratio", async (h) => {
  const entry = localEntry("remote-one", 0.75);
  const chapter = entry.chapters[0];
  h.cached.set("/api/novels/remote-one/chapters/1", { updatedAt: "2026-01-01", payload: { book: entry.book, chapter, chapters: entry.chapters } });
  const pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  assert(h.els.viewContent.querySelector(".novel-reader-screen"));
  assert(h.frameIds().length > 0, "cached reader has a pending restoration frame");
  // Network arrives before any frame has applied the saved position. Measuring
  // the current DOM here would turn the saved 75% position into an initial zero.
  h.fetches[0].wait.resolve({ book: { ...entry.book, progress: { chapterIndex: 1, scrollRatio: 0.1 } }, chapter, chapters: entry.chapters });
  await pending;
  h.runFrames();
  assertNear(h.api.__test.captureReaderRatio(), 0.75, "pending cached restoration survived fast refresh");
}, true);

test("prefetched next chapter cannot revive an older saved position after current reading", async (h) => {
  const entry = localEntry("remote-one");
  entry.book.progress = { chapterIndex: 2, scrollRatio: 0.8 };
  const pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  h.fetches[0].wait.resolve({ book: entry.book, chapter: entry.chapters[0], chapters: entry.chapters, next: entry.chapters[1] });
  await pending;
  assert.equal(h.fetches[1].path, "/api/novels/remote-one/chapters/2", "chapter two was automatically prefetched");
  h.fetches[1].wait.resolve({ book: entry.book, chapter: entry.chapters[1], chapters: entry.chapters });
  await settle();
  h.runFrames();
  h.setRatio(0.3);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.state.book.progress.chapterIndex, 1);
  await h.api.renderNovelReader("remote-one", 2);
  assert.equal(h.fetches.length, 2, "chapter two should reuse the completed prefetch");
  h.runFrames();
  assert.equal(h.state.chapter.index, 2);
  assertNear(h.api.__test.captureReaderRatio(), 0, "old prefetched chapter-two 80% was revived instead of starting the next chapter");
});

test("prefetched chapter progress snapshot never crosses services with matching book IDs", async (h) => {
  const entry = localEntry("remote-one");
  entry.book.progress = { chapterIndex: 2, scrollRatio: 0.8 };
  h.setActiveUrl("http://second.synthetic.invalid");
  let pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  h.fetches[0].wait.resolve({ book: entry.book, chapter: entry.chapters[0], chapters: entry.chapters, next: entry.chapters[1] });
  await pending;
  h.fetches[1].wait.resolve({ book: entry.book, chapter: entry.chapters[1], chapters: entry.chapters });
  await settle();
  h.runFrames();

  h.setActiveUrl("http://first.synthetic.invalid");
  pending = h.api.renderNovelReader("remote-one", 1);
  await settle();
  h.fetches[2].wait.resolve({ book: { ...entry.book, progress: { chapterIndex: 1, scrollRatio: 0.1 } }, chapter: entry.chapters[0], chapters: entry.chapters });
  await pending;
  h.runFrames();
  h.setRatio(0.3);
  h.api.__test.saveReaderProgress();
  await settle();

  h.setActiveUrl("http://second.synthetic.invalid");
  await h.api.renderNovelReader("remote-one", 2);
  assert.equal(h.fetches.length, 3, "second service should reuse its own chapter-two prefetch");
  h.runFrames();
  assertNear(h.api.__test.captureReaderRatio(), 0.8, "first service's current progress overwrote second service's prefetched progress");
}, true);

test("shelf loading retains only summaries even for large synthetic books", async (h) => {
  h.books.clear();
  for (let i = 0; i < 16; i++) {
    const entry = localEntry(`local:large-${i}`);
    for (const chapter of entry.chapters) chapter.content = `BODY_ONLY_${i}_` + "合成正文".repeat(12000);
    h.books.set(entry.book.id, entry);
  }
  await h.api.__test.loadPersistentLocalLibrary();
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["summaries"], "shelf load used an aggregate body API");
  assert.equal(h.api.__test.localBooks.size, 16);
  for (const summary of h.api.__test.localBooks.values()) assert(!Object.hasOwn(summary, "chapters"));
  assert(!JSON.stringify([...h.api.__test.localBooks.values()]).includes("BODY_ONLY_"));
}, mutate("const entries = await loadLocalNovelSummaries();", "const entries = await loadLocalNovelEntries();"));

test("local details and reader catalog use metadata without any body API", async (h) => {
  await h.api.renderNovelDetail("local:a");
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["catalog"]);
  assert(!Object.hasOwn(h.api.__test.localBooks.get("local:a"), "chapters"));
  await h.api.renderNovelReader("local:a", 1);
  h.state.chapters = [];
  h.storageCalls.length = 0;
  await h.api.__test.loadReaderCatalog();
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["catalog"]);
  assert.equal(h.state.chapters.length, 2);
  assert(h.state.chapters.every((chapter) => !Object.hasOwn(chapter, "content")));
});

test("local reader holds one chapter body while neighbors and cache remain metadata", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  assert(h.state.chapter, "single chapter reader did not mount");
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["chapter"]);
  assert(h.state.chapter.content.includes("chapter 1"));
  assert.equal(h.state.prev, null);
  assert(!Object.hasOwn(h.state.next, "content"));
  assert(h.state.chapters.every((chapter) => !Object.hasOwn(chapter, "content")));
  const summary = h.api.__test.localBooks.get("local:a");
  assert(!Object.hasOwn(summary, "chapter") && !Object.hasOwn(summary, "chapters"), "reader cached a body-bearing DTO");
}, mutate("localBooks.set(summary.book.id, summary);", "localBooks.set(summary.book.id, entry);"));

test("a missing chapter does not silently fall back to the first chapter", async (h) => {
  await h.api.renderNovelReader("local:a", 999);
  assert.equal(h.state.chapter, null);
  assert.equal(h.els.viewContent.querySelector(".novel-reader-screen"), null);
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["chapter"]);
});

test("local progress passes its opened content generation and returns only summary", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  const generation = h.state.book.localGeneration;
  h.setRatio(0.56);
  h.api.__test.saveReaderProgress();
  await settle();
  assert.equal(h.saves.at(-1).options.expectedGeneration, generation, "generation was omitted from the storage compare-and-write");
  assert(!Object.hasOwn(h.api.__test.localBooks.get("local:a"), "chapters"));
  assertNear(h.books.get("local:a").book.progress.scrollRatio, 0.56, "generation-matched progress persisted");
}, mutate("}, { expectedGeneration })", "})"));

test("an already-open reader cannot write its old position into a replacement generation", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  const replacement = localEntry("local:a", 0.82);
  replacement.generation = replacement.book.localGeneration = "fixture-new-generation";
  replacement.chapters[0].content = "NEW_GENERATION_BODY";
  h.books.set("local:a", replacement);
  h.setRatio(0.11);
  h.api.__test.saveReaderProgress();
  await settle();
  assertNear(h.books.get("local:a").book.progress.scrollRatio, 0.82, "old generation overwrote replacement progress");
  await h.api.renderNovelReader("local:a", 1);
  assert.equal(h.state.chapter.content, "NEW_GENERATION_BODY");
  assert.equal(h.state.book.localGeneration, "fixture-new-generation");
});

test("a late summary lookup after deletion cannot repopulate the shelf cache", async (h) => {
  const stale = structuredClone(h.books.get("local:a"));
  const lookup = h.queueRead("local:a");
  const pending = h.api.__test.ensureLocalNovelEntry("local:a");
  await settle();
  await h.api.__test.removeLocalBook(stale.book);
  lookup.resolve(stale);
  assert.equal(await pending, null);
  assert.equal(h.api.__test.localBooks.has("local:a"), false);
  assert.equal(h.books.has("local:a"), false);
});

test("a late shelf list after deletion cannot restore a deleted summary", async (h) => {
  await h.api.__test.loadPersistentLocalLibrary();
  const stale = structuredClone([...h.books.values()]);
  const lookup = h.queueListRead();
  const pending = h.api.__test.loadPersistentLocalLibrary();
  await settle();
  await h.api.__test.removeLocalBook(h.books.get("local:a").book);
  lookup.resolve(stale);
  const result = await pending;
  assert(!result.some((entry) => entry.book.id === "local:a"));
  assert.equal(h.api.__test.localBooks.has("local:a"), false);
  assert.equal(h.api.__test.localBooks.has("local:b"), true);
});

test("overlapping shelf reads cannot replace the newer metadata snapshot", async (h) => {
  const older = h.queueListRead();
  const newer = h.queueListRead();
  const first = h.api.__test.loadPersistentLocalLibrary();
  const second = h.api.__test.loadPersistentLocalLibrary();
  const current = localEntry("local:b"); current.book.title = "NEWEST SUMMARY";
  newer.resolve([current]);
  await second;
  older.resolve([localEntry("local:a")]);
  await first;
  assert.equal(h.api.__test.localBooks.size, 1);
  assert.equal(h.api.__test.localBooks.get("local:b").book.title, "NEWEST SUMMARY");
});

test("explicit TXT export reads the full book without storing it in the shelf map", async (h) => {
  await h.api.__test.loadPersistentLocalLibrary();
  h.storageCalls.length = 0;
  let exported;
  h.window.Capacitor.Plugins.FanHaoNovel.exportTextFile = async (value) => { exported = value; return {}; };
  await h.api.__test.downloadBook("local:a");
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["entry"]);
  assert(exported.text.includes("chapter 1") && exported.text.includes("chapter 2"));
  assert(!Object.hasOwn(h.api.__test.localBooks.get("local:a"), "chapters"));
});

test("remote offline detection uses a summary then reads only its requested chapter", async (h) => {
  const sourceRealm = "server:11111111-1111-4111-8111-111111111111";
  const cached = localEntry(h.api.__test.remoteCacheIdFromSourceId("remote-one", sourceRealm));
  cached.book.sourceType = "remote-cache"; cached.book.sourceBookId = "remote-one"; cached.book.sourceRealm = sourceRealm;
  h.cached.set("/api/novels/source-identity", { payload: { sourceRealm } });
  h.books.set(cached.book.id, cached);
  await h.api.renderNovelReader("remote-one", 2);
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["summary", "chapter"]);
  assert.equal(h.state.chapter.index, 2);
  assert.equal(h.fetches.length, 0);
  assert(!Object.hasOwn(h.api.__test.localBooks.get(cached.book.id), "chapters"));
});

test("whole-book remote caching saves a summary and reloads only catalog metadata", async (h) => {
  const entry = localEntry("remote-cache-test");
  entry.book.sourceRealm = "server:11111111-1111-4111-8111-111111111111";
  entry.book.catalogRevision = "33333333-3333-4333-8333-333333333333";
  entry.book.local = false;
  h.cached.set("/api/novels/source-identity", { payload: { sourceRealm: entry.book.sourceRealm } });
  for (const chapter of entry.chapters) {
    const query = new URLSearchParams({ catalogRevision: entry.book.catalogRevision, chapterId: chapter.id, sourceRealm: entry.book.sourceRealm });
    h.cached.set(`/api/novels/remote-cache-test/chapters/${chapter.index}?${query}`, { payload: { sourceRealm: entry.book.sourceRealm, catalogRevision: entry.book.catalogRevision, book: entry.book, chapter } });
  }
  const saved = await h.api.__test.cacheWholeBook(entry.book, entry.chapters.map(({ content, ...metadata }) => metadata), { confirmLarge: false });
  assert(saved?.book, "whole-book caching did not persist");
  assert(!Object.hasOwn(saved, "chapters"));
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["summary", "saveEntry", "catalog"]);
  assert.equal(h.books.get(saved.book.id).chapters.length, 2);
  assert(!Object.hasOwn(h.api.__test.localBooks.get(saved.book.id), "chapters"));
});

test("a summary snapshot cannot overwrite progress committed after its read began", async (h) => {
  await h.api.renderNovelReader("local:a", 1);
  h.runFrames();
  const stale = structuredClone(h.books.get("local:a"));
  stale.book.progress.updatedAt = "2099-01-01T00:00:00Z"; // Wall clocks are not a local write order.
  h.api.__test.localBooks.clear();
  const read = h.queueRead("local:a");
  const pending = h.api.__test.ensureLocalNovelEntry("local:a");
  await settle();
  h.setRatio(0.64); h.api.__test.saveReaderProgress(); await settle();
  read.resolve(stale);
  const summary = await pending;
  assertNear(summary.book.progress.scrollRatio, 0.64, "late summary replaced newly committed progress");
  assertNear(h.api.__test.localBooks.get("local:a").book.progress.scrollRatio, 0.64, "cache progress regressed");
}, mutate("const keepProgress = generation != null && previous?.generation === generation", "const keepProgress = false && generation != null && previous?.generation === generation"));

test("a catalog snapshot preserves the newer same-generation local progress", async (h) => {
  await h.api.renderNovelReader("local:a", 1); h.runFrames();
  const stale = structuredClone(h.books.get("local:a"));
  const read = h.queueRead("local:a");
  const pending = h.api.__test.readLocalCatalog("local:a");
  await settle();
  h.setRatio(0.72); h.api.__test.saveReaderProgress(); await settle();
  read.resolve(stale);
  const catalog = await pending;
  assert.equal(catalog.chapters.length, 2);
  assertNear(catalog.book.progress.scrollRatio, 0.72, "late catalog DTO regressed progress");
  assertNear(h.api.__test.localBooks.get("local:a").book.progress.scrollRatio, 0.72, "late catalog replaced committed cache progress");
});

test("a shelf snapshot merges newer progress without dropping unaffected books", async (h) => {
  await h.api.__test.loadPersistentLocalLibrary();
  await h.api.renderNovelReader("local:a", 1); h.runFrames();
  const stale = structuredClone([...h.books.values()]);
  const read = h.queueListRead();
  const pending = h.api.__test.loadPersistentLocalLibrary();
  await settle();
  h.setRatio(0.81); h.api.__test.saveReaderProgress(); await settle();
  read.resolve(stale);
  const list = await pending;
  assert.equal(list.length, 2);
  assertNear(list.find((entry) => entry.book.id === "local:a").book.progress.scrollRatio, 0.81, "late shelf list regressed progress");
  assert(h.api.__test.localBooks.has("local:b"));
});

test("late local progress during next-chapter load does not invalidate the content read", async (h) => {
  await h.api.renderNovelReader("local:a", 1); h.runFrames();
  const stale = structuredClone(h.books.get("local:a"));
  h.setRatio(0.66); h.api.__test.saveReaderProgress();
  const read = h.queueRead("local:a");
  const pending = h.api.renderNovelReader("local:a", 2);
  await settle();
  assert(h.saves.length > 0 && !h.state.chapter, "fixture must have saves and a pending chapter read");
  for (const save of h.saves) save.wait.resolve();
  await settle();
  read.resolve(stale);
  await pending;
  assert(h.state.chapter, "a metadata-only progress commit canceled a valid body read");
  assert.equal(h.state.chapter.index, 2);
  assertNear(h.state.book.progress.scrollRatio, 0.66, "chapter response replaced newer progress");
  h.runFrames();
  assertNear(h.api.__test.captureReaderRatio(), 0, "next chapter must start from its own beginning");
});

let passed = 0;
let negativePassed = 0;
let layeredControls = 0;
const failures = [];
const optionsFor = (item) => ({
  deferSaves: /late .*save|late local progress|local progress responses/.test(item.name),
  deferPosts: /remote progress writes serialize|remote progress queues|remote progress timeout/.test(item.name)
});
for (const item of tests) {
  if (!process.argv.includes("--negative-only")) {
    const h = createReaderHarness(source, optionsFor(item));
    try { await item.run(h); passed += 1; console.log(`PASS ${item.name}`); }
    catch (error) { failures.push({ name: item.name, error }); console.error(`FAIL ${item.name}\n${error.stack}`); }
  }
  if (item.defect) {
    const targeted = typeof item.defect === "function";
    const h = createReaderHarness(targeted ? item.defect(source) : source, { ...(targeted ? {} : { historical }), ...optionsFor(item) });
    try {
      await item.run(h);
      failures.push({ name: `Historical control unexpectedly passed: ${item.name}`, error: new Error("Defect was not reproduced") });
      console.error(`FAIL historical control did not reproduce: ${item.name}`);
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) {
        failures.push({ name: `Historical harness failed for the wrong reason: ${item.name}`, error });
        console.error(`FAIL historical harness error: ${item.name}\n${error.stack}`);
      } else {
        if (targeted) layeredControls += 1;
        else negativePassed += 1;
        console.log(`CONTROL reproduced: ${item.name} (${error.message.split("\n")[0]})`);
      }
    }
  }
}
console.log(`Novel reader verification: ${passed} current-source scenarios passed; ${negativePassed} historical regressions reproduced; ${layeredControls} layered-storage mutation controls rejected; ${failures.length} failures.`);
if (failures.length) process.exitCode = 1;
