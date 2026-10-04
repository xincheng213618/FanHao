import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { assertSourceSnapshot, LOCAL_REIMPORT_TEMP_PREFIX, MAX_LOCAL_REIMPORT_ARTIFACT_BYTES, samePath, sourceIdentity } from "./local-reimport-artifact.js";

const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

export function createNovelReimportService({
  collectionService, dbPath, novelStore, projectRoot, pythonPath = "python", spawnProcess = spawn,
  artifactRoot = path.join(os.tmpdir(), `${LOCAL_REIMPORT_TEMP_PREFIX}${crypto.randomUUID()}`),
  maxPending = 4, processTimeoutMs = 120_000, closeTimeoutMs = 15_000,
  maxArtifactBytes = MAX_LOCAL_REIMPORT_ARTIFACT_BYTES, isWriterReleased = () => true
} = {}) {
  if (!collectionService || !dbPath || !novelStore) throw new Error("novel reimport dependencies are required");
  const root = path.resolve(projectRoot || process.cwd());
  const scriptPath = path.join(root, "tools", "rescan_novel_library.py");
  artifactRoot = path.resolve(artifactRoot);
  let accepting = true, active = null, pumping = false, stopTask = null, generation = 0;
  let cleanupError = null;
  const queue = [], busy = new Set(), children = new Set(), files = new Set(), idle = new Set();

  async function start() {
    const intent = generation;
    if (stopTask) { try { await stopTask; } catch (error) { if (children.size) throw error; } }
    if (intent !== generation) throw stopped();
    if ([...children].some((child) => child.closing)) throw failure("NOVEL_REIMPORT_CHILD_UNCONFIRMED", "前一重导入子进程尚未确认退出", 503);
    cleanupFiles();
    stopTask = null; accepting = true;
  }

  async function reimport(bookId, body = {}, { signal } = {}) {
    if (!accepting) throw stopped();
    if (signal?.aborted) throw cancelled();
    const metadata = novelStore.bookMeta(bookId);
    const current = metadata?.book;
    if (!current) return null;
    if (["text", "content", "contentBase64", "content_base64"].some((key) => Object.hasOwn(body || {}, key))) {
      const imported = await novelStore.reimportBook(bookId, body);
      return imported ? result(imported.book) : null;
    }
    const sourcePath = String(current.sourcePath || "");
    if (sourcePath.startsWith("collector://")) {
      const sourceUrl = String(current.relativePath || "").trim();
      if (!sourceUrl) throw failure("NOVEL_REIMPORT_SOURCE", "这本书没有可用的采集来源网址", 400);
      const queued = await collectionService.createTask({ name: `重新采集：${current.title || "网页小说"}`, url: sourceUrl, adapterId: "auto", mode: "collect" });
      return { kind: "collection", book: current, task: queued.task, message: "已创建重新采集任务" };
    }
    if (sourcePath.startsWith("upload://")) throw failure("NOVEL_REIMPORT_SOURCE", "这本书由浏览器上传，请选择 TXT 文件重新导入", 400);
    const local = resolveLocalSource(current);
    const key = `source:${process.platform === "win32" ? local.sourcePath.toLowerCase() : local.sourcePath}`;
    const bookKey = `book:${bookId}`;
    if (busy.has(key) || busy.has(bookKey)) throw failure("NOVEL_REIMPORT_BUSY", "这本书正在重新导入，请等待当前操作完成", 409);
    if (queue.length + Number(Boolean(active)) >= Math.max(1, maxPending)) throw failure("NOVEL_REIMPORT_QUEUE_FULL", "本地重导入队列已满，请稍后重试", 503);
    const deferred = defer();
    const descriptor = { bookId, sourceRealm: metadata.sourceRealm, catalogRevision: metadata.catalogRevision,
      ...local, sourceIdentity: sourceIdentity(local.sourcePath), artifactRoot,
      artifactPath: path.join(artifactRoot, `${crypto.randomUUID()}.json`) };
    const job = { ...deferred, descriptor, key, bookKey, signal, phase: "queued", failure: null };
    job.onAbort = () => cancelJob(job, cancelled());
    signal?.addEventListener("abort", job.onAbort, { once: true });
    busy.add(key); busy.add(bookKey); queue.push(job); void pump();
    return deferred.promise;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const job = queue.shift(); active = job;
        if (!accepting) { finishJob(job, stopped()); continue; }
        try {
          assertOwnedRoot(false); fs.mkdirSync(artifactRoot);
        } catch (error) { if (error.code !== "EEXIST") { finishJob(job, error); continue; } }
        try {
          assertOwnedRoot(true); files.add(job.descriptor.artifactPath);
          if (job.failure) throw job.failure;
          job.phase = "parse";
          await parse(job);
          job.phase = "hash";
          if (job.failure) throw job.failure;
          assertSourceSnapshot(job.descriptor);
          const stat = await fs.promises.stat(job.descriptor.artifactPath);
          if (job.failure) throw job.failure;
          if (!stat.isFile() || stat.size > maxArtifactBytes) throw failure("NOVEL_REIMPORT_TOO_LARGE", "本地 TXT 解析结果超过允许的大小上限", 413);
          const hash = crypto.createHash("sha256"); let bytes = 0;
          const stream = fs.createReadStream(job.descriptor.artifactPath);
          const streamClosed = new Promise((resolve) => stream.once("close", resolve));
          job.stream = stream;
          try {
            for await (const chunk of stream) {
              bytes += chunk.length;
              if (bytes > maxArtifactBytes) throw failure("NOVEL_REIMPORT_TOO_LARGE", "本地 TXT 解析结果超过允许的大小上限", 413);
              hash.update(chunk);
            }
          } finally { stream.destroy(); await streamClosed; job.stream = null; }
          if (job.failure) throw job.failure;
          if (bytes !== stat.size) throw failure("NOVEL_REIMPORT_SOURCE_CHANGED", "重新导入的解析结果已变化", 409);
          Object.assign(job.descriptor, { artifactBytes: bytes, artifactHash: hash.digest("hex") });
          job.phase = "write";
          const imported = await novelStore.reimportLocalBook(job.descriptor.bookId, job.descriptor);
          job.resolve(result(imported.book));
        } catch (error) { job.reject(error.code === "NOVEL_REIMPORT_CHILD_UNCONFIRMED" ? error : job.failure || error); }
        finally { finishJob(job); }
      }
    } finally { active = null; pumping = false; for (const resolve of idle) resolve(); idle.clear(); }
  }

  function finishJob(job, error) {
    if (error) job.reject(error);
    busy.delete(job.key); busy.delete(job.bookKey); job.signal?.removeEventListener("abort", job.onAbort);
    if (![...children].some((child) => child.job === job)) {
      try { cleanupFiles(job.descriptor.artifactPath); } catch (error) { cleanupError = error; }
    }
    if (active === job) active = null;
  }

  async function parse(job) {
    let child;
    try {
      child = spawnProcess(pythonPath, ["-u", scriptPath, "--file", job.descriptor.sourcePath, "--source-root", job.descriptor.sourceRoot,
        "--book-id", job.descriptor.bookId, "--export-only", job.descriptor.artifactPath, "--export-max-bytes", String(maxArtifactBytes)], {
        cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
      });
    } catch (error) { throw failure("NOVEL_REIMPORT_SPAWN", error.message || "无法启动小说重新导入程序", 500); }
    const exited = defer(), failed = defer();
    const handle = { child, job, exited: false, closing: false, closed: exited.promise, closeTask: null };
    children.add(handle); job.child = handle;
    let outputBytes = 0; const output = [];
    handle.fail = (error) => {
      job.failure ||= error; handle.closing = true; failed.resolve();
      try { child.kill("SIGKILL"); } catch {}
      child.stdout?.resume?.(); child.stderr?.resume?.();
    };
    const append = (chunk) => {
      if (job.failure) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) handle.fail(failure("NOVEL_REIMPORT_OUTPUT", "小说重新导入输出过大", 500));
      else output.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    const pipeError = (error) => handle.fail(failure("NOVEL_REIMPORT_PROCESS", error.message || "小说重新导入输出读取失败", 500));
    child.stdout?.on("error", pipeError); child.stderr?.on("error", pipeError);
    child.once("error", (error) => handle.fail(failure("NOVEL_REIMPORT_PROCESS", error.message || "小说重新导入程序失败", 500)));
    child.once("close", (code) => { handle.exited = true; handle.code = code; children.delete(handle); exited.resolve(); });
    const timer = setTimeout(() => handle.fail(failure("NOVEL_REIMPORT_TIMEOUT", "小说重新导入解析超时", 504)), processTimeoutMs);
    try {
      if (job.failure) handle.fail(job.failure);
      await Promise.race([handle.closed, failed.promise]);
      if (!handle.exited) await closeChild(handle);
      if (job.failure) throw job.failure;
      if (handle.code === 75) throw failure("NOVEL_REIMPORT_TOO_LARGE", "本地 TXT 解析结果超过允许的大小上限", 413);
      if (handle.code !== 0) throw failure("NOVEL_REIMPORT_PROCESS", Buffer.concat(output).toString("utf8").trim().slice(-800) || "小说重新导入解析失败", 500);
    } catch (error) {
      if (!handle.exited) { accepting = false; error = failure("NOVEL_REIMPORT_CHILD_UNCONFIRMED", "重导入子进程尚未确认退出", 503); }
      throw error;
    } finally { clearTimeout(timer); job.child = null; }
  }

  function closeChild(handle) {
    if (handle.exited) return Promise.resolve();
    if (!handle.closeTask) handle.closeTask = bounded(handle.closed, closeTimeoutMs, "重导入子进程尚未确认退出");
    return handle.closeTask;
  }
  function cancelJob(job, error) {
    if (job.phase === "write") return;
    job.failure ||= error;
    const index = queue.indexOf(job);
    if (index >= 0) { queue.splice(index, 1); finishJob(job, job.failure); }
    else { job.child?.fail(job.failure); job.stream?.destroy(job.failure); }
  }
  function beginStop() {
    generation += 1; accepting = false;
    for (const job of [...queue]) cancelJob(job, stopped());
    if (active) cancelJob(active, stopped());
  }
  function stop() {
    if (!stopTask) stopTask = (async () => {
      beginStop();
      if (pumping) await new Promise((resolve) => idle.add(resolve));
      for (const handle of children) { handle.fail(stopped()); await closeChild(handle); }
      cleanupFiles();
      if (cleanupError || files.size) throw cleanupError || failure("NOVEL_REIMPORT_CLEANUP", "重新导入临时文件尚未释放", 503);
    })();
    return stopTask;
  }
  function assertOwnedRoot(exists) {
    const temp = fs.realpathSync(os.tmpdir());
    if (!samePath(path.dirname(artifactRoot), temp) || !path.basename(artifactRoot).startsWith(LOCAL_REIMPORT_TEMP_PREFIX)
      || (exists && !samePath(fs.realpathSync(artifactRoot), artifactRoot))) throw new Error("重新导入临时目录来源无效");
  }
  function cleanupFiles(only) {
    if (children.size || !isWriterReleased()) return;
    if (!fs.existsSync(artifactRoot)) { for (const file of [...files]) if (!only || file === only) files.delete(file); if (!files.size) cleanupError = null; return; }
    assertOwnedRoot(true);
    cleanupError = null;
    for (const file of [...files]) {
      if (only && only !== file) continue;
      if (!samePath(path.dirname(file), artifactRoot) || !/^[0-9a-f-]{36}\.json$/.test(path.basename(file))) throw new Error("重新导入临时文件来源无效");
      try { fs.unlinkSync(file); files.delete(file); } catch (error) { if (error.code === "ENOENT") files.delete(file); else cleanupError = error; }
    }
    if (!files.size && !fs.readdirSync(artifactRoot).length) fs.rmdirSync(artifactRoot);
  }
  return { reimport, start, beginStop, stop, diagnostics: () => ({ accepting, pending: queue.length, active: Boolean(active), children: children.size, files: files.size, artifactRoot }) };
}

function result(book) { return { kind: "book", book, message: `重新导入完成：${book.chapterCount} 章` }; }
function resolveLocalSource(book) {
  const sourcePath = String(book.sourcePath || "").trim(), sourceRoot = String(book.sourceRoot || "").trim();
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(sourceRoot)) throw failure("NOVEL_REIMPORT_SOURCE", "这本书没有有效的本地 TXT 来源目录", 400);
  if (!fs.existsSync(sourcePath) || !fs.existsSync(sourceRoot)) throw failure("NOVEL_REIMPORT_SOURCE", "原始 TXT 文件或所在目录不存在", 404);
  const resolvedPath = fs.realpathSync(sourcePath), resolvedRoot = fs.realpathSync(sourceRoot), relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolvedPath).toLowerCase() !== ".txt" || !fs.statSync(resolvedPath).isFile()) throw failure("NOVEL_REIMPORT_SOURCE", "原始 TXT 不在登记目录内或不是有效 TXT 文件", 400);
  return { sourcePath: resolvedPath, sourceRoot: resolvedRoot };
}
function defer() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function failure(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode, outcome: "not_committed" }); }
function stopped() { return failure("NOVEL_REIMPORT_STOPPED", "小说重新导入服务正在停止", 503); }
function cancelled() { return failure("NOVEL_REIMPORT_CANCELLED", "小说重新导入已取消", 499); }
async function bounded(promise, milliseconds, message) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure("NOVEL_REIMPORT_CHILD_UNCONFIRMED", message, 503)), milliseconds); })]); } finally { clearTimeout(timer); } }
