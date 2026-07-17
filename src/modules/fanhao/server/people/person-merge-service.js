export function createPersonMergeService({
  actorMovieRows,
  actorProfileAliases,
  actorProfileRow,
  getLibrary,
  getStamp,
  normalizePersonSearchValue,
  normalizeSourcePath,
  personHasVrMergeContent,
  preferredPersonDisplayName,
  uniquePersonNames
}) {
  let personMergeCache = null;
  const personRecordCache = new Map();
  let personRecordCacheStamp = "";

  function preferCanonicalPerson(a, b) {
    const aF = (a.sourcePaths || []).some((item) => /^f:\//i.test(String(item || "").replaceAll("\\", "/")));
    const bF = (b.sourcePaths || []).some((item) => /^f:\//i.test(String(item || "").replaceAll("\\", "/")));
    return (
      Number(bF) - Number(aF) ||
      actorMovieRows(b.id).length - actorMovieRows(a.id).length ||
      Number(b.workCount || 0) - Number(a.workCount || 0) ||
      Number(b.sourceCount || 0) - Number(a.sourceCount || 0) ||
      String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" })
    );
  }

  function maps() {
    const stamp = getStamp();
    if (personMergeCache?.stamp === stamp) return personMergeCache.maps;

    const library = getLibrary();
    const parent = new Map();
    const ensureParent = (personId) => {
      if (!parent.has(personId)) parent.set(personId, personId);
    };
    const find = (personId) => {
      ensureParent(personId);
      const next = parent.get(personId);
      if (next === personId) return personId;
      const root = find(next);
      parent.set(personId, root);
      return root;
    };
    const union = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    };
    for (const person of library.people) ensureParent(person.id);

    const byActorId = new Map();
    for (const person of library.people) {
      const actorId = String(actorProfileRow(person.id)?.javdb_actor_id || "").trim();
      if (!actorId) continue;
      if (!byActorId.has(actorId)) byActorId.set(actorId, []);
      byActorId.get(actorId).push(person);
    }

    for (const people of byActorId.values()) {
      if (people.length < 2 || people.some(personHasVrMergeContent)) continue;
      for (const person of people.slice(1)) union(people[0].id, person.id);
    }

    const aliasOwners = new Map();
    for (const person of library.people) {
      const row = actorProfileRow(person.id);
      if (!row) continue;
      for (const alias of actorProfileAliases(row)) {
        const key = normalizePersonSearchValue(alias);
        if (!key) continue;
        if (!aliasOwners.has(key)) aliasOwners.set(key, []);
        aliasOwners.get(key).push(person);
      }
    }

    for (const person of library.people) {
      const key = normalizePersonSearchValue(person.name);
      const owners = aliasOwners.get(key) || [];
      for (const owner of owners) {
        if (owner.id === person.id) continue;
        const ownerActorId = String(actorProfileRow(owner.id)?.javdb_actor_id || "").trim();
        const personActorId = String(actorProfileRow(person.id)?.javdb_actor_id || "").trim();
        if (ownerActorId && personActorId && ownerActorId !== personActorId) continue;
        union(owner.id, person.id);
      }
    }

    const components = new Map();
    for (const person of library.people) {
      const root = find(person.id);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(person);
    }

    const aliasToCanonical = new Map();
    const groupsByCanonical = new Map();
    for (const people of components.values()) {
      if (people.length < 2) continue;
      const canonical = [...people].sort(preferCanonicalPerson)[0];
      const memberIds = people.map((person) => person.id);
      groupsByCanonical.set(canonical.id, memberIds);
      for (const memberId of memberIds) aliasToCanonical.set(memberId, canonical.id);
    }

    const nextMaps = { aliasToCanonical, groupsByCanonical };
    personMergeCache = { stamp, maps: nextMaps };
    return nextMaps;
  }

  function canonicalId(personId) {
    const id = String(personId || "");
    return maps().aliasToCanonical.get(id) || id;
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
