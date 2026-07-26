import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TASK_STATUSES = new Set(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]);
const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "cancelling"]);
const TASK_MODES = new Set(["collect", "test"]);
const MAX_TASK_HISTORY = 200;

export const BUILTIN_NOVEL_ADAPTERS = Object.freeze([
  Object.freeze({
    id: "diyibanzhu",
    name: "第一版主",
    driver: "diyibanzhu",
    system: true,
    description: "完整目录、合集范围去重和章节内分页。",
    matchHosts: ["diyibanzhu.me", "*.diyibanzhu.me"],
    config: Object.freeze({
      delayMs: 500,
      timeoutMs: 30000,
      maxChapters: 0,
      useEnvProxy: false,
      skipCoveredRanges: true
    })
  }),
  Object.freeze({
    id: "cool18",
    name: "Cool18 帖子链",
    driver: "cool18",
    system: true,
    description: "从起始帖子递归整理同站 threadview 章节链。",
    matchHosts: ["cool18.com", "*.cool18.com", "6park.com", "*.6park.com"],
    config: Object.freeze({
      delayMs: 1000,
      timeoutMs: 30000,
      maxChapters: 30,
      useEnvProxy: false
    })
  }),
  Object.freeze({
    id: "alicesw",
    name: "爱丽丝书屋",
    driver: "alicesw",
    system: true,
    description: "自动解析作品页或章节目录页，支持中文章节序号。",
    matchHosts: ["alicesw.com", "*.alicesw.com"],
    config: Object.freeze({
      delayMs: 5000,
      timeoutMs: 30000,
      maxChapters: 0,
      useEnvProxy: false
    })
  })
]);

export function createNovelCollectionStore({ dbPath } = {}) {
  if (!dbPath) throw new Error("novel collection dbPath is required");
  let db = null;

  function getDb() {
    if (!db) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      ensureSchema(db);
    }
    return db;
  }

  function close() {
    if (!db) return;
    try {
      db.close();
    } catch {}
    db = null;
  }

  function listAdapters() {
    const custom = getDb()
      .prepare("SELECT * FROM novel_collection_adapters ORDER BY name COLLATE NOCASE, created_at")
      .all()
      .map(publicCustomAdapter);
    return [...BUILTIN_NOVEL_ADAPTERS.map(publicSystemAdapter), ...custom];
  }

  function getAdapter(id) {
    const key = String(id || "").trim();
    const system = BUILTIN_NOVEL_ADAPTERS.find((item) => item.id === key);
    if (system) return publicSystemAdapter(system);
    const row = getDb().prepare("SELECT * FROM novel_collection_adapters WHERE id = ?").get(key);
    return row ? publicCustomAdapter(row) : null;
  }

  function createAdapter(input = {}) {
    const normalized = normalizeCustomAdapter(input);
    const now = new Date().toISOString();
    const id = `custom-${crypto.randomUUID()}`;
    getDb()
      .prepare(
        `
        INSERT INTO novel_collection_adapters (
          id, name, description, match_hosts_json, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        normalized.name,
        normalized.description,
        JSON.stringify(normalized.matchHosts),
        JSON.stringify(normalized.config),
        now,
        now
      );
    return getAdapter(id);
  }

  function updateAdapter(id, input = {}) {
    const current = getAdapter(id);
    if (!current) throw httpError(404, "适配器不存在");
    if (current.system) throw httpError(405, "内置适配器不可修改，请新建自定义适配器");
    const normalized = normalizeCustomAdapter({ ...current, ...input, config: { ...current.config, ...(input.config || {}) } });
    getDb()
      .prepare(
        `
        UPDATE novel_collection_adapters
        SET name = ?, description = ?, match_hosts_json = ?, config_json = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(
        normalized.name,
        normalized.description,
        JSON.stringify(normalized.matchHosts),
        JSON.stringify(normalized.config),
        new Date().toISOString(),
        current.id
      );
    return getAdapter(current.id);
  }

  function deleteAdapter(id) {
    const current = getAdapter(id);
    if (!current) return null;
    if (current.system) throw httpError(405, "内置适配器不可删除");
    const result = getDb().prepare("DELETE FROM novel_collection_adapters WHERE id = ?").run(current.id);
    return result.changes ? current : null;
  }

  function resolveAdapter(urlValue, requestedId = "") {
    const url = normalizeHttpUrl(urlValue);
    const adapterId = String(requestedId || "").trim();
    if (adapterId && adapterId !== "auto") {
      const adapter = getAdapter(adapterId);
      if (!adapter) throw httpError(400, "所选采集适配器不存在");
      return { adapter, url };
    }
    const host = urlObject(url).hostname.toLowerCase();
    const adapters = listAdapters();
    const custom = adapters.filter((adapter) => !adapter.system);
    const system = adapters.filter((adapter) => adapter.system);
    const adapter = [...custom, ...system].find((candidate) =>
      candidate.matchHosts.some((pattern) => hostMatches(host, pattern))
    );
    if (!adapter) throw httpError(400, "没有匹配该网址的适配器，请先新建自定义适配器");
    return { adapter, url };
  }

  function listTasks({ limit = MAX_TASK_HISTORY } = {}) {
    const safeLimit = clampInteger(limit, MAX_TASK_HISTORY, 1, MAX_TASK_HISTORY);
    return getDb()
      .prepare("SELECT * FROM novel_collection_tasks ORDER BY created_at DESC LIMIT ?")
      .all(safeLimit)
      .map(publicTask);
  }

  function getTask(id) {
    const row = getDb().prepare("SELECT * FROM novel_collection_tasks WHERE id = ?").get(String(id || ""));
    return row ? publicTask(row) : null;
  }

  function createTask(input = {}) {
    const resolved = resolveAdapter(input.url || input.startUrl, input.adapterId);
    const mode = TASK_MODES.has(String(input.mode || "")) ? String(input.mode) : "collect";
    const options = normalizeTaskOptions(input.options || {}, mode);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const name = cleanText(input.name, 120) || `${mode === "test" ? "测试" : "采集"}：${resolved.adapter.name}`;
    getDb()
      .prepare(
        `
        INSERT INTO novel_collection_tasks (
          id, name, adapter_id, adapter_name, adapter_snapshot_json, start_url, mode, options_json,
          status, progress_current, progress_total, message, book_id, result_json, error, log_tail,
          attempt, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, '', '{}', '', '', 0, ?, '', '', ?)
      `
      )
      .run(
        id,
        name,
        resolved.adapter.id,
        resolved.adapter.name,
        JSON.stringify(resolved.adapter),
        resolved.url,
        mode,
        JSON.stringify(options),
        "等待执行",
        now,
        now
      );
    trimHistory();
    return getTask(id);
  }

  function prepareTaskRun(id) {
    const current = requireTask(id);
    if (["running", "cancelling"].includes(current.status)) throw httpError(409, "任务正在运行");
    const currentAdapter = getAdapter(current.adapterId);
    const adapter = currentAdapter || current.adapterSnapshot;
    if (!adapter) throw httpError(400, "任务缺少可用适配器");
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `
        UPDATE novel_collection_tasks
        SET adapter_name = ?, adapter_snapshot_json = ?, status = 'queued',
            progress_current = 0, progress_total = 0, message = ?, book_id = '',
            result_json = '{}', error = '', log_tail = '', started_at = '', finished_at = '',
            updated_at = ?
        WHERE id = ?
      `
      )
      .run(adapter.name, JSON.stringify(adapter), "等待执行", now, current.id);
    return getTask(current.id);
  }

  function markRunning(id) {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `
        UPDATE novel_collection_tasks
        SET status = 'running', message = ?, error = '', started_at = ?, finished_at = '',
            attempt = attempt + 1, updated_at = ?
        WHERE id = ?
      `
      )
      .run("正在启动采集器", now, now, String(id || ""));
    return getTask(id);
  }

  function updateProgress(id, patch = {}) {
    const current = requireTask(id);
    const progressCurrent = clampInteger(patch.current, current.progressCurrent, 0, Number.MAX_SAFE_INTEGER);
    const progressTotal = clampInteger(patch.total, current.progressTotal, 0, Number.MAX_SAFE_INTEGER);
    const message = cleanText(patch.message, 500) || current.message;
    const logTail = cleanLogTail(patch.logTail ?? current.logTail);
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `
        UPDATE novel_collection_tasks
        SET progress_current = ?, progress_total = ?, message = ?, log_tail = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(progressCurrent, progressTotal, message, logTail, now, current.id);
    return getTask(current.id);
  }

  function markCancelling(id) {
    const current = requireTask(id);
    if (current.status !== "running") return current;
    getDb()
      .prepare("UPDATE novel_collection_tasks SET status = 'cancelling', message = ?, updated_at = ? WHERE id = ?")
      .run("正在取消", new Date().toISOString(), current.id);
    return getTask(current.id);
  }

  function completeTask(id, { bookId = "", result = {}, message = "采集完成", logTail = "" } = {}) {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `
        UPDATE novel_collection_tasks
        SET status = 'succeeded', message = ?, book_id = ?, result_json = ?, error = '',
            log_tail = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(
        cleanText(message, 500) || "采集完成",
        String(bookId || ""),
        JSON.stringify(result && typeof result === "object" ? result : {}),
        cleanLogTail(logTail),
        now,
        now,
        String(id || "")
      );
    return getTask(id);
  }

  function failTask(id, error, { cancelled = false, logTail = "" } = {}) {
    const now = new Date().toISOString();
    const message = cleanText(error?.message || error, 1500) || (cancelled ? "任务已取消" : "采集失败");
    getDb()
      .prepare(
        `
        UPDATE novel_collection_tasks
        SET status = ?, message = ?, error = ?, log_tail = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(
        cancelled ? "cancelled" : "failed",
        cancelled ? "任务已取消" : message,
        cancelled ? "" : message,
        cleanLogTail(logTail),
        now,
        now,
        String(id || "")
      );
    return getTask(id);
  }

  function deleteTask(id) {
    const current = getTask(id);
    if (!current) return null;
    if (ACTIVE_TASK_STATUSES.has(current.status)) throw httpError(409, "运行中或排队中的任务不能删除");
    const result = getDb().prepare("DELETE FROM novel_collection_tasks WHERE id = ?").run(current.id);
    return result.changes ? current : null;
  }

  function queuedTasks() {
    return getDb()
      .prepare("SELECT * FROM novel_collection_tasks WHERE status = 'queued' ORDER BY created_at, id")
      .all()
      .map(publicTask);
  }

  function recoverInterruptedTasks() {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `
        UPDATE novel_collection_tasks
        SET status = 'failed', message = ?, error = ?, finished_at = ?, updated_at = ?
        WHERE status IN ('running', 'cancelling')
      `
      )
      .run("服务重启，任务已中断", "服务重启，任务已中断，可重新执行", now, now);
  }

  function summary() {
    const rows = getDb()
      .prepare("SELECT status, COUNT(*) AS count FROM novel_collection_tasks GROUP BY status")
      .all();
    const status = Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
    return {
      adapters: listAdapters().length,
      customAdapters: Number(getDb().prepare("SELECT COUNT(*) AS count FROM novel_collection_adapters").get()?.count || 0),
      tasks: Object.values(status).reduce((total, count) => total + count, 0),
      active: Number(status.queued || 0) + Number(status.running || 0) + Number(status.cancelling || 0),
      status
    };
  }

  function requireTask(id) {
    const task = getTask(id);
    if (!task) throw httpError(404, "采集任务不存在");
    return task;
  }

  function trimHistory() {
    getDb()
      .prepare(
        `
        DELETE FROM novel_collection_tasks
        WHERE id IN (
          SELECT id FROM novel_collection_tasks
          WHERE status NOT IN ('queued', 'running', 'cancelling')
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )
      `
      )
      .run(MAX_TASK_HISTORY);
  }

  return {
    close,
    completeTask,
    createAdapter,
    createTask,
    dbPath,
    deleteAdapter,
    deleteTask,
    failTask,
    getAdapter,
    getTask,
    listAdapters,
    listTasks,
    markCancelling,
    markRunning,
    prepareTaskRun,
    queuedTasks,
    recoverInterruptedTasks,
    resolveAdapter,
    summary,
    updateAdapter,
    updateProgress
  };
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS novel_collection_adapters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      match_hosts_json TEXT NOT NULL DEFAULT '[]',
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS novel_collection_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      adapter_snapshot_json TEXT NOT NULL DEFAULT '{}',
      start_url TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'collect',
      options_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      progress_current INTEGER NOT NULL DEFAULT 0,
      progress_total INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      book_id TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      log_tail TEXT NOT NULL DEFAULT '',
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_novel_collection_tasks_status
      ON novel_collection_tasks(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_novel_collection_tasks_created
      ON novel_collection_tasks(created_at DESC);
  `);
}

function normalizeCustomAdapter(input) {
  const name = cleanText(input.name, 100);
  if (!name) throw httpError(400, "适配器名称不能为空");
  const matchHosts = normalizeHosts(input.matchHosts ?? input.match_hosts);
  if (!matchHosts.length) throw httpError(400, "至少填写一个匹配域名");
  const sourceConfig = input.config && typeof input.config === "object" && !Array.isArray(input.config) ? input.config : input;
  const config = normalizeGenericConfig(sourceConfig);
  if (!config.contentSelector) throw httpError(400, "正文 CSS 选择器不能为空");
  return {
    name,
    description: cleanText(input.description, 500),
    matchHosts,
    config
  };
}

function normalizeGenericConfig(config = {}) {
  return {
    bookTitleSelector: cleanText(config.bookTitleSelector, 500),
    authorSelector: cleanText(config.authorSelector, 500),
    catalogSelector: cleanText(config.catalogSelector, 500),
    chapterLinkSelector: cleanText(config.chapterLinkSelector, 500),
    chapterTitleSelector: cleanText(config.chapterTitleSelector, 500),
    contentSelector: cleanText(config.contentSelector, 500),
    removeSelectors: normalizeStringList(config.removeSelectors, 100, 500),
    removeLinePatterns: normalizeStringList(config.removeLinePatterns, 100, 500),
    chapterUrlPattern: validateRegexText(config.chapterUrlPattern),
    catalogNextSelector: cleanText(config.catalogNextSelector, 500),
    chapterNextSelector: cleanText(config.chapterNextSelector, 500),
    sortMode: ["document", "numeric"].includes(String(config.sortMode || "")) ? String(config.sortMode) : "document",
    maxCatalogPages: clampInteger(config.maxCatalogPages, 10, 1, 100),
    maxChapterPages: clampInteger(config.maxChapterPages, 20, 1, 200),
    maxChapters: clampInteger(config.maxChapters, 0, 0, 20000),
    delayMs: clampInteger(config.delayMs, 800, 0, 60000),
    timeoutMs: clampInteger(config.timeoutMs, 30000, 3000, 120000),
    useEnvProxy: Boolean(config.useEnvProxy)
  };
}

function normalizeTaskOptions(options = {}, mode = "collect") {
  return {
    maxChapters: clampInteger(options.maxChapters, mode === "test" ? 1 : -1, -1, 20000),
    delayMs: clampInteger(options.delayMs, -1, -1, 60000),
    timeoutMs: clampInteger(options.timeoutMs, -1, -1, 120000)
  };
}

function publicSystemAdapter(adapter) {
  return {
    id: adapter.id,
    name: adapter.name,
    driver: adapter.driver,
    system: true,
    description: adapter.description,
    matchHosts: [...adapter.matchHosts],
    config: { ...adapter.config },
    createdAt: "",
    updatedAt: ""
  };
}

function publicCustomAdapter(row) {
  return {
    id: row.id,
    name: row.name || "",
    driver: "generic",
    system: false,
    description: row.description || "",
    matchHosts: parseJsonArray(row.match_hosts_json),
    config: { ...normalizeGenericConfig(parseJsonObject(row.config_json)) },
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function publicTask(row) {
  const status = TASK_STATUSES.has(row.status) ? row.status : "failed";
  return {
    id: row.id,
    name: row.name || "",
    adapterId: row.adapter_id || "",
    adapterName: row.adapter_name || "",
    adapterSnapshot: parseJsonObject(row.adapter_snapshot_json),
    startUrl: row.start_url || "",
    mode: TASK_MODES.has(row.mode) ? row.mode : "collect",
    options: parseJsonObject(row.options_json),
    status,
    progressCurrent: Number(row.progress_current || 0),
    progressTotal: Number(row.progress_total || 0),
    message: row.message || "",
    bookId: row.book_id || "",
    result: parseJsonObject(row.result_json),
    error: row.error || "",
    logTail: row.log_tail || "",
    attempt: Number(row.attempt || 0),
    createdAt: row.created_at || "",
    startedAt: row.started_at || "",
    finishedAt: row.finished_at || "",
    updatedAt: row.updated_at || ""
  };
}

function normalizeHosts(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,;，；]+/);
  return [...new Set(values
    .map((item) => String(item || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, ""))
    .filter((item) => /^(\*\.)?[a-z0-9.-]+$/i.test(item) && !item.includes(".."))
  )].slice(0, 50);
}

function hostMatches(host, pattern) {
  const expected = String(pattern || "").toLowerCase();
  if (!expected) return false;
  if (expected.startsWith("*.")) {
    const suffix = expected.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === expected;
}

function normalizeHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, "网页地址不能为空");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw httpError(400, "网页地址格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw httpError(400, "只支持 HTTP 或 HTTPS 网页");
  if (!parsed.hostname) throw httpError(400, "网页地址缺少域名");
  parsed.hash = "";
  return parsed.toString();
}

function urlObject(value) {
  return new URL(value);
}

function normalizeStringList(value, maxItems, maxLength) {
  const source = Array.isArray(value) ? value : String(value || "").split(/\r?\n|,/);
  return [...new Set(source.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function validateRegexText(value) {
  const pattern = cleanText(value, 500);
  if (!pattern) return "";
  try {
    new RegExp(pattern);
  } catch {
    throw httpError(400, "章节网址正则表达式无效");
  }
  return pattern;
}

function cleanText(value, maxLength = 500) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanLogTail(value) {
  return String(value || "").replace(/\u0000/g, "").slice(-16000);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clampInteger(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
