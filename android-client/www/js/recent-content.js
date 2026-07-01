const RECENT_CONTENT_STORAGE_KEY = "fanhao.android.recentContent";
const MAX_RECENT_CONTENT = 36;

export function readRecentContent(limit = 12) {
  const items = parseRecentContent();
  return items.slice(0, Math.max(0, Number(limit) || 0));
}

export function recordRecentContent(item) {
  const normalized = normalizeRecentItem(item);
  if (!normalized) return [];

  const current = parseRecentContent().filter((entry) => entry.key !== normalized.key);
  const next = [normalized, ...current].slice(0, MAX_RECENT_CONTENT);
  localStorage.setItem(RECENT_CONTENT_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function clearRecentContent() {
  localStorage.removeItem(RECENT_CONTENT_STORAGE_KEY);
}

function parseRecentContent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_CONTENT_STORAGE_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.map(normalizeRecentItem).filter(Boolean).sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)))
      : [];
  } catch {
    return [];
  }
}

function normalizeRecentItem(item = {}) {
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
    label: String(item.label || "").trim() || "内容",
    title: String(item.title || "").trim() || "未命名内容",
    subtitle: String(item.subtitle || "").trim(),
    meta: String(item.meta || "").trim(),
    coverUrl: String(item.coverUrl || "").trim(),
    fallback: String(item.fallback || item.title || item.label || "?").trim().slice(0, 2) || "?",
    openedAt: item.openedAt || new Date().toISOString()
  };
}
