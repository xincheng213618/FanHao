import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PENDING = 1_000;
const UNKNOWN = "未知";
const ACCESS_LOG_BOOTSTRAP_KEY = "access_log_bootstrap_v1";

function localDay(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function requestKind(req, url) {
  const pathname = String(url?.pathname || "/");
  const accept = String(req?.headers?.accept || "");
  const destination = String(req?.headers?.["sec-fetch-dest"] || "");
  return {
    pageView: req?.method === "GET" && (destination === "document" || accept.includes("text/html")),
    api: pathname.startsWith("/api/"),
    media: pathname.startsWith("/media/")
  };
}

function mergeCounter(target, source) {
  target.requests += source.requests;
  target.pageViews += source.pageViews;
  target.apiRequests += source.apiRequests;
  target.mediaRequests += source.mediaRequests;
  target.deniedRequests += source.deniedRequests;
  target.errorRequests += source.errorRequests;
  target.responseBytes += source.responseBytes;
  if (source.firstSeen < target.firstSeen) target.firstSeen = source.firstSeen;
  if (source.lastSeen >= target.lastSeen) {
    target.lastSeen = source.lastSeen;
    target.lastPath = source.lastPath;
    target.userAgent = source.userAgent;
  }
}

function publicNumber(value) {
  return Number(value || 0);
}

export function createAccessAnalyticsService({
  dbPath,
  ensureDataDir,
  ipRegionService,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxPending = DEFAULT_MAX_PENDING,
  createDatabase = (filePath) => new DatabaseSync(filePath)
}) {
  ensureDataDir?.();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db = createDatabase(dbPath);
  let pending = new Map();
  let flushTimer = null;
  let flushPromise = Promise.resolve();
  let flushQueued = false;
  let closed = false;
  const serviceStartedAt = new Date().toISOString();

  initializeSchema(db);
  const statements = createStatements(db);

  function attach(req, res, url, authState, startedAt = Date.now()) {
    res.on("finish", () => record(req, res, url, authState, startedAt));
  }

  function record(req, res, url, authState) {
    if (closed) return;
    const now = new Date();
    const timestamp = now.toISOString();
    const ip = String(authState?.access?.clientAddress || "").trim() || UNKNOWN;
    const authReason = String(authState?.reason || "unknown");
    const accessMode = String(authState?.access?.mode || "unknown");
    const kind = requestKind(req, url);
    const entry = {
      day: localDay(now),
      ip,
      authReason,
      accessMode,
      requests: 1,
      pageViews: kind.pageView ? 1 : 0,
      apiRequests: kind.api ? 1 : 0,
      mediaRequests: kind.media ? 1 : 0,
      deniedRequests: authReason === "missing-password" || res.statusCode === 401 ? 1 : 0,
      errorRequests: res.statusCode >= 400 ? 1 : 0,
      responseBytes: Math.max(0, Number(res.getHeader?.("Content-Length") || 0)),
      firstSeen: timestamp,
      lastSeen: timestamp,
      lastPath: String(url?.pathname || "/").slice(0, 500),
      userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 300)
    };
    const key = `${entry.day}\0${ip}\0${authReason}\0${accessMode}`;
    enqueue(key, entry);
  }

  function enqueue(key, entry) {
    const current = pending.get(key);
    if (current) mergeCounter(current, entry);
    else pending.set(key, entry);

    if (pending.size >= maxPending) queueFlush();
    else ensureFlushTimer();
  }

  async function bootstrapFromAccessLogs(logPaths = []) {
    if (statements.selectMeta.get(ACCESS_LOG_BOOTSTRAP_KEY)?.value) {
      return { imported: 0, scanned: 0, skipped: true };
    }
    const cutoff = statements.firstTracked.get()?.first_seen || serviceStartedAt;
    let imported = 0;
    let scanned = 0;

    for (const logPath of logPaths) {
      if (!fs.statSync(logPath, { throwIfNoEntry: false })?.isFile()) continue;
      const lines = readline.createInterface({
        input: fs.createReadStream(logPath, { encoding: "utf8" }),
        crlfDelay: Infinity
      });
      for await (const line of lines) {
        scanned += 1;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = historicalLogEntry(row, cutoff);
        if (!entry) continue;
        const key = `${entry.day}\0${entry.ip}\0${entry.authReason}\0${entry.accessMode}`;
        enqueue(key, entry);
        imported += 1;
        if (pending.size >= maxPending) await queueFlush();
      }
    }

    await queueFlush();
    statements.upsertMeta.run(ACCESS_LOG_BOOTSTRAP_KEY, JSON.stringify({
      imported,
      scanned,
      cutoff,
      completedAt: new Date().toISOString()
    }));
    return { imported, scanned, skipped: false, cutoff };
  }

  function ensureFlushTimer() {
    if (flushTimer || closed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      queueFlush();
    }, flushIntervalMs);
    flushTimer.unref?.();
  }

  function queueFlush() {
    if (flushQueued) return flushPromise;
    flushQueued = true;
    const run = flushPromise.then(flushNow, flushNow);
    flushPromise = run.finally(() => {
      flushQueued = false;
      if (pending.size && !closed) ensureFlushTimer();
    });
    return flushPromise;
  }

  async function flushNow() {
    if (!pending.size || closed) return;
    const batch = pending;
    pending = new Map();
    const geoByIp = new Map();

    try {
      for (const ip of new Set([...batch.values()].map((entry) => entry.ip))) {
        const cached = statements.selectGeo.get(ip);
        if (cached) {
          geoByIp.set(ip, cached);
          continue;
        }
        const located = await ipRegionService.lookup(ip);
        const geo = {
          ip,
          country: located.country || UNKNOWN,
          province: located.province || UNKNOWN,
          city: located.city || UNKNOWN,
          isp: located.isp || UNKNOWN,
          isoCode: located.isoCode || "",
          located: located.located ? 1 : 0,
          ipVersion: Number(located.ipVersion || 0),
          lookupError: located.reason || "",
          updatedAt: new Date().toISOString()
        };
        geoByIp.set(ip, geo);
      }

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const geo of geoByIp.values()) {
          statements.upsertGeo.run(
            geo.ip,
            geo.country,
            geo.province,
            geo.city,
            geo.isp,
            geo.isoCode || geo.iso_code || "",
            Number(geo.located || 0),
            Number(geo.ipVersion || geo.ip_version || 0),
            geo.lookupError || geo.lookup_error || "",
            geo.updatedAt || geo.updated_at || new Date().toISOString()
          );
        }
        for (const entry of batch.values()) upsertEntry(statements, entry);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      for (const [key, entry] of batch) {
        const current = pending.get(key);
        if (current) mergeCounter(current, entry);
        else pending.set(key, entry);
      }
      console.warn("[access-analytics]", error?.message || error);
      ensureFlushTimer();
    }
  }

  async function statsPayload(url) {
    await queueFlush();
    const filters = parseFilters(url);
    const { where, params } = buildWhere(filters);
    const source = `FROM access_daily d LEFT JOIN access_ip_geo g ON g.ip = d.ip ${where}`;
    const summaryRow = db.prepare(`
      SELECT
        COUNT(DISTINCT d.ip) AS unique_ips,
        COALESCE(SUM(d.request_count), 0) AS requests,
        COALESCE(SUM(d.page_view_count), 0) AS page_views,
        COALESCE(SUM(d.denied_count), 0) AS denied_requests,
        COALESCE(SUM(d.error_count), 0) AS error_requests,
        COALESCE(SUM(CASE WHEN d.auth_reason = 'missing-password' THEN d.request_count ELSE 0 END), 0) AS missing_password_requests,
        COALESCE(SUM(CASE WHEN d.auth_reason = 'password' THEN d.request_count ELSE 0 END), 0) AS password_requests,
        COALESCE(SUM(CASE WHEN d.auth_reason = 'trusted-network' THEN d.request_count ELSE 0 END), 0) AS trusted_network_requests,
        COALESCE(SUM(CASE WHEN d.auth_reason IN ('app', 'app-cookie') THEN d.request_count ELSE 0 END), 0) AS injected_requests,
        MIN(d.first_seen) AS first_seen,
        MAX(d.last_seen) AS last_seen
      ${source}
    `).get(...params) || {};

    const auth = db.prepare(`
      SELECT d.auth_reason AS reason, COUNT(DISTINCT d.ip) AS unique_ips,
        SUM(d.request_count) AS requests, SUM(d.page_view_count) AS page_views,
        SUM(d.denied_count) AS denied_requests
      ${source}
      GROUP BY d.auth_reason
      ORDER BY requests DESC
    `).all(...params).map(publicAggregateRow);

    const provinces = db.prepare(`
      SELECT COALESCE(NULLIF(g.province, ''), '${UNKNOWN}') AS province,
        COUNT(DISTINCT d.ip) AS unique_ips, SUM(d.request_count) AS requests,
        SUM(d.page_view_count) AS page_views
      ${source}
      GROUP BY COALESCE(NULLIF(g.province, ''), '${UNKNOWN}')
      ORDER BY requests DESC, province
      LIMIT 20
    `).all(...params).map(publicAggregateRow);

    const daily = db.prepare(`
      SELECT d.day, COUNT(DISTINCT d.ip) AS unique_ips,
        SUM(d.request_count) AS requests, SUM(d.page_view_count) AS page_views,
        SUM(d.denied_count) AS denied_requests
      ${source}
      GROUP BY d.day
      ORDER BY d.day
    `).all(...params).map(publicAggregateRow);

    const groupColumns = "d.ip, d.auth_reason, d.access_mode";
    const total = publicNumber(db.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 ${source} GROUP BY ${groupColumns})`).get(...params)?.count);
    const visitors = db.prepare(`
      SELECT d.ip, d.auth_reason, d.access_mode,
        COALESCE(NULLIF(g.country, ''), '${UNKNOWN}') AS country,
        COALESCE(NULLIF(g.province, ''), '${UNKNOWN}') AS province,
        COALESCE(NULLIF(g.city, ''), '${UNKNOWN}') AS city,
        COALESCE(NULLIF(g.isp, ''), '${UNKNOWN}') AS isp,
        MAX(COALESCE(g.located, 0)) AS located,
        SUM(d.request_count) AS requests,
        SUM(d.page_view_count) AS page_views,
        SUM(d.api_count) AS api_requests,
        SUM(d.media_count) AS media_requests,
        SUM(d.denied_count) AS denied_requests,
        SUM(d.error_count) AS error_requests,
        SUM(d.response_bytes) AS response_bytes,
        MIN(d.first_seen) AS first_seen,
        MAX(d.last_seen) AS last_seen,
        MAX(d.last_path) AS last_path,
        MAX(d.user_agent) AS user_agent
      ${source}
      GROUP BY ${groupColumns}
      ORDER BY requests DESC, last_seen DESC
      LIMIT ? OFFSET ?
    `).all(...params, filters.limit, filters.offset).map((row) => ({
      ...row,
      located: Boolean(row.located),
      requests: publicNumber(row.requests),
      pageViews: publicNumber(row.page_views),
      apiRequests: publicNumber(row.api_requests),
      mediaRequests: publicNumber(row.media_requests),
      deniedRequests: publicNumber(row.denied_requests),
      errorRequests: publicNumber(row.error_requests),
      responseBytes: publicNumber(row.response_bytes),
      authReason: row.auth_reason,
      accessMode: row.access_mode,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      lastPath: row.last_path,
      userAgent: row.user_agent
    }));

    const optionFilters = { ...filters, province: "", query: "" };
    const optionWhere = buildWhere(optionFilters);
    const provinceOptions = db.prepare(`
      SELECT DISTINCT COALESCE(NULLIF(g.province, ''), '${UNKNOWN}') AS province
      FROM access_daily d LEFT JOIN access_ip_geo g ON g.ip = d.ip
      ${optionWhere.where}
      ORDER BY province
    `).all(...optionWhere.params).map((row) => row.province);

    return {
      generatedAt: new Date().toISOString(),
      filters,
      geo: ipRegionService.status(),
      summary: {
        uniqueIps: publicNumber(summaryRow.unique_ips),
        requests: publicNumber(summaryRow.requests),
        pageViews: publicNumber(summaryRow.page_views),
        deniedRequests: publicNumber(summaryRow.denied_requests),
        errorRequests: publicNumber(summaryRow.error_requests),
        missingPasswordRequests: publicNumber(summaryRow.missing_password_requests),
        passwordRequests: publicNumber(summaryRow.password_requests),
        trustedNetworkRequests: publicNumber(summaryRow.trusted_network_requests),
        injectedRequests: publicNumber(summaryRow.injected_requests),
        firstSeen: summaryRow.first_seen || "",
        lastSeen: summaryRow.last_seen || ""
      },
      auth,
      provinces,
      provinceOptions,
      daily,
      visitors,
      pagination: { total, limit: filters.limit, offset: filters.offset }
    };
  }

  async function close() {
    if (closed) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    await queueFlush();
    closed = true;
    ipRegionService.close?.();
    db.close();
    db = null;
  }

  return { attach, bootstrapFromAccessLogs, close, flush: queueFlush, record, statsPayload };
}

function historicalLogEntry(row, cutoff) {
  const timestamp = String(row?.time || "");
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime()) || timestamp >= cutoff) return null;
  const ip = String(row.remote || "").trim() || UNKNOWN;
  const authReason = String(row.auth || "unknown");
  const accessMode = String(row.access || "unknown");
  const rawPath = String(row.path || "/");
  let pathname = rawPath.split("?", 1)[0] || "/";
  try {
    pathname = new URL(rawPath, "http://fanhao.local").pathname;
  } catch {}
  const method = String(row.method || "GET").toUpperCase();
  const status = Number(row.status || 0);
  const isApi = pathname.startsWith("/api/");
  const isMedia = pathname.startsWith("/media/");
  const extension = path.extname(pathname).toLowerCase();
  const pageView = method === "GET" && !isApi && !isMedia && (!extension || extension === ".html" || extension === ".htm");
  return {
    day: localDay(date),
    ip,
    authReason,
    accessMode,
    requests: 1,
    pageViews: pageView ? 1 : 0,
    apiRequests: isApi ? 1 : 0,
    mediaRequests: isMedia ? 1 : 0,
    deniedRequests: authReason === "missing-password" || status === 401 ? 1 : 0,
    errorRequests: status >= 400 ? 1 : 0,
    responseBytes: Math.max(0, Number(row.responseLength || 0)),
    firstSeen: timestamp,
    lastSeen: timestamp,
    lastPath: pathname.slice(0, 500),
    userAgent: String(row.userAgent || "").slice(0, 300)
  };
}

function initializeSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS access_ip_geo (
      ip TEXT PRIMARY KEY,
      country TEXT NOT NULL DEFAULT '${UNKNOWN}',
      province TEXT NOT NULL DEFAULT '${UNKNOWN}',
      city TEXT NOT NULL DEFAULT '${UNKNOWN}',
      isp TEXT NOT NULL DEFAULT '${UNKNOWN}',
      iso_code TEXT NOT NULL DEFAULT '',
      located INTEGER NOT NULL DEFAULT 0,
      ip_version INTEGER NOT NULL DEFAULT 0,
      lookup_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_daily (
      day TEXT NOT NULL,
      ip TEXT NOT NULL,
      auth_reason TEXT NOT NULL,
      access_mode TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      page_view_count INTEGER NOT NULL DEFAULT 0,
      api_count INTEGER NOT NULL DEFAULT 0,
      media_count INTEGER NOT NULL DEFAULT 0,
      denied_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      response_bytes INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      last_path TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (day, ip, auth_reason, access_mode)
    );

    CREATE INDEX IF NOT EXISTS idx_access_daily_day ON access_daily(day DESC);
    CREATE INDEX IF NOT EXISTS idx_access_daily_ip ON access_daily(ip, last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_access_daily_auth ON access_daily(auth_reason, day DESC);
    CREATE INDEX IF NOT EXISTS idx_access_geo_province ON access_ip_geo(province, ip);
  `);
}

function createStatements(db) {
  return {
    firstTracked: db.prepare("SELECT MIN(first_seen) AS first_seen FROM access_daily"),
    selectMeta: db.prepare("SELECT value FROM access_meta WHERE key = ?"),
    upsertMeta: db.prepare("INSERT OR REPLACE INTO access_meta (key, value) VALUES (?, ?)"),
    selectGeo: db.prepare("SELECT * FROM access_ip_geo WHERE ip = ?"),
    upsertGeo: db.prepare(`
      INSERT INTO access_ip_geo (
        ip, country, province, city, isp, iso_code, located, ip_version, lookup_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET
        country = excluded.country,
        province = excluded.province,
        city = excluded.city,
        isp = excluded.isp,
        iso_code = excluded.iso_code,
        located = excluded.located,
        ip_version = excluded.ip_version,
        lookup_error = excluded.lookup_error,
        updated_at = excluded.updated_at
    `),
    upsertDaily: db.prepare(`
      INSERT INTO access_daily (
        day, ip, auth_reason, access_mode, request_count, page_view_count, api_count, media_count,
        denied_count, error_count, response_bytes, first_seen, last_seen, last_path, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, ip, auth_reason, access_mode) DO UPDATE SET
        request_count = access_daily.request_count + excluded.request_count,
        page_view_count = access_daily.page_view_count + excluded.page_view_count,
        api_count = access_daily.api_count + excluded.api_count,
        media_count = access_daily.media_count + excluded.media_count,
        denied_count = access_daily.denied_count + excluded.denied_count,
        error_count = access_daily.error_count + excluded.error_count,
        response_bytes = access_daily.response_bytes + excluded.response_bytes,
        first_seen = MIN(access_daily.first_seen, excluded.first_seen),
        last_seen = MAX(access_daily.last_seen, excluded.last_seen),
        last_path = CASE WHEN excluded.last_seen >= access_daily.last_seen THEN excluded.last_path ELSE access_daily.last_path END,
        user_agent = CASE WHEN excluded.last_seen >= access_daily.last_seen THEN excluded.user_agent ELSE access_daily.user_agent END
    `)
  };
}

function upsertEntry(statements, entry) {
  statements.upsertDaily.run(
    entry.day,
    entry.ip,
    entry.authReason,
    entry.accessMode,
    entry.requests,
    entry.pageViews,
    entry.apiRequests,
    entry.mediaRequests,
    entry.deniedRequests,
    entry.errorRequests,
    entry.responseBytes,
    entry.firstSeen,
    entry.lastSeen,
    entry.lastPath,
    entry.userAgent
  );
}

function parseFilters(url) {
  const days = clampInteger(url.searchParams.get("days"), 30, 1, 3650);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return {
    days,
    startDay: localDay(start),
    auth: String(url.searchParams.get("auth") || "").trim(),
    access: String(url.searchParams.get("access") || "remote").trim(),
    province: String(url.searchParams.get("province") || "").trim(),
    query: String(url.searchParams.get("q") || "").trim().slice(0, 100),
    limit: clampInteger(url.searchParams.get("limit"), 50, 1, 200),
    offset: clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)
  };
}

function buildWhere(filters) {
  const conditions = ["d.day >= ?"];
  const params = [filters.startDay];
  if (filters.auth) {
    conditions.push("d.auth_reason = ?");
    params.push(filters.auth);
  }
  if (filters.access && filters.access !== "all") {
    conditions.push("d.access_mode = ?");
    params.push(filters.access);
  }
  if (filters.province) {
    conditions.push(`COALESCE(NULLIF(g.province, ''), '${UNKNOWN}') = ?`);
    params.push(filters.province);
  }
  if (filters.query) {
    const like = `%${filters.query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    conditions.push("(d.ip LIKE ? ESCAPE '\\' OR g.province LIKE ? ESCAPE '\\' OR g.city LIKE ? ESCAPE '\\' OR g.isp LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

function publicAggregateRow(row) {
  return {
    ...row,
    uniqueIps: publicNumber(row.unique_ips),
    requests: publicNumber(row.requests),
    pageViews: publicNumber(row.page_views),
    deniedRequests: publicNumber(row.denied_requests)
  };
}
