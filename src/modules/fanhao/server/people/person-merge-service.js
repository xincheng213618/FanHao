export function createPersonMergeService({
  actorMovieRows,
  actorProfileAliases,
  actorProfileRow,
  getLibrary,
  getStamp,
  resolveCanonicalId = (id) => id,
  normalizePersonSearchValue,
  normalizeSourcePath,
  personHasVrMergeContent,
  preferredPersonDisplayName,
  uniquePersonNames
}) {
  let personMergeCache = null;
  const personRecordCache = new Map();
  let personRecordCacheStamp = "";

  function maps() {
    const stamp = getStamp();
    if (personMergeCache?.stamp === stamp) return personMergeCache.maps;
    const aliasToCanonical = new Map();
    const groupsByCanonical = new Map();
    for (const person of getLibrary().people) {
      const canonical = canonicalId(person.id);
      aliasToCanonical.set(String(person.id), canonical);
      if (!groupsByCanonical.has(canonical)) groupsByCanonical.set(canonical, []);
      groupsByCanonical.get(canonical).push(String(person.id));
    }
    const nextMaps = { aliasToCanonical, groupsByCanonical };
    personMergeCache = { stamp, maps: nextMaps };
    return nextMaps;
  }

  // Names and aliases are search hints, never identity authority. Only a durable,
  // explicitly confirmed merge may redirect an ID, independently of the library.
  function canonicalId(personId) {
    return String(resolveCanonicalId(String(personId || "")));
  }

  function members(personId) {
    const library = getLibrary();
    const canonicalPersonId = canonicalId(personId);
    const ids = maps().groupsByCanonical.get(canonicalPersonId) || [canonicalPersonId];
    return ids.map((id) => library.peopleById.get(id)).filter(Boolean);
  }

  function aliasNames(personId) {
    const library = getLibrary();
    const canonicalPersonId = canonicalId(personId);
    const canonicalRow = actorProfileRow(canonicalPersonId);
    const primary = new Set(
      uniquePersonNames([
        library.peopleById.get(canonicalPersonId)?.name,
        canonicalRow?.person_name,
        canonicalRow?.display_name
      ]).map(normalizePersonSearchValue)
    );
    const names = [];
    for (const person of members(canonicalPersonId)) {
      const row = actorProfileRow(person.id);
      names.push(person.name, row?.person_name, row?.display_name, ...actorProfileAliases(row));
    }
    return uniquePersonNames(names).filter((name) => {
      const key = normalizePersonSearchValue(name);
      return key && !primary.has(key);
    });
  }

  function record(person) {
    if (!person) return null;
    const stamp = getStamp();
    if (personRecordCacheStamp !== stamp) {
      personRecordCacheStamp = stamp;
      personRecordCache.clear();
    }
    const library = getLibrary();
    const canonicalPersonId = canonicalId(person.id);
    if (personRecordCache.has(canonicalPersonId)) return personRecordCache.get(canonicalPersonId);
    const canonical = library.peopleById.get(canonicalPersonId) || person;
    const mergedMembers = members(canonicalPersonId);
    if (mergedMembers.length <= 1) {
      personRecordCache.set(canonicalPersonId, canonical);
      return canonical;
    }

    const sourcePaths = [];
    const sourceSeen = new Set();
    const addSourcePath = (value) => {
      const text = String(value || "").trim();
      const key = normalizeSourcePath(text);
      if (!text || !key || sourceSeen.has(key)) return;
      sourceSeen.add(key);
      sourcePaths.push(text);
    };
    for (const member of [canonical, ...mergedMembers.filter((item) => item.id !== canonical.id)]) {
      for (const sourcePath of [...(member.sourcePaths || []), member.relativePath]) addSourcePath(sourcePath);
    }

    const works = [];
    const workSeen = new Set();
    for (const member of [canonical, ...mergedMembers.filter((item) => item.id !== canonical.id)]) {
      for (const workId of member.works || []) {
        if (!workId || workSeen.has(workId)) continue;
        workSeen.add(workId);
        works.push(workId);
      }
    }

    const workRows = works.map((workId) => library.worksById.get(workId)).filter(Boolean);
    const modifiedAt = mergedMembers
      .map((member) => member.modifiedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || canonical.modifiedAt;

    const mergedRecord = {
      ...canonical,
      relativePath: sourcePaths[0] || canonical.relativePath,
      sourcePaths,
      sourceCount: sourcePaths.length,
      works,
      workCount: works.length,
      videoCount: workRows.reduce((sum, work) => sum + Number(work.videoCount || 0), 0),
      playableCount: workRows.reduce((sum, work) => sum + Number(work.playableCount || 0), 0),
      imageCount: workRows.reduce((sum, work) => sum + Number(work.imageCount || 0), 0),
      infoCount: workRows.reduce((sum, work) => sum + Number(work.infoCount || 0), 0),
      modifiedAt
    };
    personRecordCache.set(canonicalPersonId, mergedRecord);
    return mergedRecord;
  }

  function displayName(person) {
    const row = person?.id ? actorProfileRow(person.id) : null;
    return row ? preferredPersonDisplayName(row, person?.name || "") : person?.name || "";
  }

  function searchNames(person) {
    if (!person) return [];
    const row = actorProfileRow(person.id);
    return uniquePersonNames([
      person.name,
      row?.person_name,
      row?.display_name,
      ...actorProfileAliases(row),
      ...aliasNames(person.id)
    ]);
  }

  function displayPersonForWork(personId) {
    const library = getLibrary();
    return record(library.peopleById.get(canonicalId(personId)));
  }

  function invalidate() {
    personMergeCache = null;
    personRecordCacheStamp = "";
    personRecordCache.clear();
  }

  return {
    aliasNames,
    canonicalId,
    displayName,
    displayPersonForWork,
    invalidate,
    maps,
    members,
    record,
    searchNames
  };
}
