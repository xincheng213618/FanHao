import fs from "node:fs";
import path from "node:path";

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function createAdminMaintenanceTaskService({
  actorProfileRow,
  adminTaskService,
  clearSearchSourceCaches,
  clampInteger,
  coverGenerationStatus,
  cookieProfileDir,
  invalidateTableStamp,
  nodeCommand,
  refreshLibrary,
  resolveLibraryPersonByPublicId,
  setActorMovieCache,
  setLocalWorkCachesDirty,
  setWorkInfoCache
}) {
  function refreshActorMoviesPayload(body = {}) {
    const fullScan = Boolean(body.fullScan || body.full || body.all);
    const person = fullScan ? null : resolveLibraryPersonByPublicId(body.personId);
    if (!fullScan && !person) {
      throw httpError("人物不存在", 404);
    }

    const profile = person ? actorProfileRow(person.id) : null;
    if (person && !profile?.javdb_url) {
      throw httpError("这个人物还没有配置 JavDB actor 页", 400);
    }

    const sleep = clampInteger(body.sleep, 2, 0, 60);
    const maxPages = clampInteger(body.maxPages, fullScan ? 0 : 1, 0, 1000);
    const fullActorScan = maxPages === 0;
    const args = [
      "-u",
      path.join("tools", "refresh_core_javdb_actor_movies.py"),
      "--profile-dir",
      path.resolve("data", "selenium-core-actor-refresh-profile"),
      "--write",
      "--max-pages",
      String(maxPages),
      "--fast",
      "--sleep",
      String(sleep),
      "--jitter",
      "0"
    ];
    if (person) args.push("--person-id", person.id);
    if (fullScan) args.push("--all-linked-people");
    if (cookieProfileDir && fs.existsSync(cookieProfileDir)) {
      args.push(
        "--cookie-profile-dir",
        cookieProfileDir,
        "--cookie-profile-name",
        "Default",
        "--cookie-domain",
        "javdb.com"
      );
    }

    const task = adminTaskService.startProcessTask({
      type: "actor-movies",
      label: fullScan ? "全量刷新全部 JavDB 人物" : fullActorScan ? "全量刷新当前 JavDB 人物" : "刷新 JavDB 片单",
      person,
      command: "python",
      args,
      refreshHints: ["current-view"],
      invalidates: ["actorProfiles", "actorMovies", "workInfo", "workCovers"],
      onDone: () => {
        invalidateTableStamp("actor_movies");
        setActorMovieCache(null);
        setLocalWorkCachesDirty();
        refreshLibrary?.();
        clearSearchSourceCaches();
      }
    });

    return { ok: true, task: adminTaskService.publicTask(task) };
  }

  function generateMissingCoversPayload(body = {}) {
    const limit = clampInteger(body.limit, 20, 1, 200);
    const args = [path.join("tools", "generate_missing_covers.mjs"), "--write", "--limit", String(limit)];
    const task = adminTaskService.startProcessTask({
      type: "covers",
      label: `批量补封面 ${limit}`,
      person: null,
      command: nodeCommand,
      args,
      refreshHints: ["covers", "current-view"],
      onDone: () => {
        invalidateTableStamp("work_info");
        setWorkInfoCache(null);
        clearSearchSourceCaches();
      }
    });

    return { ok: true, task: adminTaskService.publicTask(task) };
  }

  function coverCacheStatusPayload(limitValue) {
    const sampleLimit = clampInteger(limitValue, 8, 0, 50);
    return coverGenerationStatus(sampleLimit);
  }

  return {
    coverCacheStatusPayload,
    generateMissingCoversPayload,
    refreshActorMoviesPayload
  };
}
