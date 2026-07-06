import fs from "node:fs";
import path from "node:path";

const JAVDB_115_COOKIE_PROFILE_DIR = path.join(process.env.LOCALAPPDATA || "", "115Chrome", "User Data");

export async function routeAdminApi(req, res, url, deps) {
  const {
    actorMovieRows,
    actorProfileRow,
    actorAvatarService,
    adminScriptService,
    adminTaskService,
    appConfigService,
    clearSearchSourceCaches,
    clampInteger,
    coverGenerationStatus,
    doubanCookieService,
    enrichLocalWorksWithActorMovieInfo,
    invalidateTableStamp,
    library,
    personLibraryService,
    publicPerson,
    pagedWorksPayload,
    resolveLibraryPersonByPublicId = (personId) => library.peopleById.get(personId),
    readJsonBody,
    refreshLibrary,
    requireLocalAdmin,
    sendJson,
    setActorMovieCache,
    setLocalWorkCachesDirty,
    setWorkInfoCache,
    sortWorkList
  } = deps;

  if (!url.pathname.startsWith("/api/admin/")) return false;

  if (url.pathname === "/api/admin/tasks" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { tasks: adminTaskService.list().map(adminTaskService.publicTask), summary: adminTaskService.summary(), historyLimit: adminTaskService.historyLimit });
    return true;
  }

  if (url.pathname === "/api/admin/tasks/stop" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const task = adminTaskService.stopTask(body.taskId || body.id);
      sendJson(res, 200, { ok: true, task: adminTaskService.publicTask(task) });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "停止任务失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/scripts" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, {
      scripts: adminScriptService.definitions.map(adminScriptService.publicScript),
      categories: adminScriptService.categories()
    });
    return true;
  }

  if (url.pathname === "/api/admin/scripts/run" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const script = adminScriptService.byId(body.scriptId);
      if (!script) {
        sendJson(res, 404, { error: "脚本不存在" });
        return true;
      }
      if (
        script.id === "image-library-rescan" &&
        adminTaskService.hasRunningScript(script.id)
      ) {
        sendJson(res, 409, { error: "图库索引刷新已经在后台运行" });
        return true;
      }
      const options = adminScriptService.normalizeOptions(script, body.options || {});
      const { command, args } = adminScriptService.buildCommand(script, options);
      const person = options.personId ? resolveLibraryPersonByPublicId(options.personId) : null;
      const task = adminTaskService.startProcessTask({
        type: `script:${script.id}`,
        scriptId: script.id,
        label: script.title,
        person,
        command,
        args,
        refreshHints: script.refreshHints || [],
        invalidates: script.invalidates || []
      });
      sendJson(res, 202, { ok: true, task: adminTaskService.publicTask(task), script: adminScriptService.publicScript(script) });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "启动脚本失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/config" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { config: appConfigService.publicConfig() });
    return true;
  }

  if (url.pathname === "/api/admin/config" && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    appConfigService.set(body.config || body);
    sendJson(res, 200, { ok: true, config: appConfigService.publicConfig() });
    return true;
  }

  if (url.pathname === "/api/admin/douban-cookie" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { ok: true, cookie: doubanCookieService.status() });
    return true;
  }

  if (url.pathname === "/api/admin/douban-cookie" && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, cookie: doubanCookieService.save(body.cookie || body.value || "") });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "保存豆瓣 Cookie 失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/douban-cookie/test" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const result = await doubanCookieService.test();
      sendJson(res, result.ok ? 200 : 409, { ok: result.ok, cookie: doubanCookieService.status(), test: result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "测试豆瓣 Cookie 失败", cookie: doubanCookieService.status() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/import-actor-avatars" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    appConfigService.set({
      ...appConfigService.current(),
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? appConfigService.current().actorAvatarDataPath
    });

    try {
      const summary = actorAvatarService.importFromFiletree(appConfigService.current().actorAvatarDataPath, { replace: Boolean(body.replace) });
      sendJson(res, 200, { ok: true, config: appConfigService.publicConfig(), summary });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "扫描演员头像失败", config: appConfigService.publicConfig() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/actor-avatar-candidates" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    appConfigService.set({
      ...appConfigService.current(),
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? appConfigService.current().actorAvatarDataPath
    });
    try {
      const summary = actorAvatarService.candidatesFromFiletree(appConfigService.current().actorAvatarDataPath, {
        personId: resolveLibraryPersonByPublicId(body.personId)?.id || body.personId,
        limit: clampInteger(body.limit, 24, 1, 200)
      });
      sendJson(res, 200, { ok: true, config: appConfigService.publicConfig(), summary });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "读取演员头像候选失败", config: appConfigService.publicConfig() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/apply-actor-avatar-candidate" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    appConfigService.set({
      ...appConfigService.current(),
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? appConfigService.current().actorAvatarDataPath
    });
    try {
      const result = actorAvatarService.importCandidate(appConfigService.current().actorAvatarDataPath, resolveLibraryPersonByPublicId(body.personId)?.id || body.personId, body.relPath, { dryRun: Boolean(body.dryRun) });
      sendJson(res, 200, { ok: true, config: appConfigService.publicConfig(), ...result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "应用演员头像候选失败", config: appConfigService.publicConfig() });
    }
    return true;
  }

  const personMappingMatch = /^\/api\/admin\/person-mapping\/([^/]+)$/.exec(url.pathname);
  if (personMappingMatch && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    const personId = decodeURIComponent(personMappingMatch[1]);
    const person = resolveLibraryPersonByPublicId(personId);
    if (!person) {
      sendJson(res, 404, { error: "人物不存在" });
      return true;
    }
    const extraSourcePaths = url.searchParams.getAll("sourcePath");
    sendJson(res, 200, {
      ok: true,
      person: publicPerson(person),
      sourceCandidates: personLibraryService.sourceCandidates(person, { extraSourcePaths })
    });
    return true;
  }

  if (url.pathname === "/api/admin/rescan-person" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const person = resolveLibraryPersonByPublicId(body.personId);
    if (!person) {
      sendJson(res, 404, { error: "人物不存在" });
      return true;
    }

    try {
      const nextPerson = personLibraryService.refreshPerson(person.id, {
        sourcePaths: Array.isArray(body.sourcePaths) ? body.sourcePaths : []
      });
      const actorRows = actorMovieRows(nextPerson.id);
      const rawWorks = nextPerson.works
        .map((workId) => library.worksById.get(workId))
        .filter(Boolean);
      const works = sortWorkList(
        enrichLocalWorksWithActorMovieInfo(rawWorks, actorRows),
        url.searchParams.get("sort") || "title"
      );
      sendJson(res, 200, {
        ok: true,
        person: publicPerson(nextPerson),
        ...pagedWorksPayload(works, url, {})
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "刷新人物失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/refresh-actor-movies" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const fullScan = Boolean(body.fullScan || body.full || body.all);
    const person = fullScan ? null : resolveLibraryPersonByPublicId(body.personId);
    if (!fullScan && !person) {
      sendJson(res, 404, { error: "人物不存在" });
      return true;
    }

    const profile = person ? actorProfileRow(person.id) : null;
    if (person && !profile?.javdb_url) {
      sendJson(res, 400, { error: "这个人物还没有配置 JavDB actor 页" });
      return true;
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
    if (JAVDB_115_COOKIE_PROFILE_DIR && fs.existsSync(JAVDB_115_COOKIE_PROFILE_DIR)) {
      args.push(
        "--cookie-profile-dir",
        JAVDB_115_COOKIE_PROFILE_DIR,
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
    sendJson(res, 202, { ok: true, task: adminTaskService.publicTask(task) });
    return true;
  }

  if (url.pathname === "/api/admin/refresh-rankings" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 410, { error: "旧缓存库已移除；排行榜刷新需要 core DB 原生脚本。" });
    return true;
    /*
    const body = await readJsonBody(req);
    const rawKeys = Array.isArray(body.keys) ? body.keys : [body.key || "y2025"];
    const keys = rawKeys
      .map((item) => String(item || "").trim())
      .filter((item, index, list) => list.indexOf(item) === index)
      .slice(0, 12);
    const sleep = clampInteger(body.sleep, 2, 0, 60);
    const args = ["-u", path.join("tools", "cache_javdb_rankings.py"), "--write", "--fast", "--sleep", String(sleep), "--jitter", "0.5"];
    for (const key of keys.length ? keys : ["y2025"]) {
      args.push("--list", key || "all");
    }
    const task = adminTaskService.startProcessTask({
      type: "rankings",
      label: "刷新排行榜缓存",
      person: null,
      command: "python",
      args,
      refreshHints: ["rankings", "current-view"],
      onDone: () => {
        invalidateTableStamp("javdb_rankings");
        setLocalWorkCachesDirty();
        clearSearchSourceCaches();
      }
    });
    sendJson(res, 202, { ok: true, task: adminTaskService.publicTask(task) });
    return true;
    */
  }

  if (url.pathname === "/api/admin/cover-cache-status" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    const sampleLimit = clampInteger(url.searchParams.get("limit"), 8, 0, 50);
    sendJson(res, 200, coverGenerationStatus(sampleLimit));
    return true;
  }

  if (url.pathname === "/api/admin/generate-missing-covers" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const limit = clampInteger(body.limit, 20, 1, 200);
    const args = [path.join("tools", "generate_missing_covers.mjs"), "--write", "--limit", String(limit)];
    const task = adminTaskService.startProcessTask({
      type: "covers",
      label: `批量补封面 ${limit}`,
      person: null,
      command: process.execPath,
      args,
      refreshHints: ["covers", "current-view"],
      onDone: () => {
        invalidateTableStamp("work_info");
        setWorkInfoCache(null);
        clearSearchSourceCaches();
      }
    });
    sendJson(res, 202, { ok: true, task: adminTaskService.publicTask(task) });
    return true;
  }

  return false;
}
