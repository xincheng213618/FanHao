import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { extractWorkCodes } from "../../../../../lib/code-parser.js";
import { ensureRealPathWithinRoots } from "../../../../platform/server/library-path-safety.js";

const INCOMPLETE = /(?:\.aria2|\.part|\.partial|\.crdownload|\.download|\.tmp)$/i;
const MEDIA = /\.(?:mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|webm|iso)$/i;
const EXCLUDED = /^(?:\.|\$|System Volume Information$|Recovery$)/i;
const ACTIVE = new Set(["running", "stopping"]);
const within = (file, root) => { const r = path.relative(root, file); return !r || (!r.startsWith("..") && !path.isAbsolute(r)); };
const signature = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

export function createFileWorkflowService({ dataDir, roots, indexedPaths = () => [], maxFiles = 5000 }) {
  const stateDir = path.resolve(dataDir, "file-workflows");
  const allowedRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  let active = null;
  let closing = false;
  let running = null;
  let previewing = false;
  const lockPath = path.join(stateDir, "execution.lock");

  function validate(file) {
    const resolved = path.resolve(file);
    if (!allowedRoots.some((root) => within(resolved, root))) throw fail("目录不在允许的整理范围内", 400);
    ensureRealPathWithinRoots(resolved, allowedRoots, "整理路径");
    if (within(resolved, stateDir) || within(stateDir, resolved)) throw fail("任务数据目录不能参与文件整理", 400);
    return resolved;
  }
  function save(job) {
    fs.mkdirSync(stateDir, { recursive: true });
    job.updatedAt = new Date().toISOString();
    const destination = path.join(stateDir, `${job.id}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, "w");
    try { fs.writeFileSync(fd, JSON.stringify(job)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  }
  function read(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw fail("任务不存在", 404);
    if (active?.id === id) return active;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), "utf8"));
      if (job.version !== 1 || job.id !== id || !Array.isArray(job.items)) throw new Error("Invalid journal");
      return job;
    } catch { throw fail("任务不存在或记录损坏", 404); }
  }
  function summary(job, includeItems = true) {
    const executable = job.items.filter((item) => !item.reason);
    let status = job.status;
    if (ACTIVE.has(status) && active?.id !== job.id && !lockOwnerAlive()) status = "interrupted";
    return {
      id: job.id, kind: job.kind, status, source: job.source, target: job.target,
      createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error || "",
      totalFiles: executable.length, completedFiles: executable.filter((item) => item.phase === "done").length,
      totalBytes: executable.reduce((sum, item) => sum + item.bytes, 0),
      skippedFiles: job.items.length - executable.length,
      items: includeItems ? job.items.map(({ source, target, code, bytes, reason, phase }) => ({ source, target, code, bytes, reason, phase })) : undefined
    };
  }
  function lockOwnerAlive() {
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
      process.kill(owner.pid, 0);
      return true;
    } catch (error) { return !["ENOENT", "ESRCH"].includes(error.code); }
  }
  function list() {
    let entries = [];
    try { entries = fs.readdirSync(stateDir).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)); } catch {}
    return entries.flatMap((name) => { try { return [summary(read(name.slice(0, -5)), false)]; } catch { return []; } })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }

  function indexedFileKeys() {
    const keys = new Set();
    for (const file of indexedPaths()) {
      keys.add(path.resolve(file).toLowerCase());
      try { keys.add(fs.realpathSync.native(file).toLowerCase()); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return keys;
  }
  function isIndexed(file, keys) {
    if (keys.has(path.resolve(file).toLowerCase())) return true;
    try { return keys.has(fs.realpathSync.native(file).toLowerCase()); } catch (error) { if (error.code !== "ENOENT") throw error; return false; }
  }

  async function preview(input) {
    let { kind, source, target } = input || {};
    if (closing || active || previewing) throw fail("已有任务正在运行或生成预览，请稍后再试");
    if (!["organize", "migrate"].includes(kind)) throw fail("请选择整理或迁移", 400);
    if (typeof source !== "string" || typeof target !== "string" || !path.isAbsolute(source) || !path.isAbsolute(target)) throw fail("源目录和目标目录必须是完整路径", 400);
    source = validate(source); target = validate(target);
    if (within(source, target) || within(target, source)) throw fail("源目录与目标目录不能相同或互相包含", 400);
    previewing = true;
    try {
      if (!(await fsp.stat(source)).isDirectory() || !(await fsp.stat(target)).isDirectory()) throw fail("请先创建源目录和目标目录", 400);
      const sourceReal = await fsp.realpath(source), targetReal = await fsp.realpath(target);
      if (within(sourceReal, targetReal) || within(targetReal, sourceReal)) throw fail("源目录与目标目录实际指向重叠位置", 400);
      const indexed = indexedFileKeys();
      const items = [], targets = new Set();
      const entries = await fsp.readdir(source, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (EXCLUDED.test(entry.name)) continue;
        const base = path.join(source, entry.name);
        const group = [];
        await collect(base, group);
        const unfinished = group.some((file) => INCOMPLETE.test(file.file));
        const codes = extractWorkCodes(entry.name);
        const code = codes.length === 1 ? codes[0] : "";
        for (const item of group) {
          if (items.length >= maxFiles) throw fail(`单次预览最多 ${maxFiles} 个文件，请缩小源目录`, 400);
          const relative = path.relative(source, item.file);
          // Keep the original name (including quality, part and U/UC suffixes).
          const destination = kind === "organize"
            ? path.join(target, code || "unknown", relative)
            : path.join(target, relative);
          const key = destination.toLowerCase();
          let reason = item.reason || (unfinished ? "同组存在未完成下载" : "");
          if (!reason && isIndexed(item.file, indexed)) reason = "已入库文件，请使用作品迁移以同步数据库";
          if (!reason && kind === "organize" && !code) reason = codes.length ? "检测到多个番号" : "未识别番号";
          if (!reason && kind === "organize" && !entry.isDirectory() && !MEDIA.test(entry.name)) reason = "根目录非视频文件，保留原位";
          if (!reason && fs.existsSync(`${item.file}.aria2`)) reason = "下载尚未完成";
          if (!reason && (targets.has(key) || fs.existsSync(destination))) reason = "目标同名文件已存在";
          if (!reason) { validate(item.file); validate(destination); targets.add(key); }
          items.push({ source: item.file, target: destination, code, bytes: item.stat?.size || 0,
            signature: item.stat ? signature(item.stat) : "", reason, phase: "planned" });
        }
      }
      const job = { version: 1, id: crypto.randomUUID(), kind, source, target, sourceReal, targetReal,
        status: "preview", createdAt: new Date().toISOString(), items };
      save(job);
      return summary(job);
    } finally { previewing = false; }
  }

  async function collect(file, result) {
    if (result.length >= maxFiles) throw fail("目录过大，请缩小扫描范围", 400);
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) { result.push({ file, reason: "跳过链接或联接目录" }); return; }
    if (stat.isFile()) { result.push({ file, stat }); return; }
    if (!stat.isDirectory()) return;
    validate(file);
    for (const entry of await fsp.readdir(file, { withFileTypes: true })) {
      if (!EXCLUDED.test(entry.name)) await collect(path.join(file, entry.name), result);
    }
  }

  function claim() {
    fs.mkdirSync(stateDir, { recursive: true });
    if (fs.existsSync(lockPath)) {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { throw fail("任务锁损坏，需要检查任务目录"); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw fail("任务锁无效");
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      if (alive) throw fail("另一个服务正在执行整理任务");
      fs.unlinkSync(lockPath);
    }
    const fd = fs.openSync(lockPath, "wx");
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  function run(id) {
    if (closing || previewing) throw fail("服务正在停止或生成预览");
    if (active) { if (active.id === id) return summary(active); throw fail("请等待当前文件任务结束"); }
    const job = read(id);
    if (job.status === "completed") return summary(job);
    if (!job.items.some((item) => !item.reason)) throw fail("没有可以执行的文件");
    claim();
    active = job;
    job.status = "running"; job.error = "";
    try { save(job); } catch (error) { active = null; fs.unlinkSync(lockPath); throw error; }
    running = execute(job).catch((error) => {
      job.status = "blocked";
      job.error = `任务记录保存失败，已停止：${error.message}`;
      console.error("[file-workflows]", job.id, job.error);
    }).finally(() => {
      active = null; running = null;
      try { fs.unlinkSync(lockPath); } catch {}
    });
    return summary(job);
  }

  async function execute(job) {
    try {
      checkDirectories(job);
      const indexed = indexedFileKeys();
      for (let i = 0; i < job.items.length; i += 1) {
        const item = job.items[i];
        if (item.reason) continue;
        if (item.phase === "done") { await cleanupTemporary(job, item, i); continue; }
        if (closing || job.status === "stopping") { job.status = "interrupted"; save(job); return; }
        if (isIndexed(item.source, indexed)) throw fail("预览后文件已入库，请改用作品迁移");
        await moveFile(job, item, i);
      }
      job.status = "completed"; save(job);
    } catch (error) { job.status = "blocked"; job.error = String(error.message || error); save(job); }
  }

  async function moveFile(job, item, index) {
    checkDirectories(job, item);
    if (fs.lstatSync(item.target, { throwIfNoEntry: false })?.isSymbolicLink()) throw fail("目标文件变成了链接，停止任务");
    if (!within(item.source, job.source) || !within(item.target, job.target)) throw fail("任务路径不属于预览目录");
    const temporary = `${item.target}.fanhao-${job.id}-${index}.partial`;
    const sourceExists = fs.existsSync(item.source);
    if (!sourceExists) {
      if (item.phase === "published" && item.hash && await hashFile(item.target) === item.hash) { item.phase = "done"; save(job); await cleanupTemporary(job, item, index); return; }
      throw fail("源文件已不存在，需要检查任务记录");
    }
    const sourceStat = await fsp.lstat(item.source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || signature(sourceStat) !== item.signature) throw fail("预览后源文件发生变化，请重新预览");
    if (fs.existsSync(`${item.source}.aria2`) || fs.existsSync(`${item.source}.part`)) throw fail("检测到下载中的文件，停止任务");
    if (item.phase === "published") {
      if (await hashFile(item.target) !== item.hash || await hashFile(item.source) !== item.hash) throw fail("恢复校验失败，保留源文件和目标文件");
    } else {
      if (fs.existsSync(item.target)) {
        // A process may stop after linking but before persisting 'published'.
        const t = fs.existsSync(temporary) ? await fsp.lstat(temporary) : null;
        const d = await fsp.lstat(item.target);
        if (item.phase !== "copied" || !t || t.isSymbolicLink() || d.isSymbolicLink() || t.ino !== d.ino || t.dev !== d.dev || await hashFile(item.target) !== item.hash) throw fail("目标已存在，未覆盖任何文件");
      } else {
        if (fs.existsSync(temporary)) {
          const stat = await fsp.lstat(temporary);
          if (!stat.isFile() || stat.isSymbolicLink()) throw fail("临时文件身份发生变化");
          await fsp.unlink(temporary);
        }
        await fsp.mkdir(path.dirname(item.target), { recursive: true });
        validate(item.target);
        item.phase = "copying"; save(job);
        await fsp.copyFile(item.source, temporary, fs.constants.COPYFILE_EXCL);
        const handle = await fsp.open(temporary, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
        item.hash = await hashFile(temporary);
        if (item.hash !== await hashFile(item.source) || signature(await fsp.lstat(item.source)) !== item.signature) throw fail("复制期间源文件发生变化，保留源文件");
        item.phase = "copied"; save(job);
        validate(item.target);
        // Atomic no-overwrite publication, also for cross-volume source copies.
        await fsp.link(temporary, item.target);
      }
      item.phase = "published"; save(job);
    }
    checkDirectories(job, item);
    if (fs.lstatSync(item.target).isSymbolicLink()) throw fail("目标文件变成了链接，保留源文件");
    if (signature(await fsp.lstat(item.source)) !== item.signature || await hashFile(item.target) !== item.hash) throw fail("删除源文件前校验失败，保留两份文件");
    await fsp.unlink(item.source);
    item.phase = "done"; save(job);
    await cleanupTemporary(job, item, index);
  }

  function checkDirectories(job, item) {
    if (fs.realpathSync.native(validate(job.source)) !== job.sourceReal || fs.realpathSync.native(validate(job.target)) !== job.targetReal) throw fail("预览后目录指向发生变化，请重新预览");
    if (item) {
      validate(item.source); validate(item.target);
      ensureRealPathWithinRoots(item.source, [job.source], "源文件");
      ensureRealPathWithinRoots(item.target, [job.target], "目标文件");
    }
  }

  async function cleanupTemporary(job, item, index) {
    const temporary = `${item.target}.fanhao-${job.id}-${index}.partial`;
    if (!fs.existsSync(temporary)) return;
    checkDirectories(job, item);
    const left = await fsp.lstat(temporary), right = await fsp.lstat(item.target);
    // Only remove our remaining publication link, never a replacement file.
    if (left.isFile() && !left.isSymbolicLink() && right.isFile() && !right.isSymbolicLink() && left.ino === right.ino && left.dev === right.dev) await fsp.unlink(temporary);
  }

  function beginStop() {
    closing = true;
    if (active && ACTIVE.has(active.status)) { active.status = "stopping"; save(active); }
  }

  return {
    preview, run, list, detail: (id) => summary(read(id)),
    config: () => ({ roots: allowedRoots, maxFiles, download: { provider: "115", mode: "external", description: "使用 115 下载到本地后，选择下载目录进行整理。" } }),
    stop(id) {
      const job = read(id);
      if (active?.id === id) { job.status = "stopping"; save(job); }
      return summary(job);
    },
    beginStop,
    async close() { beginStop(); await running; }
  };
}

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
