import fs from "node:fs";
import path from "node:path";

export function createAdminCoreMutationService({
  actorIdFromJavdbUrl,
  actorProfileRow,
  canonicalJavdbActorUrl,
  canonicalJavdbActorUrls,
  cleanPersonNamePart,
  coreLocalPathPersonName,
  coreLocalPersonSourcePath,
  corePersonFallbackRecord,
  ensureLibraryDirectoryPath,
  getCoreDb,
  invalidateActorMovies,
  invalidateActorProfiles,
  invalidatePersonMerge,
  invalidateTableStamp,
  hasCoreDb,
  libraryOpenRoots,
  normalizePersonGender,
  normalizePersonSearchValue,
  parseJsonArray,
  publicActorProfile,
  publicMergedPersonById,
  publicPerson,
  publicWork,
  reconcileMovedLocalWork,
  refreshLibrary,
  relativeFromRoot,
  replacePathPrefix,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  safeStat,
  sourcePathToAbsolute,
  resetWorkSearch,
  uniqueTextArray,
  uniquePersonNames
}) {
  function safeDirectoryName(value, fallback = "新人物") {
    const clean = cleanPersonNamePart(value) || fallback;
    const safe = clean
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
      .replace(/[. ]+$/g, "")
      .trim();
    return (safe || fallback).slice(0, 120);
  }

  function libraryRootForNewPerson(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      const error = new Error("请选择保存硬盘");
      error.statusCode = 400;
      throw error;
    }
    const root = sourcePathToAbsolute(raw);
    const matchedRoot = libraryOpenRoots().find((rootPath) => path.resolve(rootPath).toLowerCase() === path.resolve(root).toLowerCase());
    if (!matchedRoot) {
      const error = new Error("保存硬盘不在资料库根目录中");
      error.statusCode = 400;
      throw error;
    }
    if (!safeStat(matchedRoot)?.isDirectory()) {
      const error = new Error("保存硬盘不可用");
      error.statusCode = 404;
      throw error;
    }
    return matchedRoot;
  }

  function createOrUpdateMoveTargetPerson(db, payload = {}) {
    const displayName = cleanPersonNamePart(payload.displayName || payload.name);
    const name = cleanPersonNamePart(payload.name || displayName);
    const nameSearch = normalizePersonSearchValue(name);
    if (!name || !nameSearch) {
      const error = new Error("请填写演员名");
      error.statusCode = 400;
      throw error;
    }

    const inputActorUrl = String(payload.javdbUrl || payload.actorUrl || "").trim();
    const javdbUrl = canonicalJavdbActorUrl(inputActorUrl);
    if (inputActorUrl && !javdbUrl) {
      const error = new Error("请输入 JavDB actor 页面链接，例如 https://javdb.com/actors/BzpA");
      error.statusCode = 400;
      throw error;
    }
    const actorKey = actorIdFromJavdbUrl(javdbUrl);

    const root = libraryRootForNewPerson(payload.rootPath || payload.root);
    const folderName = safeDirectoryName(payload.folderName || displayName || name, name);
    const folderPath = ensureLibraryDirectoryPath(path.join(root, folderName), "目标人物文件夹");
    fs.mkdirSync(folderPath, { recursive: true });

    const now = new Date().toISOString();
    const existing = db
      .prepare(
        `
        SELECT *
        FROM people
        WHERE name_search = ?
           OR lower(trim(name)) = lower(trim(?))
           OR lower(trim(COALESCE(display_name, ''))) = lower(trim(?))
        ORDER BY
          CASE WHEN name = ? OR display_name = ? THEN 0 ELSE 1 END,
          id ASC
        LIMIT 1
        `
      )
      .get(nameSearch, name, displayName || name, name, displayName || name);

    let personId;
    if (existing?.id) {
      personId = Number(existing.id);
      db
        .prepare(
          `
          UPDATE people
          SET
            display_name = COALESCE(NULLIF(?, ''), display_name),
            folder_path = COALESCE(NULLIF(?, ''), folder_path),
            gender = COALESCE(NULLIF(?, ''), gender),
            source = CASE WHEN source IS NULL OR source = '' THEN 'manual_move' ELSE source END,
            updated_at = ?
          WHERE id = ?
          `
        )
        .run(displayName || name, folderPath, normalizePersonGender(payload.gender || existing.gender || "unknown"), now, personId);
    } else {
      const result = db
        .prepare(
          `
          INSERT INTO people (name, name_search, display_name, folder_path, movie_count, status, error, source, created_at, updated_at, gender)
          VALUES (?, ?, ?, ?, 0, 'ok', NULL, 'manual_move', ?, ?, ?)
          `
        )
        .run(name, nameSearch, displayName || name, folderPath, now, now, normalizePersonGender(payload.gender || "unknown"));
      personId = Number(result.lastInsertRowid);
    }

    if (actorKey) {
      db.prepare(
        `
        INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
        VALUES (?, 'javdb-actor', ?, ?, 'manual_move', ?, ?)
        ON CONFLICT(provider, external_key) DO UPDATE SET
          person_id = excluded.person_id,
          url = excluded.url,
          source = excluded.source,
          updated_at = excluded.updated_at
        `
      ).run(personId, actorKey, javdbUrl, now, now);
    }

    const aliases = uniquePersonNames(Array.isArray(payload.aliases) ? payload.aliases : []);
    if (aliases.length) {
      const insertAlias = db.prepare("INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source) VALUES (?, ?, ?, 'manual_move')");
      const primaryKey = normalizePersonSearchValue(displayName || name);
      for (const alias of aliases) {
        const key = normalizePersonSearchValue(alias);
        if (key && key !== primaryKey) insertAlias.run(personId, alias, key);
      }
    }

    invalidateTableStamp("actor_profiles", "actor_movies");
    invalidateActorProfiles();
    invalidatePersonMerge();
    return {
      id: String(personId),
      name: displayName || name,
      targetDirectory: folderPath,
      created: !existing?.id
    };
  }

  function targetDirectoryForPerson(person, db, options = {}) {
    const explicitPath = String(options.targetDirectory || options.targetPath || "").trim();
    if (explicitPath) {
      const fullPath = ensureLibraryDirectoryPath(explicitPath, "目标人物文件夹");
      if (!safeStat(fullPath)?.isDirectory()) {
        const error = new Error("目标人物文件夹不存在");
        error.statusCode = 404;
        throw error;
      }
      return fullPath;
    }

    const sourcePaths = uniqueTextArray([person?.relativePath, ...(person?.sourcePaths || [])]);
    for (const sourcePath of sourcePaths) {
      const fullPath = ensureLibraryDirectoryPath(sourcePath, "目标人物文件夹");
      if (safeStat(fullPath)?.isDirectory()) return fullPath;
    }

    const rows = db
      .prepare(
        `
        SELECT lw.local_path
        FROM local_works lw
        JOIN work_people wp ON wp.work_id = lw.work_id
        WHERE wp.person_id = ?
          AND wp.role = 'actor'
          AND lw.local_path IS NOT NULL
          AND lw.local_path <> ''
        ORDER BY lw.local_path
        `
      )
      .all(Number(person.id));
    for (const row of rows) {
      const fullPath = ensureLibraryDirectoryPath(coreLocalPersonSourcePath(row.local_path), "目标人物文件夹");
      if (safeStat(fullPath)?.isDirectory()) return fullPath;
    }

    const personName = String(person?.name || "").trim();
    for (const rootPath of libraryOpenRoots()) {
      const candidate = path.join(rootPath, personName);
      if (personName && safeStat(candidate)?.isDirectory()) return ensureLibraryDirectoryPath(candidate, "目标人物文件夹");
    }

    const error = new Error("没有找到目标人物文件夹");
    error.statusCode = 404;
    throw error;
  }

  function correctedActorFieldsJson(fieldsJson, actorName) {
    const fields = parseJsonArray(fieldsJson);
    const cleanName = String(actorName || "").trim();
    if (!cleanName) return JSON.stringify(fields);

    let replaced = false;
    const nextFields = fields.map((field) => {
      const label = String(field?.label || field?.name || "").trim();
      if (!/^(演员|演員|女优|女優|actor|actors|actor_names)$/i.test(label)) return field;
      replaced = true;
      return { ...field, label: field.label || "演员", value: cleanName };
    });
    if (!replaced) nextFields.push({ label: "演员", value: cleanName });
    return JSON.stringify(nextFields);
  }

  function findOrCreateCorePersonByName(db, name, folderPath = "") {
    const cleanName = String(name || "").trim();
    const nameSearch = normalizePersonSearchValue(cleanName);
    if (!cleanName || !nameSearch) {
      const error = new Error("演员名无效");
      error.statusCode = 400;
      throw error;
    }

    const existing = db
      .prepare(
        `
        SELECT *
        FROM people
        WHERE name_search = ?
           OR lower(trim(name)) = lower(trim(?))
           OR lower(trim(COALESCE(display_name, ''))) = lower(trim(?))
        ORDER BY
          CASE WHEN name = ? OR display_name = ? THEN 0 ELSE 1 END,
          id ASC
        LIMIT 1
        `
      )
      .get(nameSearch, cleanName, cleanName, cleanName, cleanName);
    if (existing?.id) return existing;

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `
        INSERT INTO people (name, name_search, display_name, folder_path, movie_count, status, error, source, created_at, updated_at, gender)
        VALUES (?, ?, ?, ?, 0, 'ok', NULL, 'local_folder_correction', ?, ?, 'unknown')
        `
      )
      .run(cleanName, nameSearch, cleanName, folderPath || null, now, now);
    invalidateTableStamp("actor_profiles");
    invalidateActorProfiles();
    invalidatePersonMerge();
    return db.prepare("SELECT * FROM people WHERE id = ?").get(Number(result.lastInsertRowid));
  }

  function upsertActorProfile(person, payload) {
    const now = new Date().toISOString();
    const hasActorUrlInput = Object.hasOwn(payload, "javdbUrl") || Object.hasOwn(payload, "javdbUrls") || Object.hasOwn(payload, "actorUrls");
    const rawActorUrls = Object.hasOwn(payload, "javdbUrls")
      ? payload.javdbUrls
      : Object.hasOwn(payload, "actorUrls")
        ? payload.actorUrls
        : payload.javdbUrl;
    const javdbUrls = hasActorUrlInput ? canonicalJavdbActorUrls(rawActorUrls) : [];
    const inputActorText = Array.isArray(rawActorUrls) ? rawActorUrls.join("\n") : String(rawActorUrls || "").trim();
    if (inputActorText && !javdbUrls.length) {
      const error = new Error("请输入 JavDB actor 页面链接，例如 https://javdb.com/actors/BzpA");
      error.statusCode = 400;
      throw error;
    }

    const avatarBase64 = typeof payload.avatarBase64 === "string" ? payload.avatarBase64 : "";
    const avatarBlob = avatarBase64 ? Buffer.from(avatarBase64, "base64") : null;
    const movieCount = Number.isFinite(Number(payload.movieCount)) ? Number(payload.movieCount) : null;

    const existing = actorProfileRow(person.id);
    const displayName = cleanPersonNamePart(payload.displayName) || existing?.display_name || person.name;
    const gender = normalizePersonGender(payload.gender || existing?.gender || person.gender || "unknown");
    const hasAliasesInput = Array.isArray(payload.aliases) || typeof payload.aliases === "string";
    const inputAliases = Array.isArray(payload.aliases)
      ? payload.aliases
      : typeof payload.aliases === "string"
        ? [payload.aliases]
        : [];
    const displayNameKey = normalizePersonSearchValue(displayName);
    const aliases = uniquePersonNames(inputAliases).filter((alias) => normalizePersonSearchValue(alias) !== displayNameKey);
    const avatarMime = payload.avatarMime || (avatarBlob ? "image/jpeg" : existing?.avatar_mime || null);

    const corePersonId = Number(person.id);
    const db = getCoreDb();
    db
      .prepare(
        `
        UPDATE people
        SET
          name = COALESCE(NULLIF(?, ''), name),
          name_search = COALESCE(NULLIF(?, ''), name_search),
          display_name = COALESCE(NULLIF(?, ''), display_name),
          gender = ?,
          movie_count = ?,
          source = COALESCE(NULLIF(?, ''), source),
          status = ?,
          error = ?,
          updated_at = ?
        WHERE id = ?
        `
      )
      .run(person.name, normalizePersonSearchValue(person.name), displayName, gender, movieCount, payload.source || existing?.source || "manual", payload.status || "ok", payload.error || null, now, corePersonId);

    if (hasActorUrlInput) {
      db.prepare("DELETE FROM person_external_refs WHERE person_id = ? AND provider = 'javdb-actor'").run(corePersonId);
      const insertRef = db.prepare(
        `
        INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
        VALUES (?, 'javdb-actor', ?, ?, ?, ?, ?)
        ON CONFLICT(provider, external_key) DO UPDATE SET
          person_id = excluded.person_id,
          url = excluded.url,
          source = excluded.source,
          updated_at = excluded.updated_at
        `
      );
      for (const url of javdbUrls) {
        insertRef.run(corePersonId, actorIdFromJavdbUrl(url), url, payload.source || "manual", now, now);
      }
    } else if (payload.javdbActorId || existing?.javdb_actor_id) {
      const actorKey = payload.javdbActorId || existing?.javdb_actor_id || "";
      const finalJavdbUrl = existing?.javdb_url || (actorKey ? `https://javdb.com/actors/${actorKey}` : "");
      if (actorKey) {
        db.prepare(
          `
          INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
          VALUES (?, 'javdb-actor', ?, ?, ?, ?, ?)
          ON CONFLICT(provider, external_key) DO UPDATE SET
            person_id = excluded.person_id,
            url = COALESCE(NULLIF(excluded.url, ''), person_external_refs.url),
            updated_at = excluded.updated_at
          `
        ).run(corePersonId, actorKey, finalJavdbUrl, payload.source || "manual", now, now);
      }
    }

    if (hasAliasesInput) {
      const aliasSource = payload.source || "manual";
      db.prepare("DELETE FROM person_aliases WHERE person_id = ? AND source = ?").run(corePersonId, aliasSource);
      const insertAlias = db.prepare("INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source) VALUES (?, ?, ?, ?)");
      for (const alias of aliases) insertAlias.run(corePersonId, alias, normalizePersonSearchValue(alias), aliasSource);
    }

    const avatarUrl = payload.sourceAvatarUrl || payload.avatarUrl || existing?.avatar_url || "";
    if (avatarBlob || avatarUrl) {
      db.prepare(
        `
        INSERT INTO fanhao_images.images (
          owner_type, owner_id, kind, source_type, remote_url, mime, image_blob, byte_size,
          sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
        )
        VALUES ('person', ?, 'avatar', ?, ?, ?, ?, ?, 0, 'ok', ?, 'manual', ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          remote_url = excluded.remote_url,
          mime = COALESCE(excluded.mime, images.mime),
          image_blob = COALESCE(excluded.image_blob, images.image_blob),
          byte_size = COALESCE(excluded.byte_size, images.byte_size),
          status = excluded.status,
          source = excluded.source,
          legacy_table = excluded.legacy_table,
          legacy_key = excluded.legacy_key,
          updated_at = excluded.updated_at
        `
      ).run(
        corePersonId,
        avatarUrl.startsWith("http://") || avatarUrl.startsWith("https://") ? "remote" : avatarUrl ? "local" : "unknown",
        avatarUrl,
        avatarMime || "image/jpeg",
        avatarBlob,
        avatarBlob?.length || null,
        payload.source || "manual",
        person.id,
        now,
        now
      );
    }

    if (hasActorUrlInput) {
      invalidateActorMovies();
    }
    invalidateTableStamp("actor_profiles", "actor_movies");
    invalidateActorProfiles();
    invalidateActorMovies();
    invalidatePersonMerge();

    return publicActorProfile(actorProfileRow(person.id));
  }

  function mergePeopleIntoTarget(targetPersonId, sourcePersonIds = []) {
    if (!hasCoreDb()) {
      const error = new Error("core DB 不可用");
      error.statusCode = 500;
      throw error;
    }
    const targetId = Number(targetPersonId);
    const sourceIds = uniqueTextArray(sourcePersonIds).map(Number).filter((id) => Number.isFinite(id) && id !== targetId);
    if (!Number.isFinite(targetId) || !sourceIds.length) {
      const error = new Error("合并人物参数无效");
      error.statusCode = 400;
      throw error;
    }

    const db = getCoreDb();
    const target = db.prepare("SELECT id, name, display_name FROM people WHERE id = ?").get(targetId);
    if (!target?.id) {
      const error = new Error("目标人物不存在");
      error.statusCode = 404;
      throw error;
    }

    const sources = sourceIds.map((id) => db.prepare("SELECT id, name, display_name FROM people WHERE id = ?").get(id)).filter(Boolean);
    if (!sources.length) {
      const error = new Error("没有可合并的来源人物");
      error.statusCode = 404;
      throw error;
    }

    const now = new Date().toISOString();
    const targetPrimaryKeys = new Set(uniquePersonNames([target.name, target.display_name]).map(normalizePersonSearchValue).filter(Boolean));
    const insertAlias = db.prepare("INSERT OR IGNORE INTO person_aliases(person_id, alias, alias_search, source) VALUES (?, ?, ?, 'manual_merge')");
    const sourceAliases = db.prepare("SELECT alias FROM person_aliases WHERE person_id = ? ORDER BY id");
    const sourceWorkPeople = db.prepare("SELECT work_id, role, sort_order, source, created_at FROM work_people WHERE person_id = ?");
    const insertWorkPerson = db.prepare(
      `
      INSERT OR IGNORE INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'manual_merge', ?, ?)
      `
    );
    const sourceRefs = db.prepare("SELECT id, provider, external_key, url, source, created_at FROM person_external_refs WHERE person_id = ?");
    const targetRefExists = db.prepare("SELECT id FROM person_external_refs WHERE person_id = ? AND provider = ? AND external_key = ?");
    const updateRef = db.prepare("UPDATE person_external_refs SET person_id = ?, source = 'manual_merge', updated_at = ? WHERE id = ?");
    const deleteRef = db.prepare("DELETE FROM person_external_refs WHERE id = ?");

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const source of sources) {
        for (const alias of uniquePersonNames([source.name, source.display_name, ...sourceAliases.all(source.id).map((row) => row.alias)])) {
          const key = normalizePersonSearchValue(alias);
          if (key && !targetPrimaryKeys.has(key)) insertAlias.run(targetId, alias, key);
        }

        for (const row of sourceWorkPeople.all(source.id)) {
          insertWorkPerson.run(row.work_id, targetId, row.role || "actor", row.sort_order || 0, row.created_at || now, now);
        }
        db.prepare("DELETE FROM work_people WHERE person_id = ?").run(source.id);

        for (const ref of sourceRefs.all(source.id)) {
          if (ref.provider === "javdb-actor" && targetRefExists.get(targetId, ref.provider, ref.external_key)) {
            deleteRef.run(ref.id);
            continue;
          }
          if (targetRefExists.get(targetId, ref.provider, ref.external_key)) {
            deleteRef.run(ref.id);
          } else {
            updateRef.run(targetId, now, ref.id);
          }
        }

        db.prepare("UPDATE fanhao_images.images SET owner_id = ?, updated_at = ? WHERE owner_type = 'person' AND owner_id = ?").run(targetId, now, source.id);
        db.prepare("DELETE FROM person_aliases WHERE person_id = ?").run(source.id);
        db.prepare("DELETE FROM people WHERE id = ?").run(source.id);
      }
      db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").run(now, targetId);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    invalidateTableStamp("actor_profiles", "actor_movies", "work_info", "work_covers");
    invalidateActorProfiles();
    invalidateActorMovies();
    invalidatePersonMerge();
    resetWorkSearch();
    refreshLibrary();

    return {
      targetPersonId: String(targetId),
      mergedPersonIds: sources.map((source) => String(source.id)),
      person: publicMergedPersonById(String(targetId))
    };
  }

  function correctWorkActorFromLocalFolder(workId) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work || work.missingLocal) {
      const error = new Error("作品本地文件不存在");
      error.statusCode = 404;
      throw error;
    }
    if (!hasCoreDb()) {
      const error = new Error("core DB 不可用");
      error.statusCode = 500;
      throw error;
    }

    const db = getCoreDb();
    const coreWorkId = Number(work.id);
    if (!Number.isFinite(coreWorkId)) {
      const error = new Error("作品编号无效");
      error.statusCode = 400;
      throw error;
    }

    const row = db
      .prepare(
        `
        SELECT local_path
        FROM local_works
        WHERE work_id = ?
          AND local_path IS NOT NULL
          AND local_path <> ''
        ORDER BY id
        LIMIT 1
        `
      )
      .get(coreWorkId);
    const actorName = coreLocalPathPersonName(row?.local_path || "");
    if (!actorName) {
      const error = new Error("没有从本地文件夹识别出演员名");
      error.statusCode = 400;
      throw error;
    }

    const person = findOrCreateCorePersonByName(db, actorName, coreLocalPersonSourcePath(row.local_path));
    const before = db
      .prepare(
        `
        SELECT CAST(wp.person_id AS TEXT) AS person_id, p.name
        FROM work_people wp
        JOIN people p ON p.id = wp.person_id
        WHERE wp.work_id = ?
          AND wp.role = 'actor'
        ORDER BY wp.sort_order, wp.person_id
        `
      )
      .all(coreWorkId);

    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM work_people WHERE work_id = ? AND role = 'actor' AND person_id <> ?").run(coreWorkId, Number(person.id));
      db
        .prepare(
          `
          INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
          VALUES (?, ?, 'actor', 0, 'local_folder_correction', ?, ?)
          ON CONFLICT(work_id, person_id, role) DO UPDATE SET
            sort_order = 0,
            source = excluded.source,
            updated_at = excluded.updated_at
          `
        )
        .run(coreWorkId, Number(person.id), now, now);
      const workRow = db.prepare("SELECT fields_json FROM works WHERE id = ?").get(coreWorkId);
      const fieldsJson = correctedActorFieldsJson(workRow?.fields_json, actorName);
      db.prepare("UPDATE works SET fields_json = ?, updated_at = ? WHERE id = ?").run(fieldsJson, now, coreWorkId);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    invalidateTableStamp("actor_movies", "work_info", "actor_profiles");
    invalidateActorMovies();
    invalidateActorProfiles();
    invalidatePersonMerge();
    refreshLibrary();
    const nextWork = resolveLibraryWorkByPublicId(String(coreWorkId));
    const nextPerson = resolveLibraryPersonByPublicId(String(person.id));
    return {
      actorName,
      person: nextPerson ? publicPerson(nextPerson) : { id: String(person.id), name: person.name || actorName },
      before,
      work: nextWork ? publicWork(nextWork, true) : null
    };
  }

  function prepareWorkMove(workId, personId, options = {}) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work || work.missingLocal) {
      const error = new Error("作品本地文件不存在");
      error.statusCode = 404;
      throw error;
    }
    if (!hasCoreDb()) {
      const error = new Error("core DB 不可用");
      error.statusCode = 500;
      throw error;
    }

    const db = getCoreDb();
    const coreWorkId = Number(work.id);
    if (!Number.isFinite(coreWorkId)) {
      const error = new Error("作品编号无效");
      error.statusCode = 400;
      throw error;
    }

    let createdPerson = null;
    if (!personId && options.createPerson) {
      createdPerson = createOrUpdateMoveTargetPerson(db, options.createPerson);
      personId = createdPerson.id;
      options = {
        ...options,
        targetDirectory: options.targetDirectory || createdPerson.targetDirectory
      };
    }

    const corePersonId = Number(personId);
    if (!Number.isFinite(corePersonId)) {
      const error = new Error("人物编号无效");
      error.statusCode = 400;
      throw error;
    }

    const targetPerson = resolveLibraryPersonByPublicId(String(corePersonId)) || corePersonFallbackRecord(String(corePersonId));
    if (!targetPerson?.id) {
      const error = new Error("目标人物不存在");
      error.statusCode = 404;
      throw error;
    }

    const row = db
      .prepare(
        `
        SELECT id, local_path, source_info_path
        FROM local_works
        WHERE work_id = ?
          AND local_path IS NOT NULL
          AND local_path <> ''
        ORDER BY id
        LIMIT 1
        `
      )
      .get(coreWorkId);
    if (!row?.local_path) {
      const error = new Error("这个作品没有本地文件夹");
      error.statusCode = 404;
      throw error;
    }

    const oldDir = ensureLibraryDirectoryPath(row.local_path, "作品文件夹");
    if (!safeStat(oldDir)?.isDirectory()) {
      const error = new Error("本地作品文件夹不存在");
      error.statusCode = 404;
      throw error;
    }
    const personDir = targetDirectoryForPerson(targetPerson, db, options);
    const newDir = ensureLibraryDirectoryPath(path.join(personDir, path.basename(oldDir)), "目标作品文件夹");
    if (path.resolve(oldDir).toLowerCase() === path.resolve(newDir).toLowerCase()) {
      const error = new Error("作品已经在目标人物文件夹中");
      error.statusCode = 409;
      throw error;
    }
    if (fs.existsSync(newDir)) {
      const error = new Error(`目标文件夹已存在：${relativeFromRoot(newDir)}`);
      error.statusCode = 409;
      throw error;
    }

    const before = db
      .prepare(
        `
        SELECT CAST(wp.person_id AS TEXT) AS person_id, p.name
        FROM work_people wp
        JOIN people p ON p.id = wp.person_id
        WHERE wp.work_id = ?
          AND wp.role = 'actor'
        ORDER BY wp.sort_order, wp.person_id
        `
      )
      .all(coreWorkId);

    return {
      version: 1,
      workId: String(coreWorkId),
      localWorkId: Number(row.id),
      personId: String(corePersonId),
      targetPerson: {
        id: String(corePersonId),
        name: targetPerson.name || `#${corePersonId}`,
        relativePath: targetPerson.relativePath || relativeFromRoot(personDir),
        sourcePaths: uniqueTextArray([...(targetPerson.sourcePaths || []), relativeFromRoot(personDir)])
      },
      personDir,
      oldDir,
      newDir,
      sourceInfoPath: row.source_info_path || "",
      createdPerson,
      before
    };
  }

  function inspectWorkMove(plan) {
    const db = getCoreDb();
    const row = db.prepare("SELECT local_path FROM local_works WHERE id = ? AND work_id = ?").get(Number(plan.localWorkId), Number(plan.workId));
    if (!row?.local_path) return "missing";
    const current = path.resolve(row.local_path).toLowerCase();
    if (current === path.resolve(plan.oldDir).toLowerCase()) return "source";
    if (current === path.resolve(plan.newDir).toLowerCase()) return "target";
    return "conflict";
  }

  function commitWorkMove(plan) {
    const db = getCoreDb();
    const coreWorkId = Number(plan.workId);
    const corePersonId = Number(plan.personId);
    const currentState = inspectWorkMove(plan);
    if (currentState === "target") return { committed: false, alreadyCommitted: true };
    if (currentState !== "source") {
      const error = new Error("SQLite 中的作品路径已被其他操作修改");
      error.statusCode = 409;
      throw error;
    }

    const now = new Date().toISOString();
    try {
      db.exec("BEGIN IMMEDIATE");
      const fileRows = db.prepare("SELECT id, file_path FROM local_files WHERE local_work_id = ?").all(Number(plan.localWorkId));
      const imageRows = db
        .prepare("SELECT id, local_path FROM fanhao_images.images WHERE owner_type = 'work' AND owner_id = ? AND local_path IS NOT NULL AND local_path <> ''")
        .all(coreWorkId);

      db
        .prepare(
          `
          UPDATE local_works
          SET local_path = ?,
              source_info_path = CASE
                WHEN source_info_path IS NOT NULL AND source_info_path <> '' THEN ?
                ELSE source_info_path
              END,
              updated_at = ?
          WHERE id = ?
          `
        )
        .run(plan.newDir, replacePathPrefix(plan.sourceInfoPath, plan.oldDir, plan.newDir), now, Number(plan.localWorkId));

      const updateFile = db.prepare("UPDATE local_files SET file_path = ?, relative_path = ?, updated_at = ? WHERE id = ?");
      for (const fileRow of fileRows) {
        const nextPath = replacePathPrefix(fileRow.file_path, plan.oldDir, plan.newDir);
        updateFile.run(nextPath, relativeFromRoot(nextPath), now, fileRow.id);
      }

      const updateImage = db.prepare("UPDATE fanhao_images.images SET local_path = ?, updated_at = ? WHERE id = ?");
      for (const imageRow of imageRows) {
        updateImage.run(replacePathPrefix(imageRow.local_path, plan.oldDir, plan.newDir), now, imageRow.id);
      }

      db.prepare("DELETE FROM work_people WHERE work_id = ? AND role = 'actor' AND person_id <> ?").run(coreWorkId, corePersonId);
      db
        .prepare(
          `
          INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
          VALUES (?, ?, 'actor', 0, 'manual_move', ?, ?)
          ON CONFLICT(work_id, person_id, role) DO UPDATE SET
            sort_order = 0,
            source = excluded.source,
            updated_at = excluded.updated_at
          `
        )
        .run(coreWorkId, corePersonId, now, now);

      const actorName = plan.targetPerson.name || `#${corePersonId}`;
      const workRow = db.prepare("SELECT fields_json FROM works WHERE id = ?").get(coreWorkId);
      const fieldsJson = correctedActorFieldsJson(workRow?.fields_json, actorName);
      db.prepare("UPDATE works SET fields_json = ?, updated_at = ? WHERE id = ?").run(fieldsJson, now, coreWorkId);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    return { committed: true, alreadyCommitted: false };
  }

  function finalizeWorkMove(plan, moveResult = {}) {
    const coreWorkId = Number(plan.workId);
    const corePersonId = Number(plan.personId);
    invalidateTableStamp("actor_movies", "work_info", "actor_profiles");
    invalidateActorMovies();
    invalidateActorProfiles();
    invalidatePersonMerge();
    resetWorkSearch();
    reconcileMovedLocalWork({
      beforePersonIds: (plan.before || []).map((person) => String(person.person_id || "")),
      newDir: plan.newDir,
      oldDir: plan.oldDir,
      personDir: plan.personDir,
      targetPerson: plan.targetPerson,
      workId: String(coreWorkId)
    });
    const nextWork = resolveLibraryWorkByPublicId(String(coreWorkId));
    const nextPerson = resolveLibraryPersonByPublicId(String(corePersonId));
    return {
      moved: true,
      moveMode: moveResult?.mode || "",
      oldPath: relativeFromRoot(plan.oldDir),
      newPath: relativeFromRoot(plan.newDir),
      createdPerson: plan.createdPerson ? { id: plan.createdPerson.id, name: plan.createdPerson.name, created: plan.createdPerson.created } : null,
      before: plan.before || [],
      person: nextPerson ? publicPerson(nextPerson) : publicPerson(plan.targetPerson),
      work: nextWork ? publicWork(nextWork, true) : null
    };
  }

  return {
    correctWorkActorFromLocalFolder,
    commitWorkMove,
    finalizeWorkMove,
    inspectWorkMove,
    mergePeopleIntoTarget,
    prepareWorkMove,
    upsertActorProfile
  };
}
