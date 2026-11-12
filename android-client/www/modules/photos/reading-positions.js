import { isAccountOwnerCurrent } from "../../js/account-owner.js";

const PREFIX = "fanhao.android.photoReadingPositions.v1:";
const LIMIT = 40;

function storageKey(scope) {
  return scope?.owner && scope.owner !== "pending" && isAccountOwnerCurrent(scope)
    ? PREFIX + JSON.stringify([scope.origin, scope.owner]) : "";
}

export function readPhotoPositions(scope) {
  const key = storageKey(scope);
  if (!key) return [];
  try {
    const items = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter(item => {
      if (!item || typeof item.id !== "string" || !item.id || seen.has(item.id)
        || typeof item.title !== "string" || typeof item.revision !== "string" || !item.revision
        || !Number.isSafeInteger(item.page) || item.page <= 1) return false;
      seen.add(item.id);
      return true;
    }).slice(0, LIMIT);
  } catch { return []; }
}

function write(scope, items) {
  const key = storageKey(scope);
  if (!key) return false;
  try {
    localStorage.setItem(key, JSON.stringify(items.slice(0, LIMIT)));
    return true;
  } catch { return false; }
}

export function savePhotoPosition(scope, album, page, revision) {
  const id = String(album.id || "");
  const total = Number(album.imageCount);
  if (!id || !revision || !Number.isSafeInteger(total) || !Number.isSafeInteger(page) || page < 1 || page > total) return false;
  const items = readPhotoPositions(scope);
  if (items[0]?.id === id && items[0].page === page && items[0].revision === revision) return false;
  const remaining = items.filter(item => item.id !== id);
  if (page > 1) remaining.unshift({ id, title: String(album.title || album.personName || "套图").slice(0, 200), revision, page });
  else if (remaining.length === items.length) return false;
  return write(scope, remaining);
}

export function discardPhotoPosition(scope, saved) {
  const positions = readPhotoPositions(scope);
  const remaining = positions.filter(item => item.id !== saved.id || item.revision !== saved.revision || item.page !== saved.page);
  return remaining.length < positions.length && write(scope, remaining);
}
