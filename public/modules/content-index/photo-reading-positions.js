import { captureWebAccount } from "../../platform/accounts/session-context.js";

const STORAGE_PREFIX = "fanhao.photo.readingPositions.v1:";
const MAX_POSITIONS = 40;

export function createPhotoReadingPositions() {
  function account() {
    try {
      const { owner, revision } = captureWebAccount();
      return { key: `${STORAGE_PREFIX}${owner || "guest"}`, revision };
    } catch { return null; }
  }

  function read(scope) {
    if (!scope) return [];
    try {
      const records = JSON.parse(globalThis.localStorage.getItem(scope.key) || "[]");
      return Array.isArray(records) ? records.filter(record => record && typeof record.id === "string"
        && typeof record.title === "string" && typeof record.archive === "string"
        && Number.isSafeInteger(record.page) && record.page > 1).slice(0, MAX_POSITIONS) : [];
    } catch { return []; }
  }

  function write(scope, records) {
    try { globalThis.localStorage.setItem(scope.key, JSON.stringify(records.slice(0, MAX_POSITIONS))); }
    catch { /* Reading is still available without browser storage. */ }
  }

  function archiveRevision(album) {
    return album?.imageRevision || album?.archiveIdentity || "";
  }

  function positionFor(album) {
    const archive = archiveRevision(album);
    if (!archive || !Number.isSafeInteger(album.imageCount)) return null;
    const scope = account();
    const records = read(scope);
    const saved = records.find(record => record.id === album.id);
    if (!saved) return null;
    if (saved.archive === archive && saved.page <= album.imageCount) return saved;
    write(scope, records.filter(record => record.id !== album.id));
    return { expired: true };
  }

  function recorder(album) {
    const scope = account();
    const archive = archiveRevision(album);
    if (!scope || !album?.id || !archive || !Number.isSafeInteger(album.imageCount)) return null;
    let lastPage = null;
    return (page) => {
      if (!Number.isSafeInteger(page) || page < 1 || page > album.imageCount || page === lastPage) return;
      const current = account();
      if (current?.key !== scope.key || current.revision !== scope.revision) return;
      lastPage = page;
      const records = read(scope);
      const previous = records.find(record => record.id === album.id);
      if (previous?.archive === archive && previous.page === page && records[0] === previous) return;
      const remaining = records.filter(record => record.id !== album.id);
      if (page > 1) remaining.unshift({ id: album.id, title: album.title || album.id, archive, page });
      else if (!previous) return;
      write(scope, remaining);
    };
  }

  return { positionFor, recorder, recent: () => read(account()) };
}
