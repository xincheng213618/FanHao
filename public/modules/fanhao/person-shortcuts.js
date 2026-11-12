const STORAGE_PREFIX = "fanhao.people-shortcuts.v1:";
const PIN_LIMIT = 12;
const RECENT_LIMIT = 8;

function ids(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === "string" && id))].slice(0, limit);
}

export function createPersonShortcutStore(getOwner) {
  const volatile = new Map();
  const empty = () => ({ pinned: [], recent: [] });

  function key(scope) {
    try {
      const owner = getOwner();
      return owner ? `${STORAGE_PREFIX}${encodeURIComponent(owner)}:${scope === "western" ? "western" : "main"}` : "";
    } catch { return ""; }
  }

  function read(storageKey) {
    if (!storageKey) return empty();
    if (volatile.has(storageKey)) return volatile.get(storageKey);
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
      return { pinned: ids(value?.pinned, PIN_LIMIT), recent: ids(value?.recent, RECENT_LIMIT) };
    } catch { return empty(); }
  }

  function write(storageKey, value) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
      volatile.delete(storageKey);
    } catch { volatile.set(storageKey, value); }
  }

  return {
    available(scope) { return Boolean(key(scope)); },
    list(scope) { return read(key(scope)); },
    visit(scope, id) {
      const storageKey = key(scope);
      if (!storageKey || !id) return;
      const value = read(storageKey);
      if (value.recent[0] === id) return;
      write(storageKey, { ...value, recent: [id, ...value.recent.filter((entry) => entry !== id)].slice(0, RECENT_LIMIT) });
    },
    togglePin(scope, id, visibleIds) {
      const storageKey = key(scope);
      if (!storageKey) return "当前账号不可用";
      const value = read(storageKey);
      if (value.pinned.includes(id)) {
        write(storageKey, { ...value, pinned: value.pinned.filter((entry) => entry !== id) });
        return "";
      }
      const pinned = value.pinned.filter((entry) => visibleIds.has(entry));
      if (pinned.length >= PIN_LIMIT) return `已固定 ${PIN_LIMIT} 位人物，请先取消一位`;
      write(storageKey, { ...value, pinned: [...pinned, id] });
      return "";
    },
    clearRecent(scope) {
      const storageKey = key(scope);
      if (storageKey) write(storageKey, { ...read(storageKey), recent: [] });
    }
  };
}

export function resolvePersonShortcuts(people, { pinned, recent }) {
  const wanted = new Set([...pinned, ...recent]);
  const matching = new Map();
  for (const person of people) {
    if (!wanted.size) break;
    const id = String(person.id);
    if (wanted.delete(id)) matching.set(id, person);
  }
  const fixed = new Set(pinned);
  const resolve = (entries) => entries.map((id) => matching.get(id)).filter(Boolean);
  return { pinned: resolve(pinned), recent: resolve(recent.filter((id) => !fixed.has(id))) };
}
