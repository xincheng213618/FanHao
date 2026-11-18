import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { deriveWorkTraits } from "../../../../../lib/work-traits.js";
import { extractWorkCodes, workCodeKey } from "../../../../../lib/code-parser.js";
import { hasLocalWorkMarkerPrefix } from "../../../../../lib/local-work-marker.js";
import {
  VIDEO, assertFinished, checkedPath, collectIntakeFiles, identity, inside, intakeDetailUrl, intakeError, is4kOrHigher, lstat,
  nameForIntake, nameWithIntakeMarks, openIntakePath, pathKey, regular, same, sameIntakeFileContent, signature, stageIntakeFile, subtitleFiles,
  subtitleSuffix, videoMarkerName
} from "./intake-files.js";
import {
  assertNoIntakeConflict, assertUnindexed, catalogForIntake, cleanIntakeMetadata,
  commitIntakeCatalog, describeIntakeFile, indexIntakeSubtitle, indexedMarkFile, intakeCode, intakeLibraryFolder, intakeLibraryPartGroups, intakeNameCode,
  libraryFilesForLocal, metadataInfo, personIntakeTargets
} from "./intake-catalog.js";
import {
  classifyIntakeVideoAds, inspectIntakePackage, matchesIntakePackageFingerprint, packageSubtitles, packageSummary,
  removeIntakePackage, removeMigratedIntakePackage, requireIntakePackage, requireIntakePackageFolder, snapshotIntakeDirectory
} from "./intake-packages.js";
import { hasIdentityTable } from "../people/person-identity.js";
import { createSubtitlecatProvider } from "../playback/subtitlecat-provider.js";
import { writeSubtitleBesideVideo } from "../playback/subtitle-sidecars.js";
import { importedIntakeSubtitle, intakeSubtitleLanguage, isChineseSubtitleLanguage, MAX_INTAKE_SUBTITLE_BYTES, validateIntakeSubtitle } from "./intake-subtitles.js";

const ACTIONS = new Set(["replace", "keep", "new", "discard", "discardBoth", "discardLibraryVideo", "mark"]);
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
const oldFiles = (plan) => plan.old ? [plan.old, ...(plan.additionalOld || [])] : [];
const displacedSubtitles = (plan) => (plan.subtitleConflicts || []).filter(({ backup }) => backup)
  .map(({ target, targetSignature, backup }) => ({ path: target, signature: targetSignature, backup }));

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

function volumeCapacity(folder) {
  const { bsize, blocks } = fs.statfsSync(folder, { bigint: true });
  return bsize * blocks;
}

function volumeShare(folder) {
  if (process.platform !== "win32") return "";
  let resolved;
  try { resolved = fs.realpathSync.native(path.parse(folder).root); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return "";
    throw error;
  }
  return /^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.exec(resolved)?.[0] || "";
}

export function createMediaIntakeService({ getDb, sourceRoots, libraryRoots, relativeFromRoot,
  probeVideo, fetchMetadata, findLocalMetadata, searchRoots, classifyAds = async () => [], openPath = openIntakePath,
  onIndexChanged = () => {}, markFavorite = () => {}, targetDevice = volumeDevice, targetShare = volumeShare, resolveWork,
  targetCapacity = volumeCapacity,
  isWesternPath = () => false,
  subtitleProvider = createSubtitlecatProvider({ maxDownloadBytes: MAX_INTAKE_SUBTITLE_BYTES }), subtitleBackupRoot }) {
  const incomingRoots = sourceRoots.map((value) => path.resolve(value));
  const targetRoots = libraryRoots.map((value) => path.resolve(value));
  const metadata = new Map(), probes = new Map(), pending = new Set(), initialized = new WeakSet();
  const owner = `${process.pid}:${randomUUID()}`;
  const active = new Map();
  const completions = new Map();
  const subtitleSearches = new Map(), subtitleWrites = new Map(), subtitleCodeConfirmations = new Map();
  let closing = false, retryTimer, metadataLookup;

  function volumeLabel(folder) {
    if (!folder) return "";
    const root = targetRoots.filter((candidate) => inside(folder, candidate)).sort((a, b) => b.length - a.length)[0];
    return root || path.parse(folder).root;
  }

  function shareKey(folder) {
    const share = targetShare(folder);
    return share ? `smb:${share.toLowerCase()}` : "";
  }

  const deviceKey = (folder) => String(targetDevice(folder) || "");

  function withShareVolume(disk, volumes = new Map()) {
    if (!disk?.key?.startsWith("smb:") || disk.volume || !disk.label) return disk;
    const label = pathKey(disk.label);
    if (!volumes.has(label)) {
      let volume = null;
      try {
        const device = deviceKey(disk.label);
        const capacity = targetCapacity(disk.label);
        if (device && capacity > 0) volume = { device, capacity: String(capacity) };
      } catch { /* Keep unknown backing volumes in a shared lane. */ }
      volumes.set(label, volume);
    }
    return { ...disk, volume: volumes.get(label) };
  }

  function diskFor(plan) {
    if (!usesVolumeQueue(plan)) return null;
    return withShareVolume({ key: shareKey(plan.folder) || deviceKey(plan.folder), label: volumeLabel(plan.folder) });
  }

  function sameDisk(a, b) {
    if (!a || !b) return false;
    if (!a.key || !b.key) return true;
    const shared = a.key.startsWith("smb:");
    if (a.key === b.key) {
      // Require distinct device numbers and capacities before splitting a share. A device number alone can fluctuate on SMB.
      return !shared || !a.volume || !b.volume || pathKey(a.label) === pathKey(b.label)
        || a.volume.device === b.volume.device || a.volume.capacity === b.volume.capacity;
    }
    // Keep jobs with a legacy device key in the same lane as newer jobs on the same mapped drive.
    if (shared === b.key.startsWith("smb:")) return false;
    const drive = /^[a-z]:/i.exec(a.label || "")?.[0];
    return a.label === b.label || Boolean(drive && b.label?.toLowerCase().startsWith(drive.toLowerCase()));
  }

  function database() {
    const db = getDb();
    if (!initialized.has(db)) {
      db.exec(`CREATE TABLE IF NOT EXISTS media_intake_jobs (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, plan_json TEXT NOT NULL, result_json TEXT,
        error TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_intake_queue (
        sequence INTEGER PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES media_intake_jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS intake_video_playback_ids (
        local_work_id INTEGER NOT NULL REFERENCES local_works(id) ON DELETE CASCADE,
        work_id INTEGER NOT NULL, file_id TEXT NOT NULL, public_id TEXT NOT NULL,
        PRIMARY KEY (local_work_id, work_id, file_id)
      );
      CREATE INDEX IF NOT EXISTS media_intake_video_marker_jobs ON media_intake_jobs (
        json_extract(plan_json,'$.workId'), json_extract(plan_json,'$.correction.videoId'), created_at DESC
      ) WHERE json_extract(plan_json,'$.correction.videoId') IS NOT NULL`);
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

  function incomingPath(file) {
    const source = checkedPath(file, sourcePathRoots(file));
    if (!VIDEO.test(source)) throw intakeError("请选择视频文件", 400);
    if (targetRoots.some((root) => inside(source, root))) throw intakeError("馆藏盘内的文件请在作品详情操作", 400);
    return source;
  }

  function incoming(file, { missing = false } = {}) {
    const source = incomingPath(file);
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

  function isActiveSubtitleTemporary(file) {
    const key = pathKey(file);
    return [...subtitleWrites.values()].some((write) => write.temporaryKey === key);
  }

  async function selectedPackage(input, source, ignoreTemporaryFile) {
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
    const bundle = await inspectIntakePackage(folder, incomingRoots, classifyAds, ignoreTemporaryFile);
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

  function subtitleWorkFolders(code) {
    return database().prepare(`SELECT l.id AS localId,l.work_id AS workId,l.local_path AS folder,w.code
      FROM works w JOIN local_works l ON l.work_id=w.id
      WHERE w.code_search=? OR w.code=? COLLATE NOCASE`).all(workCodeKey(code), code)
      .filter(({ folder }) => typeof folder === "string" && path.isAbsolute(folder)
        && targetRoots.some((root) => inside(folder, root) && pathKey(folder) !== pathKey(root)));
  }

  function findLibrarySubtitleFiles(name, size) {
    const indexed = database().prepare(
      "SELECT file_path FROM local_files WHERE file_type='video' AND name=? COLLATE NOCASE AND size=?"
    ).all(name, size).map((row) => row.file_path);
    const code = intakeNameCode(path.parse(name).name);
    if (!code) return indexed;
    return indexed.concat(subtitleWorkFolders(code).map(({ folder }) => path.join(folder, name)));
  }

  async function scan(input = {}) {
    const subtitleMode = input.subtitleMode === true;
    const findIndexed = subtitleMode ? findLibrarySubtitleFiles : undefined;
    if (subtitleMode) assertSubtitlePath(input.path);
    const found = await collectIntakeFiles(input, input.path ? sourcePathRoots(input.path) : incomingRoots,
      { searchRoots, excludedRoots: targetRoots, findIndexed, excludePath: subtitleMode ? isWesternPath : undefined });
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
        if (subtitleMode && targetRoots.some((root) => inside(file, root))) {
          const checked = checkedPath(file, targetRoots);
          const source = input.locateReplacement === true && input.path && !lstat(checked)
            ? findMissingLibrarySubtitleVideo(checked) : checked;
          const stat = regular(source);
          const binding = librarySubtitleVideo(source);
          items.set(pathKey(source), { path: source, name: path.basename(source), size: stat.size,
            code: binding.code || intakeCode(source), library: true, indexed: binding.id != null });
          continue;
        }
        const origin = downloadOrigins.get(pathKey(file)) || matchingPackageParent(file);
        let bundle = null;
        if (origin) for (let dir = path.dirname(file); inside(dir, origin); dir = path.dirname(dir)) {
          if (packageCode(dir)) {
            const key = pathKey(dir);
            if (!packages.has(key)) packages.set(key, inspectIntakePackage(packageFolder(dir), incomingRoots, classifyAds, isActiveSubtitleTemporary));
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
        items.set(pathKey(source), { path: source, name: path.basename(source), size, code: bundle?.code || intakeCode(source),
          package: packageSummary(bundle) });
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

  function sourceMigration(source, code, stat) {
    if (!code) return null;
    const rows = database().prepare(`SELECT j.state,j.owner,j.plan_json,j.result_json,q.job_id AS queued
      FROM media_intake_jobs j LEFT JOIN media_intake_queue q ON q.job_id=j.id
      WHERE json_extract(j.plan_json,'$.code')=? COLLATE NOCASE
      AND json_extract(j.plan_json,'$.action') IN ('replace','keep','new')
      ORDER BY j.updated_at DESC`).all(code);
    for (const row of rows) {
      const plan = JSON.parse(row.plan_json);
      if (pathKey(plan.source) !== pathKey(source) || stat && !same(signature(stat), plan.sourceSignature)) continue;
      const result = JSON.parse(row.result_json);
      const target = result?.target;
      let targetVerified = false;
      if (target && plan.files[0]?.staged) {
        try {
          targetVerified = same(signature(regular(checkedPath(target, targetRoots))), plan.files[0].staged);
        }
        catch { /* The recorded target can be offline, moved, or changed. */ }
      }
      const state = row.queued ? "queued" : row.state === "working" && !ownerAlive(row.owner) ? "interrupted" : row.state;
      return { state, target: targetVerified ? target : "" };
    }
    return null;
  }

  async function compare(input = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const { phase } = input;
    const indexOnly = phase === "index", libraryOnly = phase === "library";
    if (phase !== undefined && !indexOnly && !libraryOnly && phase !== "source") throw intakeError("对照读取阶段无效", 400);
    const sourcePath = incomingPath(input.path);
    if (!libraryOnly && !lstat(sourcePath)) {
      const migration = sourceMigration(sourcePath, intakeCode(sourcePath, input.code), null);
      if (migration?.target) throw intakeError(`源视频已从原路径移除，已核实迁移目标：${migration.target}`, 409);
      throw intakeError("源视频不在原路径，未核实迁移目标。请检查文件是否已移动或改名。", 404);
    }
    const source = indexOnly || libraryOnly ? sourcePath : incoming(sourcePath);
    const bundle = indexOnly || libraryOnly ? null : await selectedPackage(input, source, isActiveSubtitleTemporary);
    signal?.throwIfAborted();
    const code = intakeCode(source, input.code || bundle?.code);
    const db = database();
    const catalog = catalogForIntake(db, code);
    const meta = currentMetadata(code, catalog);
    const actors = () => meta && !catalog.videos.length ? personIntakeTargets(db, meta.actors, targetRoots) : [];
    const sourceDetails = libraryOnly ? null : fileDetails(source, indexOnly ? null : await probe(source),
      bundle ? path.basename(bundle.folder) : "");
    signal?.throwIfAborted();
    if (!indexOnly && !libraryOnly) {
      const sides = bundle ? packageSubtitles(bundle).filter((item) => item.video === 0) : subtitleFiles(source, { exclusive: true });
      sourceDetails.subtitles = sides.map(({ file }) => path.basename(file));
      sourceDetails.migration = sourceMigration(source, code, regular(source));
    }
    if (phase === "source") return { source: sourceDetails, package: packageSummary(bundle), metadata: meta, actors: actors() };
    const candidates = catalog.videos.slice(0, 40);
    const groups = intakeLibraryPartGroups(catalog.videos);
    const indexedFiles = candidates.map((row) => ({ id: Number(row.id), workId: row.work.id, title: row.work.title, name: row.name,
      path: row.file_path, folder: row.folder, size: row.size, a: hasLocalWorkMarkerPrefix(path.basename(row.folder || "")),
      partIds: groups.get(Number(row.id)) }));
    const moreFiles = catalog.videos.length > indexedFiles.length;
    if (indexOnly) {
      const subtitleCodeConfirmation = input.confirmSubtitleCode === true && input.code && code && !isWesternPath(source)
        ? confirmSubtitleCode(incoming(source), code, sourceDetails.signature) : undefined;
      return { code, source: { ...sourceDetails, probePending: true }, works: catalog.works,
        files: indexedFiles.map((file) => ({ ...file, probePending: true })), moreFiles, metadata: meta, actors: [], subtitleCodeConfirmation };
    }
    const files = [];
    // Bounded batches avoid opening a stack of remote media simultaneously.
    for (let index = 0; index < indexedFiles.length; index += 4) {
      checkOpen();
      signal?.throwIfAborted();
      files.push(...await Promise.all(indexedFiles.slice(index, index + 4).map(async (base) => {
        try {
          const file = checkedPath(base.path, targetRoots);
          if (!libraryVideoStat(file)) {
            return { ...base, available: false, missing: true, labels: [], probe: null };
          }
          const measured = await probe(file);
          const details = fileDetails(file, measured, path.basename(base.folder || ""));
          let subtitles = [];
          try { subtitles = subtitleFiles(file, { exclusive: true }).map((sidecar) => path.basename(sidecar.file)); }
          catch { /* A directory listing failure does not invalidate the video. */ }
          return { ...base, ...details, subtitles, folder: base.folder, marks: filenameFlags(file), protected4k: is4kOrHigher(measured), available: true };
        } catch { return { ...base, available: false, labels: [], probe: null }; }
      })));
    }
    if (libraryOnly) return { files, moreFiles };
    return { code, source: sourceDetails, package: packageSummary(bundle), works: catalog.works, files, moreFiles, metadata: meta, actors: actors() };
  }

  async function readRemoteMetadata(code, key, detailUrl) {
    try {
      const raw = await fetchMetadata(code, detailUrl);
      if (raw?.accessBlocked === "login") {
        throw intakeError(detailUrl ? "这个详情页需要 JavDB 登录，后台会话当前不可用"
          : "JavDB 把后台搜索跳到了登录页，可以尝试粘贴详情页网址读取", 502);
      }
      if (raw?.accessBlocked === "blocked") throw intakeError("JavDB 限制了后台访问，请稍后重试", 502);
      if (detailUrl) {
        const status = raw?.upstreamStatus;
        if (Number.isInteger(status) && status >= 400 && status <= 599) {
          throw intakeError(`JavDB 详情页返回 HTTP ${status}，请确认网址或稍后重试`, 502);
        }
        const resolvedUrl = intakeDetailUrl(raw?.detailUrl);
        if (!raw?.code || !resolvedUrl) throw intakeError("详情页未读到作品番号，请检查网址或 115Chrome 登录状态", 422);
        if (workCodeKey(raw.code) !== key) throw intakeError(`详情页的番号与 ${code} 不一致`, 409);
        raw.detailUrl = resolvedUrl;
      } else if (!raw || workCodeKey(raw.code) !== key) {
        throw intakeError("115Chrome／JavDB 没有查到相同番号，可以粘贴详情页网址读取", 404);
      }
      const value = cleanIntakeMetadata(raw, "115Chrome / JavDB");
      if (!value.title || !value.actors.length) throw intakeError("查到了番号，但缺少标题或演员，暂无法自动归档");
      return value;
    } catch (error) {
      if (error.statusCode) throw error;
      if (detailUrl) throw intakeError("无法读取 JavDB 详情页，请检查网址、代理或 115Chrome 登录状态", 502);
      throw intakeError("115Chrome／JavDB 查询失败。请检查 115 登录、代理或浏览器配置后重试", 502);
    }
  }

  async function lookupMetadata(input = {}) {
    const source = incoming(input.path);
    const code = intakeCode(source, input.code);
    if (!code) throw intakeError("请先填写番号", 400);
    const detailUrl = intakeDetailUrl(input.detailUrl);
    if (input.detailUrl !== undefined && !detailUrl) throw intakeError("请粘贴 JavDB 作品详情页网址（javdb.com/v/…）", 400);
    const key = workCodeKey(code);
    if (metadataLookup) {
      if (metadataLookup.key === key && metadataLookup.detailUrl === detailUrl) return metadataLookup.promise;
      throw intakeError("115Chrome 正在读取资料，请稍后重试");
    }
    const promise = readRemoteMetadata(code, key, detailUrl).catch(async (error) => {
      if (detailUrl || !findLocalMetadata) throw error;
      const raw = await findLocalMetadata(code).catch(() => null);
      if (!raw || workCodeKey(raw.code) !== key) throw error;
      const value = cleanIntakeMetadata(raw, "LTX 本地目录");
      if (!value.title || !value.actors.length) throw error;
      return value;
    }).then((value) => {
      const actors = personIntakeTargets(database(), value.actors, targetRoots);
      bounded(metadata, key, { value, expiresAt: Date.now() + 30 * 60_000 }, 40);
      return { metadata: value, actors };
    }).finally(() => {
      metadataLookup = undefined;
    });
    metadataLookup = { key, detailUrl, promise };
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
    const volumes = new Map();
    return database().prepare(`SELECT j.id,j.plan_json FROM media_intake_queue q JOIN media_intake_jobs j ON j.id=q.job_id
      ORDER BY q.sequence`).all().map(({ id, plan_json }) => {
      const plan = JSON.parse(plan_json);
      return { id, disk: usesVolumeQueue(plan) ? withShareVolume(plan.disk, volumes) : null };
    });
  }

  function present(job, waiting = readQueue()) {
    const { plan } = job;
    const index = waiting.findIndex((entry) => entry.id === job.id);
    const position = index < 0 ? 0 : waiting.slice(0, index).filter((entry) => sameDisk(entry.disk, waiting[index].disk)).length + 1;
    const running = active.get(job.id);
    const live = position > 0 || Boolean(running) || ownerAlive(job.owner);
    const originals = oldFiles(plan);
    return { id: job.id, state: position ? "queued" : job.state === "working" && !live ? "interrupted" : job.state,
      active: live, position, progress: progressView(running?.progress), targetVolume: volumeLabel(plan.folder), action: plan.action, code: plan.code, source: plan.source, old: plan.old?.path || "",
      target: job.result?.target || plan.files[0]?.target || "", tags: plan.tags, result: job.result,
      oldPaths: plan.action === "replace" ? originals.map((old) => old.path) : undefined,
      workId: plan.action === "discardLibraryVideo" ? String(plan.workId) : undefined,
      missingSource: plan.missingSource || undefined,
      replaces4k: originals.some((old) => old.quality4k), oldQualityUnknown: originals.some((old) => old.qualityUnknown),
      items: plan.files.map((file) => ({ source: file.source, target: file.target, retainedSubtitle: file.retainedSubtitle })), package: packageSummary(plan.bundle),
      subtitleConflicts: plan.subtitleConflicts?.map(({ source, target, backup }) => ({
        source, target, disposition: backup ? "preserved" : "deduplicated", ...(backup ? { backup } : {})
      })),
      discardSubtitles: plan.action === "discard"
        ? (plan.bundle ? packageSubtitles(plan.bundle).map(({ file }) => file) : plan.discardSubtitles?.map(({ source }) => source)) : undefined,
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

  function sharesSourceIdentity(plan, other) {
    const reported = plan.sourceSignature?.slice(0, 2);
    if (!reported?.[1] || !same(reported, other.sourceSignature?.slice(0, 2))) return false;
    if (reported.every(Number.isSafeInteger)) return true;
    // Some NTFS file IDs differ only in bits that the Number stat loses.
    // Separate the plans only if both paths still prove their identity.
    const exactStat = (file) => {
      const roots = targetRoots.some(root => inside(file, root)) ? targetRoots : sourcePathRoots(file);
      return fs.lstatSync(checkedPath(file, roots), { bigint: true });
    };
    try {
      const current = exactStat(plan.source);
      const pending = exactStat(other.source);
      if (!current.isFile() || !pending.isFile()
          || !same(reported, [Number(current.dev), Number(current.ino)])
          || !same(reported, [Number(pending.dev), Number(pending.ino)])) return true;
      return current.dev === pending.dev && current.ino === pending.ino;
    } catch {
      return true;
    }
  }

  function assertSeparatePlans(plan, other) {
    const pathsFor = (value) => [value.source, ...oldFiles(value).map((old) => old.path), value.retained?.path, value.bundle?.folder,
      ...(value.discardSubtitles || []).map(({ source }) => source),
      ...(value.subtitleConflicts || []).flatMap(({ source, target, backup }) => [source, target, backup]),
      ...value.files.flatMap((item) => [item.source, item.target])].filter(Boolean).map(pathKey);
    const paths = pathsFor(plan), otherPaths = pathsFor(other);
    if (otherPaths.some((file) => paths.includes(file) || (plan.bundle && inside(file, pathKey(plan.bundle.folder))))
      || (other.bundle && paths.some((file) => inside(file, pathKey(other.bundle.folder)))) || sharesSourceIdentity(plan, other)) {
      throw intakeError("这个视频已在执行队列中");
    }
    if (plan.action !== "discard" && other.action !== "discard" && workCodeKey(other.code) === workCodeKey(plan.code)) {
      throw intakeError(`${plan.code} 已有任务在执行队列中，等它完成后再提交`);
    }
  }

  function assertNotPending(plan, jobId) {
    for (const write of subtitleWrites.values()) {
      try { assertSeparatePlans(plan, write); }
      catch { throw intakeError("该视频正在保存外挂字幕，请等字幕保存完成后重试"); }
    }
    const rows = database().prepare(`SELECT j.id,j.plan_json,j.owner,q.job_id AS queued FROM media_intake_jobs j
      LEFT JOIN media_intake_queue q ON q.job_id=j.id WHERE q.job_id IS NOT NULL OR j.owner<>''`).all();
    for (const row of rows) {
      if (row.id !== jobId && (row.queued || ownerAlive(row.owner))) assertSeparatePlans(plan, JSON.parse(row.plan_json));
    }
  }

  function indexedSubtitleVideo(source, { allowMissing = false } = {}) {
    const rows = database().prepare(`SELECT f.id,f.work_id AS workId,f.local_work_id AS localId,w.code
      FROM local_files f JOIN works w ON w.id=f.work_id
      WHERE f.file_type='video' AND lower(replace(f.file_path,char(92),'/'))=lower(?)`).all(source.replaceAll("\\", "/"));
    if (!rows.length && allowMissing) return null;
    if (rows.length !== 1 || rows[0].localId == null) throw intakeError("未找到唯一的馆藏视频记录", 404);
    return rows[0];
  }

  function librarySubtitleVideo(source) {
    assertSubtitlePath(source);
    if (!VIDEO.test(source)) throw intakeError("请选择视频文件", 400);
    const indexed = indexedSubtitleVideo(source, { allowMissing: true });
    if (indexed) return indexed;
    const code = intakeNameCode(path.parse(source).name);
    const folders = code ? subtitleWorkFolders(code).filter(({ folder }) => pathKey(folder) === pathKey(path.dirname(source))) : [];
    if (folders.length !== 1) throw intakeError("未找到唯一的馆藏视频记录", 404);
    assertUnindexed(database(), source);
    assertFinished(source);
    return { id: null, ...folders[0] };
  }

  function findMissingLibrarySubtitleVideo(missing) {
    const indexed = indexedSubtitleVideo(missing);
    const folder = path.dirname(missing);
    const binding = subtitleWorkFolders(indexed.code).find(({ localId }) => localId === indexed.localId);
    const unresolved = () => intakeError("馆藏记录指向的文件已不存在，请拖入要处理的视频或粘贴完整路径");
    if (!binding || pathKey(binding.folder) !== pathKey(folder) || !lstat(folder)?.isDirectory()) throw unresolved();
    const count = database().prepare("SELECT count(*) AS total FROM local_files WHERE local_work_id=? AND file_type='video'")
      .get(indexed.localId).total;
    if (count !== 1) throw unresolved();
    const key = workCodeKey(indexed.code);
    const matches = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) =>
      entry.isFile() && VIDEO.test(entry.name) && workCodeKey(intakeNameCode(path.parse(entry.name).name)) === key);
    if (matches.length !== 1) throw unresolved();
    const candidate = checkedPath(path.join(folder, matches[0].name), targetRoots);
    assertUnindexed(database(), candidate);
    return candidate;
  }

  function confirmSubtitleCode(source, code, sourceSignature) {
    assertSubtitlePath(source);
    requireSame(source, sourceSignature);
    const key = pathKey(source);
    const previous = subtitleCodeConfirmations.get(key);
    if (previous?.code === code && same(previous.sourceSignature, sourceSignature)) return previous.id;
    for (const write of subtitleWrites.values()) {
      if (pathKey(write.source) === key && write.code !== code) write.controller?.abort();
    }
    const id = randomUUID();
    bounded(subtitleCodeConfirmations, key, { id, code, sourceSignature }, 512);
    return id;
  }

  function subtitleTarget(input, { allowMissingCode = false, confirmIncomingCode = false } = {}) {
    assertSubtitlePath(input.path);
    const indexed = input.subtitleMode === true && typeof input.path === "string" && path.isAbsolute(input.path)
      && targetRoots.some((root) => inside(path.resolve(input.path), root));
    const source = indexed ? checkedPath(input.path, targetRoots) : incoming(input.path);
    const library = indexed ? librarySubtitleVideo(source) : null;
    const detected = library?.code || intakeCode(source);
    const code = input.code ? intakeCode(source, input.code) : detected;
    if (!code && !allowMissingCode) throw intakeError("请先确认视频番号", 400);
    const sourceSignature = signature(regular(source));
    const saved = library ? null : subtitleCodeConfirmations.get(pathKey(source));
    const current = saved && same(saved.sourceSignature, sourceSignature) ? saved : null;
    const confirmation = input.subtitleCodeConfirmation;
    const confirmed = Boolean(confirmation && current?.id === confirmation && current.code === code);
    if (confirmation && !confirmed) throw intakeError("视频或已确认的番号已改变，请重新确认番号", 409);
    if (!confirmed && !(confirmIncomingCode && !library) && detected && workCodeKey(detected) !== workCodeKey(code)) {
      throw intakeError("源视频番号与当前输入不一致，请重新核对", 422);
    }
    if (input.automatic === true && current && current.code !== code) throw intakeError("视频番号已经重新确认", 409);
    return { source, code, sourceSignature, library, confirmed, confirmation, action: "subtitle", files: [],
      key: JSON.stringify([pathKey(source), workCodeKey(code), sourceSignature]) };
  }

  function requireSubtitleSource(target) {
    const { source, library, sourceSignature, code, confirmation } = target;
    const file = library ? checkedPath(source, targetRoots) : incoming(source);
    assertSubtitlePath(file);
    requireSame(file, sourceSignature);
    if (!library) {
      const current = subtitleCodeConfirmations.get(pathKey(file));
      if ((confirmation && current?.id !== confirmation)
        || (current && same(current.sourceSignature, sourceSignature) && current.code !== code)) {
        throw intakeError("视频的已确认番号已改变，请重新确认番号", 409);
      }
    }
    if (library) {
      const current = librarySubtitleVideo(file);
      if (current.id !== library.id || current.workId !== library.workId || current.localId !== library.localId) {
        throw intakeError("馆藏索引已改变，请重新加入字幕工作台");
      }
    }
  }

  function subtitleSource(input = {}) {
    const confirmIncomingCode = input.confirmSubtitleCode === true && Boolean(input.code);
    const { source, code, sourceSignature, library } = subtitleTarget(input, { allowMissingCode: true, confirmIncomingCode });
    const subtitleCodeConfirmation = !library && confirmIncomingCode && code
      ? confirmSubtitleCode(source, code, sourceSignature) : undefined;
    return { code, subtitleCodeConfirmation, source: { path: source, name: path.basename(source),
      subtitles: subtitleFiles(source, { exclusive: true }).map(({ file }) => path.basename(file)) } };
  }

  function subtitleChoice(target, resultId) {
    const selection = subtitleSearches.get(target.key);
    const result = selection?.expires > Date.now() && selection.results.get(resultId);
    if (!result) throw intakeError("请为当前视频重新搜索并选择字幕", 409);
    return result;
  }

  async function subtitleSearch(input = {}, { signal } = {}) {
    const target = subtitleTarget(input);
    const search = await subtitleProvider.search(target.code, { signal });
    const codeKey = workCodeKey(target.code);
    const results = search.results.filter((result) => extractWorkCodes(result.title).some((code) => workCodeKey(code) === codeKey));
    bounded(subtitleSearches, target.key, { expires: Date.now() + 5 * 60_000,
      results: new Map(results.map((result) => [result.id, { files: new Set() }])) }, 40);
    return { results };
  }

  async function subtitleLanguageFiles(input = {}, { signal } = {}) {
    const target = subtitleTarget(input);
    const result = subtitleChoice(target, input.resultId);
    const listing = await subtitleProvider.files(input.resultId, { signal });
    const files = listing.files.filter((file) => isChineseSubtitleLanguage(file.languageCode || file.language));
    result.files = new Set(files.map((file) => file.id));
    return { files };
  }

  function hasSourceSubtitle(source) {
    return filenameFlags(source).subtitled || subtitleFiles(source, { exclusive: true, legacy: true })
      .some(({ file }) => !/\.(?:en|eng|ja|jpn)\.(?:srt|ass|ssa|vtt)$/i.test(file));
  }

  async function saveSourceSubtitle(target, file, signal, { automatic = false, copySource } = {}) {
    const { source, code, sourceSignature, key, library } = target;
    // Use the checked source selected in the workbench even after an online request.
    const bundle = library ? null : await selectedPackage({}, incoming(source));
    const measured = await probe(source);
    signal?.throwIfAborted();
    const language = file.languageCode || file.language;
    validateIntakeSubtitle({ ...file, language }, {
      code, confirmed: target.confirmed || Boolean(library), videoName: path.basename(source), duration: measured?.duration
    });
    checkOpen();
    requireSubtitleSource(target);
    assertNoIntakeConflict(database(), source, library?.workId || 0);
    const controller = library ? null : new AbortController();
    const write = { ...target, controller, bundle: copySource?.bundle || bundle };
    if (copySource) {
      requireSubtitleSource(copySource.video);
      requireSame(checkedPath(copySource.sidecar, sourcePathRoots(copySource.video.source)), copySource.sidecarSignature);
      assertNoIntakeConflict(database(), copySource.video.source, 0);
      write.files = [{ source: copySource.video.source }, { source: copySource.sidecar }];
    }
    assertNotPending(write);
    if (automatic && hasSourceSubtitle(source)) return { available: false, reason: "existing-subtitle" };
    subtitleWrites.set(key, write);
    try {
      const roots = library ? targetRoots : sourcePathRoots(source);
      const writeSignal = controller ? AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]) : signal;
      const result = await writeSubtitleBesideVideo({ path: source, size: sourceSignature[2] }, file.bytes,
        { language, name: file.name, roots, signal: writeSignal, onTemporaryFile: (file) => { write.temporaryKey = pathKey(file); } });
      if (library) {
        requireSubtitleSource(target);
        if (library.id != null && indexIntakeSubtitle(database(), library, checkedPath(result.path, roots), relativeFromRoot)) onIndexChanged();
      } else if (automatic && result.created) {
        result.signature = signature(regular(checkedPath(result.path, roots)));
      }
      return result;
    } finally { subtitleWrites.delete(key); }
  }

  async function subtitleDownload(input = {}, { signal } = {}) {
    const target = subtitleTarget(input);
    if (!subtitleChoice(target, input.resultId).files.has(input.fileId)) throw intakeError("请选择当前结果中的中文字幕", 400);
    const file = await subtitleProvider.download(input.resultId, input.fileId, { signal });
    return saveSourceSubtitle(target, file, signal);
  }

  async function subtitleDownloadDirect(input = {}, { signal } = {}) {
    const target = subtitleTarget(input);
    const automatic = input.automatic === true;
    if (automatic && hasSourceSubtitle(target.source)) {
      return { available: false, reason: "existing-subtitle" };
    }
    const checkCatalogFile = automatic && !sourceIsLtx(target.source, path.dirname(target.source));
    const entry = await findLocalMetadata?.(target.code, checkCatalogFile
      ? { name: path.basename(target.source), size: target.sourceSignature[2] } : undefined).catch(() => null);
    signal?.throwIfAborted();
    if (!entry?.subtitleUrl || workCodeKey(entry.code) !== workCodeKey(target.code)) {
      return { available: false, reason: "no-direct-link" };
    }
    if (checkCatalogFile && !entry.matchesFile) return { available: false, reason: "different-version" };
    let file;
    try {
      file = await subtitleProvider.downloadDirect(entry.subtitleUrl, { signal });
    } catch (error) {
      if (!automatic || !error.retryable || error.code === "SUBTITLECAT_RATE_LIMIT") throw error;
      await delay(800, undefined, { signal });
      if (hasSourceSubtitle(target.source)) return { available: false, reason: "existing-subtitle" };
      file = await subtitleProvider.downloadDirect(entry.subtitleUrl, { signal });
    }
    return saveSourceSubtitle(target, file, signal, { automatic });
  }

  function subtitleImport(input = {}, { signal } = {}) {
    return saveSourceSubtitle(subtitleTarget(input), importedIntakeSubtitle(input), signal);
  }

  async function subtitleCopy(input = {}, { signal } = {}) {
    const video = subtitleTarget({ path: input.path, code: input.code, subtitleCodeConfirmation: input.subtitleCodeConfirmation });
    const { selected, oldPath, oldSignature } = targetForExisting(catalogForIntake(database(), video.code), input, "subtitle-copy");
    if (!same(video.sourceSignature, input.sourceSignature) || !same(oldSignature, input.oldSignature)) {
      throw intakeError("待迁移或馆藏视频已改变，请重新对照");
    }
    const target = subtitleTarget({ path: oldPath, code: video.code, subtitleMode: true });
    if (target.library.id !== selected.id || !same(target.sourceSignature, oldSignature)) {
      throw intakeError("馆藏视频已改变，请重新对照");
    }
    const bundle = await selectedPackage(input, video.source, isActiveSubtitleTemporary);
    const candidates = bundle ? packageSubtitles(bundle).filter(({ video }) => video === 0) : subtitleFiles(video.source, { exclusive: true });
    const matches = candidates.filter(({ file }) => path.basename(file) === input.name && /\.srt$/i.test(file));
    if (matches.length !== 1) throw intakeError("未找到唯一的源 SRT 字幕，请重新匹配", 404);
    const sidecar = checkedPath(matches[0].file, sourcePathRoots(video.source));
    const sidecarSignature = signature(regular(sidecar));
    const size = sidecarSignature[2];
    if (size < 1 || size > MAX_INTAKE_SUBTITLE_BYTES) throw intakeError("请选择不超过 2 MiB 的中文字幕 SRT", 422);
    const handle = await fs.promises.open(sidecar, "r");
    let bytes;
    try {
      if (!same(signature(await handle.stat()), sidecarSignature)) throw intakeError("源字幕已改变，请重新核对");
      bytes = Buffer.alloc(size);
      let position = 0;
      while (position < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, position, size - position, position);
        if (!bytesRead) throw intakeError("源字幕读取不完整，请重新核对");
        position += bytesRead;
      }
    } finally { await handle.close(); }
    return saveSourceSubtitle(target, { name: input.name, bytes, language: intakeSubtitleLanguage(input.name) }, signal,
      { copySource: { video, sidecar, sidecarSignature, bundle } });
  }

  async function subtitleRemove(input = {}, { signal } = {}) {
    const target = subtitleTarget(input);
    const { source, key, library } = target;
    const roots = library ? targetRoots : sourcePathRoots(source);
    const sidecar = subtitleFiles(source, { exclusive: true }).find(({ file }) => path.basename(file) === input.name);
    if (!sidecar) throw intakeError("未找到这份源视频的外挂字幕，请重新匹配", 404);
    if (!subtitleBackupRoot) throw intakeError("字幕备份目录不可用", 503);
    const file = checkedPath(sidecar.file, roots);
    const original = signature(regular(file));
    const bundle = library ? null : await selectedPackage({}, incoming(source));
    requireSubtitleSource(target);
    assertNoIntakeConflict(database(), source, library?.workId || 0);
    if (library) indexedMarkFile(database(), file, library.localId, "info");
    else assertUnindexed(database(), file);
    const write = { ...target, bundle, files: [{ source: file }] };
    assertNotPending(write);
    subtitleWrites.set(key, write);
    try {
      const backupDir = path.join(subtitleBackupRoot, randomUUID());
      await fs.promises.mkdir(backupDir, { recursive: true });
      const backup = path.join(backupDir, path.basename(file));
      requireSame(file, original);
      await fs.promises.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
      const checksum = async (value) => {
        const digest = createHash("sha256");
        for await (const chunk of fs.createReadStream(value, { signal })) digest.update(chunk);
        return digest.digest("hex");
      };
      const [before, after] = await Promise.all([checksum(file), checksum(backup)]);
      if (before !== after) throw intakeError("字幕备份校验失败，原文件已保留");
      signal?.throwIfAborted();
      checkOpen();
      requireSubtitleSource(target);
      if (library) {
        const db = database();
        db.exec("BEGIN IMMEDIATE");
        let removed = false;
        try {
          const indexed = indexedMarkFile(db, file, library.localId, "info");
          if (indexed) db.prepare("DELETE FROM local_files WHERE id=?").run(indexed.id);
          removeOwned(file, original, roots);
          removed = true;
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          if (removed) fs.copyFileSync(backup, file, fs.constants.COPYFILE_EXCL);
          throw error;
        }
        onIndexChanged();
      } else {
        assertUnindexed(database(), file);
        removeOwned(file, original, roots);
      }
      return { name: path.basename(file), backupPath: backup };
    } finally { subtitleWrites.delete(key); }
  }

  function assertSubtitlesPlanned(plan) {
    if (!usesVolumeQueue(plan)) return;
    const listed = new Set([...plan.files.filter((item) => item.type === "info" && item.source), ...(plan.subtitleConflicts || [])]
      .map(({ source }) => pathKey(source)));
    for (const { source } of plan.files.filter((item) => item.type === "video")) {
      if (subtitleFiles(source, { exclusive: true }).some(({ file }) => !listed.has(pathKey(file)))) {
        throw intakeError("源视频增加了外挂字幕，请返回核对并重新提交，让字幕一起迁移");
      }
    }
  }

  function save(job, { db = database(), releaseOwner = false } = {}) {
    job.updatedAt = stamp();
    const values = [job.state, JSON.stringify(job.plan), job.result ? JSON.stringify(job.result) : null, job.error || "", job.updatedAt, job.id];
    if (releaseOwner) {
      db.prepare(`UPDATE media_intake_jobs SET state=?,plan_json=?,result_json=?,error=?,updated_at=?,owner=''
        WHERE id=? AND owner=?`).run(...values, owner);
    } else db.prepare("UPDATE media_intake_jobs SET state=?,plan_json=?,result_json=?,error=?,updated_at=? WHERE id=?").run(...values);
  }

  function targetForExisting(catalog, input, action) {
    const selected = catalog.videos.find((row) => Number(row.id) === Number(input.oldId));
    if (!selected) throw intakeError("请选择需要对照的馆藏视频", 400);
    return targetForIndexedVideo(selected, action);
  }

  function targetForIndexedVideo(selected, action) {
    const oldPath = checkedPath(selected.file_path, targetRoots);
    const indexedPath = checkedPath(selected.folder, targetRoots);
    const flat = pathKey(indexedPath) === pathKey(oldPath);
    const parent = intakeLibraryFolder(selected);
    if (!parent || (flat && action !== "replace")) throw intakeError("视频和作品文件夹的索引不一致");
    const folder = checkedPath(parent, targetRoots);
    const stat = regular(oldPath);
    assertVideoOwner(oldPath, selected.id);
    if (stat.nlink !== 1 || stat.size !== selected.size) throw intakeError("馆藏视频的身份或索引归属已变，请先刷新馆藏");
    if (action !== "keep" && !selected.file_id) throw intakeError("馆藏视频缺少索引身份");
    return { selected, folder, flat, oldPath, oldSignature: signature(stat) };
  }

  function assertVideoOwner(file, id) {
    const owners = database().prepare("SELECT id FROM local_files WHERE lower(replace(file_path,char(92),'/'))=lower(?)").all(file.replaceAll("\\", "/"));
    if (owners.length !== 1 || owners[0].id !== id) throw intakeError("馆藏视频的身份或索引归属已变，请先刷新馆藏");
  }

  function libraryVideoStat(source) {
    const stat = lstat(checkedPath(source, targetRoots));
    if (stat) {
      if (!stat.isFile()) throw intakeError("所选路径已变成链接或其他类型，馆藏记录已保留");
      return stat;
    }
    const parent = checkedPath(path.dirname(source), targetRoots);
    let names;
    try { names = fs.readdirSync(parent); }
    catch { throw intakeError("无法读取视频所在目录，馆藏记录已保留"); }
    if (names.some((name) => pathKey(path.join(parent, name)) === pathKey(source))) {
      throw intakeError("无法确认视频是否缺失，馆藏记录已保留");
    }
    return null;
  }

  function verifyLibraryVideoDiscard(plan) {
    const { source, folder, localId, workId, bindings } = plan;
    const db = database();
    assertNoIntakeConflict(db, folder, workId);
    const local = db.prepare("SELECT work_id,local_path FROM local_works WHERE id=?").get(localId);
    if (local?.work_id !== workId || !same(identity(lstat(checkedPath(folder, targetRoots))), plan.folderIdentity)
      || pathKey(local.local_path) !== pathKey(folder)) throw intakeError("馆藏文件夹已改变，请重新选择视频");
    const rows = libraryFilesForLocal(db, localId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (rows.length !== bindings.length || bindings.some(({ id, fileId, file }) => {
      const row = byId.get(id);
      return row?.file_id !== fileId || pathKey(row.file_path) !== pathKey(file);
    })) throw intakeError("馆藏文件列表已改变，请重新选择视频");
    assertVideoOwner(source, plan.videoRowId);
    assertFinished(source);
    if (!bindings.some(({ file }) => {
      if (pathKey(file) === pathKey(source)) return false;
      try { return regular(checkedPath(file, targetRoots)).size > 0; }
      catch { return false; }
    })) throw intakeError("作品必须至少保留一份可读取的馆藏视频");
  }

  function prepareLibraryVideoDiscard(input) {
    if (!resolveWork) throw intakeError("单文件删除不可用", 503);
    const work = resolveWork(input.workId);
    const video = work?.videos?.find((item) => String(item.id) === input.videoId);
    const source = checkedPath(input.path, targetRoots);
    if (!video || typeof input.modifiedAt !== "string" || (video.modifiedAt || "") !== input.modifiedAt
      || !Number.isSafeInteger(input.size) || video.size !== input.size || pathKey(video.path) !== pathKey(source)) {
      throw intakeError("所选馆藏视频已改变，请重新选择");
    }
    const stat = libraryVideoStat(source);
    if (stat) {
      const indexedMtime = video.modifiedAt ? Date.parse(video.modifiedAt) : stat.mtimeMs;
      if (stat.nlink !== 1 || stat.size !== video.size || !(Math.abs(stat.mtimeMs - indexedMtime) < 2)) {
        throw intakeError("馆藏视频的身份或大小已改变，请先刷新馆藏");
      }
    }
    const { id: videoRowId, workId, localId, code } = indexedSubtitleVideo(source);
    if (String(workId) !== String(work.id)) throw intakeError("视频已不属于所选作品");
    const db = database();
    const local = db.prepare("SELECT local_path FROM local_works WHERE id=? AND work_id=?").get(localId, workId);
    if (!local) throw intakeError("未找到馆藏目录");
    const folder = checkedPath(local.local_path, targetRoots);
    if (!inside(source, folder) || pathKey(source) === pathKey(folder)) throw intakeError("视频不在登记的馆藏目录内");
    const indexed = new Map(libraryFilesForLocal(db, localId).map((row) => [pathKey(row.file_path), row]));
    const bindings = work.videos.map((item) => {
      const row = indexed.get(pathKey(item.path));
      if (!row?.file_id || !item.id) throw intakeError("馆藏文件缺少索引身份，请先刷新馆藏");
      return { id: row.id, fileId: row.file_id, file: row.file_path, publicId: String(item.id) };
    });
    const id = randomUUID();
    const plan = { action: "discardLibraryVideo", source, sourceSignature: signature(stat), missingSource: !stat, videoRowId, workId, localId, code,
      folder, folderIdentity: identity(lstat(folder)), bindings, files: [], tags: {},
      sourceTrash: path.join(path.dirname(source), `.fh-${id}.discard`) };
    verifyLibraryVideoDiscard(plan);
    return registerPlan(id, plan, stamp());
  }

  async function planSubtitleConflict(db, plan, subtitle, target, jobId) {
    if (plan.action !== "replace") throw intakeError("目标有同名字幕，请先核对字幕再迁移");
    const owners = oldFiles(plan).filter(({ path: file }) => pathKey(path.dirname(file)) === pathKey(path.dirname(target))
      && subtitleSuffix(path.basename(target), path.basename(file), true));
    if (owners.length !== 1) throw intakeError("目标有同名字幕，请先核对字幕再迁移");
    assertSubtitleConflictUnshared(plan, target);
    const row = indexedMarkFile(db, target, plan.localId, "info");
    const previous = regular(target);
    if (previous.nlink !== 1) throw intakeError("馆藏字幕已有多个硬链接，请先核对归属");
    const sourceSignature = subtitle.signature || signature(regular(subtitle.file));
    const targetSignature = signature(previous);
    const conflict = { source: subtitle.file, target, sourceSignature, targetSignature, indexId: row?.id ?? null, fileId: row?.file_id ?? null };
    if (await sameIntakeFileContent(conflict.source, target, { leftSignature: sourceSignature, rightSignature: targetSignature })) return conflict;
    const earlier = plan.subtitleConflicts || [];
    const reserved = new Set(earlier.filter((item) => item.backup).map((item) => pathKey(item.backup)));
    const pathTooLong = (file) => process.platform === "win32" && (file.length >= 260 || path.basename(file).length > 255);
    const compact = path.join(plan.folder, `.fh-${jobId.slice(0, 8)}-sub${earlier.length + 1}`);
    for (let index = 1; index <= 100; index++) {
      const suffix = `.library-backup${index === 1 ? "" : `.${index}`}`;
      const readable = target + suffix;
      const backup = checkedPath(pathTooLong(readable) ? compact + suffix : readable, targetRoots);
      if (pathTooLong(backup)) throw intakeError("备份馆藏字幕的路径过长，请先缩短作品文件夹名");
      if (lstat(backup) || reserved.has(pathKey(backup))) continue;
      assertUnindexed(db, backup);
      return { ...conflict, backup };
    }
    throw intakeError("馆藏字幕的备份名已用完，请先核对已有备份");
  }

  function assertSubtitleConflictUnshared(plan, target) {
    const replaced = new Set(oldFiles(plan).map((old) => pathKey(old.path)));
    if (fs.readdirSync(plan.folder).some((name) => VIDEO.test(name) && subtitleSuffix(path.basename(target), name, true)
      && !replaced.has(pathKey(path.join(plan.folder, name))))) {
      throw intakeError("目标同名字幕仍有其他馆藏视频使用，请先核对字幕");
    }
  }

  async function prepare(input = {}) {
    const action = input.action;
    if (!ACTIONS.has(action)) throw intakeError("请选择处理方式", 400);
    if (action === "discardLibraryVideo") return prepareLibraryVideoDiscard(input);
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
      const mediaOnly = Boolean(usesVolumeQueue(plan) && input.packageMediaFingerprint);
      const expected = mediaOnly ? input.packageMediaFingerprint : input.packageFingerprint;
      if (expected && !matchesIntakePackageFingerprint(bundle, expected, { mediaOnly, source, subtitle: input.automaticSubtitle })) {
        throw intakeError(mediaOnly ? "下载包的正片或字幕已改变，请重新核对" : "下载包内容已改变，请重新对照后确认");
      }
      assertPackageUnindexed(bundle.folder);
      bundle.quarantine = checkedPath(path.join(path.dirname(bundle.folder), `.fh-${id}.discard`), incomingRoots);
      plan.bundle = bundle;
    }
    if (action === "discard" && !bundle) {
      const roots = sourcePathRoots(source);
      plan.discardSubtitles = subtitleFiles(source, { exclusive: true }).map(({ file }) => {
        const sidecar = checkedPath(file, roots);
        assertUnindexed(database(), sidecar);
        return { source: sidecar, signature: signature(regular(sidecar)) };
      });
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
        if (!plan.meta) throw intakeError("请先查询标题和人物资料，可用 115Chrome 搜索或粘贴详情页网址");
        const options = personIntakeTargets(db, plan.meta.actors, targetRoots);
        plan.actor = options.find((item) => item.folder === input.actorFolder && item.name === input.actorName) || (options.length === 1 ? options[0] : null);
        if (!plan.actor) throw intakeError("请选择要归档的人物目录", 400);
        plan.actorIdentity = identity(lstat(plan.actor.folder));
        plan.workId = catalog.works[0]?.id || null;
        const base = nameForIntake(plan.actor.folder, code, plan.meta.title, {}, ".mp4").slice(0, -4);
        plan.folder = checkedPath(path.join(plan.actor.folder, `${plan.tags.a ? "[A]." : ""}${base.slice(0, 115)}`), targetRoots);
        if (lstat(plan.folder)) throw intakeError("目标作品目录已存在，请先核对该目录");
      } else {
        const { selected, folder, flat, oldPath, oldSignature } = targetForExisting(catalog, input, action);
        plan.folder = folder; plan.workId = selected.work.id; plan.localId = Number(selected.local_work_id); plan.meta = selected.work;
        plan.folderIdentity = identity(lstat(folder));
        if (input.oldSignature && !same(oldSignature, input.oldSignature)) throw intakeError("馆藏视频已改变，请重新对照");
        if (action === "replace") {
          const partIds = intakeLibraryPartGroups(catalog.videos).get(Number(selected.id));
          const parts = input.oldParts;
          if (partIds ? !Array.isArray(parts) || !same(partIds, parts.map((part) => part?.id)) : parts !== undefined) {
            throw intakeError("馆藏分段已改变，请重新匹配后确认整组替换");
          }
          const originals = [];
          for (const [index, oldId] of (partIds || [Number(selected.id)]).entries()) {
            const entry = oldId === selected.id ? { selected, oldPath, oldSignature } : targetForExisting(catalog, { oldId }, action);
            if (parts && !same(entry.oldSignature, parts[index].signature)) throw intakeError("馆藏分段已改变，请重新核对");
            const oldProbe = await probe(entry.oldPath);
            originals.push({ id: oldId, localId: entry.selected.local_work_id, path: entry.oldPath,
              dbPath: entry.selected.file_path, fileId: entry.selected.file_id,
              signature: entry.oldSignature, quality4k: is4kOrHigher(oldProbe), qualityUnknown: !oldProbe });
          }
          [plan.old] = originals;
          if (originals.length > 1) plan.additionalOld = originals.slice(1);
        } else plan.retained = { id: Number(selected.id), path: oldPath, fileId: selected.file_id, signature: oldSignature };
        if (flat) {
          plan.localId = plan.old.localId;
          plan.flatReplacement = { parent: folder, parentIdentity: plan.folderIdentity };
          const base = nameForIntake(folder, code, plan.meta.title, {}, ".mp4").slice(0, -4);
          plan.folder = checkedPath(path.join(folder, `${plan.tags.a ? "[A]." : ""}${base.slice(0, 115)}`), targetRoots);
          plan.folderIdentity = null;
          assertFlatReplacementFolderFree(db, plan.folder);
        } else if (plan.tags.a && !hasLocalWorkMarkerPrefix(path.basename(folder))) {
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
        const old = oldFiles(plan).find((file) => pathKey(file.path) === pathKey(target));
        if (lstat(target) && !old) throw intakeError("目标文件已存在，请选择不同的版本标签");
        if (old) old.backup = path.join(plan.folder, old === plan.old ? `.fh-${id}.old` : `.fh-${id}-${old.id}.old`);
        plan.files.push({ type: "video", source: video, target, sourceSignature: entry.signature, probe: videoProbe });
      }
      const target = plan.files[0].target;
      const sides = bundle ? packageSubtitles(bundle) : subtitleFiles(source, { exclusive: true }).map((side) => ({ ...side, video: 0 }));
      const subtitleTargets = new Set(plan.files.map((item) => pathKey(item.target)));
      for (const side of sides) {
        checkedPath(side.file, sourcePathRoots(source));
        assertUnindexed(db, side.file);
        const video = plan.files[side.video];
        const destination = checkedPath(path.join(plan.folder, path.parse(video.target).name + side.suffix), targetRoots);
        if (process.platform === "win32" && destination.length >= 260) throw intakeError("配套字幕的目标路径过长，请先缩短字幕后缀");
        const key = pathKey(destination);
        if (subtitleTargets.has(key)) throw intakeError("目标有同名字幕，请先核对字幕再迁移");
        subtitleTargets.add(key);
        if (lstat(destination)) {
          const conflict = await planSubtitleConflict(db, plan, side, destination, id);
          (plan.subtitleConflicts ||= []).push(conflict);
          if (!conflict.backup) continue;
        }
        plan.files.push({ type: "info", source: side.file, target: destination, sourceSignature: side.signature || signature(regular(side.file)) });
      }
      if (plan.old && !plan.additionalOld && sources.length === 1) {
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
      assertNoIntakeConflict(db, plan.folder, plan.workId);
    }
    return registerPlan(id, plan, createdAt);
  }

  function prepareMark(input) {
    const db = database();
    const code = intakeCode("", input.code);
    const target = targetForExisting(catalogForIntake(db, code), input, "mark");
    if (!same(target.oldSignature, input.oldSignature)) throw intakeError("馆藏视频已改变，请重新对照");
    const name = nameWithIntakeMarks(target.oldPath, input.tags || {}, filenameFlags(target.oldPath));
    return prepareMarkPlan(target, code, name);
  }

  function prepareMarkPlan({ selected, folder, oldPath, oldSignature }, code, name, correction = null) {
    const db = database();
    const newStem = path.parse(name).name;
    const localId = Number(selected.local_work_id), workId = Number(selected.work.id);
    const subtitles = subtitleFiles(oldPath);
    const oldStem = path.parse(oldPath).name.toLowerCase();
    if (subtitles.length && fs.readdirSync(folder).some((file) => VIDEO.test(file) && file.toLowerCase() !== path.basename(oldPath).toLowerCase()
        && path.parse(file).name.toLowerCase() === oldStem)) throw intakeError("这份外挂字幕与其他视频共用，请先核对字幕");
    if (correction && subtitles.length !== subtitleFiles(oldPath, { exclusive: true }).length) {
      throw intakeError("这份外挂字幕与其他视频共用，请先核对字幕");
    }
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
      localId, workId, old, files, tags: correction?.tags || {}, ...(correction ? { correction } : {}) }, stamp());
  }

  function resolveMarkerVideo(workId, videoId) {
    const work = resolveWork?.(workId);
    const video = work?.videos?.find((item) => String(item.id) === videoId);
    if (!video || work.missingLocal) throw intakeError("找不到要订正标签的本地视频", 404);
    return { work, video };
  }

  function readVideoMarkers(workId, videoId) {
    const { video } = resolveMarkerVideo(workId, videoId);
    const source = checkedPath(video.path, targetRoots);
    return { videoId, ...videoMarkerName(path.basename(source)) };
  }

  function readVideoMarkerJob(workId, jobId) {
    const job = readJob(jobId);
    if (!job.plan.correction || String(job.plan.workId) !== workId) throw intakeError("标签订正任务不存在", 404);
    const { id, state, active, error } = present(job);
    return { job: { id, state, active, error } };
  }

  function reusableVideoMarkerJob(job, correction, source) {
    const previous = job.plan.correction;
    if (previous.name !== correction.name || Object.keys(correction.tags).some((key) => previous.tags[key] !== correction.tags[key])) return false;
    if (active.has(job.id) || ownerAlive(job.owner)) return true;
    const oldPath = pathKey(job.plan.source) === pathKey(source);
    const targetPath = pathKey(job.plan.files[0].target) === pathKey(source);
    if (job.state === "completed") return targetPath;
    if (job.state === "committed") return oldPath || targetPath;
    return ["prepared", "working", "blocked"].includes(job.state) && oldPath
      && same(job.plan.sourceSignature, signature(lstat(source)));
  }

  function correctVideoMarkers(workId, input) {
    checkOpen();
    const { videoId, name, tags } = input || {};
    if (typeof videoId !== "string" || !videoId || typeof name !== "string" || !name || /[\\/\u0000]/.test(name)
      || !tags || Object.keys(tags).length !== 3 || [tags.ltx, tags.c, tags.u].some((value) => typeof value !== "boolean")) {
      throw intakeError("请选择视频并提交完整的 LTX、C、U 标签", 400);
    }
    const { work, video } = resolveMarkerVideo(workId, videoId);
    const source = checkedPath(video.path, targetRoots);
    const currentName = path.basename(source);
    const wanted = videoMarkerName(name, tags);
    const db = database();
    const correction = { videoId, name, tags: { ltx: tags.ltx, c: tags.c, u: tags.u } };
    const priorRow = db.prepare(`SELECT * FROM media_intake_jobs
      WHERE json_extract(plan_json,'$.workId')=? AND json_extract(plan_json,'$.correction.videoId')=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(Number(work.id), videoId);
    if (priorRow) {
      const prior = decodeJob(priorRow);
      if (reusableVideoMarkerJob(prior, correction, source)) {
        run(prior.id);
        return { videoId, ...wanted, changed: true, ...readVideoMarkerJob(workId, prior.id) };
      }
    }
    if (currentName !== name) throw intakeError("馆藏视频文件名已改变，请重新读取标签");
    if (wanted.name === name) return { videoId, ...wanted, changed: false };
    const selected = db.prepare(`SELECT f.*,l.local_path AS folder FROM local_files f
      JOIN local_works l ON l.id=f.local_work_id AND l.work_id=f.work_id
      WHERE f.work_id=? AND f.file_type='video' AND lower(replace(f.file_path,char(92),'/'))=lower(?)`)
      .get(Number(work.id), source.replaceAll("\\", "/"));
    if (!selected) throw intakeError("找不到馆藏视频所属目录", 404);
    const target = targetForIndexedVideo({ ...selected, work }, "mark");
    assertFinished(target.oldPath);
    if (video.modifiedAt && !(Math.abs(target.oldSignature[3] - Date.parse(video.modifiedAt)) < 2)) {
      throw intakeError("馆藏视频的索引时间已改变，请先刷新馆藏");
    }
    const code = db.prepare("SELECT code FROM works WHERE id=?").get(selected.work_id)?.code || "";
    const job = prepareMarkPlan(target, code, wanted.name, correction);
    run(job.id);
    return { videoId, ...wanted, changed: true, ...readVideoMarkerJob(workId, job.id) };
  }

  function registerPlan(id, plan, createdAt) {
    checkOpen();
    if (!plan.missingSource) requireSame(plan.source, plan.sourceSignature);
    assertNotPending(plan, id);
    database().prepare("INSERT INTO media_intake_jobs (id,state,plan_json,created_at,updated_at) VALUES (?,'prepared',?,?,?)")
      .run(id, JSON.stringify(plan), createdAt, createdAt);
    return present(readJob(id));
  }

  function requireSame(file, expected) {
    if (!same(signature(regular(file)), expected)) throw intakeError("文件身份已改变，请重新核对");
  }

  function assertFlatReplacementFolderFree(db, folder, { created = false } = {}) {
    if ((!created && lstat(folder)) || db.prepare("SELECT 1 FROM local_works WHERE lower(replace(local_path,char(92),'/'))=lower(?)")
      .get(folder.replaceAll("\\", "/"))) throw intakeError("目标作品目录已存在或已有馆藏记录，请先核对该目录");
  }

  function revalidate(job) {
    const plan = job.plan;
    const marking = plan.action === "mark";
    if (!marking) incoming(plan.source);
    requireSame(plan.source, plan.sourceSignature);
    assertSubtitlesPlanned(plan);
    if (plan.bundle) {
      assertPackageUnindexed(packageFolder(plan.bundle.folder));
      requireIntakePackageFolder(plan.bundle, incomingRoots);
    }
    checkedPath(plan.folder, targetRoots);
    if (plan.disk) {
      const expected = plan.disk.key;
      if (expected.startsWith("smb:")) {
        if (shareKey(plan.folder) !== expected) throw intakeError("目标网络共享已改变，请重新核对");
      } else if (deviceKey(plan.folder) !== expected) throw intakeError("目标卷已改变，请重新核对");
    }
    if (plan.folderIdentity && !same(identity(lstat(plan.folder)), plan.folderIdentity)) throw intakeError("目标作品目录已改变");
    assertNoIntakeConflict(database(), plan.folder, plan.workId);
    if (plan.localId) {
      const db = database();
      const binding = db.prepare("SELECT work_id,local_path FROM local_works WHERE id=?");
      const current = binding.get(plan.localId);
      const indexedPath = plan.flatReplacement ? plan.old.path : plan.folder;
      if (current?.work_id !== plan.workId || pathKey(current.local_path || "") !== pathKey(indexedPath)) throw intakeError("目标作品目录已改变");
      if (plan.flatReplacement) {
        const parent = checkedPath(plan.flatReplacement.parent, targetRoots);
        if (!same(identity(lstat(parent)), plan.flatReplacement.parentIdentity)) throw intakeError("原馆藏视频的所在目录已改变");
        assertFlatReplacementFolderFree(db, plan.folder, { created: Boolean(plan.folderIdentity) });
      }
      const originals = plan.retained ? [plan.retained] : oldFiles(plan);
      for (const original of originals) {
        const localId = original.localId ?? plan.localId;
        const local = localId === plan.localId ? current : binding.get(localId);
        const indexed = libraryFilesForLocal(db, localId);
        if (local?.work_id !== plan.workId || (plan.flatReplacement && pathKey(local.local_path || "") !== pathKey(original.path))
            || !indexed.some((row) => row.id === original.id && row.file_id === original.fileId && pathKey(row.file_path) === pathKey(original.path))) {
          throw intakeError("馆藏视频索引已改变");
        }
      }
      if (plan.action === "replace") {
        const groups = intakeLibraryPartGroups(catalogForIntake(db, plan.code).videos);
        if (!same(groups.get(plan.old.id) || [plan.old.id], originals.map((old) => old.id))) throw intakeError("馆藏分段已改变，请重新核对");
      }
    }
    if (plan.retained) requireSame(checkedPath(plan.retained.path, targetRoots), plan.retained.signature);
    for (const old of oldFiles(plan)) {
      const original = old.backup && lstat(old.backup) ? old.backup : old.path;
      checkedPath(original, targetRoots);
      requireSame(original, old.signature);
    }
    for (const { source, target, backup, sourceSignature, targetSignature, indexId, fileId } of plan.subtitleConflicts || []) {
      const db = database();
      requireSame(checkedPath(source, sourcePathRoots(plan.source)), sourceSignature);
      assertUnindexed(db, source);
      checkedPath(target, targetRoots);
      assertSubtitleConflictUnshared(plan, target);
      const row = indexedMarkFile(db, target, plan.localId, "info");
      if ((row?.id ?? null) !== indexId || (row?.file_id ?? null) !== fileId) throw intakeError("馆藏字幕索引已改变，请重新核对");
      if (backup) {
        checkedPath(backup, targetRoots);
        assertUnindexed(db, backup);
      }
      if (backup && lstat(backup)) {
        requireSame(backup, targetSignature);
        const current = signature(lstat(target));
        const staged = plan.files.find((item) => pathKey(item.target) === pathKey(target))?.staged;
        if (current && !same(current, targetSignature) && !same(current, staged)) throw intakeError("馆藏字幕已改变，请重新核对");
      } else requireSame(target, targetSignature);
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
    if ((plan.action === "new" || plan.flatReplacement) && !plan.folderIdentity) {
      if (!plan.flatReplacement) {
        checkedPath(plan.actor.folder, targetRoots);
        const actorStat = lstat(plan.actor.folder);
        if (plan.actorIdentity && !same(identity(actorStat), plan.actorIdentity)) throw intakeError("人物目录已改变");
        if (!actorStat) fs.mkdirSync(plan.actor.folder);
        else if (!actorStat.isDirectory()) throw intakeError("人物目录不可用");
      }
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
    const backups = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      revalidate(job);
      const originals = oldFiles(plan);
      const displaced = [...originals, ...displacedSubtitles(plan)];
      if (plan.action === "replace") for (const old of originals) assertVideoOwner(old.path, old.id);
      for (const item of plan.files) requireSame(item.temp, item.staged);
      for (const item of plan.files) {
        if (!displaced.some((old) => old.backup && pathKey(old.path) === pathKey(item.target))) assertUnindexed(db, item.target);
      }
      for (const old of displaced) {
        if (!old.backup) continue;
        if (!lstat(old.backup)) fs.linkSync(old.path, old.backup);
        requireSame(old.backup, old.signature);
        backups.push(old);
        if (same(signature(lstat(old.path)), old.signature)) fs.unlinkSync(old.path);
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
      for (const old of backups.reverse()) {
        if (!same(signature(lstat(old.backup)), old.signature)) continue;
        if (!lstat(old.path)) fs.linkSync(old.backup, old.path);
        if (same(signature(lstat(old.path)), old.signature)) fs.unlinkSync(old.backup);
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
      for (const { target, backup, targetSignature } of plan.subtitleConflicts || []) {
        requireSame(checkedPath(backup || target, targetRoots), targetSignature);
      }
      if (plan.bundle) cleanPackage(job);
      else for (const { source, backup, sourceSignature } of plan.subtitleConflicts || []) {
        if (backup) continue;
        assertUnindexed(database(), source);
        removeOwned(source, sourceSignature, sourcePathRoots(plan.source));
      }
      for (const item of plan.files) {
        if (item.source && (!plan.bundle || item.retainedSubtitle)) {
          assertUnindexed(database(), item.source);
          removeOwned(item.source, item.sourceSignature, plan.action === "mark" || item.retainedSubtitle ? targetRoots : sourcePathRoots(plan.source));
        }
        removeOwned(item.temp, item.staged, targetRoots);
      }
      if (plan.action === "replace") {
        for (const old of oldFiles(plan)) {
          const file = old.backup || old.path;
          assertUnindexed(database(), file);
          removeOwned(file, old.signature, targetRoots);
        }
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
  }

  function cleanPackage(job) {
    const bundle = job.plan.bundle;
    assertPackageUnindexed(packageFolder(bundle.folder));
    assertPackageUnindexed(bundle.quarantine);
    if (usesVolumeQueue(job.plan)) {
      job.result.sourceFolderRemaining = removeMigratedIntakePackage(bundle, incomingRoots, () => save(job));
    } else removeIntakePackage(bundle, incomingRoots, () => save(job));
  }

  function discardSourceVideo(plan) {
    const source = incoming(plan.source, { missing: true });
    const roots = sourcePathRoots(source);
    const subtitles = plan.discardSubtitles || [];
    if (lstat(source)) requireSame(source, plan.sourceSignature);
    const exclusive = subtitles.length ? new Set(subtitleFiles(source, { exclusive: true }).map(({ file }) => pathKey(file))) : null;
    for (const sidecar of subtitles) {
      const file = checkedPath(sidecar.source, roots);
      if (!lstat(file)) continue;
      if (!exclusive.has(pathKey(file))) throw intakeError("源外挂字幕的归属已改变，请重新核对");
      assertUnindexed(database(), file);
      requireSame(file, sidecar.signature);
    }
    removeOwned(source, plan.sourceSignature, roots);
    for (const sidecar of subtitles) removeOwned(sidecar.source, sidecar.signature, roots);
  }

  function moveDiscardPair(plan, restore = false) {
    const directory = (bundle, roots) => ({ original: bundle.folder, quarantine: bundle.quarantine, roots,
      verify: (file) => requireIntakePackage(bundle, roots, file) });
    const entries = [plan.bundle ? directory(plan.bundle, incomingRoots) : {
      original: plan.source, quarantine: plan.sourceTrash, roots: sourcePathRoots(plan.source),
      verify: (file) => requireSame(file, plan.sourceSignature)
    }, directory(plan.libraryRemoval, targetRoots)];
    moveDiscardEntries(entries, restore);
  }

  function moveDiscardEntries(entries, restore) {
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

  function moveLibraryVideoDiscard(plan, restore = false) {
    moveDiscardEntries([{ original: plan.source, quarantine: plan.sourceTrash, roots: targetRoots, verify(file) {
      requireSame(file, plan.sourceSignature);
      if (regular(file).nlink !== 1) throw intakeError("馆藏视频已有多个硬链接，请先核对归属");
    } }], restore);
  }

  function commitLibraryVideoDiscard(job) {
    const { plan } = job, db = database();
    db.exec("BEGIN IMMEDIATE");
    try {
      verifyLibraryVideoDiscard(plan);
      assertUnindexed(db, plan.sourceTrash);
      const missingSource = !libraryVideoStat(plan.source) && !lstat(checkedPath(plan.sourceTrash, targetRoots));
      if (plan.missingSource && !missingSource) throw intakeError("视频已重新出现，请刷新后重新选择");
      if (!missingSource) moveLibraryVideoDiscard(plan);
      const pin = db.prepare(`INSERT INTO intake_video_playback_ids (local_work_id,work_id,file_id,public_id) VALUES (?,?,?,?)
        ON CONFLICT(local_work_id,work_id,file_id) DO UPDATE SET public_id=excluded.public_id`);
      for (const { id, fileId, publicId } of plan.bindings) {
        if (id !== plan.videoRowId) pin.run(plan.localId, plan.workId, fileId, publicId);
      }
      const deleted = plan.bindings.find(({ id }) => id === plan.videoRowId);
      db.prepare("DELETE FROM intake_video_playback_ids WHERE local_work_id=? AND work_id=? AND file_id=?")
        .run(plan.localId, plan.workId, deleted.fileId);
      if (db.prepare("DELETE FROM local_files WHERE id=? AND local_work_id=? AND file_id=? AND file_type='video'")
        .run(deleted.id, plan.localId, deleted.fileId).changes !== 1) throw intakeError("馆藏视频索引已改变");
      if (hasIdentityTable(db, "video_probe_cache")) {
        db.prepare("DELETE FROM video_probe_cache WHERE file_path=? OR file_path=?").run(plan.source, deleted.file);
      }
      job.result = { discarded: true, missingSource, workId: String(plan.workId), videoId: deleted.publicId };
      job.state = "committed";
      save(job);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      job.result = null;
      job.state = "working";
      if (!plan.missingSource) moveLibraryVideoDiscard(plan, true);
      throw error;
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
    finishDiscard(job);
  }

  function finishDiscard(job) {
    if (onIndexChanged() === null) throw intakeError("删除已写入数据库，馆藏刷新失败，可重试收尾");
    job.state = "completed";
    job.error = "";
  }

  async function execute(job, progress) {
    const { plan } = job;
    if (plan.action === "discardLibraryVideo") {
      setPhase(progress, "delete");
      if (job.state !== "committed") commitLibraryVideoDiscard(job);
      if (!job.result?.missingSource) {
        assertUnindexed(database(), plan.sourceTrash);
        removeOwned(plan.sourceTrash, plan.sourceSignature, targetRoots);
      }
      finishDiscard(job);
      return;
    }
    if (plan.action === "discardBoth") {
      setPhase(progress, "delete");
      if (job.state !== "committed") commitDiscardPair(job);
      finishDiscardPair(job);
      return;
    }
    if (plan.action === "discard") {
      setPhase(progress, "delete");
      job.state = "working";
      save(job);
      if (plan.bundle) cleanPackage(job);
      else discardSourceVideo(plan);
      job.result = { discarded: true };
      job.state = "completed";
      job.error = "";
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
      const volumes = new Map();
      let occupied = false;
      for (const claim of claims) {
        if (!ownerAlive(claim.owner)) continue;
        const other = JSON.parse(claim.plan_json);
        if (disk && usesVolumeQueue(other) && sameDisk(disk, withShareVolume(other.disk, volumes) ?? diskFor(other))) occupied = true;
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
    }).finally(() => {
      completions.set(id, { job, warned: false });
      pump();
    });
    active.set(id, { disk, progress, promise });
    return true;
  }

  function flushCompletions() {
    for (const [id, completion] of completions) {
      try {
        // The terminal receipt and claim release are one SQLite write. Keep the
        // disk lane until it succeeds, so a retry never runs the file work twice.
        const db = database();
        const { timeout } = db.prepare("PRAGMA busy_timeout").get();
        // Retry the receipt from the queue timer without blocking unrelated
        // requests for the connection's usual synchronous busy timeout.
        if (timeout) db.exec("PRAGMA busy_timeout=0");
        try { save(completion.job, { db, releaseOwner: true }); }
        finally { if (timeout) db.exec(`PRAGMA busy_timeout=${timeout}`); }
        completions.delete(id);
        active.delete(id);
      } catch (error) {
        if (!completion.warned) console.warn("[media-intake-receipt]", id, error.code || error.message);
        completion.warned = true;
        if (sqliteBusy(error)) return false;
      }
    }
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
    const writerAvailable = flushCompletions();
    if (closing) return;
    let retry = true;
    try { if (writerAvailable) retry = drainQueue() || completions.size > 0; }
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
          if (current.state !== "committed") assertSubtitlesPlanned(current.plan);
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
    if (plan.action === "discardLibraryVideo") {
      if (!plan.missingSource) moveLibraryVideoDiscard(plan, true);
      return;
    }
    if (plan.action === "discardBoth") {
      moveDiscardPair(plan, true);
      return;
    }
    if (plan.bundle && (plan.bundle.isolated || lstat(checkedPath(plan.bundle.quarantine, incomingRoots)))) {
      throw intakeError("下载包已隔离，请重试清理");
    }
    if ([...oldFiles(plan), ...displacedSubtitles(plan)].some((old) => old.backup && lstat(old.backup))) {
      throw intakeError("旧文件的备份还未恢复，这个任务只能重试");
    }
    for (const item of plan.files) {
      if (item.temp && lstat(checkedPath(item.temp, targetRoots))?.isFile()) fs.unlinkSync(item.temp);
      if (item.staged && same(signature(lstat(checkedPath(item.target, targetRoots))), item.staged)) {
        assertUnindexed(database(), item.target);
        fs.unlinkSync(item.target);
      }
    }
    if ((plan.action === "new" || plan.flatReplacement) && plan.folderIdentity && same(identity(lstat(plan.folder)), plan.folderIdentity)) {
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
    if (input.subtitleMode === true) assertSubtitlePath(file);
    let target;
    if (targetRoots.some((root) => typeof file === "string" && path.isAbsolute(file) && inside(path.resolve(file), root))) {
      target = checkedPath(file, targetRoots);
      regular(target);
      if (input.subtitleMode === true) librarySubtitleVideo(target);
      else if (!database().prepare("SELECT 1 FROM local_files WHERE lower(replace(file_path,char(92),'/'))=lower(?) AND file_type='video'")
        .get(target.replaceAll("\\", "/"))) throw intakeError("未找到这个馆藏视频", 404);
    } else target = incoming(file);
    try { await openPath(input.folder === true ? path.dirname(target) : target); }
    catch { throw intakeError("系统未能打开这个文件或文件夹，请检查默认应用", 502); }
    return { ok: true };
  }

  function assertSubtitlePath(file) {
    if (typeof file === "string" && path.isAbsolute(file) && isWesternPath(path.resolve(file))) {
      throw intakeError("欧美作品请在欧美栏目查看", 422);
    }
  }

  return {
    config: () => ({ roots: incomingRoots, maxFiles: 120, discardReasons: DISCARD_REASONS, subtitleRemoval: Boolean(subtitleBackupRoot), subtitleCopy: true,
      libraryVideoDeletion: Boolean(resolveWork) }),
    discardStats,
    scan: (input) => track(() => scan(input)), compare: (input, options) => track(() => compare(input, options)),
    metadata: (input) => track(() => lookupMetadata(input)), prepare: (input) => track(() => prepare(input)),
    "subtitle-source": (input) => track(() => subtitleSource(input)),
    "subtitle-search": (input, options) => track(() => subtitleSearch(input, options)),
    "subtitle-files": (input, options) => track(() => subtitleLanguageFiles(input, options)),
    "subtitle-download": (input, options) => track(() => subtitleDownload(input, options)),
    "subtitle-download-direct": (input, options) => track(() => subtitleDownloadDirect(input, options)),
    "subtitle-import": (input, options) => track(() => subtitleImport(input, options)),
    "subtitle-copy": (input, options) => track(() => subtitleCopy(input, options)),
    "subtitle-remove": (input, options) => track(() => subtitleRemove(input, options)),
    open: (input) => track(() => open(input)), run, cancel,
    readVideoMarkers, readVideoMarkerJob, correctVideoMarkers,
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
    async close() {
      beginStop();
      await Promise.allSettled([...active.values()].map(({ promise }) => promise).concat([...pending, subtitleProvider.stop?.()]));
      flushCompletions();
    }
  };

  function beginStop() {
    if (closing) return;
    closing = true;
    clearTimeout(retryTimer);
    subtitleProvider.beginStop?.();
  }
}
