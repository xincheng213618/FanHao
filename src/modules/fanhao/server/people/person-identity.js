import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertActorProfileMutationAllowed } from "./actor-profile-mutation-guard.js";

export function identityError(message, code = "PERSON_IDENTITY_CONFLICT") {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

export function hasIdentityTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

export function personPathKey(value) {
  if (!String(value || "").trim()) return "";
  const text = String(value).trim();
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(text);
  const absolute = (windows ? path.win32 : path).resolve(text).replaceAll("\\", "/").replace(/\/+$/, "");
  return windows || process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function ensurePersonIdentitySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_identity_merges (
      operation_id TEXT PRIMARY KEY, target_id INTEGER NOT NULL REFERENCES people(id),
      source_ids_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_redirects (
      source_id INTEGER PRIMARY KEY REFERENCES people(id), target_id INTEGER NOT NULL REFERENCES people(id),
      operation_id TEXT NOT NULL REFERENCES person_identity_merges(operation_id), created_at TEXT NOT NULL,
      CHECK(source_id <> target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_person_redirects_target ON person_redirects(target_id);
    CREATE TABLE IF NOT EXISTS person_library_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people(id),
      path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_locations_person ON person_library_locations(person_id);
    CREATE TRIGGER IF NOT EXISTS person_external_identity_no_rebind
    BEFORE UPDATE OF person_id ON person_external_refs
    WHEN OLD.person_id <> NEW.person_id AND NOT EXISTS (
      SELECT 1 FROM person_redirects WHERE source_id = OLD.person_id AND target_id = NEW.person_id
    ) BEGIN SELECT RAISE(ABORT, 'PERSON_EXTERNAL_IDENTITY_OWNED: external identity belongs to another person; merge first'); END;
  `);
  for (const table of ["work_people", "person_external_refs", "person_aliases", "person_library_locations"]) {
    for (const action of ["INSERT", "UPDATE"]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_canonical_person_${action.toLowerCase()}
        BEFORE ${action} ON ${table}
        WHEN EXISTS (SELECT 1 FROM person_redirects WHERE source_id = NEW.person_id)
        BEGIN SELECT RAISE(ABORT, 'PERSON_ID_REDIRECTED: resolve canonical person before writing'); END;`);
    }
  }
  // Import only unambiguous declarations. Conflicting legacy paths remain visible
  // in the audit instead of assigning a directory to whichever row was read first.
  const groups = new Map();
  for (const row of db.prepare(`SELECT id, folder_path FROM people
    WHERE folder_path IS NOT NULL AND trim(folder_path) <> ''
      AND NOT EXISTS (SELECT 1 FROM person_redirects r WHERE r.source_id = people.id)`).all()) {
    const key = personPathKey(row.folder_path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO person_library_locations
    (person_id, path, path_key, source, created_at, updated_at) VALUES (?, ?, ?, 'legacy_folder_path', ?, ?)`);
  const now = new Date().toISOString();
  for (const [key, rows] of groups) if (key && rows.length === 1) insert.run(rows[0].id, rows[0].folder_path, key, now, now);
}

export function canonicalPersonId(db, personId) {
  let id = Number(personId);
  if (!Number.isSafeInteger(id) || id <= 0) return "";
  if (!hasIdentityTable(db, "person_redirects")) return String(id);
  const seen = new Set();
  const query = db.prepare("SELECT target_id FROM person_redirects WHERE source_id = ?");
  while (true) {
    if (seen.has(id)) throw identityError("人物合并关系存在循环", "PERSON_REDIRECT_CYCLE");
    seen.add(id);
    const row = query.get(id);
    if (!row) return String(id);
    id = Number(row.target_id);
  }
}

export function personIdentityMembers(db, personId) {
  const target = canonicalPersonId(db, personId);
  if (!target) return [];
  if (!hasIdentityTable(db, "person_redirects")) return [Number(target)];
  return [Number(target), ...db.prepare("SELECT source_id FROM person_redirects WHERE target_id = ? ORDER BY source_id")
    .all(Number(target)).map((row) => Number(row.source_id))];
}

export function personLocations(db, personId) {
  if (!hasIdentityTable(db, "person_library_locations")) return [];
  return db.prepare("SELECT * FROM person_library_locations WHERE person_id = ? ORDER BY id").all(Number(canonicalPersonId(db, personId)));
}

export function bindPersonLocation(db, personId, value) {
  if (!value || !hasIdentityTable(db, "person_library_locations")) return;
  const id = Number(canonicalPersonId(db, personId));
  const key = personPathKey(value);
  const owner = db.prepare("SELECT person_id FROM person_library_locations WHERE path_key = ?").get(key);
  if (owner && Number(owner.person_id) !== id) throw identityError("该目录已经绑定其他人物，请先合并人物", "PERSON_LOCATION_OWNED");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO person_library_locations (person_id, path, path_key, source, created_at, updated_at)
    VALUES (?, ?, ?, 'explicit', ?, ?) ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at`)
    .run(id, value, key, now, now);
}

export function assertExternalIdentityOwner(db, personId, actorKeys) {
  const id = canonicalPersonId(db, personId);
  for (const key of actorKeys || []) {
    const owner = db.prepare("SELECT person_id FROM person_external_refs WHERE provider = 'javdb-actor' AND external_key = ?").get(key);
    if (owner && canonicalPersonId(db, owner.person_id) !== id) {
      throw identityError(`该 JavDB 身份已属于人物 ${owner.person_id}，请先合并人物`, "PERSON_EXTERNAL_IDENTITY_OWNED");
    }
  }
}

export function findPersonByIdentity(db, { personId, actorKey, folderPath, name } = {}) {
  if (personId) return db.prepare("SELECT * FROM people WHERE id = ?").get(Number(canonicalPersonId(db, personId))) || null;
  if (actorKey) {
    const ref = db.prepare("SELECT person_id FROM person_external_refs WHERE provider = 'javdb-actor' AND external_key = ?").get(actorKey);
    if (ref) return findPersonByIdentity(db, { personId: ref.person_id });
  }
  if (folderPath && hasIdentityTable(db, "person_library_locations")) {
    const location = db.prepare("SELECT person_id FROM person_library_locations WHERE path_key = ?").get(personPathKey(folderPath));
    if (location) return findPersonByIdentity(db, { personId: location.person_id });
  }
  const key = String(name || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!key) return null;
  const matches = new Map();
  const rows = db.prepare(`SELECT p.* FROM people p WHERE p.name_search = ? OR lower(trim(p.name)) = ?
    OR lower(trim(p.display_name)) = ? OR EXISTS (SELECT 1 FROM person_aliases a WHERE a.person_id = p.id AND a.alias_search = ?)`).all(key, key, key, key);
  for (const row of rows) {
    if (canonicalPersonId(db, row.id) !== String(row.id)) continue;
    const canonical = findPersonByIdentity(db, { personId: row.id });
    if (canonical) matches.set(canonical.id, canonical);
  }
  if (matches.size > 1) throw identityError("同名人物不唯一，请选择已有人物或先合并", "PERSON_NAME_AMBIGUOUS");
  return [...matches.values()][0] || null;
}

function assertNoIdentityJobs(db, ids) {
  const marks = ids.map(() => "?").join(",");
  if (hasIdentityTable(db, "person_folder_operations") && db.prepare(`SELECT 1 FROM person_folder_operations
    WHERE person_id IN (${marks}) AND status IN ('prepared','filesystem_moved','applying','blocked') LIMIT 1`).get(...ids)) {
    throw identityError("人物目录操作尚未完成，请完成后再合并", "PERSON_FOLDER_OPERATION_ACTIVE");
  }
  // Job JSON retains historical IDs. Active moves must finish before identity changes.
  if (hasIdentityTable(db, "work_move_path_reservations") && db.prepare("SELECT 1 FROM work_move_path_reservations WHERE released_at = '' LIMIT 1").get()) {
    throw identityError("作品移动任务尚未完成，请完成后再合并", "PERSON_MOVE_ACTIVE");
  }
}

export function previewPersonMerge(db, targetPersonId, sourcePersonIds = [], options = {}) {
  if (!Array.isArray(sourcePersonIds) || sourcePersonIds.length > 100) throw identityError("每次合并必须指定 1 至 100 个人物");
  const targetId = Number(canonicalPersonId(db, targetPersonId));
  const target = db.prepare("SELECT * FROM people WHERE id = ?").get(targetId);
  if (!target) throw identityError("目标人物不存在", "PERSON_NOT_FOUND");
  const requested = [...new Set(sourcePersonIds.map(Number))];
  if (!requested.length || requested.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw identityError("合并来源无效");
  const ids = [...new Set(requested.map((id) => Number(canonicalPersonId(db, id))))].filter((id) => id !== targetId);
  const sources = ids.map((id) => db.prepare("SELECT * FROM people WHERE id = ?").get(id));
  if (sources.some((row) => !row)) throw identityError("来源人物不存在", "PERSON_NOT_FOUND");
  const rows = [target, ...sources];
  const members = rows.map((person) => ({
    person,
    aliases: db.prepare("SELECT * FROM person_aliases WHERE person_id = ? ORDER BY id").all(person.id),
    refs: db.prepare("SELECT * FROM person_external_refs WHERE person_id = ? ORDER BY id").all(person.id),
    works: db.prepare("SELECT * FROM work_people WHERE person_id = ? ORDER BY work_id, role").all(person.id),
    locations: personLocations(db, person.id)
  }));
  const externalKeys = new Set(members.flatMap((m) => m.refs.filter((r) => r.provider === "javdb-actor").map((r) => r.external_key)));
  const warnings = externalKeys.size > 1 ? ["这些人物包含不同的 JavDB 身份，请确认均属于同一人"] : [];
  return { targetId: String(targetId), sourceIds: ids.map(String), members, warnings,
    displayName: String(options.displayName || target.display_name || target.name).trim().slice(0, 200),
    workCount: new Set(members.flatMap((m) => m.works.filter((w) => w.role === "actor").map((w) => w.work_id))).size };
}

export function mergePersonIdentities(db, targetPersonId, sourcePersonIds, options = {}) {
  ensurePersonIdentitySchema(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = previewPersonMerge(db, targetPersonId, sourcePersonIds, options);
    if (!plan.sourceIds.length) {
      db.exec("COMMIT");
      return { targetPersonId: plan.targetId, mergedPersonIds: [], alreadyMerged: true };
    }
    if (plan.warnings.length && !options.confirmDifferentExternalIds) throw identityError(plan.warnings[0], "PERSON_EXTERNAL_ID_CONFLICT");
    const ids = [Number(plan.targetId), ...plan.sourceIds.map(Number)];
    assertActorProfileMutationAllowed(db, ids);
    assertNoIdentityJobs(db, ids);
    const operationId = randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO person_identity_merges VALUES (?, ?, ?, ?, ?)")
      .run(operationId, ids[0], JSON.stringify(plan.sourceIds), JSON.stringify(plan), now);
    const alias = db.prepare("INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source) VALUES (?, ?, ?, 'identity_merge')");
    const addAlias = (name) => {
      const value = String(name || "").trim();
      if (value) alias.run(ids[0], value, value.toLowerCase().replace(/\s+/g, ""));
    };
    for (const member of plan.members) {
      if (options.preserveSourceNames !== false || member.person.id === ids[0]) {
        for (const name of [member.person.name, member.person.display_name, ...member.aliases.map((a) => a.alias)]) addAlias(name);
      }
    }
    for (const sourceId of ids.slice(1)) {
      db.prepare("UPDATE person_redirects SET target_id = ? WHERE target_id = ?").run(ids[0], sourceId);
      db.prepare("INSERT INTO person_redirects VALUES (?, ?, ?, ?)").run(sourceId, ids[0], operationId, now);
      db.prepare(`INSERT INTO work_people(work_id, person_id, role, sort_order, source, created_at, updated_at)
        SELECT work_id, ?, role, sort_order, source, created_at, ? FROM work_people WHERE person_id = ?
        ON CONFLICT(work_id, person_id, role) DO UPDATE SET sort_order = min(work_people.sort_order, excluded.sort_order),
          source = CASE WHEN work_people.source = 'actor_movies' OR excluded.source = 'actor_movies' THEN 'actor_movies' ELSE work_people.source END,
          updated_at = excluded.updated_at`)
        .run(ids[0], now, sourceId);
      db.prepare("DELETE FROM work_people WHERE person_id = ?").run(sourceId);
      db.prepare("UPDATE person_external_refs SET person_id = ?, updated_at = ? WHERE person_id = ?").run(ids[0], now, sourceId);
      db.prepare("UPDATE person_library_locations SET person_id = ?, updated_at = ? WHERE person_id = ?").run(ids[0], now, sourceId);
      // Keep source rows, aliases, images, immutable avatar publications and job
      // receipts for provenance. A merge commits exclusively to the main DB.
      db.prepare("UPDATE people SET status = 'merged', updated_at = ? WHERE id = ?").run(now, sourceId);
    }
    for (const member of plan.members) if (member.person.folder_path) bindPersonLocation(db, ids[0], member.person.folder_path);
    const target = plan.members[0].person;
    const gender = [target, ...plan.members.slice(1).map((m) => m.person)].map((p) => p.gender).find((g) => g && g !== "unknown") || "unknown";
    const folder = personLocations(db, ids[0])[0]?.path || target.folder_path || null;
    db.prepare(`UPDATE people SET display_name = ?, gender = ?, folder_path = ?,
      movie_count = ?, updated_at = ? WHERE id = ?`).run(plan.displayName, gender, folder, plan.workCount, now, ids[0]);
    db.exec("COMMIT");
    return { targetPersonId: plan.targetId, mergedPersonIds: plan.sourceIds, operationId };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
