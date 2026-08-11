import fs from "node:fs";
import path from "node:path";

export function linkedLocalWorkIdsForPeople(db, personIds = []) {
  const ids = [...new Set((personIds || [])
    .map((personId) => Number(personId))
    .filter(Number.isFinite))];
  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `
      SELECT DISTINCT CAST(wp.work_id AS TEXT) AS work_id
      FROM work_people wp
      JOIN local_works lw ON lw.work_id = wp.work_id
      WHERE wp.role = 'actor'
        AND wp.person_id IN (${placeholders})
      ORDER BY wp.work_id
      `
    )
    .all(...ids)
    .map((row) => String(row.work_id || ""))
    .filter(Boolean);
}

export function createCoreLibraryService({
  chooseCover,
  compareNaturalName,
  combinedLocalWorkCodeKeys,
  createId,
  dbBoolOrNull,
  emptyLibrary,
  fileBase,
  getCoreDb,
  hasCoreDb,
  libraryRoots,
  looseWorkCodeKey,
  normalizeExt,
  normalizePersonSearchValue,
  normalizeWorkCode,
  pathWithinRoot,
  parseJsonTextArray,
  personRecordFromWorks,
  proxiedRemoteImageUrl,
  publicRemoteUrl,
  registerFiles,
  relativeFromRoot,
  sourcePathToAbsolute,
  storedWorkCodeKey,
  uniquePersonNames,
  uniqueTextArray
}) {
  const LOCAL_CODE_BATCH_SIZE = 200;

  function localCodeKeysForRows(rows = [], extraKeys = new Set()) {
    const candidates = [...new Set(rows
      .map((row) => storedWorkCodeKey(row?.code_key) || looseWorkCodeKey(row?.code))
      .filter(Boolean))];
    const keys = new Set([...extraKeys]
      .map((value) => storedWorkCodeKey(value))
      .filter(Boolean));
    for (let offset = 0; offset < candidates.length; offset += LOCAL_CODE_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + LOCAL_CODE_BATCH_SIZE);
      try {
        const placeholders = batch.map(() => "?").join(", ");
        for (const row of getCoreDb()
          .prepare(`
            SELECT DISTINCT w.code_search AS code_key
            FROM works w
            WHERE w.code_search IN (${placeholders})
              AND EXISTS (
                SELECT 1
                FROM local_works lw
                WHERE lw.work_id = w.id
              )
          `)
          .all(...batch)) {
          const codeKey = storedWorkCodeKey(row.code_key);
          if (codeKey) keys.add(codeKey);
        }
      } catch (error) {
        console.warn("[core-missing-local-codes]", error.message);
        return combinedLocalWorkCodeKeys(extraKeys);
      }
    }
    return keys;
  }

  function personRow(personId) {
    const coreId = Number(personId);
    if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
    try {
      return getCoreDb().prepare("SELECT * FROM people WHERE id = ?").get(coreId) || null;
    } catch (error) {
      console.warn("[core-person]", error.message);
      return null;
    }
  }

  function personFallbackRecord(personId) {
    const row = personRow(personId);
    if (!row?.id) return null;
    const sourcePaths = uniqueTextArray([row.folder_path], { maxLength: 260, maxItems: 4 });
    return {
      id: String(row.id),
      name: row.display_name || row.name || String(row.id),
      relativePath: sourcePaths[0] || "",
      sourcePaths,
      sourceCount: sourcePaths.length,
      coverId: null,
      workCount: 0,
      videoCount: 0,
      playableCount: 0,
      imageCount: 0,
      infoCount: 0,
      modifiedAt: row.updated_at || row.created_at || null,
      works: []
    };
  }

  function localPathPersonName(localPath) {
    const fullPath = sourcePathToAbsolute(localPath);
    if (!fullPath) return "";
    const matchingRoot = [...libraryRoots]
      .sort((a, b) => b.length - a.length)
      .find((rootPath) => pathWithinRoot(fullPath, rootPath));
    if (!matchingRoot) {
      return path.basename(path.dirname(fullPath)) || path.basename(fullPath);
    }
    const relative = path.relative(matchingRoot, fullPath);
    return relative.split(/[\\/]+/).filter(Boolean)[0] || path.basename(fullPath);
  }

  function localPersonSourcePath(localPath) {
    const fullPath = sourcePathToAbsolute(localPath);
    const personName = localPathPersonName(fullPath);
    if (!fullPath || !personName) return relativeFromRoot(fullPath);
    const matchingRoot = [...libraryRoots]
      .sort((a, b) => b.length - a.length)
      .find((rootPath) => pathWithinRoot(fullPath, rootPath));
    return matchingRoot ? relativeFromRoot(path.join(matchingRoot, personName)) : relativeFromRoot(path.dirname(fullPath));
  }

  function peopleByFolderName(db) {
    const people = new Map();
    const rows = db.prepare("SELECT id, name, display_name FROM people").all();
    for (const row of rows) {
      const names = uniquePersonNames([row.name, row.display_name]);
      for (const name of names) {
        const key = normalizePersonSearchValue(name);
        if (!key) continue;
        if (!people.has(key)) people.set(key, []);
        const entries = people.get(key);
        if (!entries.some((entry) => Number(entry.id) === Number(row.id))) {
          entries.push({
            id: row.id,
            name: row.name || "",
            displayName: row.display_name || row.name || ""
          });
        }
      }
    }
    return people;
  }

  function personFromLocalPath(peopleByFolderNameMap, localPath) {
    const folderName = localPathPersonName(localPath);
    const matches = peopleByFolderNameMap.get(normalizePersonSearchValue(folderName)) || [];
    return matches.length === 1 ? matches[0] : null;
  }

  function backfillLocalWorkPeopleFromFolders(db) {
    const people = peopleByFolderName(db);
    const rows = db
      .prepare(
        `
        SELECT lw.work_id, lw.local_path
        FROM local_works lw
        WHERE lw.local_path IS NOT NULL
          AND lw.local_path <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM work_people wp
            WHERE wp.work_id = lw.work_id
              AND wp.role = 'actor'
          )
        `
      )
      .all();
    if (!rows.length) return people;

    const now = new Date().toISOString();
    const insert = db.prepare(
      `
      INSERT INTO work_people (work_id, person_id, role, sort_order, source, created_at, updated_at)
      VALUES (?, ?, 'actor', 0, 'local_folder', ?, ?)
      ON CONFLICT(work_id, person_id, role) DO NOTHING
      `
    );

    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const person = personFromLocalPath(people, row.local_path);
        if (!person?.id) continue;
        insert.run(Number(row.work_id), Number(person.id), now, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return people;
  }

  function fileToMediaFile(row) {
    const filePath = String(row.file_path || "");
    const name = String(row.name || path.basename(filePath));
    const type = String(row.file_type || "");
    return {
      id: String(row.file_id || createId(type[0] || "f", filePath)),
      type,
      name,
      title: String(row.title || fileBase(name)),
      ext: String(row.ext || normalizeExt(name)),
      path: filePath,
      relativePath: String(row.relative_path || relativeFromRoot(filePath)),
      size: Number(row.size || 0),
      modifiedAt: row.modified_at || null,
      playable: type === "video" ? Boolean(row.playable) : undefined
    };
  }

  function workInfoFallback(row) {
    return {
      code: row.code || "",
      title: row.work_title || "",
      releaseDate: row.release_date || "",
      durationMinutes: row.duration_minutes ?? null,
      rating: row.rating ?? null,
      ratingCount: row.rating_count ?? null,
      hasMagnet: dbBoolOrNull(row.has_magnet),
      isStreamable: dbBoolOrNull(row.is_streamable),
      hasSubtitles: dbBoolOrNull(row.has_subtitles),
      javdbTags: parseJsonTextArray(row.javdb_tags_json),
      director: row.director || "",
      imageUrl: "",
      actors: [],
      tags: [],
      fields: []
    };
  }

  function loadLibrary() {
    if (!hasCoreDb()) return null;

    const db = getCoreDb();
    const peopleByFolderNameMap = backfillLocalWorkPeopleFromFolders(db);
    const index = emptyLibrary();
    for (const rootPath of libraryRoots) {
      if (fs.existsSync(rootPath)) {
        index.availableRoots.push(rootPath);
      } else {
        index.missingRoots.push(rootPath);
      }
    }

    const filesByLocalWorkId = new Map();
    for (const row of db
      .prepare(
        `
        SELECT local_work_id, file_id, file_type, file_path, name, title, ext,
               relative_path, size, modified_at, playable, sort_order
        FROM local_files
        ORDER BY local_work_id, file_type, sort_order, name
        `
      )
      .all()) {
      const localWorkId = String(row.local_work_id || "");
      if (!localWorkId) continue;
      if (!filesByLocalWorkId.has(localWorkId)) filesByLocalWorkId.set(localWorkId, []);
      filesByLocalWorkId.get(localWorkId).push(fileToMediaFile(row));
    }

    const personBuckets = new Map();
    const localRows = db
      .prepare(
        `
        SELECT
          lw.id AS local_work_id,
          lw.work_id AS core_work_id,
          lw.local_path,
          lw.source_mtime,
          fallback_person.id AS fallback_person_id,
          fallback_person.name AS fallback_person_name,
          fallback_person.display_name AS fallback_person_display_name,
          w.code,
          w.title AS work_title,
          w.release_date,
          w.duration_minutes,
          w.rating,
          w.rating_count,
          w.has_magnet,
          w.is_streamable,
          w.has_subtitles,
          w.javdb_tags_json,
          w.director,
          w.updated_at AS work_updated_at
        FROM local_works lw
        JOIN works w ON w.id = lw.work_id
        LEFT JOIN people fallback_person
          ON fallback_person.id = (
            SELECT wp.person_id
            FROM work_people wp
            WHERE wp.work_id = w.id
              AND wp.role = 'actor'
            ORDER BY
              wp.sort_order ASC,
              wp.person_id ASC
            LIMIT 1
          )
        WHERE lw.local_path IS NOT NULL
          AND lw.local_path <> ''
        ORDER BY lw.local_path
        `
      )
      .all();

    for (const row of localRows) {
      const folderPerson = personFromLocalPath(peopleByFolderNameMap, row.local_path);
      const fallbackPerson = row.fallback_person_id
        ? {
            id: row.fallback_person_id,
            name: row.fallback_person_name || "",
            displayName: row.fallback_person_display_name || row.fallback_person_name || ""
          }
        : null;
      const displayPerson = folderPerson || fallbackPerson;
      const corePersonId = displayPerson?.id ? String(displayPerson.id) : "";
      if (!corePersonId) continue;
      const personName = displayPerson.displayName || displayPerson.name || "";
      if (!personName) continue;
      const personId = corePersonId;
      const sourcePath = localPersonSourcePath(row.local_path);
      if (!personBuckets.has(personId)) {
        personBuckets.set(personId, {
          id: personId,
          name: personName,
          sourcePaths: [],
          works: []
        });
      }
      const bucket = personBuckets.get(personId);
      if (sourcePath && !bucket.sourcePaths.includes(sourcePath)) bucket.sourcePaths.push(sourcePath);

      const files = filesByLocalWorkId.get(String(row.local_work_id)) || [];
      const videos = files.filter((file) => file.type === "video").sort(compareNaturalName);
      const images = files.filter((file) => file.type === "image").sort(compareNaturalName);
      const infos = files.filter((file) => file.type === "info").sort(compareNaturalName);
      videos.forEach((video, index) => {
        video.id = `${row.core_work_id}-${index + 1}`;
      });
      const title = row.work_title || path.basename(sourcePathToAbsolute(row.local_path)) || row.code || "";
      const cover = chooseCover(images, fileBase(title), sourcePathToAbsolute(row.local_path));
      const modifiedAt = [...videos, ...images, ...infos]
        .map((file) => file.modifiedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || row.source_mtime || row.work_updated_at || null;
      const work = {
        id: String(row.core_work_id),
        personId,
        title,
        directoryName: path.basename(sourcePathToAbsolute(row.local_path)),
        relativePath: relativeFromRoot(sourcePathToAbsolute(row.local_path)),
        coverId: cover?.id || null,
        videoCount: videos.length,
        playableCount: videos.filter((video) => video.playable).length,
        imageCount: images.length,
        infoCount: infos.length,
        modifiedAt,
        videos,
        images,
        infos,
        infoSummary: workInfoFallback(row)
      };
      bucket.works.push(work);
      index.worksById.set(work.id, work);
      registerFiles(index, [...videos, ...images, ...infos]);
    }

    for (const bucket of personBuckets.values()) {
      const person = personRecordFromWorks(bucket, bucket.sourcePaths, bucket.works);
      index.people.push(person);
      index.peopleById.set(person.id, person);
    }

    index.people.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    index.scannedAt = new Date().toISOString();
    index.totals.people = index.people.length;
    index.totals.works = index.worksById.size;
    const files = [...index.filesById.values()];
    index.totals.videos = files.filter((file) => file.type === "video").length;
    index.totals.playableVideos = files.filter((file) => file.type === "video" && file.playable).length;
    index.totals.images = files.filter((file) => file.type === "image").length;
    index.totals.infoFiles = files.filter((file) => file.type === "info").length;
    return index;
  }

  function missingWorkFromRow(person, row) {
    const code = normalizeWorkCode(row.code) || row.code || "";
    const title = row.title && row.title !== row.code ? row.title : code || row.title || "未下载作品";
    return {
      id: String(row.work_id || row.id || ""),
      personId: person.id,
      personName: person.name,
      title,
      directoryName: code,
      relativePath: "",
      coverId: null,
      remoteCoverUrl: proxiedRemoteImageUrl(row.image_url),
      videoCount: 0,
      playableCount: 0,
      imageCount: 0,
      infoCount: 0,
      videos: [],
      images: [],
      infos: [],
      modifiedAt: row.updated_at || "",
      missingLocal: true,
      javdbUrl: publicRemoteUrl(row.detail_url),
      actorUrl: row.actor_url || "",
      infoSummary: {
        code,
        title: row.title || "",
        javdbUrl: publicRemoteUrl(row.detail_url),
        releaseDate: row.release_date || "",
        durationMinutes: row.duration_minutes ?? null,
        rating: row.rating ?? null,
        ratingCount: row.rating_count ?? null,
        hasMagnet: dbBoolOrNull(row.has_magnet),
        isStreamable: dbBoolOrNull(row.is_streamable),
        hasSubtitles: dbBoolOrNull(row.has_subtitles),
        javdbTags: parseJsonTextArray(row.javdb_tags_json)
      }
    };
  }

  function missingWorksForPerson(person, excludedCodeKeys = new Set()) {
    if (!person?.id || !hasCoreDb()) return [];
    const corePersonId = Number(person.id);
    if (!Number.isFinite(corePersonId)) return [];

    try {
      const rows = getCoreDb()
        .prepare(
          `
          SELECT
            w.id AS work_id,
            w.code,
            w.code_search AS code_key,
            w.title,
            w.release_date,
            w.duration_minutes,
            w.rating,
            w.rating_count,
            w.has_magnet,
            w.is_streamable,
            w.has_subtitles,
            w.javdb_tags_json,
            w.updated_at,
            wref.url AS detail_url,
            pref.url AS actor_url
          FROM work_people wp
          JOIN works w ON w.id = wp.work_id
          LEFT JOIN work_external_refs wref
            ON wref.work_id = w.id
           AND wref.provider = 'javdb-video'
          LEFT JOIN person_external_refs pref
            ON pref.id = (
              SELECT pref2.id
              FROM person_external_refs pref2
              WHERE pref2.person_id = wp.person_id
                AND pref2.provider = 'javdb-actor'
              ORDER BY pref2.id ASC
              LIMIT 1
            )
          WHERE wp.person_id = ?
            AND wp.role = 'actor'
            AND NOT EXISTS (
              SELECT 1
              FROM local_works lw
              WHERE lw.work_id = w.id
            )
          ORDER BY COALESCE(w.release_date, '') DESC, w.id DESC
          `
        )
        .all(corePersonId);
      const localKeys = localCodeKeysForRows(rows, excludedCodeKeys);
      return rows
        .filter((row) => {
          const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
          return !codeKey || !localKeys.has(codeKey);
        })
        .map((row) => missingWorkFromRow(person, row));
    } catch (error) {
      console.warn("[core-missing-works]", error.message);
      return [];
    }
  }

  function localWorkIdsForPeople(personIds = []) {
    if (!hasCoreDb()) return [];
    try {
      return linkedLocalWorkIdsForPeople(getCoreDb(), personIds);
    } catch (error) {
      console.warn("[core-local-work-people]", error.message);
      return [];
    }
  }

  return {
    backfillLocalWorkPeopleFromFolders,
    fileToMediaFile,
    localWorkIdsForPeople,
    loadLibrary,
    localPathPersonName,
    localPersonSourcePath,
    missingWorkFromRow,
    missingWorksForPerson,
    peopleByFolderName,
    personFallbackRecord,
    personFromLocalPath,
    personRow,
    workInfoFallback
  };
}
