import {
  MUSIC_FACET_CACHE,
  MUSIC_FACET_CACHE_MAX_ENTRIES,
  MUSIC_FACET_CACHE_MAX_ESTIMATED_BYTES,
  MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES,
  MUSIC_FACET_CACHE_MAX_KEY_BYTES
} from "./constants.js";

// Cache values remain Maps so scan publication can discard a connection's
// cache through MUSIC_FACET_CACHE.delete(db). Metadata owns neither the db nor
// the cached rows, and disappears with the corresponding Map.
const cacheWeights = new WeakMap();

export function cachedMusicFacet(db, key, build) {
  const keyBytes = Buffer.byteLength(key, "utf8");
  if (keyBytes > MUSIC_FACET_CACHE_MAX_KEY_BYTES) return build();

  let cache = MUSIC_FACET_CACHE.get(db);
  if (cache?.has(key)) {
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  const value = build();
  const estimatedBytes = estimateEntryBytes(keyBytes, value);
  if (estimatedBytes > MUSIC_FACET_CACHE_MAX_ENTRY_ESTIMATED_BYTES) return value;

  if (!cache) {
    cache = new Map();
    MUSIC_FACET_CACHE.set(db, cache);
  }
  let weights = cacheWeights.get(cache);
  if (!weights) {
    weights = { entries: new Map(), estimatedBytes: 0 };
    cacheWeights.set(cache, weights);
  } else if (cache.size === 0) {
    weights.entries.clear();
    weights.estimatedBytes = 0;
  }

  while (cache.size >= MUSIC_FACET_CACHE_MAX_ENTRIES
    || weights.estimatedBytes + estimatedBytes > MUSIC_FACET_CACHE_MAX_ESTIMATED_BYTES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
    weights.estimatedBytes -= weights.entries.get(oldest) || 0;
    weights.entries.delete(oldest);
  }
  cache.set(key, value);
  weights.entries.set(key, estimatedBytes);
  weights.estimatedBytes += estimatedBytes;
  return value;
}

function estimateEntryBytes(keyBytes, value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? keyBytes + Buffer.byteLength(json, "utf8") : Infinity;
  } catch {
    return Infinity;
  }
}
