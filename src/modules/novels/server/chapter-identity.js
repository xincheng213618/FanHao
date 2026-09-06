import { randomUUID } from "node:crypto";

// Full immutable snapshots of ONE book only. Ordinals, titles and hashes are
// never chapter identity. Compare exact stored text; do not normalize it here.
export function reconcileChapters({ oldChapters, incomingChapters, oldRevision, newRevision, progress = null, allocateId = randomUUID }) {
  const validate = (chapters, old) => {
    if (!Array.isArray(chapters)) throw new TypeError("章节快照必须完整");
    const indexes = new Set(), ids = new Set();
    for (const chapter of chapters) {
      if (!Number.isSafeInteger(chapter.index) || chapter.index < 1 || indexes.has(chapter.index)
          || typeof chapter.title !== "string" || typeof chapter.content !== "string"
          || (old && (typeof chapter.id !== "string" || !chapter.id || ids.has(chapter.id)))) {
        throw new TypeError("章节快照损坏");
      }
      indexes.add(chapter.index); ids.add(chapter.id);
    }
  };
  validate(oldChapters, true); validate(incomingChapters, false);
  if (typeof newRevision !== "string" || !newRevision || newRevision === oldRevision) throw new TypeError("目录版本必须更新");
  const groups = (chapters, keyFor) => {
    const map = new Map();
    for (const chapter of chapters) {
      const key = keyFor(chapter);
      if (key === null) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(chapter);
    }
    return map;
  };
  const bodyKey = chapter => /[^ \t\r\n]/.test(chapter.content) ? chapter.content : null;
  const titleKey = chapter => chapter.title.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") || null;
  const before = groups(oldChapters, bodyKey), after = groups(incomingChapters, bodyKey);
  const oldIds = new Set(oldChapters.map(chapter => chapter.id)), allocated = new Set();
  const retained = new Map(), assigned = new Set();
  const chapters = incomingChapters.map(chapter => {
    const key = bodyKey(chapter), previous = before.get(key);
    let id;
    if (key !== null && previous?.length === 1 && after.get(key)?.length === 1) {
      id = previous[0].id; retained.set(id, chapter.index); assigned.add(chapter.index);
    } else {
      id = allocateId();
      if (typeof id !== "string" || !id || oldIds.has(id) || allocated.has(id)) throw new TypeError("新章节身份冲突");
      allocated.add(id);
    }
    return { id, index: chapter.index, title: chapter.title, content: chapter.content };
  }).sort((a, b) => a.index - b.index);
  if (!progress) return { chapters, progress: null };
  const previous = progress.previous || {
    chapterId: progress.chapterId ?? null, chapterIndex: progress.chapterIndex ?? null,
    scrollRatio: progress.scrollRatio ?? null, catalogRevision: progress.catalogRevision ?? null,
    ...(typeof progress.title === "string" ? { title: progress.title } : {})
  };
  const unresolved = reason => ({ chapters, progress: { status: "unresolved", reason, previous } });
  if (progress.status !== "resolved") return unresolved(progress.reason || "previous_unresolved");
  if (!oldRevision || progress.catalogRevision !== oldRevision) return unresolved("stale_revision");
  const old = oldChapters.find(chapter => chapter.id === progress.chapterId);
  if (!old || old.index !== progress.chapterIndex) return unresolved("old_chapter_missing");
  if (typeof progress.scrollRatio !== "number" || !Number.isFinite(progress.scrollRatio)
      || progress.scrollRatio < 0 || progress.scrollRatio > 1) return unresolved("invalid_ratio");
  const index = retained.get(old.id);
  if (index !== undefined) return { chapters, progress: {
    status: "resolved", chapterId: old.id, chapterIndex: index,
    scrollRatio: progress.scrollRatio, catalogRevision: newRevision
  } };
  if ((before.get(bodyKey(old))?.length || 0) > 1 || (after.get(bodyKey(old))?.length || 0) > 1) return unresolved("ambiguous_content");
  const title = titleKey(old), oldTitles = groups(oldChapters, titleKey), newTitles = groups(chapters, titleKey);
  const candidates = newTitles.get(title);
  if (title && oldTitles.get(title)?.length === 1 && candidates?.length === 1) {
    const candidate = candidates[0];
    if (!assigned.has(candidate.index) && (after.get(bodyKey(candidate))?.length || 0) <= 1 && candidate.content !== old.content) {
      return { chapters, progress: { status: "needs_review", reason: "content_changed", previous,
        candidate: { chapterId: candidate.id, chapterIndex: candidate.index, scrollRatio: 0, catalogRevision: newRevision, title: candidate.title }
      } };
    }
  }
  return unresolved("no_unique_match");
}
