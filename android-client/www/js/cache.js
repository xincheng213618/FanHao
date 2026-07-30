import { CLIENT_VERSION } from "./config.js?v=20260730-fanhao-work-detail-ui-46";

const DB_NAME = "fanhao-android-cache";
const DB_VERSION = 2;
const RESPONSE_STORE = "responses";
const IMAGE_STORE = "images";
const RESPONSE_CACHE_VERSION = `responses:${CLIENT_VERSION}`;
const MAX_CACHED_RESPONSE_BYTES = 30 * 1024 * 1024;
const RESPONSE_CACHE_MAX_BYTES = 120 * 1024 * 1024;
const RESPONSE_CACHE_MAX_ENTRIES = 600;
const MAX_CACHED_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_CACHE_MAX_BYTES = 250 * 1024 * 1024;
const IMAGE_CACHE_MAX_ENTRIES = 2500;
const CACHE_OPEN_TIMEOUT_MS = 1600;

let dbPromise = null;
let responseTrimPromise = null;
let imageTrimPromise = null;
let staleResponsePrunePromise = null;

export async function readCachedJson(baseUrl, path) {
  const db = await openCacheDb();
  const entry = await requestToPromise(db.transaction(RESPONSE_STORE, "readonly").objectStore(RESPONSE_STORE).get(cacheKey(baseUrl, path)));
  if (!entry || !entry.payload || !isCurrentResponseCache(entry)) return null;
  touchCachedResponse(entry).catch(() => {});
  return entry;
}

export async function writeCachedJson(baseUrl, path, payload) {
  const db = await openCacheDb();
  const entry = {
    key: cacheKey(baseUrl, path),
    baseUrl: normalizeBaseUrl(baseUrl),
    path,
    version: RESPONSE_CACHE_VERSION,
    payload,
    accessedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  entry.bytes = estimateEntrySize(entry);
  if (entry.bytes > MAX_CACHED_RESPONSE_BYTES) return null;

  await requestToPromise(db.transaction(RESPONSE_STORE, "readwrite").objectStore(RESPONSE_STORE).put(entry));
  scheduleResponseCacheTrim().catch(() => {});
  return entry;
}

export async function readCachedImage(url, options = {}) {
  const db = await openCacheDb();
  const entry = await requestToPromise(db.transaction(IMAGE_STORE, "readonly").objectStore(IMAGE_STORE).get(imageCacheKey(url)));
  if (!entry || !entry.blob) return null;
  touchCachedImage(entry, options).catch(() => {});
  return entry;
}

export async function writeCachedImage(url, blob, options = {}) {
  if (!blob || !blob.size || blob.size > MAX_CACHED_IMAGE_BYTES) return null;

  const db = await openCacheDb();
  const entry = {
    key: imageCacheKey(url),
    baseUrl: normalizeBaseUrl(options.baseUrl) || imageBaseUrl(url),
    url: normalizeImageUrl(url),
    blob,
    mime: blob.type || "image/jpeg",
    bytes: blob.size,
    accessedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await requestToPromise(db.transaction(IMAGE_STORE, "readwrite").objectStore(IMAGE_STORE).put(entry));
  scheduleImageCacheTrim().catch(() => {});
  return entry;
}

export async function getCacheStats(baseUrl = "") {
  const db = await openCacheDb();
  const entries = await requestToPromise(db.transaction(RESPONSE_STORE, "readonly").objectStore(RESPONSE_STORE).getAll());
  const images = db.objectStoreNames.contains(IMAGE_STORE)
    ? await requestToPromise(db.transaction(IMAGE_STORE, "readonly").objectStore(IMAGE_STORE).getAll())
    : [];
  const normalizedBase = baseUrl ? normalizeBaseUrl(baseUrl) : "";
  const visibleEntries = normalizedBase
    ? entries.filter((entry) => entry.baseUrl === normalizedBase && isCurrentResponseCache(entry))
    : entries.filter(isCurrentResponseCache);
  const visibleImages = normalizedBase
    ? images.filter((entry) => entry.baseUrl === normalizedBase)
    : images;
  const visibleAll = [...visibleEntries, ...visibleImages];
  const latest = visibleAll.reduce((value, entry) => {
    if (!entry.updatedAt) return value;
    return !value || entry.updatedAt > value ? entry.updatedAt : value;
  }, "");

  return {
    count: visibleEntries.length + visibleImages.length,
    responseCount: visibleEntries.length,
    imageCount: visibleImages.length,
    responseBytes: visibleEntries.reduce((sum, entry) => sum + responseEntryBytes(entry), 0),
    imageBytes: visibleImages.reduce((sum, entry) => sum + Number(entry.bytes || entry.blob?.size || 0), 0),
    bytes: visibleEntries.reduce((sum, entry) => sum + responseEntryBytes(entry), 0) +
      visibleImages.reduce((sum, entry) => sum + Number(entry.bytes || entry.blob?.size || 0), 0),
    latestUpdatedAt: latest
  };
}

export async function clearCachedData(baseUrl = "") {
  const db = await openCacheDb();
  const normalizedBase = baseUrl ? normalizeBaseUrl(baseUrl) : "";
  if (!normalizedBase) {
    await requestToPromise(db.transaction(RESPONSE_STORE, "readwrite").objectStore(RESPONSE_STORE).clear());
    if (db.objectStoreNames.contains(IMAGE_STORE)) {
      await requestToPromise(db.transaction(IMAGE_STORE, "readwrite").objectStore(IMAGE_STORE).clear());
    }
    return;
  }

  await deleteByBaseUrl(db, RESPONSE_STORE, normalizedBase);
  if (db.objectStoreNames.contains(IMAGE_STORE)) await deleteByBaseUrl(db, IMAGE_STORE, normalizedBase);
}

export async function clearCachedJson(baseUrl = "") {
  return clearCachedData(baseUrl);
}

export function cacheAgeText(updatedAt) {
  if (!updatedAt) return "上次缓存";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "上次缓存";

  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff >= 0 && diff < minute) return "刚刚";
  if (diff >= 0 && diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;
  if (diff >= 0 && diff < day) return `${Math.max(1, Math.floor(diff / hour))} 小时前`;
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function openCacheDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("当前环境不支持本地缓存"));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const timer = window.setTimeout(() => {
      fail(new Error("本地缓存暂时不可用"));
    }, CACHE_OPEN_TIMEOUT_MS);

    const finish = (callback) => {
      if (settled) return false;
      settled = true;
      window.clearTimeout(timer);
      callback();
      return true;
    };

    const fail = (error) => {
      finish(() => {
        dbPromise = null;
        reject(error || new Error("本地缓存打开失败"));
      });
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RESPONSE_STORE)) {
        const store = db.createObjectStore(RESPONSE_STORE, { keyPath: "key" });
        store.createIndex("baseUrl", "baseUrl", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        const store = db.createObjectStore(IMAGE_STORE, { keyPath: "key" });
        store.createIndex("baseUrl", "baseUrl", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      finish(() => {
        scheduleStaleResponsePrune(request.result).catch(() => {});
        resolve(request.result);
      }) || request.result?.close?.();
    };
    request.onerror = () => fail(request.error || new Error("本地缓存打开失败"));
    request.onblocked = () => fail(new Error("本地缓存升级被占用"));
  });

  return dbPromise;
}

function cacheKey(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)} ${RESPONSE_CACHE_VERSION} ${path}`;
}

function isCurrentResponseCache(entry) {
  return entry?.version === RESPONSE_CACHE_VERSION || String(entry?.key || "").includes(` ${RESPONSE_CACHE_VERSION} `);
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function imageCacheKey(url) {
  return normalizeImageUrl(url);
}

function normalizeImageUrl(url) {
  return String(url || "").trim();
}

function imageBaseUrl(url) {
  try {
    const parsed = new URL(url);
    return normalizeBaseUrl(parsed.origin);
  } catch {
    return "";
  }
}

async function deleteByBaseUrl(db, storeName, normalizedBase) {
  const transaction = db.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);
  const entries = await requestToPromise(store.index("baseUrl").getAllKeys(normalizedBase));
  await Promise.all(entries.map((key) => requestToPromise(store.delete(key))));
}

async function touchCachedResponse(entry) {
  if (!entry?.key) return;
  const db = await openCacheDb();
  await requestToPromise(
    db.transaction(RESPONSE_STORE, "readwrite").objectStore(RESPONSE_STORE).put({
      ...entry,
      accessedAt: new Date().toISOString(),
      version: RESPONSE_CACHE_VERSION,
      bytes: responseEntryBytes(entry)
    })
  );
}

function scheduleStaleResponsePrune(db) {
  if (staleResponsePrunePromise) return staleResponsePrunePromise;
  staleResponsePrunePromise = pruneStaleResponseCache(db).finally(() => {
    staleResponsePrunePromise = null;
  });
  return staleResponsePrunePromise;
}

async function pruneStaleResponseCache(db) {
  if (!db?.objectStoreNames?.contains(RESPONSE_STORE)) return;
  const rows = await requestToPromise(db.transaction(RESPONSE_STORE, "readonly").objectStore(RESPONSE_STORE).getAll());
  const staleKeys = rows
    .filter((entry) => entry?.key && !isCurrentResponseCache(entry))
    .map((entry) => entry.key);
  if (!staleKeys.length) return;

  const transaction = db.transaction(RESPONSE_STORE, "readwrite");
  const store = transaction.objectStore(RESPONSE_STORE);
  await Promise.all(staleKeys.map((key) => requestToPromise(store.delete(key))));
}

function scheduleResponseCacheTrim() {
  if (responseTrimPromise) return responseTrimPromise;
  responseTrimPromise = trimResponseCache().finally(() => {
    responseTrimPromise = null;
  });
  return responseTrimPromise;
}

async function trimResponseCache() {
  const db = await openCacheDb();
  const rows = await requestToPromise(db.transaction(RESPONSE_STORE, "readonly").objectStore(RESPONSE_STORE).getAll());
  const totalBytes = rows.reduce((sum, row) => sum + responseEntryBytes(row), 0);
  if (rows.length <= RESPONSE_CACHE_MAX_ENTRIES && totalBytes <= RESPONSE_CACHE_MAX_BYTES) return;

  const sorted = rows.sort((a, b) => String(b.accessedAt || b.updatedAt || "").localeCompare(String(a.accessedAt || a.updatedAt || "")));
  let keptCount = 0;
  let keptBytes = 0;
  const deleteKeys = [];

  for (const row of sorted) {
    const bytes = responseEntryBytes(row);
    keptCount += 1;
    keptBytes += bytes;
    if (keptCount > RESPONSE_CACHE_MAX_ENTRIES || keptBytes > RESPONSE_CACHE_MAX_BYTES) {
      deleteKeys.push(row.key);
    }
  }

  if (!deleteKeys.length) return;
  const transaction = db.transaction(RESPONSE_STORE, "readwrite");
  const store = transaction.objectStore(RESPONSE_STORE);
  await Promise.all(deleteKeys.map((key) => requestToPromise(store.delete(key))));
}

async function touchCachedImage(entry, options = {}) {
  if (!entry?.key) return;
  const db = await openCacheDb();
  await requestToPromise(
    db.transaction(IMAGE_STORE, "readwrite").objectStore(IMAGE_STORE).put({
      ...entry,
      baseUrl: normalizeBaseUrl(options.baseUrl) || entry.baseUrl || imageBaseUrl(entry.url || entry.key),
      accessedAt: new Date().toISOString()
    })
  );
}

function scheduleImageCacheTrim() {
  if (imageTrimPromise) return imageTrimPromise;
  imageTrimPromise = trimImageCache().finally(() => {
    imageTrimPromise = null;
  });
  return imageTrimPromise;
}

async function trimImageCache() {
  const db = await openCacheDb();
  if (!db.objectStoreNames.contains(IMAGE_STORE)) return;

  const rows = await requestToPromise(db.transaction(IMAGE_STORE, "readonly").objectStore(IMAGE_STORE).getAll());
  const totalBytes = rows.reduce((sum, row) => sum + imageEntryBytes(row), 0);
  if (rows.length <= IMAGE_CACHE_MAX_ENTRIES && totalBytes <= IMAGE_CACHE_MAX_BYTES) return;

  const sorted = rows.sort((a, b) => String(b.accessedAt || b.updatedAt || "").localeCompare(String(a.accessedAt || a.updatedAt || "")));
  let keptCount = 0;
  let keptBytes = 0;
  const deleteKeys = [];

  for (const row of sorted) {
    const bytes = imageEntryBytes(row);
    keptCount += 1;
    keptBytes += bytes;
    if (keptCount > IMAGE_CACHE_MAX_ENTRIES || keptBytes > IMAGE_CACHE_MAX_BYTES) {
      deleteKeys.push(row.key);
    }
  }

  if (!deleteKeys.length) return;
  const transaction = db.transaction(IMAGE_STORE, "readwrite");
  const store = transaction.objectStore(IMAGE_STORE);
  await Promise.all(deleteKeys.map((key) => requestToPromise(store.delete(key))));
}

function imageEntryBytes(entry) {
  return Number(entry?.bytes || entry?.blob?.size || 0);
}

function responseEntryBytes(entry) {
  return Number(entry?.bytes || estimateEntrySize(entry));
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地缓存读写失败"));
  });
}

function estimateEntrySize(entry) {
  try {
    return new Blob([JSON.stringify(entry)]).size;
  } catch {
    return JSON.stringify(entry).length;
  }
}







