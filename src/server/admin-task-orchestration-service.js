export function createAdminTaskOrchestrationService({
  adminScriptService,
  adminTaskService,
  resolveLibraryPersonByPublicId
}) {
  function tasksPayload() {
    return {
      tasks: adminTaskService.list().map(adminTaskService.publicTask),
      summary: adminTaskService.summary(),
      historyLimit: adminTaskService.historyLimit
    };
  }

  function stopTaskPayload(taskId) {
    const task = adminTaskService.stopTask(taskId);
    return { ok: true, task: adminTaskService.publicTask(task) };
  }

  function scriptsPayload() {
    return {
      scripts: adminScriptService.definitions.map(adminScriptService.publicScript),
      categories: adminScriptService.categories()
    };
  }

  function runScriptPayload(body = {}) {
    const script = adminScriptService.byId(body.scriptId);
    if (!script) {
      const error = new Error("脚本不存在");
      error.statusCode = 404;
      throw error;
    }
    if (script.id === "image-library-rescan" && adminTaskService.hasRunningScript(script.id)) {
      const error = new Error("图库索引刷新已经在后台运行");
      error.statusCode = 409;
      throw error;
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

    return {
      ok: true,
      task: adminTaskService.publicTask(task),
      script: adminScriptService.publicScript(script)
    };
  }

  return {
    runScriptPayload,
    scriptsPayload,
    stopTaskPayload,
    tasksPayload
  };
}
