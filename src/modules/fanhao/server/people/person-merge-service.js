const PERSON_SEARCH_NAMES_MAX_BYTES = 16 * 1024 * 1024;

export function createPersonMergeService({
  actorMovieRows,
  actorProfileAliases,
  actorProfileRow,
  getLibrary,
  getStamp,
  resolveCanonicalId = (id) => id,
  createCanonicalIdReader,
  normalizePersonSearchValue,
  normalizeSourcePath,
  personHasVrMergeContent,
  preferredPersonDisplayName,
  uniquePersonNames
}) {
  let personMergeCache = null;
  let personSearchNameCache = null;
  const personRecordCache = new Map();
  let personRecordCacheStamp = "";

  function maps() {
    return mapsForStamp(getStamp());
  }

  function mapsForStamp(stamp, resolve) {
    const library = getLibrary();
    if (mergeCacheMatches(stamp, library, resolve)) return personMergeCache.maps;
    const people = library.people;
    const canonicalForId = resolve || (people.length ? batchCanonicalId() : canonicalId);
    const maps = buildMergeMaps(people, canonicalForId);
    personMergeCache = {
      stamp, library: new WeakRef(library), people: new WeakRef(people),
      identity: canonicalForId.identitySnapshot, maps
    };
    return maps;
  }

  function buildMergeMaps(people, resolve) {
    const aliasToCanonical = new Map();
    const groupsByCanonical = new Map();
    for (const person of people) {
      const canonical = resolve(person.id);
      aliasToCanonical.set(String(person.id), canonical);
      if (!groupsByCanonical.has(canonical)) groupsByCanonical.set(canonical, []);
      groupsByCanonical.get(canonical).push(String(person.id));
    }
    return { aliasToCanonical, groupsByCanonical };
  }

  function mergeCacheMatches(stamp, library, resolve) {
    return personMergeCache?.stamp === stamp && personMergeCache.library.deref() === library
      && personMergeCache.people.deref() === library.people
      && (!resolve?.identitySnapshot || personMergeCache.identity === resolve.identitySnapshot);
  }

  // Names and aliases are search hints, never identity authority. Only a durable,
  // explicitly confirmed merge may redirect an ID, independently of the library.
  function canonicalId(personId) {
    return String(resolveCanonicalId(String(personId || "")));
  }

  function batchCanonicalId() {
    const resolve = createCanonicalIdReader?.() || resolveCanonicalId;
    const read = (personId) => String(resolve(String(personId || "")));
    read.identitySnapshot = resolve.identitySnapshot;
    return read;
  }

  function members(personId) {
    const library = getLibrary();
    return membersForId(library, canonicalId(personId), maps().groupsByCanonical);
  }

  function membersForId(library, canonicalPersonId, groups) {
    const ids = groups.get(canonicalPersonId) || [canonicalPersonId];
    return ids.map((id) => library.peopleById.get(id)).filter(Boolean);
  }

  function aliasNames(personId) {
    return aliasNamesForId(getLibrary(), canonicalId(personId), actorProfileRow, members);
  }

  function createAliasNameReader(readRow) {
    const { library, resolve, canonicalMembers } = createMergeReader();
    return (id) => aliasNamesForId(library, resolve(id), readRow, canonicalMembers);
  }

  function createMergeReader({ isolateFallback = false } = {}) {
    const stamp = getStamp();
    const library = getLibrary();
    const resolve = batchCanonicalId();
    const isolated = isolateFallback && !resolve.identitySnapshot;
    if (!isolated && personMergeCache && !mergeCacheMatches(stamp, library, resolve)) {
      personMergeCache = null;
      personRecordCache.clear();
    }
    let groups;
    const mergeMaps = isolated ? () => buildMergeMaps(library.people, resolve) : () => mapsForStamp(stamp, resolve);
    const canonicalMembers = (id) => membersForId(library, id, groups ??= mergeMaps().groupsByCanonical);
    return { stamp, library, resolve, canonicalMembers, recordCache: isolated ? new Map() : personRecordCache };
  }

  function aliasNamesForId(library, canonicalPersonId, readRow, readMembers) {
    const canonicalRow = readRow(canonicalPersonId);
    const primary = new Set(
      uniquePersonNames([
        library.peopleById.get(canonicalPersonId)?.name,
        canonicalRow?.person_name,
        canonicalRow?.display_name
      ]).map(normalizePersonSearchValue)
    );
    const names = [];
    for (const person of readMembers(canonicalPersonId)) {
      const row = readRow(person.id);
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
    return recordAtStamp(person, getLibrary(), stamp, canonicalId, members);
  }

  function records(people) {
    if (!people.length) return [];
    const { stamp, library, resolve, canonicalMembers } = createMergeReader();
    const readMembers = (id) => canonicalMembers(resolve(id));
    return people.map((person) => person ? recordAtStamp(person, library, stamp, resolve, readMembers) : null);
  }

  function recordAtStamp(person, library, stamp, resolve, readMembers, recordCache = personRecordCache) {
    if (recordCache === personRecordCache && personRecordCacheStamp !== stamp) {
      personRecordCacheStamp = stamp;
      personRecordCache.clear();
    }
    const canonicalPersonId = resolve(person.id);
    if (recordCache.has(canonicalPersonId)) return recordCache.get(canonicalPersonId);
    const canonical = library.peopleById.get(canonicalPersonId) || person;
    const mergedMembers = readMembers(canonicalPersonId);
    if (mergedMembers.length <= 1) {
      recordCache.set(canonicalPersonId, canonical);
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
    recordCache.set(canonicalPersonId, mergedRecord);
    return mergedRecord;
  }

  function displayName(person) {
    return displayNameForPerson(person, actorProfileRow);
  }

  function displayNameForPerson(person, readRow) {
    const row = person?.id ? readRow(person.id) : null;
    return row ? preferredPersonDisplayName(row, person?.name || "") : person?.name || "";
  }

  function searchNames(person) {
    return searchNamesForPerson(person, actorProfileRow, aliasNames);
  }

  function createSearchReader(readRow, normalizeSearchValue) {
    const { stamp, library, resolve, canonicalMembers, recordCache } = createMergeReader({ isolateFallback: true });
    const readMembers = (id) => canonicalMembers(resolve(id));
    const readAliases = (id) => aliasNamesForId(library, resolve(id), readRow, canonicalMembers);
    const searchNames = (person) => searchNamesForPerson(person, readRow, readAliases);
    const identity = resolve.identitySnapshot;
    const profile = readRow.profileSnapshot;
    if (profile && readRow.identitySnapshot !== identity) readRow.cacheable = false;
    return {
      displayName: (person) => displayNameForPerson(person, readRow),
      members: readMembers,
      record: (person) => recordAtStamp(person, library, stamp, resolve, readMembers, recordCache),
      searchNames,
      ...searchNameKeys({ stamp, library, identity, profile, readRow, searchNames, normalizeSearchValue })
    };
  }

  function searchNameKeys({ stamp, library, identity, profile, readRow, searchNames, normalizeSearchValue }) {
    if (!identity || !profile || readRow.cacheable === false || !normalizeSearchValue) return {};
    const people = library.people;
    const cached = personSearchNameCache;
    if (cached?.stamp === stamp && cached.library.deref() === library && cached.people.deref() === people
      && cached.identity === identity && cached.profile === profile && cached.normalizeSearchValue === normalizeSearchValue) {
      return { searchNameKeys: (_person, index) => cached.keys?.[index] || null };
    }
    personSearchNameCache = null;
    let bytes = people.length * 64;
    let keys = bytes <= PERSON_SEARCH_NAMES_MAX_BYTES ? [] : null;
    return {
      searchNameKeys(person, index) {
        if (!keys) return null;
        const projected = [];
        for (const name of searchNames(person)) {
          const lower = name.toLowerCase();
          const exact = normalizePersonSearchValue(name);
          const fuzzy = normalizeSearchValue(name);
          projected.push(lower, exact, fuzzy);
          bytes += 80 + 2 * (lower.length + exact.length + fuzzy.length);
        }
        if (bytes > PERSON_SEARCH_NAMES_MAX_BYTES) keys = null;
        else keys[index] = projected;
        return projected;
      },
      finishSearchNameKeys() {
        if (readRow.cacheable === false || (keys && keys.length !== people.length)) return;
        // An oversized catalog keeps only its owner marker until the next revision.
        personSearchNameCache = {
          stamp, library: new WeakRef(library), people: new WeakRef(people),
          identity, profile, normalizeSearchValue, keys
        };
      }
    };
  }

  function searchNamesForPerson(person, readRow, readAliases) {
    if (!person) return [];
    const row = readRow(person.id);
    return uniquePersonNames([
      person.name,
      row?.person_name,
      row?.display_name,
      ...actorProfileAliases(row),
      ...readAliases(person.id)
    ]);
  }

  function displayPersonForWork(personId) {
    const library = getLibrary();
    return record(library.peopleById.get(canonicalId(personId)));
  }

  function invalidate() {
    personMergeCache = null;
    personSearchNameCache = null;
    personRecordCacheStamp = "";
    personRecordCache.clear();
  }

  return {
    aliasNames,
    canonicalId,
    createAliasNameReader,
    createSearchReader,
    displayName,
    displayPersonForWork,
    invalidate,
    maps,
    members,
    record,
    records,
    searchNames
  };
}
