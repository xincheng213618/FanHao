import fs from "node:fs";
import path from "node:path";
import { extractWorkCodes, normalizeWorkCode, workCodeKey } from "../../../../../lib/code-parser.js";
import { applyParsedInfoToCoreWork } from "../../../../../lib/core-info-metadata.js";
import { parseInfoMetadata } from "../../../../../lib/info-metadata.js";
import { bindPersonLocation, findPersonByIdentity, hasIdentityTable, personLocations } from "../people/person-identity.js";
import { checkedPath, inside, intakeError, lstat, pathKey, regular, safeName, signature } from "./intake-files.js";

const now = () => new Date().toISOString();
const VIDEO_PLAYABLE = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const actorKey = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, "");
const jsonArray = (value) => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
const cleanText = (value, limit = 300) => String(value || "").replace(/[\r\n\u0000]/g, " ").trim().slice(0, limit);

export function intakeCode(file, supplied) {
  if (supplied !== undefined && supplied !== "") {
    const raw = String(supplied).trim();
    if (!/^[A-Z0-9][-_. A-Z0-9]{1,38}$/i.test(raw) || !normalizeWorkCode(raw)) throw intakeError("请输入有效的番号", 400);
    return normalizeWorkCode(raw);
  }
  for (const name of [path.parse(file).name, path.basename(path.dirname(file))]) {
    const code = intakeNameCode(name);
    if (code) return code;
  }
  return "";
}

export function intakeNameCode(name) {
  const codes = extractWorkCodes(name.replace(/(\d)(?=(?:restored|ltx)\b)/ig, "$1 "));
  return codes.length === 1 ? codes[0] : "";
}

export function catalogForIntake(db, code) {
  if (!code) return { works: [], videos: [] };
  const works = db.prepare(`SELECT id,code,title,release_date,duration_minutes,rating,director,javdb_tags_json
    FROM works WHERE code_search=? OR code=? COLLATE NOCASE ORDER BY id LIMIT 30`).all(workCodeKey(code), code).map((row) => ({
    id: Number(row.id), code: row.code, title: row.title || row.code, date: row.release_date || "", durationMinutes: row.duration_minutes,
    rating: row.rating, director: row.director || "", tags: jsonArray(row.javdb_tags_json),
    actors: db.prepare(`SELECT coalesce(nullif(p.display_name,''),p.name) AS name FROM work_people wp
      JOIN people p ON p.id=wp.person_id WHERE wp.work_id=? AND wp.role='actor' ORDER BY wp.sort_order,p.id`).all(row.id).map(({ name }) => name)
  }));
  const videos = works.flatMap((work) => db.prepare(`SELECT f.*,l.local_path AS folder FROM local_files f
    JOIN local_works l ON l.id=f.local_work_id WHERE f.work_id=? AND f.file_type='video' ORDER BY l.id,f.sort_order,f.name`).all(work.id)
    .map((row) => ({ ...row, work })));
  return { works, videos };
}

export function assertUnindexed(db, file) {
  if (db.prepare(`SELECT 1 FROM local_files WHERE lower(replace(file_path,char(92),'/'))=lower(?) LIMIT 1`).get(file.replaceAll("\\", "/"))) {
    throw intakeError("文件已被馆藏索引引用，请在对应作品里操作");
  }
}

export function assertNoIntakeConflict(db, folder, workId) {
  const overlaps = (other) => other && (inside(path.resolve(other), folder) || inside(folder, path.resolve(other)));
  if (hasIdentityTable(db, "work_move_path_reservations")) {
    const rows = db.prepare("SELECT work_id,old_path,new_path FROM work_move_path_reservations WHERE released_at=''").all();
    if (rows.some((r) => r.work_id === workId || overlaps(r.old_path) || overlaps(r.new_path))) throw intakeError("该作品正在迁移，请等原任务结束");
  }
  if (hasIdentityTable(db, "person_folder_operations")) {
    const rows = db.prepare("SELECT source_path,target_path FROM person_folder_operations WHERE status NOT IN ('completed','failed','rolled_back')").all();
    if (rows.some((r) => overlaps(r.source_path) || overlaps(r.target_path))) throw intakeError("该人物目录正在变更，请等原任务结束");
  }
}

export function personIntakeTargets(db, actors, roots) {
  return actors.flatMap((name) => {
    const person = findPersonByIdentity(db, { name });
    const known = person ? [person.folder_path, ...personLocations(db, person.id).map((row) => row.path)].filter(Boolean) : [];
    const names = person ? [...new Set([name, person.name, person.display_name].map((value) => safeName(value, "").slice(0, 100)).filter(Boolean))] : [];
    const discovered = roots.flatMap((root) => names.map((leaf) => path.join(root, leaf)));
    const unique = new Map();
    for (const folder of [...known, ...discovered]) {
      let target;
      try {
        target = checkedPath(folder, roots);
        if (!lstat(target)?.isDirectory()) continue;
      } catch { continue; }
      const key = pathKey(target);
      if (unique.has(key) || roots.some((root) => pathKey(root) === key)) continue;
      const owner = findPersonByIdentity(db, { folderPath: target });
      if (!owner || Number(owner.id) === Number(person.id)) unique.set(key, target);
    }
    if (unique.size) return [...unique.values()].map((folder) => ({ name, personId: Number(person.id), folder }));
    if (known.length) return [];
    const root = roots.find((value) => lstat(value)?.isDirectory());
    if (!root) return [];
    const folder = checkedPath(path.join(root, safeName(name, "").slice(0, 100)), roots);
    if (pathKey(folder) === pathKey(root)) return [];
    const owner = findPersonByIdentity(db, { folderPath: folder });
    if ((owner && Number(owner.id) !== Number(person?.id)) || (lstat(folder) && !owner && !person)) return [];
    return [{ name, personId: person ? Number(person.id) : null, folder }];
  });
}

export function metadataInfo(meta, code) {
  return Object.entries({ video_id: code, video_title: meta.title, actor_names: meta.actors.join("、"),
    release_date: meta.date, duration: meta.durationMinutes ? `${meta.durationMinutes} 分钟` : "", rating: meta.rating,
    director: meta.director, maker: meta.maker, series: meta.series, tags: meta.tags.join("、"), image_url: meta.imageUrl,
    detail_url: meta.detailUrl, metadata_source: meta.source }).filter(([, value]) => value !== null && value !== "" && value !== undefined)
    .map(([key, value]) => `${key}: ${cleanText(value, 1400)}`).join("\n") + "\n";
}

export function cleanIntakeMetadata(meta, source) {
  return {
    code: cleanText(meta.code, 50), title: cleanText(meta.title),
    actors: [...new Set((Array.isArray(meta.actors) ? meta.actors : []).map((name) => cleanText(name, 80)).filter(Boolean))].slice(0, 16),
    tags: [...new Set((Array.isArray(meta.tags) ? meta.tags : []).map((name) => cleanText(name, 80)).filter(Boolean))].slice(0, 32),
    date: cleanText(meta.date, 30), durationMinutes: Number(meta.durationMinutes) || null, rating: Number(meta.rating) || null,
    maker: cleanText(meta.maker), series: cleanText(meta.series), director: cleanText(meta.director),
    imageUrl: /^https?:\/\//i.test(meta.imageUrl || "") ? cleanText(meta.imageUrl, 1000) : "",
    detailUrl: /^https?:\/\//i.test(meta.detailUrl || "") ? cleanText(meta.detailUrl, 1000) : "", source
  };
}

export function libraryFilesForLocal(db, localId) {
  return db.prepare(`SELECT id,name,file_path,file_id,sort_order FROM local_files
    WHERE local_work_id=? AND file_type='video' ORDER BY sort_order,name,id`).all(localId);
}

export function indexedMarkFile(db, file, localId, type) {
  const rows = db.prepare(`SELECT id,file_id,local_work_id,file_path,file_type FROM local_files
    WHERE lower(replace(file_path,char(92),'/'))=lower(?)`).all(file.replaceAll("\\", "/"));
  if (rows.length > 1 || (rows[0] && (rows[0].local_work_id !== localId || rows[0].file_type !== type))) {
    throw intakeError("文件被其他馆藏记录引用，请先核对索引");
  }
  return rows[0] || null;
}

function orderIntakeVideos(db, localId, plan, timestamp) {
  const rows = libraryFilesForLocal(db, localId);
  const { matched_by: matchedBy } = db.prepare("SELECT matched_by FROM local_works WHERE id=?").get(localId);
  if (matchedBy !== "intake_ordered") {
    // Legacy playback follows natural filename order. Store that sequence before changing any names.
    rows.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
    db.prepare("UPDATE local_works SET matched_by='intake_ordered',updated_at=? WHERE id=?").run(timestamp, localId);
  }
  const selected = rows.findIndex((row) => row.id === plan.old?.id);
  const extraParts = plan.files.filter((item) => item.type === "video").length - 1;
  const update = db.prepare("UPDATE local_files SET sort_order=?,updated_at=? WHERE id=?");
  for (const [index, row] of rows.entries()) {
    const order = index + (selected >= 0 && index > selected ? extraParts : 0);
    if (row.sort_order !== order) update.run(order, timestamp, row.id);
  }
  return selected >= 0 ? selected + 1 : rows.length;
}

function updateIndexedFileName(db, item, localId, relativeFromRoot, timestamp) {
  const row = indexedMarkFile(db, item.source, localId, item.type);
  if ((row?.id ?? null) !== item.indexId || (row?.file_id ?? null) !== item.fileId) throw intakeError("文件的馆藏索引已改变，请重新核对");
  if (!row) return false;
  const { base, name } = path.parse(item.target);
  db.prepare("UPDATE local_files SET file_path=?,name=?,title=?,relative_path=?,updated_at=? WHERE id=?")
    .run(item.target, base, name, relativeFromRoot(item.target), timestamp, row.id);
  if (item.type === "video" && hasIdentityTable(db, "video_probe_cache")) {
    db.prepare("DELETE FROM video_probe_cache WHERE file_path=? OR file_path=?").run(item.source, row.file_path);
  }
  if (item.type === "info") db.prepare(`UPDATE local_works SET source_info_path=?,updated_at=? WHERE id=?
    AND lower(replace(source_info_path,char(92),'/'))=lower(?)`).run(item.target, timestamp, localId, item.source.replaceAll("\\", "/"));
  return true;
}

export function commitIntakeCatalog(db, plan, relativeFromRoot) {
  const timestamp = now();
  let workId = plan.workId;
  let localId = plan.localId;
  if (plan.action === "mark") {
    orderIntakeVideos(db, localId, plan, timestamp);
    for (const item of plan.files) {
      updateIndexedFileName(db, item, localId, relativeFromRoot, timestamp);
    }
    return { workId, localId, target: plan.files[0].target };
  }
  if (plan.action === "new") {
    const existing = catalogForIntake(db, plan.code);
    if (existing.videos.length || existing.works.length > 1 || (workId && existing.works[0]?.id !== workId)) throw intakeError("确认后番号馆藏已变，请重新核对");
    workId ||= existing.works[0]?.id || Number(db.prepare(`INSERT INTO works (code,code_search,title,status,source,created_at,updated_at)
      VALUES (?,?,?,'ok','local_scan',?,?)`).run(plan.code, workCodeKey(plan.code), plan.meta.title, timestamp, timestamp).lastInsertRowid);
    const registered = findPersonByIdentity(db, { name: plan.actor.name });
    if (Number(registered?.id || 0) !== Number(plan.actor.personId || 0)) throw intakeError("人物索引已改变，请重新生成预览");
    const personId = registered ? Number(registered.id) : Number(db.prepare(`INSERT INTO people (name,name_search,display_name,folder_path,status,source,created_at,updated_at)
      VALUES (?,?,?,?,'ok','local_scan',?,?)`).run(plan.actor.name, actorKey(plan.actor.name), plan.actor.name, plan.actor.folder, timestamp, timestamp).lastInsertRowid);
    bindPersonLocation(db, personId, plan.actor.folder);
    db.prepare(`INSERT OR IGNORE INTO work_people (work_id,person_id,role,sort_order,source,created_at,updated_at)
      VALUES (?,?,'actor',0,'local_scan',?,?)`).run(workId, personId, timestamp, timestamp);
    const info = plan.files.find((item) => item.type === "info" && !item.source);
    localId = Number(db.prepare(`INSERT INTO local_works (work_id,local_path,source_info_path,source_info_id,source_name,source_size,
      source_mtime,detected_code,detected_code_search,matched_by,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'intake',1,?,?)`)
      .run(workId, plan.folder, info.target, makeFileId("info", info.target), "local_scan", plan.files[0].staged[2],
        new Date(plan.files[0].staged[3]).toISOString(), plan.code, workCodeKey(plan.code), timestamp, timestamp).lastInsertRowid);
    applyParsedInfoToCoreWork(db, workId, parseInfoMetadata(info.content, { code: plan.code, title: plan.meta.title }), { now: timestamp });
  }
  let order = orderIntakeVideos(db, localId, plan, timestamp);
  for (const [index, item] of plan.files.entries()) {
    if (item.retainedSubtitle && updateIndexedFileName(db, item, localId, relativeFromRoot, timestamp)) continue;
    const stat = regular(item.target);
    const name = path.basename(item.target), ext = path.extname(name).toLowerCase(), title = path.parse(name).name;
    const modified = new Date(stat.mtimeMs).toISOString();
    const playable = Number(item.type === "video" && VIDEO_PLAYABLE.has(ext));
    const old = index === 0 ? plan.old : null;
    if (old && item.type === "video") {
      db.prepare(`UPDATE local_files SET file_path=?,name=?,title=?,ext=?,relative_path=?,size=?,modified_at=?,playable=?,updated_at=? WHERE id=?`)
        .run(item.target, name, title, ext, relativeFromRoot(item.target), stat.size, modified, playable, timestamp, old.id);
      if (hasIdentityTable(db, "video_probe_cache")) db.prepare("DELETE FROM video_probe_cache WHERE file_path=? OR file_path=?").run(old.path, old.dbPath || old.path);
    } else {
      db.prepare(`INSERT INTO local_files (work_id,local_work_id,file_id,file_type,file_path,name,title,ext,relative_path,size,modified_at,playable,sort_order,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(workId, localId, makeFileId(item.type, item.target), item.type, item.target, name, title, ext,
        relativeFromRoot(item.target), stat.size, modified, playable, item.type === "video" ? order++ : 0, timestamp, timestamp);
    }
    if (item.type === "video" && hasIdentityTable(db, "video_probe_cache")) {
      const fileId = old?.fileId || makeFileId(item.type, item.target);
      db.prepare(`INSERT OR REPLACE INTO video_probe_cache (file_id,file_path,source_size,source_mtime,schema_version,status,probe_json,updated_at)
        VALUES (?,?,?,?,1,'ok',?,?)`).run(fileId, item.target, stat.size, `library:${modified}`, JSON.stringify(item.probe || plan.probe), timestamp);
    }
  }
  return { workId, localId, target: plan.files[0].target };
}

function makeFileId(type, file) { return `${type[0]}_${Buffer.from(file).toString("base64url")}`; }

export function describeIntakeFile(file, probe) {
  const stat = regular(file);
  return { path: file, folder: path.dirname(file), name: path.basename(file), size: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(), signature: signature(stat), probe };
}
