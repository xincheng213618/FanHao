import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { ARCHIVE_IMAGE_INDEXER_VERSION, archiveDiskSignature } from "../../../platform/server/archive-image-service.js";
import { ensureRealPathWithinRoots } from "../../../platform/server/library-path-safety.js";
import { safeChildPath } from "../../../platform/server/request-io.js";

const MAX_LINKS = 30;
const MAX_PAGE = 100;
const MAX_SEED_BATCH = 400;
const ARCHIVE_CATEGORY = "coalesce(nullif(json_extract(data_json,'$.category'),''),'未分类')";
const ARCHIVE_IMAGE_JOIN = `i.archive_path=a.archive_path AND i.indexer_version=? AND i.archive_identity<>'' AND (
  i.archive_identity=a.archive_identity OR (a.archive_identity='' AND i.archive_size=json_extract(a.data_json,'$.size')
    AND cast(i.archive_mtime_ms AS INTEGER)=json_extract(a.data_json,'$.scanMtimeMs')))`;

function catalogError(message, statusCode = 400, code = "PHOTO_CATALOG_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

function text(value, max = 240) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    throw catalogError("套图资料字段无效或过长");
  }
  return value.trim();
}

function required(value, label, max) {
  const result = text(value, max);
  if (!result) throw catalogError(`缺少${label}`);
  return result;
}

function key(value) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw catalogError("套图资料格式无效");
  return value;
}

function count(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw catalogError("套图声明数量无效");
  return value;
}

function confirmedDate(value) {
  if (value == null) return null;
  const date = text(value, 10);
  if (!date) return "";
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw catalogError("套图发行日期无效，请使用 YYYY-MM-DD");
  }
  return date;
}

function metadataJson(value) {
  if (value == null) return "";
  object(value);
  const json = JSON.stringify(value, (_name, part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    return Object.fromEntries(Object.keys(part).sort().map(name => [name, part[name]]));
  });
  if (Buffer.byteLength(json) > 16 * 1024) throw catalogError("套图来源附加资料过长");
  return json;
}

function remoteUrl(value) {
  const url = text(value, 2048);
  if (!url) return "";
  const parsed = URL.parse(url);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw catalogError("套图来源链接无效");
  }
  return parsed.href;
}

function links(values, normalize, identity) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > MAX_LINKS) throw catalogError("套图关联数量无效");
  const rows = values.map(normalize);
  if (new Set(rows.map(identity)).size !== rows.length) throw catalogError("套图关联重复");
  return rows;
}

function declarations(value) {
  return {
    declaredImageCount: count(value.declaredImageCount),
    declaredVideoCount: count(value.declaredVideoCount),
    declaredSizeLabel: text(value.declaredSizeLabel, 100)
  };
}

function normalizePlan(value) {
  const input = object(value);
  const mergeWorkIds = links(input.mergeWorkIds, id => required(id, "归并作品标识", 100), id => id);
  let workId = text(input.workId, 100);
  if (mergeWorkIds.length) {
    if (mergeWorkIds.length !== 2 || (workId && workId !== mergeWorkIds[0])) throw catalogError("请指定本地作品和来源作品进行归并");
    workId = mergeWorkIds[0];
  }
  const archiveIds = links(input.archiveIds, id => required(id, "归档标识", 4096), id => id);
  const sources = links(input.sources, entry => {
    const row = object(entry);
    return {
      provider: key(required(row.provider, "来源", 60)), externalId: required(row.externalId, "来源编号"),
      url: remoteUrl(row.url), title: text(row.title, 500), issueCode: text(row.issueCode), issueLabel: text(row.issueLabel),
      description: text(row.description, 4000),
      releaseDate: text(row.releaseDate ?? row.publishedAt, 60), ...declarations(row),
      metadata: row.metadata == null ? null : JSON.parse(metadataJson(row.metadata))
    };
  }, row => JSON.stringify([row.provider, row.externalId]));
  const collections = links(input.collections, entry => {
    const row = object(entry);
    const provider = key(text(row.provider, 60));
    const externalId = text(row.externalId);
    if (externalId && !provider) throw catalogError("来源合集编号需要来源名称");
    return {
      name: required(row.name, "合集名称", 500), provider, externalId, url: remoteUrl(row.url), issueListUrl: remoteUrl(row.issueListUrl),
      declaredCount: count(row.declaredCount), declaredCountLabel: text(row.declaredCountLabel, 100),
      ...declarations(row)
    };
  }, collectionKey);
  const people = links(input.people, entry => {
    const row = object(entry);
    const personId = typeof row.personId === "number" && Number.isSafeInteger(row.personId)
      ? String(row.personId) : text(row.personId, 100);
    const name = text(row.name);
    if (!personId && !name) throw catalogError("缺少套图人物标识或姓名");
    return { personId, name, role: key(text(row.role, 60)) || "model" };
  }, row => JSON.stringify([personKey(row), row.role]));
  if (mergeWorkIds.length && (!archiveIds.length || !sources.length)) throw catalogError("归并需要所选归档和已绑定来源");
  if (!workId && !archiveIds.length && !sources.length) throw catalogError("新套图需要至少一个归档或来源");
  return {
    workId, mergeWorkIds, archiveIds, title: input.title == null ? null : required(input.title, "套图标题", 500),
    issueCode: input.issueCode == null ? null : text(input.issueCode), suggestedIssueCode: text(input.suggestedIssueCode),
    releaseDate: confirmedDate(input.releaseDate), sources, collections, people
  };
}

function collectionKey(row) {
  return JSON.stringify([row.provider, row.externalId ? "external" : "name", row.externalId || key(row.name)]);
}

export { collectionKey as photoCatalogCollectionKey };

function personKey(row) {
  return JSON.stringify(row.personId ? ["id", row.personId] : ["name", key(row.name)]);
}

function effectiveIssue(plan, work) {
  if (plan.issueCode != null) return { value: plan.issueCode, source: plan.issueCode ? "manual" : "" };
  if (work?.issue_code) return { value: work.issue_code, source: work.issue_source };
  const source = plan.sources.find(row => row.issueCode);
  if (source) return { value: source.issueCode, source: `source:${source.provider}` };
  return { value: plan.suggestedIssueCode, source: plan.suggestedIssueCode ? "archive" : "" };
}

export function photoCatalogMergeFieldConflicts(local, source) {
  return ["title", "issueCode", "releaseDate"].flatMap((field) => {
    const localValue = local[field];
    const sourceValue = source[field];
    if (local.fieldSources[field] !== "manual" || source.fieldSources[field] !== "manual" || !localValue || !sourceValue) return [];
    const differs = field === "issueCode" ? key(localValue) !== key(sourceValue) : localValue !== sourceValue;
    return differs ? [{ field, localValue, sourceValue }] : [];
  });
}

function mergeFields(plan, local, donor, conflicts) {
  for (const { field } of photoCatalogMergeFieldConflicts(workSummary(local), workSummary(donor))) {
    if (plan[field] == null) conflicts.push({ code: "merge-field-conflict", id: field, workId: donor.id });
  }
  const title = local.title_source === "manual" ? local : donor;
  const issue = local.issue_source === "manual" || (local.issue_code && donor.issue_source !== "manual") ? local : donor;
  return { ...local, title: title.title, title_source: title.title_source,
    issue_code: issue.issue_code, issue_source: issue.issue_source, release_date: local.release_date || donor.release_date };
}

function fieldSources(row) {
  return { title: row.title_source, issueCode: row.issue_source, releaseDate: row.release_date ? "manual" : "" };
}

function workSummary(row) {
  return { id: row.id, title: row.title, issueCode: row.issue_code, releaseDate: row.release_date, fieldSources: fieldSources(row) };
}

function scannedArchiveId(value) {
  const id = required(value, "扫描归档标识", 4096);
  if (!/^ps_[a-zA-Z0-9_-]+$/u.test(id)) throw catalogError("扫描归档标识无效");
  return id;
}

function scannedArchiveSignature(value, archivePath, size, modifiedAt) {
  const signature = text(value, 4096);
  if (!signature) return "";
  let parts;
  try { parts = JSON.parse(signature); } catch { throw catalogError("扫描归档签名无效"); }
  if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== archivePath || parts[1] !== size
    || !Number.isFinite(parts[2]) || Math.trunc(parts[2]) !== Date.parse(modifiedAt)
    || typeof parts[3] !== "string" || typeof parts[4] !== "string") {
    throw catalogError("扫描归档签名与索引记录不一致");
  }
  return signature;
}

function scannedArchive(row, id) {
  const value = object(row.archive);
  const archivePath = Buffer.from(id.slice(3), "base64url").toString("utf8");
  if (!path.isAbsolute(archivePath) || archivePath.includes("\0") || path.resolve(archivePath) !== archivePath
    || `ps_${Buffer.from(archivePath).toString("base64url")}` !== id || (value.archivePath != null && value.archivePath !== archivePath)) {
    throw catalogError("扫描归档路径与标识不一致");
  }
  const relativePath = value.relativePath;
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 4096 || relativePath.includes("\0")) {
    throw catalogError("扫描归档相对路径无效");
  }
  const segments = relativePath.split(/[\\/]/u);
  if (path.win32.isAbsolute(relativePath) || /^[a-z]:/iu.test(relativePath)
    || segments.some(segment => !segment || segment === "." || segment === "..")
    || !archivePath.endsWith(`${path.sep}${segments.join(path.sep)}`)) {
    throw catalogError("扫描归档相对路径与标识不一致");
  }
  const size = count(value.size);
  if (size == null) throw catalogError("扫描归档大小缺失");
  const modifiedAt = text(value.modifiedAt, 40);
  if (modifiedAt && !Number.isFinite(Date.parse(modifiedAt))) throw catalogError("扫描归档修改时间无效");
  const archiveExt = required(value.archiveExt, "归档格式", 12).toLowerCase();
  if (path.extname(archivePath).slice(1).toLowerCase() !== archiveExt) throw catalogError("扫描归档格式与路径不一致");
  const collection = object(row.collection);
  if (collection.provider !== "local") throw catalogError("扫描归档必须属于本地合集");
  return {
    archivePath, archiveIdentity: scannedArchiveSignature(value.archiveIdentity, archivePath, size, modifiedAt),
    archive: {
      id, title: text(value.title, 4096) || "未命名套图", category: text(value.category, 1000), relativePath,
      rootLabel: text(value.rootLabel, 1000), archiveExt, size, modifiedAt,
      scanMtimeMs: modifiedAt ? Date.parse(modifiedAt) : null,
      coverUrl: `/media/gallery-cover/${encodeURIComponent(id)}${modifiedAt ? `?v=${encodeURIComponent(modifiedAt)}` : ""}`,
      personHint: text(value.personHint, 1000), issueHint: text(value.issueHint, 1000),
      ...declarations(value)
    },
    collection: {
      provider: "local", externalId: required(collection.externalId, "本地合集标识"), name: required(collection.name, "本地合集名称", 1000),
      url: "", issueListUrl: "", declaredCount: null, declaredCountLabel: "", ...declarations({})
    },
    issueCode: text(row.suggestedIssueCode)
  };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photo_catalog_works (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, title_source TEXT NOT NULL,
      issue_code TEXT NOT NULL, issue_key TEXT NOT NULL, issue_source TEXT NOT NULL, release_date TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_catalog_issue ON photo_catalog_works(issue_key, id);
    CREATE INDEX IF NOT EXISTS idx_photo_catalog_recent ON photo_catalog_works(updated_at DESC, id);
    CREATE TABLE IF NOT EXISTS photo_catalog_archives (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES photo_catalog_works(id) ON DELETE CASCADE,
      archive_path TEXT NOT NULL, archive_identity TEXT NOT NULL,
      data_json TEXT NOT NULL, sort_order INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_catalog_archives_work ON photo_catalog_archives(work_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_photo_catalog_archive_category ON photo_catalog_archives(${ARCHIVE_CATEGORY}, work_id);
    CREATE TABLE IF NOT EXISTS photo_catalog_sources (
      provider TEXT NOT NULL, external_id TEXT NOT NULL,
      work_id TEXT NOT NULL REFERENCES photo_catalog_works(id) ON DELETE CASCADE,
      data_json TEXT NOT NULL, sort_order INTEGER NOT NULL, PRIMARY KEY(provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_photo_catalog_sources_work ON photo_catalog_sources(work_id, sort_order);
    CREATE TABLE IF NOT EXISTS photo_catalog_collections (
      work_id TEXT NOT NULL REFERENCES photo_catalog_works(id) ON DELETE CASCADE,
      collection_key TEXT NOT NULL, data_json TEXT NOT NULL, sort_order INTEGER NOT NULL,
      PRIMARY KEY(work_id, collection_key)
    );
    CREATE INDEX IF NOT EXISTS idx_photo_catalog_collection_key ON photo_catalog_collections(collection_key, work_id);
    CREATE TABLE IF NOT EXISTS photo_catalog_people (
      work_id TEXT NOT NULL REFERENCES photo_catalog_works(id) ON DELETE CASCADE,
      person_key TEXT NOT NULL, role TEXT NOT NULL, data_json TEXT NOT NULL, sort_order INTEGER NOT NULL,
      PRIMARY KEY(work_id, person_key, role)
    );
    CREATE INDEX IF NOT EXISTS idx_photo_catalog_person_key ON photo_catalog_people(person_key, work_id);
    CREATE TABLE IF NOT EXISTS photo_catalog_receipts (
      request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, work_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photo_catalog_redirects (
      source_id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES photo_catalog_works(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, CHECK(source_id<>target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_photo_catalog_redirect_target ON photo_catalog_redirects(target_id);
  `);
}

function insertWorkStatement(db) {
  return db.prepare(`INSERT INTO photo_catalog_works(id,title,title_source,issue_code,issue_key,issue_source,release_date,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
}

function appendLinks(db, workId, values, { table, columns, identity, conflict, project = row => row, refresh = [], mergeJson = false }) {
  if (!values.length) return;
  const next = db.prepare(`SELECT coalesce(max(sort_order),-1)+1 AS value FROM ${table} WHERE work_id=?`).get(workId).value;
  const params = Array.from({ length: columns.length + 3 }, () => "?").join(",");
  const data = mergeJson ? `json_patch(${table}.data_json,excluded.data_json)` : "excluded.data_json";
  const updates = [`data_json=${data}`, ...refresh.map(column => `${column}=excluded.${column}`)].join(",");
  const save = db.prepare(`INSERT INTO ${table} (work_id,${columns.join(",")},data_json,sort_order) VALUES (${params})
    ON CONFLICT(${conflict}) DO UPDATE SET ${updates} WHERE ${table}.work_id=excluded.work_id`);
  for (const [index, row] of values.entries()) save.run(workId, ...identity(row), JSON.stringify(project(row)), next + index);
}

function retainKnownFields(previous, row) {
  if (!previous) return row;
  return { ...JSON.parse(previous.data_json), ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== "" && value != null)) };
}

function mergeRelationships(db, targetId, donorId, timestamp) {
  db.prepare("UPDATE photo_catalog_sources SET work_id=? WHERE work_id=?").run(targetId, donorId);
  for (const { table, columns, identity } of [
    { table: "photo_catalog_collections", columns: ["collection_key"], identity: row => [collectionKey(row)] },
    { table: "photo_catalog_people", columns: ["person_key", "role"], identity: row => [personKey(row), row.role] }
  ]) {
    const read = db.prepare(`SELECT data_json FROM ${table} WHERE work_id=? ORDER BY sort_order,rowid`);
    const current = new Map(read.all(targetId).map(({ data_json: json }) => {
      const row = JSON.parse(json);
      return [JSON.stringify(identity(row)), row];
    }));
    const incoming = read.all(donorId).map(donorRow => {
      const localRow = current.get(JSON.stringify(identity(JSON.parse(donorRow.data_json))));
      return localRow ? retainKnownFields(donorRow, localRow) : JSON.parse(donorRow.data_json);
    });
    appendLinks(db, targetId, incoming, { table, columns, identity, conflict: ["work_id", ...columns].join(",") });
    db.prepare(`DELETE FROM ${table} WHERE work_id=?`).run(donorId);
  }
  db.prepare("UPDATE photo_catalog_redirects SET target_id=? WHERE target_id=?").run(targetId, donorId);
  db.prepare("INSERT INTO photo_catalog_redirects(source_id,target_id,created_at) VALUES (?,?,?)").run(donorId, targetId, timestamp);
  db.prepare("DELETE FROM photo_catalog_works WHERE id=?").run(donorId);
}

function hydrate(db, rows) {
  if (!rows.length) return [];
  const items = new Map(rows.map(row => [row.id, {
    ...workSummary(row),
    archives: [], sources: [], collections: [], people: [], createdAt: row.created_at, updatedAt: row.updated_at
  }]));
  const ids = [...items.keys()];
  const placeholders = ids.map(() => "?").join(",");
  const archives = db.prepare(`SELECT a.work_id,a.data_json,i.image_count,i.indexed_at
    FROM photo_catalog_archives a LEFT JOIN photo_set_image_indexes i ON ${ARCHIVE_IMAGE_JOIN}
    WHERE a.work_id IN (${placeholders}) ORDER BY a.sort_order,a.rowid`).all(ARCHIVE_IMAGE_INDEXER_VERSION, ...ids);
  for (const row of archives) {
    const { scanMtimeMs: _scanMtimeMs, ...archive } = JSON.parse(row.data_json);
    items.get(row.work_id).archives.push({ ...archive, measuredImageCount: row.image_count ?? null, measuredImageCountAt: row.indexed_at || "" });
  }
  for (const field of ["sources", "collections", "people"]) {
    const linked = db.prepare(`SELECT work_id,data_json FROM photo_catalog_${field} WHERE work_id IN (${placeholders}) ORDER BY sort_order,rowid`).all(...ids);
    for (const row of linked) items.get(row.work_id)[field].push(JSON.parse(row.data_json));
  }
  return [...items.values()].map(work => ({
    ...work,
    measuredImageCount: work.archives.length && work.archives.every(row => row.measuredImageCount != null)
      ? work.archives.reduce((sum, row) => sum + row.measuredImageCount, 0) : null,
    measuredSize: work.archives.length ? work.archives.reduce((sum, row) => sum + row.size, 0) : null
  }));
}

export function createPhotoCatalogService({
  getImageGalleryDb, photoSetById, resolvePersonId, now = () => new Date().toISOString(), createId = () => `pw_${randomUUID()}`
}) {
  const initialized = new WeakSet();
  const confirmationKey = randomBytes(32);

  function database() {
    const db = getImageGalleryDb();
    if (!initialized.has(db)) {
      ensureSchema(db);
      initialized.add(db);
    }
    return db;
  }

  function readArchive(db, id) {
    const album = photoSetById(id);
    if (!album || album.id !== id) return null;
    const candidate = safeChildPath(album.sourceRoot, album.relativePath);
    if (!candidate) return null;
    let signature;
    try {
      const safePath = ensureRealPathWithinRoots(candidate, [album.sourceRoot], "套图归档");
      signature = archiveDiskSignature(safePath, statSync(safePath));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code) || error.statusCode === 400) return null;
      throw error;
    }
    if (!signature) return null;
    const measured = db.prepare(`SELECT image_count,indexed_at FROM photo_set_image_indexes
      WHERE archive_path=? AND archive_identity=? AND indexer_version=?`).get(signature.archivePath, signature.archiveIdentity, ARCHIVE_IMAGE_INDEXER_VERSION);
    const modifiedAt = new Date(signature.archiveMtimeMs).toISOString();
    return {
      stamp: signature.archiveIdentity,
      path: signature.archivePath,
      personName: String(album.personName || ""),
      archive: {
        id, title: String(album.title || ""), category: String(album.category || ""),
        relativePath: String(album.relativePath || ""), rootLabel: String(album.rootLabel || ""),
        archiveExt: String(album.archiveExt || ""), size: signature.archiveSize, modifiedAt,
        coverUrl: `/media/gallery-cover/${encodeURIComponent(id)}?v=${encodeURIComponent(modifiedAt)}`
      },
      measuredImageCount: measured?.image_count ?? null, measuredImageCountAt: measured?.indexed_at || ""
    };
  }

  function resolvedPerson(row) {
    if (!row.personId || !resolvePersonId) return row;
    const result = resolvePersonId(row.personId);
    const personId = result && typeof result === "object" ? result.id : result;
    if (!personId) return null;
    return { ...row, personId: String(personId), name: row.name || text(result?.displayName || result?.name) };
  }

  function inspect(db, plan) {
    const conflicts = [], candidates = new Map();
    const readWork = db.prepare("SELECT * FROM photo_catalog_works WHERE id=?");
    const work = plan.workId ? readWork.get(plan.workId) : null;
    if (plan.workId && !work) conflicts.push({ code: "work-not-found", id: plan.workId });
    const donorId = plan.mergeWorkIds[1];
    const donor = donorId ? readWork.get(donorId) : null;
    if (donorId && !donor) conflicts.push({ code: "work-not-found", id: donorId });
    if (donor && work) {
      if (db.prepare("SELECT 1 FROM photo_catalog_sources WHERE work_id=? LIMIT 1").get(work.id)) {
        conflicts.push({ code: "merge-target-has-source", id: work.id });
      }
      if (db.prepare("SELECT 1 FROM photo_catalog_archives WHERE work_id=? LIMIT 1").get(donor.id)) {
        conflicts.push({ code: "merge-donor-has-archive", id: donor.id });
      }
    }
    function candidate(row, reason) {
      if (!row) return;
      const existing = candidates.get(row.id) || { id: row.id, title: row.title, issueCode: row.issue_code, reasons: [] };
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      candidates.set(row.id, existing);
    }
    function owner(ownerId, reason, id) {
      if (ownerId) candidate(readWork.get(ownerId), reason);
      const expected = reason === "source" && donorId ? donorId : work?.id;
      if (donorId && !ownerId) conflicts.push({ code: `merge-${reason}-unbound`, id });
      if (ownerId && ownerId !== expected) conflicts.push({ code: `${reason}-owned`, id, workId: ownerId });
    }
    const archiveOwner = db.prepare("SELECT work_id FROM photo_catalog_archives WHERE id=?");
    const sourceOwner = db.prepare("SELECT work_id FROM photo_catalog_sources WHERE provider=? AND external_id=?");
    const localRows = plan.archiveIds.map(id => {
      owner(archiveOwner.get(id)?.work_id, "archive", id);
      const row = readArchive(db, id);
      if (!row) conflicts.push({ code: "archive-not-found", id });
      return row;
    }).filter(Boolean);
    for (const source of plan.sources) {
      owner(sourceOwner.get(source.provider, source.externalId)?.work_id, "source", `${source.provider}:${source.externalId}`);
    }
    const fields = donor && work ? mergeFields(plan, work, donor, conflicts) : work;
    const issue = effectiveIssue(plan, fields);
    if (issue.value) {
      for (const row of db.prepare(`SELECT id,title,issue_code FROM photo_catalog_works
        WHERE issue_key=? AND id<>? ORDER BY id LIMIT 20`).all(key(issue.value), work?.id || "")) candidate(row, "issue-code");
    }
    const people = [];
    for (const row of plan.people) {
      const resolved = resolvedPerson(row);
      if (!resolved) conflicts.push({ code: "person-not-found", id: row.personId });
      else if (people.some(person => personKey(person) === personKey(resolved) && person.role === resolved.role)) {
        conflicts.push({ code: "person-duplicate", id: resolved.personId });
      } else people.push(resolved);
    }
    const personCandidates = [...new Set(localRows.map(row => row.personName).filter(Boolean))];
    return { work, donor, fields, localRows, people, issue, conflicts, candidates: [...candidates.values()], personCandidates };
  }

  function tokenFor(plan, state) {
    // The image-index cache can fill independently while a preview is open.
    const archives = state.localRows.map(({ stamp, personName, archive }) => [stamp, personName, archive]);
    return createHmac("sha256", confirmationKey).update(JSON.stringify([
      plan, state.work?.revision ?? null, state.donor?.revision ?? null, archives, state.people, state.conflicts, state.candidates
    ])).digest("hex");
  }

  function preview(input) {
    let plan = normalizePlan(input);
    const db = database();
    let state = inspect(db, plan);
    if (!plan.workId) {
      const owners = state.candidates.filter(row => row.reasons.includes("archive") || row.reasons.includes("source"));
      if (owners.length === 1) {
        plan = { ...plan, workId: owners[0].id };
        state = inspect(db, plan);
      }
    }
    return {
      plan, confirmationToken: state.conflicts.length ? "" : tokenFor(plan, state),
      candidates: state.candidates, conflicts: state.conflicts, personCandidates: state.personCandidates, issue: state.issue,
      merge: state.work && state.donor ? { target: workSummary(state.work), donor: workSummary(state.donor) } : null,
      archives: state.localRows.map(row => ({ ...row.archive,
        measuredImageCount: row.measuredImageCount, measuredImageCountAt: row.measuredImageCountAt }))
    };
  }

  function persist(db, plan, state, timestamp) {
    const work = state.fields;
    const workId = work?.id || createId();
    const archives = state.localRows.map(row => row.archive);
    const firstSource = plan.sources.find(row => row.title);
    const sourceTitle = firstSource?.title || (!archives.length ? plan.sources[0]?.externalId : "");
    const retainTitle = work && (work.title_source !== "archive" || !firstSource);
    const title = plan.title || (retainTitle ? work.title : sourceTitle || archives[0]?.title || "未命名套图");
    const titleSource = plan.title ? "manual" : retainTitle ? work.title_source : sourceTitle ? `source:${(firstSource || plan.sources[0]).provider}` : "archive";
    const { value: issueCode, source: issueSource } = state.issue;
    const releaseDate = plan.releaseDate ?? work?.release_date ?? "";
    if (work) {
      db.prepare(`UPDATE photo_catalog_works SET title=?,title_source=?,issue_code=?,issue_key=?,issue_source=?,release_date=?,
        revision=revision+1,updated_at=? WHERE id=?`).run(title, titleSource, issueCode, key(issueCode), issueSource, releaseDate, timestamp, workId);
    } else {
      insertWorkStatement(db).run(workId, title, titleSource, issueCode, key(issueCode), issueSource, releaseDate, timestamp, timestamp);
    }
    if (state.donor) mergeRelationships(db, workId, state.donor.id, timestamp);
    appendLinks(db, workId, state.localRows, {
      table: "photo_catalog_archives", columns: ["id", "archive_path", "archive_identity"], conflict: "id",
      identity: row => [row.archive.id, row.path, row.stamp], project: row => row.archive,
      refresh: ["archive_path", "archive_identity"], mergeJson: true
    });
    const sourceRow = db.prepare("SELECT data_json FROM photo_catalog_sources WHERE provider=? AND external_id=?");
    const sources = plan.sources.map(row => retainKnownFields(sourceRow.get(row.provider, row.externalId), row));
    appendLinks(db, workId, sources, { table: "photo_catalog_sources", columns: ["provider", "external_id"],
      identity: row => [row.provider, row.externalId], conflict: "provider,external_id" });
    const collectionRow = db.prepare("SELECT data_json FROM photo_catalog_collections WHERE work_id=? AND collection_key=?");
    const collections = plan.collections.map(row => retainKnownFields(collectionRow.get(workId, collectionKey(row)), row));
    appendLinks(db, workId, collections, { table: "photo_catalog_collections", columns: ["collection_key"],
      identity: row => [collectionKey(row)], conflict: "work_id,collection_key" });
    appendLinks(db, workId, state.people, { table: "photo_catalog_people", columns: ["person_key", "role"],
      identity: row => [personKey(row), row.role], conflict: "work_id,person_key,role" });
    return hydrate(db, [db.prepare("SELECT * FROM photo_catalog_works WHERE id=?").get(workId)])[0];
  }

  function confirm(input) {
    const { plan: rawPlan, confirmationToken: suppliedToken, requestId: suppliedId } = object(input);
    const plan = normalizePlan(rawPlan);
    const requestId = required(suppliedId, "确认请求标识", 120);
    const confirmationToken = required(suppliedToken, "预览确认凭证", 64);
    const fingerprint = createHash("sha256").update(JSON.stringify([plan, confirmationToken])).digest("hex");
    const db = database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = db.prepare("SELECT fingerprint,work_json FROM photo_catalog_receipts WHERE request_id=?").get(requestId);
      let work;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw catalogError("该确认请求标识已用于其他预览", 409, "PHOTO_CATALOG_REQUEST_CONFLICT");
        work = JSON.parse(receipt.work_json);
      } else {
        const state = inspect(db, plan);
        if (state.conflicts.length || !/^[a-f0-9]{64}$/u.test(confirmationToken)
          || !timingSafeEqual(Buffer.from(tokenFor(plan, state), "hex"), Buffer.from(confirmationToken, "hex"))) {
          throw catalogError("套图确认内容已变化，请重新预览", 409, "PHOTO_CATALOG_STALE");
        }
        const timestamp = now();
        work = persist(db, plan, state, timestamp);
        db.prepare("INSERT INTO photo_catalog_receipts VALUES (?,?,?,?)").run(requestId, fingerprint, JSON.stringify(work), timestamp);
      }
      db.exec("COMMIT");
      return { work, replayed: Boolean(receipt) };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function detail(value) {
    const id = text(value, 4096);
    if (!id) return null;
    const db = database();
    const row = db.prepare(`SELECT * FROM photo_catalog_works WHERE id=? OR id=(SELECT work_id FROM photo_catalog_archives WHERE id=?)
      OR id=(SELECT target_id FROM photo_catalog_redirects WHERE source_id=?)`).get(id, id, id);
    return row ? hydrate(db, [row])[0] : null;
  }

  // Used only by the local seed CLI after it validates the published scan.
  // Keep filesystem access out of the write transaction and never update existing owners.
  function seedScannedArchives(rows) {
    if (!Array.isArray(rows) || rows.length > MAX_SEED_BATCH) throw catalogError(`扫描登记每批最多 ${MAX_SEED_BATCH} 个归档`);
    if (!rows.length) return { inserted: 0, skipped: 0 };
    const db = database();
    const owner = db.prepare("SELECT 1 FROM photo_catalog_archives WHERE id=?");
    const insertWork = insertWorkStatement(db);
    const insertArchive = db.prepare(`INSERT INTO photo_catalog_archives(id,work_id,archive_path,archive_identity,data_json,sort_order)
      VALUES (?,?,?,?,?,0)`);
    const insertCollection = db.prepare(`INSERT INTO photo_catalog_collections(work_id,collection_key,data_json,sort_order)
      VALUES (?,?,?,0)`);
    const timestamp = now();
    let inserted = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const id = scannedArchiveId(object(object(row).archive).id);
        if (owner.get(id)) continue;
        const { archive, archivePath, archiveIdentity, collection, issueCode } = scannedArchive(row, id);
        const workId = createId();
        insertWork.run(workId, archive.title, "archive", issueCode, key(issueCode), issueCode ? "archive" : "", "", timestamp, timestamp);
        insertArchive.run(id, workId, archivePath, archiveIdentity, JSON.stringify(archive));
        insertCollection.run(workId, collectionKey(collection), JSON.stringify(collection));
        inserted += 1;
      }
      db.exec("COMMIT");
      return { inserted, skipped: rows.length - inserted };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function stats() {
    const db = database();
    const totals = db.prepare(`SELECT count(*) AS works,coalesce(sum(issue_code<>''),0) AS withIssue,
      coalesce(sum(EXISTS (SELECT 1 FROM photo_catalog_people p WHERE p.work_id=w.id)),0) AS withPeople,
      (SELECT count(DISTINCT collection_key) FROM photo_catalog_collections) AS collections,
      (SELECT count(DISTINCT person_key) FROM photo_catalog_people) AS people FROM photo_catalog_works w`).get();
    const byCategory = db.prepare(`SELECT ${ARCHIVE_CATEGORY} AS key,count(DISTINCT a.work_id) AS works,
      count(*) AS archives,sum(json_extract(a.data_json,'$.size')) AS bytes,count(i.image_count) AS measuredArchives,
      coalesce(sum(i.image_count),0) AS measuredImages,
      count(json_extract(a.data_json,'$.declaredImageCount')) AS declaredImageArchives,
      coalesce(sum(json_extract(a.data_json,'$.declaredImageCount')),0) AS declaredImages,
      count(json_extract(a.data_json,'$.declaredVideoCount')) AS declaredVideoArchives,
      coalesce(sum(json_extract(a.data_json,'$.declaredVideoCount')),0) AS declaredVideos,
      count(nullif(json_extract(a.data_json,'$.personHint'),'')) AS personHintArchives
      FROM photo_catalog_archives a LEFT JOIN photo_set_image_indexes i ON ${ARCHIVE_IMAGE_JOIN}
      GROUP BY ${ARCHIVE_CATEGORY} ORDER BY works DESC,key`).all(ARCHIVE_IMAGE_INDEXER_VERSION);
    const measures = ["archives", "bytes", "measuredArchives", "measuredImages", "declaredImageArchives", "declaredImages",
      "declaredVideoArchives", "declaredVideos", "personHintArchives"];
    const result = { ...totals, ...Object.fromEntries(measures.map(field => [field, 0])), categories: [] };
    for (const row of byCategory) {
      for (const field of measures) result[field] += row[field] || 0;
      result.categories.push({ key: row.key, name: row.key, works: row.works, archives: row.archives, bytes: row.bytes || 0 });
    }
    return result;
  }

  function list({ q, category, collection, person, limit, offset, scope, sort } = {}) {
    const db = database();
    const where = [], args = [];
    const query = text(q, 300).toLowerCase();
    const categoryFilter = text(category, 1000), collectionFilter = text(collection, 600), personFilter = text(person, 500);
    const pageLimit = Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(limit) || 24)));
    const pageOffset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(offset) || 0)));
    if (collectionFilter) {
      where.push(`EXISTS (SELECT 1 FROM photo_catalog_collections c WHERE c.work_id=w.id
        AND (c.collection_key=? OR json_extract(c.data_json,'$.name')=?))`);
      args.push(collectionFilter, collectionFilter);
    }
    if (personFilter) {
      where.push(`EXISTS (SELECT 1 FROM photo_catalog_people p WHERE p.work_id=w.id
        AND (p.person_key=? OR json_extract(p.data_json,'$.name')=? OR json_extract(p.data_json,'$.personId')=?))`);
      args.push(personFilter, personFilter, personFilter);
    }
    if (query) {
      where.push(`(instr(lower(w.title),?)>0 OR instr(lower(w.issue_code),?)>0
        OR EXISTS (SELECT 1 FROM photo_catalog_sources s WHERE s.work_id=w.id
          AND (instr(lower(json_extract(s.data_json,'$.title')),?)>0 OR instr(lower(json_extract(s.data_json,'$.issueCode')),?)>0
            OR instr(lower(json_extract(s.data_json,'$.issueLabel')),?)>0))
        OR EXISTS (SELECT 1 FROM photo_catalog_collections c WHERE c.work_id=w.id AND instr(lower(json_extract(c.data_json,'$.name')),?)>0)
        OR EXISTS (SELECT 1 FROM photo_catalog_people p WHERE p.work_id=w.id AND instr(lower(json_extract(p.data_json,'$.name')),?)>0))`);
      args.push(query, query, query, query, query, query, query);
    }
    const local = "EXISTS (SELECT 1 FROM photo_catalog_archives a WHERE a.work_id=w.id)";
    const source = "EXISTS (SELECT 1 FROM photo_catalog_sources s WHERE s.work_id=w.id)";
    const selection = filters => `FROM photo_catalog_works w${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}`;
    const scoped = scope === "local" ? local : scope === "source" ? source : "";
    const categorySelection = selection(scoped ? [...where, scoped] : where), categoryArgs = [...args];
    if (categoryFilter) {
      where.push(`w.id IN (SELECT work_id FROM photo_catalog_archives WHERE ${ARCHIVE_CATEGORY}=?)`);
      args.push(categoryFilter);
    }
    const countsRow = db.prepare(`SELECT count(*) AS total, coalesce(sum(${local}),0) AS local,
      coalesce(sum(${source}),0) AS source ${selection(where)}`).get(...args);
    if (scoped) where.push(scoped);
    const selected = selection(where);
    const counts = { local: countsRow.local, source: countsRow.source };
    const total = scope === "local" ? counts.local : scope === "source" ? counts.source : countsRow.total;
    const sortPrefix = sort === "release" ? "w.release_date DESC," : sort === "size"
      ? "(SELECT sum(json_extract(a.data_json,'$.size')) FROM photo_catalog_archives a WHERE a.work_id=w.id) DESC," : "";
    const items = hydrate(db, db.prepare(`SELECT w.* ${selected} ORDER BY ${sortPrefix}w.updated_at DESC,w.id LIMIT ? OFFSET ?`)
      .all(...args, pageLimit, pageOffset));
    function facets(table, column) {
      return db.prepare(`SELECT facet.${column} AS key, min(coalesce(nullif(json_extract(facet.data_json,'$.name'),''),
        json_extract(facet.data_json,'$.personId'))) AS name,count(DISTINCT facet.work_id) AS count
        FROM ${table} facet WHERE facet.work_id IN (SELECT w.id ${selected})
        GROUP BY facet.${column} ORDER BY count DESC,name,facet.${column} LIMIT 100`).all(...args).map(row => ({ ...row }));
    }
    const categories = db.prepare(`SELECT ${ARCHIVE_CATEGORY} AS key,count(DISTINCT work_id) AS count
      FROM photo_catalog_archives WHERE work_id IN (SELECT w.id ${categorySelection})
      GROUP BY ${ARCHIVE_CATEGORY} ORDER BY count DESC,key LIMIT 100`).all(...categoryArgs).map(row => ({ key: row.key, name: row.key, count: row.count }));
    return { items, total, counts, limit: pageLimit, offset: pageOffset,
      facets: { categories, collections: facets("photo_catalog_collections", "collection_key"), people: facets("photo_catalog_people", "person_key") } };
  }

  return { preview, confirm, detail, list, seedScannedArchives, stats };
}
