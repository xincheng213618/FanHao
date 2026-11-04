import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Current table definition from tools/manga_collector.py. Other schemas keep
// the existing per-chapter reader, including ordering and failure isolation.
const MANGA_IMAGES_TABLE_SQL = `CREATE TABLE manga_images (
        cache_key TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        image_index INTEGER NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        downloaded_url TEXT,
        final_url TEXT,
        local_path TEXT,
        content_type TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        error TEXT,
        PRIMARY KEY (cache_key, chapter_index, image_index),
        FOREIGN KEY (cache_key, chapter_index)
            REFERENCES manga_chapters(cache_key, chapter_index) ON DELETE CASCADE
    )`;

function closeDatabase(state) {
  if (!state.db) return;
  try {
    state.db.close();
  } catch {
    // The next read will reopen the database if needed.
  }
  state.db = null;
  state.path = "";
  state.fileStamp = "";
  state.comicStatement = null;
  state.firstImageStatements = null;
}

function databaseFileStat(dbPath) {
  try {
    const stat = fs.statSync(dbPath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function fileStamp(stat) {
  return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs, stat.size]);
}

export function createMangaDatabaseReader({ dbPath } = {}) {
  const configuredPath = String(dbPath || "").trim();
  const state = { db: null, path: "", fileStamp: "", generation: 0, comicStatement: null, firstImageStatements: null };

  function open() {
    if (!configuredPath) return null;
    const resolvedPath = path.resolve(configuredPath);
    const stat = databaseFileStat(resolvedPath);
    if (!stat) {
      closeDatabase(state);
      return null;
    }
    const stamp = fileStamp(stat);
    if (state.db && (state.path !== resolvedPath || state.fileStamp !== stamp)) {
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
      state.fileStamp = stamp;
      state.generation += 1;
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
      state.comicStatement ||= database.prepare("SELECT * FROM manga_comics WHERE cache_key = ?");
      return state.comicStatement.get(String(cacheKey || "")) || null;
    } catch {
      state.comicStatement = null;
      return null;
    }
  }

  function comics() {
    const database = open();
    if (!database) return null;
    try {
      return database.prepare("SELECT cache_key, source_url, downloaded_count FROM manga_comics").all();
    } catch {
      // Older collector schemas can still be read through comic().
      return null;
    }
  }

  function lookupStamp() {
    const database = open();
    if (!database) return null;
    try {
      const version = database.prepare("PRAGMA data_version").get()?.data_version;
      return JSON.stringify([state.path, state.fileStamp, state.generation, version]);
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
      const statements = state.firstImageStatements ||= {};
      if (chapterIndex == null) {
        statements.comic ||= database.prepare(
          "SELECT * FROM manga_images WHERE cache_key = ? AND local_path IS NOT NULL AND local_path <> '' ORDER BY chapter_index, image_index LIMIT 1"
        );
        return statements.comic.get(String(cacheKey || "")) || null;
      }
      statements.chapter ||= database.prepare(
        "SELECT * FROM manga_images WHERE cache_key = ? AND chapter_index = ? AND local_path IS NOT NULL AND local_path <> '' ORDER BY image_index LIMIT 1"
      );
      return statements.chapter.get(String(cacheKey || ""), Number(chapterIndex)) || null;
    } catch {
      state.firstImageStatements = null;
      return null;
    }
  }

  function detailFirstImages(cacheKey, chapterIndexes) {
    if (typeof cacheKey !== "string" || !Array.isArray(chapterIndexes) || !chapterIndexes.length
      || chapterIndexes.length > 10000 || !chapterIndexes.every(index => typeof index === "number" && Number.isFinite(index))) return null;
    const database = open();
    if (!database) return null;
    try {
      // Eligibility and rows share this statement's read snapshot. The exact
      // producer DDL proves a real, unshadowed rowid and unique BINARY keys.
      const rows = database.prepare(`
        WITH body_policy AS MATERIALIZED (
          SELECT EXISTS (
            SELECT 1 FROM main.sqlite_schema
            WHERE type = 'table' AND name = 'manga_images' AND sql = ?
          ) AND NOT EXISTS (
            SELECT 1 FROM temp.sqlite_schema WHERE name = 'manga_images' COLLATE NOCASE
          ) AS eligible
        ), parameters(cache_key) AS (VALUES (?)),
        requested(ordinal, chapter_index) AS (VALUES ${chapterIndexes.map((_index, ordinal) => `(${ordinal}, ?)`).join(",")})
        SELECT body_policy.eligible AS __detail_eligible, requested.ordinal AS __detail_ordinal, image.*
        FROM requested CROSS JOIN body_policy CROSS JOIN parameters
        LEFT JOIN manga_images AS image ON body_policy.eligible AND image.rowid = (
          SELECT picked.rowid FROM manga_images AS picked
          WHERE picked.cache_key = parameters.cache_key AND picked.chapter_index = requested.chapter_index
            AND picked.local_path IS NOT NULL AND picked.local_path <> ''
          ORDER BY picked.image_index LIMIT 1
        )
        ORDER BY requested.ordinal
      `).all(MANGA_IMAGES_TABLE_SQL, cacheKey, ...chapterIndexes);
      if (rows.length !== chapterIndexes.length
        || rows.some((row, ordinal) => row.__detail_eligible !== 1 || row.__detail_ordinal !== ordinal)) return null;
      return rows.map(row => {
        delete row.__detail_eligible;
        delete row.__detail_ordinal;
        return row.cache_key === null ? null : row;
      });
    } catch {
      // A bad selected row must not hide healthy chapters. The caller retries
      // through firstImage(), whose established catch boundary is per chapter.
      return null;
    }
  }

  return { chapter, chapters, comic, comics, firstImage, detailFirstImages, image, images, lookupStamp, status };
}
