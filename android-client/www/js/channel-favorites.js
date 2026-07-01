const CHANNEL_FAVORITES_STORAGE_KEY = "fanhao.android.channelFavorites";
const MAX_CHANNEL_FAVORITES = 200;

export function readChannelFavorites(limit = MAX_CHANNEL_FAVORITES) {
  return parseChannelFavorites().slice(0, Math.max(0, Number(limit) || 0));
}

export function countChannelFavorites() {
  return parseChannelFavorites().length;
}

export function isChannelFavorite(item) {
  const normalized = normalizeFavoriteItem(item);
  if (!normalized) return false;
  return parseChannelFavorites().some((entry) => entry.key === normalized.key);
}

export function toggleChannelFavorite(item) {
  const normalized = normalizeFavoriteItem(item);
  if (!normalized) return { favorite: false, items: parseChannelFavorites() };

  const current = parseChannelFavorites();
  const exists = current.some((entry) => entry.key === normalized.key);
  const next = exists
    ? current.filter((entry) => entry.key !== normalized.key)
    : [{ ...normalized, favoritedAt: new Date().toISOString() }, ...current].slice(0, MAX_CHANNEL_FAVORITES);

  localStorage.setItem(CHANNEL_FAVORITES_STORAGE_KEY, JSON.stringify(next));
  return { favorite: !exists, items: next };
}

export function removeChannelFavorite(item) {
  const normalized = normalizeFavoriteItem(item);
  if (!normalized) return parseChannelFavorites();
  const next = parseChannelFavorites().filter((entry) => entry.key !== normalized.key);
  localStorage.setItem(CHANNEL_FAVORITES_STORAGE_KEY, JSON.stringify(next));
  return next;
}

function parseChannelFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHANNEL_FAVORITES_STORAGE_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.map(normalizeFavoriteItem).filter(Boolean).sort((a, b) => String(b.favoritedAt).localeCompare(String(a.favoritedAt)))
      : [];
  } catch {
    return [];
  }
}

function normalizeFavoriteItem(item = {}) {
  const view = String(item.view || "").trim();
  const params = item.params && typeof item.params === "object" ? item.params : {};
  const id = String(params.id || item.id || "").trim();
  if (!view || !id) return null;

  const chapterIndex = String(params.chapterIndex || item.chapterIndex || "").trim();
  const key = [view, id, chapterIndex].filter(Boolean).join(":");
  return {
    key,
    view,
    params: {
      id,
      ...(chapterIndex ? { chapterIndex } : {})
    },
    type: String(item.type || "").trim(),
    label: String(item.label || "").trim() || "频道",
    title: String(item.title || "").trim() || "未命名内容",
    subtitle: String(item.subtitle || "").trim(),
    meta: String(item.meta || "").trim(),
    coverUrl: String(item.coverUrl || "").trim(),
    fallback: String(item.fallback || item.title || item.label || "?").trim().slice(0, 2) || "?",
    favoritedAt: item.favoritedAt || new Date().toISOString()
  };
}
