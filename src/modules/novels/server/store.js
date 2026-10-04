import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { reconcileChapters } from "./chapter-identity.js";
import { assertSourceSnapshot, loadLocalReimportArtifact, samePath } from "./local-reimport-artifact.js";

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 5000;
const MAX_CHAPTER_CHARS = 12000;
const MAX_UPLOAD_TEXT_CHARS = 50 * 1024 * 1024;
const UPLOAD_SOURCE_ROOT = "上传";
const COLLECTION_SOURCE_ROOT = "网页采集";
const LIBRARY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROGRESS_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PROGRESS_SESSION_LIMIT = 8192;
const PROGRESS_BOOK_SESSION_LIMIT = 32;
export const NOVEL_WRITE_METHODS = Object.freeze(["saveProgress", "updateBookMetadata", "uploadBook", "reimportBook", "importCollectedBook", "deleteBook", "reimportLocalBook"]);
const PROGRESS_COLUMNS = `s.chapter_id AS progress_chapter_id, s.chapter_index AS progress_chapter_index,
  s.scroll_ratio AS progress_scroll_ratio, s.updated_at AS progress_updated_at,
  s.catalog_revision AS progress_revision, s.status AS progress_status,
  s.reason AS progress_reason, s.anchor_json AS progress_anchor, s.candidate_json AS progress_candidate`;

export function createNovelStore(options = {}) {
  const dbPath = options.dbPath;
  if (!dbPath) throw new Error("novel dbPath is required");
  let db = null;
  let summaryStaticCache = null;
  let readStorageStamp = null;
  let writeOperationActive = false;

  function storageStamp() {
    const stamp = (filePath, ignoreEmpty = false) => {
      try {
        const stat = fs.statSync(filePath, { bigint: true });
        if (ignoreEmpty && stat.size === 0n) return "";
        return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
      } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
      }
    };
    return `${stamp(dbPath)}|${stamp(`${dbPath}-wal`, true)}`;
  }

  function listRevision(sourceRealm) {
    // The rows belong to the read snapshot, not to a file stamp observed after
    // another writer commits. An unstable read gets a one-use token so a later
    // page cannot append to it as though both pages came from one revision.
    const stamp = readStorageStamp !== null && storageStamp() === readStorageStamp
      ? readStorageStamp
      : crypto.randomUUID();
    return crypto.createHash("sha256").update(`${sourceRealm}\n${stamp}`).digest("hex");
  }

  function getDb() {
    if (!db) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const candidate = new DatabaseSync(dbPath);
      try { ensureSchema(candidate); }
      catch (error) { candidate.close(); throw error; }
      db = candidate;
    }
    return db;
  }

  function withDb(callback, { changesCatalog = true } = {}) {
    const database = getDb();
    try {
      return callback(database);
    } finally {
      if (changesCatalog) summaryStaticCache = null;
      if (!writeOperationActive) closeDb();
    }
  }

  function withReadDb(callback, { cacheSummary = false } = {}) {
    return withDb((database) => {
      // Capture before BEGIN's first read. A writer can commit while this
      // snapshot is open; never associate its newer file stamp with old rows.
      readStorageStamp = cacheSummary ? storageStamp() : null;
      try {
        return inReadSnapshot(database, callback);
      } finally {
        readStorageStamp = null;
      }
    }, { changesCatalog: false });
  }

  function invalidate() {
    summaryStaticCache = null;
    closeDb();
  }

  function closeDb() {
    if (!db) return;
    try {
      db.close();
    } catch {}
    db = null;
  }

  function summary() {
    return withReadDb((database) => summaryFromDb(database), { cacheSummary: true });
  }

  function summaryFromDb(database) {
    const sourceRealm = sourceRealmFromDb(database);
    const summaryStatic = staticSummaryFromDb(database, sourceRealm);
    const recent = database
      .prepare(
        `
        SELECT b.*, ${PROGRESS_COLUMNS}
        FROM novel_reading_state s
        JOIN novel_books b ON b.id = s.book_id
        WHERE b.status = 'ok'
        ORDER BY s.updated_at DESC
        LIMIT 6
      `
      )
      .all()
      .map((row) => publicBook(row, sourceRealm));
    return {
      ...summaryStatic,
      totals: { ...summaryStatic.totals },
      categories: summaryStatic.categories.map((item) => ({ ...item })),
      roots: summaryStatic.roots.map((item) => ({ ...item })),
      recent
    };
  }

  function staticSummaryFromDb(database, sourceRealm) {
    const scannedAt = metaValue(database, "scanned_at");
    const dataVersion = database.prepare("PRAGMA data_version").get().data_version;
    const schemaVersion = metaValue(database, "schema_version");
    const stamp = `${readStorageStamp}:${dataVersion}:${sourceRealm}:${schemaVersion}:${scannedAt}`;
    const storageUnchanged = readStorageStamp !== null && storageStamp() === readStorageStamp;
    if (storageUnchanged && summaryStaticCache?.stamp === stamp) return summaryStaticCache.value;
    const totals =
      database
        .prepare(
          `
          SELECT
            COUNT(*) AS books,
            COUNT(DISTINCT NULLIF(TRIM(author), '')) AS authors,
            COALESCE(SUM(chapter_count), 0) AS chapters,
            COALESCE(SUM(char_count), 0) AS chars,
            COALESCE(SUM(size_bytes), 0) AS bytes,
            COALESCE(MAX(updated_at), '') AS updated_at
          FROM novel_books
          WHERE status = 'ok'
        `
        )
        .get() || {};
    const categories = database
      .prepare(
        `
        SELECT COALESCE(category, '全部') AS name, COUNT(*) AS count
        FROM novel_books
        WHERE status = 'ok'
        GROUP BY COALESCE(category, '全部')
        ORDER BY count DESC, name COLLATE NOCASE
      `
      )
      .all();
    const roots = database
      .prepare(
        `
        SELECT source_root AS path, COUNT(*) AS count
        FROM novel_books
        GROUP BY source_root
        ORDER BY count DESC, path COLLATE NOCASE
      `
      )
      .all();
    const value = {
      sourceRealm,
      dbPath,
      scannedAt,
      roots,
      totals: {
        books: Number(totals.books || 0),
        authors: Number(totals.authors || 0),
        chapters: Number(totals.chapters || 0),
        chars: Number(totals.chars || 0),
        bytes: Number(totals.bytes || 0),
        updatedAt: totals.updated_at || ""
      },
      categories: categories.map((row) => ({ name: row.name || "全部", count: Number(row.count || 0) }))
    };
    summaryStaticCache = storageUnchanged && storageStamp() === readStorageStamp
      ? { stamp, value }
      : null;
    return value;
  }

  function listBooks(url, existingDatabase = null) {
    const run = existingDatabase
      ? callback => callback(existingDatabase)
      : callback => withReadDb(callback, { cacheSummary: true });
    return run((database) => {
      const sourceRealm = sourceRealmFromDb(database);
      const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
      const category = String(url.searchParams.get("category") || "all").trim() || "all";
      const author = String(url.searchParams.get("author") || "").trim();
      const readingOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("reading") || "").toLowerCase());
      const sort = normalizeSort(url.searchParams.get("sort"));
      const limit = clampInteger(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
      const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      const conditions = ["b.status = 'ok'"];
      const params = [];
      if (readingOnly) conditions.push("EXISTS (SELECT 1 FROM novel_reading_state rs WHERE rs.book_id = b.id)");
      if (category !== "all") {
        conditions.push("COALESCE(b.category, '全部') = ?");
        params.push(category);
      }
      if (author) {
        conditions.push("TRIM(COALESCE(b.author, '')) = ?");
        params.push(author);
      }
      if (query) {
        const like = `%${escapeLike(query)}%`;
        const parts = [
          "b.title LIKE ? ESCAPE '\\'",
          "COALESCE(b.author, '') LIKE ? ESCAPE '\\'",
          "COALESCE(b.category, '') LIKE ? ESCAPE '\\'",
          "COALESCE(b.latest_chapter_title, '') LIKE ? ESCAPE '\\'",
          "COALESCE(b.summary, '') LIKE ? ESCAPE '\\'"
        ];
        params.push(like, like, like, like, like);
        conditions.push(`(${parts.join(" OR ")})`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const order = bookOrderSql(sort);
      const countRow = database.prepare(`SELECT COUNT(*) AS count FROM novel_books b ${where}`).get(...params);
      const rows = database
        .prepare(
          `
          SELECT b.*, ${PROGRESS_COLUMNS}
          FROM novel_books b
          LEFT JOIN novel_reading_state s ON s.book_id = b.id
          ${where}
          ${order}
          LIMIT ? OFFSET ?
        `
        )
        .all(...params, limit, offset);
      const summary = summaryFromDb(database);
      return {
        sourceRealm,
        listRevision: listRevision(sourceRealm),
        books: rows.map((row) => publicBook(row, sourceRealm)),
        total: Number(countRow?.count || 0),
        limit,
        offset,
        nextOffset: offset + rows.length,
        query,
        category,
        author,
        readingOnly,
        sort,
        facets: summary.categories,
        summary
      };
    });
  }

  function listAuthors(url) {
    return withReadDb((database) => {
      const sourceRealm = sourceRealmFromDb(database);
      const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
      const sort = normalizeAuthorSort(url.searchParams.get("sort"));
      const limit = clampInteger(url.searchParams.get("limit"), 5000, 1, 5000);
      const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      const conditions = ["status = 'ok'", "TRIM(COALESCE(author, '')) <> ''"];
      const params = [];
      if (query) {
        conditions.push("author LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(query)}%`);
      }
      const where = `WHERE ${conditions.join(" AND ")}`;
      const order = authorOrderSql(sort);
      const total = database.prepare(`SELECT COUNT(DISTINCT TRIM(author)) AS count FROM novel_books ${where}`).get(...params);
      const authors = database
        .prepare(
          `
          SELECT
            TRIM(author) AS name,
            COUNT(*) AS book_count,
            COALESCE(SUM(chapter_count), 0) AS chapter_count,
            COALESCE(SUM(char_count), 0) AS char_count,
            COALESCE(SUM(size_bytes), 0) AS size_bytes,
            COALESCE(MAX(updated_at), '') AS updated_at
          FROM novel_books
          ${where}
          GROUP BY TRIM(author)
          ${order}
          LIMIT ? OFFSET ?
        `
        )
        .all(...params, limit, offset)
        .map((row) => ({
          name: row.name || "",
          bookCount: Number(row.book_count || 0),
          chapterCount: Number(row.chapter_count || 0),
          charCount: Number(row.char_count || 0),
          sizeBytes: Number(row.size_bytes || 0),
          updatedAt: row.updated_at || ""
        }));
      return {
        sourceRealm,
        authors,
        total: Number(total?.count || 0),
        query,
        sort,
        limit,
        offset,
        summary: summaryFromDb(database)
      };
    });
  }

  function authorDetail(authorName, url) {
    const author = String(authorName || "").trim().slice(0, 80);
    if (!author) throw httpError(400, "作者名不能为空");
    const requestUrl = new URL(url.toString());
    requestUrl.searchParams.set("author", author);
    return withReadDb((database) => {
      const page = listBooks(requestUrl, database);
      const row = database
        .prepare(
          `
          SELECT
            TRIM(author) AS name,
            COUNT(*) AS book_count,
            COALESCE(SUM(chapter_count), 0) AS chapter_count,
            COALESCE(SUM(char_count), 0) AS char_count,
            COALESCE(SUM(size_bytes), 0) AS size_bytes,
            COALESCE(MAX(updated_at), '') AS updated_at
          FROM novel_books
          WHERE status = 'ok' AND TRIM(COALESCE(author, '')) = ?
          GROUP BY TRIM(author)
        `
        )
        .get(author);
      const profile = row
        ? {
            name: row.name || author,
            bookCount: Number(row.book_count || 0),
            chapterCount: Number(row.chapter_count || 0),
            charCount: Number(row.char_count || 0),
            sizeBytes: Number(row.size_bytes || 0),
            updatedAt: row.updated_at || ""
          }
        : null;
      if (!profile) return null;
      return { ...page, author: profile };
    }, { cacheSummary: true });
  }

  function bookDetail(bookId) {
    return withReadDb((database) => bookDetailFromDb(database, bookId));
  }

  function bookMeta(bookId) {
    return withReadDb((database) => {
      const book = bookRecordFromDb(database, bookId);
      return book
        ? { serverClockMs: progressServerClock(database), sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision, book, chapters: [], chapterTotal: Number(book.chapterCount || 0), catalogLoaded: false }
        : null;
    });
  }

  function updateBookMetadata(bookId, body = {}) {
    return withDb((database) => {
      const current = bookRecordFromDb(database, bookId);
      if (!current) return null;
      const title = Object.hasOwn(body, "title") ? String(body.title || "").trim().slice(0, 180) : current.title;
      const author = Object.hasOwn(body, "author") ? String(body.author || "").trim().slice(0, 80) : current.author;
      const category = Object.hasOwn(body, "category") ? String(body.category || "").trim().slice(0, 80) : current.category;
      const summary = Object.hasOwn(body, "summary") ? String(body.summary || "").trim().slice(0, 2000) : current.summary;
      if (!title) throw httpError(400, "书名不能为空");
      const updatedAt = new Date().toISOString();
      const transaction = beginTransaction(database, "BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `
            INSERT INTO novel_book_overrides (book_id, title, author, category, summary, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(book_id) DO UPDATE SET
              title = excluded.title,
              author = excluded.author,
              category = excluded.category,
              summary = excluded.summary,
              updated_at = excluded.updated_at
          `
          )
          .run(bookId, title, author, category, summary, updatedAt);
        database
          .prepare("UPDATE novel_books SET title = ?, author = ?, category = ?, summary = ?, updated_at = ? WHERE id = ?")
          .run(title, author, category, summary, updatedAt, bookId);
        commitTransaction(database, transaction);
      } catch (error) {
        try {
          rollbackTransaction(database, transaction);
        } catch {}
        throw error;
      }
      return bookRecordFromDb(database, bookId);
    });
  }

  function deleteBook(bookId, { sourceRealm } = {}) {
    return withDb((database) => {
      if (sourceRealm !== undefined && sourceRealm !== sourceRealmFromDb(database)) {
        throw httpError(409, "小说库来源已变化，请重新打开这本书后再删除");
      }
      const book = database
        .prepare("SELECT id, title, source_path FROM novel_books WHERE id = ? AND status = 'ok'")
        .get(bookId);
      if (!book) return null;
      const deletedAt = new Date().toISOString();
      const transaction = beginTransaction(database, "BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `
            INSERT INTO novel_book_deletions (book_id, source_path, title, deleted_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(book_id) DO UPDATE SET
              source_path = excluded.source_path,
              title = excluded.title,
              deleted_at = excluded.deleted_at
          `
          )
          .run(book.id, book.source_path || "", book.title || "", deletedAt);
        database.prepare("DELETE FROM novel_chapters WHERE book_id = ?").run(book.id);
        database.prepare("DELETE FROM novel_reading_state WHERE book_id = ?").run(book.id);
        database.prepare("DELETE FROM novel_book_overrides WHERE book_id = ?").run(book.id);
        database.prepare("DELETE FROM novel_books WHERE id = ?").run(book.id);
        commitTransaction(database, transaction);
      } catch (error) {
        try {
          rollbackTransaction(database, transaction);
        } catch {}
        throw error;
      }
      return { id: book.id, title: book.title || "", sourcePath: book.source_path || "", deletedAt };
    });
  }

  function bookDetailFromDb(database, bookId) {
    const book = bookRecordFromDb(database, bookId);
    if (!book) return null;
    return {
      sourceRealm: book.sourceRealm,
      catalogRevision: book.catalogRevision,
      book,
      chapters: chapterList(database, bookId)
    };
  }

  function bookRecordFromDb(database, bookId, { includeRealm = true } = {}) {
    if (!includeRealm) {
      const row = database.prepare("SELECT * FROM novel_books WHERE id = ? AND status = 'ok'").get(bookId);
      return row ? publicBook(row) : null;
    }
    const row = database
      .prepare(
        `
        SELECT b.*, ${PROGRESS_COLUMNS}
        FROM novel_books b
        LEFT JOIN novel_reading_state s ON s.book_id = b.id
        WHERE b.id = ? AND b.status = 'ok'
      `
      )
      .get(bookId);
    return row ? publicBook(row, includeRealm ? sourceRealmFromDb(database) : undefined) : null;
  }

  function chapterDetail(bookId, chapterIndex, options = {}) {
    return withReadDb((database) => {
      const book = bookRecordFromDb(database, bookId);
      if (!book) return null;
      checkBookPreconditions(book, options);
      const chapter = database
        .prepare(
          `
          SELECT id, book_id, chapter_index, title, content, char_count, updated_at
          FROM novel_chapters
          WHERE book_id = ? AND chapter_index = ?
        `
        )
        .get(bookId, clampInteger(chapterIndex, 1, 1, Number.MAX_SAFE_INTEGER));
      if (!chapter) return null;
      if (options.chapterId !== undefined && options.chapterId !== chapter.id) throw httpError(409, "章节已变化，请刷新目录");
      const previous = database
        .prepare(
          `
          SELECT id, book_id, chapter_index, title, '' AS content, char_count, updated_at
          FROM novel_chapters
          WHERE book_id = ? AND chapter_index < ?
          ORDER BY chapter_index DESC
          LIMIT 1
        `
        )
        .get(bookId, chapter.chapter_index);
      const following = database
        .prepare(
          `
          SELECT id, book_id, chapter_index, title, '' AS content, char_count, updated_at
          FROM novel_chapters
          WHERE book_id = ? AND chapter_index > ?
          ORDER BY chapter_index ASC
          LIMIT 1
        `
        )
        .get(bookId, chapter.chapter_index);
      return {
        serverClockMs: progressServerClock(database),
        sourceRealm: book.sourceRealm,
        catalogRevision: book.catalogRevision,
        book,
        chapter: publicChapter(chapter, true),
        chapters: [],
        chapterTotal: Number(book.chapterCount || 0),
        catalogLoaded: false,
        prev: previous ? publicChapter(previous, false) : null,
        next: following ? publicChapter(following, false) : null
      };
    });
  }

  function catalog(bookId, url) {
    return withReadDb((database) => {
      const book = bookRecordFromDb(database, bookId);
      if (book) checkBookPreconditions(book, {
        sourceRealm: url.searchParams.has("sourceRealm") ? url.searchParams.get("sourceRealm") : undefined,
        catalogRevision: url.searchParams.has("catalogRevision") ? url.searchParams.get("catalogRevision") : undefined
      });
      if (!book) return null;
      const query = String(url?.searchParams?.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const order = String(url?.searchParams?.get("order") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
      const all = ["1", "true", "yes"].includes(String(url?.searchParams?.get("all") || "").toLowerCase());
      const requestedLimit = clampInteger(url?.searchParams?.get("limit"), 120, 20, 200);
      const requestedOffset = clampInteger(url?.searchParams?.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      const anchor = clampInteger(url?.searchParams?.get("anchor"), 0, 0, Number.MAX_SAFE_INTEGER);
      const where = ["book_id = ?"];
      const params = [bookId];
      if (query) {
        const pattern = `%${escapeLike(query)}%`;
        where.push("(title LIKE ? ESCAPE '\\' COLLATE NOCASE OR CAST(chapter_index AS TEXT) LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
      }
      const filteredTotal = Number(
        database.prepare(`SELECT COUNT(*) AS count FROM novel_chapters WHERE ${where.join(" AND ")}`).get(...params)?.count || 0
      );
      const limit = all ? Math.max(1, filteredTotal) : requestedLimit;
      let offset = all ? 0 : requestedOffset;
      if (!all && !query && anchor > 0 && filteredTotal > 0) {
        const clampedAnchor = Math.max(1, Math.min(filteredTotal, anchor));
        const position = order === "desc" ? filteredTotal - clampedAnchor : clampedAnchor - 1;
        offset = Math.floor(position / limit) * limit;
      }
      const lastPageOffset = filteredTotal > 0 ? Math.floor((filteredTotal - 1) / limit) * limit : 0;
      offset = Math.max(0, Math.min(lastPageOffset, offset));
      const rows = database
        .prepare(
          `
          SELECT id, book_id, chapter_index, title, '' AS content, char_count, updated_at
          FROM novel_chapters
          WHERE ${where.join(" AND ")}
          ORDER BY chapter_index ${order === "desc" ? "DESC" : "ASC"}
          LIMIT ? OFFSET ?
        `
        )
        .all(...params, limit, offset);
      const chapters = rows.map((row) => publicChapter(row, false));
      return {
        sourceRealm: book.sourceRealm,
        catalogRevision: book.catalogRevision,
        bookId,
        chapters,
        total: Number(book.chapterCount || 0),
        filteredTotal,
        limit,
        offset,
        query,
        order,
        all,
        firstIndex: chapters[0]?.index || 0,
        lastIndex: chapters[chapters.length - 1]?.index || 0
      };
    });
  }

  function saveProgress(bookId, body = {}) {
    return withDb((database) => inTransaction(database, "BEGIN IMMEDIATE", () => {
      const session = progressSession(body);
      if (body.sourceRealm !== undefined && body.sourceRealm !== sourceRealmFromDb(database)) {
        throw httpError(409, "小说库来源已变化，请重新打开这本书后再保存进度");
      }
      const book = database.prepare("SELECT catalog_revision, legacy_write_allowed FROM novel_books WHERE id = ? AND status = 'ok'").get(bookId);
      if (!book) return null;
      const saved = database.prepare("SELECT status FROM novel_reading_state WHERE book_id = ?").get(bookId);
      if (session && body.sourceRealm !== sourceRealmFromDb(database)) throw httpError(409, "小说库来源已变化，请重新打开后再保存进度");
      const modern = Boolean(session) || body.catalogRevision !== undefined || body.chapterId !== undefined || !book.legacy_write_allowed || (saved && saved.status !== "resolved");
      let chapter;
      if (modern) {
        if (body.catalogRevision !== book.catalog_revision || typeof body.chapterId !== "string" || !body.chapterId) {
          throw httpError(409, "目录版本已变化，请刷新后再保存进度");
        }
        chapter = database.prepare("SELECT id, chapter_index FROM novel_chapters WHERE book_id = ? AND id = ?").get(bookId, body.chapterId);
        const suppliedIndex = body.chapterIndex ?? body.chapter_index;
        if (!chapter || (suppliedIndex !== undefined && suppliedIndex !== chapter.chapter_index)) throw httpError(409, "章节已变化，请刷新后再保存进度");
      } else {
        // Compatibility only before this book's first v5 replacement. An index
        // alone cannot prove which historic snapshot an old client displayed.
        const chapterIndex = clampInteger(body.chapterIndex ?? body.chapter_index, 1, 1, Number.MAX_SAFE_INTEGER);
        chapter = database.prepare("SELECT id, chapter_index FROM novel_chapters WHERE book_id = ? AND chapter_index = ?").get(bookId, chapterIndex);
      }
      if (!chapter) return null;
      const suppliedRatio = body.scrollRatio ?? body.scroll_ratio ?? 0;
      if (modern && (typeof suppliedRatio !== "number" || !Number.isFinite(suppliedRatio) || suppliedRatio < 0 || suppliedRatio > 1)) {
        throw httpError(400, "阅读位置无效");
      }
      const ratio = Math.max(0, Math.min(1, Number(suppliedRatio) || 0));
      if (session && !acceptProgressSequence(database, bookId, book.catalog_revision, session)) {
        const current = database.prepare("SELECT * FROM novel_reading_state WHERE book_id = ?").get(bookId);
        return { bookId, status: current.status, chapterId: current.chapter_id, chapterIndex: current.chapter_index,
          scrollRatio: current.scroll_ratio, updatedAt: current.updated_at, catalogRevision: current.catalog_revision, applied: false };
      }
      const updatedAt = new Date().toISOString();
      database
        .prepare(
          `
          INSERT INTO novel_reading_state (book_id, chapter_id, chapter_index, scroll_ratio, updated_at, catalog_revision, status, reason, anchor_json, candidate_json)
          VALUES (?, ?, ?, ?, ?, ?, 'resolved', '', NULL, NULL)
          ON CONFLICT(book_id) DO UPDATE SET
            chapter_id = excluded.chapter_id,
            chapter_index = excluded.chapter_index,
            scroll_ratio = excluded.scroll_ratio,
            updated_at = excluded.updated_at,
            catalog_revision = excluded.catalog_revision, status = 'resolved', reason = '', anchor_json = NULL, candidate_json = NULL
        `
        )
        .run(bookId, chapter.id, Number(chapter.chapter_index), ratio, updatedAt, book.catalog_revision);
      return { bookId, status: "resolved", chapterId: chapter.id, chapterIndex: Number(chapter.chapter_index), scrollRatio: ratio, updatedAt, catalogRevision: book.catalog_revision,
        ...(session ? { applied: true } : {}) };
    }), { changesCatalog: false });
  }

  function openDownload(bookId) {
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // This internal DTO only supplies TXT headers; downloads remain read-only
      // even for a legacy database which has not yet received a library_id.
      const book = bookRecordFromDb(database, bookId, { includeRealm: false });
      if (!book) {
        database.close();
        return null;
      }
      const iterator = database
        .prepare(
          `
          SELECT chapter_index, title, content
          FROM novel_chapters
          WHERE book_id = ?
          ORDER BY chapter_index
        `
        )
        .iterate(bookId);
      let firstChapter = true;
      let closed = false;
      return {
        book,
        fileName: safeFileName(`${book.title || "小说"}.txt`),
        header: `${book.title || "小说"}\n\n`,
        nextChunk() {
          if (closed) return null;
          const result = iterator.next();
          if (result.done) return null;
          const chapter = result.value;
          const title = chapter.title || `第 ${chapter.chapter_index} 章`;
          const content = String(chapter.content || "").trim().replace(/\n{3,}/g, "\n\n");
          const prefix = firstChapter ? "" : "\n\n";
          firstChapter = false;
          return `${prefix}${title}${content ? `\n\n${content}` : ""}`;
        },
        close() {
          if (closed) return;
          closed = true;
          try {
            iterator.return?.();
          } catch {}
          try {
            database.close();
          } catch {}
        }
      };
    } catch (error) {
      try {
        database.close();
      } catch {}
      throw error;
    }
  }

  function uploadBook(body = {}) {
    return withDb((database) => {
      const bookId = uploadBookIntoDb(database, body);
      return inReadSnapshot(database, () => bookDetailFromDb(database, bookId));
    });
  }

  function reimportBook(bookId, body = {}) {
    return withDb((database) => {
      const importedBookId = reimportBookIntoDb(database, bookId, body);
      return importedBookId ? inReadSnapshot(database, () => bookDetailFromDb(database, importedBookId)) : null;
    });
  }

  function importCollectedBook(body = {}) {
    return withDb((database) => {
      const bookId = importCollectedBookIntoDb(database, body);
      return inReadSnapshot(database, () => bookDetailFromDb(database, bookId));
    });
  }

  function writeIdentity() {
    return withReadDb(sourceRealmFromDb);
  }

  function reimportLocalBook(bookId, descriptor, prepared) {
    const record = prepared || loadLocalReimportArtifact(descriptor, options.reimportArtifactRoot);
    return withDb((database) => {
      reimportLocalBookIntoDb(database, bookId, descriptor, record);
      return inReadSnapshot(database, () => bookDetailFromDb(database, bookId));
    });
  }

  function writeIdentityRecord() {
    const before = databaseFileIdentity(dbPath);
    return withReadDb((database) => ({ sourceRealm: sourceRealmFromDb(database), databaseIdentity: stableDatabaseIdentity(before, databaseFileIdentity(dbPath)) }));
  }

  function executeWriteOperation(operation) {
    const methods = { saveProgress, updateBookMetadata, uploadBook, reimportBook, importCollectedBook, deleteBook, reimportLocalBook };
    const { operationId, method, args = [] } = operation || {};
    if (typeof operationId !== "string" || !operationId || operationId.length > 180 || !NOVEL_WRITE_METHODS.includes(method) || !Array.isArray(args)) {
      throw Object.assign(httpError(400, "小说写入请求无效"), { outcome: "not_committed" });
    }
    const requestHash = novelWriteOperationHash(method, args);
    const before = databaseFileIdentity(dbPath);
    const database = getDb();
    let transaction;
    let begun = false;
    try {
      // Materialize the large export before acquiring a SQLite write lock.
      // A known receipt needs no artifact, including after successful cleanup.
      const hasReceipts = method === "reimportLocalBook" && database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='novel_write_receipts'").get();
      const previousReceipt = hasReceipts && database.prepare("SELECT 1 FROM novel_write_receipts WHERE source_realm=? AND operation_id=?").get(sourceRealmFromDb(database), operationId);
      const prepared = method === "reimportLocalBook" && !previousReceipt ? loadLocalReimportArtifact(args[1], options.reimportArtifactRoot) : null;
      transaction = beginTransaction(database, "BEGIN IMMEDIATE");
      begun = true;
      writeOperationActive = true;
      const sourceRealm = sourceRealmFromDb(database);
      const databaseIdentity = stableDatabaseIdentity(before, databaseFileIdentity(dbPath));
      if (operation.sourceRealm !== undefined && operation.sourceRealm !== sourceRealm) throw httpError(409, "小说库来源已变化，不能重放原写入");
      options.onWriteOperationStart?.({ operationId, sourceRealm, databaseIdentity });
      // This additive table leaves the scanner's v5 schema contract unchanged.
      // The response and all book changes commit together, so a lost Worker
      // reply can be recovered without repeating an upload or chapter rewrite.
      ensureWriteReceiptSchema(database);
      const acknowledgedReceipts = deleteAcknowledgedReceipts(database, operation.acknowledgedReceipts, sourceRealm, databaseIdentity);
      const receipt = database.prepare("SELECT request_hash, response_json FROM novel_write_receipts WHERE source_realm = ? AND operation_id = ?").get(sourceRealm, operationId);
      let result;
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw httpError(409, "小说写入标识已用于不同请求");
        result = JSON.parse(receipt.response_json);
        if (operation.retainReceipt) database.prepare("UPDATE novel_write_receipts SET retain_receipt = 1 WHERE source_realm = ? AND operation_id = ?").run(sourceRealm, operationId);
      } else {
        result = method === "reimportLocalBook" ? reimportLocalBook(args[0], args[1], prepared) : methods[method](...args);
        database.prepare("INSERT INTO novel_write_receipts (source_realm, operation_id, request_hash, response_json, completed_at, retain_receipt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(sourceRealm, operationId, requestHash, JSON.stringify(result), new Date().toISOString(), Number(Boolean(operation.retainReceipt)));
      }
      commitTransaction(database, transaction);
      begun = false;
      return { result, sourceRealm, requestHash, databaseIdentity, acknowledgedReceipts };
    } catch (error) {
      if (begun) {
        try {
          rollbackTransaction(database, transaction);
          Object.assign(error, { rollbackConfirmed: true, outcome: "not_committed" });
        } catch (rollbackError) {
          throw Object.assign(new Error("小说写入回滚无法确认", { cause: new AggregateError([error, rollbackError]) }), {
            code: "NOVEL_WRITE_OUTCOME_UNKNOWN", statusCode: 503, outcome: "unknown", operationId
          });
        }
      } else if (!error.outcome) Object.assign(error, { outcome: "not_committed" });
      throw error;
    } finally {
      writeOperationActive = false;
      summaryStaticCache = null;
      closeDb();
    }
  }

  function readWriteReceipt({ operationId, requestHash, sourceRealm, databaseIdentity, acknowledgedReceipts = [] }) {
    const before = databaseFileIdentity(dbPath);
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      return inReadSnapshot(database, () => {
        validateExistingLibraryMetadata(database);
        const currentRealm = sourceRealmFromDb(database);
        const currentIdentity = stableDatabaseIdentity(before, databaseFileIdentity(dbPath));
        if (sourceRealm !== currentRealm) return { status: "realm_changed", sourceRealm: currentRealm };
        const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'novel_write_receipts'").get();
        const receipt = exists && database.prepare("SELECT request_hash, response_json FROM novel_write_receipts WHERE source_realm = ? AND operation_id = ?").get(sourceRealm, operationId);
        // An external restore can retain the realm and even the same inode
        // while losing a committed receipt. Absence never proves rollback.
        if (!receipt) return { status: databaseIdentity && databaseIdentity === currentIdentity ? "receipt_missing" : "database_changed", sourceRealm: currentRealm };
        if (receipt.request_hash !== requestHash) return { status: "conflict", sourceRealm: currentRealm };
        return { status: "committed", sourceRealm: currentRealm, databaseIdentity: currentIdentity, requestHash, result: JSON.parse(receipt.response_json), acknowledgedReceipts: acknowledgedReceipts.filter((token) => token.sourceRealm === currentRealm && token.databaseIdentity && token.databaseIdentity === currentIdentity) };
      });
    } finally {
      database.close();
    }
  }

  function releaseWriteReceipts(receipts) {
    const before = databaseFileIdentity(dbPath);
    if (!before) return [];
    // SQLite's URI mode=rw forbids CREATE, including a replacement race after
    // stat. Cleanup has no authority to initialize or migrate a novel library.
    const location = pathToFileURL(path.resolve(dbPath));
    location.searchParams.set("mode", "rw");
    const database = new DatabaseSync(location.href);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      return inTransaction(database, "BEGIN IMMEDIATE", () => {
        validateExistingLibraryMetadata(database);
        const sourceRealm = sourceRealmFromDb(database);
        const databaseIdentity = stableDatabaseIdentity(before, databaseFileIdentity(dbPath));
        const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'novel_write_receipts'").get();
        return exists ? deleteAcknowledgedReceipts(database, receipts, sourceRealm, databaseIdentity) : [];
      });
    } finally { database.close(); }
  }

  return {
    authorDetail,
    bookDetail,
    bookMeta,
    catalog,
    chapterDetail,
    deleteBook,
    dbPath,
    executeWriteOperation,
    importCollectedBook,
    openDownload,
    invalidate,
    listAuthors,
    listBooks,
    reimportBook,
    reimportLocalBook,
    readWriteReceipt,
    releaseWriteReceipts,
    saveProgress,
    writeIdentity,
    writeIdentityRecord,
    summary,
    updateBookMetadata,
    uploadBook
  };
}

function ensureSchema(db) {
  const existingIdentity = validateExistingLibraryMetadata(db);
  db.exec("PRAGMA busy_timeout = 5000");
  // A current library needs no DDL or writer lock just to read a chapter.
  // Keep checking each newly opened connection so external upgrades are seen.
  if (existingIdentity && Number(metaValue(db, "schema_version")) === 5) return;
  db.exec("PRAGMA journal_mode = WAL");
  inTransaction(db, "BEGIN IMMEDIATE", () => {
  validateExistingLibraryMetadata(db); // The writer lock may have waited behind an upgrade.
  db.exec(`
    CREATE TABLE IF NOT EXISTS novel_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS novel_books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      category TEXT,
      source_root TEXT NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      size_bytes INTEGER,
      mtime_ms INTEGER,
      encoding TEXT,
      char_count INTEGER,
      chapter_count INTEGER,
      first_chapter_id TEXT,
      latest_chapter_id TEXT,
      latest_chapter_title TEXT,
      summary TEXT,
      tags_json TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_novel_books_title ON novel_books(title);
    CREATE INDEX IF NOT EXISTS idx_novel_books_author ON novel_books(author);
    CREATE INDEX IF NOT EXISTS idx_novel_books_category ON novel_books(category);
    CREATE INDEX IF NOT EXISTS idx_novel_books_updated ON novel_books(updated_at);
    CREATE TABLE IF NOT EXISTS novel_chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(book_id, chapter_index)
    );
    CREATE INDEX IF NOT EXISTS idx_novel_chapters_book ON novel_chapters(book_id, chapter_index);
    CREATE TABLE IF NOT EXISTS novel_reading_state (
      book_id TEXT PRIMARY KEY,
      chapter_id TEXT,
      chapter_index INTEGER,
      scroll_ratio REAL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS novel_book_overrides (
      book_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      category TEXT,
      summary TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS novel_book_deletions (
      book_id TEXT PRIMARY KEY,
      source_path TEXT,
      title TEXT,
      deleted_at TEXT NOT NULL
    );
  `);
  const schemaVersion = Number(metaValue(db, "schema_version") || 0);
  if (schemaVersion < 2) {
    db.exec("DROP TABLE IF EXISTS novel_search");
  }
  if (schemaVersion < 5) migrateChapterSchema(db);
  // Concurrent initializers may propose different UUIDs; only the persisted
  // winner is ever exposed. Neither URLs nor book/file identities define a library.
  if (!existingIdentity) {
    db.prepare("INSERT INTO novel_meta (key, value) VALUES ('library_id', ?) ON CONFLICT(key) DO NOTHING").run(crypto.randomUUID());
  }
  sourceRealmFromDb(db);
  if (schemaVersion < 5) db.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('schema_version', '5')").run();
  });
}

function validateExistingLibraryMetadata(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'novel_meta'").get()) return;
  const versionRow = db.prepare("SELECT value FROM novel_meta WHERE key = 'schema_version'").get();
  if (versionRow) {
    const version = Number(versionRow.value);
    if (!Number.isInteger(version) || version < 0) throw new Error("小说库版本标记无效，未修改原库");
    if (version > 5) throw new Error("小说库来自更新版本，当前程序不能修改");
  }
  const identity = db.prepare("SELECT value FROM novel_meta WHERE key = 'library_id'").get();
  if (identity && (typeof identity.value !== "string" || !LIBRARY_ID_PATTERN.test(identity.value))) {
    throw new Error("小说库来源身份无效，未重新分配身份或修改原库");
  }
  return identity?.value;
}

function sourceRealmFromDb(db) {
  const identity = db.prepare("SELECT value FROM novel_meta WHERE key = 'library_id'").get();
  if (!identity || typeof identity.value !== "string" || !LIBRARY_ID_PATTERN.test(identity.value)) {
    throw new Error("小说库缺少有效的持久来源身份");
  }
  return `server:${identity.value}`;
}

function progressServerClock(database) {
  const floor = Number(metaValue(database, "progress_clock_ms") || 0);
  if (!Number.isSafeInteger(floor) || floor < 0) throw new Error("阅读进度时钟无效");
  return Math.max(Date.now(), floor);
}

function progressSession(body) {
  const fields = ["progressSessionId", "progressSessionStartedAt", "progressSequence"];
  if (!fields.some(field => Object.hasOwn(body, field))) return null;
  if (!fields.every(field => Object.hasOwn(body, field))
      || typeof body.progressSessionId !== "string" || !LIBRARY_ID_PATTERN.test(body.progressSessionId)
      || !Number.isSafeInteger(body.progressSessionStartedAt) || body.progressSessionStartedAt < 0
      || !Number.isSafeInteger(body.progressSequence) || body.progressSequence < 1) {
    throw httpError(400, "阅读进度顺序标识无效");
  }
  return { id: body.progressSessionId, startedAt: body.progressSessionStartedAt, sequence: body.progressSequence };
}

// Lazy additive schema: current v5 read connections need neither DDL nor a
// writer lock. Sequence, cursor and operation receipt share the write transaction.
function acceptProgressSequence(database, bookId, revision, session) {
  const now = progressServerClock(database);
  if (session.startedAt > now) throw httpError(400, "阅读进度会话时间无效，请重新打开这本书");
  if (session.startedAt <= now - PROGRESS_SESSION_TTL_MS) throw Object.assign(httpError(409, "阅读进度会话已过期，请重新打开这本书"), { code: "NOVEL_PROGRESS_SESSION_EXPIRED" });
  database.exec(`CREATE TABLE IF NOT EXISTS novel_progress_sessions (
    book_id TEXT NOT NULL, catalog_revision TEXT NOT NULL, session_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, max_sequence INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, catalog_revision, session_id)
  ); CREATE INDEX IF NOT EXISTS idx_novel_progress_sessions_expiry ON novel_progress_sessions(expires_at)`);
  database.prepare("INSERT INTO novel_meta(key, value) VALUES ('progress_clock_ms', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
  // Never evict a valid high-water mark: an evicted session could otherwise
  // return as a new writer and resurrect a delayed packet.
  database.prepare(`DELETE FROM novel_progress_sessions WHERE expires_at <= ? OR NOT EXISTS (
    SELECT 1 FROM novel_books b WHERE b.id=novel_progress_sessions.book_id
      AND b.catalog_revision=novel_progress_sessions.catalog_revision AND b.status='ok'
  )`).run(now);
  const previous = database.prepare("SELECT started_at, max_sequence FROM novel_progress_sessions WHERE book_id=? AND catalog_revision=? AND session_id=?")
    .get(bookId, revision, session.id);
  if (previous && previous.started_at !== session.startedAt) throw httpError(409, "阅读进度会话标识已用于其他时间");
  if (previous && session.sequence <= previous.max_sequence) return false;
  if (!previous) {
    const total = database.prepare("SELECT COUNT(*) AS count FROM novel_progress_sessions").get().count;
    const bookTotal = database.prepare("SELECT COUNT(*) AS count FROM novel_progress_sessions WHERE book_id=?").get(bookId).count;
    if (total >= PROGRESS_SESSION_LIMIT || bookTotal >= PROGRESS_BOOK_SESSION_LIMIT) {
      throw Object.assign(httpError(503, "阅读进度保存繁忙，请稍后重试"), { code: "NOVEL_PROGRESS_BUSY" });
    }
  }
  database.prepare(`INSERT INTO novel_progress_sessions(book_id, catalog_revision, session_id, started_at, max_sequence, expires_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(book_id, catalog_revision, session_id) DO UPDATE SET max_sequence=excluded.max_sequence`)
    .run(bookId, revision, session.id, session.startedAt, session.sequence, session.startedAt + PROGRESS_SESSION_TTL_MS);
  return true;
}

export function novelWriteOperationHash(method, args) {
  return crypto.createHash("sha256").update(JSON.stringify([method, args])).digest("hex");
}

function ensureWriteReceiptSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS novel_write_receipts (
    source_realm TEXT NOT NULL, operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
    completed_at TEXT NOT NULL, retain_receipt INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (source_realm, operation_id)
  )`);
  if (!database.prepare("PRAGMA table_info(novel_write_receipts)").all().some((column) => column.name === "retain_receipt")) {
    database.exec("ALTER TABLE novel_write_receipts ADD COLUMN retain_receipt INTEGER NOT NULL DEFAULT 1");
  }
}

function deleteAcknowledgedReceipts(database, receipts = [], sourceRealm, databaseIdentity) {
  if (!Array.isArray(receipts) || !receipts.length || !databaseIdentity) return [];
  const remove = database.prepare("DELETE FROM novel_write_receipts WHERE source_realm = ? AND operation_id = ? AND request_hash = ? AND retain_receipt = 0");
  const acknowledged = receipts.filter((receipt) => receipt.sourceRealm === sourceRealm && receipt.databaseIdentity === databaseIdentity);
  for (const receipt of acknowledged) remove.run(receipt.sourceRealm, receipt.operationId, receipt.requestHash);
  return acknowledged;
}

function databaseFileIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return stat.ino ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : "";
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
function stableDatabaseIdentity(before, after) {
  return before && before !== after ? "" : after;
}

let savepointSequence = 0;
function beginTransaction(database, begin) {
  if (!database.isTransaction) {
    database.exec(begin);
    return null;
  }
  const savepoint = `novel_operation_${++savepointSequence}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  return savepoint;
}

function commitTransaction(database, savepoint) {
  database.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
}

function rollbackTransaction(database, savepoint) {
  if (savepoint) {
    database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } else database.exec("ROLLBACK");
}

function inTransaction(database, begin, callback) {
  const transaction = beginTransaction(database, begin);
  try {
    const result = callback(database);
    commitTransaction(database, transaction);
    return result;
  } catch (error) {
    try { rollbackTransaction(database, transaction); } catch {}
    throw error;
  }
}

function inReadSnapshot(database, callback) {
  return inTransaction(database, "BEGIN", () => {
    // Validate within the same snapshot as the response, including an upgrade
    // committed between opening the connection and beginning this transaction.
    validateExistingLibraryMetadata(database);
    return callback(database);
  });
}

function checkBookPreconditions(book, options) {
  if (options.sourceRealm !== undefined && options.sourceRealm !== book.sourceRealm) throw httpError(409, "小说库来源已变化，请重新打开");
  if (options.catalogRevision !== undefined && options.catalogRevision !== book.catalogRevision) throw httpError(409, "目录版本已变化，请刷新目录");
}

function migrateChapterSchema(database) {
  // DDL, all backfill and the version marker share the caller's transaction.
  // Do not rename legacy chapter IDs or rewrite any pre-v5 progress columns.
  database.exec(`
    ALTER TABLE novel_books ADD COLUMN catalog_revision TEXT;
    ALTER TABLE novel_books ADD COLUMN legacy_write_allowed INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE novel_reading_state ADD COLUMN catalog_revision TEXT;
    ALTER TABLE novel_reading_state ADD COLUMN status TEXT NOT NULL DEFAULT 'unresolved';
    ALTER TABLE novel_reading_state ADD COLUMN reason TEXT NOT NULL DEFAULT 'legacy_unverified';
    ALTER TABLE novel_reading_state ADD COLUMN anchor_json TEXT;
    ALTER TABLE novel_reading_state ADD COLUMN candidate_json TEXT;
  `);
  const invalid = database.prepare(`SELECT c.id FROM novel_chapters c LEFT JOIN novel_books b ON b.id = c.book_id
    WHERE b.id IS NULL OR typeof(c.id) != 'text' OR c.id = '' OR typeof(c.chapter_index) != 'integer'
      OR c.chapter_index < 1 OR typeof(c.title) != 'text' OR typeof(c.content) != 'text' LIMIT 1`).get();
  if (invalid) throw new Error("旧章节记录损坏，升级已回滚");
  for (const book of database.prepare("SELECT id FROM novel_books").iterate()) {
    database.prepare("UPDATE novel_books SET catalog_revision = ? WHERE id = ?").run(crypto.randomUUID(), book.id);
  }
  for (const row of database.prepare("SELECT * FROM novel_reading_state").iterate()) {
    const anchor = { chapterId: row.chapter_id ?? null, chapterIndex: row.chapter_index ?? null,
      scrollRatio: row.scroll_ratio ?? null, catalogRevision: null };
    database.prepare("UPDATE novel_reading_state SET anchor_json = ? WHERE book_id = ?").run(JSON.stringify(anchor), row.book_id);
  }
}

function metaValue(db, key) {
  try {
    return db.prepare("SELECT value FROM novel_meta WHERE key = ?").get(key)?.value || "";
  } catch {
    return "";
  }
}

function chapterList(db, bookId) {
  return db
    .prepare(
      `
      SELECT id, book_id, chapter_index, title, '' AS content, char_count, updated_at
      FROM novel_chapters
      WHERE book_id = ?
      ORDER BY chapter_index
    `
    )
    .all(bookId)
    .map((row) => publicChapter(row, false));
}

function uploadBookIntoDb(database, body = {}) {
  const fileName = safeFileName(body.fileName || body.file_name || body.name || "上传小说.txt");
  const text = normalizeUploadText(body.text ?? body.content ?? decodeBase64Text(body.contentBase64 ?? body.content_base64));
  if (!text) throw httpError(400, "上传内容为空");
  if (text.length > MAX_UPLOAD_TEXT_CHARS) throw httpError(413, "上传文本太大");

  const title = cleanTitle(body.title || path.parse(fileName).name);
  const author = String(body.author || detectAuthor(text) || "").trim().slice(0, 80);
  const category = String(body.category || UPLOAD_SOURCE_ROOT).trim().slice(0, 80) || UPLOAD_SOURCE_ROOT;
  const now = new Date().toISOString();
  const uploadKey = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
  const sourcePath = `upload://${uploadKey}/${fileName}`;
  const bookId = crypto.createHash("sha1").update(sourcePath).digest("hex").slice(0, 20);
  let chapters = splitUploadedChapters(text);
  const latestChapter = chapters[chapters.length - 1] || null;
  const summary = summarizeNovelText(chapters.slice(0, 2).map((chapter) => chapter.content).join("\n\n") || text);
  const sizeBytes = clampInteger(body.sizeBytes ?? body.size_bytes, Buffer.byteLength(text, "utf8"), 0, Number.MAX_SAFE_INTEGER);
  const tags = [category, UPLOAD_SOURCE_ROOT].filter(Boolean);

  const transaction = beginTransaction(database, "BEGIN IMMEDIATE");
  try {
    const replacement = prepareChapterReplacement(database, bookId, chapters);
    chapters = replacement.chapters;
    database
      .prepare(
        `
        INSERT INTO novel_books (
          id, title, author, category, source_root, source_path, relative_path, file_name,
          size_bytes, mtime_ms, encoding, char_count, chapter_count, first_chapter_id,
          latest_chapter_id, latest_chapter_title, summary, tags_json, status, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        bookId,
        title,
        author,
        category,
        UPLOAD_SOURCE_ROOT,
        sourcePath,
        fileName,
        fileName,
        sizeBytes,
        Date.now(),
        body.encoding || "browser-text",
        text.length,
        chapters.length,
        chapters[0]?.id || "",
        chapters[chapters.length - 1]?.id || "",
        latestChapter?.title || "",
        summary,
        JSON.stringify(tags),
        "ok",
        "",
        now
      );

    const insertChapter = database.prepare(
      `
      INSERT INTO novel_chapters (id, book_id, chapter_index, title, content, char_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    );
    for (const chapter of chapters) {
      const id = chapter.id;
      insertChapter.run(id, bookId, chapter.index, chapter.title, chapter.content, chapter.content.length, now);
    }
    finishChapterReplacement(database, bookId, replacement);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('scanned_at', ?)").run(now);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('last_uploaded_at', ?)").run(now);
    commitTransaction(database, transaction);
  } catch (error) {
    try {
      rollbackTransaction(database, transaction);
    } catch {}
    throw error;
  }

  return bookId;
}

function reimportLocalBookIntoDb(database, bookId, descriptor, record) {
  const transaction = beginTransaction(database, "BEGIN IMMEDIATE");
  try {
    if (descriptor.bookId !== bookId || descriptor.sourceRealm !== sourceRealmFromDb(database)) throw httpError(409, "小说库来源已变化，请重新打开后再导入");
    const current = database.prepare("SELECT * FROM novel_books WHERE id=? AND status='ok'").get(bookId);
    if (!current || current.catalog_revision !== descriptor.catalogRevision) throw httpError(409, "书籍已删除或目录已更新，请重新打开后再导入");
    try {
      if (!samePath(fs.realpathSync(current.source_path), descriptor.sourcePath) || !samePath(fs.realpathSync(current.source_root), descriptor.sourceRoot)) throw new Error("changed");
    } catch { throw httpError(409, "书籍来源路径已变化，请重新打开后再导入"); }
    assertSourceSnapshot(descriptor);
    const replacement = prepareChapterReplacement(database, bookId, record.chapters);
    const chapters = replacement.chapters;
    database.prepare("DELETE FROM novel_chapters WHERE book_id=?").run(bookId);
    database.prepare("DELETE FROM novel_book_deletions WHERE book_id=?").run(bookId);
    const columns = ["title", "author", "category", "source_root", "source_path", "relative_path", "file_name", "size_bytes", "mtime_ms", "encoding", "char_count", "chapter_count", "summary", "tags_json", "status", "error", "updated_at"];
    database.prepare(`UPDATE novel_books SET ${columns.map((key) => `${key}=?`).join(",")}, first_chapter_id=?, latest_chapter_id=?, latest_chapter_title=? WHERE id=?`)
      .run(...columns.map((key) => record[key]), chapters[0].id, chapters.at(-1).id, chapters.at(-1).title, bookId);
    const insert = database.prepare("INSERT INTO novel_chapters (id,book_id,chapter_index,title,content,char_count,updated_at) VALUES (?,?,?,?,?,?,?)");
    for (const chapter of chapters) {
      const chars = chapter.content.length - (chapter.content.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length || 0);
      insert.run(chapter.id, bookId, chapter.index, chapter.title, chapter.content, chars, record.updated_at);
    }
    const override = database.prepare("SELECT title,author,category,summary FROM novel_book_overrides WHERE book_id=?").get(bookId);
    if (override) database.prepare("UPDATE novel_books SET title=?,author=?,category=?,summary=? WHERE id=?")
      .run(override.title || record.title, override.author || "", override.category || record.category, override.summary || "", bookId);
    finishChapterReplacement(database, bookId, replacement);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key,value) VALUES ('scanned_at',?)").run(record.updated_at);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key,value) VALUES ('last_reimported_at',?)").run(record.updated_at);
    assertSourceSnapshot(descriptor);
    commitTransaction(database, transaction);
  } catch (error) { try { rollbackTransaction(database, transaction); } catch {} throw error; }
}

function reimportBookIntoDb(database, bookId, body = {}) {
  const current = database.prepare("SELECT * FROM novel_books WHERE id = ? AND status = 'ok'").get(bookId);
  if (!current) return null;

  const text = normalizeUploadText(body.text ?? body.content ?? decodeBase64Text(body.contentBase64 ?? body.content_base64));
  if (!text) throw httpError(400, "重新导入内容为空");
  if (text.length > MAX_UPLOAD_TEXT_CHARS) throw httpError(413, "重新导入文本太大");

  const browserUpload = String(current.source_path || "").startsWith("upload://");
  const fileName = safeFileName(
    browserUpload
      ? body.fileName || body.file_name || body.name || current.file_name
      : current.file_name
  );
  const title = cleanTitle(body.title || (browserUpload ? path.parse(fileName).name : current.title));
  const author = String(
    Object.hasOwn(body, "author")
      ? body.author || ""
      : detectAuthor(text) || current.author || ""
  ).trim().slice(0, 80);
  const category = String(
    Object.hasOwn(body, "category")
      ? body.category || ""
      : current.category || UPLOAD_SOURCE_ROOT
  ).trim().slice(0, 80) || UPLOAD_SOURCE_ROOT;
  let chapters = splitUploadedChapters(text);
  const latestChapter = chapters[chapters.length - 1];
  const summary = String(
    Object.hasOwn(body, "summary")
      ? body.summary || ""
      : summarizeNovelText(chapters.slice(0, 2).map((chapter) => chapter.content).join("\n\n") || text)
  ).replace(/\s+/g, " ").trim().slice(0, 280);
  const sizeBytes = clampInteger(
    body.sizeBytes ?? body.size_bytes,
    Buffer.byteLength(text, "utf8"),
    0,
    Number.MAX_SAFE_INTEGER
  );
  const tags = [...new Set([...parseJsonArray(current.tags_json), category, current.source_root].filter(Boolean))];
  const override = database
    .prepare("SELECT title, author, category, summary FROM novel_book_overrides WHERE book_id = ?")
    .get(bookId);
  const now = new Date().toISOString();

  const transaction = beginTransaction(database, "BEGIN IMMEDIATE");
  try {
    const lockedBook = database.prepare("SELECT catalog_revision FROM novel_books WHERE id = ? AND status = 'ok'").get(bookId);
    if (!lockedBook || lockedBook.catalog_revision !== current.catalog_revision) throw httpError(409, "书籍已删除或目录已更新，请重新打开后再导入");
    const replacement = prepareChapterReplacement(database, bookId, chapters);
    chapters = replacement.chapters;
    database.prepare("DELETE FROM novel_chapters WHERE book_id = ?").run(bookId);
    database.prepare("DELETE FROM novel_book_deletions WHERE book_id = ?").run(bookId);
    database
      .prepare(
        `
        UPDATE novel_books
        SET title = ?, author = ?, category = ?, relative_path = ?, file_name = ?,
            size_bytes = ?, mtime_ms = ?, encoding = ?, char_count = ?, chapter_count = ?,
            first_chapter_id = ?, latest_chapter_id = ?, latest_chapter_title = ?,
            summary = ?, tags_json = ?, status = 'ok', error = '', updated_at = ?
        WHERE id = ?
      `
      )
      .run(
        title,
        author,
        category,
        browserUpload ? fileName : current.relative_path,
        fileName,
        sizeBytes,
        Date.now(),
        body.encoding || current.encoding || "browser-text",
        text.length,
        chapters.length,
        chapters[0].id,
        chapters[chapters.length - 1].id,
        latestChapter.title,
        summary,
        JSON.stringify(tags),
        now,
        bookId
      );

    const insertChapter = database.prepare(
      `
      INSERT INTO novel_chapters (id, book_id, chapter_index, title, content, char_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    );
    for (const chapter of chapters) {
      insertChapter.run(
        chapter.id,
        bookId,
        chapter.index,
        chapter.title,
        chapter.content,
        chapter.content.length,
        now
      );
    }
    if (override) {
      database
        .prepare("UPDATE novel_books SET title = ?, author = ?, category = ?, summary = ? WHERE id = ?")
        .run(
          override.title || title,
          override.author || "",
          override.category || category,
          override.summary || "",
          bookId
        );
    }
    finishChapterReplacement(database, bookId, replacement);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('scanned_at', ?)").run(now);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('last_reimported_at', ?)").run(now);
    commitTransaction(database, transaction);
  } catch (error) {
    try {
      rollbackTransaction(database, transaction);
    } catch {}
    throw error;
  }

  return bookId;
}

function importCollectedBookIntoDb(database, body = {}) {
  const sourceUrl = normalizeCollectionUrl(body.sourceUrl || body.source_url || body.url);
  const title = cleanTitle(body.title || "网页小说");
  const author = String(body.author || "").trim().slice(0, 80);
  const category = String(body.category || COLLECTION_SOURCE_ROOT).trim().slice(0, 80) || COLLECTION_SOURCE_ROOT;
  const adapterName = String(body.adapterName || body.adapter_name || body.adapterId || "").trim().slice(0, 80);
  let chapters = normalizeCollectedChapters(body.chapters);
  const totalChars = chapters.reduce((total, chapter) => total + chapter.content.length, 0);
  if (totalChars > MAX_UPLOAD_TEXT_CHARS) throw httpError(413, "采集正文超过 50 MiB 上限");
  const sourcePath = `collector://${crypto.createHash("sha1").update(sourceUrl).digest("hex")}`;
  const bookId = crypto.createHash("sha1").update(sourcePath).digest("hex").slice(0, 20);
  const latestChapter = chapters[chapters.length - 1];
  const summary = String(body.summary || summarizeNovelText(chapters.slice(0, 2).map((chapter) => chapter.content).join("\n\n")))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  const tags = [...new Set([category, COLLECTION_SOURCE_ROOT, adapterName].filter(Boolean))];
  const now = validIsoDate(body.collectedAt || body.collected_at) || new Date().toISOString();
  const fileName = safeFileName(`${title}.txt`);
  const override = database
    .prepare("SELECT title, author, category, summary FROM novel_book_overrides WHERE book_id = ?")
    .get(bookId);

  const transaction = beginTransaction(database, "BEGIN IMMEDIATE");
  try {
    const replacement = prepareChapterReplacement(database, bookId, chapters);
    chapters = replacement.chapters;
    database.prepare("DELETE FROM novel_chapters WHERE book_id = ?").run(bookId);
    database.prepare("DELETE FROM novel_book_deletions WHERE book_id = ?").run(bookId);
    database
      .prepare(
        `
        INSERT INTO novel_books (
          id, title, author, category, source_root, source_path, relative_path, file_name,
          size_bytes, mtime_ms, encoding, char_count, chapter_count, first_chapter_id,
          latest_chapter_id, latest_chapter_title, summary, tags_json, status, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', '', ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          author = excluded.author,
          category = excluded.category,
          source_root = excluded.source_root,
          source_path = excluded.source_path,
          relative_path = excluded.relative_path,
          file_name = excluded.file_name,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          encoding = excluded.encoding,
          char_count = excluded.char_count,
          chapter_count = excluded.chapter_count,
          first_chapter_id = excluded.first_chapter_id,
          latest_chapter_id = excluded.latest_chapter_id,
          latest_chapter_title = excluded.latest_chapter_title,
          summary = excluded.summary,
          tags_json = excluded.tags_json,
          status = 'ok',
          error = '',
          updated_at = excluded.updated_at
      `
      )
      .run(
        bookId,
        title,
        author,
        category,
        COLLECTION_SOURCE_ROOT,
        sourcePath,
        sourceUrl,
        fileName,
        Buffer.byteLength(chapters.map((chapter) => `${chapter.title}\n\n${chapter.content}`).join("\n\n"), "utf8"),
        Date.now(),
        "utf-8",
        totalChars,
        chapters.length,
        chapters[0].id,
        chapters[chapters.length - 1].id,
        latestChapter.title,
        summary,
        JSON.stringify(tags),
        now
      );

    const insertChapter = database.prepare(
      `
      INSERT INTO novel_chapters (id, book_id, chapter_index, title, content, char_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    );
    for (const chapter of chapters) {
      insertChapter.run(
        chapter.id,
        bookId,
        chapter.index,
        chapter.title,
        chapter.content,
        chapter.content.length,
        now
      );
    }
    if (override) {
      database
        .prepare("UPDATE novel_books SET title = ?, author = ?, category = ?, summary = ? WHERE id = ?")
        .run(
          override.title || title,
          override.author || "",
          override.category || category,
          override.summary || "",
          bookId
        );
    }
    finishChapterReplacement(database, bookId, replacement);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('scanned_at', ?)").run(now);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('last_collected_at', ?)").run(now);
    commitTransaction(database, transaction);
  } catch (error) {
    try {
      rollbackTransaction(database, transaction);
    } catch {}
    throw error;
  }

  return bookId;
}

function prepareChapterReplacement(database, bookId, incomingChapters) {
  const book = database.prepare("SELECT catalog_revision FROM novel_books WHERE id = ?").get(bookId);
  const oldChapters = database.prepare("SELECT id, chapter_index AS 'index', title, content FROM novel_chapters WHERE book_id = ? ORDER BY chapter_index").all(bookId);
  const row = database.prepare("SELECT * FROM novel_reading_state WHERE book_id = ?").get(bookId);
  const revision = crypto.randomUUID();
  const progress = row ? {
    status: row.status, reason: row.reason, chapterId: row.chapter_id, chapterIndex: row.chapter_index,
    scrollRatio: row.scroll_ratio, catalogRevision: row.catalog_revision,
    ...(row.anchor_json ? { previous: JSON.parse(row.anchor_json) } : {}),
    ...(oldChapters.find(chapter => chapter.id === row.chapter_id) ? { title: oldChapters.find(chapter => chapter.id === row.chapter_id).title } : {})
  } : null;
  const result = reconcileChapters({ oldChapters, incomingChapters, oldRevision: book?.catalog_revision, newRevision: revision, progress });
  return { ...result, revision, existed: Boolean(book) };
}

function finishChapterReplacement(database, bookId, replacement) {
  database.prepare("UPDATE novel_books SET catalog_revision = ?, legacy_write_allowed = ? WHERE id = ?")
    .run(replacement.revision, replacement.existed ? 0 : 1, bookId);
  const progress = replacement.progress;
  if (!progress) return;
  if (progress.status === "resolved") {
    database.prepare(`UPDATE novel_reading_state SET chapter_id = ?, chapter_index = ?, scroll_ratio = ?,
      catalog_revision = ?, status = 'resolved', reason = '', anchor_json = NULL, candidate_json = NULL WHERE book_id = ?`)
      .run(progress.chapterId, progress.chapterIndex, progress.scrollRatio, progress.catalogRevision, bookId);
  } else {
    database.prepare("UPDATE novel_reading_state SET status = ?, reason = ?, anchor_json = ?, candidate_json = ? WHERE book_id = ?")
      .run(progress.status, progress.reason, JSON.stringify(progress.previous), progress.candidate ? JSON.stringify(progress.candidate) : null, bookId);
  }
}

function normalizeCollectedChapters(value) {
  if (!Array.isArray(value) || !value.length) throw httpError(400, "采集结果没有章节");
  if (value.length > 20000) throw httpError(413, "采集章节超过 20000 章上限");
  const chapters = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const title = String(item.title || `第 ${chapters.length + 1} 章`)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) || `第 ${chapters.length + 1} 章`;
    const content = normalizeUploadText(item.content || item.body || "");
    if (!content) continue;
    chapters.push({
      index: chapters.length + 1,
      title,
      content
    });
  }
  if (!chapters.length) throw httpError(400, "采集结果没有有效正文");
  return chapters;
}

function normalizeCollectionUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw httpError(400, "采集来源网址无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw httpError(400, "采集来源只支持 HTTP 或 HTTPS");
  parsed.hash = "";
  return parsed.toString();
}

function validIsoDate(value) {
  const text = String(value || "").trim();
  if (!text || !Number.isFinite(Date.parse(text))) return "";
  return new Date(text).toISOString();
}

function publicBook(row, sourceRealm) {
  const resolved = row.progress_status === "resolved" && row.progress_revision === row.catalog_revision;
  const recovery = row.progress_status && !resolved ? {
    status: row.progress_status === "needs_review" ? "needs_review" : "unresolved",
    reason: row.progress_reason || "stale_revision",
    previous: row.progress_anchor ? JSON.parse(row.progress_anchor) : {
      chapterId: row.progress_chapter_id ?? null, chapterIndex: row.progress_chapter_index ?? null,
      scrollRatio: row.progress_scroll_ratio ?? null, catalogRevision: row.progress_revision ?? null
    },
    ...(row.progress_candidate ? { candidate: JSON.parse(row.progress_candidate) } : {})
  } : null;
  return {
    id: row.id,
    ...(sourceRealm ? { sourceRealm } : {}),
    catalogRevision: row.catalog_revision || null,
    title: row.title || "",
    author: row.author || "",
    category: row.category || "全部",
    sourceRoot: row.source_root || "",
    sourcePath: row.source_path || "",
    relativePath: row.relative_path || "",
    fileName: row.file_name || "",
    sizeBytes: Number(row.size_bytes || 0),
    mtimeMs: Number(row.mtime_ms || 0),
    encoding: row.encoding || "",
    charCount: Number(row.char_count || 0),
    chapterCount: Number(row.chapter_count || 0),
    firstChapterId: row.first_chapter_id || "",
    latestChapterId: row.latest_chapter_id || "",
    latestChapterTitle: row.latest_chapter_title || "",
    summary: row.summary || "",
    tags: parseJsonArray(row.tags_json),
    updatedAt: row.updated_at || "",
    progressRecovery: recovery,
    progress: resolved && row.progress_chapter_index
      ? {
          status: "resolved",
          chapterId: row.progress_chapter_id,
          catalogRevision: row.progress_revision,
          chapterIndex: Number(row.progress_chapter_index || 0),
          scrollRatio: Number(row.progress_scroll_ratio || 0),
          updatedAt: row.progress_updated_at || ""
        }
      : null
  };
}

function publicChapter(row, includeContent) {
  return {
    id: row.id,
    bookId: row.book_id,
    index: Number(row.chapter_index || 0),
    title: row.title || `第 ${row.chapter_index || ""} 章`,
    content: includeContent ? row.content || "" : "",
    charCount: Number(row.char_count || 0),
    updatedAt: row.updated_at || ""
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function normalizeSort(value) {
  const sort = String(value || "updated").trim();
  return ["updated", "title", "size", "chars", "chapters", "progress"].includes(sort) ? sort : "updated";
}

function normalizeAuthorSort(value) {
  const sort = String(value || "books").trim();
  return ["books", "name", "chapters", "size", "updated"].includes(sort) ? sort : "books";
}

function authorOrderSql(sort) {
  if (sort === "name") return "ORDER BY name COLLATE NOCASE ASC";
  if (sort === "chapters") return "ORDER BY chapter_count DESC, name COLLATE NOCASE ASC";
  if (sort === "size") return "ORDER BY size_bytes DESC, name COLLATE NOCASE ASC";
  if (sort === "updated") return "ORDER BY updated_at DESC, name COLLATE NOCASE ASC";
  return "ORDER BY book_count DESC, name COLLATE NOCASE ASC";
}

function bookOrderSql(sort) {
  if (sort === "title") return "ORDER BY b.title COLLATE NOCASE ASC";
  if (sort === "size") return "ORDER BY b.size_bytes DESC, b.title COLLATE NOCASE ASC";
  if (sort === "chars") return "ORDER BY b.char_count DESC, b.title COLLATE NOCASE ASC";
  if (sort === "chapters") return "ORDER BY b.chapter_count DESC, b.title COLLATE NOCASE ASC";
  if (sort === "progress") return "ORDER BY s.updated_at IS NULL ASC, s.updated_at DESC, b.updated_at DESC";
  return "ORDER BY b.updated_at DESC, b.title COLLATE NOCASE ASC";
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, (item) => `\\${item}`);
}

function decodeBase64Text(value) {
  if (!value) return "";
  const payload = String(value).replace(/^data:[^,]+,/, "");
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function normalizeUploadText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t　]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanTitle(value) {
  const stem = String(value || "小说").trim();
  const cleaned = stem
    .replace(/[_\-\s]*(?:fixed|format|formatted|utf8|utf-8|精校|校对版|完结)\s*$/iu, "")
    .replace(/^[\[(【（].{1,16}[\])】）]\s*/u, "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  return cleaned || stem || "小说";
}

function safeFileName(value) {
  const parsed = path.basename(String(value || "小说.txt")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  const fileName = parsed || "小说.txt";
  const baseName = path.parse(fileName).name || "小说";
  return `${baseName.slice(0, 176)}.txt`;
}

function detectAuthor(text) {
  const lines = String(text || "").split("\n").slice(0, 120);
  for (const line of lines) {
    const match = line.trim().match(/^(?:作者|原作者|Author|writer)\s*[:：]\s*(.+)$/iu);
    if (match?.[1] && match[1].trim().length <= 80) return match[1].trim();
  }
  return "";
}

function splitUploadedChapters(text) {
  const chapters = [];
  let currentTitle = "";
  let currentLines = [];
  const leadingLines = [];

  function flush() {
    if (!currentTitle) return;
    const content = chapterContentFromLines(currentLines) || currentTitle;
    chapters.push({ index: chapters.length + 1, title: currentTitle, content });
    currentTitle = "";
    currentLines = [];
  }

  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (line && line.length <= 90 && isChapterTitle(line)) {
      if (!currentTitle && leadingLines.some((item) => item.trim())) {
        currentTitle = "序章";
        currentLines = leadingLines.splice(0, leadingLines.length);
      }
      flush();
      currentTitle = line;
      currentLines = [];
      continue;
    }
    if (currentTitle) currentLines.push(rawLine);
    else leadingLines.push(rawLine);
  }
  flush();
  return chapters.length ? chapters : chunkPlainText(text);
}

function chunkPlainText(text) {
  const paragraphs = paragraphsFromNovelText(text);
  const chapters = [];
  let current = [];
  let currentLength = 0;
  for (const paragraph of paragraphs) {
    if (current.length && currentLength + paragraph.length > MAX_CHAPTER_CHARS) {
      const index = chapters.length + 1;
      chapters.push({ index, title: chapters.length ? `正文 ${index}` : "正文", content: current.join("\n\n") });
      current = [];
      currentLength = 0;
    }
    current.push(paragraph);
    currentLength += paragraph.length;
  }
  if (current.length) {
    const index = chapters.length + 1;
    chapters.push({ index, title: chapters.length ? `正文 ${index}` : "正文", content: current.join("\n\n") });
  }
  if (!chapters.length) chapters.push({ index: 1, title: "正文", content: String(text || "").trim() || "空白章节" });
  return chapters;
}

function chapterContentFromLines(lines) {
  return String(lines.join("\n") || "")
    .split(/\n\s*\n+/)
    .flatMap((part) => part.split("\n").map((line) => line.trim()).filter(Boolean))
    .join("\n\n")
    .trim();
}

function paragraphsFromNovelText(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  const blocks = source.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  return source.split("\n").map((line) => line.trim()).filter(Boolean);
}

function summarizeNovelText(text) {
  const parts = [];
  for (const paragraph of paragraphsFromNovelText(text)) {
    if (isChapterTitle(paragraph)) continue;
    if (/^(?:作者|书名|标题|来源|网址|链接)\s*[:：]/iu.test(paragraph)) continue;
    if (/(?:本作品来自互联网|内容版权归作者所有|更多好书|推广链接|https?:\/\/)/iu.test(paragraph)) continue;
    parts.push(paragraph);
    if (parts.join("").length >= 260) break;
  }
  return parts.join("").replace(/\s+/g, " ").trim().slice(0, 280);
}

function isChapterTitle(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 90) return false;
  return /^(?:第\s*[\d零〇一二两兩三四五六七八九十百千万萬壹贰貳叁參肆伍陆陸柒捌玖拾佰仟\s]{1,18}\s*(?:章|章节|节|回|话|卷|部|篇|幕)|(?:序章|序言|楔子|正文|尾声|后记|後記|番外|番外篇|外传|外傳|前传|前傳|间章|間章|特别篇|特别章|大结局|全书完|全文完)(?:\s|$|[:：]))/iu.test(text);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clampInteger(value, fallback, min, max) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
