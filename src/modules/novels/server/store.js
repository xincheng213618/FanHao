import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 5000;
const MAX_CHAPTER_CHARS = 12000;
const MAX_UPLOAD_TEXT_CHARS = 50 * 1024 * 1024;
const UPLOAD_SOURCE_ROOT = "上传";

export function createNovelStore(options = {}) {
  const dbPath = options.dbPath;
  if (!dbPath) throw new Error("novel dbPath is required");
  let db = null;

  function getDb() {
    if (!db) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      ensureSchema(db);
    }
    return db;
  }

  function withDb(callback) {
    const database = getDb();
    try {
      return callback(database);
    } finally {
      invalidate();
    }
  }

  function invalidate() {
    if (!db) return;
    try {
      db.close();
    } catch {}
    db = null;
  }

  function summary() {
    return withDb((database) => summaryFromDb(database));
  }

  function summaryFromDb(database) {
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
    const recent = database
      .prepare(
        `
        SELECT b.*, s.chapter_index AS progress_chapter_index, s.scroll_ratio AS progress_scroll_ratio, s.updated_at AS progress_updated_at
        FROM novel_reading_state s
        JOIN novel_books b ON b.id = s.book_id
        WHERE b.status = 'ok'
        ORDER BY s.updated_at DESC
        LIMIT 6
      `
      )
      .all()
      .map(publicBook);
    return {
      dbPath,
      scannedAt: metaValue(database, "scanned_at"),
      roots,
      totals: {
        books: Number(totals.books || 0),
        authors: Number(totals.authors || 0),
        chapters: Number(totals.chapters || 0),
        chars: Number(totals.chars || 0),
        bytes: Number(totals.bytes || 0),
        updatedAt: totals.updated_at || ""
      },
      categories: categories.map((row) => ({ name: row.name || "全部", count: Number(row.count || 0) })),
      recent
    };
  }

  function listBooks(url) {
    return withDb((database) => {
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
          SELECT b.*, s.chapter_index AS progress_chapter_index, s.scroll_ratio AS progress_scroll_ratio, s.updated_at AS progress_updated_at
          FROM novel_books b
          LEFT JOIN novel_reading_state s ON s.book_id = b.id
          ${where}
          ${order}
          LIMIT ? OFFSET ?
        `
        )
        .all(...params, limit, offset);
      const facets = database
        .prepare(
          `
          SELECT COALESCE(category, '全部') AS name, COUNT(*) AS count
          FROM novel_books
          WHERE status = 'ok'
          GROUP BY COALESCE(category, '全部')
          ORDER BY count DESC, name COLLATE NOCASE
        `
        )
        .all()
        .map((row) => ({ name: row.name || "全部", count: Number(row.count || 0) }));
      return {
        books: rows.map(publicBook),
        total: Number(countRow?.count || 0),
        limit,
        offset,
        query,
        category,
        author,
        readingOnly,
        sort,
        facets,
        summary: summaryFromDb(database)
      };
    });
  }

  function listAuthors(url) {
    return withDb((database) => {
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
    const page = listBooks(requestUrl);
    const profile = withDb((database) => {
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
      return row
        ? {
            name: row.name || author,
            bookCount: Number(row.book_count || 0),
            chapterCount: Number(row.chapter_count || 0),
            charCount: Number(row.char_count || 0),
            sizeBytes: Number(row.size_bytes || 0),
            updatedAt: row.updated_at || ""
          }
        : null;
    });
    if (!profile) return null;
    return { ...page, author: profile };
  }

  function bookDetail(bookId) {
    return withDb((database) => bookDetailFromDb(database, bookId));
  }

  function bookMeta(bookId) {
    return withDb((database) => {
      const book = bookRecordFromDb(database, bookId);
      return book
        ? { book, chapters: [], chapterTotal: Number(book.chapterCount || 0), catalogLoaded: false }
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
      database.exec("BEGIN IMMEDIATE");
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
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      return bookRecordFromDb(database, bookId);
    });
  }

  function deleteBook(bookId) {
    return withDb((database) => {
      const book = database
        .prepare("SELECT id, title, source_path FROM novel_books WHERE id = ? AND status = 'ok'")
        .get(bookId);
      if (!book) return null;
      const deletedAt = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
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
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
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
      book,
      chapters: chapterList(database, bookId)
    };
  }

  function bookRecordFromDb(database, bookId) {
    const row = database
      .prepare(
        `
        SELECT b.*, s.chapter_index AS progress_chapter_index, s.scroll_ratio AS progress_scroll_ratio, s.updated_at AS progress_updated_at
        FROM novel_books b
        LEFT JOIN novel_reading_state s ON s.book_id = b.id
        WHERE b.id = ? AND b.status = 'ok'
      `
      )
      .get(bookId);
    return row ? publicBook(row) : null;
  }

  function chapterDetail(bookId, chapterIndex) {
    return withDb((database) => {
      const book = bookRecordFromDb(database, bookId);
      if (!book) return null;
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
    return withDb((database) => {
      const book = bookRecordFromDb(database, bookId);
      if (!book) return null;
      const query = String(url?.searchParams?.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const order = String(url?.searchParams?.get("order") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
      const limit = clampInteger(url?.searchParams?.get("limit"), 120, 20, 200);
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
      let offset = requestedOffset;
      if (!query && anchor > 0 && filteredTotal > 0) {
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
        bookId,
        chapters,
        total: Number(book.chapterCount || 0),
        filteredTotal,
        limit,
        offset,
        query,
        order,
        firstIndex: chapters[0]?.index || 0,
        lastIndex: chapters[chapters.length - 1]?.index || 0
      };
    });
  }

  function saveProgress(bookId, body = {}) {
    return withDb((database) => {
      const chapterIndex = clampInteger(body.chapterIndex ?? body.chapter_index, 1, 1, Number.MAX_SAFE_INTEGER);
      const chapter = database.prepare("SELECT id, chapter_index FROM novel_chapters WHERE book_id = ? AND chapter_index = ?").get(bookId, chapterIndex);
      if (!chapter) return null;
      const ratio = Math.max(0, Math.min(1, Number(body.scrollRatio ?? body.scroll_ratio ?? 0) || 0));
      const updatedAt = new Date().toISOString();
      database
        .prepare(
          `
          INSERT INTO novel_reading_state (book_id, chapter_id, chapter_index, scroll_ratio, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(book_id) DO UPDATE SET
            chapter_id = excluded.chapter_id,
            chapter_index = excluded.chapter_index,
            scroll_ratio = excluded.scroll_ratio,
            updated_at = excluded.updated_at
        `
        )
        .run(bookId, chapter.id, Number(chapter.chapter_index), ratio, updatedAt);
      return { bookId, chapterId: chapter.id, chapterIndex: Number(chapter.chapter_index), scrollRatio: ratio, updatedAt };
    });
  }

  function openDownload(bookId) {
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const book = bookRecordFromDb(database, bookId);
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
      return bookDetailFromDb(database, bookId);
    });
  }

  return {
    authorDetail,
    bookDetail,
    bookMeta,
    catalog,
    chapterDetail,
    deleteBook,
    dbPath,
    openDownload,
    invalidate,
    listAuthors,
    listBooks,
    saveProgress,
    summary,
    updateBookMetadata,
    uploadBook
  };
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
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
  if (schemaVersion < 4) db.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('schema_version', '4')").run();
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
  const chapters = splitUploadedChapters(text);
  const firstChapter = chapters[0] || null;
  const latestChapter = chapters[chapters.length - 1] || null;
  const summary = summarizeNovelText(chapters.slice(0, 2).map((chapter) => chapter.content).join("\n\n") || text);
  const sizeBytes = clampInteger(body.sizeBytes ?? body.size_bytes, Buffer.byteLength(text, "utf8"), 0, Number.MAX_SAFE_INTEGER);
  const tags = [category, UPLOAD_SOURCE_ROOT].filter(Boolean);

  database.exec("BEGIN IMMEDIATE");
  try {
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
        firstChapter ? chapterId(bookId, firstChapter.index) : "",
        latestChapter ? chapterId(bookId, latestChapter.index) : "",
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
      const id = chapterId(bookId, chapter.index);
      insertChapter.run(id, bookId, chapter.index, chapter.title, chapter.content, chapter.content.length, now);
    }
    database.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('scanned_at', ?)").run(now);
    database.prepare("INSERT OR REPLACE INTO novel_meta (key, value) VALUES ('last_uploaded_at', ?)").run(now);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  return bookId;
}

function publicBook(row) {
  return {
    id: row.id,
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
    progress: row.progress_chapter_index
      ? {
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

function chapterId(bookId, index) {
  return `${bookId}-${String(index).padStart(5, "0")}`;
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
