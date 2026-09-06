import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { constants } from "node:sqlite";
import { NovelStorageModel } from "./fixtures/novel-storage-model/model.mjs";
import { LIBRARY, OTHER_LIBRARY, PRIVATE_MARKER, legacyRecord, legacyLibrary } from "./fixtures/novel-storage-model/synthetic.mjs";

// Real node:sqlite, private temporary files and invented JSON only. No IndexedDB,
// real book database, Android bridge, production imports, or network operations.
let checks = 0, serial = 0, scenarios = 0;
const connections = new Set();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-storage-model-"));
function equal(actual, expected, label) { checks++; assert.equal(actual, expected, label); }
function same(actual, expected, label) { checks++; assert.deepEqual(actual, expected, label); }
function check(value, label) { checks++; assert.ok(value, label); }
function throws(action, pattern, label) { checks++; assert.throws(action, pattern, label); }
const plain = (value) => JSON.parse(JSON.stringify(value));
function open(filename = path.join(temporary, `case-${serial++}.sqlite`), libraryId = LIBRARY) {
  const model = new NovelStorageModel(filename, { libraryId }); connections.add(model); return model;
}
function close(model) { model.close(); connections.delete(model); }
function databasePath(model) { return model.connection.location(); }
function legacyRows(model) {
  return plain(model.connection.prepare("SELECT row_id,library_id,realm,legacy_id,hex(CAST(raw_json AS BLOB)) AS bytes FROM legacy_books ORDER BY row_id").all());
}
function normalizedTables(model) {
  return model.connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name!='legacy_books' ORDER BY name").all().map((row) => row.name);
}
function resolve(model, record) { return model.resolveLegacyAlias({ realm: record.realm, legacyId: record.legacyId })?.editionId; }
function scenario(label, action) { action(); scenarios++; console.log(`novel-storage-model: ${label} passed`); }

const PROTECTED_TABLES = new Set(["chapter_bodies", "legacy_books", "legacy_extensions"]);
const ROW_ACTIONS = new Set([constants.SQLITE_READ, constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE]);
function fence(model, action, { forbidden = PROTECTED_TABLES, immutableLegacy = false } = {}) {
  const events = [];
  model.connection.setAuthorizer((code, table, column, database, origin) => {
    if (ROW_ACTIONS.has(code)) events.push({ code, table, column, database, origin });
    if (ROW_ACTIONS.has(code) && forbidden.has(table)) return constants.SQLITE_DENY;
    if (immutableLegacy && table === "legacy_books" && [constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE].includes(code)) return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
  try { return { result: action(), events }; }
  finally { model.connection.setAuthorizer(null); }
}

// Observe actual calls to native StatementSync, not a substitute database. Fresh
// statements are prepared inside each API call, with authorizer already enabled.
function nativeCalls(model, action) {
  const records = [], db = model.connection, original = db.prepare;
  db.prepare = function(sql) {
    const statement = original.call(db, sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args) => {
          const record = { sql, operation: property, rows: 0 }; records.push(record);
          const result = value.apply(target, args);
          if (property === "all") record.rows = result.length;
          if (property === "get") record.rows = result ? 1 : 0;
          if (property === "iterate") return (function* () { for (const row of result) { record.rows++; yield row; } })();
          return result;
        };
      }
    });
  };
  try { return { result: action(), records }; }
  finally { delete db.prepare; }
}

function assertRolledBack(model, before) {
  same(model.inspectMigrationState(), { version: 0, completed: false }, "sandbox-private version rolled back");
  same(normalizedTables(model), [], "DDL rolled back along with new rows");
  same(legacyRows(model), before, "legacy raw JSON byte-for-byte unchanged");
}

try {
  scenario("atomic migration, opaque identities, source isolation and extension preservation", () => {
    const model = open(), records = legacyLibrary(); model.seedLegacy(records); const before = legacyRows(model);
    throws(() => model.listShelf(), /migration is not complete/, "no partial-model read fallback to legacy");
    const observed = nativeCalls(model, () => fence(model, () => model.migrateLegacy(), { forbidden: new Set(), immutableLegacy: true }));
    same(observed.result.result, { migrated: true, version: 2, books: records.length }, "whole migration committed");
    const legacyReads = observed.records.filter((item) => /SELECT \* FROM legacy_books/.test(item.sql));
    equal(legacyReads.length, 1, "one native legacy cursor"); equal(legacyReads[0].operation, "iterate", "legacy cursor is not getAll/all"); equal(legacyReads[0].rows, records.length, "native cursor yielded every legacy row");
    same(legacyRows(model), before, "migration never rewrites JSON formatting/escapes/unknown fields");
    const local = model.listShelf(), other = open(databasePath(model), OTHER_LIBRARY);
    equal(local.length, records.filter((row) => row.libraryId === LIBRARY).length, "library-scoped shelf"); equal(other.listShelf().length, 1, "other scope stays separate");
    const all = [...local, ...other.listShelf()];
    equal(new Set(all.map((row) => row.workId)).size, records.length, "same titles never merge works");
    equal(new Set(all.map((row) => row.editionId)).size, records.length, "every legacy row owns an edition");
    for (const record of records) {
      const owner = record.libraryId === LIBRARY ? model : other;
      const editionId = resolve(owner, record), summary = owner.listShelf().find((row) => row.editionId === editionId);
      check(Boolean(summary), "structured alias finds exactly its edition"); equal(summary.bookKey, editionId, "bookKey is editionId, never workId");
      check(editionId !== summary.workId && editionId !== record.legacyId, "opaque separately allocated work and edition IDs");
      equal(summary.realm, record.realm, "authority is explicit tuple realm, not raw URL"); equal(summary.fileName, `${record.rowId}.txt`, "production legacy fileName retained");
      const input = JSON.parse(record.rawJson), chapters = owner.listChapters(editionId);
      equal(chapters.length, input.chapters.length, "all chapter metadata present");
      for (let index = 0; index < chapters.length; index++) {
        const chapter = chapters[index]; equal(chapter.ordinal, index + 1, "ordinal describes order only");
        check(chapter.chapterId !== input.chapters[index].id && chapter.chapterId !== String(chapter.ordinal), "chapter ID is newly allocated opaque identity");
        equal(owner.readChapter(editionId, chapter.chapterId).content, input.chapters[index].content, "exact single-chapter text retained");
        const extra = owner.connection.prepare("SELECT properties_json FROM legacy_extensions WHERE library_id=? AND entity_kind='chapter' AND entity_id=?").get(owner.libraryId, chapter.chapterId);
        same(JSON.parse(extra.properties_json).futureChapter, input.chapters[index].futureChapter, "unknown chapter fields survive isolated");
      }
      const extensions = model.connection.prepare("SELECT entity_kind,properties_json FROM legacy_extensions WHERE library_id=? AND edition_id=?").all(record.libraryId, editionId);
      same(JSON.parse(extensions.find((row) => row.entity_kind === "book").properties_json).metadata, input.book.metadata, "unknown nested book metadata retained");
      same(JSON.parse(extensions.find((row) => row.entity_kind === "entry").properties_json).futureEntry, input.futureEntry, "unknown entry extension retained");
    }
    const serialized = JSON.stringify(local);
    for (const privateKey of [PRIVATE_MARKER, "sourceKey", "sourceUrl", "contents", "properties_json", "raw_json"]) check(!serialized.includes(privateKey), "catalog whitelist excludes " + privateKey);
    const unbound = local.find((row) => row.editionId === resolve(model, records[3]));
    equal(unbound.realm, null, "missing remote realm remains null"); equal(unbound.binding, "unbound", "missing remote authority is unresolved"); equal(unbound.retention, "protected", "unknown-origin cache never inferred disposable");
    const conservativeLocal = local.find((row) => row.editionId === resolve(model, records[6]));
    equal(conservativeLocal.binding, "unbound", "sandbox conservatively leaves realm-less imported row unbound"); equal(conservativeLocal.retention, "durable", "realm-less imported body remains owned/durable");
    equal(model.resolveLegacyAlias({ realm: "server:another-source", legacyId: "same-old-id" }), null, "unbound alias does not attach to current source");
    throws(() => model.resolveLegacyAlias({ realm: "https://current-server.invalid", legacyId: "same-old-id" }), /explicit device\/server authority/, "locator cannot impersonate realm");
    const known = resolve(model, records[0]), progress = model.readProgress(known), chapters = model.listChapters(known);
    equal(progress.chapterId, chapters[1].chapterId, "legacy index 30 maps within its original directory to ordinal 2"); equal(progress.scrollRatio, 0.375, "known old ratio retained");
    check(!JSON.stringify(progress).includes(PRIVATE_MARKER), "progress DTO excludes unknown body-like progress fields");
    for (const record of [records[5], records[7]]) {
      const unresolved = model.readProgress(resolve(model, record)); equal(unresolved.status, "unresolved", "missing/contradictory old chapter remains unresolved"); equal(unresolved.chapterId, null, "unresolved never clamps onto a chapter"); equal(unresolved.scrollRatio, null, "unresolved ratio not applied elsewhere");
      equal(unresolved.rawPosition.chapterIndex, JSON.parse(record.rawJson).book.progress.chapterIndex, "old scalar anchor retained");
    }
    const otherEdition = resolve(other, records[4]), foreignChapter = other.listChapters(otherEdition)[0];
    equal(model.readChapter(otherEdition, foreignChapter.chapterId), null, "cross-library body blocked");
    equal(model.readProgress(otherEdition), null, "cross-library progress blocked"); equal(model.readShelf(otherEdition), null, "cross-library shelf blocked");
    const sameLibraryOther = resolve(model, records[1]), wrongChapter = model.listChapters(sameLibraryOther)[0];
    equal(model.readChapter(known, wrongChapter.chapterId), null, "chapter identity alone cannot cross edition");
    equal(model.readChapter(local.find((row) => row.editionId === known).workId, chapters[0].chapterId), null, "workId is not an edition lookup key");
    same(plain(model.connection.prepare("PRAGMA foreign_key_check").all()), [], "native SQLite foreign keys consistent");
    close(other); close(model);
  });

  scenario("real SQL access fences, chapter-sized reads and independent progress/shelf", () => {
    const model = open(), records = legacyLibrary(); model.seedLegacy(records); model.migrateLegacy();
    const edition = resolve(model, records[0]), chapter = model.listChapters(edition)[1];
    const bodySnapshot = plain(model.connection.prepare("SELECT * FROM chapter_bodies ORDER BY chapter_id").all());
    const legacySnapshot = legacyRows(model);
    const result = nativeCalls(model, () => fence(model, () => {
      const summary = model.listShelf({ limit: 2 }); equal(summary.length, 2, "bounded shelf page");
      const next = model.listShelf({ limit: 2, afterEditionId: summary[1].editionId }); equal(next.length, 2, "next bounded shelf page"); check(next.every((row) => !summary.some((old) => old.editionId === row.editionId)), "shelf cursor has no overlap");
      const directory = model.listChapters(edition, { limit: 1 }); equal(directory.length, 1, "bounded chapter metadata page");
      check(!Object.hasOwn(directory[0], "content"), "TOC has no body field");
      const second = model.listChapters(edition, { limit: 1, afterOrdinal: directory[0].ordinal }); equal(second[0].chapterId, chapter.chapterId, "TOC paging uses ordinal only for order");
      const before = model.readProgress(edition); const saved = model.writeProgress(edition, { chapterId: chapter.chapterId, scrollRatio: 0.9 });
      equal(saved.revision, before.revision + 1, "independent progress revision"); equal(saved.chapterId, chapter.chapterId, "chapter identity persisted");
      const persisted = plain(saved);
      model.setShelf(edition, { onShelf: false, pinned: true }); equal(model.readShelf(edition).onShelf, false, "move off shelf independently");
      same(plain(model.readProgress(edition)), persisted, "shelf change leaves progress unchanged");
      check(!model.listShelf().some((row) => row.editionId === edition), "off-shelf edition hidden only from shelf");
      model.writeProgress(edition, { chapterId: chapter.chapterId, scrollRatio: 0.2 }); equal(model.readShelf(edition).onShelf, false, "reading does not silently restore shelf membership");
    }));
    equal(result.result.events.filter((event) => PROTECTED_TABLES.has(event.table)).length, 0, "SQLite authorized no protected-table access for list/progress/shelf");
    check(result.records.every((record) => !/chapter_bodies|legacy_books|legacy_extensions/.test(record.sql)), "observed native StatementSync calls match access boundary");
    same(plain(model.connection.prepare("SELECT * FROM chapter_bodies ORDER BY chapter_id").all()), bodySnapshot, "progress/shelf never rewrite any body"); same(legacyRows(model), legacySnapshot, "progress/shelf never rewrite legacy");
    for (const sql of ["SELECT content FROM chapter_bodies", "SELECT raw_json FROM legacy_books", "SELECT properties_json FROM legacy_extensions",
      "UPDATE chapter_bodies SET content='lost'", "DELETE FROM legacy_books", "UPDATE legacy_extensions SET properties_json='{}'"]) {
      throws(() => fence(model, () => model.connection.prepare(sql).run()), /not authorized|prohibited|authorization denied/i, "real SQLite DENY fence must be active for " + sql);
    }
    const chapterCall = nativeCalls(model, () => model.readChapter(edition, chapter.chapterId));
    const bodyCalls = chapterCall.records.filter((record) => /chapter_bodies/.test(record.sql));
    equal(bodyCalls.length, 1, "single native body statement"); equal(bodyCalls[0].operation, "get", "single chapter uses native get, not all"); equal(bodyCalls[0].rows, 1, "one returned chapter body");
    for (const ratio of [-0.1, 1.1, NaN, Infinity, "0.5", null]) throws(() => model.writeProgress(edition, { chapterId: chapter.chapterId, scrollRatio: ratio }), /not clamped/, "invalid new progress ratio rejects");
    throws(() => model.writeProgress(edition, { chapterId: "unrelated-chapter", scrollRatio: 0.5 }), /does not belong/, "unknown progress target cannot create a chapter");
    throws(() => model.listShelf({ limit: 0 }), /limit/, "zero page bound invalid"); throws(() => model.listChapters(edition, { limit: 1001 }), /limit/, "unbounded TOC read refused");
    close(model);
  });

  scenario("migration failures rollback DDL, rows and marker, then reopen/retry", () => {
    const failures = [
      (stage) => stage === "after-schema",
      (stage, info) => stage === "after-chapter" && info.rowId === "a-imported" && info.ordinal === 1,
      (stage, info) => stage === "after-chapter" && info.rowId === "b-server-one" && info.ordinal === 2,
      (stage) => stage === "after-marker",
      (stage) => stage === "before-commit"
    ];
    for (const shouldFail of failures) {
      let model = open(); const filename = databasePath(model); model.seedLegacy(legacyLibrary()); const before = legacyRows(model);
      const sentinel = new Error("injected migration failure");
      throws(() => model.migrateLegacy({ failpoint(stage, info = {}) { if (shouldFail(stage, info)) throw sentinel; } }), (error) => error === sentinel, "the original migration failure escapes");
      assertRolledBack(model, before); close(model); model = open(filename); assertRolledBack(model, before);
      equal(model.migrateLegacy().books, legacyLibrary().length, "reopened failed migration can be retried"); same(legacyRows(model), before, "successful retry still leaves raw input unchanged");
      close(model);
    }
  });

  scenario("damaged rows abort all books; no silent skip or ownership guessing", () => {
    const corruptions = [
      () => ({ rawJson: "{not valid JSON" }),
      (entry) => { entry.chapters[0].content = null; },
      (entry) => { entry.chapters[1].index = entry.chapters[0].index; },
      (entry) => { entry.chapters[0].bookId = "OTHER-BOOK"; },
      (entry) => { entry.id = "wrong-parent-id"; },
      (entry) => { entry.chapters = []; }
    ];
    for (const corrupt of corruptions) {
      const model = open(); const good = legacyRecord({ rowId: "a-valid" });
      const damaged = legacyRecord({ rowId: "z-damaged", legacyId: "damaged", modify(entry) { corrupt(entry); } });
      // Keep malformed text deliberately malformed, not a normalized test object.
      if (corrupt === corruptions[0]) damaged.rawJson = "{not valid JSON";
      model.seedLegacy([good, damaged]); const before = legacyRows(model);
      throws(() => model.migrateLegacy(), /damaged|JSON|property name|Unexpected|Expected/i, "corrupt input rejects entire migration");
      assertRolledBack(model, before); equal(model.connection.prepare("SELECT COUNT(*) AS count FROM legacy_books").get().count, 2, "damaged original row retained, not skipped/deleted");
      close(model);
    }
  });

  scenario("state transaction rollback, protected retention and native SQL constraints", () => {
    const model = open(), records = legacyLibrary(); model.seedLegacy(records); model.migrateLegacy();
    const imported = resolve(model, records[0]), server = resolve(model, records[1]), unbound = resolve(model, records[3]);
    const chapter = model.listChapters(imported)[0], beforeProgress = plain(model.readProgress(imported)), beforeShelf = plain(model.readShelf(imported));
    for (const stage of ["after-progress", "before-commit"]) {
      throws(() => model.writeProgress(imported, { chapterId: chapter.chapterId, scrollRatio: 0.75 }, { failpoint(point) { if (point === stage) throw new Error("progress rollback"); } }), /progress rollback/);
      same(plain(model.readProgress(imported)), beforeProgress, "failed progress transaction rolled back");
    }
    throws(() => model.setShelf(imported, { onShelf: false, pinned: true }, { failpoint() { throw new Error("shelf rollback"); } }), /shelf rollback/);
    same(plain(model.readShelf(imported)), beforeShelf, "failed shelf transaction rolled back");
    const eligible = model.evictionCandidates(); equal(eligible.length, 2, "only explicit bound remote caches eligible");
    check(!eligible.some((row) => [imported, unbound].includes(row.editionId)), "owned and unbound content protected");
    model.setShelf(server, { pinned: true }); check(!model.evictionCandidates().some((row) => row.editionId === server), "pinned remote cache protected");
    model.setShelf(server, { pinned: false }); check(model.evictionCandidates().some((row) => row.editionId === server), "unpin only makes known synthetic cache eligible");
    throws(() => model.deleteImportedBook(unbound), /imported-book deletion only/, "no accidental protected-cache deletion API");
    // Direct SQL probes exercise SQLite constraints, bypassing JS argument checks.
    throws(() => model.connection.prepare("UPDATE progress SET status='resolved',chapter_id=?,scroll_ratio=NULL WHERE library_id=? AND edition_id=?").run(chapter.chapterId, LIBRARY, imported), /CHECK constraint failed/, "resolved NULL ratio rejected by actual SQL CHECK");
    const foreignChapter = model.listChapters(server)[0];
    throws(() => model.connection.prepare("UPDATE progress SET chapter_id=? WHERE library_id=? AND edition_id=?").run(foreignChapter.chapterId, LIBRARY, imported), /FOREIGN KEY constraint failed/, "cross-edition progress rejected by actual composite FK");
    throws(() => model.connection.prepare("UPDATE editions SET retention='reclaimable' WHERE edition_id=?").run(imported), /CHECK constraint failed/, "imported retention cannot be silently changed to cache");
    throws(() => model.connection.prepare("UPDATE editions SET retention='reclaimable' WHERE edition_id=?").run(unbound), /CHECK constraint failed/, "unbound cache cannot become disposable");
    throws(() => model.connection.prepare("UPDATE chapters SET ordinal=2 WHERE chapter_id=?").run(chapter.chapterId), /UNIQUE constraint failed/, "same edition duplicate ordinal rejected");
    same(plain(model.connection.prepare("PRAGMA foreign_key_check").all()), [], "failed direct SQL writes leave FK-consistent model");
    close(model);
  });

  scenario("successful migration is durable/no-op and deleted normalized books never resurrect", () => {
    let model = open(); const filename = databasePath(model), records = legacyLibrary(); model.seedLegacy(records); const original = legacyRows(model); model.migrateLegacy();
    const imported = resolve(model, records[0]), chapter = model.listChapters(imported)[0], target = resolve(model, records[1]);
    model.writeProgress(target, { chapterId: model.listChapters(target)[2].chapterId, scrollRatio: 0.123 }); model.setShelf(target, { pinned: true, onShelf: false });
    const latestProgress = plain(model.readProgress(target)), latestShelf = plain(model.readShelf(target));
    const firstSnapshot = plain(model.connection.prepare("SELECT * FROM chapter_bodies WHERE edition_id=? ORDER BY chapter_id").all(imported));
    throws(() => model.deleteImportedBook(imported, { failpoint() { throw new Error("delete rollback"); } }), /delete rollback/);
    same(plain(model.connection.prepare("SELECT * FROM chapter_bodies WHERE edition_id=? ORDER BY chapter_id").all(imported)), firstSnapshot, "delete abort restores body cascade"); check(model.readProgress(imported), "delete abort restores progress"); check(model.readShelf(imported), "delete abort restores shelf");
    equal(model.deleteImportedBook(imported), true, "local-file import is owned and explicitly deletable"); equal(model.readChapter(imported, chapter.chapterId), null, "new body deleted"); equal(model.readProgress(imported), null, "new progress deleted"); equal(model.readShelf(imported), null, "new shelf deleted");
    throws(() => model.writeProgress(imported, { chapterId: chapter.chapterId, scrollRatio: 0.5 }), /does not belong/, "late progress does not recreate deleted edition");
    close(model); model = open(filename);
    same(fence(model, () => model.migrateLegacy()).result, { migrated: false, version: 2 }, "completed migration returns no-op without even reading raw input");
    equal(resolve(model, records[0]), undefined, "deleted alias not recreated from retained legacy"); equal(model.readChapter(imported, chapter.chapterId), null, "deleted chapter not resurrected after reopen");
    same(plain(model.readProgress(target)), latestProgress, "no-op preserves new progress"); same(plain(model.readShelf(target)), latestShelf, "no-op preserves new shelf state");
    same(legacyRows(model), original, "original JSON still exists: this is NOT permanent deletion");
    equal(model.connection.prepare("SELECT COUNT(*) AS count FROM migrations").get().count, 1, "one durable migration completion marker");
    close(model);
  });

  console.log(`novel-storage-model: ${checks} assertions passed across ${scenarios} real-SQLite scenarios`);
  console.log("Boundary: synthetic private SQLite only; no production/IndexedDB migration, Android memory benchmark, sync, or permanent deletion. Realm-less imported rows conservatively remain unbound/durable. Cache candidates assume caller-verified synthetic authorities; no actual eviction is implemented.");
} finally {
  for (const model of connections) { try { model.close(); } catch {} }
  const exact = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(exact).toLowerCase(), parent.toLowerCase()); assert.ok(path.basename(exact).startsWith("fanhao-novel-storage-model-"));
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Remove-Item -LiteralPath '${exact.replaceAll("'", "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 10000 });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(exact, { recursive: true, force: true });
}
