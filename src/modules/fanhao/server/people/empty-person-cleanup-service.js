import { createHash } from "node:crypto";
import path from "node:path";
import { assertActorProfileMutationAllowed, personAvatarAggregateKey } from "./actor-profile-mutation-guard.js";
import { canonicalPersonId, hasIdentityTable } from "./person-identity.js";

const LOCAL_ONLY_PERSON_SOURCES = new Set([
  "library-index",
  "local_folder_correction",
  "local_full_scan",
  "manual_move"
]);

function cleanupError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function tableExists(db, schema, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM ${schema}.sqlite_schema WHERE type = 'table' AND name = ?`).get(name));
  } catch {
    return false;
  }
}

function rowCount(db, schema, table, clause, ...args) {
  if (!tableExists(db, schema, table)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${schema}.${table} WHERE ${clause}`).get(...args)?.count || 0);
}

function uniqueText(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function absolutePathRoot(value) {
  const text = String(value || "");
  const parser = /^[a-z]:[\\/]|^\\\\/i.test(text) ? path.win32 : path;
  return parser.parse(text).root;
}

function confirmationToken(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function createEmptyPersonCleanupService({
  actorMovieRows = () => [],
  getCoreDb,
  hasCoreDb,
  invalidateTableStamp = () => {},
  refreshLibrary = () => null,
  resolveLibraryPersonByPublicId = () => null,
  safeStat,
  sourcePathToAbsolute = (value) => value,
  warn = console.warn
}) {
  function inspect(personId) {
    if (!hasCoreDb()) throw cleanupError("core DB 不可用", "EMPTY_PERSON_DB_UNAVAILABLE", 503);
    const db = getCoreDb();
    const requestedId = String(personId || "").trim();
    const canonicalId = canonicalPersonId(db, requestedId);
    if (!canonicalId || canonicalId !== requestedId) {
      throw cleanupError("人物编号无效或已经合并", "EMPTY_PERSON_ID_INVALID", 409);
    }

    const person = db.prepare("SELECT * FROM people WHERE id = ?").get(Number(canonicalId));
    if (!person) throw cleanupError("人物不存在", "EMPTY_PERSON_NOT_FOUND", 404);

    const locations = hasIdentityTable(db, "person_library_locations")
      ? db.prepare("SELECT path, source FROM person_library_locations WHERE person_id = ? ORDER BY id").all(Number(canonicalId))
      : [];
    const sourcePaths = uniqueText([person.folder_path, ...locations.map((item) => item.path)]);
    const pathStates = sourcePaths.map((sourcePath) => {
      const absolutePath = sourcePathToAbsolute(sourcePath);
      const rootPath = absolutePathRoot(absolutePath);
      return {
        sourcePath,
        absolutePath,
        rootAvailable: Boolean(rootPath && safeStat(rootPath)?.isDirectory()),
        exists: Boolean(safeStat(absolutePath))
      };
    });

    const libraryPerson = resolveLibraryPersonByPublicId(canonicalId);
    const relatedActorMovies = actorMovieRows(canonicalId);
    const counts = {
      localWorks: Array.isArray(libraryPerson?.works) ? libraryPerson.works.length : 0,
      catalogWorks: rowCount(db, "main", "work_people", "person_id = ?", Number(canonicalId)),
      aliases: rowCount(db, "main", "person_aliases", "person_id = ?", Number(canonicalId)),
      externalRefs: rowCount(db, "main", "person_external_refs", "person_id = ?", Number(canonicalId)),
      actorMovies: Array.isArray(relatedActorMovies) ? relatedActorMovies.length : 0,
      profileReservations: rowCount(db, "main", "cross_store_aggregate_reservations", "aggregate_key = ?", personAvatarAggregateKey(canonicalId)),
      profilePublications: rowCount(db, "main", "actor_profile_publications", "person_id = ?", Number(canonicalId)),
      profileRevocations: rowCount(db, "main", "actor_profile_image_revocations", "person_id = ?", Number(canonicalId)),
      folderOperations: rowCount(db, "main", "person_folder_operations", "person_id = ?", Number(canonicalId)),
      moveJobs: rowCount(db, "main", "work_move_jobs", "person_id = ?", Number(canonicalId)),
      redirects: rowCount(db, "main", "person_redirects", "source_id = ? OR target_id = ?", Number(canonicalId), Number(canonicalId)),
      mergeOperations: rowCount(db, "main", "person_identity_merges", "target_id = ?", Number(canonicalId)),
      images: rowCount(db, "fanhao_images", "images", "owner_type = 'person' AND owner_id = ?", Number(canonicalId)),
      imageStaging: rowCount(db, "fanhao_images", "actor_profile_image_staging", "person_id = ?", Number(canonicalId)),
      imageGcReceipts: rowCount(db, "fanhao_images", "actor_profile_image_gc_receipts", "person_id = ?", Number(canonicalId))
    };

    const blockers = [];
    const block = (code, message) => blockers.push({ code, message });
    if (String(person.status || "ok") !== "ok") block("PERSON_STATUS", "人物状态不是可清理的正常记录");
    if (!LOCAL_ONLY_PERSON_SOURCES.has(String(person.source || ""))) block("PERSON_SOURCE", "人物不是本地目录产生的记录");
    if (!sourcePaths.length) block("NO_SOURCE_PATH", "人物没有可核对的来源目录");
    if (pathStates.some((item) => !item.rootAvailable)) block("SOURCE_ROOT_UNAVAILABLE", "人物来源磁盘当前不可用");
    if (pathStates.some((item) => item.exists)) block("SOURCE_PATH_EXISTS", "人物来源目录仍然存在");
    if (Number(person.movie_count || 0) > 0 || counts.localWorks || counts.catalogWorks || counts.actorMovies) {
      block("PERSON_HAS_WORKS", "人物仍有关联作品");
    }
    if (counts.aliases || counts.externalRefs) block("PERSON_HAS_IDENTITY", "人物仍有别名或外部身份资料");
    if (counts.profileReservations || counts.profilePublications || counts.profileRevocations || counts.images || counts.imageStaging || counts.imageGcReceipts) {
      block("PERSON_HAS_PROFILE_ASSETS", "人物仍有头像或资料发布记录");
    }
    if (counts.folderOperations || counts.moveJobs) block("PERSON_HAS_JOBS", "人物仍有历史或进行中的文件任务");
    if (counts.redirects || counts.mergeOperations) block("PERSON_HAS_MERGES", "人物仍在合并关系中");

    const snapshot = {
      version: 1,
      personId: canonicalId,
      updatedAt: String(person.updated_at || ""),
      source: String(person.source || ""),
      sourcePaths,
      pathStates,
      counts
    };
    const eligible = blockers.length === 0;
    return {
      eligible,
      person: {
        id: canonicalId,
        name: String(person.display_name || person.name || canonicalId),
        source: String(person.source || "")
      },
      sourcePaths,
      counts,
      blockers,
      confirmationToken: eligible ? confirmationToken(snapshot) : ""
    };
  }

  function preview(personId) {
    return { ok: true, preview: true, ...inspect(personId) };
  }

  function remove(personId, options = {}) {
    const providedToken = String(options.confirmationToken || "").trim();
    if (!providedToken) throw cleanupError("请先预览并确认清理范围", "EMPTY_PERSON_PREVIEW_REQUIRED", 400);

    if (!hasCoreDb()) throw cleanupError("core DB 不可用", "EMPTY_PERSON_DB_UNAVAILABLE", 503);
    const db = getCoreDb();
    db.exec("BEGIN IMMEDIATE");
    let plan;
    try {
      assertActorProfileMutationAllowed(db, Number(personId));
      plan = inspect(personId);
      if (!plan.eligible) {
        throw cleanupError(plan.blockers[0]?.message || "人物当前不可清理", "EMPTY_PERSON_NOT_ELIGIBLE", 409);
      }
      if (plan.confirmationToken !== providedToken) {
        throw cleanupError("人物状态已变化，请重新预览后再清理", "EMPTY_PERSON_PREVIEW_STALE", 409);
      }
      if (hasIdentityTable(db, "person_library_locations")) {
        db.prepare("DELETE FROM person_library_locations WHERE person_id = ?").run(Number(plan.person.id));
      }
      const deleted = db.prepare("DELETE FROM people WHERE id = ?").run(Number(plan.person.id));
      if (Number(deleted.changes || 0) !== 1) {
        throw cleanupError("人物状态已变化，请重新预览后再清理", "EMPTY_PERSON_PREVIEW_STALE", 409);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }

    let cacheRefreshed = false;
    try {
      invalidateTableStamp("people", "person_library_locations");
      cacheRefreshed = Boolean(refreshLibrary());
    } catch (error) {
      warn("[empty-person-cleanup-refresh]", error?.message || error);
    }
    return {
      ok: true,
      deleted: true,
      person: plan.person,
      removedLocationCount: plan.sourcePaths.length,
      cacheRefreshed
    };
  }

  return { preview, remove };
}
