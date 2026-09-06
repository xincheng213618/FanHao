// History carries opaque references, not caller-supplied request limits. The
// small session-only store cannot restore a range from a URL or a cold launch.
export function createChannelHistoryState() {
  const entries = new Map();
  const session = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let latest = null;
  return {
    capture(source, route, limit) {
      if (typeof source !== "string" || !source || typeof route !== "string" || !route
        || !Number.isSafeInteger(limit) || limit < 1) return "";
      if (latest && latest.source === source && latest.route === route && latest.limit === limit) return latest.token;
      const token = `${session}:${++sequence}`;
      const entry = { source, route, limit };
      entries.set(token, entry);
      latest = { ...entry, token };
      if (entries.size > 128) entries.delete(entries.keys().next().value);
      return token;
    },
    restore(token, source, route, fallback) {
      const entry = typeof token === "string" ? entries.get(token) : null;
      return entry && entry.source === source && entry.route === route
        ? Math.max(fallback, entry.limit) : fallback;
    }
  };
}
