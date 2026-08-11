import fs from "node:fs";
import path from "node:path";

function normalizeNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s._\-()[\]【】（）「」『』"'’‘“”・·,，、|/]+/g, "")
    .trim();
}

function nameFromFiletreeKey(value, fileBase) {
  const text = String(value || "").split("?", 1)[0].replaceAll("\\", "/").split("/").pop() || "";
  return fileBase(text);
}

function resolveInside(baseDir, parts) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...parts);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

export function createActorAvatarService({
  avatarExts,
  fileBase,
  getCoreDb,
  getPeople,
  getPersonById,
  getProfileRow,
  getPublicProfile,
  getSearchNames,
  invalidateProfiles,
  localAvatarSource,
  maxBytes,
  normalizeExt,
  publicPerson,
  safeStat
}) {
  function mime(filePath) {
    const ext = normalizeExt(filePath);
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    return "image/jpeg";
  }

  function targetPath(rootPath, groupName, targetValue) {
    const contentDir = path.resolve(rootPath, "Content");
    const groupPath = resolveInside(contentDir, [String(groupName || "")]);
    if (!groupPath) return null;

    const rawTarget = String(targetValue || "").split("?", 1)[0].replaceAll("\\", "/");
    const parts = rawTarget.split("/").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    return resolveInside(groupPath, parts);
  }

  function personIndex() {
    const index = new Map();
    const ambiguous = new Set();
    for (const person of getPeople()) {
      for (const name of getSearchNames(person)) {
        const key = normalizeNameKey(name);
        if (!key) continue;
        const existing = index.get(key);
        if (existing && existing.id !== person.id) {
          ambiguous.add(key);
          index.delete(key);
          continue;
        }
        if (!ambiguous.has(key)) index.set(key, person);
      }
    }
    return { index, ambiguous };
  }

  function readFiletree(rootPath) {
    const root = path.resolve(String(rootPath || "").trim());
    const filetreePath = path.join(root, "Filetree.json");
    const contentDir = path.join(root, "Content");
    if (!rootPath) {
      const error = new Error("请先填写演员头像目录。");
      error.statusCode = 400;
      throw error;
    }
    if (!safeStat(filetreePath)?.isFile()) {
      const error = new Error("该路径下未找到 Filetree.json。");
      error.statusCode = 400;
      throw error;
    }
    if (!safeStat(contentDir)?.isDirectory()) {
      const error = new Error("该路径下未找到 Content 目录。");
      error.statusCode = 400;
      throw error;
    }

    let filetree = null;
    try {
      filetree = JSON.parse(fs.readFileSync(filetreePath, "utf8"));
    } catch (error) {
      const wrapped = new Error(`读取 Filetree.json 失败：${error.message}`);
      wrapped.statusCode = 400;
      throw wrapped;
    }

    const content = filetree?.Content || filetree?.content;
    if (!content || typeof content !== "object") {
      const error = new Error("Filetree.json 中未找到 Content 节点。");
      error.statusCode = 400;
      throw error;
    }
    return { root, content };
  }

  function entriesFromFiletree(rootPath) {
    const { root, content } = readFiletree(rootPath);
    const entries = [];
    const summary = {
      groups: 0,
      filetreeItems: 0,
      usable: 0,
      missingFiles: 0,
      unsupported: 0,
      tooLarge: 0,
      unsafePath: 0
    };

    for (const [groupName, mapping] of Object.entries(content)) {
      if (!mapping || typeof mapping !== "object") continue;
      summary.groups += 1;
      for (const [actorKey, targetValue] of Object.entries(mapping)) {
        const values = Array.isArray(targetValue) ? targetValue : [targetValue];
        for (const value of values) {
          summary.filetreeItems += 1;
          const fullPath = targetPath(root, groupName, value || actorKey);
          if (!fullPath) {
            summary.unsafePath += 1;
            continue;
          }
          const ext = normalizeExt(fullPath);
          if (!avatarExts.has(ext)) {
            summary.unsupported += 1;
            continue;
          }
          const stat = safeStat(fullPath);
          if (!stat?.isFile()) {
            summary.missingFiles += 1;
            continue;
          }
          if (stat.size > maxBytes) {
            summary.tooLarge += 1;
            continue;
          }
          const actorName = nameFromFiletreeKey(actorKey, fileBase);
          const key = normalizeNameKey(actorName);
          if (!key) continue;
          const relPath = path.relative(root, fullPath).replaceAll(path.sep, "/");
          entries.push({
            actorName,
            key,
            fullPath,
            relPath,
            mime: mime(fullPath),
            size: stat.size
          });
          summary.usable += 1;
        }
      }
    }

    return { root, entries, summary };
  }

  function publicCandidate(entry) {
    return {
      actorName: entry.actorName,
      relPath: entry.relPath,
      size: entry.size,
      mime: entry.mime
    };
  }

  function candidatesFromFiletree(rootPath, options = {}) {
    const { root, entries, summary } = entriesFromFiletree(rootPath);
    const { index, ambiguous } = personIndex();
    const personIdFilter = String(options.personId || "").trim();
    const limit = Math.max(0, Number(options.limit || 0) || 0);
    const byPerson = new Map();
    let matched = 0;
    let skippedAmbiguous = 0;
    let skippedUnmatched = 0;

    for (const entry of entries) {
      if (ambiguous.has(entry.key)) {
        skippedAmbiguous += 1;
        continue;
      }
      const person = index.get(entry.key);
      if (!person) {
        skippedUnmatched += 1;
        continue;
      }
      if (personIdFilter && person.id !== personIdFilter) continue;
      matched += 1;

      if (!byPerson.has(person.id)) {
        const profile = getPublicProfile(person.id);
        byPerson.set(person.id, {
          personId: person.id,
          personName: person.name,
          displayName: profile?.displayName || person.name,
          hasAvatar: Boolean(profile?.avatarUrl),
          candidates: []
        });
      }

      byPerson.get(person.id).candidates.push(publicCandidate(entry));
    }

    const people = [...byPerson.values()]
      .map((person) => ({
        ...person,
        candidates: person.candidates.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true, sensitivity: "base" }))
      }))
      .sort((a, b) => Number(a.hasAvatar) - Number(b.hasAvatar) || a.displayName.localeCompare(b.displayName, "zh-Hans-CN"))
      .slice(0, limit || Number.MAX_SAFE_INTEGER);

    return {
      root,
      ...summary,
      matched,
      matchedPeople: byPerson.size,
      returnedPeople: people.length,
      skippedAmbiguous,
      skippedUnmatched,
      people
    };
  }

  function upsertAvatar(person, entry, existing, now) {
    const buffer = fs.readFileSync(entry.fullPath);
    const corePersonId = Number(person.id);
    const db = getCoreDb();
    db.exec("SAVEPOINT upsert_actor_avatar");
    try {
      db.prepare(
        `
        UPDATE people
        SET display_name = COALESCE(display_name, ?),
            updated_at = ?
        WHERE id = ?
        `
      ).run(existing?.display_name || person.name, now, corePersonId);
      db.prepare(
        `
        INSERT INTO fanhao_images.images (
          owner_type, owner_id, kind, source_type, local_path, mime, image_blob, byte_size,
          sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
        )
        VALUES ('person', ?, 'avatar', 'local', ?, ?, ?, ?, 0, 'ok', ?, 'local-avatar', ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          mime = excluded.mime,
          image_blob = excluded.image_blob,
          byte_size = excluded.byte_size,
          status = excluded.status,
          source = excluded.source,
          legacy_table = excluded.legacy_table,
          legacy_key = excluded.legacy_key,
          updated_at = excluded.updated_at
        `
      ).run(corePersonId, entry.fullPath, entry.mime, buffer, buffer.length, localAvatarSource, person.id, now, now);
      db.exec("RELEASE SAVEPOINT upsert_actor_avatar");
    } catch (error) {
      try {
        db.exec("ROLLBACK TO SAVEPOINT upsert_actor_avatar; RELEASE SAVEPOINT upsert_actor_avatar;");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Actor avatar update failed and its transaction could not be rolled back");
      }
      throw error;
    }
  }

  function importCandidate(rootPath, personId, relPath, options = {}) {
    const person = getPersonById(String(personId || ""));
    if (!person) {
      const error = new Error("人物不存在");
      error.statusCode = 404;
      throw error;
    }

    const cleanRelPath = String(relPath || "").replaceAll("\\", "/").trim();
    const { entries } = entriesFromFiletree(rootPath);
    const { index, ambiguous } = personIndex();
    const entry = entries.find((item) => item.relPath === cleanRelPath);
    if (!entry) {
      const error = new Error("候选头像不存在或不可用");
      error.statusCode = 404;
      throw error;
    }
    if (ambiguous.has(entry.key)) {
      const error = new Error("候选头像名称匹配到多个人物，请先补充别名后再选择");
      error.statusCode = 409;
      throw error;
    }
    const matchedPerson = index.get(entry.key);
    if (matchedPerson?.id !== person.id && !options.force) {
      const error = new Error("候选头像与当前人物不匹配");
      error.statusCode = 400;
      throw error;
    }

    if (!options.dryRun) {
      const now = new Date().toISOString();
      const existing = getProfileRow(person.id);
      upsertAvatar(person, entry, existing, now);
      invalidateProfiles();
    }
    return {
      dryRun: Boolean(options.dryRun),
      person: publicPerson(person),
      candidate: publicCandidate(entry)
    };
  }

  function importFromFiletree(rootPath, options = {}) {
    const { root, entries, summary } = entriesFromFiletree(rootPath);
    const { index, ambiguous } = personIndex();
    const replace = Boolean(options.replace);
    const importedPersonIds = new Set();
    const seenAvatarKeys = new Set();
    const now = new Date().toISOString();
    let matched = 0;
    let imported = 0;
    let skippedExisting = 0;
    let skippedDuplicate = 0;
    let skippedAmbiguous = 0;
    let skippedUnmatched = 0;

    for (const entry of entries) {
      if (ambiguous.has(entry.key)) {
        skippedAmbiguous += 1;
        continue;
      }
      const person = index.get(entry.key);
      if (!person) {
        skippedUnmatched += 1;
        continue;
      }
      matched += 1;

      if (importedPersonIds.has(person.id) || seenAvatarKeys.has(`${person.id}:${entry.relPath}`)) {
        skippedDuplicate += 1;
        continue;
      }

      const existing = getProfileRow(person.id);
      if (existing?.avatar_url && !replace) {
        skippedExisting += 1;
        continue;
      }

      upsertAvatar(person, entry, existing, now);
      importedPersonIds.add(person.id);
      seenAvatarKeys.add(`${person.id}:${entry.relPath}`);
      imported += 1;
    }

    if (imported) invalidateProfiles();
    return {
      root,
      replace,
      ...summary,
      matched,
      imported,
      skippedExisting,
      skippedDuplicate,
      skippedAmbiguous,
      skippedUnmatched
    };
  }

  return {
    candidatesFromFiletree,
    entriesFromFiletree,
    importCandidate,
    importFromFiletree
  };
}
