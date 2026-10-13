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
  clearShortVideoListCache,
  clearSearchSourceCaches,
  clampInteger,
  coverGenerationStatus,
  cookieProfileDir,
  invalidateTableStamp,
  linkedPersonIds,
  nodeCommand,
  coreDbPath,
  coreImageDbPath,
  personOrganizationService,
  refreshLibrary,
  resolveLibraryPersonByPublicId,
  setActorMovieCache,
  setLocalWorkCachesDirty,
  setWorkInfoCache,
  syncPersonLocal
}) {
  const currentTasks = () => adminTaskService.list?.() || [];
  function organizePersonPayload(body = {}) {
    const person = resolveLibraryPersonByPublicId(body.personId);
    if (!person) throw httpError("人物不存在", 404);
    const active = currentTasks().find((task) => task.type === "person-organize"
      && String(task.personId) === String(person.id) && ["running", "stopping"].includes(task.status));
    if (active) return { ok: true, task: adminTaskService.publicTask(active) };
    if (currentTasks().some((task) => ["running", "stopping"].includes(task.status)
      && ["actor-movies", "script"].includes(task.type))) throw httpError("还有资料扫描任务正在运行，请完成后再整理", 409);
    if (body.preview || !body.planId) return { ok: true, plan: personOrganizationService.preview(person.id) };
    const plan = personOrganizationService.read(body.planId);
    if (String(plan.personId) !== String(person.id)) throw httpError("整理计划不属于当前人物", 409);
    if (plan.status === "done") throw httpError("这次整理已经完成，请重新预览", 409);
    if (!plan.groups.length) throw httpError("没有可以整理的本地作品", 400);
    plan.refreshMetadata = body.refreshMetadata !== false;
    // Mark before spawning so another request cannot generate a competing plan.
    plan.status = "running";
    const planFile = personOrganizationService.planPath(plan.id);
    fs.writeFileSync(`${planFile}.tmp`, JSON.stringify(plan, null, 2));
    fs.renameSync(`${planFile}.tmp`, planFile);
    const args = [path.join("tools", "organize_person_library.mjs"), "--plan", planFile,
      "--db", coreDbPath, "--image-db", coreImageDbPath];
    let outputBuffer = "", pathsReloaded = false;
    const task = adminTaskService.startProcessTask({
      type: "person-organize", label: "重新整理人物目录", person, command: nodeCommand, args,
      refreshHints: ["current-view"], invalidates: ["localWorks", "workInfo", "workCovers"],
      onStdout: (currentTask, chunk) => {
        outputBuffer += chunk;
        const lines = outputBuffer.split(/\r?\n/);
        outputBuffer = lines.pop().slice(-256);
        if (pathsReloaded || !lines.includes("PERSON_ORGANIZATION_PATHS_SYNCED")) return;
        pathsReloaded = true;
        try {
          setLocalWorkCachesDirty();
          clearSearchSourceCaches();
          if (!refreshLibrary()) throw new Error("重新加载失败");
          currentTask.logs.push("文件路径已同步，可继续播放；正在更新封面和 info");
        } catch (error) { currentTask.logs.push(`ERROR 文件路径重载失败：${error.message}`); }
      },
      onDone: (completedTask) => {
        try {
          setLocalWorkCachesDirty();
          setWorkInfoCache(null);
          clearSearchSourceCaches();
          if (!refreshLibrary()) throw new Error("整理后重新加载索引失败");
          const latest = personOrganizationService.read(plan.id);
          if (latest.groups.some((group) => !group.done)) return;
          const result = syncPersonLocal(person.id);
          if (!result) throw new Error("人物本地目录未能同步");
          if (result?.bindingWarnings?.length) throw new Error(result.bindingWarnings.map((w) => w.message).join("；"));
          completedTask.logs.push(plan.refreshMetadata ? "目录、封面、info 与本地索引已同步" : "目录与本地索引已同步");
        } catch (error) { completedTask.status = "error"; completedTask.logs.push(`ERROR 本地索引同步失败：${error.message}`); }
      }
    });
    return { ok: true, task: adminTaskService.publicTask(task) };
  }

  function refreshActorMoviesPayload(body = {}) {
    if (currentTasks().some((task) => task.type === "person-organize" && ["running", "stopping"].includes(task.status))) {
      throw httpError("人物目录正在整理，请完成后再扫描资料", 409);
    }
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
    const actorWaitSeconds = clampInteger(body.actorWaitSeconds, fullActorScan ? 300 : 120, 15, 600);
    const args = [
      "-u",
      path.join("tools", "refresh_core_javdb_actor_movies.py"),
      "--profile-dir",
      path.resolve("data", "selenium-core-actor-refresh-profile"),
      "--write",
      "--max-pages",
      String(maxPages),
      "--actor-wait-seconds",
      String(actorWaitSeconds),
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
      onDone: (completedTask) => {
        invalidateTableStamp("actor_movies");
        setActorMovieCache(null);
        setLocalWorkCachesDirty();
        const nextLibrary = refreshLibrary?.();
        clearSearchSourceCaches();
        if (completedTask.status !== "done") return;
        if (!nextLibrary) {
          completedTask.status = "error";
          completedTask.logs.push("ERROR JavDB 已更新，但本地资料库重新加载失败");
          return;
        }
        const personIds = person ? [person.id] : linkedPersonIds();
        for (const personId of new Set(personIds.map(String))) {
          const currentPerson = resolveLibraryPersonByPublicId(personId);
          const name = currentPerson?.name || personId;
          try {
            completedTask.logs.push(`正在同步本地文件：${name}`);
            const result = syncPersonLocal(personId);
            completedTask.logs.push(result
              ? `本地已同步：${name} · ${result.person.workCount} 部 · ${result.person.videoCount} 个视频`
              : `本地同步已跳过：${name} · 未配置本地来源`);
            if (result?.bindingWarnings?.length) {
              completedTask.status = "error";
              completedTask.logs.push(`ERROR ${name} 其余作品已同步，但 ${result.bindingWarnings.length} 个目录关联待确认；已保留原有记录`);
              for (const warning of result.bindingWarnings) completedTask.logs.push(warning.message);
            }
          } catch (error) {
            completedTask.status = "error";
            completedTask.logs.push(`ERROR JavDB 已更新，但 ${name} 本地同步失败：${error.message}`);
          }
        }
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

  function generateMissingShortVideoCoversPayload(body = {}) {
    const limit = clampInteger(body.limit, 50, 1, 50000);
    const concurrency = clampInteger(body.concurrency, 4, 1, 16);
    const args = [
      path.join("tools", "generate_missing_short_video_covers.mjs"),
      "--write",
      "--limit",
      String(limit),
      "--concurrency",
      String(concurrency)
    ];
    const task = adminTaskService.startProcessTask({
      type: "short-video-covers",
      label: `补短视频封面 ${limit} x${concurrency}`,
      person: null,
      command: nodeCommand,
      args,
      refreshHints: ["short-videos", "current-view"],
      onDone: () => {
        clearShortVideoListCache?.();
      }
    });

    return { ok: true, task: adminTaskService.publicTask(task) };
  }

  async function coverCacheStatusPayload(limitValue) {
    const sampleLimit = clampInteger(limitValue, 8, 0, 50);
    return await coverGenerationStatus(sampleLimit);
  }

  return {
    organizePersonPayload,
    coverCacheStatusPayload,
    generateMissingCoversPayload,
    generateMissingShortVideoCoversPayload,
    refreshActorMoviesPayload
  };
}
