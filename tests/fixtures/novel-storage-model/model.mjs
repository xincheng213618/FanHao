// UNCONNECTED DESIGN SANDBOX. This is not the Android storage implementation.
// Only synthetic legacy rows are supplied by the verifier; no production path.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const VERSION = 2; // Sandbox-private schema marker, unrelated to production IDB versions.
const IMPORTED_TYPES = new Set(["local-file", "native-file", "shared-text", "system-picker", "document-tree"]);
const SCHEMA = `
CREATE TABLE works (
  work_id TEXT PRIMARY KEY, library_id TEXT NOT NULL,
  UNIQUE(library_id, work_id)
);
CREATE TABLE editions (
  edition_id TEXT PRIMARY KEY, library_id TEXT NOT NULL, work_id TEXT NOT NULL,
  realm TEXT, binding TEXT NOT NULL CHECK(binding IN ('bound','unbound')),
  kind TEXT NOT NULL CHECK(kind IN ('imported','remote-cache','unknown')),
  retention TEXT NOT NULL CHECK(retention IN ('durable','reclaimable','protected')),
  title TEXT NOT NULL, author TEXT NOT NULL, category TEXT NOT NULL,
  file_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  chapter_count INTEGER NOT NULL CHECK(chapter_count > 0), char_count INTEGER NOT NULL,
  UNIQUE(library_id, edition_id),
  FOREIGN KEY(library_id, work_id) REFERENCES works(library_id, work_id) ON DELETE CASCADE,
  CHECK((binding = 'unbound' AND realm IS NULL) OR (binding = 'bound' AND realm IS NOT NULL)),
  CHECK(retention != 'reclaimable' OR (kind = 'remote-cache' AND binding = 'bound')),
  CHECK(kind != 'imported' OR retention = 'durable')
);
CREATE TABLE chapters (
  chapter_id TEXT PRIMARY KEY, library_id TEXT NOT NULL, edition_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0), legacy_index INTEGER NOT NULL,
  legacy_chapter_id TEXT, title TEXT NOT NULL, char_count INTEGER NOT NULL,
  UNIQUE(library_id, edition_id, chapter_id), UNIQUE(library_id, edition_id, ordinal),
  UNIQUE(library_id, edition_id, legacy_index),
  FOREIGN KEY(library_id, edition_id) REFERENCES editions(library_id, edition_id) ON DELETE CASCADE
);
CREATE TABLE chapter_bodies (
  library_id TEXT NOT NULL, edition_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
  content TEXT NOT NULL, PRIMARY KEY(library_id, edition_id, chapter_id),
  FOREIGN KEY(library_id, edition_id, chapter_id) REFERENCES chapters(library_id, edition_id, chapter_id) ON DELETE CASCADE
);
CREATE TABLE progress (
  library_id TEXT NOT NULL, edition_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('resolved','unresolved')), chapter_id TEXT,
  scroll_ratio REAL, raw_position_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL, PRIMARY KEY(library_id, edition_id),
  FOREIGN KEY(library_id, edition_id) REFERENCES editions(library_id, edition_id) ON DELETE CASCADE,
  FOREIGN KEY(library_id, edition_id, chapter_id) REFERENCES chapters(library_id, edition_id, chapter_id),
  CHECK((status = 'resolved' AND chapter_id IS NOT NULL AND scroll_ratio IS NOT NULL AND scroll_ratio >= 0 AND scroll_ratio <= 1)
    OR (status = 'unresolved' AND chapter_id IS NULL AND scroll_ratio IS NULL))
);
CREATE TABLE shelf (
  library_id TEXT NOT NULL, edition_id TEXT NOT NULL, on_shelf INTEGER NOT NULL CHECK(on_shelf IN (0,1)),
  pinned INTEGER NOT NULL CHECK(pinned IN (0,1)), updated_at TEXT NOT NULL,
  PRIMARY KEY(library_id, edition_id),
  FOREIGN KEY(library_id, edition_id) REFERENCES editions(library_id, edition_id) ON DELETE CASCADE
);
CREATE TABLE legacy_aliases (
  library_id TEXT NOT NULL, realm TEXT, legacy_id TEXT NOT NULL, edition_id TEXT NOT NULL,
  FOREIGN KEY(library_id, edition_id) REFERENCES editions(library_id, edition_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX known_alias_tuple ON legacy_aliases(library_id, realm, legacy_id) WHERE realm IS NOT NULL;
CREATE UNIQUE INDEX unbound_alias_tuple ON legacy_aliases(library_id, legacy_id) WHERE realm IS NULL;
CREATE TABLE legacy_extensions (
  library_id TEXT NOT NULL, edition_id TEXT NOT NULL, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  properties_json TEXT NOT NULL, PRIMARY KEY(library_id, entity_kind, entity_id),
  FOREIGN KEY(library_id, edition_id) REFERENCES editions(library_id, edition_id) ON DELETE CASCADE
);
CREATE TABLE migrations (version INTEGER PRIMARY KEY, completed_at TEXT NOT NULL);
CREATE INDEX shelf_catalog ON shelf(library_id, on_shelf, edition_id);
`;

const EDITION_COLUMNS = `e.edition_id AS editionId, e.work_id AS workId, e.library_id AS libraryId,
  e.realm, e.binding, e.kind, e.retention, e.title, e.author, e.category, e.file_name AS fileName,
  e.created_at AS createdAt, e.updated_at AS updatedAt, e.chapter_count AS chapterCount, e.char_count AS charCount`;
const ENTRY_FIELDS = new Set(["id", "book", "chapters", "createdAt", "updatedAt", "bytes"]);
const BOOK_FIELDS = new Set(["id", "title", "author", "category", "fileName", "sourceFile", "sourceType", "progress", "updatedAt", "createdAt", "local", "chapterCount", "charCount", "latestChapterTitle"]);
const CHAPTER_FIELDS = new Set(["id", "bookId", "index", "chapterIndex", "title", "content", "charCount", "updatedAt"]);

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value; // Opaque identity: never URL-normalize, concatenate, or infer.
}
function authority(value) {
  if (value == null) return null;
  requiredText(value, "realm");
  if (!/^(device|server):[^\s]+$/.test(value)) throw new Error("realm must be an explicit device/server authority, not a URL");
  return value;
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`damaged ${name}`);
  return value;
}
function text(value, fallback = "") { return typeof value === "string" ? value : fallback; }
function extras(value, known) { return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key))); }
function legacyAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(["chapterId", "chapter_id", "chapterIndex", "chapter_index", "scrollRatio", "scroll_ratio", "updatedAt"]
    .filter((key) => Object.hasOwn(value, key) && (value[key] == null || ["string", "number", "boolean"].includes(typeof value[key])))
    .map((key) => [key, value[key]])); // Other legacy progress properties stay only in immutable raw JSON.
}
function limit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error("limit must be an integer in 1..1000");
  return value;
}

export class NovelStorageModel {
  constructor(filename, { libraryId }) {
    requiredText(filename, "sandbox filename");
    this.libraryId = requiredText(libraryId, "libraryId");
    // Exposed only so the verifier can apply the real SQLite authorizer.
    this.connection = new DatabaseSync(filename, { enableForeignKeyConstraints: true, timeout: 50 });
    this.connection.exec(`CREATE TABLE IF NOT EXISTS legacy_books (
      row_id TEXT PRIMARY KEY, library_id TEXT NOT NULL, realm TEXT, legacy_id TEXT NOT NULL, raw_json TEXT NOT NULL
    )`);
  }

  close() { this.connection.close(); }
  _get(sql, ...args) { return this.connection.prepare(sql).get(...args); }
  _all(sql, ...args) { return this.connection.prepare(sql).all(...args); }
  _run(sql, ...args) { return this.connection.prepare(sql).run(...args); }
  _version() { return this._get("PRAGMA user_version").user_version; }
  _ready() { if (this._version() !== VERSION) throw new Error("model migration is not complete"); }
  _transaction(action, beforeCommit = () => {}) {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      beforeCommit();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  seedLegacy(records) {
    if (this._version() !== 0) throw new Error("legacy seeding is only permitted before model migration");
    this._transaction(() => {
      for (const record of records) {
        if (typeof record.rawJson !== "string") throw new Error("legacy rawJson must be supplied verbatim");
        this._run("INSERT INTO legacy_books VALUES (?, ?, ?, ?, ?)",
          requiredText(record.rowId, "rowId"), requiredText(record.libraryId, "libraryId"), authority(record.realm),
          requiredText(record.legacyId, "legacyId"), record.rawJson);
      }
    });
  }

  migrateLegacy({ failpoint = () => {} } = {}) {
    if (this._version() === VERSION) {
      if (!this._get("SELECT version FROM migrations WHERE version = ?", VERSION)) throw new Error("damaged migration marker");
      return { migrated: false, version: VERSION };
    }
    if (this._version() !== 0) throw new Error("unsupported model version; original data retained");
    return this._transaction(() => {
      this.connection.exec(SCHEMA);
      failpoint("after-schema");
      let migrated = 0;
      // One legacy aggregate at a time. This is not streaming within its JSON.
      for (const row of this.connection.prepare("SELECT * FROM legacy_books ORDER BY row_id").iterate()) {
        this._migrateRow(row, failpoint);
        migrated++;
        failpoint("after-book", { rowId: row.row_id, count: migrated });
      }
      this._run("INSERT INTO migrations VALUES (?, ?)", VERSION, new Date().toISOString());
      this.connection.exec("PRAGMA user_version = 2");
      failpoint("after-marker");
      return { migrated: true, version: VERSION, books: migrated };
    }, () => failpoint("before-commit"));
  }

  _migrateRow(row, failpoint) {
    const entry = object(JSON.parse(row.raw_json), "legacy entry");
    const book = object(entry.book, "legacy book");
    if (book.id !== row.legacy_id || (entry.id != null && entry.id !== book.id)) throw new Error("damaged legacy identity");
    requiredText(book.title, "legacy title");
    if (!Array.isArray(entry.chapters) || !entry.chapters.length) throw new Error("damaged legacy chapters");
    const realm = authority(row.realm);
    const kind = book.sourceType === "remote-cache" ? "remote-cache" : IMPORTED_TYPES.has(book.sourceType) ? "imported" : "unknown";
    const binding = realm == null ? "unbound" : "bound";
    const retention = kind === "imported" ? "durable" : kind === "remote-cache" && realm != null ? "reclaimable" : "protected";
    const workId = randomUUID(), editionId = randomUUID();
    const legacyIndices = new Map();
    let charCount = 0;
    const chapters = entry.chapters.map((input, index) => {
      const chapter = object(input, "legacy chapter");
      if (chapter.bookId != null && chapter.bookId !== book.id) throw new Error("damaged legacy chapter parent identity");
      const oldIndex = chapter.index ?? chapter.chapterIndex;
      if (!Number.isInteger(oldIndex) || oldIndex < 1 || legacyIndices.has(oldIndex)) throw new Error("damaged or duplicate legacy chapter index");
      if (typeof chapter.content !== "string" || !chapter.content.trim()) throw new Error("damaged legacy chapter body");
      const chapterId = randomUUID(); legacyIndices.set(oldIndex, chapterId); charCount += chapter.content.length;
      return { input: chapter, chapterId, oldIndex, ordinal: index + 1 };
    });
    const now = new Date().toISOString();
    this._run("INSERT INTO works VALUES (?, ?)", workId, row.library_id);
    this._run("INSERT INTO editions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      editionId, row.library_id, workId, realm, binding, kind, retention,
      book.title, text(book.author), text(book.category), text(book.fileName, text(book.sourceFile)),
      text(entry.createdAt, now), text(entry.updatedAt, text(book.updatedAt, now)), chapters.length, charCount);
    this._run("INSERT INTO legacy_aliases VALUES (?, ?, ?, ?)", row.library_id, realm, row.legacy_id, editionId);
    this._extensions(row.library_id, editionId, "entry", editionId, extras(entry, ENTRY_FIELDS));
    this._extensions(row.library_id, editionId, "book", editionId, extras(book, BOOK_FIELDS));
    for (const { input, chapterId, oldIndex, ordinal } of chapters) {
      this._run("INSERT INTO chapters VALUES (?, ?, ?, ?, ?, ?, ?, ?)", chapterId, row.library_id, editionId,
        ordinal, oldIndex, typeof input.id === "string" ? input.id : null, text(input.title, `正文 ${ordinal}`), input.content.length);
      this._run("INSERT INTO chapter_bodies VALUES (?, ?, ?, ?)", row.library_id, editionId, chapterId, input.content);
      this._extensions(row.library_id, editionId, "chapter", chapterId, extras(input, CHAPTER_FIELDS));
      failpoint("after-chapter", { rowId: row.row_id, ordinal, editionId, chapterId });
    }
    if (Object.hasOwn(book, "progress")) {
      const old = book.progress;
      const oldIndex = old?.chapterIndex ?? old?.chapter_index;
      const ratio = old?.scrollRatio ?? old?.scroll_ratio ?? 0;
      const chapterId = Number.isInteger(oldIndex) ? legacyIndices.get(oldIndex) : null;
      const oldChapterId = old?.chapterId ?? old?.chapter_id;
      const coherent = oldChapterId == null || oldChapterId === chapters.find((chapter) => chapter.oldIndex === oldIndex)?.input.id;
      const resolved = Boolean(chapterId) && coherent && typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
      this._run("INSERT INTO progress VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row.library_id, editionId,
        resolved ? "resolved" : "unresolved", resolved ? chapterId : null, resolved ? ratio : null,
        JSON.stringify(legacyAnchor(old)), 1, text(old?.updatedAt, now));
    }
    this._run("INSERT INTO shelf VALUES (?, ?, ?, ?, ?)", row.library_id, editionId, 1, 0, now);
  }

  _extensions(libraryId, editionId, kind, entityId, properties) {
    this._run("INSERT INTO legacy_extensions VALUES (?, ?, ?, ?, ?)", libraryId, editionId, kind, entityId, JSON.stringify(properties));
  }

  resolveLegacyAlias({ realm = null, legacyId }) {
    this._ready(); authority(realm); requiredText(legacyId, "legacyId");
    const row = this._get("SELECT edition_id AS editionId FROM legacy_aliases WHERE library_id = ? AND realm IS ? AND legacy_id = ?", this.libraryId, realm, legacyId);
    return row ? { bookKey: row.editionId, editionId: row.editionId } : null;
  }

  listShelf({ limit: pageSize = 100, afterEditionId = "" } = {}) {
    this._ready(); limit(pageSize);
    return this._all(`SELECT ${EDITION_COLUMNS}, s.pinned,
      p.status AS progressStatus, p.chapter_id AS progressChapterId, p.scroll_ratio AS progressRatio
      FROM editions e JOIN shelf s ON s.library_id=e.library_id AND s.edition_id=e.edition_id
      LEFT JOIN progress p ON p.library_id=e.library_id AND p.edition_id=e.edition_id
      WHERE e.library_id = ? AND s.on_shelf = 1 AND e.edition_id > ? ORDER BY e.edition_id LIMIT ?`,
    this.libraryId, afterEditionId, pageSize).map((row) => ({ ...row, bookKey: row.editionId, pinned: Boolean(row.pinned) }));
  }

  listChapters(bookKey, { limit: pageSize = 100, afterOrdinal = 0 } = {}) {
    this._ready(); requiredText(bookKey, "editionId bookKey"); limit(pageSize);
    if (!Number.isInteger(afterOrdinal) || afterOrdinal < 0) throw new Error("invalid ordinal page cursor");
    return this._all(`SELECT chapter_id AS chapterId, edition_id AS editionId, ordinal, title, char_count AS charCount
      FROM chapters WHERE library_id = ? AND edition_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?`, this.libraryId, bookKey, afterOrdinal, pageSize);
  }

  readChapter(bookKey, chapterId) {
    this._ready(); requiredText(bookKey, "editionId bookKey"); requiredText(chapterId, "chapterId");
    return this._get(`SELECT c.chapter_id AS chapterId, c.edition_id AS editionId, c.ordinal, c.title, b.content
      FROM chapters c JOIN chapter_bodies b ON b.library_id=c.library_id AND b.edition_id=c.edition_id AND b.chapter_id=c.chapter_id
      WHERE c.library_id = ? AND c.edition_id = ? AND c.chapter_id = ?`, this.libraryId, bookKey, chapterId) || null;
  }

  readProgress(bookKey) {
    this._ready(); requiredText(bookKey, "editionId bookKey");
    const row = this._get(`SELECT status, chapter_id AS chapterId, scroll_ratio AS scrollRatio,
      raw_position_json AS rawPositionJson, revision, updated_at AS updatedAt
      FROM progress WHERE library_id = ? AND edition_id = ?`, this.libraryId, bookKey);
    return row ? { ...row, rawPosition: JSON.parse(row.rawPositionJson) } : null;
  }

  writeProgress(bookKey, position, { failpoint = () => {} } = {}) {
    this._ready(); requiredText(bookKey, "editionId bookKey"); object(position, "progress");
    requiredText(position.chapterId, "chapterId");
    if (typeof position.scrollRatio !== "number" || !Number.isFinite(position.scrollRatio) || position.scrollRatio < 0 || position.scrollRatio > 1) throw new Error("invalid progress ratio; not clamped");
    return this._transaction(() => {
      if (!this._get("SELECT chapter_id FROM chapters WHERE library_id = ? AND edition_id = ? AND chapter_id = ?", this.libraryId, bookKey, position.chapterId)) throw new Error("chapter does not belong to this library/edition");
      this._run(`INSERT INTO progress VALUES (?, ?, 'resolved', ?, ?, ?, 1, ?)
        ON CONFLICT(library_id, edition_id) DO UPDATE SET status='resolved', chapter_id=excluded.chapter_id,
        scroll_ratio=excluded.scroll_ratio, raw_position_json=excluded.raw_position_json,
        revision=progress.revision+1, updated_at=excluded.updated_at`, this.libraryId, bookKey, position.chapterId,
      position.scrollRatio, JSON.stringify({ chapterId: position.chapterId, scrollRatio: position.scrollRatio }), new Date().toISOString());
      failpoint("after-progress");
      return this.readProgress(bookKey);
    }, () => failpoint("before-commit"));
  }

  readShelf(bookKey) {
    this._ready();
    const row = this._get("SELECT on_shelf AS onShelf, pinned, updated_at AS updatedAt FROM shelf WHERE library_id = ? AND edition_id = ?", this.libraryId, bookKey);
    return row ? { ...row, onShelf: Boolean(row.onShelf), pinned: Boolean(row.pinned) } : null;
  }

  setShelf(bookKey, { onShelf = true, pinned = false }, { failpoint = () => {} } = {}) {
    this._ready(); requiredText(bookKey, "editionId bookKey");
    if (typeof onShelf !== "boolean" || typeof pinned !== "boolean") throw new Error("shelf flags must be boolean");
    return this._transaction(() => {
      if (!this._get("SELECT edition_id FROM editions WHERE library_id = ? AND edition_id = ?", this.libraryId, bookKey)) throw new Error("missing edition");
      this._run(`INSERT INTO shelf VALUES (?, ?, ?, ?, ?) ON CONFLICT(library_id, edition_id)
        DO UPDATE SET on_shelf=excluded.on_shelf, pinned=excluded.pinned, updated_at=excluded.updated_at`,
      this.libraryId, bookKey, Number(onShelf), Number(pinned), new Date().toISOString());
      failpoint("after-shelf");
      return this.readShelf(bookKey);
    }, () => failpoint("before-commit"));
  }

  deleteImportedBook(bookKey, { failpoint = () => {} } = {}) {
    // Deletes only normalized sandbox rows; retained legacy JSON is NOT erased.
    // This is explicitly not a permanent-deletion or backup-cleanup API.
    this._ready(); requiredText(bookKey, "editionId bookKey");
    return this._transaction(() => {
      const row = this._get("SELECT work_id, kind FROM editions WHERE library_id = ? AND edition_id = ?", this.libraryId, bookKey);
      if (!row) return false;
      if (row.kind !== "imported") throw new Error("explicit imported-book deletion only; cache reclamation is not implemented");
      this._run("DELETE FROM editions WHERE library_id = ? AND edition_id = ?", this.libraryId, bookKey);
      this._run("DELETE FROM works WHERE library_id = ? AND work_id = ? AND NOT EXISTS(SELECT 1 FROM editions WHERE work_id = ?)", this.libraryId, row.work_id, row.work_id);
      failpoint("after-delete");
      return true;
    }, () => failpoint("before-commit"));
  }

  evictionCandidates() {
    // Design-only eligibility sketch. Explicit realm inputs are caller-verified
    // fixture authorities; a string/URL is not proof of reacquisition rights.
    // Shelf pin is a conservative guard here, not a full offline-retention policy.
    this._ready();
    return this._all(`SELECT ${EDITION_COLUMNS} FROM editions e
      LEFT JOIN shelf s ON s.library_id=e.library_id AND s.edition_id=e.edition_id
      WHERE e.library_id = ? AND e.kind = 'remote-cache' AND e.binding = 'bound' AND e.retention = 'reclaimable'
      AND COALESCE(s.pinned, 0) = 0`, this.libraryId);
  }

  inspectMigrationState() {
    const version = this._version();
    return { version, completed: version === VERSION && Boolean(this._get("SELECT version FROM migrations WHERE version = ?", VERSION)) };
  }
}
