// Candidate contract only: no application imports, persistence, migration, or API wiring.
// IDs are allocated by the caller, never derived from title, locator, or ordinal.
// A realm is an explicit library/server authority, not the currently selected URL.
// legacyId is an old opaque book ID, NOT a sourceKey (which may contain text excerpts).
// PRECONDITION: oldChapters is the immutable snapshot that progress was recorded
// against. This candidate does not verify revisions. A production repository MUST
// check the saved revision/snapshot before calling it; updatedAt or ordinal is no proof.
const id = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new TypeError(`${label} must be a nonempty opaque ID without outer whitespace`);
  }
  return value;
};

export function qualifyLegacyAlias({ libraryId, realm, legacyId } = {}) {
  if (typeof realm !== "string" || !realm.trim()) {
    return { status: "unresolved", reason: "missing_realm", key: null };
  }
  return {
    status: "qualified",
    key: JSON.stringify(["legacy-book", id(libraryId, "libraryId"), id(realm, "realm"), id(legacyId, "legacyId")]),
  };
}

export function resolveImportIdentity({ qualifiedAlias = null, aliases = [], allocated, explicitWorkId } = {}) {
  if (qualifiedAlias && qualifiedAlias.status !== "qualified") {
    return { status: "unresolved", reason: qualifiedAlias.reason || "unqualified_alias" };
  }
  const chosenWork = explicitWorkId === undefined ? null : id(explicitWorkId, "explicitWorkId");
  const key = qualifiedAlias?.key;
  if (key) {
    const tuple = JSON.parse(key);
    if (!Array.isArray(tuple) || tuple.length !== 4 || tuple[0] !== "legacy-book"
        || JSON.stringify(tuple) !== key || tuple.slice(1).some((part) => typeof part !== "string" || !part.trim())) {
      throw new TypeError("qualifiedAlias must be a structured library/realm/legacy-ID tuple");
    }
  } else if (qualifiedAlias) {
    throw new TypeError("qualifiedAlias is missing its key");
  }
  const found = aliases.filter((alias) => key && alias.key === key);
  const identities = new Map(found.map((alias) => {
    const workId = id(alias.workId, "alias.workId");
    const editionId = id(alias.editionId, "alias.editionId");
    return [JSON.stringify([workId, editionId]), { workId, editionId }];
  }));
  if (identities.size > 1) return { status: "unresolved", reason: "alias_conflict" };
  if (identities.size === 1) {
    const identity = identities.values().next().value;
    if (chosenWork && chosenWork !== identity.workId) return { status: "unresolved", reason: "work_conflict" };
    return { status: "reused", reason: "qualified_alias", ...identity, aliasKey: key };
  }
  return {
    status: "created",
    reason: chosenWork ? "explicit_work_new_edition" : "new_identity",
    workId: chosenWork || id(allocated?.workId, "allocated.workId"),
    editionId: id(allocated?.editionId, "allocated.editionId"),
    aliasKey: key || null,
  };
}

function trustedReference(chapter) {
  const ref = chapter.upstream;
  if (ref?.trusted !== true) return null;
  return [id(ref.realm, "upstream.realm"), id(ref.sourceBindingId, "upstream.sourceBindingId"), id(ref.chapterId, "upstream.chapterId")];
}

function checkChapters(chapters, editionId, incoming = false) {
  if (!Array.isArray(chapters)) throw new TypeError("chapters must be an array");
  const ids = new Set();
  const ordinals = new Set();
  for (const chapter of chapters) {
    const chapterKey = id(chapter[incoming ? "allocatedId" : "id"], incoming ? "allocatedId" : "chapter.id");
    if (ids.has(chapterKey)) throw new TypeError("duplicate chapter ID");
    ids.add(chapterKey);
    if (chapter.editionId !== editionId) throw new TypeError("chapter belongs to a different edition");
    if (!Number.isInteger(chapter.ordinal) || chapter.ordinal < 1 || ordinals.has(chapter.ordinal)) {
      throw new TypeError("chapter ordinal must be positive and unique within this edition");
    }
    ordinals.add(chapter.ordinal);
    if (typeof chapter.title !== "string" || typeof chapter.content !== "string") {
      throw new TypeError("matching requires explicit title and full content, not a metadata-only entry");
    }
    trustedReference(chapter);
  }
  return ids;
}

function groups(chapters, keyFor) {
  const result = new Map();
  chapters.forEach((chapter, index) => {
    const key = keyFor(chapter);
    if (key === null) return;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(index);
  });
  return result;
}

function compatibleReferences(oldChapter, incoming) {
  const oldRef = trustedReference(oldChapter);
  const newRef = trustedReference(incoming);
  // A known different chapter in the SAME binding is conflicting evidence.
  // Different bindings can still be matched by unique text, never by bare upstream ID.
  return !oldRef || !newRef || oldRef[0] !== newRef[0] || oldRef[1] !== newRef[1] || oldRef[2] === newRef[2];
}

export function reconcileImportedChapters({ editionId, oldChapters, incomingChapters }) {
  id(editionId, "editionId");
  const oldIds = checkChapters(oldChapters, editionId);
  const allocatedIds = checkChapters(incomingChapters, editionId, true);
  for (const allocatedId of allocatedIds) {
    if (oldIds.has(allocatedId)) throw new TypeError("allocated chapter ID collides with an old chapter ID");
  }
  const referenceKey = (chapter) => {
    const reference = trustedReference(chapter);
    return reference ? JSON.stringify(reference) : null;
  };
  const oldReferences = groups(oldChapters, referenceKey);
  const newReferences = groups(incomingChapters, referenceKey);
  const blockedOld = new Set();
  const blockedNew = new Set();
  for (const key of new Set([...oldReferences.keys(), ...newReferences.keys()])) {
    if ((oldReferences.get(key)?.length || 0) > 1 || (newReferences.get(key)?.length || 0) > 1) {
      for (const index of oldReferences.get(key) || []) blockedOld.add(index);
      for (const index of newReferences.get(key) || []) blockedNew.add(index);
    }
  }
  const pairedOld = new Set();
  const pairedNew = new Map();
  const matchUnique = (basis, keyFor) => {
    // Uniqueness is counted across the COMPLETE snapshots, not only remaining items.
    const before = groups(oldChapters, keyFor);
    const after = groups(incomingChapters, keyFor);
    for (const [key, oldIndexes] of before) {
      const newIndexes = after.get(key);
      if (oldIndexes.length !== 1 || newIndexes?.length !== 1) continue;
      const oldIndex = oldIndexes[0];
      const newIndex = newIndexes[0];
      if (blockedOld.has(oldIndex) || blockedNew.has(newIndex) || pairedOld.has(oldIndex) || pairedNew.has(newIndex)) continue;
      if (!compatibleReferences(oldChapters[oldIndex], incomingChapters[newIndex])) continue;
      pairedOld.add(oldIndex);
      pairedNew.set(newIndex, { oldIndex, basis });
    }
  };
  const hasBody = (chapter) => Boolean(chapter.content.trim());
  matchUnique("trusted_upstream", referenceKey);
  matchUnique("unique_title_content", (chapter) => chapter.title.trim() && hasBody(chapter)
    ? JSON.stringify([chapter.title.trim(), chapter.content]) : null);
  matchUnique("unique_content", (chapter) => hasBody(chapter) ? chapter.content : null);
  matchUnique("unique_title", (chapter) => chapter.title.trim() || null);

  const matches = [];
  const chapters = incomingChapters.map((incoming, newIndex) => {
    const pair = pairedNew.get(newIndex);
    const old = pair ? oldChapters[pair.oldIndex] : null;
    const chapterIdentityPreserved = Boolean(pair && pair.basis !== "unique_title");
    const chapterId = chapterIdentityPreserved ? old.id : incoming.allocatedId;
    if (pair) matches.push({
      oldChapterId: old.id,
      chapterId,
      basis: pair.basis,
      chapterIdentityPreserved,
      contentUnchanged: hasBody(old) && old.content === incoming.content,
    });
    return {
      id: chapterId, editionId, ordinal: incoming.ordinal, title: incoming.title, content: incoming.content,
      ...(incoming.upstream ? { upstream: { ...incoming.upstream } } : {}),
    };
  }).sort((left, right) => left.ordinal - right.ordinal);
  return {
    editionId, chapters, matches,
    unmatchedOld: oldChapters.flatMap((chapter, index) => pairedOld.has(index) ? [] : [{
      chapterId: chapter.id,
      reason: blockedOld.has(index) ? "ambiguous_upstream" : "no_unique_match",
    }]),
  };
}

export function remapImportedProgress({ editionId, oldChapters, chapters, matches, progress }) {
  id(editionId, "editionId");
  checkChapters(oldChapters, editionId);
  checkChapters(chapters, editionId);
  const previousProgress = progress ? { ...progress } : null;
  const unresolved = (reason) => ({ status: "unresolved", reason, needsReview: true, progress: null, previousProgress });
  if (!progress) return unresolved("missing_progress");
  if (progress.editionId !== editionId) return unresolved("different_edition");
  if (!Number.isFinite(progress.scrollRatio) || progress.scrollRatio < 0 || progress.scrollRatio > 1) {
    return unresolved("invalid_ratio");
  }
  const old = oldChapters.find((chapter) => chapter.id === progress.chapterId);
  if (!old) return unresolved("old_chapter_missing");
  const links = matches.filter((match) => match.oldChapterId === old.id);
  if (links.length !== 1) return unresolved("no_unique_match");
  const link = links[0];
  const chapter = chapters.find((item) => item.id === link.chapterId);
  if (!chapter || (link.chapterIdentityPreserved === true ? chapter.id !== old.id
    : link.chapterIdentityPreserved !== false || link.basis !== "unique_title" || chapter.id === old.id)) {
    return unresolved("invalid_match");
  }
  const contentUnchanged = link.chapterIdentityPreserved && Boolean(old.content.trim()) && old.content === chapter.content;
  // An ordinal/legacy timestamp is not an identity or a causal sync revision.
  // Keep previousProgress for a caller-owned review UI; do not persist here.
  return {
    status: contentUnchanged ? "mapped" : "reset",
    reason: contentUnchanged ? link.basis : "content_changed",
    basis: link.basis,
    chapterIdentityPreserved: link.chapterIdentityPreserved,
    needsReview: !contentUnchanged,
    progress: { editionId, chapterId: chapter.id, ordinal: chapter.ordinal, scrollRatio: contentUnchanged ? progress.scrollRatio : 0 },
    previousProgress,
  };
}
