// Local chapter IDs are independent of both source IDs and display order.
// Reconciliation requires complete immutable snapshots. A caller must compare
// the persisted generation in the same transaction before replacing a book.
const identityRecord = value => value && typeof value === "object" && !Array.isArray(value);
const identityString = value => typeof value === "string" && value.trim() === value && value.length > 0;
const identityRatio = value => Math.max(0, Math.min(1, Number(value) || 0));

function identityUuid() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("当前环境无法创建稳定章节身份");
}

function identityGroups(chapters, field) {
  const groups = new Map();
  for (const chapter of chapters) {
    const key = field === "title" ? chapter.title.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") : chapter[field];
    if (field === "content" ? !/[^ \t\r\n]/.test(key) : !key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chapter);
  }
  return groups;
}

function identityChapters(entry, requireIds) {
  if (!identityRecord(entry?.book) || !identityString(entry.book.id) || !Array.isArray(entry.chapters) || !entry.chapters.length) {
    throw new Error("本地小说缺少完整书籍与章节快照");
  }
  const indices = new Set(), ids = new Set();
  for (const chapter of entry.chapters) {
    if (!identityRecord(chapter) || typeof chapter.content !== "string"
      || typeof chapter.title !== "string" || !Number.isInteger(chapter.index) || chapter.index < 1 || indices.has(chapter.index)
      || (chapter.bookId != null && chapter.bookId !== entry.book.id)) throw new Error("本地小说章节快照不完整或顺序重复");
    indices.add(chapter.index);
    if (requireIds && (!identityString(chapter.id) || ids.has(chapter.id))) throw new Error("本地小说章节身份无效或重复");
    if (identityString(chapter.id)) ids.add(chapter.id);
  }
  return entry.chapters;
}

function identityAnchor(progress, chapter = null, source = false) {
  const ratio = progress?.scrollRatio ?? progress?.scroll_ratio;
  const result = {
    chapterId: source ? null : (identityString(progress?.chapterId) ? progress.chapterId : chapter?.id || null),
    chapterIndex: Number(progress?.chapterIndex ?? progress?.chapter_index ?? chapter?.index) || null,
    scrollRatio: typeof ratio === "number" && Number.isFinite(ratio) ? ratio : null,
    catalogRevision: source ? null : (identityString(progress?.catalogRevision) ? progress.catalogRevision : null)
  };
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1 || progress?.invalidScrollRatio) result.invalidScrollRatio = true;
  const title = typeof progress?.title === "string" ? progress.title : chapter?.title;
  if (typeof title === "string") result.title = title;
  if (source) {
    result.sourceChapterId = identityString(progress?.chapterId) ? progress.chapterId : null;
    result.sourceCatalogRevision = identityString(progress?.catalogRevision) ? progress.catalogRevision : null;
  }
  return result;
}

export function safeLocalProgressRecovery(value) {
  if (!identityRecord(value) || !["needs_review", "unresolved"].includes(value.status) || !identityRecord(value.previous)) return null;
  const previous = identityAnchor(value.previous);
  for (const field of ["sourceChapterId", "sourceCatalogRevision"]) {
    if (typeof value.previous[field] === "string" || value.previous[field] === null) previous[field] = value.previous[field];
  }
  const result = { status: value.status, reason: typeof value.reason === "string" ? value.reason : "unresolved", previous };
  if (value.status === "needs_review" && identityRecord(value.candidate)
    && identityString(value.candidate.chapterId) && identityString(value.candidate.catalogRevision)
    && Number.isInteger(value.candidate.chapterIndex) && value.candidate.chapterIndex > 0) {
    result.candidate = { chapterId: value.candidate.chapterId, chapterIndex: value.candidate.chapterIndex,
      scrollRatio: 0, catalogRevision: value.candidate.catalogRevision };
    if (typeof value.candidate.title === "string") result.candidate.title = value.candidate.title;
  }
  return result;
}

export function reconcileLocalNovelEntry(existing, incoming, {
  allocateId = () => "chapter:" + identityUuid(),
  allocateRevision = () => "catalog:" + identityUuid(),
  legacySnapshot = false
} = {}) {
  const after = identityChapters(incoming, false);
  const before = existing ? identityChapters(existing, true) : [];
  if (existing && existing.book.id !== incoming.book.id) throw new Error("不能跨书籍协调章节身份");
  if (existing && !identityString(existing.book.catalogRevision)) throw new Error("旧书籍缺少目录版本，不能猜测章节身份");
  const revision = allocateRevision();
  if (!identityString(revision) || revision === existing?.book.catalogRevision) throw new Error("新目录版本无效或重复");
  const oldBodies = identityGroups(before, "content"), newBodies = identityGroups(after, "content");
  const oldTitles = identityGroups(before, "title"), newTitles = identityGroups(after, "title");
  const legacyIds = legacySnapshot ? identityGroups(after, "id") : new Map();
  const allocated = new Set([...before.map(chapter => chapter.id), ...(legacySnapshot ? after.map(chapter => chapter.id).filter(identityString) : [])]);
  const preserved = new Map();
  const chapters = after.map(chapter => {
    const exact = oldBodies.get(chapter.content);
    let id;
    if (legacySnapshot && identityString(chapter.id) && legacyIds.get(chapter.id)?.length === 1) {
      // Preserve an existing unique ID as an opaque value; its spelling is not
      // used as evidence of chapter identity or of the old reading position.
      id = chapter.id;
    } else if (exact?.length === 1 && newBodies.get(chapter.content)?.length === 1) {
      id = exact[0].id; preserved.set(id, chapter);
    } else {
      id = allocateId();
      if (!identityString(id) || allocated.has(id)) throw new Error("新章节身份无效、重复或碰撞旧章节");
      allocated.add(id);
    }
    return { ...chapter, id, bookId: incoming.book.id };
  });
  const book = { ...incoming.book, catalogRevision: revision, progress: null, progressRecovery: null };
  const result = { ...incoming, book, chapters, catalogRevision: revision };
  const makeResolved = (chapter, progress) => ({ chapterId: chapter.id, chapterIndex: chapter.index,
    scrollRatio: identityRatio(progress.scrollRatio ?? progress.scroll_ratio), catalogRevision: revision,
    ...(typeof progress.updatedAt === "string" ? { updatedAt: progress.updatedAt } : {}) });

  if (existing?.book.progressRecovery) {
    const recovery = safeLocalProgressRecovery(existing.book.progressRecovery);
    if (recovery) book.progressRecovery = { status: "unresolved", reason: recovery.reason, previous: recovery.previous };
    return result; // An earlier unresolved decision is never silently revived.
  }
  if (!existing) {
    if (incoming.book.sourceProgressRecovery) {
      const sourcePrevious = incoming.book.sourceProgressRecovery.previous || {};
      book.progressRecovery = { status: "unresolved", reason: "source_needs_review", previous: identityAnchor(sourcePrevious, null, true) };
    } else if (identityRecord(incoming.book.sourceProgress)) {
      const progress = incoming.book.sourceProgress;
      const matching = chapters.filter(chapter => chapter.sourceChapterId === progress.chapterId
        && chapter.sourceCatalogRevision === progress.catalogRevision);
      if (identityString(progress.chapterId) && identityString(progress.catalogRevision)
        && progress.catalogRevision === incoming.book.sourceCatalogRevision && matching.length === 1
        && typeof progress.scrollRatio === "number" && Number.isFinite(progress.scrollRatio) && progress.scrollRatio >= 0 && progress.scrollRatio <= 1
        && Number(progress.chapterIndex) === matching[0].index) book.progress = makeResolved(matching[0], progress);
      else book.progressRecovery = { status: "unresolved", reason: "source_anchor_mismatch", previous: identityAnchor(progress, null, true) };
    } else if (legacySnapshot && identityRecord(incoming.book.progress)) {
      // A co-located ordinal does not prove earlier reimports were correct.
      // Keep the old anchor visible, but require an explicit chapter selection.
      const progress = incoming.book.progress;
      const chapter = chapters.find(chapter => chapter.index === Number(progress.chapterIndex ?? progress.chapter_index));
      book.progressRecovery = { status: "unresolved", reason: "legacy_unverified", previous: identityAnchor(progress, chapter ? { index: chapter.index, title: chapter.title } : null) };
    }
    return result;
  }
  const progress = existing.book.progress;
  if (!identityRecord(progress)) return result;
  const oldChapter = before.find(chapter => chapter.id === progress.chapterId);
  const previous = identityAnchor(progress, oldChapter);
  if (progress.catalogRevision !== existing.book.catalogRevision) {
    book.progressRecovery = { status: "unresolved", reason: "stale_revision", previous }; return result;
  }
  if (!oldChapter || Number(progress.chapterIndex) !== oldChapter.index) {
    book.progressRecovery = { status: "unresolved", reason: "old_chapter_missing", previous }; return result;
  }
  if (typeof progress.scrollRatio !== "number" || !Number.isFinite(progress.scrollRatio) || progress.scrollRatio < 0 || progress.scrollRatio > 1) {
    book.progressRecovery = { status: "unresolved", reason: "invalid_ratio", previous }; return result;
  }
  const mapped = chapters.find(chapter => chapter.id === oldChapter.id);
  if (mapped && preserved.has(oldChapter.id)) { book.progress = makeResolved(mapped, progress); return result; }
  const title = oldChapter.title.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const titleMatches = newTitles.get(title) || [];
  const candidateHasIdentity = titleMatches.length === 1 && [...preserved.values()].some(chapter => chapter.index === titleMatches[0].index);
  if (oldBodies.get(oldChapter.content)?.length === 1 && (newBodies.get(oldChapter.content)?.length || 0) <= 1
    && title && oldTitles.get(title)?.length === 1 && titleMatches.length === 1 && !candidateHasIdentity
    && (newBodies.get(titleMatches[0].content)?.length || 0) <= 1 && titleMatches[0].content !== oldChapter.content) {
    const candidate = chapters.find(chapter => chapter.index === titleMatches[0].index);
    book.progressRecovery = { status: "needs_review", reason: "content_changed", previous,
      candidate: { chapterId: candidate.id, chapterIndex: candidate.index, title: candidate.title, scrollRatio: 0, catalogRevision: revision } };
  } else {
    const ambiguous = (oldBodies.get(oldChapter.content)?.length || 0) > 1 || (newBodies.get(oldChapter.content)?.length || 0) > 1;
    book.progressRecovery = { status: "unresolved", reason: ambiguous ? "ambiguous_content" : "no_unique_match", previous };
  }
  return result;
}
