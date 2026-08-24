import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function closeDatabase(state) {
  if (!state.db) return;
  try {
    state.db.close();
  } catch {
    // The next read will reopen the database if needed.
  }
  state.db = null;
  state.path = "";
  state.mtimeMs = 0;
}

function databaseFileStat(dbPath) {
  try {
    const stat = fs.statSync(dbPath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

export function createMangaDatabaseReader({ dbPath } = {}) {
  const configuredPath = String(dbPath || "").trim();
  const state = { db: null, path: "", mtimeMs: 0 };

  function open() {
    if (!configuredPath) return null;
    const resolvedPath = path.resolve(configuredPath);
    const stat = databaseFileStat(resolvedPath);
    if (!stat) {
      closeDatabase(state);
      return null;
    }
    if (state.db && (state.path !== resolvedPath || state.mtimeMs !== stat.mtimeMs)) {
      closeDatabase(state);
    }
    if (state.db) return state.db;

    try {
      const database = new DatabaseSync(resolvedPath, { readOnly: true });
      database.exec("PRAGMA busy_timeout = 5000;");
      const schema = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('manga_comics', 'manga_chapters', 'manga_images')")
        .all();
      if (schema.length < 3) {
        database.close();
        return null;
      }
      state.db = database;
      state.path = resolvedPath;
      state.mtimeMs = stat.mtimeMs;
      return database;
    } catch {
      closeDatabase(state);
      return null;
    }
  }

  function status() {
    const resolvedPath = configuredPath ? path.resolve(configuredPath) : "";
    const stat = resolvedPath ? databaseFileStat(resolvedPath) : null;
    return {
      path: resolvedPath,
      exists: Boolean(stat),
      available: Boolean(open())
    };
  }

  function comic(cacheKey) {
    const database = open();
    if (!database) return null;
    try {
      return database.prepare("SELECT * FROM manga_comics WHERE cache_key = ?").get(String(cacheKey || "")) || null;
    } catch {
      return null;
    }
  }

  function chapters(cacheKey) {
    const database = open();
    if (!database) return [];
    try {
      return database.prepare(
        "SELECT * FROM manga_chapters WHERE cache_key = ? ORDER BY chapter_index"
      ).all(String(cacheKey || ""));
    } catch {
      return [];
    }
  }

  function chapter(cacheKey, chapterIndex) {
    const database = open();
    if (!database) return null;
    try {
      return database.prepare(
        "SELECT * FROM manga_chapters WHERE cache_key = ? AND chapter_index = ?"
      ).get(String(cacheKey || ""), Number(chapterIndex)) || null;
    } catch {
      return null;
    }
  }

  function images(cacheKey, chapterIndex) {
    const database = open();
    if (!database) return [];
    try {
      return database.prepare(
        "SELECT * FROM manga_images WHERE cache_key = ? AND chapter_index = ? ORDER BY image_index"
      ).all(String(cacheKey || ""), Number(chapterIndex));
    } catch {
      return [];
    }
  }

  function image(cacheKey, chapterIndex, imageIndex) {
    const database = open();
    if (!database) return null;
    try {
      return database.prepare(
        "SELECT * FROM manga_images WHERE cache_key = ? AND chapter_index = ? AND image_index = ?"
      ).get(String(cacheKey || ""), Number(chapterIndex), Number(imageIndex)) || null;
    } catch {
      return null;
    }
  }

  function firstImage(cacheKey, chapterIndex = null) {
    const database = open();
    if (!database) return null;
    try {
      if (chapterIndex == null) {
        return database.prepare(
          "SELECT * FROM manga_images WHERE cache_key = ? AND local_path IS NOT NULL AND local_path <> '' ORDER BY chapter_index, image_index LIMIT 1"
        ).get(String(cacheKey || "")) || null;
      }
      return database.prepare(
        "SELECT * FROM manga_images WHERE cache_key = ? AND chapter_index = ? AND local_path IS NOT NULL AND local_path <> '' ORDER BY image_index LIMIT 1"
      ).get(String(cacheKey || ""), Number(chapterIndex)) || null;
    } catch {
      return null;
    }
  }

  return { chapter, chapters, comic, firstImage, image, images, status };
}
