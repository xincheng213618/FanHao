const LOCAL_NOVEL_DB_NAME = "fanhao-local-novels";
const LOCAL_NOVEL_DB_VERSION = 1;
const LOCAL_NOVEL_STORE = "books";
const LOCAL_DB_OPEN_TIMEOUT_MS = 2000;

let localNovelDbPromise = null;

export async function loadLocalNovelEntries() {
  const db = await openLocalNovelDb();
  const rows = await requestToPromise(db.transaction(LOCAL_NOVEL_STORE, "readonly").objectStore(LOCAL_NOVEL_STORE).getAll());
  return rows
    .map(normalizeLocalNovelEntry)
    .filter(Boolean)
    .sort((a, b) => String(b.book.progress?.updatedAt || b.book.updatedAt || "").localeCompare(String(a.book.progress?.updatedAt || a.book.updatedAt || "")));
}

export async function readLocalNovelEntry(bookId) {
  const id = String(bookId || "");
  if (!id) return null;
  const db = await openLocalNovelDb();
  const row = await requestToPromise(db.transaction(LOCAL_NOVEL_STORE, "readonly").objectStore(LOCAL_NOVEL_STORE).get(id));
  return normalizeLocalNovelEntry(row);
}

export async function saveLocalNovelEntry(entry) {
  const normalized = normalizeLocalNovelEntry(entry);
  if (!normalized?.book?.id) throw new Error("本地小说缺少 ID");
  await requestLocalStoragePersistence().catch(() => {});
  const now = new Date().toISOString();
  const db = await openLocalNovelDb();
  const row = {
    ...normalized,
    id: normalized.book.id,
    createdAt: normalized.createdAt || now,
    updatedAt: now
  };
  row.book = {
    ...row.book,
    local: true,
    updatedAt: row.book.updatedAt || now
  };
  row.bytes = estimateEntryBytes(row);
  await requestToPromise(db.transaction(LOCAL_NOVEL_STORE, "readwrite").objectStore(LOCAL_NOVEL_STORE).put(row));
  return normalizeLocalNovelEntry(row);
}

export async function saveLocalNovelProgress(bookId, progress = {}) {
  const entry = await readLocalNovelEntry(bookId);
  if (!entry) return null;
  const updatedAt = new Date().toISOString();
  entry.book.progress = {
    chapterIndex: Math.max(1, Number(progress.chapterIndex || progress.chapter_index || 1) || 1),
    scrollRatio: Math.max(0, Math.min(1, Number(progress.scrollRatio || progress.scroll_ratio || 0) || 0)),
    updatedAt
  };
  entry.updatedAt = updatedAt;
  entry.book.updatedAt = entry.book.updatedAt || updatedAt;
  return saveLocalNovelEntry(entry);
}

export async function deleteLocalNovelEntry(bookId) {
  const id = String(bookId || "");
  if (!id) return;
  const db = await openLocalNovelDb();
  await requestToPromise(db.transaction(LOCAL_NOVEL_STORE, "readwrite").objectStore(LOCAL_NOVEL_STORE).delete(id));
}

function openLocalNovelDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("当前环境不支持本地小说库"));
  if (localNovelDbPromise) return localNovelDbPromise;

  localNovelDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_NOVEL_DB_NAME, LOCAL_NOVEL_DB_VERSION);
    let settled = false;
    const timer = window.setTimeout(() => fail(new Error("本地小说库暂时不可用")), LOCAL_DB_OPEN_TIMEOUT_MS);

    const finish = (callback) => {
      if (settled) return false;
      settled = true;
      window.clearTimeout(timer);
      callback();
      return true;
    };

    const fail = (error) => {
      finish(() => {
        localNovelDbPromise = null;
        reject(error || new Error("本地小说库打开失败"));
      });
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_NOVEL_STORE)) {
        const store = db.createObjectStore(LOCAL_NOVEL_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("title", "book.title", { unique: false });
      }
    };
    request.onsuccess = () => {
      finish(() => resolve(request.result)) || request.result?.close?.();
    };
    request.onerror = () => fail(request.error || new Error("本地小说库打开失败"));
    request.onblocked = () => fail(new Error("本地小说库升级被占用"));
  });

  return localNovelDbPromise;
}

async function requestLocalStoragePersistence() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

function normalizeLocalNovelEntry(row) {
  if (!row?.book?.id) return null;
  const now = new Date().toISOString();
  const chapters = Array.isArray(row.chapters)
    ? row.chapters
        .map((chapter, index) => normalizeLocalChapter(chapter, row.book.id, index + 1, row.updatedAt || now))
        .filter(Boolean)
    : [];
  if (!chapters.length) return null;
  const charCount = chapters.reduce((sum, chapter) => sum + Number(chapter.charCount || 0), 0);
  const book = {
    ...row.book,
    id: String(row.book.id),
    local: true,
    category: row.book.category || "本机",
    author: row.book.author || "本机文件",
    chapterCount: chapters.length,
    charCount,
    latestChapterTitle: row.book.latestChapterTitle || chapters[chapters.length - 1]?.title || "正文",
    updatedAt: row.book.updatedAt || row.updatedAt || now
  };
  return {
    id: book.id,
    book,
    chapters,
    createdAt: row.createdAt || book.updatedAt || now,
    updatedAt: row.updatedAt || book.updatedAt || now,
    bytes: Number(row.bytes || 0)
  };
}

function normalizeLocalChapter(chapter, bookId, fallbackIndex, updatedAt) {
  const index = Math.max(1, Number(chapter?.index || chapter?.chapterIndex || fallbackIndex) || fallbackIndex);
  const content = String(chapter?.content || "");
  if (!content.trim()) return null;
  return {
    ...chapter,
    id: chapter?.id || `${bookId}-${String(index).padStart(5, "0")}`,
    bookId,
    index,
    title: String(chapter?.title || `正文 ${index}`).trim(),
    content,
    charCount: Number(chapter?.charCount || content.length || 0),
    updatedAt: chapter?.updatedAt || updatedAt
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地小说库读写失败"));
  });
}

function estimateEntryBytes(entry) {
  try {
    return new Blob([JSON.stringify(entry)]).size;
  } catch {
    return JSON.stringify(entry).length;
  }
}
