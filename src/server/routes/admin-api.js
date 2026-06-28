import path from "node:path";

export async function routeAdminApi(req, res, url, deps) {
  const {
    actorAvatarCandidatesFromFiletree,
    actorProfileRow,
    adminScriptById,
    adminScriptCategories,
    adminTaskHistoryLimit,
    adminTaskSummary,
    adminTasks,
    buildAdminScriptCommand,
    clearSearchSourceCaches,
    clampInteger,
    coverGenerationStatus,
    getAppConfig,
    importActorAvatarCandidate,
    importActorAvatarsFromFiletree,
    invalidateTableStamp,
    library,
    normalizeAdminScriptOptions,
    normalizeAppConfig,
    publicAdminScript,
    publicAdminTask,
    publicAppConfig,
    publicPerson,
    pagedWorksPayload,
    readJsonBody,
    refreshPersonLibrary,
    requireLocalAdmin,
    scriptDefinitions,
    sendJson,
    setActorMovieCache,
    setAppConfig,
    setLocalWorkCachesDirty,
    setWorkInfoCache,
    sortWorkList,
    startAdminProcessTask,
    stopAdminTask
  } = deps;

  if (!url.pathname.startsWith("/api/admin/")) return false;

  if (url.pathname === "/api/admin/tasks" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { tasks: adminTasks.map(publicAdminTask), summary: adminTaskSummary(), historyLimit: adminTaskHistoryLimit });
    return true;
  }

  if (url.pathname === "/api/admin/tasks/stop" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const task = stopAdminTask(body.taskId || body.id);
      sendJson(res, 200, { ok: true, task: publicAdminTask(task) });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "停止任务失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/scripts" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, {
      scripts: scriptDefinitions.map(publicAdminScript),
      categories: adminScriptCategories()
    });
    return true;
  }

  if (url.pathname === "/api/admin/scripts/run" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const script = adminScriptById(body.scriptId);
      if (!script) {
        sendJson(res, 404, { error: "脚本不存在" });
        return true;
      }
      if (
        script.id === "image-library-rescan" &&
        adminTasks.some((task) => task.scriptId === script.id && (task.status === "running" || task.status === "stopping"))
      ) {
        sendJson(res, 409, { error: "图库索引刷新已经在后台运行" });
        return true;
      }
      const options = normalizeAdminScriptOptions(script, body.options || {});
      const { command, args } = buildAdminScriptCommand(script, options);
      const person = options.personId ? library.peopleById.get(options.personId) : null;
      const task = startAdminProcessTask({
        type: `script:${script.id}`,
        scriptId: script.id,
        label: script.title,
        person,
        command,
        args,
        refreshHints: script.refreshHints || [],
        invalidates: script.invalidates || []
      });
      sendJson(res, 202, { ok: true, task: publicAdminTask(task), script: publicAdminScript(script) });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "启动脚本失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/config" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { config: publicAppConfig() });
    return true;
  }

  if (url.pathname === "/api/admin/config" && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    setAppConfig(normalizeAppConfig(body.config || body));
    sendJson(res, 200, { ok: true, config: publicAppConfig() });
    return true;
  }

  if (url.pathname === "/api/admin/import-actor-avatars" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    setAppConfig(normalizeAppConfig({
      ...getAppConfig(),
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? getAppConfig().actorAvatarDataPath
    }));

    try {
      const summary = importActorAvatarsFromFiletree(getAppConfig().actorAvatarDataPath, { replace: Boolean(body.replace) });
      sendJson(res, 200, { ok: true, config: publicAppConfig(), summary });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "扫描演员头像失败", config: publicAppConfig() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/actor-avatar-candidates" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    setAppConfig(normalizeAppConfig({
      ...getAppConfig(),
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? getAppConfig().actorAvatarDataPath
    }));
    try {
      const summary = actorAvatarCandidatesFromFiletree(getAppConfig().actorAvatarDataPath, {
        personId: body.personId,
        limit: clampInteger(body.limit, 24, 1, 200)
      });
      sendJson(res, 200, { ok: true, config: publicAppConfig(), summary });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "读取演员头像候选失败", config: publicAppConfig() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/apply-actor-avatar-candidate" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    setAppConfig(normalizeAppConfig({
      ...getAppConfig(),
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? getAppConfig().actorAvatarDataPath
    }));
    try {
      const result = importActorAvatarCandidate(getAppConfig().actorAvatarDataPath, body.personId, body.relPath, { dryRun: Boolean(body.dryRun) });
      sendJson(res, 200, { ok: true, config: publicAppConfig(), ...result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "应用演员头像候选失败", config: publicAppConfig() });
    }
    return true;
  }

  if (url.pathname === "/api/admin/rescan-person" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    const body = await readJsonBody(req);
    const person = library.peopleById.get(body.personId);
    if (!person) {
      sendJson(res, 404, { error: "人物不存在" });
      return true;
    }

    try {
      const nextPerson = refreshPersonLibrary(person.id);
      const works = sortWorkList(
        nextPerson.works
          .map((workId) => library.worksById.get(workId))
          .filter(Boolean),
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
    const person = library.peopleById.get(body.personId);
    if (!person) {
      sendJson(res, 404, { error: "人物不存在" });
      return true;
    }

    const profile = actorProfileRow(person.id);
    if (!profile?.javdb_url) {
      sendJson(res, 400, { error: "这个人物还没有配置 JavDB actor 页" });
      return true;
    }

    const sleep = clampInteger(body.sleep, 2, 0, 60);
    const args = [
      "-u",
      path.join("tools", "backfill_javdb_actor_page.py"),
      "--write",
      "--all-sources",
      "--person-id",
      person.id,
      "--actor-movies-only",
      "--fast",
      "--sleep",
      String(sleep),
      "--jitter",
      "0"
    ];
    const task = startAdminProcessTask({
      type: "actor-movies",
      label: "刷新缺失检测",
      person,
      command: "python",
      args,
      refreshHints: ["current-view"],
      onDone: () => {
        invalidateTableStamp("actor_movies");
        setActorMovieCache(null);
        setLocalWorkCachesDirty();
        clearSearchSourceCaches();
      }
    });
    sendJson(res, 202, { ok: true, task: publicAdminTask(task) });
    return true;
  }

  if (url.pathname === "/api/admin/refresh-rankings" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
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
    const task = startAdminProcessTask({
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
    sendJson(res, 202, { ok: true, task: publicAdminTask(task) });
    return true;
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
    const task = startAdminProcessTask({
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
    sendJson(res, 202, { ok: true, task: publicAdminTask(task) });
    return true;
  }

  return false;
}
