import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createReaderHarness, deferred, settle } from "./fixtures/android-novel-reader-harness.mjs";
import { functions as pickerBeforeDeferred } from "./fixtures/android-novel-picker-before-deferred.mjs";
import { reconcileLocalNovelEntry } from "../android-client/www/js/novel-chapter-identity.js";

// Run the actual complete novel module. Only the existing deterministic harness
// supplies DOM/native/network/storage boundaries; all split/identity/export and
// import-progress logic is production code (the UI now delegates reconciliation
// to the actual pure storage module). No real library or media is touched.
const sourcePath = fileURLToPath(new URL("../android-client/www/modules/novels/novel-views.js", import.meta.url));
const source = fs.readFileSync(sourcePath, "utf8");
const historical = JSON.parse(fs.readFileSync(new URL("./fixtures/android-novel-import-before-fix.json", import.meta.url), "utf8"));
const historicalDrain = JSON.parse(fs.readFileSync(new URL("./fixtures/android-novel-native-import-before-drain.json", import.meta.url), "utf8"));
assert(source.includes("async function saveLocalTextFile("), "Expected actual local import persistence entry point");
const exposedSource = `
const importStorageBoundary = saveLocalNovelEntry;
saveLocalNovelEntry = (entry, options) => window.__importStorageHook
  ? window.__importStorageHook(entry, importStorageBoundary, options) : importStorageBoundary(entry, options);
const importProgressBoundary = saveLocalNovelProgress;
saveLocalNovelProgress = (id, progress, options) => window.__importProgressHook
  ? window.__importProgressHook(id, progress, importProgressBoundary, options) : importProgressBoundary(id, progress, options);
` + source.replace("export function createNovelViews(context) {", `export function createNovelViews(context) {
  const importHostBoundary = context;
  context = { ...context,
    renderCurrentView: (...args) => window.__importRenderCurrentViewHook
      ? window.__importRenderCurrentViewHook(...args) : importHostBoundary.renderCurrentView(...args),
    showView: (...args) => window.__importShowViewHook
      ? window.__importShowViewHook(...args) : importHostBoundary.showView(...args)
  };
`).replace(/\n    renderNovelList,\r?\n/, `\n    renderNovelList,\n    __importTest: { createLocalBookEntry, saveLocalTextFile, splitLocalTextChapters, chunkLocalText, composeLocalNovelText, importPendingNativeTextFile, importNativeTextFile, importFromSystemFileManager, scanLocalNovelFiles, importLocalNovelFiles, uploadNovelFiles, setNovelBusy, clearNovelBusy, listState, get nativeBusy() { return importingNativeText; } },\n`);
assert.notEqual(exposedSource, source, "Could not expose real import functions from createNovelViews");

function makeHarness(old = false, mutate = null) {
  const h = createReaderHarness(mutate ? mutate(exposedSource) : exposedSource, old
    ? { historical: { functions: { ...historical.functions, ...historicalDrain.functions } } }
    : { reconcileEntries: true });
  h.modernIdentity = !old;
  h.books.clear();
  h.imports = h.api.__importTest;
  h.importWrites = [];
  h.queuedImportWrites = [];
  h.window.__importStorageHook = (entry, save, options) => {
    h.importWrites.push(structuredClone(entry));
    const delay = h.queuedImportWrites.shift();
    return delay ? delay.promise.then(() => save(entry, options)) : save(entry, options);
  };
  h.queueImportWrite = () => { const wait = deferred(); h.queuedImportWrites.push(wait); return wait; };
  return h;
}

function replaceImportFunctions(source, replacements) {
  for (const [name, body] of Object.entries(replacements)) {
    const pattern = new RegExp(`\\n  (?:async )?function ${name}\\([^]*?\\n  \\}`);
    assert(pattern.test(source), `Missing function for import negative control: ${name}`);
    source = source.replace(pattern, () => `\n${body}`);
  }
  return source;
}
const oldPicker = (source) => replaceImportFunctions(source, pickerBeforeDeferred);
const oldBusy = (source) => replaceImportFunctions(source, Object.fromEntries(
  ["setNovelBusy", "clearNovelBusy"].map((name) => [name, pickerBeforeDeferred[name]])
));
const mutatePicker = (from, to) => (source) => {
  const pattern = /\n  function importFromSystemFileManager\([^]*?\n  \}/;
  const body = source.match(pattern)?.[0];
  assert(body?.includes(from), `Missing targeted picker mutation: ${from}`);
  return source.replace(pattern, () => body.replace(from, to));
};

const appSource = fs.readFileSync(new URL("../android-client/www/app.js", import.meta.url), "utf8");
const registrySource = fs.readFileSync(new URL("../android-client/www/js/android-module-registry.js", import.meta.url), "utf8");
function appFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Android shell must define ${name}`);
  const remaining = appSource.slice(start);
  const next = /\r?\n(?:async )?function\s/.exec(remaining);
  assert(next, `Android shell function ${name} must have a clear boundary`);
  return remaining.slice(0, next.index);
}

function installReaderImportShell(h, bookId, chapterIndex = 1) {
  // Execute the actual pre-DOM shell lifecycle and synchronous registry dispatch.
  // Only unrelated chrome and history are stubs; rendering uses the full module.
  const registryRender = registrySource.match(/  function render\(view, params, renderGuard\) \{[\s\S]*?\r?\n  \}/)?.[0];
  assert(registryRender, "Expected actual synchronous registry render entry point");
  const context = {
    AbortController,
    CustomEvent: class { constructor(type, options) { return h.event(type, options); } },
    window: h.window, currentView: "novelReader", currentViewParams: { id: bookId, chapterIndex: String(chapterIndex) },
    viewRenderToken: 0, activeViewController: null, scrollRestoreIntent: 0, library: {},
    els: new Proxy(h.els, { get(target, key) { return target[key] ||= h.document.createElement("div"); } }),
    syncContentPanelMode() {}, syncSearchSurface() {}, renderRouteLoadingState() {},
    setActiveBottom() {}, finishAppStartup() {}, isRootNavigationView: () => false, currentViewNeedsLibrary: () => false,
    resolve: () => ({ route: { render: (params, guard) => h.api.renderNovelReader(params.id, params.chapterIndex, guard) } })
  };
  vm.runInNewContext(["beginViewRender", "sameViewParams", "renderCurrentView"].map(appFunction).join("\n") + "\n" + registryRender,
    context, { filename: "android-app-import-reader-shell.js" });
  context.androidModuleRegistry = { deactivateExcept() {}, render: context.render };
  h.window.__importRenderCurrentViewHook = () => context.renderCurrentView();
  h.window.__importShowViewHook = (view, params) => {
    context.currentView = view;
    context.currentViewParams = params;
    return context.renderCurrentView();
  };
  return context;
}

function nativeQueue(h, initial = []) {
  const queue = [...initial];
  const calls = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  h.window.Capacitor.Plugins.FanHaoNovel.consumePendingTextFile = async () => {
    calls.push(queue.length);
    assert(calls.length < 50, "native consumer spun without a bounded stop/retry");
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    try {
      const value = queue.shift() ?? { available: false, hasPending: false };
      if (value instanceof Error) throw value;
      return await (value.promise || value);
    } finally { inFlight -= 1; }
  };
  return { queue, calls, get maximumInFlight() { return maximumInFlight; } };
}

function nativeFile(uri = OLD_URI, name = "native-fixture.txt") {
  return { available: true, uri, fileName: name, text: CHAPTER_TEXT, sizeBytes: 300, encoding: "utf-8" };
}

function activeRetryTimers(h) {
  return [...h.timers.values()].filter((timer) => !timer.canceled && timer.delay === 500);
}

const OLD_URI = "content://synthetic.provider/document/book-a";
const SECOND_URI = "content://synthetic.provider/document/book-b";
const PREAMBLE = "作者前言专属标记甲：这段文字不能消失。\n\n第二段前言专属标记乙，包含完整引言。";
const BODY_ONE = "第一章正文唯一标记丙。这是正文的第一段。";
const BODY_TWO = "第二章正文唯一标记丁。这是正文的第二段。";
const CHAPTER_TEXT = `第一章 起点\n${BODY_ONE}\n\n第二章 后续\n${BODY_TWO}`;
const WITH_PREAMBLE = `${PREAMBLE}\n\n${CHAPTER_TEXT}`;
const progress = (chapterIndex, scrollRatio = 0.42) => ({ chapterIndex, scrollRatio, updatedAt: "2026-01-02T03:04:05.000Z" });
const file = (patch = {}) => ({ fileName: "fixture-book.txt", text: CHAPTER_TEXT, sizeBytes: 300, lastModified: 1000, ...patch });
const body = (entry) => entry.chapters.map((chapter) => chapter.content).join("\n\n");
const plain = (value) => JSON.parse(JSON.stringify(value));
const noWhitespace = (value) => String(value).replace(/\s+/g, "");

function validChapterIndexes(entry) {
  assert.deepEqual(entry.chapters.map((chapter) => chapter.index), entry.chapters.map((_, index) => index + 1), "chapter indexes are contiguous and one-based");
  for (const chapter of entry.chapters) {
    assert.equal(chapter.bookId, entry.book.id);
    assert(!Object.hasOwn(chapter, "id"), "the parser must not mint ordinal-derived identities before storage reconciliation");
  }
  assert.equal(entry.book.chapterCount, entry.chapters.length);
  assert.equal(entry.book.charCount, entry.chapters.reduce((total, chapter) => total + chapter.content.length, 0));
}

function seed(h, entry, savedProgress = progress(1)) {
  let row = structuredClone(entry.chapters ? entry : h.books.get(entry.book.id));
  if (h.modernIdentity && !row.book.catalogRevision) row = reconcileLocalNovelEntry(null, row);
  // This fixture knows the immutable synthetic snapshot being seeded; real
  // legacy migration is exercised separately, never inferred from title/index.
  const chapter = row.chapters.find((chapter) => Number(chapter.index) === Number(savedProgress?.chapterIndex));
  row.book.progress = h.modernIdentity && savedProgress ? { ...savedProgress,
    chapterId: chapter?.id, catalogRevision: row.book.catalogRevision } : savedProgress;
  row.createdAt = "2025-01-01T00:00:00.000Z";
  h.books.set(row.book.id, row);
  return row;
}

function makeLegacyEntry(input) {
  return makeHarness(true).imports.createLocalBookEntry(input);
}

const tests = [];
const test = (name, run, defect = false) => tests.push({ name, run, defect });

test("non-empty text before the first chapter becomes a retained preamble", (h) => {
  const entry = h.imports.createLocalBookEntry(file({ text: WITH_PREAMBLE }));
  assert(body(entry).includes(PREAMBLE), "the text before the first matched chapter was discarded");
  assert.equal(entry.chapters.length, 3);
  assert.equal(entry.chapters[0].title, "序言");
  assert.equal(entry.chapters[0].preamble, true);
  assert.equal(entry.chapters[0].content, PREAMBLE);
  assert.equal(entry.chapters[1].content, BODY_ONE);
  assert.equal(entry.chapters[2].content, BODY_TWO);
  validChapterIndexes(entry);
}, true);

test("chaptered TXT without a preamble keeps the original two chapters", (h) => {
  const entry = h.imports.createLocalBookEntry(file());
  assert.equal(entry.chapters.length, 2);
  assert(!entry.chapters.some((chapter) => chapter.preamble));
  assert.deepEqual(plain(entry.chapters.map((chapter) => chapter.title)), ["第一章 起点", "第二章 后续"]);
  assert.equal(entry.chapters[0].content, BODY_ONE);
  assert.equal(entry.chapters[1].content, BODY_TWO);
  validChapterIndexes(entry);
});

test("whitespace-only prefix does not create an empty preamble", (h) => {
  const entry = h.imports.createLocalBookEntry(file({ text: `\uFEFF \r\n\t\r\n${CHAPTER_TEXT}` }));
  assert.equal(entry.chapters.length, 2);
  assert(!entry.chapters.some((chapter) => chapter.preamble));
  validChapterIndexes(entry);
});

test("CRLF chaptered TXT preserves and normalizes the preamble", (h) => {
  const entry = h.imports.createLocalBookEntry(file({ text: WITH_PREAMBLE.replace(/\n/g, "\r\n") }));
  assert.equal(entry.chapters[0].content, PREAMBLE, "CRLF preamble was dropped or corrupted");
  assert(!body(entry).includes("\r"));
  validChapterIndexes(entry);
}, true);

test("a single recognized chapter preserves its heading and preceding text", (h) => {
  const text = `${PREAMBLE}\n\n第一章 单章\n${BODY_ONE}`;
  const entry = h.imports.createLocalBookEntry(file({ text }));
  assert.equal(noWhitespace(body(entry)), noWhitespace(text));
  validChapterIndexes(entry);
});

test("unheaded TXT retains all paragraphs", (h) => {
  const text = `${PREAMBLE}\n\n${BODY_ONE}\n\n${BODY_TWO}`;
  const entry = h.imports.createLocalBookEntry(file({ text }));
  assert.equal(noWhitespace(body(entry)), noWhitespace(text));
  validChapterIndexes(entry);
});

test("large unheaded TXT is chunked without dropping or repeating paragraphs", (h) => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `段落-${String(index).padStart(3, "0")}-` + "分块正文测试。".repeat(300));
  const text = paragraphs.join("\n\n");
  const entry = h.imports.createLocalBookEntry(file({ text, sizeBytes: undefined }));
  assert(entry.chapters.length > 1, "large paragraph-based text should still use the chunking path");
  assert.equal(noWhitespace(body(entry)), noWhitespace(text));
  validChapterIndexes(entry);
});

test("a single very long paragraph is retained in full", (h) => {
  const text = "超长单段内容。".repeat(12000);
  const entry = h.imports.createLocalBookEntry(file({ text }));
  assert.equal(body(entry), text);
  validChapterIndexes(entry);
});

test("preamble export and re-import preserve original content without generated title growth", (h) => {
  let entry = h.imports.createLocalBookEntry(file({ text: WITH_PREAMBLE }));
  let exported = h.imports.composeLocalNovelText(entry);
  assert(exported.includes(PREAMBLE), "export cannot recover discarded preamble content");
  assert(!exported.includes("序言"), "generated preamble label must not be inserted into TXT content");
  const initial = exported;
  for (let cycle = 0; cycle < 4; cycle += 1) {
    entry = h.imports.createLocalBookEntry(file({ text: exported }));
    exported = h.imports.composeLocalNovelText(entry);
    assert.equal(exported, initial, `import/export cycle ${cycle + 1} changed or duplicated text`);
    for (const marker of ["作者前言专属标记甲", "第二段前言专属标记乙", "第一章正文唯一标记丙", "第二章正文唯一标记丁"]) {
      assert.equal(exported.split(marker).length - 1, 1, `cycle repeated/dropped ${marker}`);
    }
  }
}, true);

test("an author-written preamble heading is preserved once", (h) => {
  let entry = h.imports.createLocalBookEntry(file({ text: `序言\n${PREAMBLE}\n\n${CHAPTER_TEXT}` }));
  const first = h.imports.composeLocalNovelText(entry);
  assert.equal(first.split("序言").length - 1, 1, "author-written preamble heading was duplicated or removed");
  entry = h.imports.createLocalBookEntry(file({ text: first }));
  assert.equal(h.imports.composeLocalNovelText(entry), first);
}, true);

test("remote-cache export retains the remote book title header", (h) => {
  const entry = h.imports.createLocalBookEntry(file());
  entry.book.sourceType = "remote-cache";
  entry.book.title = "远端缓存书名";
  assert(h.imports.composeLocalNovelText(entry).startsWith("远端缓存书名\n\n"));
});

test("canonical sourceUri identity does not depend on import timestamps", (h) => {
  const first = h.imports.createLocalBookEntry(file({ sourceUri: OLD_URI, sourceType: "system-picker", lastModified: 1000 }));
  const later = h.imports.createLocalBookEntry(file({ sourceUri: OLD_URI, sourceType: "system-picker", lastModified: 999999 }));
  assert.equal(first.book.id, later.book.id, "the same URI received a timestamp-derived new book ID");
  assert.equal(first.book.sourceUri, OLD_URI);
  assert.equal(first.book.sourceKey, `uri:${OLD_URI}`);
}, true);

test("different source URIs do not merge identical names and content", (h) => {
  const first = h.imports.createLocalBookEntry(file({ sourceUri: OLD_URI }));
  const second = h.imports.createLocalBookEntry(file({ sourceUri: SECOND_URI }));
  assert.notEqual(first.book.id, second.book.id, "distinct selected documents were merged by file metadata");
}, true);

test("legacy uri alias and canonical sourceUri produce the same stable identity", (h) => {
  const alias = h.imports.createLocalBookEntry(file({ uri: OLD_URI, lastModified: 1 }));
  const canonical = h.imports.createLocalBookEntry(file({ sourceUri: OLD_URI, lastModified: 2 }));
  assert.equal(alias.book.id, canonical.book.id, "existing external-intent URI IDs became incompatible");
  assert.equal(canonical.book.sourceUri, OLD_URI);
}, true);

test("canonical sourceUri wins over a conflicting legacy uri alias", (h) => {
  const entry = h.imports.createLocalBookEntry(file({ sourceUri: `  ${OLD_URI}  `, uri: SECOND_URI }));
  assert.equal(entry.book.sourceUri, OLD_URI, "canonical URI was ignored in favour of the legacy alias");
}, true);

test("blank canonical sourceUri falls back to a trimmed legacy uri alias", (h) => {
  const entry = h.imports.createLocalBookEntry(file({ sourceUri: "  ", uri: `  ${OLD_URI}  ` }));
  assert.equal(entry.book.sourceUri, OLD_URI);
});

test("renaming or editing the same source document does not change its ID", (h) => {
  const original = h.imports.createLocalBookEntry(file({ sourceUri: OLD_URI }));
  const changed = h.imports.createLocalBookEntry(file({ sourceUri: OLD_URI, fileName: "renamed.txt", sizeBytes: 9876, text: CHAPTER_TEXT + "\n附记", lastModified: 2000 }));
  assert.equal(changed.book.id, original.book.id, "the URI-backed identity depended on mutable document metadata");
}, true);

test("repeated native import reuses its stored ID and exact valid progress", async (h) => {
  const first = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, sourceType: "system-picker" }));
  const old = seed(h, first, progress(2));
  const next = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, sourceType: "document-tree", lastModified: 999999 }));
  assert.equal(next.book.id, first.book.id, "duplicate native import added a second book");
  assert.equal(h.books.size, 1);
  assert.equal(next.book.progress.chapterId, old.book.progress.chapterId);
  assert.equal(next.book.progress.chapterIndex, old.book.progress.chapterIndex);
  assert.equal(next.book.progress.scrollRatio, old.book.progress.scrollRatio);
  assert.equal(next.book.progress.catalogRevision, next.book.catalogRevision);
  if (h.modernIdentity) assert.notEqual(next.book.catalogRevision, old.book.catalogRevision);
  assert.equal(next.createdAt, old.createdAt);
  assert.equal(next.book.sourceType, "document-tree", "progress preservation must not overwrite freshly imported metadata");
  assert.equal(h.api.__test.localBooks.get(next.book.id).book.id, next.book.id);
}, true);

test("native import remains compatible with an already-stored legacy uri ID", async (h) => {
  const legacy = makeLegacyEntry(file({ uri: OLD_URI }));
  seed(h, legacy, progress(2, 0.61));
  const imported = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, lastModified: 99999 }));
  assert.equal(imported.book.id, legacy.book.id, "old uri-backed book was duplicated under canonical sourceUri");
  assert.equal(h.books.size, 1);
  assert.equal(imported.book.progress.chapterIndex, 2);
  assert.equal(imported.book.progress.scrollRatio, 0.61);
}, true);

test("adding the retained preamble remaps old first-chapter progress to the actual chapter", async (h) => {
  const legacy = makeLegacyEntry(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  assert.equal(legacy.chapters[0].title, "第一章 起点", "fixture must reproduce old discarded preamble indexing");
  seed(h, legacy, progress(1));
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  const current = h.books.get(imported.book.id).chapters.find((chapter) => chapter.title === "第一章 起点");
  assert.equal(h.books.get(imported.book.id).chapters[0].preamble, true, "preamble was not retained before progress remapping");
  assert.equal(current.index, 2);
  assert.equal(imported.book.progress.chapterIndex, current.index, "old first-chapter progress was moved onto the new preamble");
  assert.equal(imported.book.progress.scrollRatio, 0.42);
}, true);

test("adding the retained preamble remaps old later-chapter progress", async (h) => {
  const legacy = makeLegacyEntry(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  seed(h, legacy, progress(2, 0.81));
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  assert.equal(imported.book.progress.chapterIndex, 3, "old chapter-two progress did not follow chapter two after preamble insertion");
  assert.equal(h.books.get(imported.book.id).chapters[2].title, "第二章 后续");
  assert.equal(imported.book.progress.scrollRatio, 0.81);
}, true);

test("duplicate chapter titles are disambiguated by unchanged content", async (h) => {
  const text = `第一章 重名\n内容甲唯一标记\n\n第一章 重名\n内容乙唯一标记`;
  const legacy = makeLegacyEntry(file({ uri: OLD_URI, text }));
  seed(h, legacy, progress(2, 0.55));
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: `${PREAMBLE}\n\n${text}` }));
  const target = h.books.get(imported.book.id).chapters.find((chapter) => chapter.content === "内容乙唯一标记");
  assert.equal(target.index, 3);
  assert.equal(imported.book.progress.chapterIndex, target.index, "duplicate title matching picked the wrong chapter body");
  assert.equal(imported.book.progress.scrollRatio, 0.55);
}, true);

test("a unique chapter title offers an explicit changed-body candidate without active progress", async (h) => {
  const legacy = makeLegacyEntry(file({ uri: OLD_URI }));
  seed(h, legacy, progress(2, 0.36));
  const updated = `${PREAMBLE}\n\n${CHAPTER_TEXT.replace(BODY_TWO, BODY_TWO + " 新增修订内容。")}`;
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: updated }));
  assert.equal(imported.book.progress, null, "title-only matching must not create automatically resumable progress");
  assert.equal(imported.book.progressRecovery?.status, "needs_review");
  assert.equal(imported.book.progressRecovery.candidate.chapterIndex, 3);
  assert.equal(imported.book.progressRecovery.candidate.scrollRatio, 0);
  assert.equal(imported.book.progressRecovery.previous.scrollRatio, 0.36);
  assert(h.books.get(imported.book.id).chapters[2].content.includes("新增修订内容"));
}, true);

test("ambiguous repeated titles and bodies clear progress instead of guessing", async (h) => {
  const text = "第一章 重复\n完全相同的正文\n\n第一章 重复\n完全相同的正文";
  const legacy = makeLegacyEntry(file({ uri: OLD_URI, text }));
  seed(h, legacy, progress(2, 0.69));
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: `${PREAMBLE}\n\n${text}` }));
  assert(!imported.book.progress, "ambiguous old progress was guessed onto a potentially different chapter");
}, true);

test("unchanged duplicate chapter structure is still ambiguous and keeps an unresolved anchor", async (h) => {
  const text = "第一章 重复\n完全相同的正文\n\n第一章 重复\n完全相同的正文";
  const existing = h.imports.createLocalBookEntry(file({ uri: OLD_URI, text }));
  seed(h, existing, progress(2, 0.69));
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text }));
  assert.equal(imported.book.progress, null, "unchanged order is not proof of duplicate chapter identity");
  assert.equal(imported.book.progressRecovery?.status, "unresolved");
  assert.equal(imported.book.progressRecovery.previous.chapterIndex, 2);
  assert.equal(imported.book.progressRecovery.previous.scrollRatio, 0.69);
}, true);

test("a removed old progress chapter does not transfer to an unrelated new chapter", async (h) => {
  const legacy = makeLegacyEntry(file({ uri: OLD_URI }));
  seed(h, legacy, progress(2));
  const replacement = `第一章 起点\n${BODY_ONE}\n\n第三章 新篇\n全新的无关正文`;
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: replacement }));
  assert(!imported.book.progress, "same numeric index transferred removed-chapter progress onto unrelated text");
}, true);

test("old entries without URI metadata are never fuzzy-merged or overwritten", async (h) => {
  // Build the actual legacy bug's records: sourceUri was passed by callers but
  // ignored by createLocalBookEntry, leaving a file/timestamp identity.
  const exact = makeLegacyEntry(file({ sourceUri: OLD_URI, sourceType: "system-picker" }));
  const similar = makeLegacyEntry(file({ fileName: "fixture-book copy.txt", text: CHAPTER_TEXT + "\n不同版本", sourceUri: SECOND_URI }));
  const oldExact = seed(h, exact, progress(2, 0.31));
  const oldSimilar = seed(h, similar, progress(1, 0.72));
  const imported = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, lastModified: 123456 }));
  assert.notEqual(imported.book.id, exact.book.id);
  assert.notEqual(imported.book.id, similar.book.id);
  assert.equal(h.books.size, 3, "unsafe legacy match removed or overwrote an unrelated old record");
  assert.deepEqual(plain(h.books.get(exact.book.id)), plain(oldExact));
  assert.deepEqual(plain(h.books.get(similar.book.id)), plain(oldSimilar));
  assert(!imported.book.progress, "new URI-backed book inherited an unverified legacy record's progress");
});

test("different native documents retain independent progress during repeated import", async (h) => {
  const a = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI }));
  const b = await h.imports.saveLocalTextFile(file({ sourceUri: SECOND_URI }));
  seed(h, a, progress(1, 0.2));
  seed(h, b, progress(2, 0.9));
  const nextA = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, lastModified: 7777 }));
  const nextB = await h.imports.saveLocalTextFile(file({ sourceUri: SECOND_URI, lastModified: 8888 }));
  assert.equal(h.books.size, 2, "timestamp changes duplicated native books");
  assert.equal(nextA.book.progress.chapterIndex, 1);
  assert.equal(nextA.book.progress.scrollRatio, 0.2);
  assert.equal(nextB.book.progress.chapterIndex, 2);
  assert.equal(nextB.book.progress.scrollRatio, 0.9);
}, true);

test("an existing-book read failure rejects import without publishing a replacement", async (h) => {
  const input = file({ uri: OLD_URI });
  const existing = seed(h, h.imports.createLocalBookEntry(input), progress(2));
  const before = structuredClone(existing);
  const read = h.queueRead(existing.book.id);
  const pending = h.imports.saveLocalTextFile(input);
  read.reject(new Error("Synthetic IndexedDB read failure"));
  await assert.rejects(pending, /Synthetic IndexedDB read failure/, "storage read failure was treated as a missing book");
  assert.equal(h.importWrites.length, 0, "import attempted to overwrite an unreadable existing entry");
  assert.deepEqual(plain(h.books.get(existing.book.id)), plain(before));
}, true);

test("reimporting the mounted book retires its old reader before chapter indexes change", async (h) => {
  const legacy = makeLegacyEntry(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  seed(h, legacy, progress(1));
  await h.api.renderNovelReader(legacy.book.id, 1);
  h.runFrames();
  h.setRatio(0.67);
  h.window.dispatchEvent(h.event("scroll"));
  const obsoleteFrames = h.frameIds();
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  await settle();
  assert.equal(h.state.active, false, "old mounted reader remains able to write an obsolete chapter index");
  assert.equal(imported.book.progress.chapterIndex, 2);
  assert(h.saves.some((save) => save.id === legacy.book.id && save.progress.scrollRatio === 0.67), "old mounted reader was not flushed before replacement");
  const count = h.saves.length;
  for (const id of obsoleteFrames) h.runFrame(id, true);
  h.api.__test.flushReaderProgress();
  await settle();
  assert.equal(h.saves.length, count, "old reader callback issued another stale write after reimport");
  assert.equal(h.books.get(imported.book.id).book.progress.chapterIndex, 2);
}, true);

test("a delayed old progress response cannot replace newly reimported chapter cache", async (h) => {
  const legacy = makeLegacyEntry(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  seed(h, legacy, progress(1));
  const delayedResponses = [];
  h.window.__importProgressHook = (id, nextProgress) => {
    // Simulate a completed earlier transaction whose JS completion is delayed:
    // disk progress commits now, but the returned entry still has old chapters.
    const oldSnapshot = structuredClone(h.books.get(id));
    oldSnapshot.book.progress = { ...nextProgress, updatedAt: "2026-01-02T04:00:00.000Z" };
    h.books.set(id, structuredClone(oldSnapshot));
    const response = deferred();
    delayedResponses.push({ response, oldSnapshot });
    return response.promise;
  };
  await h.api.renderNovelReader(legacy.book.id, 1);
  h.runFrames();
  h.setRatio(0.63);
  h.api.__test.saveReaderProgress();
  await settle();
  assert(delayedResponses.length > 0);
  const newText = WITH_PREAMBLE.replace(BODY_TWO, BODY_TWO + " 最新重导正文标记戊。");
  const imported = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: newText }));
  for (const item of delayedResponses) item.response.resolve(item.oldSnapshot);
  await settle();
  const cached = h.api.__test.localBooks.get(imported.book.id);
  assert(!Object.hasOwn(cached, "chapters"), "late old progress response repopulated full chapters in the summary cache");
  assert.equal(cached.generation, imported.generation, "late old progress response overwrote the new content generation");
  assert.equal(h.books.get(imported.book.id).chapters[0].preamble, true);
  await h.api.renderNovelReader(imported.book.id, 3);
  assert(h.state.chapter.content.includes("最新重导正文标记戊"), "reopening after the late response read stale chapter content");
}, true);

test("native reimport retires the same-book loading session created by the real shell rerender", async (h) => {
  const legacy = makeLegacyEntry(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  seed(h, legacy, progress(1, 0.63));
  const shell = installReaderImportShell(h, legacy.book.id);
  await shell.renderCurrentView();
  h.runFrames();
  h.setRatio(0.63);
  const commit = h.queueImportWrite();
  const pending = h.imports.importNativeTextFile({ ...nativeFile(OLD_URI), text: WITH_PREAMBLE });
  await settle();
  // Import invokes renderCurrentView without awaiting it: the replacement reader
  // has a session but book=null while cached local data crosses an await boundary.
  const retiredDuringImport = !h.state.active;
  h.runFrames();
  assert.equal(h.importWrites.length, 1);
  assert(!h.importWrites[0].book.progress, "UI must not precompute progress before the storage transaction reads its snapshot");
  commit.resolve();
  await pending;
  await settle();
  const saved = h.books.get(legacy.book.id);
  assert.equal(saved.book.progress.chapterIndex, 2, "old reader flush wrote its obsolete index into the newly imported preamble");
  assert.equal(saved.book.progress.scrollRatio, 0.63);
  assert.equal(h.state.chapter.title, saved.chapters[1].title);
  assert.equal(retiredDuringImport, true, "same-book loading session remounted an obsolete reader during import");
  assert.equal(h.saves.length, 1, "openReader flushed a remounted obsolete reader after the replacement committed");
}, (candidate) => {
  const guard = " || readerState.session?.bookId === entry.book.id";
  assert(candidate.includes(guard), "Expected the specific same-book loading-session retirement guard");
  return candidate.replace(guard, "");
});

test("importing another book does not retire a different-book loading reader", async (h) => {
  const a = seed(h, h.imports.createLocalBookEntry(file({ uri: OLD_URI })));
  const b = seed(h, h.imports.createLocalBookEntry(file({ uri: SECOND_URI })));
  const readB = h.queueRead(b.book.id);
  const renderingB = h.api.renderNovelReader(b.book.id, 1);
  const loadingSession = h.state.session;
  assert.equal(h.state.book, null);
  await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: WITH_PREAMBLE }));
  assert.equal(h.state.session, loadingSession, "unrelated import invalidated the pending reader");
  assert.equal(h.state.active, true);
  readB.resolve(b);
  await renderingB;
  assert.equal(h.state.book.id, b.book.id);
  assert.notEqual(h.state.book.id, a.book.id);
});

test("system picker passes stable URI and keeps unknown modification time as zero", async (h) => {
  h.window.Capacitor.Plugins.FanHaoNovel.openTextDocumentPicker = async () => ({ items: [nativeFile()] });
  h.imports.importFromSystemFileManager();
  await settle();
  assert.equal(h.books.size, 1);
  const entry = [...h.books.values()][0];
  assert.equal(entry.book.sourceUri, OLD_URI);
  assert.equal(entry.book.lastModified, 0, "picker invented a document modification timestamp from import time");
  assert.equal(h.imports.listState.uploading, false);
});

test("deferred picker opts in and imports descriptors instead of legacy items", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel;
  let options; const reads = [];
  plugin.openTextDocumentPicker = async (value) => {
    options = value;
    return { documents: [{ uri: OLD_URI, fileName: "selected.txt" }], items: [nativeFile(SECOND_URI)] };
  };
  plugin.readPickedTextFile = async ({ uri }) => { reads.push(uri); return { ...nativeFile(uri), fileName: "", uri: "" }; };
  h.imports.importFromSystemFileManager(); await settle();
  assert(options && typeof options === "object", "picker did not request the bounded deferred protocol");
  assert.deepEqual(plain(options), { deferredRead: true }, "picker did not request the bounded deferred protocol");
  assert.deepEqual(reads, [OLD_URI], "descriptor read was skipped or legacy items were also imported");
  assert.equal(h.books.size, 1);
  const saved = [...h.books.values()][0];
  assert.equal(saved.book.sourceUri, OLD_URI, "descriptor URI was lost when read response omitted its alias");
  assert.equal(saved.book.fileName, "selected.txt");
  assert.equal(saved.book.sourceType, "system-picker");
  assert.equal(saved.book.lastModified, 0);
  assert.equal(h.imports.listState.uploading, false);
}, oldPicker);

test("an empty documents array is authoritative over legacy items", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel; let reads = 0;
  plugin.openTextDocumentPicker = async () => ({ documents: [], items: [nativeFile()] });
  plugin.readPickedTextFile = async () => { reads++; return nativeFile(); };
  h.imports.importFromSystemFileManager(); await settle();
  assert.equal(h.importWrites.length, 0, "empty new selection fell back to stale legacy full-text items");
  assert.equal(reads, 0);
  assert.equal(h.imports.listState.uploading, false);
}, oldPicker);

test("deferred picker reads the next book only after the previous read and save finish", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel;
  const readA = deferred(), saveA = h.queueImportWrite(), reads = [];
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI }, { uri: SECOND_URI }], items: [] });
  plugin.readPickedTextFile = ({ uri }) => { reads.push(uri); return uri === OLD_URI ? readA.promise : Promise.resolve(nativeFile(uri)); };
  h.imports.importFromSystemFileManager(); await settle();
  assert.deepEqual(reads, [OLD_URI], "B was read while A was still being read");
  assert.equal(h.importWrites.length, 0);
  readA.resolve(nativeFile()); await settle();
  assert.equal(h.importWrites.length, 1, "another book was saved before the first transaction completed");
  assert.deepEqual(reads, [OLD_URI], "B was read while A had not durably committed");
  assert.equal(h.books.size, 0);
  assert.equal(h.imports.listState.uploading, true);
  saveA.resolve(); await settle();
  assert.deepEqual(reads, [OLD_URI, SECOND_URI]);
  assert.equal(h.books.size, 2);
  assert.equal(h.imports.listState.uploading, false);
}, mutatePicker("await saveLocalTextFile({", "saveLocalTextFile({"));

test("deferred read itself is awaited before another selected URI is requested", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel; const readA = deferred(), reads = [];
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI }, { uri: SECOND_URI }] });
  plugin.readPickedTextFile = ({ uri }) => { reads.push(uri); return uri === OLD_URI ? readA.promise : Promise.resolve(nativeFile(uri)); };
  h.imports.importFromSystemFileManager(); await settle();
  assert.deepEqual(reads, [OLD_URI], "multiple deferred bodies were requested concurrently");
  readA.resolve(nativeFile()); await settle();
  assert.equal(h.books.size, 2);
}, mutatePicker("await plugin.readPickedTextFile({ uri })", "plugin.readPickedTextFile({ uri })"));

test("one failed deferred read does not stop later files and counts native errors once", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel; const reads = [];
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI }, { uri: SECOND_URI }], errors: [{ message: "not TXT" }] });
  plugin.readPickedTextFile = async ({ uri }) => { reads.push(uri); if (uri === OLD_URI) throw new Error("provider offline"); return nativeFile(uri); };
  h.imports.importFromSystemFileManager(); await settle();
  assert.deepEqual(reads, [OLD_URI, SECOND_URI]);
  assert.equal(h.books.size, 1);
  assert.equal([...h.books.values()][0].book.sourceUri, SECOND_URI);
  assert(h.statuses.some(([message]) => message.includes("文件管理器导入 2/2")), "processed progress counted only successes after a failed read");
  assert.equal(h.statuses.at(-1)[0], "已导入 1 本，跳过 2 个文件；首个失败原因：provider offline");
  assert.equal(h.imports.listState.uploading, false);
});

test("all failed picked files preserve the first actionable decoder reason in the final summary", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel;
  const existing = seed(h, h.imports.createLocalBookEntry(file({ uri: OLD_URI }))), snapshot = plain(existing);
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI }, { uri: SECOND_URI }] });
  plugin.readPickedTextFile = async ({ uri }) => {
    throw new Error(uri === OLD_URI ? "TXT 编码无法识别，请另存为 UTF-8 后重试" : "第二个文档已被移动");
  };
  h.imports.importFromSystemFileManager(); await settle();
  assert.equal(h.importWrites.length, 0);
  assert.deepEqual(plain(h.books.get(existing.book.id)), snapshot);
  assert.match(h.statuses.at(-1)[0], /已导入 0 本，跳过 2 个文件；首个失败原因：.*另存为 UTF-8/, "final failure summary swallowed actionable encoding guidance");
  assert.equal(h.statuses.at(-1)[1], "error");
  assert(h.statuses.some(([message]) => message.includes("第二个文档已被移动")), "per-file failure did not expose its own reason");
  assert.equal(h.imports.listState.uploading, false);
}, mutatePicker("firstFailure ||= reason;", ""));

test("a non-array documents field retains old-native items compatibility", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel; let reads = 0;
  plugin.openTextDocumentPicker = async () => ({ documents: null, items: [nativeFile()] });
  plugin.readPickedTextFile = async () => { reads++; throw new Error("legacy response must not trigger a second read"); };
  h.imports.importFromSystemFileManager(); await settle();
  assert.equal(reads, 0); assert.equal(h.importWrites.length, 1);
  assert.equal([...h.books.values()][0].book.sourceUri, OLD_URI);
  assert.equal(h.imports.listState.uploading, false);
});

test("failed deferred persistence finishes before the next read and preserves old stored data", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel; const reads = [];
  const existing = seed(h, h.imports.createLocalBookEntry(file({ uri: OLD_URI }))), snapshot = plain(existing);
  const saveA = h.queueImportWrite();
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI }, { uri: SECOND_URI }] });
  plugin.readPickedTextFile = async ({ uri }) => { reads.push(uri); return { ...nativeFile(uri), text: WITH_PREAMBLE }; };
  h.imports.importFromSystemFileManager(); await settle();
  assert.deepEqual(reads, [OLD_URI]);
  assert.equal(h.importWrites.length, 1);
  saveA.reject(new Error("synthetic transaction abort")); await settle();
  assert.deepEqual(reads, [OLD_URI, SECOND_URI]);
  assert.deepEqual(plain(h.books.get(existing.book.id)), snapshot);
  assert.equal(h.books.size, 2);
  assert.equal(h.statuses.at(-1)[0], "已导入 1 本，跳过 1 个文件；首个失败原因：synthetic transaction abort");
});

test("repeated selected URI is read and saved once without conflating different URIs", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel; const reads = [];
  plugin.openTextDocumentPicker = async () => ({ documents: [
    { uri: OLD_URI, fileName: "same.txt" }, { uri: ` ${OLD_URI} `, fileName: "same.txt" },
    { uri: SECOND_URI, fileName: "same.txt" }, { uri: OLD_URI }
  ] });
  plugin.readPickedTextFile = async ({ uri }) => { reads.push(uri); return nativeFile(uri, "same.txt"); };
  h.imports.importFromSystemFileManager(); await settle();
  assert.deepEqual(reads, [OLD_URI, SECOND_URI], "duplicate descriptors caused repeated native reads");
  assert.equal(h.importWrites.length, 2);
  assert.equal(h.books.size, 2);
  assert.equal(h.statuses.at(-1)[0], "已从文件管理器导入 2 本");
}, mutatePicker("if (seenUris.has(uri)) return false;", ""));

test("legacy duplicate full-text URI is also saved only once", async (h) => {
  h.window.Capacitor.Plugins.FanHaoNovel.openTextDocumentPicker = async () => ({ items: [nativeFile(), nativeFile()] });
  h.imports.importFromSystemFileManager(); await settle();
  assert.equal(h.importWrites.length, 1, "legacy duplicate selection was needlessly imported twice");
  assert.equal(h.books.size, 1);
}, oldPicker);

test("canceled picker never reads descriptors or imports legacy payloads", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel; let reads = 0;
  plugin.openTextDocumentPicker = async () => ({ canceled: true, documents: [{ uri: OLD_URI }], items: [nativeFile()] });
  plugin.readPickedTextFile = async () => { reads++; return nativeFile(); };
  h.imports.importFromSystemFileManager(); await settle();
  assert.equal(reads, 0); assert.equal(h.importWrites.length, 0);
  assert.equal(h.imports.listState.uploading, false);
  assert.match(h.statuses.at(-1)[0], /已取消/);
});

test("missing deferred native reader reports incompatibility without treating descriptors as text", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel;
  const existing = seed(h, h.imports.createLocalBookEntry(file({ uri: OLD_URI }))), snapshot = plain(existing);
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI, fileName: "descriptor.txt" }], items: [nativeFile(SECOND_URI)] });
  delete plugin.readPickedTextFile;
  h.imports.importFromSystemFileManager(); await settle();
  assert.equal(h.importWrites.length, 0);
  assert.deepEqual(plain(h.books.get(existing.book.id)), snapshot);
  assert.equal(h.statuses.at(-1)[1], "error");
  assert.match(h.statuses.at(-1)[0], /不支持逐本读取/);
  assert.equal(h.imports.listState.uploading, false);
});

test("available false with text cannot overwrite an existing URI-backed book", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel;
  const existing = seed(h, h.imports.createLocalBookEntry(file({ uri: OLD_URI }))), snapshot = plain(existing);
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI }, { uri: SECOND_URI }] });
  plugin.readPickedTextFile = async ({ uri }) => uri === OLD_URI
    ? { available: false, text: "should not replace saved chapters", uri, message: "unavailable" } : nativeFile(uri);
  h.imports.importFromSystemFileManager(); await settle();
  assert.deepEqual(plain(h.books.get(existing.book.id)), snapshot, "an unavailable result overwrote the stored book");
  assert.equal(h.importWrites.length, 1);
  assert.equal(h.books.size, 2);
}, mutatePicker("file?.available === false || ", ""));

test("missing text cannot become a blank-text replacement of existing chapters", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel;
  const existing = seed(h, h.imports.createLocalBookEntry(file({ uri: OLD_URI }))), snapshot = plain(existing);
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI }] });
  plugin.readPickedTextFile = async () => ({ available: true, uri: OLD_URI, fileName: "descriptor-only.txt" });
  h.imports.importFromSystemFileManager(); await settle();
  assert.equal(h.importWrites.length, 0, "descriptor-only response was saved as blank text");
  assert.deepEqual(plain(h.books.get(existing.book.id)), snapshot);
}, mutatePicker(' || typeof file?.text !== "string"', ""));

test("malformed descriptors are skipped individually and a later valid URI still imports", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel; const reads = [];
  plugin.openTextDocumentPicker = async () => ({ documents: [null, {}, { uri: 123 }, { uri: " " }, { uri: SECOND_URI }] });
  plugin.readPickedTextFile = async ({ uri }) => { reads.push(uri); return nativeFile(uri); };
  h.imports.importFromSystemFileManager(); await settle();
  assert.deepEqual(reads, [SECOND_URI]);
  assert.equal(h.books.size, 1);
  assert.equal(h.statuses.at(-1)[0], "已导入 1 本，跳过 4 个文件；首个失败原因：所选文档缺少 URI");
});

test("empty or whitespace-only picked text never overwrites an existing book", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel;
  const existing = seed(h, h.imports.createLocalBookEntry(file({ uri: OLD_URI }))), snapshot = plain(existing);
  plugin.openTextDocumentPicker = async () => ({ documents: [{ uri: OLD_URI }] });
  for (const text of ["", " \r\n\t\uFEFF "]) {
    plugin.readPickedTextFile = async () => ({ ...nativeFile(), text });
    h.imports.importFromSystemFileManager(); await settle();
  }
  assert.equal(h.importWrites.length, 0, "empty picked text overwrote saved chapters");
  assert.equal(h.books.size, 1);
  assert.deepEqual(plain(h.books.get(existing.book.id)), snapshot);
  assert.match(h.statuses.at(-1)[0], /TXT 内容为空/);
  assert.equal(h.imports.listState.uploading, false);
}, mutatePicker('if (!/\\S/.test(file.text)) throw new Error("TXT 内容为空，未替换已保存的小说");', ""));

for (const unavailable of [false, true]) {
  test(`picker ${unavailable ? "unavailable result" : "bridge rejection"} clears its operation without writing`, async (h) => {
    h.window.Capacitor.Plugins.FanHaoNovel.openTextDocumentPicker = async () => {
      if (!unavailable) throw new Error("picker unavailable");
      return { available: false, documents: [{ uri: OLD_URI }], items: [nativeFile()], message: "picker unavailable" };
    };
    h.imports.importFromSystemFileManager(); await settle();
    assert.equal(h.importWrites.length, 0);
    assert.equal(h.imports.listState.uploading, false);
    assert.equal(h.statuses.at(-1)[1], "error");
    assert.match(h.statuses.at(-1)[0], /picker unavailable/);
  });
}

for (const origin of ["picker", "scan", "browser", "upload"]) {
  test(`finishing external import cannot clear a still-running ${origin} operation`, async (h) => {
    const plugin = h.window.Capacitor.Plugins.FanHaoNovel; const waiting = deferred(); let pickerCalls = 0;
    plugin.openTextDocumentPicker = () => { pickerCalls++; return waiting.promise; };
    if (origin === "picker") h.imports.importFromSystemFileManager();
    else if (origin === "scan") {
      plugin.openTextDirectoryPicker = () => waiting.promise; plugin.readScannedTextFile = async () => nativeFile();
      h.imports.scanLocalNovelFiles();
    } else {
      const browserFile = { name: "browser.txt", type: "text/plain", size: 300, lastModified: 0, arrayBuffer: () => waiting.promise };
      h.imports[origin === "browser" ? "importLocalNovelFiles" : "uploadNovelFiles"]([browserFile]);
    }
    await settle();
    assert.equal(h.imports.listState.uploading, true);
    await h.imports.importNativeTextFile(nativeFile(SECOND_URI)); await settle();
    assert.equal(h.imports.listState.uploading, true, "external import cleared another live operation's busy state");
    assert.equal(h.imports.listState.busyAction, origin === "browser" ? "local" : origin);
    const before = pickerCalls; h.imports.importFromSystemFileManager(); await settle();
    assert.equal(pickerCalls, before, "a second picker was allowed while another import was still running");
    waiting.resolve(origin === "picker" || origin === "scan" ? { canceled: true } : new TextEncoder().encode(CHAPTER_TEXT).buffer);
    await settle();
    assert.equal(h.imports.listState.uploading, false);
  }, oldBusy);
}

test("finishing the older picker preserves a newer external import's busy owner", async (h) => {
  const waitingPicker = deferred(), writingNative = h.queueImportWrite();
  h.window.Capacitor.Plugins.FanHaoNovel.openTextDocumentPicker = () => waitingPicker.promise;
  h.imports.importFromSystemFileManager(); await settle();
  const native = h.imports.importNativeTextFile(nativeFile(SECOND_URI)); await settle();
  waitingPicker.resolve({ canceled: true }); await settle();
  assert.equal(h.imports.listState.uploading, true, "older picker completion cleared the newer native import");
  assert.equal(h.imports.listState.busyAction, "local");
  writingNative.resolve(); await native; await settle();
  assert.equal(h.imports.listState.uploading, false);
}, oldBusy);

test("same-action busy owners remain distinct and repeated cleanup is harmless", (h) => {
  const first = h.imports.setNovelBusy("local"), second = h.imports.setNovelBusy("local");
  h.imports.clearNovelBusy(first); h.imports.clearNovelBusy(first); h.imports.clearNovelBusy({});
  assert.equal(h.imports.listState.uploading, true, "cleanup of one owner cleared another owner with the same action label");
  assert.equal(h.imports.listState.busyAction, "local");
  h.imports.clearNovelBusy(second);
  assert.equal(h.imports.listState.uploading, false);
  assert.equal(h.imports.listState.busyAction, "");
}, oldBusy);

test("directory picker retains URI and unknown modification time through confirmation", async (h) => {
  const plugin = h.window.Capacitor.Plugins.FanHaoNovel;
  plugin.openTextDirectoryPicker = async () => ({ items: [{ uri: OLD_URI, fileName: "native-fixture.txt", recommended: true, sizeBytes: 300, lastModified: 0 }] });
  plugin.readScannedTextFile = async () => nativeFile();
  h.imports.scanLocalNovelFiles();
  await settle();
  const confirm = h.document.body.querySelectorAll("button").find((button) => button.textContent === "导入已选");
  assert(confirm, "real scan confirmation UI was not mounted");
  confirm.click();
  await settle();
  assert.equal(h.books.size, 1);
  const entry = [...h.books.values()][0];
  assert.equal(entry.book.sourceUri, OLD_URI);
  assert.equal(entry.book.lastModified, 0, "directory import invented an unknown modification timestamp");
});

test("a B notification during A storage commit is retained and processed serially", async (h) => {
  const queue = nativeQueue(h, [nativeFile()]);
  const writingA = h.queueImportWrite();
  const pending = h.imports.importPendingNativeTextFile();
  await settle();
  assert.equal(h.importWrites.length, 1);
  queue.queue.push(nativeFile(SECOND_URI, "native-b.txt"));
  h.window.dispatchEvent(h.event("fanhaoNativeTextFile"));
  await settle();
  assert.equal(queue.calls.length, 1, "B consumed concurrently while A was still committing");
  writingA.resolve();
  await pending;
  await settle();
  assert.equal(h.books.size, 2, "busy A import swallowed the B notification");
  assert.equal(queue.calls.length, 3, "consumer did not finish at the empty queue");
  assert.equal(queue.maximumInFlight, 1);
  assert.equal(h.imports.nativeBusy, false);
}, true);

test("one notification drains already-queued A B and C then stops on empty", async (h) => {
  const queue = nativeQueue(h, [nativeFile(), nativeFile(SECOND_URI, "native-b.txt"), nativeFile("content://synthetic.provider/document/book-c", "native-c.txt")]);
  await h.imports.importPendingNativeTextFile();
  assert.equal(h.books.size, 3, "queued imports required extra notifications to continue");
  assert.equal(queue.calls.length, 4);
  assert.equal(queue.maximumInFlight, 1);
  assert.equal(activeRetryTimers(h).length, 0);
}, true);

test("an empty native queue stops without a retry or storage write", async (h) => {
  const queue = nativeQueue(h);
  await h.imports.importPendingNativeTextFile();
  assert.equal(queue.calls.length, 1);
  assert.equal(h.importWrites.length, 0);
  assert.equal(activeRetryTimers(h).length, 0);
  assert.equal(h.imports.nativeBusy, false);
});

test("resolved native read failure with hasPending continues to the next item", async (h) => {
  const queue = nativeQueue(h, [{ available: false, message: "Synthetic native TXT read failure", hasPending: true }, nativeFile()]);
  await h.imports.importPendingNativeTextFile();
  assert.equal(h.books.size, 1, "failed native item blocked a known pending item");
  assert.equal(queue.calls.length, 3);
  assert(h.statuses.some(([message, tone]) => message.includes("Synthetic native TXT read failure") && tone === "error"));
}, true);

test("ordinary bridge exception with no new item does not spin or schedule retry", async (h) => {
  const queue = nativeQueue(h, [new Error("Synthetic unavailable bridge")]);
  await h.imports.importPendingNativeTextFile();
  assert.equal(queue.calls.length, 1);
  assert.equal(h.books.size, 0);
  assert.equal(activeRetryTimers(h).length, 0);
  assert.equal(h.imports.nativeBusy, false);
  assert(h.statuses.some(([message, tone]) => message.includes("Synthetic unavailable bridge") && tone === "error"));
});

test("bridge exception carrying hasPending drains the next item", async (h) => {
  const failure = Object.assign(new Error("Synthetic item failure"), { data: { hasPending: true } });
  const queue = nativeQueue(h, [failure, nativeFile()]);
  await h.imports.importPendingNativeTextFile();
  assert.equal(h.books.size, 1, "known pending item was abandoned after bridge rejection");
  assert.equal(queue.calls.length, 3);
}, true);

test("notification received during a rejecting bridge call still requests another consume", async (h) => {
  const first = deferred();
  const queue = nativeQueue(h, [first]);
  const pending = h.imports.importPendingNativeTextFile();
  await settle();
  queue.queue.push(nativeFile());
  h.window.dispatchEvent(h.event("fanhaoNativeTextFile"));
  first.reject(new Error("Synthetic first bridge call failure"));
  await pending;
  assert.equal(h.books.size, 1, "new notification was lost when the older call rejected");
  assert.equal(queue.calls.length, 3);
}, true);

test("native busy results maintain one delayed retry and eventually drain", async (h) => {
  const busy = { available: false, busy: true, hasPending: true };
  const queue = nativeQueue(h, [busy, busy, nativeFile()]);
  await h.imports.importPendingNativeTextFile();
  assert.equal(queue.calls.length, 1);
  assert.equal(activeRetryTimers(h).length, 1, "native busy needs one bounded delayed retry");
  h.window.dispatchEvent(h.event("fanhaoNativeTextFile"));
  await settle();
  assert.equal(queue.calls.length, 2);
  assert.equal(activeRetryTimers(h).length, 1, "a repeated busy notification duplicated retry timers");
  h.runTimers(500);
  await settle();
  assert.equal(h.books.size, 1);
  assert.equal(queue.calls.length, 4);
  assert.equal(activeRetryTimers(h).length, 0);
  assert.equal(h.imports.nativeBusy, false);
}, true);

test("frontend save failure never publishes a book or success status and clears busy state", async (h) => {
  nativeQueue(h, [nativeFile()]);
  const write = h.queueImportWrite();
  const pending = h.imports.importPendingNativeTextFile();
  await settle();
  write.reject(new Error("Synthetic disk commit failure"));
  await pending;
  assert.equal(h.books.size, 0);
  assert.equal(h.api.__test.localBooks.size, 0);
  assert(!h.statuses.some(([message]) => message.startsWith("已加入手机本地书库")), "failed save reported import success");
  assert(h.statuses.some(([message, tone]) => message.includes("Synthetic disk commit failure") && tone === "error"));
  assert.equal(h.imports.listState.uploading, false);
  assert.equal(h.imports.nativeBusy, false);
});

test("frontend save failure does not prevent another queued native file from importing", async (h) => {
  const queue = nativeQueue(h, [nativeFile(), nativeFile(SECOND_URI, "native-b.txt")]);
  const write = h.queueImportWrite();
  const pending = h.imports.importPendingNativeTextFile();
  await settle();
  write.reject(new Error("Synthetic first disk commit failure"));
  await pending;
  assert.equal(h.books.size, 1, "a failed frontend save stopped the remaining native import queue");
  assert.equal([...h.books.values()][0].book.sourceUri, SECOND_URI);
  assert.equal(queue.calls.length, 3);
  assert.equal(h.imports.listState.uploading, false);
}, true);

test("import returns a new summary generation while full text stays in persistent storage", async (h) => {
  const saved = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, text: WITH_PREAMBLE }));
  assert(!Object.hasOwn(saved, "chapters"), "import returned an aggregate full-book entry");
  assert(saved.generation && saved.book.localGeneration === saved.generation);
  assert.deepEqual(h.storageCalls.map((call) => call.kind), ["entry", "saveEntry"]);
  assert(!Object.hasOwn(h.api.__test.localBooks.get(saved.book.id), "chapters"));
  assert(body(h.books.get(saved.book.id)).includes(PREAMBLE));
  const storedChapters = h.books.get(saved.book.id).chapters;
  assert(storedChapters.every((chapter) => typeof chapter.id === "string" && chapter.id.length > 0));
  assert.equal(new Set(storedChapters.map((chapter) => chapter.id)).size, storedChapters.length);
  const updated = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, text: WITH_PREAMBLE + "\n修订" }));
  assert.notEqual(updated.generation, saved.generation);
  assert.equal(h.api.__test.localBooks.get(saved.book.id).generation, updated.generation);
});

test("a summary started before reimport cannot replace the new generation", async (h) => {
  const old = seed(h, h.imports.createLocalBookEntry(file({ sourceUri: OLD_URI })), progress(1));
  const lookup = h.queueRead(old.book.id);
  const pending = h.api.__test.ensureLocalNovelEntry(old.book.id);
  await settle();
  const saved = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, text: WITH_PREAMBLE }));
  lookup.resolve(old);
  const summary = await pending;
  assert.equal(summary.generation, saved.generation);
  assert(!Object.hasOwn(summary, "chapters"));
  assert.equal(h.api.__test.localBooks.get(saved.book.id).generation, saved.generation);
});

test("a catalog started before reimport is discarded instead of publishing old metadata", async (h) => {
  const old = seed(h, h.imports.createLocalBookEntry(file({ sourceUri: OLD_URI })), progress(1));
  const lookup = h.queueRead(old.book.id);
  const pending = h.api.__test.readLocalCatalog(old.book.id);
  await settle();
  const saved = await h.imports.saveLocalTextFile(file({ sourceUri: OLD_URI, text: WITH_PREAMBLE }));
  lookup.resolve(old);
  assert.equal(await pending, null);
  assert.equal(h.api.__test.localBooks.get(saved.book.id).generation, saved.generation);
  assert(!Object.hasOwn(h.api.__test.localBooks.get(saved.book.id), "chapters"));
});

test("same-order unique-title body revision requires review and preserves the old anchor", async (h) => {
  seed(h, h.imports.createLocalBookEntry(file({ uri: OLD_URI })), progress(2, 0.71));
  const saved = await h.imports.saveLocalTextFile(file({ uri: OLD_URI, text: CHAPTER_TEXT.replace(BODY_TWO, BODY_TWO + " 新正文") }));
  assert.equal(saved.book.progress, null, "title-only location silently remained automatically resumable");
  assert.equal(saved.book.progressRecovery?.status, "needs_review");
  assert.equal(saved.book.progressRecovery.candidate.chapterIndex, 2);
  assert.equal(saved.book.progressRecovery.candidate.scrollRatio, 0);
  assert.equal(saved.book.progressRecovery.previous.scrollRatio, 0.71);
}, true);

let passed = 0;
let controls = 0;
const failures = [];
for (const item of tests) {
  if (!process.argv.includes("--negative-only")) {
    try { await item.run(makeHarness()); passed += 1; console.log(`PASS ${item.name}`); }
    catch (error) { failures.push({ name: item.name, error }); console.error(`FAIL ${item.name}\n${error.stack}`); }
  }
  if (item.defect) {
    const targetedMutation = typeof item.defect === "function";
    try {
      await item.run(targetedMutation ? makeHarness(false, item.defect) : makeHarness(true));
      failures.push({ name: item.name, error: new Error("Historical regression was not reproduced") });
      console.error(`FAIL historical control unexpectedly passed: ${item.name}`);
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) {
        failures.push({ name: item.name, error });
        console.error(`FAIL historical harness failed for wrong reason: ${item.name}\n${error.stack}`);
      } else { controls += 1; console.log(`CONTROL reproduced: ${item.name} (${error.message.split("\n")[0]})`); }
    }
  }
}
console.log(`Novel import verification: ${passed} current-source scenarios passed; ${controls} regression controls reproduced; ${failures.length} failures.`);
if (failures.length) process.exitCode = 1;
