import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_CACHED_ACCOUNTS = 32;

// The scope carries a trusted account id, never a mutable state or a credential.
// Callers must finish a state mutation and save synchronously, after reading the
// request body. A fresh synchronous turn checks the persisted revision again.
export function createAccountUserStateService({ dbPath, legacyStateService }) {
  const scope = new AsyncLocalStorage();
  const entries = new Map();
  let db = null;
  let closed = false;
  let tick = 0;
  let tickScheduled = false;

  function database() {
    if (closed) throw new Error("Account personal state service is closed");
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const connection = new DatabaseSync(dbPath);
    try {
      connection.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE;");
      const version = Number(connection.prepare("PRAGMA user_version").get().user_version);
      if (version > 1) throw new Error("Account personal state schema is newer than this server");
      if (version < 1) connection.exec(`
        CREATE TABLE account_user_state (
          account_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          state_json TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      connection.exec("COMMIT");
      db = connection;
      return db;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  function currentOwner() {
    if (closed) throw new Error("Account personal state service is closed");
    return scope.getStore() || "";
  }

  function runForUser(user, callback) {
    const owner = user?.id;
    if (owner !== undefined && owner !== null && (typeof owner !== "string" || !owner.trim() || owner.length > 128)) {
      throw new TypeError("Invalid trusted account id");
    }
    return scope.run(owner || "", callback);
  }

  function runAsGuest(callback) {
    return scope.run("", callback);
  }

  function normalizeFavoriteFolderId(value, folders = state().favoriteFolders) {
    const id = String(value || "").trim();
    return id && folders && Object.hasOwn(folders, id) ? id : legacyStateService.defaultFavoriteFolderId;
  }

  function normalizeFavoriteRecord(value, folders = state().favoriteFolders) {
    const record = value && typeof value === "object" ? value : {};
    return { createdAt: String(record.createdAt || ""), folderId: normalizeFavoriteFolderId(record.folderId, folders) };
  }

  function normalizeFavorites(value, folders = state().favoriteFolders) {
    return Object.fromEntries(Object.entries(recordObject(value)).filter(([id]) => id).map(([id, item]) => [id, normalizeFavoriteRecord(item, folders)]));
  }

  function normalizeState(value) {
    const favoriteFolders = legacyStateService.normalizeFavoriteFolders(recordObject(value?.favoriteFolders));
    const progress = Object.fromEntries(Object.entries(recordObject(value?.progress)).flatMap(([videoId, row]) => {
      if (!videoId || !row || !Number.isFinite(row.position) || row.position < 0 || !Number.isFinite(row.duration) || row.duration <= 0) return [];
      return [[videoId, {
        workId: row.workId ? String(row.workId) : null,
        position: row.position,
        duration: row.duration,
        updatedAt: String(row.updatedAt || "")
      }]];
    }));
    return { favoriteFolders, favorites: normalizeFavorites(value?.favorites, favoriteFolders), progress };
  }

  function emptyState() {
    return normalizeState({});
  }

  function decodeRow(row) {
    if (!row) return { revision: 0, state: emptyState() };
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error("Invalid account personal state revision");
    const parsed = JSON.parse(row.state_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || ["favoriteFolders", "favorites", "progress"].some((key) => !parsed[key] || typeof parsed[key] !== "object" || Array.isArray(parsed[key]))) {
      throw new Error("Invalid account personal state data");
    }
    return { revision: row.revision, state: normalizeState(parsed) };
  }

  function currentEntry(owner = currentOwner()) {
    if (!tickScheduled) {
      tickScheduled = true;
      queueMicrotask(() => { tick += 1; tickScheduled = false; });
    }
    let entry = entries.get(owner);
    if (!entry || entry.tick !== tick) {
      const row = database().prepare("SELECT revision, state_json FROM account_user_state WHERE account_id = ?").get(owner);
      if (!entry || Number(row?.revision || 0) !== entry.revision) {
        const loaded = decodeRow(row);
        const value = entry?.state || {};
        replaceState(value, loaded.state);
        entry = { state: value, revision: loaded.revision, committed: JSON.stringify(loaded.state), tick };
      } else {
        entry.tick = tick;
      }
    }
    entries.delete(owner);
    entries.set(owner, entry);
    while (entries.size > MAX_CACHED_ACCOUNTS) entries.delete(entries.keys().next().value);
    return entry;
  }

  function state() {
    const owner = currentOwner();
    return owner ? currentEntry(owner).state : legacyStateService.state;
  }

  function revision() {
    const owner = currentOwner();
    return JSON.stringify([owner || null, owner ? currentEntry(owner).revision : 0, legacyStateService.revision()]);
  }

  function save(options) {
    const owner = currentOwner();
    if (!owner) return legacyStateService.save(options);
    const entry = currentEntry(owner);
    const connection = database();
    try {
      const normalized = normalizeState(entry.state);
      const encoded = JSON.stringify(normalized);
      connection.exec("BEGIN IMMEDIATE");
      const result = entry.revision
        ? connection.prepare("UPDATE account_user_state SET state_json = ?, revision = revision + 1 WHERE account_id = ? AND revision = ?").run(encoded, owner, entry.revision)
        : connection.prepare("INSERT INTO account_user_state (account_id, revision, state_json) VALUES (?, 1, ?) ON CONFLICT(account_id) DO NOTHING").run(owner, encoded);
      if (Number(result.changes) !== 1) {
        const error = new Error("个人记录已在另一处更新，请刷新后重试");
        error.statusCode = 409;
        throw error;
      }
      connection.exec("COMMIT");
      replaceState(entry.state, normalized);
      entry.revision += 1;
      entry.committed = encoded;
      return entry.state;
    } catch (error) {
      try { if (connection.isTransaction) connection.exec("ROLLBACK"); }
      finally {
        replaceState(entry.state, JSON.parse(entry.committed));
        entry.tick = -1;
      }
      throw error;
    }
  }

  function close() {
    closed = true;
    entries.clear();
    db?.close();
    db = null;
  }

  return {
    runForUser, runAsGuest, state, save, revision, close, emptyState,
    normalizeFavoriteFolderId, normalizeFavoriteRecord, normalizeFavorites,
    cleanFavoriteFolderName: legacyStateService.cleanFavoriteFolderName,
    defaultFavoriteFolderId: legacyStateService.defaultFavoriteFolderId,
    defaultFavoriteFolderName: legacyStateService.defaultFavoriteFolderName,
    defaultFavoriteFolders: legacyStateService.defaultFavoriteFolders,
    normalizeFavoriteFolders: legacyStateService.normalizeFavoriteFolders
  };
}

function recordObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function replaceState(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}
