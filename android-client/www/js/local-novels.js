import { reconcileLocalNovelEntry, safeLocalProgressRecovery } from "./novel-chapter-identity.js?v=20260830-novel-chapters-75";

const LOCAL_NOVEL_DB_NAME = "fanhao-local-novels";
const LOCAL_NOVEL_DB_VERSION = 3;
const LEGACY_BOOK_STORE = "books";
const BOOK_STORE = "bookMetadata";
const CHAPTER_STORE = "chapterMetadata";
const BODY_STORE = "chapterBodies";
const PROGRESS_STORE = "readingProgress";
const EXTRAS_STORE = "bookExtras";
const CONTENT_STORES = [BOOK_STORE, CHAPTER_STORE, BODY_STORE, PROGRESS_STORE, EXTRAS_STORE];
const LOCAL_DB_OPEN_TIMEOUT_MS = 2000;
const LOCAL_DB_UPGRADE_IDLE_TIMEOUT_MS = 30000;
const BOOK_FIELDS = [
  "id", "local", "title", "author", "category", "fileName", "sourceType", "sourceBookId",
  "realm", "sourceRealm", "sizeBytes", "lastModified", "charCount", "chapterCount",
  "latestChapterTitle", "summary", "updatedAt", "cachedAt", "catalogRevision", "sourceCatalogRevision"
];
const CHAPTER_FIELDS = ["id", "bookId", "index", "title", "charCount", "updatedAt", "preamble", "sourceChapterId", "sourceCatalogRevision"];
const PROGRESS_FIELDS = ["chapterId", "chapterIndex", "scrollRatio", "catalogRevision", "updatedAt"];
const ENTRY_FIELDS = ["id", "book", "chapters", "createdAt", "updatedAt", "bytes", "generation", "catalogRevision"];

let localNovelDbPromise = null;
let generationSequence = 0;

// Summary/catalog APIs never retrieve legacy records, chapter bodies or extras.
export async function loadLocalNovelSummaries() {
  const db = await openLocalNovelDb();
  return runTransaction(db, [BOOK_STORE, PROGRESS_STORE], "readonly", (transaction, watch, setResult) => {
    collectRequests(watch, {
      books: transaction.objectStore(BOOK_STORE).getAll(),
      progress: transaction.objectStore(PROGRESS_STORE).getAll()
    }, (rows) => {
      const progress = new Map(rows.progress.map((row) => [row.id, row]));
      setResult(rows.books.map((row) => summaryFromRows(row, progress.get(row.id))).sort(compareSummaries));
    });
  });
}

export async function readLocalNovelSummary(bookId) {
  const id = String(bookId || "");
  if (!id) return null;
  const db = await openLocalNovelDb();
  return runTransaction(db, [BOOK_STORE, PROGRESS_STORE], "readonly", (transaction, watch, setResult) => {
    collectRequests(watch, {
      book: transaction.objectStore(BOOK_STORE).get(id),
      progress: transaction.objectStore(PROGRESS_STORE).get(id)
    }, (rows) => setResult(summaryFromRows(rows.book, rows.progress)));
  });
}

export async function readLocalNovelCatalog(bookId) {
  const id = String(bookId || "");
  if (!id) return null;
  const db = await openLocalNovelDb();
  return runTransaction(db, [BOOK_STORE, CHAPTER_STORE, PROGRESS_STORE], "readonly", (transaction, watch, setResult) => {
    collectRequests(watch, {
      book: transaction.objectStore(BOOK_STORE).get(id),
      progress: transaction.objectStore(PROGRESS_STORE).get(id),
      chapters: transaction.objectStore(CHAPTER_STORE).index("bookId").getAll(id)
    }, (rows) => {
      const summary = summaryFromRows(rows.book, rows.progress);
      setResult(summary ? { ...summary, chapters: catalogFromRows(rows.book, rows.chapters) } : null);
    });
  });
}

export async function readLocalNovelChapter(bookId, chapterIndex, { chapterId, catalogRevision } = {}) {
  const id = String(bookId || "");
  const index = Number(chapterIndex);
  if (!id || !Number.isInteger(index) || index < 1) return null;
  const db = await openLocalNovelDb();
  return runTransaction(db, [BOOK_STORE, CHAPTER_STORE, BODY_STORE, PROGRESS_STORE], "readonly", (transaction, watch, setResult) => {
    collectRequests(watch, {
      book: transaction.objectStore(BOOK_STORE).get(id),
      progress: transaction.objectStore(PROGRESS_STORE).get(id),
      chapters: transaction.objectStore(CHAPTER_STORE).index("bookId").getAll(id),
      body: transaction.objectStore(BODY_STORE).get([id, index])
    }, (rows) => {
      const summary = summaryFromRows(rows.book, rows.progress);
      if (!summary) { setResult(null); return; }
      const chapters = catalogFromRows(rows.book, rows.chapters);
      const position = chapters.findIndex((chapter) => chapter.index === index);
      if (position < 0 || !bodyMatches(rows.body, rows.book, chapters[position])
        || (chapterId !== undefined && chapters[position].id !== chapterId)
        || (catalogRevision !== undefined && summary.book.catalogRevision !== catalogRevision)) { setResult(null); return; }
      setResult({
        book: summary.book,
        chapter: { ...rows.body.extra, ...chapters[position], content: rows.body.content },
        chapters,
        prev: position > 0 ? chapters[position - 1] : null,
        next: position < chapters.length - 1 ? chapters[position + 1] : null,
        generation: summary.generation
      });
    });
  });
}

// Explicit whole-book compatibility only (export/reimport); no legacy fallback.
export async function readLocalNovelEntry(bookId) {
  const id = String(bookId || "");
  if (!id) return null;
  const db = await openLocalNovelDb();
  return runTransaction(db, CONTENT_STORES, "readonly", (transaction, watch, setResult) => {
    collectRequests(watch, {
      book: transaction.objectStore(BOOK_STORE).get(id),
      progress: transaction.objectStore(PROGRESS_STORE).get(id),
      chapters: transaction.objectStore(CHAPTER_STORE).index("bookId").getAll(id),
      bodies: transaction.objectStore(BODY_STORE).index("bookId").getAll(id),
      extras: transaction.objectStore(EXTRAS_STORE).get(id)
    }, (rows) => {
      setResult(entryFromRows(rows));
    });
  });
}

// Kept for old explicit callers; new list screens must use summaries above.
export async function loadLocalNovelEntries() {
  const summaries = await loadLocalNovelSummaries();
  const entries = [];
  for (const summary of summaries) {
    const entry = await readLocalNovelEntry(summary.id);
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function saveLocalNovelEntry(entry, { expectedGeneration } = {}) {
  const incoming = normalizeEntry(entry);
  await requestLocalStoragePersistence().catch(() => {});
  const db = await openLocalNovelDb();
  return runTransaction(db, CONTENT_STORES, "readwrite", (transaction, watch, setResult) => {
    collectRequests(watch, {
      book: transaction.objectStore(BOOK_STORE).get(incoming.book.id),
      progress: transaction.objectStore(PROGRESS_STORE).get(incoming.book.id),
      chapters: transaction.objectStore(CHAPTER_STORE).index("bookId").getAll(incoming.book.id),
      bodies: transaction.objectStore(BODY_STORE).index("bookId").getAll(incoming.book.id),
      extras: transaction.objectStore(EXTRAS_STORE).get(incoming.book.id)
    }, (rows) => {
      // Compare and reconcile the authoritative snapshot in this write transaction,
      // including progress that committed after the caller's explicit reimport read.
      if (expectedGeneration !== undefined && (rows.book?.generation ?? null) !== expectedGeneration) { setResult(null); return; }
      const existing = entryFromRows(rows);
      const prepared = prepareEntry(reconcileLocalNovelEntry(existing, incoming));
      for (const chapter of rows.chapters) transaction.objectStore(CHAPTER_STORE).delete([incoming.book.id, chapter.index]);
      for (const body of rows.bodies) transaction.objectStore(BODY_STORE).delete([incoming.book.id, body.index]);
      insertPreparedEntry(transaction, prepared);
      setResult(summaryFromRows(prepared.metadata, prepared.progress));
    });
  });
}

export async function saveLocalNovelProgress(bookId, progress = {}, { expectedGeneration } = {}) {
  const id = String(bookId || "");
  if (!id) return null;
  const db = await openLocalNovelDb();
  const chapterIndex = Number(progress.chapterIndex ?? progress.chapter_index);
  const scrollRatio = Number(progress.scrollRatio ?? progress.scroll_ratio ?? 0);
  const anchored = progress.chapterId !== undefined || progress.catalogRevision !== undefined;
  // An old ordinal-only caller needs the exact opened generation. Otherwise a
  // delayed write could silently attach its old ordinal to a replacement book.
  if (!anchored && (typeof expectedGeneration !== "string" || !expectedGeneration)) return null;
  if (!Number.isInteger(chapterIndex) || chapterIndex < 1 || !Number.isFinite(scrollRatio) || scrollRatio < 0 || scrollRatio > 1) return null;
  return runTransaction(db, [BOOK_STORE, CHAPTER_STORE, PROGRESS_STORE], "readwrite", (transaction, watch, setResult) => {
    watch(transaction.objectStore(BOOK_STORE).get(id), (metadata) => {
      if (!metadata || (expectedGeneration !== undefined && metadata.generation !== expectedGeneration)) {
        setResult(null); return;
      }
      if (anchored && (typeof progress.chapterId !== "string" || !progress.chapterId || progress.catalogRevision !== metadata.book.catalogRevision)) { setResult(null); return; }
      collectRequests(watch, {
        chapter: anchored ? transaction.objectStore(CHAPTER_STORE).index("chapterId").get([id, progress.chapterId]) : transaction.objectStore(CHAPTER_STORE).get([id, chapterIndex]),
        current: transaction.objectStore(PROGRESS_STORE).get(id)
      }, ({ chapter, current }) => {
        if (!chapter || chapter.index !== chapterIndex || chapter.generation !== metadata.generation
          || (!anchored && current?.recovery)) { setResult(null); return; }
        const updatedAt = new Date().toISOString();
        const row = { id, generation: metadata.generation, progress: { chapterId: chapter.id, chapterIndex, scrollRatio, catalogRevision: metadata.book.catalogRevision, updatedAt }, recovery: null };
        transaction.objectStore(PROGRESS_STORE).put(row);
        setResult(summaryFromRows(metadata, row));
      });
    });
  });
}

export async function deleteLocalNovelEntry(bookId) {
  const id = String(bookId || "");
  if (!id) return;
  const db = await openLocalNovelDb();
  return runTransaction(db, [...CONTENT_STORES, LEGACY_BOOK_STORE], "readwrite", (transaction, watch) => {
    collectRequests(watch, {
      chapters: transaction.objectStore(CHAPTER_STORE).index("bookId").getAllKeys(id),
      bodies: transaction.objectStore(BODY_STORE).index("bookId").getAllKeys(id)
    }, (keys) => {
      for (const key of keys.chapters) transaction.objectStore(CHAPTER_STORE).delete(key);
      for (const key of keys.bodies) transaction.objectStore(BODY_STORE).delete(key);
      for (const store of [BOOK_STORE, PROGRESS_STORE, EXTRAS_STORE, LEGACY_BOOK_STORE]) {
        transaction.objectStore(store).delete(id);
      }
    });
  });
}

// Explicit rescue only. In v2/v3, books is the pre-upgrade snapshot, not current
// content. These APIs never run migration, repair records or share the normal
// cached connection; even a missing database must remain missing.
export async function listLocalNovelRecoveryBooks({ afterKey, limit = 10, expectedVersion } = {}) {
  validateRecoveryVersion(expectedVersion, afterKey !== undefined);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw recoveryError("INVALID_ARGUMENT", "取回列表每页数量必须为 1 到 50");
  }
  let range;
  if (afterKey !== undefined) {
    try { range = IDBKeyRange.lowerBound(afterKey, true); }
    catch (error) { throw recoveryError("INVALID_ARGUMENT", "取回列表的分页位置无效", error); }
  }
  return runRecoveryRead(expectedVersion, (store, watch, setResult, version) => {
    const items = [];
    const request = store.openCursor(range);
    watch(request, (cursor) => {
      if (!cursor || items.length === limit) {
        const hasMore = Boolean(cursor);
        setResult({ version, source: "legacy-books", items, hasMore,
          nextKey: hasMore ? items[items.length - 1].key : null });
        return;
      }
      const metadata = recoveryMetadata(cursor.value);
      items.push({ key: cursor.primaryKey, ...metadata, exportable: metadata.readableChapters > 0 });
      cursor.continue();
    });
  });
}

export async function readLocalNovelRecoveryEntry(key, { expectedVersion } = {}) {
  validateRecoveryVersion(expectedVersion, true);
  try { IDBKeyRange.only(key); }
  catch (error) { throw recoveryError("INVALID_ARGUMENT", "要取回的旧书籍键无效", error); }
  return runRecoveryRead(expectedVersion, (store, watch, setResult, version) => {
    watch(store.get(key), (row) => {
      if (row === undefined) { setResult(null); return; }
      const metadata = recoveryMetadata(row);
      const chapters = [];
      for (const chapter of Array.isArray(row?.chapters) ? row.chapters : []) {
        if (!isRecoveryChapterReadable(chapter)) continue;
        // Preserve array order and original text. Invalid identity/ordinal data
        // cannot prevent a user from retrieving readable text, nor is it repaired.
        chapters.push({
          title: typeof chapter.title === "string" ? chapter.title : "",
          content: chapter.content,
          ...(Number.isInteger(chapter.index) && chapter.index > 0 ? { index: chapter.index } : {}),
          ...(typeof chapter.preamble === "boolean" ? { preamble: chapter.preamble } : {})
        });
      }
      const { title, fileName, totalChapters, readableChapters, omittedChapters } = metadata;
      setResult({ version, source: "legacy-books", entry: { book: { title, fileName }, chapters },
        totalChapters, readableChapters, omittedChapters });
    });
  });
}

function isRecoveryChapterReadable(chapter) {
  return isRecord(chapter) && typeof chapter.content === "string" && /\S/.test(chapter.content);
}

function recoveryMetadata(row) {
  const book = isRecord(row?.book) ? row.book : {};
  const chapters = Array.isArray(row?.chapters) ? row.chapters : [];
  let readableChapters = 0;
  for (const chapter of chapters) if (isRecoveryChapterReadable(chapter)) readableChapters += 1;
  return {
    title: typeof book.title === "string" ? book.title : "未命名旧小说",
    fileName: typeof book.fileName === "string" ? book.fileName : "",
    totalChapters: chapters.length, readableChapters, omittedChapters: chapters.length - readableChapters
  };
}

function validateRecoveryVersion(version, required) {
  if ((required || version !== undefined) && ![1, 2, 3].includes(version)) {
    throw recoveryError("INVALID_ARGUMENT", "请先刷新旧小说取回列表，再选择书籍");
  }
}

function recoveryError(code, message, cause) {
  const error = new Error(message);
  error.code = "RECOVERY_" + code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function runRecoveryRead(expectedVersion, queue) {
  return new Promise((resolve, reject) => {
    let request, db, transaction, result, settled = false, timer = null;
    const clearTimer = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
    const close = () => { try { db?.close(); } catch {} };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      try { transaction?.abort(); } catch {}
      close();
      reject(error);
    };
    const armTimer = (delay) => {
      clearTimer();
      timer = window.setTimeout(() => fail(recoveryError("TIMEOUT", "旧小说取回读取超时，请稍后重试")), delay);
    };
    try {
      armTimer(LOCAL_DB_OPEN_TIMEOUT_MS);
      if (!window.indexedDB || typeof window.indexedDB.open !== "function") throw new Error("当前环境不支持本地小说库");
      // No version argument: open only the schema that already exists.
      request = window.indexedDB.open(LOCAL_NOVEL_DB_NAME);
    } catch (error) { fail(recoveryError("OPEN_FAILED", "无法打开旧小说库，请稍后重试", error)); return; }
  request.onupgradeneeded = (event) => {
      // Opening a missing database creates a versionchange transaction. Abort it
      // even after an earlier timeout so a late request cannot create anything.
      try { request.transaction.abort(); } catch {}
      db = request.result;
      if (settled) { close(); return; }
      fail(recoveryError("NOT_FOUND", "没有可取回的旧小说库"));
    };
    request.onerror = () => fail(recoveryError("OPEN_FAILED", "无法打开旧小说库，请稍后重试", request.error));
    request.onblocked = () => fail(recoveryError("OPEN_BLOCKED", "旧小说库被占用，请关闭其他页面后重试"));
    request.onsuccess = () => {
      db = request.result;
      if (settled) { close(); return; }
      if (![1, 2, 3].includes(db.version)) {
        fail(recoveryError("UNSUPPORTED_VERSION", "此小说库来自更新版本，当前版本不能取回")); return;
      }
      if (expectedVersion !== undefined && expectedVersion !== db.version) {
        fail(recoveryError("STALE_VERSION", "旧小说库版本已变化，请刷新取回列表")); return;
      }
      if (!db.objectStoreNames.contains(LEGACY_BOOK_STORE)) {
        fail(recoveryError("SCHEMA_UNAVAILABLE", "此小说库没有可取回的旧书籍副本")); return;
      }
      db.onversionchange = () => fail(recoveryError("VERSION_CHANGED", "小说库正在升级，请刷新取回列表"));
      db.onclose = () => fail(recoveryError("CONNECTION_CLOSED", "旧小说库连接已关闭，请重试"));
      const failRead = (error) => fail(recoveryError("READ_FAILED", "读取旧小说失败，请稍后重试", error));
      const watch = (readRequest, success) => {
        readRequest.onerror = () => failRead(readRequest.error);
        readRequest.onsuccess = () => {
          if (settled) return;
          try { armTimer(LOCAL_DB_UPGRADE_IDLE_TIMEOUT_MS); success(readRequest.result); }
          catch (error) { failRead(error); }
        };
      };
      try {
        armTimer(LOCAL_DB_UPGRADE_IDLE_TIMEOUT_MS);
        transaction = db.transaction([LEGACY_BOOK_STORE], "readonly");
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          clearTimer();
          close();
          resolve(result);
        };
        transaction.onabort = () => failRead(transaction.error);
        transaction.onerror = (event) => failRead(event?.target?.error || transaction.error);
        queue(transaction.objectStore(LEGACY_BOOK_STORE), watch, (value) => { result = value; }, db.version);
      } catch (error) { failRead(error); }
    };
  });
}

function openLocalNovelDb() {
  if (localNovelDbPromise) return localNovelDbPromise;
  let factory;
  try {
    factory = window.indexedDB;
    if (!factory || typeof factory.open !== "function") throw new Error("当前环境不支持本地小说库");
  } catch (error) { return Promise.reject(error); }

  let resolveOpen, rejectOpen;
  const promise = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  localNovelDbPromise = promise;
  let request, upgradeTransaction = null, settled = false, timer = null;
  const invalidate = () => { if (localNovelDbPromise === promise) localNovelDbPromise = null; };
  const clearTimer = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimer();
    invalidate();
    try { upgradeTransaction?.abort(); } catch {}
    rejectOpen(error || new Error("本地小说库打开失败"));
  };
  const armTimer = (delay) => {
    clearTimer();
    timer = window.setTimeout(() => fail(new Error("本地小说库暂时不可用，请稍后重试")), delay);
  };
  armTimer(LOCAL_DB_OPEN_TIMEOUT_MS);
  try { request = factory.open(LOCAL_NOVEL_DB_NAME, LOCAL_NOVEL_DB_VERSION); }
  catch (error) { fail(error); return promise; }

  request.onupgradeneeded = (event) => {
    upgradeTransaction = request.transaction;
    if (settled) { try { upgradeTransaction.abort(); } catch {} return; }
    armTimer(LOCAL_DB_UPGRADE_IDLE_TIMEOUT_MS);
    const db = request.result;
    const guard = (action) => {
      if (settled) return;
      try { action(); } catch (error) { fail(error); }
    };
    upgradeTransaction.onerror = (event) => fail(event?.target?.error || upgradeTransaction.error || new Error("本地小说库升级失败"));
    upgradeTransaction.onabort = () => fail(upgradeTransaction.error || new Error("本地小说库升级已取消"));
    guard(() => {
      if (!db.objectStoreNames.contains(LEGACY_BOOK_STORE)) {
        const legacy = db.createObjectStore(LEGACY_BOOK_STORE, { keyPath: "id" });
        legacy.createIndex("updatedAt", "updatedAt", { unique: false });
        legacy.createIndex("title", "book.title", { unique: false });
      }
      for (const name of [BOOK_STORE, PROGRESS_STORE, EXTRAS_STORE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
      for (const name of [CHAPTER_STORE, BODY_STORE]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: ["bookId", "index"] }).createIndex("bookId", "bookId", { unique: false });
        }
      }
      const legacyWholeBook = event.oldVersion < 2;
      const cursorRequest = upgradeTransaction.objectStore(legacyWholeBook ? LEGACY_BOOK_STORE : BOOK_STORE).openCursor();
      cursorRequest.onerror = () => fail(cursorRequest.error || new Error("读取旧小说库失败"));
      const upgradeWatch = (readRequest, success) => {
        readRequest.onerror = () => fail(readRequest.error || new Error("读取升级快照失败"));
        readRequest.onsuccess = () => guard(() => { armTimer(LOCAL_DB_UPGRADE_IDLE_TIMEOUT_MS); success(readRequest.result); });
      };
      cursorRequest.onsuccess = () => guard(() => {
        armTimer(LOCAL_DB_UPGRADE_IDLE_TIMEOUT_MS);
        const cursor = cursorRequest.result;
        if (!cursor) {
          const chapters = upgradeTransaction.objectStore(CHAPTER_STORE);
          if (!chapters.indexNames.contains("chapterId")) chapters.createIndex("chapterId", ["bookId", "id"], { unique: true });
          return;
        }
        const migrate = (entry) => {
          const normalized = normalizeEntry(entry, { migration: true });
          const prepared = prepareEntry(reconcileLocalNovelEntry(null, normalized, { legacySnapshot: true }), { migration: true });
          if (cursor.primaryKey !== prepared.metadata.id) throw new Error("旧小说库的书籍 ID 不一致，升级已取消");
          // Original books rows remain untouched. v2 upgrades read CURRENT layered
          // stores, never overwrite them with the older rescue copy in books.
          insertPreparedEntry(upgradeTransaction, prepared);
          cursor.continue();
        };
        if (legacyWholeBook) { migrate(cursor.value); return; }
        const id = cursor.primaryKey;
        collectRequests(upgradeWatch, {
          progress: upgradeTransaction.objectStore(PROGRESS_STORE).get(id),
          chapters: upgradeTransaction.objectStore(CHAPTER_STORE).index("bookId").getAll(id),
          bodies: upgradeTransaction.objectStore(BODY_STORE).index("bookId").getAll(id),
          extras: upgradeTransaction.objectStore(EXTRAS_STORE).get(id)
        }, rows => migrate(entryFromRows({ ...rows, book: cursor.value }, { legacy: true })));
      });
    });
  };
  request.onsuccess = () => {
    const db = request.result;
    if (settled) { db.close(); return; }
    settled = true;
    clearTimer();
    db.onversionchange = () => { invalidate(); db.close(); };
    db.onclose = () => invalidate();
    resolveOpen(db);
  };
  request.onerror = () => fail(request.error || new Error("本地小说库打开失败"));
  request.onblocked = () => fail(new Error("本地小说库升级被占用，请关闭其他页面后重试"));
  return promise;
}

async function requestLocalStoragePersistence() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

function newGeneration() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === "function") {
    return Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join("-");
  }
  generationSequence += 1;
  return Date.now().toString(36) + "-" + generationSequence.toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extraFields(value, fields) {
  const known = new Set(fields);
  return Object.fromEntries(Object.entries(value).filter(([field]) => !known.has(field)));
}

function lightweightFields(value, fields) {
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value, field) && (value[field] == null || ["string", "number", "boolean"].includes(typeof value[field])))
    .map((field) => [field, value[field]]));
}

function normalizeEntry(entry, { migration = false } = {}) {
  if (!isRecord(entry) || !isRecord(entry.book) || typeof entry.book.id !== "string" || !entry.book.id.trim()) {
    throw new Error("本地小说缺少 ID");
  }
  const id = entry.book.id;
  if (entry.id != null && entry.id !== id) throw new Error("本地小说的书籍 ID 不一致");
  if (!Array.isArray(entry.chapters) || !entry.chapters.length) throw new Error("本地小说目录损坏，无法保存或升级");
  const indices = new Set();
  const chapters = entry.chapters.map((input, ordinal) => {
    if (!isRecord(input) || typeof input.content !== "string" || !input.content.trim()) {
      throw new Error("本地小说章节正文损坏，无法保存或升级");
    }
    if (input.bookId != null && input.bookId !== id) throw new Error("本地小说章节不属于这本书");
    const originalIndex = input.index ?? input.chapterIndex;
    const index = Number(originalIndex ?? (migration ? NaN : ordinal + 1));
    if (!Number.isInteger(index) || index < 1 || indices.has(index)) throw new Error("本地小说章节序号无效或重复");
    indices.add(index);
    return { ...input, bookId: id, index, title: String(input.title || "正文 " + index).trim() };
  }).sort((a, b) => a.index - b.index);
  return { ...entry, book: { ...entry.book }, chapters };
}

function prepareEntry(entry, { migration = false } = {}) {
  const normalized = normalizeEntry(entry, { migration });
  const id = normalized.book.id, now = new Date().toISOString(), generation = newGeneration();
  if (typeof entry.book.catalogRevision !== "string" || !entry.book.catalogRevision) throw new Error("本地小说缺少目录版本");
  const ids = new Set();
  const chapters = normalized.chapters.map(input => {
    if (typeof input.id !== "string" || !input.id || ids.has(input.id)) throw new Error("本地小说章节身份无效或重复");
    ids.add(input.id);
    const index = input.index;
    return {
      input,
      metadata: {
        ...lightweightFields(input, CHAPTER_FIELDS),
        id: input.id,
        bookId: id, index, title: String(input.title || "正文 " + index).trim(),
        charCount: Number(input.charCount || input.content.length || 0),
        updatedAt: input.updatedAt || entry.updatedAt || now,
        ...(typeof input.preamble === "boolean" ? { preamble: input.preamble } : {}),
        generation
      }
    };
  }).sort((a, b) => a.metadata.index - b.metadata.index);
  const display = lightweightFields(entry.book, BOOK_FIELDS);
  const book = {
    ...display,
    id, local: true, category: display.category || "本机", author: display.author || "本机文件",
    chapterCount: chapters.length,
    charCount: chapters.reduce((sum, chapter) => sum + chapter.metadata.charCount, 0),
    latestChapterTitle: display.latestChapterTitle || chapters[chapters.length - 1].metadata.title || "正文",
    updatedAt: display.updatedAt || (typeof entry.updatedAt === "string" ? entry.updatedAt : now)
  };
  const oldProgress = isRecord(entry.book.progress) ? entry.book.progress : {};
  const progress = { id, generation, progress: Object.keys(oldProgress).length ? { ...lightweightFields(oldProgress, PROGRESS_FIELDS), updatedAt: typeof oldProgress.updatedAt === "string" ? oldProgress.updatedAt : now } : null,
    recovery: safeLocalProgressRecovery(entry.book.progressRecovery) };
  const metadata = {
    id, book, generation,
    createdAt: entry.createdAt || book.updatedAt || now,
    updatedAt: migration ? entry.updatedAt || book.updatedAt || now : now,
    bytes: migration && Number(entry.bytes) > 0 ? Number(entry.bytes) : estimateContentBytes(chapters)
  };
  const bookExtras = extraFields(entry.book, [...BOOK_FIELDS, "progress", "progressRecovery", "sourceProgress", "sourceProgressRecovery", "localGeneration"]);
  // Non-scalar values in a known display field also stay isolated, never lost.
  for (const field of BOOK_FIELDS) {
    if (Object.hasOwn(entry.book, field) && !Object.hasOwn(lightweightFields(entry.book, [field]), field)) bookExtras[field] = entry.book[field];
  }
  return {
    metadata, progress,
    chapters: chapters.map(({ metadata: chapter }) => chapter),
    bodies: chapters.map(({ input, metadata: chapter }) => ({
      bookId: id, index: chapter.index, chapterId: chapter.id, generation, content: input.content,
      extra: extraFields(input, [...CHAPTER_FIELDS, "content", "generation"])
    })),
    extras: {
      id, generation, entry: extraFields(entry, ENTRY_FIELDS), book: bookExtras,
      hasProgress: Object.hasOwn(entry.book, "progress"),
      progress: extraFields(oldProgress, PROGRESS_FIELDS)
    }
  };
}

function estimateContentBytes(chapters) {
  return chapters.reduce((sum, chapter) => {
    try { return sum + new Blob([chapter.input.content]).size; }
    catch { return sum + chapter.input.content.length * 2; }
  }, 0);
}

function insertPreparedEntry(transaction, prepared) {
  transaction.objectStore(BOOK_STORE).put(prepared.metadata);
  transaction.objectStore(PROGRESS_STORE).put(prepared.progress);
  transaction.objectStore(EXTRAS_STORE).put(prepared.extras);
  for (const chapter of prepared.chapters) transaction.objectStore(CHAPTER_STORE).put(chapter);
  for (const body of prepared.bodies) transaction.objectStore(BODY_STORE).put(body);
}

function summaryFromRows(metadata, progressRow) {
  if (!metadata) return null;
  if (!metadata.book || metadata.id !== metadata.book.id || typeof metadata.generation !== "string" || !metadata.generation
    || typeof metadata.book.catalogRevision !== "string" || !metadata.book.catalogRevision) {
    throw new Error("本地小说摘要损坏，请重新导入");
  }
  const matching = progressRow?.generation === metadata.generation;
  const progress = matching && progressRow.progress ? lightweightFields(progressRow.progress, PROGRESS_FIELDS) : null;
  const recovery = matching ? safeLocalProgressRecovery(progressRow.recovery) : null;
  if (progress && (typeof progress.chapterId !== "string" || !progress.chapterId || progress.catalogRevision !== metadata.book.catalogRevision
    || !Number.isInteger(progress.chapterIndex) || progress.chapterIndex < 1 || typeof progress.scrollRatio !== "number"
    || !Number.isFinite(progress.scrollRatio) || progress.scrollRatio < 0 || progress.scrollRatio > 1 || recovery)) throw new Error("本地小说阅读位置损坏，请重新读取");
  const book = { ...lightweightFields(metadata.book, BOOK_FIELDS), localGeneration: metadata.generation, progress, progressRecovery: recovery };
  return {
    id: metadata.id, book, generation: metadata.generation,
    createdAt: metadata.createdAt, updatedAt: progress?.updatedAt || metadata.updatedAt,
    bytes: metadata.bytes
  };
}

function catalogFromRows(metadata, rows, { legacy = false } = {}) {
  if (rows.length !== metadata.book.chapterCount || rows.some((row) => row.bookId !== metadata.id || row.generation !== metadata.generation)
    || (!legacy && (rows.some(row => typeof row.id !== "string" || !row.id) || new Set(rows.map(row => row.id)).size !== rows.length))) {
    throw new Error("本地小说目录不完整，请重新导入");
  }
  return rows.map((row) => lightweightFields(row, CHAPTER_FIELDS)).sort((a, b) => a.index - b.index);
}

function bodyMatches(body, metadata, chapter, { legacy = false } = {}) {
  return Boolean(body && body.bookId === metadata.id && body.index === chapter.index &&
    body.generation === metadata.generation && typeof body.content === "string" && (legacy || body.chapterId === chapter.id));
}

function entryFromRows(rows, { legacy = false } = {}) {
  if (!rows.book) return null;
  const metadata = rows.book;
  if (!metadata.book || metadata.id !== metadata.book.id || typeof metadata.generation !== "string" || !metadata.generation) throw new Error("本地小说摘要损坏，请重新导入");
  const summary = legacy ? { id: metadata.id, book: { ...metadata.book }, generation: metadata.generation,
    createdAt: metadata.createdAt, updatedAt: metadata.updatedAt, bytes: metadata.bytes } : summaryFromRows(metadata, rows.progress);
  const catalog = catalogFromRows(metadata, rows.chapters, { legacy });
  if (!rows.extras || rows.extras.generation !== summary.generation || rows.bodies.length !== catalog.length) throw new Error("本地小说内容不完整，请重新导入");
  const bodies = new Map(rows.bodies.map(body => [body.index, body]));
  const chapters = catalog.map(chapter => {
    const body = bodies.get(chapter.index);
    if (!bodyMatches(body, metadata, chapter, { legacy })) throw new Error("本地小说章节不完整，请重新导入");
    return { ...body.extra, ...chapter, content: body.content };
  });
  // Extras cannot override the authoritative resolved/recovery state.
  const book = { ...rows.extras.book, ...summary.book, id: summary.id, local: true, localGeneration: summary.generation };
  if (legacy) book.progress = rows.progress?.generation === metadata.generation ? rows.progress.progress : null;
  return { ...rows.extras.entry, ...summary, book, chapters };
}

function compareSummaries(a, b) {
  return String(b.book.progress?.updatedAt || b.book.updatedAt || "").localeCompare(String(a.book.progress?.updatedAt || a.book.updatedAt || ""));
}

function collectRequests(watch, requests, complete) {
  const entries = Object.entries(requests);
  const values = {};
  let remaining = entries.length;
  if (!remaining) { complete(values); return; }
  for (const [name, request] of entries) {
    watch(request, (value) => {
      values[name] = value;
      remaining -= 1;
      if (!remaining) complete(values);
    });
  }
}

function runTransaction(db, stores, mode, queue) {
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = db.transaction(stores, mode); }
    catch (error) { reject(error); return; }
    let result, failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      reject(error || transaction.error || new Error("本地小说库读写失败"));
      try { transaction.abort(); } catch {}
    };
    const guard = (action) => {
      if (failed) return;
      try { action(); } catch (error) { fail(error); }
    };
    const watch = (request, success) => {
      request.onerror = () => fail(request.error || new Error("本地小说库读写失败"));
      request.onsuccess = () => guard(() => success(request.result));
    };
    transaction.oncomplete = () => { if (!failed) resolve(result); };
    transaction.onabort = (event) => fail(event?.target?.error || transaction.error || new Error("本地小说库读写失败"));
    transaction.onerror = (event) => fail(event?.target?.error || transaction.error || new Error("本地小说库读写失败"));
    guard(() => queue(transaction, watch, (value) => { result = value; }));
  });
}
