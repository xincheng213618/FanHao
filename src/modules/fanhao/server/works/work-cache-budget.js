const canonicalSorts = new Set([
  "title", "updated", "videos", "progress", "releaseDesc", "releaseAsc",
  "ratingDesc", "ratingAsc", "ratingCountDesc", "popularityDesc",
  "sizeDesc", "sizeAsc", "durationDesc", "durationAsc", "codeAsc", "codeDesc"
]);

export function normalizeWorkSortMode(value) {
  if (value === "size") return "sizeDesc";
  if (value === "duration") return "durationDesc";
  return canonicalSorts.has(value) ? value : "updated";
}

// Owners keep their ordinary Map/WeakMap lifetime. The global eviction index
// holds only weak references, so a sorted result cannot keep its source key
// alive merely because it was registered for a shared reference budget.
export function createWeightedCacheBudget(maxWeight, maxEntries = 8192) {
  const entries = new Map();
  const owners = new WeakMap();
  let weight = 0;

  function remove(token, evict) {
    const entry = entries.get(token);
    if (!entry) return;
    entries.delete(token);
    weight -= entry.weight;
    const owner = entry.owner.deref();
    const value = entry.value.deref();
    if (owner) {
      const index = owners.get(owner);
      if (index?.get(entry.key) === token) index.delete(entry.key);
      if (evict && value && owner.get(entry.key) === value) owner.delete(entry.key);
    }
  }

  function sweep() {
    for (const [token, entry] of entries) {
      const owner = entry.owner.deref();
      const value = entry.value.deref();
      if (!owner || !value || owner.get(entry.key) !== value) remove(token, false);
    }
  }

  function read(owner, key) {
    const value = owner.get(key);
    if (value === undefined) return undefined;
    owner.delete(key); owner.set(key, value);
    const token = owners.get(owner)?.get(key);
    const entry = entries.get(token);
    if (entry) { entries.delete(token); entries.set(token, entry); }
    return value;
  }

  function drop(owner, key) {
    const token = owners.get(owner)?.get(key);
    if (token !== undefined) remove(token, false);
    owner.delete(key);
  }

  function write(owner, key, value, nextWeight, entryLimit = Infinity) {
    drop(owner, key);
    nextWeight = Math.max(0, Number(nextWeight) || 0);
    if (nextWeight > maxWeight) return value;
    // Normal admissions are O(1). Reconcile abandoned weak owners when their
    // recorded weight or metadata count would otherwise force an eviction.
    if (weight + nextWeight > maxWeight || entries.size >= maxEntries) sweep();
    while (entries.size && (weight + nextWeight > maxWeight || entries.size >= maxEntries)) {
      remove(entries.keys().next().value, true);
    }
    owner.set(key, value);
    let index = owners.get(owner);
    if (!index) { index = new Map(); owners.set(owner, index); }
    const token = Symbol();
    index.set(key, token);
    entries.set(token, { key, owner: new WeakRef(owner), value: new WeakRef(value), weight: nextWeight });
    weight += nextWeight;
    while (owner.size > entryLimit) drop(owner, owner.keys().next().value);
    return value;
  }

  function clear(owner) {
    if (owner) { for (const key of owner.keys()) drop(owner, key); }
    else { for (const token of entries.keys()) remove(token, true); }
  }

  return { clear, drop, read, write, diagnostics: () => { sweep(); return { weight, entries: entries.size, maxWeight }; } };
}
