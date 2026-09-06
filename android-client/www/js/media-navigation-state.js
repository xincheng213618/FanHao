const MEDIA_MODES = new Set(["movie", "tv", "anime", "media"]);
const SORTS = new Set(["updated", "count", "title", "size", "rating", "relevance"]);
const MAX_TRAIL_LENGTH = 8192;

function compatibleMode(parent, detail) {
  return MEDIA_MODES.has(parent) && MEDIA_MODES.has(detail)
    && (parent === detail || parent === "media" || detail === "media");
}

function channelState(value, mode) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !compatibleMode(value.mode, mode)) return null;
  const result = { mode: value.mode };
  for (const key of ["query", "category", "seriesKey"]) {
    if (value[key] === undefined || value[key] === "") continue;
    if (typeof value[key] !== "string" || value[key].length > 2048) return null;
    const text = value[key].trim();
    if (text && (key !== "seriesKey" || value.mode !== "movie")) result[key] = text;
  }
  if (value.sort !== undefined && value.sort !== "") {
    if (!SORTS.has(value.sort)) return null;
    result.sort = value.sort;
  }
  if (value.mode !== "movie" && (result.seriesKey || (value.mode !== "anime" && value.tvView === "episodes"))) result.tvView = "episodes";
  return result;
}

function isEpisodeList(params) {
  return ["tv", "anime", "media"].includes(params.mode) && Boolean(params.seriesKey || params.tvView === "episodes");
}

// A bounded string survives both URLSearchParams and last-view JSON. Entries
// contain channel fields only: never arbitrary views, URLs or recursive trails.
export function normalizeMediaTrail(value, mode) {
  if (typeof value !== "string" || value.length > MAX_TRAIL_LENGTH || !MEDIA_MODES.has(mode)) return "";
  try {
    const raw = JSON.parse(value);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return "";
    const entries = raw.map(entry => channelState(entry, mode));
    if (entries.some(entry => !entry)) return "";
    if (mode === "movie" && entries.some(isEpisodeList)) return "";
    if (entries.length === 2 && (isEpisodeList(entries[0]) || !isEpisodeList(entries[1]))) return "";
    const encoded = JSON.stringify(entries);
    return encoded.length <= MAX_TRAIL_LENGTH ? encoded : "";
  } catch {
    return "";
  }
}

export function captureMediaTrail(sourceView, sourceParams, targetMode) {
  if (sourceView === "mediaDetail") return normalizeMediaTrail(sourceParams.mediaTrail, targetMode);
  if (sourceView !== "channel") return "";
  const source = channelState(sourceParams, targetMode);
  if (!source) return "";
  const prior = isEpisodeList(source) ? normalizeMediaTrail(sourceParams.mediaTrail, targetMode) : "";
  const entries = prior ? JSON.parse(prior) : [];
  entries.push(source);
  return normalizeMediaTrail(JSON.stringify(entries), targetMode);
}

export function mediaBackTarget(view, params = {}) {
  if (view !== "mediaDetail" && !(view === "channel" && isEpisodeList(params))) return null;
  if (params.mode === "western") return { view: "people", params: { scope: "western" } };
  const mode = MEDIA_MODES.has(params.mode) ? params.mode : "movie";
  const trail = normalizeMediaTrail(params.mediaTrail, mode);
  if (trail) {
    const entries = JSON.parse(trail);
    const parent = entries.pop();
    // An episode page may only return to its catalog, never itself/another
    // episode page supplied by a malformed or stale navigation envelope.
    if (view !== "channel" || !isEpisodeList(parent)) {
      if (entries.length) parent.mediaTrail = JSON.stringify(entries);
      return { view: "channel", params: parent };
    }
  }
  return { view: "channel", params: { mode } };
}
