import fs from "node:fs";
import path from "node:path";
import {
  assertActorProfileMutationAllowed,
  clearActorProfilePublication
} from "./actor-profile-mutation-guard.js";
import { canonicalPersonId } from "./person-identity.js";

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
  fileSystem = fs.promises,
  localAvatarSource,
  maxBytes,
  normalizeExt,
  publicPerson
}) {
  const yieldEvery = 256;

  function checkCancelled(signal) {
    if (!signal?.aborted) return;
    const error = new Error("头像读取已取消");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    error.statusCode = 499;
    throw error;
  }

  async function nextBatch(count, signal) {
    if (count % yieldEvery === 0) await new Promise((resolve) => setImmediate(resolve));
    checkCancelled(signal);
  }

  async function statOrNull(filePath, signal) {
    checkCancelled(signal);
    try {
      const stat = await fileSystem.stat(filePath);
      checkCancelled(signal);
      return stat;
    } catch (error) {
      checkCancelled(signal);
      return null;
    }
  }

  function sameFile(before, after) {
    return Boolean(before && after && after.isFile())
      && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => before[key] === after[key]);
  }

  function sourceChanged() {
    const error = new Error("头像来源已变化，请重新读取候选");
    error.code = "ACTOR_AVATAR_SOURCE_CHANGED";
    error.statusCode = 409;
    return error;
  }

  function candidateUnavailable() {
    const error = new Error("候选头像不存在或不可用");
    error.statusCode = 404;
    return error;
  }

  async function verifyFiletree(snapshot, signal) {
    if (!sameFile(snapshot.stat, await statOrNull(snapshot.path, signal))) throw sourceChanged();
  }

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

  async function readFiletree(rootPath, options = {}) {
    const signal = options.signal;
    const root = path.resolve(String(rootPath || "").trim());
    const filetreePath = path.join(root, "Filetree.json");
    const contentDir = path.join(root, "Content");
    if (!rootPath) {
      const error = new Error("请先填写演员头像目录。");
      error.statusCode = 400;
      throw error;
    }
    const stat = await statOrNull(filetreePath, signal);
    if (!stat?.isFile()) {
      const error = new Error("该路径下未找到 Filetree.json。");
      error.statusCode = 400;
      throw error;
    }
    if (!(await statOrNull(contentDir, signal))?.isDirectory()) {
      const error = new Error("该路径下未找到 Content 目录。");
      error.statusCode = 400;
      throw error;
    }

    let filetree = null;
    try {
      const text = await fileSystem.readFile(filetreePath, { encoding: "utf8", signal });
      checkCancelled(signal);
      if (!sameFile(stat, await statOrNull(filetreePath, signal))) throw sourceChanged();
      filetree = JSON.parse(text);
    } catch (error) {
      checkCancelled(signal);
      if (error.code === "ACTOR_AVATAR_SOURCE_CHANGED") throw error;
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
    return { root, content, snapshot: { path: filetreePath, stat } };
  }

  async function entriesFromFiletree(rootPath, options = {}) {
    const { root, content, snapshot } = await readFiletree(rootPath, options);
    const signal = options.signal;
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
          await nextBatch(summary.filetreeItems, signal);
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
          const stat = await statOrNull(fullPath, signal);
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
            size: stat.size,
            stat
          });
          summary.usable += 1;
        }
      }
    }

    await verifyFiletree(snapshot, signal);
    return { root, entries, summary, snapshot };
  }

  async function selectedEntry(rootPath, cleanRelPath, options) {
    const { root, content, snapshot } = await readFiletree(rootPath, options);
    let checked = 0;
    for (const [groupName, mapping] of Object.entries(content)) {
      if (!mapping || typeof mapping !== "object") continue;
      for (const [actorKey, targetValue] of Object.entries(mapping)) {
        for (const value of Array.isArray(targetValue) ? targetValue : [targetValue]) {
          await nextBatch(++checked, options.signal);
          const fullPath = targetPath(root, groupName, value || actorKey);
          if (!fullPath || path.relative(root, fullPath).replaceAll(path.sep, "/") !== cleanRelPath) continue;
          if (!avatarExts.has(normalizeExt(fullPath))) continue;
          const stat = await statOrNull(fullPath, options.signal);
          if (!stat?.isFile() || stat.size > maxBytes) continue;
          const actorName = nameFromFiletreeKey(actorKey, fileBase);
          const key = normalizeNameKey(actorName);
          if (!key) continue;
          await verifyFiletree(snapshot, options.signal);
          return { entry: { actorName, key, fullPath, relPath: cleanRelPath, mime: mime(fullPath), size: stat.size, stat }, snapshot };
        }
      }
    }
    throw candidateUnavailable();
  }

  function publicCandidate(entry) {
    return {
      actorName: entry.actorName,
      relPath: entry.relPath,
      size: entry.size,
      mime: entry.mime
    };
  }

  async function candidatesFromFiletree(rootPath, options = {}) {
    const { root, entries, summary } = await entriesFromFiletree(rootPath, options);
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

  async function avatarBuffer(entry, snapshot, signal) {
    checkCancelled(signal);
    const handle = await fileSystem.open(entry.fullPath, "r");
    let failure;
    let result;
    try {
      checkCancelled(signal);
      const before = await handle.stat();
      checkCancelled(signal);
      if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) throw candidateUnavailable();
      if (!sameFile(entry.stat, before)) throw sourceChanged();
      // One extra byte detects growth without ever allocating an unbounded BLOB.
      const buffer = Buffer.allocUnsafe(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        checkCancelled(signal);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== before.size || length > maxBytes) throw sourceChanged();
      const after = await handle.stat();
      checkCancelled(signal);
      if (!sameFile(before, after) || !sameFile(before, await statOrNull(entry.fullPath, signal))) throw sourceChanged();
      await verifyFiletree(snapshot, signal);
      result = buffer.subarray(0, length);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await handle.close();
      } catch (error) {
        if (failure) throw new AggregateError([failure, error], "Actor avatar read failed and its file could not be closed");
        throw error;
      }
    }
    // Closing a descriptor is another asynchronous boundary. A replacement or
    // rename during close must not publish bytes from the previous source.
    if (!sameFile(entry.stat, await statOrNull(entry.fullPath, signal))) throw sourceChanged();
    await verifyFiletree(snapshot, signal);
    return result;
  }

  function assertDatabase(db) {
    if (getCoreDb() !== db) throw sourceChanged();
  }

  function upsertAvatar(person, entry, buffer, existing, now, signal, db) {
    checkCancelled(signal);
    assertDatabase(db);
    const corePersonId = Number(person.id);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (canonicalPersonId(db, corePersonId) !== String(person.id)) throw sourceChanged();
      assertActorProfileMutationAllowed(db, corePersonId);
      clearActorProfilePublication(db, corePersonId);
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
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Actor avatar update failed and its transaction could not be rolled back");
      }
      throw error;
    }
  }

  function matchedEntryPerson(personId, entry, options) {
    const person = getPersonById(String(personId || ""));
    if (!person) {
      const error = new Error("人物不存在");
      error.statusCode = 404;
      throw error;
    }
    const { index, ambiguous } = personIndex();
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
    const existing = getProfileRow(person.id);
    if (existing?.person_id && String(existing.person_id) !== person.id) throw sourceChanged();
    return { person, existing };
  }

  async function importCandidate(rootPath, personId, relPath, options = {}) {
    if (!getPersonById(String(personId || ""))) {
      const error = new Error("人物不存在");
      error.statusCode = 404;
      throw error;
    }
    const db = options.dryRun ? null : getCoreDb();
    const cleanRelPath = String(relPath || "").replaceAll("\\", "/").trim();
    const { entry, snapshot } = await selectedEntry(rootPath, cleanRelPath, options);
    let { person, existing } = matchedEntryPerson(personId, entry, options);

    if (!options.dryRun) {
      const buffer = await avatarBuffer(entry, snapshot, options.signal);
      // File I/O yields to other requests; resolve names and identity again
      // before entering the short transaction, rather than retaining a preview.
      assertDatabase(db);
      ({ person, existing } = matchedEntryPerson(personId, entry, options));
      const now = new Date().toISOString();
      upsertAvatar(person, entry, buffer, existing, now, options.signal, db);
      invalidateProfiles();
    }
    return {
      dryRun: Boolean(options.dryRun),
      person: publicPerson(person),
      candidate: publicCandidate(entry)
    };
  }

  async function importFromFiletree(rootPath, options = {}) {
    const db = getCoreDb();
    const { root, entries, summary, snapshot } = await entriesFromFiletree(rootPath, options);
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

    try {
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

        if (getPublicProfile(person.id)?.avatarUrl && !replace) {
          skippedExisting += 1;
          continue;
        }

        const buffer = await avatarBuffer(entry, snapshot, options.signal);
        assertDatabase(db);
        if (getPublicProfile(person.id)?.avatarUrl && !replace) {
          skippedExisting += 1;
          continue;
        }
        // Another person's aliases may have changed during the read too. Check
        // global uniqueness only for an avatar that is about to be committed.
        const { person: currentPerson, existing: currentProfile } = matchedEntryPerson(person.id, entry, { force: false });
        upsertAvatar(currentPerson, entry, buffer, currentProfile, now, options.signal, db);
        importedPersonIds.add(person.id);
        seenAvatarKeys.add(`${person.id}:${entry.relPath}`);
        imported += 1;
      }
    } catch (error) {
      if (imported) {
        try {
          invalidateProfiles();
        } catch (invalidationError) {
          throw new AggregateError([error, invalidationError], "Actor avatar import failed after committed profiles could not be invalidated");
        }
      }
      throw error;
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
