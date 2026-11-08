import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deriveWorkTraits } from "../../../../../lib/work-traits.js";
import { workCodeKey } from "../../../../../lib/code-parser.js";
import {
  VIDEO, assertFinished, checkedPath, collectIntakeFiles, identity, inside, intakeError, is4kOrHigher, lstat,
  nameForIntake, nameWithIntakeMarks, openIntakePath, pathKey, regular, same, signature, stageIntakeFile, subtitleFiles
} from "./intake-files.js";
import {
  assertNoIntakeConflict, assertUnindexed, catalogForIntake, cleanIntakeMetadata,
  commitIntakeCatalog, describeIntakeFile, indexedMarkFile, intakeCode, intakeNameCode, libraryFilesForLocal, metadataInfo, personIntakeTargets
} from "./intake-catalog.js";
import {
  classifyIntakeVideoAds, inspectIntakePackage, packageMediaFingerprint, packageSubtitles, packageSummary,
  removeIntakePackage, removeMigratedIntakePackage, requireIntakePackage, requireIntakePackageFolder, snapshotIntakeDirectory
} from "./intake-packages.js";
import { hasIdentityTable } from "../people/person-identity.js";

const ACTIONS = new Set(["replace", "keep", "new", "discard", "discardBoth", "mark"]);
const DISCARD_REASONS = {
  "keep-4k": "保留 4K 馆藏",
  "keep-subtitled": "保留中字馆藏",
  "keep-uncensored": "保留无码馆藏",
  "quality": "画质或版本不合适",
  "other": "其他"
};
const DISCARD_PAGE_SIZE = 30;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stamp = () => new Date().toISOString();
const filenameFlags = (file) => deriveWorkTraits({ videos: [{ name: path.basename(file) }] }).flags;
function sourceIsLtx(source, folder) {
  const name = path.basename(source).replace(/(\p{Script=Han})(?=LTXC?[_.-]restored(?:[_.-]|$))/giu, "$1 ");
  return deriveWorkTraits({ directoryName: folder ? path.basename(folder) : "", videos: [{ name }] }).flags.ltx;
}
const sqliteBusy = (error) => [5, 6].includes(error.errcode & 255);
const usesVolumeQueue = (plan) => ["replace", "keep", "new"].includes(plan.action);

function discardDecision(input) {
  if (input === undefined) return null;
  if (!Array.isArray(input?.reasons) || input.reasons.length > Object.keys(DISCARD_REASONS).length
    || input.reasons.some((reason) => typeof reason !== "string" || !Object.hasOwn(DISCARD_REASONS, reason))
    || typeof input.ltx !== "boolean") throw intakeError("丢弃原因或 LTX 标记无效", 400);
  return { reasons: [...new Set(input.reasons)], ltx: input.ltx };
}

function volumeDevice(folder) {
  for (let current = folder; ; current = path.dirname(current)) {
    const stat = fs.statSync(current, { throwIfNoEntry: false });
    if (stat) return stat.dev;
    if (current === path.dirname(current)) return null;
  }
}

export function createMediaIntakeService({ getDb, sourceRoots, libraryRoots, relativeFromRoot,
  probeVideo, fetchMetadata, searchRoots, classifyAds = async () => [], openPath = openIntakePath,
  onIndexChanged = () => {}, markFavorite = () => {}, targetDevice = volumeDevice }) {
  const incomingRoots = sourceRoots.map((value) => path.resolve(value));
  const targetRoots = libraryRoots.map((value) => path.resolve(value));
  const metadata = new Map(), probes = new Map(), pending = new Set(), initialized = new WeakSet();
  const owner = `${process.pid}:${randomUUID()}`;
  const active = new Map();
  let closing = false, retryTimer;

  function volumeLabel(folder) {
    if (!folder) return "";
    const root = targetRoots.filter((candidate) => inside(folder, candidate)).sort((a, b) => b.length - a.length)[0];
    return root || path.parse(folder).root;
  }

  function diskFor(plan) {
    if (!usesVolumeQueue(plan)) return null;
    const device = targetDevice(plan.folder);
    return { key: device ? String(device) : "", label: volumeLabel(plan.folder) };
  }

  // An unidentifiable destination occupies the migration lane conservatively.
  function sameDisk(a, b) { return a && b && (!a.key || !b.key || a.key === b.key); }

  function database() {
    const db = getDb();
    if (!initialized.has(db)) {
      db.exec(`CREATE TABLE IF NOT EXISTS media_intake_jobs (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, plan_json TEXT NOT NULL, result_json TEXT,
        error TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_intake_queue (
        sequence INTEGER PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES media_intake_jobs(id) ON DELETE CASCADE
      )`);
      initialized.add(db);
    }
    return db;
  }

  function checkOpen() { if (closing) throw intakeError("服务正在停止", 503); }
  function track(operation) {
    checkOpen();
    if (pending.size >= 10) throw intakeError("正在处理多项读取，请稍后重试", 503);
    const promise = Promise.resolve().then(operation);
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }

  function sourcePathRoots(file) {
    if (typeof file !== "string" || !path.isAbsolute(file)) return incomingRoots;
    const fullPath = path.resolve(file);
    return incomingRoots.some((root) => inside(fullPath, root)) ? incomingRoots : [path.parse(fullPath).root];
  }

  function incoming(file, { missing = false } = {}) {
    const source = checkedPath(file, sourcePathRoots(file));
    if (!VIDEO.test(source)) throw intakeError("请选择视频文件", 400);
    if (targetRoots.some((root) => inside(source, root))) throw intakeError("馆藏盘内的文件请在作品详情操作", 400);
    const stat = lstat(source);
    if (stat || !missing) {
      regular(source);
      const real = fs.realpathSync.native(source);
      for (const root of targetRoots) if (lstat(root) && inside(real, fs.realpathSync.native(root))) throw intakeError("该路径实际指向馆藏", 400);
      assertUnindexed(database(), source);
      assertFinished(source);
    }
    return source;
  }

  function packageFolder(file) {
    const folder = checkedPath(file, incomingRoots);
    if (incomingRoots.some((root) => pathKey(folder) === pathKey(root)) || /^[.$]/.test(path.basename(folder))) {
      throw intakeError("请选择下载盘里的单个作品目录", 400);
    }
    const real = lstat(folder) && fs.realpathSync.native(folder);
    const overlaps = (a, b) => inside(a, b) || inside(b, a);
    if (targetRoots.some((root) => overlaps(folder, root) || (real && lstat(root) && overlaps(real, fs.realpathSync.native(root))))) {
      throw intakeError("下载包目录与馆藏重叠", 400);
    }
    return folder;
  }

  function packageCode(folder) {
    return incomingRoots.some((root) => inside(folder, root) && pathKey(root) !== pathKey(folder))
      ? intakeNameCode(path.basename(folder)) : "";
  }

  function matchingPackageParent(source) {
    const parent = path.dirname(source);
    const code = packageCode(parent);
    return code && workCodeKey(code) === workCodeKey(intakeNameCode(path.basename(source))) ? parent : "";
  }

  function enclosingPackage(source) {
    for (let folder = path.dirname(source); incomingRoots.some((root) => inside(folder, root) && pathKey(folder) !== pathKey(root)); folder = path.dirname(folder)) {
      if (packageCode(folder)) return folder;
    }
    return "";
  }

  async function selectedPackage(input, source) {
    const candidate = input.packageFolder || matchingPackageParent(source);
    if (!candidate) {
      const enclosing = enclosingPackage(source);
      const name = path.basename(source), code = intakeNameCode(name);
      if (enclosing && workCodeKey(code) !== workCodeKey(packageCode(enclosing))
          && (await classifyIntakeVideoAds([{ path: source, name, code }], classifyAds)).has(source)) {
        throw intakeError("这是下载包中的广告，请重新加入文件夹并选择正片", 400);
      }
      return null;
    }
    const folder = packageFolder(candidate);
    if (!inside(source, folder)) throw intakeError("视频不在所选下载包内", 400);
    const bundle = await inspectIntakePackage(folder, incomingRoots, classifyAds);
    if (!bundle && !input.packageFolder) return null;
    if (!bundle || pathKey(bundle.videos[0].path) !== pathKey(source)) throw intakeError("下载包正片已改变，请重新拖入核对");
    return bundle;
  }

  function assertPackageUnindexed(folder, localId = null) {
    const prefix = folder.replaceAll("\\", "/").toLowerCase();
    const db = database();
    for (const [table, column, owner] of [["local_files", "file_path", "local_work_id"], ["local_works", "local_path", "id"]]) {
      const normalized = `lower(replace(${column},char(92),'/'))`;
      if (db.prepare(`SELECT 1 FROM ${table} WHERE (${normalized}=? OR instr(${normalized},?)=1)
        AND (? IS NULL OR coalesce(${owner},-1)<>?) LIMIT 1`).get(prefix, `${prefix}/`, localId, localId)) {
        throw intakeError(localId ? "馆藏目录与其他作品共用，请单独核对" : "目录包含已入库文件，请先核对目录");
      }
    }
  }

  function assertLibraryRemoval(plan) {
    const { folder, localId, workId } = plan;
    if (targetRoots.some((root) => inside(root, folder))) throw intakeError("拒绝删除包含资料库根目录的文件夹");
    const db = database();
    assertNoIntakeConflict(db, folder, workId);
    assertPackageUnindexed(folder, localId);
    const local = db.prepare("SELECT work_id,local_path FROM local_works WHERE id=?").get(localId);
    if (local?.work_id !== workId || pathKey(local.local_path) !== pathKey(folder)
      || db.prepare("SELECT file_path FROM local_files WHERE local_work_id=?").all(localId)
        .some(({ file_path }) => !file_path || !inside(pathKey(file_path), pathKey(folder)))) {
      throw intakeError("馆藏文件夹或索引已改变，请重新核对");
    }
    const prefix = folder.replaceAll("\\", "/").toLowerCase();
    for (const [table, column] of [["people", "folder_path"], ["person_library_locations", "path"]]) {
      if (!hasIdentityTable(db, table)) continue;
      const normalized = `lower(replace(${column},char(92),'/'))`;
      if (db.prepare(`SELECT 1 FROM ${table} WHERE ${normalized}=? OR instr(${normalized},?)=1 LIMIT 1`).get(prefix, `${prefix}/`)) {
        throw intakeError("拒绝删除人物目录");
      }
    }
  }

  function bounded(map, key, value, limit) {
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  async function probe(file) {
    const before = signature(regular(file));
    const key = JSON.stringify([file, before]);
    if (!probes.has(key)) bounded(probes, key, Promise.resolve().then(() => probeVideo(file)), 160);
    const result = await probes.get(key);
    if (!result) probes.delete(key);
    if (!same(signature(regular(file)), before)) throw intakeError("读取时视频发生变化，请稍后重试");
    return result;
  }

  function fileDetails(file, fileProbe, directoryName = "") {
    const details = describeIntakeFile(file, fileProbe);
    const traits = deriveWorkTraits({ directoryName, relativePath: file, videos: [{ name: details.name, ...fileProbe }] });
    return { ...details, labels: traits.editions.map((edition) => edition.label), flags: traits.flags };
  }

  async function scan(input = {}) {
    const found = await collectIntakeFiles(input, input.path ? sourcePathRoots(input.path) : incomingRoots,
      { searchRoots, excludedRoots: targetRoots });
    const packages = new Map(), items = new Map();
    const downloadOrigins = new Map([...found.folderOrigins].filter(([, folder]) => incomingRoots.some((root) => inside(folder, root))));
    const videos = found.files.filter((file) => downloadOrigins.has(pathKey(file))).map((file) => {
      const name = path.basename(file);
      return { path: file, name, code: intakeNameCode(path.parse(name).name) };
    });
    const ads = await classifyIntakeVideoAds(videos, classifyAds);
    const skippedAds = [];
    for (const file of found.files) {
      try {
        checkOpen();
        const origin = downloadOrigins.get(pathKey(file)) || matchingPackageParent(file);
        let bundle = null;
        if (origin) for (let dir = path.dirname(file); inside(dir, origin); dir = path.dirname(dir)) {
          if (packageCode(dir)) {
            const key = pathKey(dir);
            if (!packages.has(key)) packages.set(key, inspectIntakePackage(packageFolder(dir), incomingRoots, classifyAds));
            bundle = await packages.get(key);
            if (bundle) break;
          }
          if (pathKey(dir) === pathKey(origin)) break;
        }
        if (!bundle && origin && ads.has(file)) {
          const enclosing = enclosingPackage(file);
          if (!enclosing || workCodeKey(intakeNameCode(path.parse(file).name)) !== workCodeKey(packageCode(enclosing))) {
            skippedAds.push(file);
            continue;
          }
        }
        const source = incoming(bundle?.videos[0].path || file);
        const { size } = regular(source);
        items.set(pathKey(source), { path: source, name: path.basename(source), size, code: bundle?.code || intakeCode(source), package: packageSummary(bundle) });
      } catch (error) { items.set(pathKey(file), { path: file, name: path.basename(file), error: error.statusCode ? error.message : "文件无法读取" }); }
    }
    return { unmatched: found.unmatched, items: [...items.values()], skippedAds };
  }

  function currentMetadata(code, catalog) {
    const cached = metadata.get(workCodeKey(code));
    if (cached?.expiresAt > Date.now() && cached.value) return cached.value;
    return catalog.works.length === 1 && catalog.works[0].actors.length
      ? cleanIntakeMetadata(catalog.works[0], "本地目录资料") : null;
  }

  async function compare(input = {}) {
    const source = incoming(input.path);
    const bundle = await selectedPackage(input, source);
    const code = intakeCode(source, input.code || bundle?.code);
    const catalog = catalogForIntake(database(), code);
    const meta = currentMetadata(code, catalog);
    const sourceDetails = fileDetails(source, await probe(source), bundle ? path.basename(bundle.folder) : "");
    const candidates = catalog.videos.slice(0, 40);
    const files = [];
    // Bounded batches avoid opening a stack of remote media simultaneously.
    for (let index = 0; index < candidates.length; index += 4) {
      checkOpen();
      files.push(...await Promise.all(candidates.slice(index, index + 4).map(async (row) => {
        const base = { id: Number(row.id), workId: row.work.id, title: row.work.title, name: row.name,
          path: row.file_path, folder: row.folder, size: row.size, a: /^\[A\]/i.test(path.basename(row.folder || "")) };
        try {
          const file = checkedPath(row.file_path, targetRoots);
          const measured = await probe(file);
          const details = fileDetails(file, measured, path.basename(row.folder || ""));
          return { ...base, ...details, folder: row.folder, marks: filenameFlags(file), protected4k: is4kOrHigher(measured), available: true };
        } catch { return { ...base, available: false, labels: [], probe: null }; }
      })));
    }
    return { code, source: sourceDetails, package: packageSummary(bundle), works: catalog.works, files, moreFiles: catalog.videos.length > files.length,
      metadata: meta, actors: meta && !files.length ? personIntakeTargets(database(), meta.actors, targetRoots) : [] };
  }

  async function lookupMetadata(input = {}) {
    const source = incoming(input.path);
    const code = intakeCode(source, input.code);
    if (!code) throw intakeError("请先填写番号", 400);
    const key = workCodeKey(code), cached = metadata.get(key);
    if (cached?.promise) return cached.promise;
    if ([...metadata.values()].some((item) => item.promise)) throw intakeError("115Chrome 正在查询另一部作品，请稍后重试");
    const promise = Promise.resolve().then(async () => {
      const raw = await fetchMetadata(code);
      if (!raw || workCodeKey(raw.code) !== key) throw intakeError("115Chrome／JavDB 没有查到相同番号", 404);
      const value = cleanIntakeMetadata(raw, "115Chrome / JavDB");
      if (!value.title || !value.actors.length) throw intakeError("查到了番号，但缺少标题或演员，暂无法自动归档");
      bounded(metadata, key, { value, expiresAt: Date.now() + 30 * 60_000 }, 40);
      return { metadata: value, actors: personIntakeTargets(database(), value.actors, targetRoots) };
    }).catch((error) => {
      metadata.delete(key);
      if (error.statusCode) throw error;
      throw intakeError("115Chrome／JavDB 查询失败。请检查 115 登录、代理或浏览器配置后重试", 502);
    });
    bounded(metadata, key, { promise }, 40);
    return promise;
  }

  function decodeJob(row) {
    return { id: row.id, state: row.state, owner: row.owner, plan: JSON.parse(row.plan_json), result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function readJob(id) {
    if (!JOB_ID.test(String(id))) throw intakeError("迁移记录不存在", 404);
    const row = database().prepare("SELECT * FROM media_intake_jobs WHERE id=?").get(id);
    if (!row) throw intakeError("迁移记录不存在", 404);
    return decodeJob(row);
  }

  function readQueue() {
    return database().prepare(`SELECT j.id,j.plan_json FROM media_intake_queue q JOIN media_intake_jobs j ON j.id=q.job_id
      ORDER BY q.sequence`).all().map(({ id, plan_json }) => {
      const plan = JSON.parse(plan_json);
      return { id, disk: usesVolumeQueue(plan) ? plan.disk : null };
    });
  }

  function present(job, waiting = readQueue()) {
    const { plan } = job;
    const index = waiting.findIndex((entry) => entry.id === job.id);
    const position = index < 0 ? 0 : waiting.slice(0, index).filter((entry) => sameDisk(entry.disk, waiting[index].disk)).length + 1;
    const running = active.get(job.id);
    const live = position > 0 || Boolean(running) || ownerAlive(job.owner);
    return { id: job.id, state: position ? "queued" : job.state === "working" && !live ? "interrupted" : job.state,
      active: live, position, progress: progressView(running?.progress), targetVolume: volumeLabel(plan.folder), action: plan.action, code: plan.code, source: plan.source, old: plan.old?.path || "",
      target: job.result?.target || plan.files[0]?.target || "", tags: plan.tags, result: job.result, replaces4k: Boolean(plan.old?.quality4k),
      oldQualityUnknown: Boolean(plan.old?.qualityUnknown),
      items: plan.files.map((file) => ({ source: file.source, target: file.target, retainedSubtitle: file.retainedSubtitle })), package: packageSummary(plan.bundle),
      libraryRemoval: plan.libraryRemoval ? { folder: plan.folder, videos: plan.libraryRemoval.videos, files: plan.libraryRemoval.files } : null,
      discardLtx: plan.action === "discard" ? plan.discardDecision?.ltx ?? sourceIsLtx(plan.source, plan.bundle?.folder) : undefined,
      discardReasons: plan.discardDecision?.reasons,
      createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error };
  }

  function discardStats({ reason = "", ltxOnly = false, page = 1 } = {}) {
    if (reason && reason !== "unrecorded" && !Object.hasOwn(DISCARD_REASONS, reason)) throw intakeError("未知丢弃原因", 400);
    const rows = database().prepare(`SELECT updated_at AS completedAt, json_extract(plan_json,'$.code') AS code,
        json_extract(plan_json,'$.source') AS source, json_extract(plan_json,'$.bundle.folder') AS folder,
        json_extract(plan_json,'$.discardDecision') AS decision
      FROM media_intake_jobs WHERE state='completed' AND json_extract(plan_json,'$.action')='discard'
      ORDER BY updated_at DESC, id DESC`).all().map(({ decision: stored, ...row }) => {
      const decision = stored && JSON.parse(stored);
      return { ...row, reasons: decision?.reasons || [], ltx: decision?.ltx ?? sourceIsLtx(row.source, row.folder), inferred: !decision };
    });
    const ltxCount = rows.filter((row) => row.ltx).length;
    const scope = ltxOnly ? rows.filter((row) => row.ltx) : rows;
    const counts = Object.fromEntries(Object.keys(DISCARD_REASONS).map((key) => [key, 0]));
    let unrecorded = 0;
    for (const row of scope) {
      if (!row.reasons.length) unrecorded += 1;
      for (const key of row.reasons) if (Object.hasOwn(counts, key)) counts[key] += 1;
    }
    const filtered = !reason ? scope : scope.filter((row) => reason === "unrecorded" ? !row.reasons.length : row.reasons.includes(reason));
    const pages = Math.max(1, Math.ceil(filtered.length / DISCARD_PAGE_SIZE));
    const current = Math.min(pages, Math.max(1, Math.trunc(Number(page)) || 1));
    return { total: rows.length, ltxCount, counts, unrecorded, matched: filtered.length, page: current, pages,
      records: filtered.slice((current - 1) * DISCARD_PAGE_SIZE, current * DISCARD_PAGE_SIZE) };
  }

  function setPhase(progress, phase) {
    if (progress.phase === phase) return;
    progress.phase = phase;
    progress.phaseStart = Date.now();
    progress.phaseBytes = 0;
  }

  function progressView(progress) {
    if (!progress) return null;
    const { phase, copied, verified, total, phaseStart, phaseBytes } = progress;
    const elapsed = (Date.now() - phaseStart) / 1000;
    const rate = elapsed >= 1 ? phaseBytes / elapsed : 0;
    const remaining = 2 * total - copied - verified;
    return { phase, copied, verified, total, rate, percent: total ? Math.min(100, (copied + verified) / (2 * total) * 100) : null,
      eta: rate && remaining > 0 ? remaining / rate : null };
  }

  function assertSeparatePlans(plan, other) {
    const pathsFor = (value) => [value.source, value.old?.path, value.retained?.path, value.bundle?.folder,
      ...value.files.flatMap((item) => [item.source, item.target])].filter(Boolean).map(pathKey);
    const paths = pathsFor(plan), otherPaths = pathsFor(other);
    if (otherPaths.some((file) => paths.includes(file) || (plan.bundle && inside(file, pathKey(plan.bundle.folder))))
      || (other.bundle && paths.some((file) => inside(file, pathKey(other.bundle.folder)))) || (plan.sourceSignature?.[1]
      && same(plan.sourceSignature.slice(0, 2), other.sourceSignature?.slice(0, 2)))) throw intakeError("这个视频已在执行队列中");
    if (plan.action !== "discard" && other.action !== "discard" && workCodeKey(other.code) === workCodeKey(plan.code)) {
      throw intakeError(`${plan.code} 已有任务在执行队列中，等它完成后再提交`);
    }
  }

  function assertNotPending(plan, jobId) {
    const rows = database().prepare(`SELECT j.id,j.plan_json,j.owner,q.job_id AS queued FROM media_intake_jobs j
      LEFT JOIN media_intake_queue q ON q.job_id=j.id WHERE q.job_id IS NOT NULL OR j.owner<>''`).all();
    for (const row of rows) {
      if (row.id !== jobId && (row.queued || ownerAlive(row.owner))) assertSeparatePlans(plan, JSON.parse(row.plan_json));
    }
  }

  function save(job) {
    job.updatedAt = stamp();
    database().prepare(`UPDATE media_intake_jobs SET state=?,plan_json=?,result_json=?,error=?,updated_at=? WHERE id=?`)
      .run(job.state, JSON.stringify(job.plan), job.result ? JSON.stringify(job.result) : null, job.error || "", job.updatedAt, job.id);
  }

  function targetForExisting(catalog, input, action) {
    const selected = catalog.videos.find((row) => Number(row.id) === Number(input.oldId));
    if (!selected) throw intakeError("请选择需要对照的馆藏视频", 400);
    const folder = checkedPath(selected.folder, targetRoots);
    const oldPath = checkedPath(selected.file_path, targetRoots);
    if (pathKey(path.dirname(oldPath)) !== pathKey(folder)) throw intakeError("视频和作品文件夹的索引不一致");
    const stat = regular(oldPath);
    const indexedOwners = database().prepare("SELECT id FROM local_files WHERE lower(replace(file_path,char(92),'/'))=lower(?)").all(oldPath.replaceAll("\\", "/"));
    if (indexedOwners.length !== 1 || indexedOwners[0].id !== selected.id || stat.nlink !== 1 || stat.size !== selected.size) throw intakeError("馆藏视频的身份或索引归属已变，请先刷新馆藏");
    if (action !== "keep" && !selected.file_id) throw intakeError("馆藏视频缺少索引身份");
    return { selected, folder, oldPath, oldSignature: signature(stat) };
  }

  async function prepare(input = {}) {
    const action = input.action;
    if (!ACTIONS.has(action)) throw intakeError("请选择处理方式", 400);
    if (action === "mark") return prepareMark(input);
    const source = incoming(input.path);
    const sourceStat = regular(source);
    if (sourceStat.nlink !== 1) throw intakeError("源文件已有多个硬链接，请先核对归属");
    const bundle = await selectedPackage(input, source);
    const code = intakeCode(source, input.code || bundle?.code);
    if (input.sourceSignature && !same(signature(sourceStat), input.sourceSignature)) throw intakeError("视频已改变，请重新对照后确认");
    const id = randomUUID(), createdAt = stamp();
    const plan = { action, source, sourceSignature: signature(sourceStat), code, files: [], tags: {} };
    if (bundle) {
      if (!input.packageFingerprint && (!usesVolumeQueue(plan) || input.supportsPackageConfirmation !== true)) {
        throw intakeError("此视频属于下载包，请重新匹配并确认整个文件夹");
      }
      if (usesVolumeQueue(plan) && input.packageMediaFingerprint) {
        if (input.packageMediaFingerprint !== packageMediaFingerprint(bundle)) throw intakeError("下载包的正片或字幕已改变，请重新核对");
      } else if (input.packageFingerprint && input.packageFingerprint !== bundle.fingerprint) {
        throw intakeError("下载包内容已改变，请重新对照后确认");
      }
      assertPackageUnindexed(bundle.folder);
      bundle.quarantine = checkedPath(path.join(path.dirname(bundle.folder), `.fh-${id}.discard`), incomingRoots);
      plan.bundle = bundle;
    }
    if (action === "discardBoth") {
      const { selected, folder, oldPath, oldSignature } = targetForExisting(catalogForIntake(database(), code), input, action);
      if (!same(plan.sourceSignature, input.sourceSignature) || !same(oldSignature, input.oldSignature)) {
        throw intakeError("待迁移或馆藏视频已改变，请重新对照");
      }
      Object.assign(plan, { folder, localId: Number(selected.local_work_id), workId: Number(selected.work.id),
        old: { id: Number(selected.id), path: oldPath, fileId: selected.file_id, signature: oldSignature } });
      assertLibraryRemoval(plan);
      const manifest = snapshotIntakeDirectory(folder, targetRoots, "馆藏目录");
      const files = manifest.entries.filter((item) => !item.directory);
      plan.libraryRemoval = { ...manifest, folder, label: "馆藏目录",
        quarantine: path.join(path.dirname(folder), `.fh-${id}.discard`),
        videos: files.filter((item) => VIDEO.test(item.relative)).length, files: files.length };
      if (!bundle) plan.sourceTrash = path.join(path.dirname(source), `.fh-${id}.discard`);
      return registerPlan(id, plan, createdAt);
    }
    if (action !== "discard") {
      if (!code) throw intakeError("请先确认番号", 400);
      const db = database();
      const catalog = catalogForIntake(db, code);
      const measured = await probe(source);
      if (!measured) throw intakeError("新视频的分辨率或视频流无法读取，请先在播放器里检查文件");
      plan.probe = measured;
      const tags = input.tags || {};
      plan.tags = { ltx: tags.ltx !== false, u: tags.u === true, c: tags.c === true, a: tags.a === true };
      if (action === "new") {
        if (catalog.videos.length || catalog.works.length > 1) throw intakeError("这个番号已有馆藏或多个索引归属，请先对照已有记录");
        plan.meta = currentMetadata(code, catalog);
        if (!plan.meta) throw intakeError("请先通过 115Chrome 查询标题和人物资料");
        const options = personIntakeTargets(db, plan.meta.actors, targetRoots);
        plan.actor = options.find((item) => item.folder === input.actorFolder && item.name === input.actorName) || (options.length === 1 ? options[0] : null);
        if (!plan.actor) throw intakeError("请选择要归档的人物目录", 400);
        plan.actorIdentity = identity(lstat(plan.actor.folder));
        plan.workId = catalog.works[0]?.id || null;
        const base = nameForIntake(plan.actor.folder, code, plan.meta.title, {}, ".mp4").slice(0, -4);
        plan.folder = checkedPath(path.join(plan.actor.folder, `${plan.tags.a ? "[A]." : ""}${base.slice(0, 115)}`), targetRoots);
        if (lstat(plan.folder)) throw intakeError("目标作品目录已存在，请先核对该目录");
      } else {
        const { selected, folder, oldPath, oldSignature } = targetForExisting(catalog, input, action);
        plan.folder = folder; plan.workId = selected.work.id; plan.localId = Number(selected.local_work_id); plan.meta = selected.work;
        plan.folderIdentity = identity(lstat(folder));
        if (input.oldSignature && !same(oldSignature, input.oldSignature)) throw intakeError("馆藏视频已改变，请重新对照");
        if (action === "replace") {
          const oldProbe = await probe(oldPath);
          plan.old = { id: Number(selected.id), path: oldPath, dbPath: selected.file_path, fileId: selected.file_id,
            signature: oldSignature, quality4k: is4kOrHigher(oldProbe), qualityUnknown: !oldProbe };
        } else plan.retained = { id: Number(selected.id), path: oldPath, fileId: selected.file_id, signature: oldSignature };
        if (plan.tags.a && !/^\[A\]/i.test(path.basename(folder))) {
          const first = db.prepare("SELECT id FROM local_works WHERE work_id=? ORDER BY id LIMIT 1").get(plan.workId);
          if (first?.id !== plan.localId) throw intakeError("该作品有多个目录，请在目标作品详情中单独设置 [A]");
          plan.markFavorite = true;
        }
      }
      const sources = bundle?.videos || [{ path: source, signature: plan.sourceSignature }];
      for (const [index, entry] of sources.entries()) {
        const video = incoming(entry.path);
        requireSame(video, entry.signature);
        if (regular(video).nlink !== 1) throw intakeError("源文件已有多个硬链接，请先核对归属");
        const videoProbe = index ? await probe(video) : measured;
        if (!videoProbe) throw intakeError("下载包中有视频无法读取，请先在播放器里检查文件");
        const classification = deriveWorkTraits({ relativePath: plan.folder, directoryName: path.basename(plan.folder),
          infoSummary: { code, tags: plan.meta.tags || [] }, videos: [{ name: path.basename(video), ...videoProbe }] });
        const videoTags = { ...plan.tags, quality4k: classification.flags.quality4k };
        if (!index) plan.tags.quality4k = videoTags.quality4k;
        const part = sources.length > 1 ? index + 1 : 0;
        let name = nameForIntake(plan.folder, code, plan.meta.title, videoTags, path.extname(video), part);
        if (action === "keep" && lstat(path.join(plan.folder, name))) {
          name = nameForIntake(plan.folder, code, `${plan.meta.title} 版本 2`, videoTags, path.extname(video), part);
        }
        const target = checkedPath(path.join(plan.folder, name), targetRoots);
        const old = index === 0 ? plan.old : null;
        if (lstat(target) && (!old || pathKey(old.path) !== pathKey(target))) throw intakeError("目标文件已存在，请选择不同的版本标签");
        plan.files.push({ type: "video", source: video, target, sourceSignature: entry.signature, probe: videoProbe });
      }
      const target = plan.files[0].target;
      const sides = bundle ? packageSubtitles(bundle) : subtitleFiles(source).map((side) => ({ ...side, video: 0 }));
      for (const side of sides) {
        checkedPath(side.file, sourcePathRoots(source));
        assertUnindexed(db, side.file);
        const destination = checkedPath(path.join(plan.folder, path.parse(plan.files[side.video].target).name + side.suffix), targetRoots);
        if (process.platform === "win32" && destination.length >= 260) throw intakeError("配套字幕的目标路径过长，请先缩短字幕后缀");
        if (lstat(destination) || plan.files.some((item) => pathKey(item.target) === pathKey(destination))) {
          throw intakeError("目标有同名字幕，请先核对字幕再迁移");
        }
        plan.files.push({ type: "info", source: side.file, target: destination, sourceSignature: side.signature || signature(regular(side.file)) });
      }
      if (plan.old && sources.length === 1) {
        for (const side of subtitleFiles(plan.old.path, { legacy: true, exclusive: true })) {
          const destination = checkedPath(path.join(plan.folder, path.parse(target).name + side.suffix), targetRoots);
          if (lstat(destination) || plan.files.some((item) => pathKey(item.target) === pathKey(destination))
              || (process.platform === "win32" && destination.length >= 260)) continue;
          const file = checkedPath(side.file, targetRoots);
          const row = indexedMarkFile(db, file, plan.localId, "info");
          plan.files.push({ type: "info", source: file, target: destination, sourceSignature: signature(regular(file)),
            retainedSubtitle: true, linkOnly: true, indexId: row?.id ?? null, fileId: row?.file_id ?? null });
        }
      }
      if (action === "new") plan.files.push({ type: "info", target: path.join(plan.folder, "info.txt"), content: metadataInfo(plan.meta, code) });
      for (const [index, item] of plan.files.entries()) item.temp = path.join(plan.folder, `.fh-${id}-${index}.part`);
      if (plan.old && pathKey(plan.old.path) === pathKey(target)) plan.old.backup = path.join(plan.folder, `.fh-${id}.old`);
      assertNoIntakeConflict(db, plan.folder, plan.workId);
    }
    return registerPlan(id, plan, createdAt);
  }

  function prepareMark(input) {
    const db = database();
    const code = intakeCode("", input.code);
    const { selected, folder, oldPath, oldSignature } = targetForExisting(catalogForIntake(db, code), input, "mark");
    if (!same(oldSignature, input.oldSignature)) throw intakeError("馆藏视频已改变，请重新对照");
    const name = nameWithIntakeMarks(oldPath, input.tags || {}, filenameFlags(oldPath));
    const newStem = path.parse(name).name;
    const localId = Number(selected.local_work_id), workId = Number(selected.work.id);
    const subtitles = subtitleFiles(oldPath);
    const oldStem = path.parse(oldPath).name.toLowerCase();
    if (subtitles.length && fs.readdirSync(folder).some((file) => VIDEO.test(file) && file.toLowerCase() !== path.basename(oldPath).toLowerCase()
        && path.parse(file).name.toLowerCase() === oldStem)) throw intakeError("这份外挂字幕与其他视频共用，请先核对字幕");
    const id = randomUUID();
    const items = [{ source: oldPath, name, type: "video" }, ...subtitles.map(({ file, suffix }) => ({ source: file, name: newStem + suffix, type: "info" }))];
    const files = items.map(({ source, name: leaf, type }, index) => {
      checkedPath(source, targetRoots);
      const target = checkedPath(path.join(folder, leaf), targetRoots);
      if (process.platform === "win32" && target.length >= 260) throw intakeError("目标路径过长，请先缩短作品文件夹名");
      if (lstat(target)) throw intakeError("目标文件名已存在，请先核对馆藏");
      assertUnindexed(db, target);
      const row = indexedMarkFile(db, source, localId, type);
      return { source, target, type, sourceSignature: signature(regular(source)), indexId: row?.id ?? null, fileId: row?.file_id ?? null,
        temp: path.join(folder, `.fh-${id}-${index}.part`), linkOnly: true };
    });
    assertNoIntakeConflict(db, folder, workId);
    const old = { id: Number(selected.id), path: oldPath, fileId: selected.file_id, signature: oldSignature };
    return registerPlan(id, { action: "mark", code, source: oldPath, sourceSignature: oldSignature, folder, folderIdentity: identity(lstat(folder)),
      localId, workId, old, files, tags: {} }, stamp());
  }

  function registerPlan(id, plan, createdAt) {
    checkOpen();
    requireSame(plan.source, plan.sourceSignature);
    assertNotPending(plan, id);
    database().prepare("INSERT INTO media_intake_jobs (id,state,plan_json,created_at,updated_at) VALUES (?,'prepared',?,?,?)")
      .run(id, JSON.stringify(plan), createdAt, createdAt);
    return present(readJob(id));
  }

  function requireSame(file, expected) {
    if (!same(signature(regular(file)), expected)) throw intakeError("文件身份已改变，请重新核对");
  }

  function revalidate(job) {
    const plan = job.plan;
    const marking = plan.action === "mark";
    if (!marking) incoming(plan.source);
    requireSame(plan.source, plan.sourceSignature);
    if (plan.bundle) {
      assertPackageUnindexed(packageFolder(plan.bundle.folder));
      requireIntakePackageFolder(plan.bundle, incomingRoots);
    }
    checkedPath(plan.folder, targetRoots);
    if (plan.disk && diskFor(plan).key !== plan.disk.key) throw intakeError("目标卷已改变，请重新核对");
    if (plan.folderIdentity && !same(identity(lstat(plan.folder)), plan.folderIdentity)) throw intakeError("目标作品目录已改变");
    assertNoIntakeConflict(database(), plan.folder, plan.workId);
    if (plan.localId) {
      const current = database().prepare("SELECT work_id,local_path FROM local_works WHERE id=?").get(plan.localId);
      if (current?.work_id !== plan.workId || pathKey(current.local_path || "") !== pathKey(plan.folder)) throw intakeError("目标作品目录已改变");
      const selected = plan.old || plan.retained;
      if (selected && !libraryFilesForLocal(database(), plan.localId).some((row) => row.id === selected.id && row.file_id === selected.fileId && pathKey(row.file_path) === pathKey(selected.path))) throw intakeError("馆藏视频索引已改变");
    }
    if (plan.retained) requireSame(checkedPath(plan.retained.path, targetRoots), plan.retained.signature);
    if (plan.old) {
      const original = plan.old.backup && lstat(plan.old.backup) ? plan.old.backup : plan.old.path;
      checkedPath(original, targetRoots);
      requireSame(original, plan.old.signature);
    }
    for (const item of plan.files) {
      checkedPath(item.target, targetRoots);
      checkedPath(item.temp, targetRoots);
      if (item.source) {
        const librarySource = marking || item.retainedSubtitle;
        checkedPath(item.source, librarySource ? targetRoots : sourcePathRoots(plan.source));
        requireSame(item.source, item.sourceSignature);
        if (!librarySource) assertUnindexed(database(), item.source);
      }
    }
  }

  function createTargetFolder(job) {
    const plan = job.plan;
    if (plan.action === "new" && !plan.folderIdentity) {
      checkedPath(plan.actor.folder, targetRoots);
      const actorStat = lstat(plan.actor.folder);
      if (plan.actorIdentity && !same(identity(actorStat), plan.actorIdentity)) throw intakeError("人物目录已改变");
      if (!actorStat) fs.mkdirSync(plan.actor.folder);
      else if (!actorStat.isDirectory()) throw intakeError("人物目录不可用");
      fs.mkdirSync(plan.folder);
      plan.folderIdentity = identity(lstat(plan.folder));
      save(job);
    } else if (!lstat(plan.folder)?.isDirectory() || (plan.folderIdentity && !same(identity(lstat(plan.folder)), plan.folderIdentity))) {
      throw intakeError("目标作品目录已改变");
    }
  }

  function publish(job) {
    const { plan } = job, db = database();
    const published = [];
    let backup = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      revalidate(job);
      for (const item of plan.files) requireSame(item.temp, item.staged);
      for (const item of plan.files) {
        if (!plan.old?.backup || pathKey(item.target) !== pathKey(plan.old.path)) assertUnindexed(db, item.target);
      }
      if (plan.old?.backup) {
        const owners = db.prepare("SELECT id FROM local_files WHERE lower(replace(file_path,char(92),'/'))=lower(?)").all(plan.old.path.replaceAll("\\", "/"));
        if (owners.length !== 1 || owners[0].id !== plan.old.id) throw intakeError("已有其他索引引用目标文件");
        if (!lstat(plan.old.backup)) fs.linkSync(plan.old.path, plan.old.backup);
        requireSame(plan.old.backup, plan.old.signature);
        backup = true;
        if (same(signature(lstat(plan.old.path)), plan.old.signature)) fs.unlinkSync(plan.old.path);
      }
      for (const item of plan.files) {
        if (!lstat(item.target)) fs.linkSync(item.temp, item.target);
        requireSame(item.target, item.staged);
        published.push(item);
      }
      job.result = commitIntakeCatalog(db, plan, relativeFromRoot);
      job.state = "committed";
      save(job);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      job.result = null; job.state = "working";
      for (const item of published.reverse()) if (same(signature(lstat(item.target)), item.staged)) fs.unlinkSync(item.target);
      if (backup && !lstat(plan.old.path) && same(signature(lstat(plan.old.backup)), plan.old.signature)) {
        fs.linkSync(plan.old.backup, plan.old.path);
        fs.unlinkSync(plan.old.backup);
      }
      throw error;
    }
  }

  function removeOwned(file, expected, roots) {
    checkedPath(file, roots);
    if (!lstat(file)) return;
    requireSame(file, expected);
    fs.unlinkSync(file);
  }

  function finishCommitted(job) {
    const plan = job.plan;
    if (!plan.cleaned) {
      assertNoIntakeConflict(database(), plan.folder, job.result.workId);
      for (const item of plan.files) requireSame(checkedPath(item.target, targetRoots), item.staged);
      if (plan.bundle) cleanPackage(job);
      for (const item of plan.files) {
        if (item.source && (!plan.bundle || item.retainedSubtitle)) {
          assertUnindexed(database(), item.source);
          removeOwned(item.source, item.sourceSignature, plan.action === "mark" || item.retainedSubtitle ? targetRoots : sourcePathRoots(plan.source));
        }
        removeOwned(item.temp, item.staged, targetRoots);
      }
      if (plan.action === "replace" && plan.old) {
        const old = plan.old.backup || plan.old.path;
        assertUnindexed(database(), old);
        removeOwned(old, plan.old.signature, targetRoots);
      }
      plan.cleaned = true;
      save(job);
    }
    if (onIndexChanged() === null) throw intakeError("迁移已写入数据库，馆藏刷新失败，可重试收尾");
    if (plan.markFavorite) {
      markFavorite(job.result.workId);
      const current = database().prepare("SELECT local_path FROM local_works WHERE id=?").get(job.result.localId);
      if (current?.local_path) job.result.target = path.join(current.local_path, path.basename(job.result.target));
    }
    job.state = "completed";
    job.error = "";
    save(job);
  }

  function cleanPackage(job) {
    const bundle = job.plan.bundle;
    assertPackageUnindexed(packageFolder(bundle.folder));
    assertPackageUnindexed(bundle.quarantine);
    if (usesVolumeQueue(job.plan)) {
      job.result.sourceFolderRemaining = removeMigratedIntakePackage(bundle, incomingRoots, () => save(job));
    } else removeIntakePackage(bundle, incomingRoots, () => save(job));
  }

  function moveDiscardPair(plan, restore = false) {
    const directory = (bundle, roots) => ({ original: bundle.folder, quarantine: bundle.quarantine, roots,
      verify: (file) => requireIntakePackage(bundle, roots, file) });
    const entries = [plan.bundle ? directory(plan.bundle, incomingRoots) : {
      original: plan.source, quarantine: plan.sourceTrash, roots: sourcePathRoots(plan.source),
      verify: (file) => requireSame(file, plan.sourceSignature)
    }, directory(plan.libraryRemoval, targetRoots)];
    for (const { original, quarantine, roots, verify } of restore ? entries.reverse() : entries) {
      const from = checkedPath(restore ? quarantine : original, roots);
      const to = checkedPath(restore ? original : quarantine, roots);
      if (restore && !lstat(from)) continue;
      if (lstat(to)) {
        if (restore || lstat(from)) throw intakeError("删除隔离路径已被占用，请核对后重试");
        verify(to);
        continue;
      }
      verify(from);
      fs.renameSync(from, to);
      verify(to);
    }
  }

  function commitDiscardPair(job) {
    const { plan } = job, db = database();
    db.exec("BEGIN IMMEDIATE");
    try {
      assertLibraryRemoval(plan);
      const indexed = indexedMarkFile(db, plan.old.path, plan.localId, "video");
      if (indexed?.id !== plan.old.id || indexed.file_id !== plan.old.fileId) throw intakeError("所选馆藏索引已改变");
      if (plan.bundle) {
        assertPackageUnindexed(packageFolder(plan.bundle.folder));
        assertPackageUnindexed(plan.bundle.quarantine);
      } else {
        incoming(plan.source, { missing: true });
        assertUnindexed(db, plan.sourceTrash);
      }
      assertPackageUnindexed(plan.libraryRemoval.quarantine);
      moveDiscardPair(plan);
      if (hasIdentityTable(db, "video_probe_cache")) {
        db.prepare("DELETE FROM video_probe_cache WHERE file_id IN (SELECT file_id FROM local_files WHERE local_work_id=?)").run(plan.localId);
      }
      db.prepare("DELETE FROM local_files WHERE local_work_id=?").run(plan.localId);
      db.prepare("DELETE FROM local_works WHERE id=?").run(plan.localId);
      db.prepare("UPDATE works SET updated_at=? WHERE id=?").run(stamp(), plan.workId);
      job.result = { discarded: true, workId: plan.workId, localId: plan.localId };
      job.state = "committed";
      save(job);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      job.result = null;
      job.state = "working";
      moveDiscardPair(plan, true);
      throw error;
    }
  }

  function finishDiscardPair(job) {
    const { plan } = job;
    const cleanup = (bundle, roots) => {
      if (!lstat(checkedPath(bundle.quarantine, roots))) return;
      assertPackageUnindexed(bundle.quarantine);
      removeIntakePackage(bundle, roots, () => save(job));
    };
    if (plan.bundle) cleanup(plan.bundle, incomingRoots);
    else {
      assertUnindexed(database(), plan.sourceTrash);
      removeOwned(plan.sourceTrash, plan.sourceSignature, sourcePathRoots(plan.source));
    }
    cleanup(plan.libraryRemoval, targetRoots);
    if (onIndexChanged() === null) throw intakeError("删除已写入数据库，馆藏刷新失败，可重试收尾");
    job.state = "completed";
    job.error = "";
    save(job);
  }

  async function execute(job, progress) {
    const { plan } = job;
    if (plan.action === "discardBoth") {
      setPhase(progress, "delete");
      if (job.state !== "committed") commitDiscardPair(job);
      finishDiscardPair(job);
      return;
    }
    if (plan.action === "discard") {
      setPhase(progress, "delete");
      const file = plan.bundle ? null : incoming(plan.source, { missing: job.state !== "prepared" });
      job.state = "working";
      save(job);
      if (plan.bundle) cleanPackage(job);
      else removeOwned(file, plan.sourceSignature, sourcePathRoots(plan.source));
      job.result = { discarded: true };
      job.state = "completed";
      job.error = "";
      save(job);
      return;
    }
    if (job.state !== "committed") {
      job.state = "working";
      save(job);
      revalidate(job);
      createTargetFolder(job);
      let finished = 0;
      for (const item of plan.files) {
        await stageIntakeFile(item, () => save(job), (phase, size) => {
          setPhase(progress, phase);
          progress.phaseBytes += size;
          progress[phase === "copy" ? "copied" : "verified"] += size;
        });
        finished += item.source ? item.sourceSignature[2] : 0;
        progress.copied = progress.verified = finished;
      }
      setPhase(progress, "publish");
      publish(job);
    }
    progress.copied = progress.verified = progress.total;
    setPhase(progress, "cleanup");
    finishCommitted(job);
  }

  function start(id, disk, fromQueue = false, decision = null) {
    const db = database();
    let job;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (fromQueue && !db.prepare("SELECT 1 FROM media_intake_queue WHERE job_id=?").get(id)) { db.exec("COMMIT"); return true; }
      job = readJob(id);
      if (job.state === "completed" || ownerAlive(job.owner)) {
        db.prepare("DELETE FROM media_intake_queue WHERE job_id=?").run(id);
        db.exec("COMMIT"); return true;
      }
      assertNotPending(job.plan, id);
      const claims = db.prepare("SELECT owner,plan_json FROM media_intake_jobs WHERE owner<>''").all();
      let occupied = false;
      for (const claim of claims) {
        if (!ownerAlive(claim.owner)) continue;
        const other = JSON.parse(claim.plan_json);
        if (disk && usesVolumeQueue(other) && sameDisk(disk, other.disk ?? diskFor(other))) occupied = true;
      }
      if (occupied) { db.exec("COMMIT"); return false; }
      if (job.state === "prepared" && job.plan.action === "discard" && decision) job.plan.discardDecision = decision;
      job.plan.disk = disk;
      db.prepare("UPDATE media_intake_jobs SET owner=?,state=?,plan_json=?,error='' WHERE id=?")
        .run(owner, job.state === "committed" ? "committed" : "working", JSON.stringify(job.plan), id);
      db.prepare("DELETE FROM media_intake_queue WHERE job_id=?").run(id);
      db.exec("COMMIT");
      job.owner = owner; job.error = "";
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const total = job.plan.files.reduce((sum, item) => sum + (item.source ? item.sourceSignature[2] : 0), 0);
    const progress = { phase: "prepare", copied: 0, verified: 0, total, phaseStart: Date.now(), phaseBytes: 0 };
    const promise = Promise.resolve().then(() => execute(job, progress)).catch((error) => {
      if (job.state !== "committed") job.state = "blocked";
      job.error = error.statusCode ? error.message : error.code === "ENOSPC" ? "目标盘空间不足，释放空间后可从此任务重试。"
        : "文件操作失败。请检查目标磁盘空间、文件占用或目录权限后重试。";
      if (!error.statusCode) console.warn("[media-intake]", job.id, error.code || error.message);
      save(job);
    }).catch((error) => console.warn("[media-intake-receipt]", job.id, error.code || error.message)).finally(() => {
      try { database().prepare("UPDATE media_intake_jobs SET owner='' WHERE id=? AND owner=?").run(id, owner); }
      catch (error) { console.warn("[media-intake-release]", job.id, error.code || error.message); }
      active.delete(id);
      pump();
    });
    active.set(id, { disk, progress, promise });
    return true;
  }

  function drainQueue() {
    const occupied = [...active.values()].map(({ disk }) => disk);
    let retry = false;
    for (const { id, disk } of readQueue()) {
      if (occupied.some((other) => sameDisk(disk, other))) continue;
      try {
        if (!start(id, disk, true)) { occupied.push(disk); retry = true; continue; }
        if (active.has(id)) occupied.push(disk);
      }
      catch (error) {
        if (sqliteBusy(error)) { occupied.push(disk); retry = true; continue; }
        const db = database();
        try {
          db.exec("BEGIN IMMEDIATE");
          try {
            if (db.prepare("DELETE FROM media_intake_queue WHERE job_id=?").run(id).changes) {
              const job = readJob(id);
              if (job.state !== "committed") job.state = "blocked";
              job.error = error.statusCode ? error.message : "任务未能启动，请重试。";
              save(job);
            }
            db.exec("COMMIT");
          } catch (failure) { db.exec("ROLLBACK"); throw failure; }
        } catch (receipt) {
          retry = true;
          occupied.push(disk);
          console.warn("[media-intake-start]", id, receipt.code || receipt.message);
        }
      }
    }
    return retry;
  }

  function pump() {
    if (closing) return;
    let retry = true;
    try { retry = drainQueue(); }
    catch (error) { if (!sqliteBusy(error)) console.warn("[media-intake-queue]", error.code || error.message); }
    if (retry && !retryTimer) retryTimer = setTimeout(() => { retryTimer = undefined; pump(); }, 1000).unref();
  }

  function run(id, input = {}) {
    checkOpen();
    const job = readJob(id);
    if (job.state === "completed" || active.has(id) || ownerAlive(job.owner)) return present(job);
    const disk = diskFor(job.plan);
    if (disk) {
      const db = database();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = readJob(id);
        if (current.state !== "completed" && !ownerAlive(current.owner) && !db.prepare("SELECT 1 FROM media_intake_queue WHERE job_id=?").get(id)) {
          assertNotPending(current.plan, id);
          current.plan.disk = disk;
          save(current);
          db.prepare("INSERT INTO media_intake_queue(job_id) VALUES (?)").run(id);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      pump();
    } else start(id, null, false, job.plan.action === "discard" ? discardDecision(input?.discardDecision) : null);
    return present(readJob(id));
  }

  // Nothing is committed in these states, so the job's own staged files are safe to remove.
  function abandon(job) {
    const { plan } = job;
    if (plan.action === "discardBoth") {
      moveDiscardPair(plan, true);
      return;
    }
    if (plan.bundle && (plan.bundle.isolated || lstat(checkedPath(plan.bundle.quarantine, incomingRoots)))) {
      throw intakeError("下载包已隔离，请重试清理");
    }
    if (plan.old?.backup && lstat(plan.old.backup)) throw intakeError("旧视频的备份还未恢复，这个任务只能重试");
    for (const item of plan.files) {
      if (item.temp && lstat(checkedPath(item.temp, targetRoots))?.isFile()) fs.unlinkSync(item.temp);
      if (item.staged && same(signature(lstat(checkedPath(item.target, targetRoots))), item.staged)) {
        assertUnindexed(database(), item.target);
        fs.unlinkSync(item.target);
      }
    }
    if (plan.action === "new" && plan.folderIdentity && same(identity(lstat(plan.folder)), plan.folderIdentity)) {
      try { fs.rmdirSync(plan.folder); } catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
    }
  }

  function cancel(id) {
    checkOpen();
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    let job, cancelled;
    try {
      job = readJob(id);
      if (active.has(id) || ownerAlive(job.owner)) throw intakeError("任务已开始执行，不能取消");
      const wasQueued = db.prepare("DELETE FROM media_intake_queue WHERE job_id=?").run(id).changes;
      cancelled = !wasQueued || job.state === "prepared";
      if (cancelled) {
        if (!["prepared", "blocked", "working"].includes(job.state)) throw intakeError("这个任务已写入馆藏，不能取消");
        if (job.state !== "prepared") abandon(job);
        db.prepare("DELETE FROM media_intake_jobs WHERE id=?").run(id);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    pump();
    return cancelled ? { id, cancelled: true } : present(job);
  }

  function ownerAlive(value) {
    const pid = Number(String(value || "").split(":")[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  }

  async function open(input = {}) {
    const file = input.path;
    let target;
    if (targetRoots.some((root) => typeof file === "string" && path.isAbsolute(file) && inside(path.resolve(file), root))) {
      target = checkedPath(file, targetRoots);
      regular(target);
      if (!database().prepare("SELECT 1 FROM local_files WHERE lower(replace(file_path,char(92),'/'))=lower(?) AND file_type='video'")
        .get(target.replaceAll("\\", "/"))) throw intakeError("未找到这个馆藏视频", 404);
    } else target = incoming(file);
    try { await openPath(input.folder === true ? path.dirname(target) : target); }
    catch { throw intakeError("系统未能打开这个文件或文件夹，请检查默认应用", 502); }
    return { ok: true };
  }

  return {
    config: () => ({ roots: incomingRoots, maxFiles: 120, discardReasons: DISCARD_REASONS }),
    discardStats,
    scan: (input) => track(() => scan(input)), compare: (input) => track(() => compare(input)),
    metadata: (input) => track(() => lookupMetadata(input)), prepare: (input) => track(() => prepare(input)),
    open: (input) => track(() => open(input)), run, cancel,
    list: () => {
      const db = database();
      const recent = db.prepare("SELECT id FROM media_intake_jobs ORDER BY created_at DESC LIMIT 30").all().map(({ id }) => id);
      const waiting = readQueue();
      const owned = db.prepare("SELECT id,owner FROM media_intake_jobs WHERE owner<>''").all().filter((row) => ownerAlive(row.owner)).map(({ id }) => id);
      const read = db.prepare("SELECT * FROM media_intake_jobs WHERE id=?");
      return [...new Set([...active.keys(), ...owned, ...waiting.map((entry) => entry.id), ...recent])]
        .map((id) => read.get(id)).filter(Boolean).map((row) => present(decodeJob(row), waiting));
    },
    detail: (id) => present(readJob(id)), start: pump, beginStop,
    async close() { beginStop(); await Promise.allSettled([...active.values()].map(({ promise }) => promise).concat([...pending])); }
  };

  function beginStop() { closing = true; clearTimeout(retryTimer); }
}
