import path from "node:path";

export const CURRENT_INDEX_SCHEMA = 3;
export const PARSER_VERSION = 2;

function normalizedPath(value) {
  return path.resolve(String(value || "")).replace(/\\/g, "/").toLowerCase();
}

function sortedExtensions(values) {
  return [...new Set([...(values || [])].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))].sort();
}

export function imageLibraryCacheIdentity({
  archiveExts = [],
  directVideoExts = [],
  galleryMediaSources = [],
  photoSetRoots = [],
  videoExts = []
} = {}) {
  return JSON.stringify({
    parserVersion: PARSER_VERSION,
    archiveExts: sortedExtensions(archiveExts),
    directVideoExts: sortedExtensions(directVideoExts),
    videoExts: sortedExtensions(videoExts),
    photoSetRoots: photoSetRoots.map(normalizedPath),
    galleryMediaSources: galleryMediaSources.map((source) => ({
      kind: String(source?.kind || ""),
      label: String(source?.label || ""),
      roots: (source?.roots || []).map(normalizedPath)
    }))
  });
}

export function imageLibraryIndexMatches(index, cacheIdentity) {
  return Boolean(
    index
    && Number(index.schemaVersion) === CURRENT_INDEX_SCHEMA
    && Number(index.parserVersion) === PARSER_VERSION
    && index.cacheIdentity === cacheIdentity
    && Array.isArray(index.photoSets)
    && Array.isArray(index.mediaItems)
  );
}
