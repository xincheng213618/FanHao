import fs from "node:fs";
import path from "node:path";

const DOUBAN_COOKIE_PATH = path.join(process.cwd(), "data", "douban-cookie.txt");
const DOUBAN_TEST_SUBJECT_URL = "https://movie.douban.com/subject/35321946/";
const DOUBAN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

function normalizeDoubanCookieText(value) {
  return String(value || "")
    .replace(/^Cookie:\s*/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("; ")
    .trim();
}

function readDoubanCookieFile() {
  try {
    return normalizeDoubanCookieText(fs.readFileSync(DOUBAN_COOKIE_PATH, "utf8"));
  } catch {
    return "";
  }
}

function doubanCookieStatus(extra = {}) {
  let stat = null;
  try {
    stat = fs.statSync(DOUBAN_COOKIE_PATH);
  } catch {}
  const cookie = readDoubanCookieFile();
  return {
    exists: Boolean(stat && cookie),
    filePath: DOUBAN_COOKIE_PATH,
    bytes: stat?.size || 0,
    updatedAt: stat?.mtime ? stat.mtime.toISOString() : "",
    cookieNames: cookie
      ? cookie
          .split(";")
          .map((part) => part.trim().split("=")[0])
          .filter(Boolean)
          .slice(0, 12)
      : [],
    ...extra
  };
}

function isDoubanSecurityHtml(finalUrl, html) {
  if (/^https:\/\/sec\.douban\.com\//i.test(finalUrl || "")) return true;
  return /<form[^>]+name=["']sec["']/i.test(html || "") && /sec\.douban\.com|action=["']\/c["']/i.test(html || "");
}

async function testDoubanCookie(cookie) {
  if (!cookie) {
    const error = new Error("还没有保存豆瓣 Cookie");
    error.statusCode = 400;
    throw error;
  }
  const response = await fetch(DOUBAN_TEST_SUBJECT_URL, {
    headers: {
      "User-Agent": DOUBAN_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      Referer: "https://www.douban.com/",
      Cookie: cookie
    }
  });
  const html = await response.text();
  const finalUrl = response.url || DOUBAN_TEST_SUBJECT_URL;
  const title = html
    .match(/<title>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim() || "";
  const hasSubjectDetail =
    !isDoubanSecurityHtml(finalUrl, html) &&
    (html.includes("application/ld+json") || html.includes("v:average") || html.includes("v:summary"));
  return {
    ok: response.ok && hasSubjectDetail,
    status: response.status,
    finalUrl,
    title,
    hasSubjectDetail,
    error: response.ok && hasSubjectDetail ? "" : "Cookie 不能访问豆瓣详情页，可能已过期或需要重新复制。"
  };
}

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

  if (url.pathname === "/api/admin/douban-cookie" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    sendJson(res, 200, { ok: true, cookie: doubanCookieStatus() });
    return true;
  }

  if (url.pathname === "/api/admin/douban-cookie" && req.method === "PUT") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const cookie = normalizeDoubanCookieText(body.cookie || body.value || "");
      if (!cookie || cookie.length < 20 || !cookie.includes("=")) {
        sendJson(res, 400, { error: "Cookie 内容看起来不完整" });
        return true;
      }
      fs.mkdirSync(path.dirname(DOUBAN_COOKIE_PATH), { recursive: true });
      fs.writeFileSync(DOUBAN_COOKIE_PATH, cookie, "utf8");
      sendJson(res, 200, { ok: true, cookie: doubanCookieStatus({ saved: true }) });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "保存豆瓣 Cookie 失败" });
    }
    return true;
  }

  if (url.pathname === "/api/admin/douban-cookie/test" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const result = await testDoubanCookie(readDoubanCookieFile());
      sendJson(res, result.ok ? 200 : 409, { ok: result.ok, cookie: doubanCookieStatus(), test: result });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "测试豆瓣 Cookie 失败", cookie: doubanCookieStatus() });
    }
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
