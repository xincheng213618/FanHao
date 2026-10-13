import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workCodeKey, extractWorkCodes } from "../../../../../lib/code-parser.js";
import { parseInfoMetadata, renderInfoMetadataText } from "../../../../../lib/info-metadata.js";
import { ensureRealPathWithinRoots } from "../../../../platform/server/library-path-safety.js";
import { sameLocalVideo } from "../library/local-video-identity.js";

const key = (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
const within = (value, root) => key(value) === key(root) || key(value).startsWith(`${key(root).replace(/\/$/, "")}/`);
const overlap = (a, b) => within(a, b) || within(b, a);
const signature = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
const fail = (message) => Object.assign(new Error(message), { statusCode: 409 });
const stamp = () => new Date().toISOString();

export function organizationFolderName(code, title, localName = title) {
  const clean = String(title || "").replace(/\.(mp4|mkv|avi|wmv|mov|m4v|ts)$/i, "").trim();
  const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = String(code).split(/[-.]/).map((part) => /^\d+$/.test(part) ? `0*${part.replace(/^0+/, "") || "0"}` : escape(part));
  const codePattern = /^FC2-PPV-\d+$/i.test(code)
    ? `FC2[-_\\s.]*(?:PPV[-_\\s.]*)?${parts.at(-1)}` : parts.join("[-_\\s.]*");
  const codePrefix = `(?:\\d{2,6})?${codePattern}(?=$|[^a-z0-9])`;
  const leadingCode = new RegExp(`^${codePrefix}[.\\s_-]*`, "i");
  const marker = /^\[A\][.\s_-]*/i;
  // Keep the local marker at the front. Also recognize the duplicate prefix
  // produced by earlier organization, so another pass repairs it idempotently.
  const marked = marker.test(String(localName || ""))
    || new RegExp(`^${codePrefix}[.\\s_-]*\\[A\\][.\\s_-]*${codePrefix}`, "i").test(String(localName || ""));
  let suffix = clean.replace(marker, "").replace(leadingCode, "");
  if (marker.test(suffix)) suffix = suffix.replace(marker, "").replace(leadingCode, "");
  return `${marked ? "[A]." : ""}${code} ${suffix}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 120).replace(/[. ]+$/, "");
}

function collectFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw fail("目录含链接或联接点，已跳过");
    if (stat.isDirectory()) result.push(...collectFiles(file));
    else if (stat.isFile()) result.push(file);
    if (result.length > 10000) throw fail("作品文件过多，请先手动检查");
  }
  return result;
}

export function assertNoOrganizationMove(db, roots, ownPlanId = "") {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'work_move_path_reservations'").get()) return;
  const rows = db.prepare("SELECT job_id, old_path, new_path FROM work_move_path_reservations WHERE released_at = ''").all()
    .filter((row) => !ownPlanId || !row.job_id.startsWith(`person-organization:${ownPlanId}:`));
  if (rows.some((row) => roots.some((root) => [row.old_path, row.new_path].filter(Boolean).some((p) => overlap(root, p))))) {
    throw fail("这个人物目录还有作品移动任务，请完成后再整理");
  }
}

export function reserveOrganizationPaths(db, plan) {
  const roots = [...new Set(plan.groups.map((group) => group.root))];
  db.exec("BEGIN IMMEDIATE");
  try {
    assertNoOrganizationMove(db, roots, plan.id);
    for (const schema of ["main", "fanhao_images"]) for (const [index, root] of roots.entries()) {
      const id = `person-organization:${plan.id}:${index}`;
      const existing = db.prepare(`SELECT released_at FROM ${schema}.work_move_path_reservations WHERE job_id = ?`).get(id);
      if (existing && !existing.released_at) continue;
      if (existing) throw fail("整理路径预留已经释放，请重新预览");
      db.prepare(`INSERT INTO ${schema}.work_move_path_reservations
        (job_id, work_id, local_work_id, old_path, old_path_key, new_path, new_path_key, owner_id, lease_until, created_at, updated_at)
        VALUES (?, ?, -1, ?, ?, ?, ?, ?, '', ?, ?)`)
        .run(id, id, root, key(root).replace(/\/$/, ""), root, key(root).replace(/\/$/, ""), plan.id, stamp(), stamp());
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function releaseOrganizationPaths(db, plan) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const schema of ["main", "fanhao_images"]) db.prepare(`UPDATE ${schema}.work_move_path_reservations
      SET released_at = ?, mutation_mode = '', terminal_status = 'completed', updated_at = ? WHERE owner_id = ? AND released_at = ''`)
      .run(stamp(), stamp(), plan.id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function organizationMutationMode(db, plan, mode) {
  for (const schema of ["main", "fanhao_images"]) db.prepare(`UPDATE ${schema}.work_move_path_reservations
    SET mutation_mode = ? WHERE owner_id = ? AND released_at = ''`).run(mode, plan.id);
}

export function createPersonOrganizationService({ getCoreDb, resolvePerson, sourcePathToAbsolute, roots, stateDir }) {
  function planPath(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw fail("整理计划无效");
    return path.join(stateDir, `${id}.json`);
  }
  function read(id) { return JSON.parse(fs.readFileSync(planPath(id), "utf8")); }
  function pending(personId) {
    if (!fs.existsSync(stateDir)) return null;
    return fs.readdirSync(stateDir).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => read(name.slice(0, -5)))
      .find((plan) => String(plan.personId) === String(personId) && ["running", "error"].includes(plan.status));
  }
  function assertIdle(personId) {
    const plan = pending(personId);
    if (plan && (plan.status === "running" || plan.groups.some((g) => !g.done))) throw fail("人物整理尚未完成，请点击重新整理继续该任务");
  }
  function preview(personId) {
    const person = resolvePerson(personId);
    if (!person) throw Object.assign(new Error("人物不存在"), { statusCode: 404 });
    const unfinished = pending(person.id);
    if (unfinished) return publicPlan(unfinished);
    const sources = [...new Set([...(person.sourcePaths || []), person.relativePath].filter(Boolean).map(sourcePathToAbsolute))]
      .map((source) => ensureRealPathWithinRoots(source, roots, "人物目录"));
    if (!sources.length || sources.some((p) => !fs.existsSync(p) || !fs.statSync(p).isDirectory())) throw fail("人物目录已失联，请先重新关联");
    if (sources.some((source) => roots.some((root) => key(source) === key(root)))) throw fail("不能整理资料库根目录");
    const db = getCoreDb();
    assertNoOrganizationMove(db, sources);
    const rows = db.prepare(`SELECT DISTINCT lw.id, lw.work_id, lw.local_path, w.code, w.title,
      w.raw_text, w.fields_json, w.release_date, w.duration_minutes, w.rating, w.rating_count, w.director,
      (SELECT remote_url FROM fanhao_images.images i WHERE i.owner_type = 'work' AND i.owner_id = w.id AND i.kind = 'cover' AND remote_url <> '' ORDER BY i.sort_order, i.id LIMIT 1) AS coverUrl,
      (SELECT url FROM work_external_refs r WHERE r.work_id = w.id AND r.provider = 'javdb-video' LIMIT 1) AS detailUrl
      FROM local_works lw JOIN works w ON w.id = lw.work_id
      JOIN work_people wp ON wp.work_id = w.id WHERE wp.person_id = ? ORDER BY lw.id`).all(Number(person.id));
    const groups = [], skipped = [], targets = new Set();
    for (const row of rows) {
      const source = sources.find((p) => within(row.local_path, p));
      if (!source) continue;
      try {
        if (!row.code || !workCodeKey(row.code)) throw fail("未识别番号");
        const loose = key(row.local_path) === key(source);
        if (!loose && key(path.dirname(row.local_path)) !== key(source)) throw fail("作品不是人物目录的直属文件夹");
        const indexed = db.prepare("SELECT * FROM local_files WHERE local_work_id = ?").all(row.id);
        const videos = indexed.filter((f) => f.file_type === "video");
        if (!videos.length) throw fail("没有已登记的视频，请先刷新本地");
        let files = loose ? indexed.map((f) => f.file_path) : collectFiles(row.local_path);
        if (loose) {
          const stems = new Set(videos.map((f) => path.parse(f.file_path).name.toLowerCase()));
          files.push(...fs.readdirSync(source).filter((name) => stems.has(path.parse(name).name.toLowerCase())).map((name) => path.join(source, name)));
        }
        files = [...new Set(files.map((file) => path.resolve(file)))];
        if (files.some((f) => /\.(aria2|part|partial|tmp|crdownload)$/i.test(f) || fs.existsSync(`${f}.aria2`))) throw fail("作品存在未完成下载");
        if (videos.some((v) => !files.includes(path.resolve(v.file_path)))) throw fail("已登记视频不在原目录");
        // A photographed-bonus edition may add T to the catalogue code while
        // retaining the base video's filename. Require its canonical folder,
        // explicit edition title and exact indexed file identity; never merge works.
        const editionCode = (code) => !loose && workCodeKey(row.code) === `t${workCodeKey(code)}`
          && /生写真(?:\s*\d+\s*枚)?\s*付/.test(row.title || "")
          && workCodeKey(extractWorkCodes(path.basename(row.local_path))[0]) === workCodeKey(row.code);
        const unexpectedCodes = files.filter((file) => /\.(mp4|mkv|avi|wmv|mov|m4v|ts)$/i.test(file))
          .flatMap((file) => {
            const code = extractWorkCodes(path.basename(file))[0];
            if (!code || workCodeKey(code) === workCodeKey(row.code)) return [];
            const stored = videos.find((video) => key(video.file_path) === key(file));
            if (editionCode(code) && stored) {
              const stat = fs.statSync(file);
              if (sameLocalVideo({ name: path.basename(file), size: stat.size, modifiedAt: stat.mtime.toISOString() }, stored)) return [];
            }
            return [code];
          });
        if (unexpectedCodes.length) throw fail(loose
          ? `登记视频为 ${[...new Set(unexpectedCodes)].join("、")}，与 ${row.code} 不一致，请先刷新本地`
          : `目录含其他番号视频（${[...new Set(unexpectedCodes)].join("、")}），需要手动确认`);
        const localName = path.basename(loose ? videos[0].file_path : row.local_path);
        const target = path.join(source, organizationFolderName(row.code, row.title, localName));
        if (targets.has(key(target))) throw fail("多个本地记录对应同一个目标目录");
        if (key(target) !== key(row.local_path) && fs.existsSync(target)) throw fail("目标目录已存在，保留原位");
        const items = files.map((file) => {
          ensureRealPathWithinRoots(file, [source], "源文件");
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw fail("源文件不存在或是链接");
          const destination = path.join(target, loose ? path.basename(file) : path.relative(row.local_path, file));
          ensureRealPathWithinRoots(destination, [source], "目标文件");
          return { source: file, target: destination, signature: signature(stat), done: false };
        });
        targets.add(key(target));
        const parsed = parseInfoMetadata(row.raw_text || "", { title: row.title });
        const metadata = { ...parsed, code: row.code, title: row.title,
          releaseDate: row.release_date || parsed.releaseDate, durationMinutes: row.duration_minutes ?? parsed.durationMinutes,
          rating: row.rating ?? parsed.rating, ratingCount: row.rating_count ?? parsed.ratingCount, director: row.director || parsed.director,
          javdbUrl: row.detailUrl || parsed.javdbUrl, imageUrl: row.coverUrl || parsed.imageUrl };
        let remoteCoverName = "";
        try { remoteCoverName = decodeURIComponent(path.basename(new URL(metadata.imageUrl).pathname)).toLowerCase(); } catch {}
        const obsoleteCovers = items.filter((item) => {
          const name = path.basename(item.target).toLowerCase();
          if (name === "cover.jpg" || !/\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(name)) return false;
          const base = path.parse(name).name;
          const dmmBase = base.replace(/^h[_-]\d+[_-]?/, "").replace(/^\d+(?=[a-z])/, "");
          const coverCode = dmmBase.replace(/(?:pl|ps)$/, "");
          const catalogCover = /^[a-z]+\d+(?:pl|ps)$/.test(dmmBase)
            && (workCodeKey(coverCode) === workCodeKey(row.code)
              || (editionCode(coverCode) && videos.some((video) => workCodeKey(extractWorkCodes(path.basename(video.file_path))[0]) === workCodeKey(coverCode))));
          return name === remoteCoverName || /^(cover|folder|poster|front)$/.test(base) || catalogCover;
        }).map((item) => ({ file: item.target, signature: item.signature }));
        groups.push({ localWorkId: row.id, workId: row.work_id, code: row.code, title: row.title, detailUrl: metadata.javdbUrl || "",
          releaseDate: metadata.releaseDate || "",
          metadata: { rawText: `${renderInfoMetadataText(metadata)}${metadata.imageUrl ? `\n封面: ${metadata.imageUrl}` : ""}`,
            imageUrl: metadata.imageUrl || "" },
          root: source, rootReal: fs.realpathSync.native(source), oldPath: row.local_path, target, loose, items, obsoleteCovers, done: false, metadataDone: false });
      } catch (error) { skipped.push({ code: row.code, reason: error.message }); }
    }
    const obsolete = sources.flatMap((source) => ["cover.jpg", "info.txt", "javdb-info.txt"].map((name) => path.join(source, name)))
      .filter((file) => fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink())
      .map((file) => ({ file, root: sources.find((source) => within(file, source)), signature: signature(fs.statSync(file)) }));
    const plan = { id: crypto.randomUUID(), version: 1, personId: person.id, personName: person.name, createdAt: stamp(), status: "preview", groups, skipped, obsolete };
    fs.mkdirSync(stateDir, { recursive: true });
    saveOrganizationPlan(planPath(plan.id), plan);
    return publicPlan(plan);
  }
  return { preview, read, planPath, pending, assertIdle };
}

export function publicPlan(plan) {
  return { id: plan.id, personId: plan.personId, personName: plan.personName, status: plan.status,
    workCount: plan.groups.length, moveCount: plan.groups.filter((g) => !g.done && key(g.oldPath) !== key(g.target)).length,
    groups: plan.groups.map((g) => ({ code: g.code, source: g.oldPath, target: g.target, videos: g.items.filter((i) => /\.(mp4|mkv|avi|wmv|mov|m4v|ts)$/i.test(i.source)).length })), skipped: plan.skipped,
    obsoleteCoverCount: plan.groups.reduce((sum, group) => sum
      + (group.obsoleteCovers || []).filter((item) => !group.done || fs.existsSync(item.file)).length, 0),
    obsolete: (plan.obsolete || []).map((item) => item.file) };
}

export function saveOrganizationPlan(file, plan) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(plan, null, 2), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

function validateGroup(group) {
  if (fs.realpathSync.native(group.root) !== group.rootReal) throw fail("人物目录指向发生变化");
  const rejectLinks = (file) => {
    let current = group.root;
    for (const part of path.relative(group.root, file).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw fail("整理路径变成了链接或联接点"); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
    }
  };
  ensureRealPathWithinRoots(group.target, [group.root], "目标目录");
  rejectLinks(group.target);
  for (const item of group.items) {
    ensureRealPathWithinRoots(item.source, [group.root], "源文件");
    ensureRealPathWithinRoots(item.target, [group.root], "目标文件");
    rejectLinks(item.source);
    rejectLinks(item.target);
  }
}

function rewriteFilePaths(db, item, relativeFromRoot) {
  const specs = [["main", "local_files", ["file_path"], "relative_path"], ["main", "video_probe_cache", ["file_path"]],
    ["fanhao_images", "images", ["local_path", "storage_path"]], ["fanhao_images", "local_image_cache", ["file_path"], "relative_path"]];
  for (const [schema, table, columns, relative] of specs) {
    if (!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE name = ?`).get(table)) continue;
    for (const column of columns) {
      db.prepare(`UPDATE ${schema}.${table} SET ${column} = ?${relative ? `, ${relative} = ?` : ""}, updated_at = ?
        WHERE lower(replace(${column}, char(92), '/')) = ?`).run(item.target, ...(relative ? [relativeFromRoot(item.target)] : []), stamp(), key(item.source));
    }
  }
}

// Same-volume hard links publish without replacing files or copying large videos.
// The journal and inode proof allow a retry after either the SQLite commit or unlink.
export async function organizeGroup(db, group, plan, planFile, relativeFromRoot = (p) => p.replaceAll("\\", "/")) {
  validateGroup(group);
  db.exec("BEGIN IMMEDIATE");
  try {
    assertNoOrganizationMove(db, [group.root], plan.id);
    organizationMutationMode(db, plan, "organize");
    const row = db.prepare("SELECT work_id, local_path FROM local_works WHERE id = ?").get(group.localWorkId);
    if (!row || Number(row.work_id) !== Number(group.workId) || ![key(group.oldPath), key(group.target)].includes(key(row.local_path))) throw fail("作品记录已经改变，请检查整理计划");
    for (const item of group.items) {
      if (key(item.source) === key(item.target)) continue;
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      validateGroup(group);
      const source = fs.existsSync(item.source) ? fs.lstatSync(item.source) : null;
      const target = fs.existsSync(item.target) ? fs.lstatSync(item.target) : null;
      if (source && (source.isSymbolicLink() || signature(source) !== item.signature)) throw fail("预览后源文件发生变化");
      if (target) {
        if (target.isSymbolicLink() || signature(target) !== item.signature || (source && (source.ino !== target.ino || source.dev !== target.dev))) throw fail("目标存在不同文件，未覆盖");
      } else {
        if (!source) throw fail("源文件与目标文件均不存在");
        fs.linkSync(item.source, item.target);
      }
      rewriteFilePaths(db, item, relativeFromRoot);
    }
    const info = group.items.find((item) => path.basename(item.target).toLowerCase() === "info.txt");
    db.prepare("UPDATE local_works SET local_path = ?, source_info_path = ?, updated_at = ? WHERE id = ?")
      .run(group.target, info?.target || "", stamp(), group.localWorkId);
    organizationMutationMode(db, plan, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  for (const item of group.items) {
    if (key(item.source) !== key(item.target) && fs.existsSync(item.source)) {
      validateGroup(group);
      if (signature(fs.lstatSync(item.source)) !== item.signature || signature(fs.lstatSync(item.target)) !== item.signature) throw fail("移除源路径前文件发生变化，已保留两份");
      fs.unlinkSync(item.source);
    }
    item.done = true;
    saveOrganizationPlan(planFile, plan);
  }
  // Only empty directories owned by this group; never recursively delete anything.
  if (!group.loose && key(group.oldPath) !== key(group.target)) {
    const removeEmpty = (directory) => {
      if (!fs.existsSync(directory)) return;
      ensureRealPathWithinRoots(directory, [group.root]);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) removeEmpty(path.join(directory, entry.name));
      if (!fs.readdirSync(directory).length) fs.rmdirSync(directory);
    };
    removeEmpty(group.oldPath);
  }
  group.done = true;
  saveOrganizationPlan(planFile, plan);
}

export function writeOrganizationSidecar(group, file, bytes) {
  validateGroup(group);
  ensureRealPathWithinRoots(file, [group.target], "资料文件");
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw fail("资料路径不是普通文件");
  }
  const temporary = `${file}.fanhao-${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: "wx" });
  validateGroup(group);
  fs.renameSync(temporary, file);
}

export function setOrganizationFolderReleaseDate(group) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(group.releaseDate || ""));
  if (!match) return false;
  const date = new Date(`${group.releaseDate}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== Number(match[1])
    || date.getMonth() + 1 !== Number(match[2]) || date.getDate() !== Number(match[3])) return false;
  validateGroup(group);
  const stat = fs.lstatSync(group.target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("作品路径不是普通目录");
  fs.utimesSync(group.target, stat.atime, date);
  return true;
}

export function cleanupOrganizationSidecars(db, plan) {
  const removed = [], retained = [];
  if (!plan.refreshMetadata || plan.groups.some((group) => !group.metadataDone)) return { removed, retained };
  for (const item of plan.obsolete || []) {
    if (!fs.existsSync(item.file)) continue;
    ensureRealPathWithinRoots(item.file, [item.root], "遗留资料文件");
    const rootGroup = plan.groups.find((group) => key(group.root) === key(item.root));
    if (!rootGroup || fs.realpathSync.native(item.root) !== rootGroup.rootReal) throw fail("清理前人物目录发生变化");
    if (signature(fs.lstatSync(item.file)) !== item.signature || fs.lstatSync(item.file).isSymbolicLink()) { retained.push(item.file); continue; }
    if (fs.readdirSync(item.root).some((name) => /\.(mp4|mkv|avi|wmv|mov|m4v|ts)$/i.test(name))) { retained.push(item.file); continue; }
    const refs = db.prepare("SELECT 1 FROM local_files WHERE lower(replace(file_path, char(92), '/')) = ? LIMIT 1").get(key(item.file));
    const infoRefs = db.prepare("SELECT 1 FROM local_works WHERE lower(replace(source_info_path, char(92), '/')) = ? LIMIT 1").get(key(item.file));
    const images = db.prepare("SELECT 1 FROM fanhao_images.images WHERE lower(replace(local_path, char(92), '/')) = ? OR lower(replace(storage_path, char(92), '/')) = ? LIMIT 1").get(key(item.file), key(item.file));
    if (refs || infoRefs || images) { retained.push(item.file); continue; }
    fs.unlinkSync(item.file);
    removed.push(item.file);
  }
  return { removed, retained };
}

// Only snapshotted cover names backed by the cover URL or an established cover filename.
// Other images (including samples) stay in place. Canonical cover must already exist.
export function cleanupOrganizationWorkCovers(db, group, plan) {
  const removed = [], retained = [];
  if (!plan.refreshMetadata || !group.metadataDone) return { removed, retained };
  const cover = path.join(group.target, "cover.jpg");
  validateGroup(group);
  if (!fs.existsSync(cover) || !fs.lstatSync(cover).isFile() || fs.lstatSync(cover).isSymbolicLink()) return { removed, retained };
  for (const item of group.obsoleteCovers || []) {
    if (!fs.existsSync(item.file)) continue;
    ensureRealPathWithinRoots(item.file, [group.target], "旧封面");
    if (fs.lstatSync(item.file).isSymbolicLink() || signature(fs.lstatSync(item.file)) !== item.signature) { retained.push(item.file); continue; }
    db.exec("BEGIN IMMEDIATE");
    try {
      organizationMutationMode(db, plan, "organize");
      const otherFiles = db.prepare(`SELECT 1 FROM local_files WHERE lower(replace(file_path, char(92), '/')) = ?
        AND (local_work_id <> ? OR work_id <> ?) LIMIT 1`).get(key(item.file), group.localWorkId, group.workId);
      const otherImages = db.prepare(`SELECT 1 FROM fanhao_images.images WHERE
        (lower(replace(local_path, char(92), '/')) = ? OR lower(replace(storage_path, char(92), '/')) = ?)
        AND (owner_type <> 'work' OR owner_id <> ? OR kind <> 'cover') LIMIT 1`).get(key(item.file), key(item.file), group.workId);
      if (otherFiles || otherImages) {
        retained.push(item.file);
      } else {
        db.prepare("DELETE FROM local_files WHERE lower(replace(file_path, char(92), '/')) = ?").run(key(item.file));
        db.prepare("DELETE FROM fanhao_images.local_image_cache WHERE lower(replace(file_path, char(92), '/')) = ?").run(key(item.file));
        const oldImages = db.prepare(`SELECT * FROM fanhao_images.images WHERE
          lower(replace(local_path, char(92), '/')) = ? OR lower(replace(storage_path, char(92), '/')) = ?`).all(key(item.file), key(item.file));
        for (const image of oldImages) {
          const localPath = image.local_path && key(image.local_path) === key(item.file) ? cover : image.local_path;
          const storagePath = image.storage_path && key(image.storage_path) === key(item.file) ? cover : image.storage_path;
          const duplicate = db.prepare(`SELECT id FROM fanhao_images.images WHERE id <> ? AND owner_type = ? AND owner_id = ?
            AND kind = ? AND source_type = ? AND COALESCE(remote_url, '') = ? AND COALESCE(local_path, '') = ? AND sort_order = ? LIMIT 1`)
            .get(image.id, image.owner_type, image.owner_id, image.kind, image.source_type, image.remote_url || "", localPath || "", image.sort_order);
          if (duplicate) db.prepare("DELETE FROM fanhao_images.images WHERE id = ?").run(image.id);
          else db.prepare("UPDATE fanhao_images.images SET local_path = ?, storage_path = ?, updated_at = ? WHERE id = ?")
            .run(localPath, storagePath, stamp(), image.id);
        }
      }
      organizationMutationMode(db, plan, "");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    if (retained.includes(item.file)) continue;
    validateGroup(group);
    if (signature(fs.lstatSync(item.file)) !== item.signature) throw fail("旧封面清理前文件发生变化");
    fs.unlinkSync(item.file);
    removed.push(item.file);
  }
  return { removed, retained };
}
