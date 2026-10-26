import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { ensureRealPathWithinRoots } from "../../../../platform/server/library-path-safety.js";
import { checkDuplicateAvailability } from "./availability.js";

const failure = (message, statusCode = 409, code = "DUPLICATE_CHANGED") => Object.assign(new Error(message), { statusCode, code });
const normalized = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const equalStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const signature = file => JSON.stringify([normalized(file.path), file.name, Number(file.size), file.modifiedAt || ""]);
const safeError = error => error.statusCode ? error.message : "文件不可访问，请检查磁盘或重新扫描。";

export function createDuplicateService({ dbPath, roots, resolveWork, resolveVideo, videoProbeService,
  cleanupMissing = null,
  cacheMs = 30_000, workerTimeoutMs = 30_000, stopTimeoutMs = 5000,
  workerFactory = options => new Worker(new URL("./worker.js", import.meta.url), options), snapshotLoader = null } = {}) {
  let closing = false, cached = null, pending = null, workerOwner = null, checkOwner = null, probeTask = null, recheckTask = null;
  const jobs = new Map(), probes = new Map(), targets = new WeakMap(), missing = new Map();
  const unavailable = () => failure("重复文件索引暂时不可用，请重试。", 503, "DUPLICATE_UNAVAILABLE");
  const accepting = () => { if (closing) throw unavailable(); };
  async function snapshot({ refresh = false } = {}) {
    accepting();
    if (pending) return pending;
    if (refresh) cached = null;
    const task = (async () => {
      const stamps = await Promise.all([dbPath, `${dbPath}-wal`].map(async file => {
        try { const stat = await fs.stat(file); return `${stat.size}:${stat.mtimeMs}`; }
        catch (error) { if (file !== dbPath && error.code === "ENOENT") return ""; throw error; }
      }));
      accepting();
      const key = stamps.join("|");
      if (cached?.key === key && Date.now() - cached.at < cacheMs) return cached.value;
      const value = snapshotLoader ? await snapshotLoader() : await new Promise((resolve, reject) => {
        const worker = workerFactory({ workerData: { dbPath, roots } });
        const owner = { worker }; workerOwner = owner;
        let result, error;
        const timer = setTimeout(() => { error = unavailable(); worker.terminate().catch(() => {}); }, workerTimeoutMs);
        worker.once("message", message => { result = message.snapshot; if (!result) error = unavailable(); });
        worker.once("error", () => { error = unavailable(); });
        worker.once("exit", code => {
          clearTimeout(timer); if (workerOwner === owner) workerOwner = null;
          if (closing || error || code !== 0 || !result) reject(error || unavailable()); else resolve(result);
        });
      });
      accepting(); cached = { key, at: Date.now(), value }; return value;
    })();
    pending = task;
    try { return await task; } finally { if (pending === task) pending = null; }
  }
  function enrich(group) {
    const files = group.files.map(file => {
      const probe = probes.get(signature(file)) || file.probe;
      return { ...file, ...(probe ? { probe, duration: Number(probe.duration) || null,
        resolutionLabel: probe.width && probe.height ? `${probe.width} × ${probe.height}` : file.resolutionLabel } : {}) };
    });
    const longest = Math.max(0, ...files.map(file => Number(file.duration) || 0));
    return { ...group, files: files.map(file => ({ ...file, isLongest: longest > 0 && file.duration === longest })) };
  }
  function withFiles(group, files) {
    const largest = Math.max(0, ...files.map(file => Number(file.size) || 0));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    return enrich({ ...group, files: files.map(file => ({ ...file, isLargest: largest > 0 && file.size === largest })),
      totalBytes: total, potentialExtraBytes: Math.max(0, total - largest) });
  }
  function present(group) { return withFiles(group, group.files.filter(file => file.availabilityStatus !== "missing" && !missing.has(signature(file)))); }
  async function rootOnline(row) {
    for (const root of roots || []) {
      const relative = path.relative(path.resolve(root), path.resolve(row.path));
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      try { if ((await fs.stat(root)).isDirectory()) return true; } catch { /* An offline root cannot prove deletion. */ }
    }
    return false;
  }
  async function restoreMissing(value) {
    const current = new Set(value.groups.flatMap(group => group.files.map(signature)));
    for (const [key, record] of missing) {
      if (!current.has(key)) { missing.delete(key); continue; }
      if (Date.now() - record.at < cacheMs) continue;
      try { await fs.lstat(record.row.path); missing.delete(key); }
      catch (error) { if (error.code !== "ENOENT" || !await rootOnline(record.row)) missing.delete(key); else record.at = Date.now(); }
    }
  }
  async function list({ q = "", offset = 0, limit = 20, refresh = false } = {}) {
    const value = await snapshot({ refresh });
    const query = String(q).normalize("NFKC").trim().toLowerCase();
    if (query.length > 120 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw failure("搜索或分页参数无效。", 400, "DUPLICATE_QUERY_INVALID");
    await restoreMissing(value);
    const absent = new Set([...missing.keys(), ...value.groups.flatMap(group => group.files.filter(file => file.availabilityStatus === "missing").map(signature))]);
    const candidates = value.groups.map(present).filter(group => group.files.length >= 2);
    const groups = query ? candidates.filter(group => [group.code, group.title, ...group.files.flatMap(file => [file.name, file.path])]
      .some(text => String(text || "").normalize("NFKC").toLowerCase().includes(query))) : candidates;
    const summary = absent.size ? { ...value.summary, indexedFiles: Math.max(0, value.summary.indexedFiles - absent.size),
      candidateGroups: candidates.length, candidateFiles: candidates.reduce((sum, group) => sum + group.files.length, 0),
      potentialExtraBytes: candidates.reduce((sum, group) => sum + group.potentialExtraBytes, 0) } : value.summary;
    return { summary, total: groups.length, offset, hasMore: offset + limit < groups.length,
      groups: groups.slice(offset, offset + limit).map(enrich) };
  }
  async function groupFor(id, includeMissing = false) {
    if (!/^[a-f0-9]{64}$/.test(String(id || ""))) throw failure("比对组标识无效。", 400);
    const group = (await snapshot()).groups.find(group => group.id === id);
    if (!group) throw failure("比对组已变化，请重新读取列表。", 404);
    return includeMissing ? enrich(group) : present(group);
  }
  function indexedFile(row) {
    const work = resolveWork(row.workId);
    const indexed = work?.videos?.find(file => normalized(file.path) === normalized(row.path));
    if (!indexed || signature(indexed) !== signature(row)) throw failure("视频记录已变化，请重新扫描后比对。");
    return indexed;
  }
  function currentFile(row) {
    const indexed = indexedFile(row);
    const file = resolveVideo ? resolveVideo(indexed.id) : indexed;
    if (!file || signature(file) !== signature(indexed)) throw failure("视频位置已变化，请重新读取列表。");
    ensureRealPathWithinRoots(file.path, roots, "比对视频");
    return file;
  }
  async function inspect(row, { indexedOnly = false } = {}) {
    const file = indexedOnly ? indexedFile(row) : currentFile(row);
    if (indexedOnly) ensureRealPathWithinRoots(file.path, roots, "比对视频");
    const stat = await fs.lstat(file.path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure("比对目标不是普通视频文件。");
    // Indexed dates have millisecond precision; native Windows timestamps can
    // round across that boundary. Full reads still compare exact native stats.
    if (Number(stat.size) !== Number(row.size) || row.modifiedAt && Math.abs(Number(stat.mtimeNs / 1000000n) - Date.parse(row.modifiedAt)) > 1) throw failure("视频文件已变化，请重新扫描后比对。");
    const canonical = await fs.realpath(file.path);
    ensureRealPathWithinRoots(file.path, roots, "比对视频");
    return { file, stat, canonical };
  }
  async function resolve(groupId, fileId) {
    const group = await groupFor(groupId), row = group.files.find(file => file.id === String(fileId));
    if (!row) throw failure("视频不属于当前比对组。", 404);
    const { file } = await inspect(row);
    return { url: `/player.html?${new URLSearchParams({ workId: row.workId, videoId: file.id, returnTo: "/fanhao/duplicates" })}` };
  }
  async function recheck(groupId) {
    accepting(); if (recheckTask) throw failure("正在检查文件位置，请稍后。", 429);
    if (cleanupMissing && (checkOwner || probeTask)) throw failure("正在读取媒体，请结束比对后再清理索引。", 409);
    const task = (async () => {
    const group = await groupFor(groupId, true), missingFileIds = [], warnings = [];
    for (const row of group.files) {
      accepting();
      // Playback resolution returns null (or a relocated path) after manual
      // deletion. Check the owned indexed path itself to establish absence.
      try { await inspect(row, { indexedOnly: true }); missing.delete(signature(row)); }
      catch (error) {
        if (error.code === "ENOENT" && await rootOnline(row)) {
          missing.set(signature(row), { row, at: Date.now() }); missingFileIds.push(row.id);
        } else {
          missing.delete(signature(row)); warnings.push({ fileId: row.id, error: safeError(error) });
        }
      }
    }
    accepting();
    if (cleanupMissing && (checkOwner || probeTask)) throw failure("正在读取媒体，请结束比对后再清理索引。", 409);
    const cleanup = cleanupMissing ? await cleanupMissing(group.files.filter(file => missingFileIds.includes(file.id))) : null;
    if (cleanup) warnings.push(...cleanup.warnings);
    cached = null;
    return { group: present({ ...group, files: group.files.map(file => ({ ...file,
      availabilityStatus: missingFileIds.includes(file.id) ? "missing" : warnings.some(warning => warning.fileId === file.id) ? "unknown" : "available",
      availabilityError: warnings.find(warning => warning.fileId === file.id)?.error || "" })) }), missingFileIds, warnings, ...(cleanup ? { cleanup } : {}) };
    })();
    recheckTask = task;
    try { return await task; } finally { if (recheckTask === task) recheckTask = null; }
  }
  async function cleanup({ groupId, q = "" } = {}) {
    accepting();
    if (!cleanupMissing) throw unavailable();
    if (recheckTask || checkOwner || probeTask) throw failure("正在检查或读取文件，请任务结束后再清理索引。", 409);
    const query = String(q).normalize("NFKC").trim().toLowerCase();
    if (query.length > 120 || groupId !== undefined && !/^[a-f0-9]{64}$/.test(String(groupId))) throw failure("清理范围无效。", 400);
    const task = (async () => {
      const value = await snapshot({ refresh: true });
      const groups = value.groups.filter(group => (groupId === undefined || group.id === groupId)
        && (!query || [group.code, group.title, ...group.files.flatMap(file => [file.name, file.path])]
          .some(text => String(text || "").normalize("NFKC").toLowerCase().includes(query))));
      const checked = await checkDuplicateAvailability({ groups }, roots);
      accepting();
      const files = checked.groups.flatMap(group => group.files);
      const result = await cleanupMissing(files.filter(file => file.availabilityStatus === "missing"));
      cached = null;
      return { ...result, checkedFiles: files.length, uncertainFiles: files.filter(file => file.availabilityStatus === "unknown").length };
    })();
    recheckTask = task;
    try { return await task; } finally { if (recheckTask === task) recheckTask = null; }
  }
  function chosenFiles(group, fileIds) {
    if (fileIds === undefined) return group.files;
    if (!Array.isArray(fileIds) || fileIds.length < 2 || fileIds.length > 64 || fileIds.some(id => typeof id !== "string")) throw failure("请选择本组的 2 至 64 份文件。", 400);
    const ids = new Set(fileIds);
    if (ids.size !== fileIds.length || fileIds.some(id => !group.files.some(file => file.id === id))) throw failure("所选文件不属于当前比对组。", 400);
    return group.files.filter(file => ids.has(file.id));
  }
  async function probe(groupId, fileIds) {
    accepting(); if (probeTask) throw failure("正在读取媒体参数，请稍后。", 429);
    if (cleanupMissing && recheckTask) throw failure("正在检查并清理索引，请稍后。", 409);
    const task = (async () => {
      const group = await groupFor(groupId);
      const chosen = chosenFiles(group, fileIds);
      if (chosen.length > 64) throw failure("本组文件超过 64 份，请先选两份重点对比。", 422);
      const results = new Map();
      for (const row of chosen) {
        accepting();
        try {
          const before = await inspect(row);
          const value = await videoProbeService.probeCachedAsync(before.file);
          const after = await inspect(row);
          if (!equalStat(before.stat, after.stat) || before.canonical !== after.canonical) throw failure("读取期间文件已变化。");
          if (!value) throw failure("未能取得媒体参数。", 422);
          probes.set(signature(row), value); while (probes.size > 2000) probes.delete(probes.keys().next().value);
        } catch (error) { results.set(row.id, safeError(error)); }
      }
      const value = enrich(group);
      return { group: { ...value, files: value.files.map(file => ({ ...file, ...(results.has(file.id) ? { probeError: results.get(file.id) } : {}) })) } };
    })();
    probeTask = task;
    try { return await task; } finally { if (probeTask === task) probeTask = null; }
  }
  const publicJob = job => {
    const value = structuredClone(job);
    if (value.status === "complete") {
      for (const row of targets.get(job) || []) {
        const indexed = resolveWork(row.workId)?.videos?.find(file => normalized(file.path) === normalized(row.path));
        if (!indexed || signature(indexed) !== signature(row)) {
          const file = value.files.find(file => file.id === row.id);
          Object.assign(file, { status: "changed", error: "校验后视频索引已变化，请重新校验。" }); delete file.sha256;
        }
      }
      value.matches = value.matches.filter(match => match.fileIds.every(id => value.files.some(file => file.id === id && file.status === "hashed")));
    }
    return value;
  };
  function check(id) {
    const job = jobs.get(String(id)); if (!job) throw failure("校验记录已过期，请重新校验。", 404);
    return { job: publicJob(job) };
  }
  function cancel(id) {
    const job = jobs.get(String(id)); if (!job) throw failure("校验记录不存在。", 404);
    if (checkOwner?.job === job) { job.cancelRequested = true; checkOwner.controller.abort(); }
    return { job: publicJob(job) };
  }
  async function startCheck(groupId, fileIds) {
    accepting();
    if (cleanupMissing && recheckTask) throw failure("正在检查并清理索引，请稍后。", 409);
    if (checkOwner) {
      if (checkOwner.job.groupId === groupId) return { job: publicJob(checkOwner.job) };
      throw failure("已有内容校验正在运行，请等待或先取消。", 409, "DUPLICATE_CHECK_BUSY");
    }
    const whole = await groupFor(groupId), group = { ...whole, files: chosenFiles(whole, fileIds) }; accepting();
    if (cleanupMissing && recheckTask) throw failure("正在检查并清理索引，请稍后。", 409);
    if (checkOwner) throw failure("已有内容校验正在运行，请等待或先取消。", 409, "DUPLICATE_CHECK_BUSY");
    if (group.files.length > 64) throw failure("本组文件超过 64 份，请先选两份重点对比。", 422);
    while (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
    const job = { id: crypto.randomUUID(), groupId, status: "running", startedAt: new Date().toISOString(),
      progressBytes: 0, totalBytes: 0, files: group.files.map(file => ({ id: file.id, status: "pending" })), matches: [] };
    targets.set(job, group.files);
    const owner = { job, controller: new AbortController(), task: null }; checkOwner = owner; jobs.set(job.id, job);
    owner.task = runCheck(owner, group).catch(error => {
      job.status = owner.controller.signal.aborted ? "cancelled" : "failed";
      if (job.status === "failed") job.error = safeError(error);
    }).finally(() => {
      job.finishedAt = new Date().toISOString(); if (checkOwner === owner) checkOwner = null;
    });
    return { job: publicJob(job) };
  }
  async function runCheck(owner, group) {
    const { job, controller } = owner, signal = controller.signal, contexts = new Map(), physical = new Map(), buckets = new Map();
    for (const [index, row] of group.files.entries()) {
      signal.throwIfAborted();
      try {
        const context = await inspect(row); signal.throwIfAborted(); contexts.set(row.id, context);
        // SMB servers may reuse device/inode numbers across shares. Only an
        // identical canonical path can bypass a full content read.
        const key = normalized(context.canonical);
        if (physical.has(key)) { Object.assign(job.files[index], { status: "same_file", sameAs: physical.get(key) }); continue; }
        physical.set(key, row.id);
        const size = String(context.stat.size); if (!buckets.has(size)) buckets.set(size, []); buckets.get(size).push({ row, result: job.files[index] });
      } catch (error) { signal.throwIfAborted(); Object.assign(job.files[index], { status: error.code === "DUPLICATE_CHANGED" ? "changed" : "unavailable", error: safeError(error) }); }
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) {
        const item = bucket[0], alias = job.files.find(file => file.sameAs === item.row.id);
        Object.assign(item.result, alias ? { status: "same_file" } : { status: "size_distinct" }); continue;
      }
      job.totalBytes += bucket.reduce((sum, item) => sum + item.row.size, 0);
    }
    const buffer = Buffer.alloc(1024 * 1024);
    for (const bucket of buckets.values()) for (const { row, result } of bucket) {
      signal.throwIfAborted(); if (result.status !== "pending") continue;
      let handle;
      try {
        const before = contexts.get(row.id); currentFile(row);
        handle = await fs.open(row.path, "r");
        if (!equalStat(before.stat, await handle.stat({ bigint: true }))) throw failure("校验前文件已变化。");
        result.status = "hashing"; const hash = crypto.createHash("sha256"); let position = 0;
        while (position < row.size) {
          signal.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, row.size - position), position);
          signal.throwIfAborted(); if (!bytesRead) throw failure("校验期间文件已变化。");
          hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; job.progressBytes += bytesRead; await yieldTurn();
        }
        const after = await inspect(row);
        if (!equalStat(before.stat, await handle.stat({ bigint: true })) || !equalStat(before.stat, after.stat) || before.canonical !== after.canonical) throw failure("校验期间文件已变化。");
        Object.assign(result, { status: "hashed", sha256: hash.digest("hex") });
      } catch (error) {
        signal.throwIfAborted(); Object.assign(result, { status: error.code === "DUPLICATE_CHANGED" ? "changed" : "unavailable", error: safeError(error) });
      } finally { if (handle) await handle.close(); }
    }
    signal.throwIfAborted();
    for (const result of job.files.filter(file => file.status === "hashed")) {
      const row = group.files.find(file => file.id === result.id), before = contexts.get(result.id);
      try {
        const after = await inspect(row);
        if (!equalStat(before.stat, after.stat) || before.canonical !== after.canonical) throw failure("校验结束前文件已变化。");
      } catch (error) { Object.assign(result, { status: "changed", error: safeError(error) }); delete result.sha256; }
    }
    for (const result of job.files.filter(file => file.status === "same_file")) {
      signal.throwIfAborted();
      const referenceId = result.sameAs || job.files.find(file => file.sameAs === result.id)?.id;
      try {
        if (!referenceId) throw failure("文件别名引用已变化，请重新校验。");
        const pairs = [result.id, referenceId].map(id => ({ row: group.files.find(file => file.id === id), before: contexts.get(id) }));
        const inspected = [];
        for (const { row, before } of pairs) {
          const after = await inspect(row);
          if (!equalStat(before.stat, after.stat) || before.canonical !== after.canonical) throw failure("文件别名在校验期间已变化。");
          inspected.push(after);
        }
        if (normalized(inspected[0].canonical) !== normalized(inspected[1].canonical)) throw failure("文件别名已不再指向同一文件。");
      } catch (error) { Object.assign(result, { status: "changed", error: safeError(error) }); }
    }
    signal.throwIfAborted(); const hashes = new Map();
    for (const file of job.files.filter(file => file.status === "hashed")) {
      if (!hashes.has(file.sha256)) hashes.set(file.sha256, []); hashes.get(file.sha256).push(file.id);
    }
    job.matches = [...hashes.values()].filter(ids => ids.length > 1).map(fileIds => ({ fileIds, bytes: group.files.find(file => file.id === fileIds[0]).size }));
    job.status = "complete";
  }
  function beginStop() { closing = true; cached = null; checkOwner?.controller.abort(); }
  async function stop() {
    beginStop();
    const termination = workerOwner ? workerOwner.worker.terminate() : null;
    const tasks = [termination, pending, checkOwner?.task, probeTask, recheckTask].filter(Boolean); let timer;
    try { await Promise.race([Promise.allSettled(tasks), new Promise((_, reject) => { timer = setTimeout(() => reject(failure("比对读取尚未结束。", 503, "DUPLICATE_STOP_INCOMPLETE")), stopTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  return { list, resolve, recheck, cleanup, probe, startCheck, check, cancel, beginStop, stop };
}
