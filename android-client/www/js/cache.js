import { CLIENT_VERSION } from "./config.js?v=assets-1443708f18b1";
import { accountPayloadOwner, captureAccountOwner, confirmAccountOwner, isAccountOwnerCurrent, prepareAccountOwner, rememberAccountPayload } from "./account-owner.js";

const DB_NAME = "fanhao-android-cache";
const DB_VERSION = 3;
const RESPONSE_STORE = "responses";
const IMAGE_STORE = "images";
const CACHE_TRIM_INDEX = "trimMetadata";
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
const responseInvalidationState = globalThis.__fanhaoResponseCacheInvalidationState ||= {
  epoch: 0,
  baseGenerations: new Map()
};
const imageInvalidationState = globalThis.__fanhaoImageCacheInvalidationState ||= {
  epoch: 0,
  baseGenerations: new Map()
};

export async function readCachedJson(baseUrl, path) {
  await prepareAccountOwner(baseUrl);
  const fence = captureCachedJsonFence(baseUrl);
  if (fence.account.owner === "pending") return null;
  const db = await openCacheDb();
  const entry = await runCacheTransaction(
    db,
    RESPONSE_STORE,
    "readonly",
    (store) => requestToPromise(store.get(cacheKey(baseUrl, path, fence.account)))
  );
  if (!isCachedJsonFenceCurrent(fence) || !entry || !entry.payload || !isCurrentResponseCache(entry)) return null;
  touchCachedResponse(entry, fence).catch(() => {});
  rememberAccountPayload(entry.payload, fence.account);
  confirmAccountOwner(fence.account);
  return entry;
}

export async function writeCachedJson(baseUrl, path, payload, options = {}) {
  const payloadOwner = accountPayloadOwner(payload);
  if (payloadOwner && !isAccountOwnerCurrent(payloadOwner)) return null;
  const fence = options.fence || captureCachedJsonFence(baseUrl, payloadOwner || captureAccountOwner(baseUrl));
  if (fence.account.origin !== captureAccountOwner(baseUrl).origin) return null;
  // Cloned/merged responses lose their WeakMap provenance. Such callers must
  // capture a fence before their first await, rather than adopting a new login.
  if (!payloadOwner && !options.fence && (fence.account.owner !== "guest" || fence.account.revision > 0)) return null;
  if (fence.account.owner === "pending") return null;
  const db = await openCacheDb();
  if (!isCachedJsonFenceCurrent(fence)) return null;
  const entry = {
    key: cacheKey(baseUrl, path, fence.account),
    baseUrl: normalizeBaseUrl(baseUrl),
    path,
    accountOwner: fence.account.owner,
    version: RESPONSE_CACHE_VERSION,
    payload,
    accessedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  entry.bytes = estimateEntrySize(entry);
  if (entry.bytes > MAX_CACHED_RESPONSE_BYTES) return null;

  await runCacheTransaction(db, RESPONSE_STORE, "readwrite", (store) => requestToPromise(store.put(entry)));
  scheduleResponseCacheTrim().catch(() => {});
  return entry;
}

export async function readCachedImage(url, options = {}) {
  const fence = options.fence || captureCachedImageFence(url, options);
  if (fence.baseUrl !== imageCacheBaseUrl(url, options) || !isCachedImageFenceCurrent(fence)) return null;
  const db = await openCacheDb();
  const entry = await requestToPromise(db.transaction(IMAGE_STORE, "readonly").objectStore(IMAGE_STORE).get(imageCacheKey(url)));
  if (!isCachedImageFenceCurrent(fence) || !entry || !entry.blob) return null;
  touchCachedImage(entry, options, fence).catch(() => {});
  return entry;
}

export async function writeCachedImage(url, blob, options = {}) {
  if (!blob || !blob.size || blob.size > MAX_CACHED_IMAGE_BYTES) return null;
  const baseUrl = imageCacheBaseUrl(url, options);
  const fence = options.fence || captureCachedImageFence(url, options);
  if (fence.baseUrl !== baseUrl || !isCachedImageFenceCurrent(fence)) return null;
  const db = await openCacheDb();
  if (!isCachedImageFenceCurrent(fence)) return null;
  const entry = {
    key: imageCacheKey(url),
    baseUrl,
    url: normalizeImageUrl(url),
    blob,
    mime: blob.type || "image/jpeg",
    bytes: blob.size,
    accessedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await runCacheTransaction(db, IMAGE_STORE, "readwrite", (store) => requestToPromise(store.put(entry)));
  scheduleImageCacheTrim().catch(() => {});
  return entry;
}

export async function getCacheStats(baseUrl = "") {
  const db = await openCacheDb();
  const normalizedBase = baseUrl ? normalizeBaseUrl(baseUrl) : "";
  const responseStore = db.transaction(RESPONSE_STORE, "readonly").objectStore(RESPONSE_STORE);
  const entries = await requestToPromise(normalizedBase
    ? responseStore.index("baseUrl").getAll(normalizedBase)
    : responseStore.getAll());
  let images = [];
  if (db.objectStoreNames.contains(IMAGE_STORE)) {
    const imageStore = db.transaction(IMAGE_STORE, "readonly").objectStore(IMAGE_STORE);
    images = await requestToPromise(normalizedBase
      ? imageStore.index("baseUrl").getAll(normalizedBase)
      : imageStore.getAll());
  }
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
  await clearCachedResponses(baseUrl);
  await clearCachedImages(baseUrl);
}

export async function clearCachedResponses(baseUrl = "") {
  const normalizedBase = baseUrl ? normalizeBaseUrl(baseUrl) : "";
  invalidateCachedJsonWrites(normalizedBase);
  const db = await openCacheDb();
  if (!normalizedBase) {
    await runCacheTransaction(db, RESPONSE_STORE, "readwrite", (store) => requestToPromise(store.clear()));
    return;
  }

  await deleteByBaseUrl(db, RESPONSE_STORE, normalizedBase);
}

export async function clearCachedImages(baseUrl = "") {
  const normalizedBase = baseUrl ? normalizeBaseUrl(baseUrl) : "";
  if (!normalizedBase) {
    imageInvalidationState.epoch += 1;
    imageInvalidationState.baseGenerations.clear();
  } else {
    imageInvalidationState.baseGenerations.set(normalizedBase, (imageInvalidationState.baseGenerations.get(normalizedBase) || 0) + 1);
  }
  const db = await openCacheDb();
  if (!db.objectStoreNames.contains(IMAGE_STORE)) return;
  if (!normalizedBase) {
    await runCacheTransaction(db, IMAGE_STORE, "readwrite", (store) => requestToPromise(store.clear()));
    return;
  }

  if (db.objectStoreNames.contains(IMAGE_STORE)) await deleteByBaseUrl(db, IMAGE_STORE, normalizedBase);
}

export async function clearCachedJson(baseUrl = "") {
  return clearCachedData(baseUrl);
}

export async function clearCachedJsonByPrefix(baseUrl, pathPrefix, { accountScope = null } = {}) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedPrefix = String(pathPrefix || "").trim();
  if (!normalizedBase || !normalizedPrefix) return;
  if (accountScope && !isAccountOwnerCurrent(accountScope)) return;
  invalidateCachedJsonWrites(normalizedBase);
  const db = await openCacheDb();
  if (accountScope && !isAccountOwnerCurrent(accountScope)) return;
  await runCacheTransaction(db, RESPONSE_STORE, "readwrite", async (store) => {
    const entries = await requestToPromise(store.index("baseUrl").getAll(normalizedBase));
    if (accountScope && !isAccountOwnerCurrent(accountScope)) return;
    await Promise.all(
      entries
        .filter((entry) => String(entry?.path || "").startsWith(normalizedPrefix))
        .filter((entry) => !accountScope || (entry.accountOwner || "guest") === accountScope.owner)
        .map((entry) => requestToPromise(store.delete(entry.key)))
    );
  });
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

export function captureCachedJsonFence(baseUrl, account = captureAccountOwner(baseUrl)) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  return Object.freeze({
    baseUrl: normalizedBase,
    account,
    epoch: responseInvalidationState.epoch,
    generation: responseInvalidationState.baseGenerations.get(normalizedBase) || 0
  });
}

export function isCachedJsonFenceCurrent(fence) {
  if (!fence || typeof fence !== "object") return false;
  const normalizedBase = normalizeBaseUrl(fence.baseUrl);
  return (!fence.account || isAccountOwnerCurrent(fence.account)) && Number(fence.epoch) === responseInvalidationState.epoch
    && Number(fence.generation) === (responseInvalidationState.baseGenerations.get(normalizedBase) || 0);
}

export function captureCachedImageFence(url, options = {}) {
  const baseUrl = imageCacheBaseUrl(url, options);
  return Object.freeze({ baseUrl, epoch: imageInvalidationState.epoch,
    generation: imageInvalidationState.baseGenerations.get(baseUrl) || 0 });
}

function isCachedImageFenceCurrent(fence) {
  return fence?.epoch === imageInvalidationState.epoch
    && fence.generation === (imageInvalidationState.baseGenerations.get(fence.baseUrl) || 0);
}

function invalidateCachedJsonWrites(normalizedBase) {
  if (!normalizedBase) {
    responseInvalidationState.epoch += 1;
    responseInvalidationState.baseGenerations.clear();
    return;
  }
  responseInvalidationState.baseGenerations.set(
    normalizedBase,
    (responseInvalidationState.baseGenerations.get(normalizedBase) || 0) + 1
  );
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
      // Existing entries are indexed without rewriting their payloads. Missing
      // legacy fields remain on the full-read path rather than changing size.
      for (const name of [RESPONSE_STORE, IMAGE_STORE]) {
        const store = request.transaction.objectStore(name);
        if (!store.indexNames.contains(CACHE_TRIM_INDEX)) {
          store.createIndex(CACHE_TRIM_INDEX, ["key", "bytes", "accessedAt", "updatedAt"], { unique: false });
        }
      }
    };
    request.onsuccess = () => {
      finish(() => {
        request.result.onversionchange = () => {
          request.result.close();
          dbPromise = null;
        };
        scheduleStaleResponsePrune(request.result).catch(() => {});
        resolve(request.result);
      }) || request.result?.close?.();
    };
    request.onerror = () => fail(request.error || new Error("本地缓存打开失败"));
    request.onblocked = () => fail(new Error("本地缓存升级被占用"));
  });

  return dbPromise;
}

function cacheKey(baseUrl, path, account = captureAccountOwner(baseUrl)) {
  // Existing unscoped responses belong to the legacy guest, never a new account.
  const owner = account.owner === "guest" ? "" : ` ${account.owner}`;
  return `${normalizeBaseUrl(baseUrl)} ${RESPONSE_CACHE_VERSION}${owner} ${path}`;
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

function imageCacheBaseUrl(url, options = {}) {
  return normalizeBaseUrl(options.baseUrl) || imageBaseUrl(url);
}

async function deleteByBaseUrl(db, storeName, normalizedBase) {
  await runCacheTransaction(db, storeName, "readwrite", async (store) => {
    const entries = await requestToPromise(store.index("baseUrl").getAllKeys(normalizedBase));
    await Promise.all(entries.map((key) => requestToPromise(store.delete(key))));
  });
}

async function touchCachedResponse(entry, fence) {
  if (!entry?.key) return;
  const db = await openCacheDb();
  if (!isCachedJsonFenceCurrent(fence)) return;
  await runCacheTransaction(db, RESPONSE_STORE, "readwrite", async (store) => {
    const current = await requestToPromise(store.get(entry.key));
    if (!current || !isCachedJsonFenceCurrent(fence)) return;
    await requestToPromise(store.put({
      ...current,
      accessedAt: new Date().toISOString(),
      version: RESPONSE_CACHE_VERSION,
      bytes: responseEntryBytes(current)
    }));
  });
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
  await runCacheTransaction(db, RESPONSE_STORE, "readwrite", async store => {
    const keys = await requestToPromise(store.getAllKeys());
    // Normal keys already identify the current version without cloning JSON.
    // Older and unusual keys retain the original full-entry version check.
    await Promise.all(keys.filter(key => key && !(typeof key === "string" && isCurrentResponseCache({ key }))).map(async key => {
      const entry = await requestToPromise(store.get(key));
      if (entry?.key && !isCurrentResponseCache(entry)) await requestToPromise(store.delete(entry.key));
    }));
  });
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
  await trimCacheStore(db, RESPONSE_STORE, RESPONSE_CACHE_MAX_ENTRIES, RESPONSE_CACHE_MAX_BYTES, responseEntryBytes);
}

async function touchCachedImage(entry, options, fence) {
  if (!entry?.key) return;
  const db = await openCacheDb();
  if (!isCachedImageFenceCurrent(fence)) return;
  await runCacheTransaction(db, IMAGE_STORE, "readwrite", async (store) => {
    const current = await requestToPromise(store.get(entry.key));
    if (!current || !isCachedImageFenceCurrent(fence)) return;
    await requestToPromise(store.put({ ...current,
      baseUrl: normalizeBaseUrl(options.baseUrl) || current.baseUrl || imageBaseUrl(current.url || current.key),
      accessedAt: new Date().toISOString()
    }));
  });
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
  await trimCacheStore(db, IMAGE_STORE, IMAGE_CACHE_MAX_ENTRIES, IMAGE_CACHE_MAX_BYTES, imageEntryBytes);
}

async function readCacheTrimRows(store) {
  if (!store.indexNames.contains(CACHE_TRIM_INDEX)) return requestToPromise(store.getAll());
  const keys = store.index(CACHE_TRIM_INDEX).openKeyCursor();
  const rows = new Promise((resolve, reject) => {
    const result = [];
    keys.onerror = () => reject(keys.error || new Error("本地缓存读写失败"));
    keys.onsuccess = () => {
      const cursor = keys.result;
      if (!cursor) { resolve(result); return; }
      // The first tuple member is the primary key, preserving getAll's input
      // order for the stable localeCompare sort, including equal timestamps.
      const [, bytes, accessedAt, updatedAt] = cursor.key;
      result.push({ key: cursor.primaryKey, bytes, accessedAt, updatedAt });
      cursor.continue();
    };
  });
  const [projected, count] = await Promise.all([rows, requestToPromise(store.count())]);
  // Falsy bytes use the historical full-entry size calculation. Index keys can
  // convert binary values, so unusual legacy types also need the full entry.
  if (projected.length !== count || projected.some(row => !row.bytes
    || (typeof row.bytes !== "number" && typeof row.bytes !== "string")
    || typeof row.accessedAt !== "string" || typeof row.updatedAt !== "string")) return requestToPromise(store.getAll());
  return projected;
}

async function trimCacheStore(db, storeName, maxEntries, maxBytes, entryBytes) {
  // Reading and deleting in one transaction keeps another context's new put
  // or touch from being removed according to an obsolete trim snapshot.
  await runCacheTransaction(db, storeName, "readwrite", async store => {
    const rows = await readCacheTrimRows(store);
    const totalBytes = rows.reduce((sum, row) => sum + entryBytes(row), 0);
    if (rows.length <= maxEntries && totalBytes <= maxBytes) return;
    const sorted = rows.sort((a, b) => String(b.accessedAt || b.updatedAt || "").localeCompare(String(a.accessedAt || a.updatedAt || "")));
    let keptCount = 0, keptBytes = 0;
    const deletes = [];
    for (const row of sorted) {
      keptCount += 1;
      keptBytes += entryBytes(row);
      if (keptCount > maxEntries || keptBytes > maxBytes) deletes.push(requestToPromise(store.delete(row.key)));
    }
    await Promise.all(deletes);
  });
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

export function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    const failure = (fallback) => {
      let error = null;
      try {
        error = transaction?.error || null;
      } catch {}
      reject(error || fallback);
    };
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => failure(new Error("本地缓存事务已中止")), { once: true });
    transaction.addEventListener("error", () => failure(new Error("本地缓存事务失败")), { once: true });
  });
}

async function runCacheTransaction(db, storeName, mode, operation) {
  const transaction = db.transaction(storeName, mode);
  const completion = transactionToPromise(transaction);
  let operationResult;
  try {
    operationResult = operation(transaction.objectStore(storeName), transaction);
  } catch (error) {
    try { transaction.abort(); } catch {}
    await completion.catch(() => {});
    throw error;
  }
  const [result] = await Promise.all([operationResult, completion]);
  return result;
}

function estimateEntrySize(entry) {
  try {
    return new Blob([JSON.stringify(entry)]).size;
  } catch {
    return JSON.stringify(entry).length;
  }
}







