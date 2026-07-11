import { escapeLike } from "./helpers.js";
import { normalizeMusicLanguage } from "./language.js";
import { findSmartMix, smartMixCondition } from "./smart-mix.js";
import { musicSearchIndexCondition, musicSearchIndexKind, musicSearchIndexTerm } from "./search.js";

export function catalogFilter(params = new URLSearchParams()) {
  const q = String(params.get("q") || params.get("search") || "").trim();
  const artistId = String(params.get("artist") || params.get("artistId") || "").trim();
  const albumId = String(params.get("album") || params.get("albumId") || "").trim();
  const genre = String(params.get("genre") || params.get("musicGenre") || "").trim();
  const language = normalizeMusicLanguage(params.get("language") || params.get("lang"));
  const smartMix = findSmartMix(params.get("smart") || params.get("smartId"));
  const favorite = ["1", "true", "yes"].includes(String(params.get("favorite") || "").trim().toLowerCase());
  const trackWhere = ["t.status = 'ok'"];
  const trackArgs = [];
  const albumWhere = [];
  const albumArgs = [];
  let searchKind = "";
  if (artistId && artistId !== "all") {
    trackWhere.push("t.artist_id = ?");
    trackArgs.push(artistId);
    albumWhere.push("al.artist_id = ?");
    albumArgs.push(artistId);
  }
  if (albumId && albumId !== "all") {
    trackWhere.push("t.album_id = ?");
    trackArgs.push(albumId);
  }
  if (genre && genre !== "all") {
    trackWhere.push("t.genre = ? COLLATE NOCASE");
    trackArgs.push(genre);
    albumWhere.push("al.id IN (SELECT album_id FROM music_tracks WHERE status = 'ok' AND genre = ? COLLATE NOCASE)");
    albumArgs.push(genre);
  }
  if (language) {
    trackWhere.push("t.language = ?");
    trackArgs.push(language);
    albumWhere.push("a.language = ?");
    albumArgs.push(language);
  }
  if (favorite) trackWhere.push("COALESCE(s.favorite, 0) = 1");
  if (smartMix) {
    const condition = smartMixCondition(smartMix);
    trackWhere.push(condition.where);
    trackArgs.push(...condition.args);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    searchKind = musicSearchIndexKind(q);
    if (searchKind) {
      trackWhere.push(musicSearchIndexCondition(searchKind));
      trackArgs.push(musicSearchIndexTerm(searchKind, q));
    } else {
      trackWhere.push(`(
        t.title LIKE ? ESCAPE '\\' OR
        t.display_artist LIKE ? ESCAPE '\\' OR
        t.album_title LIKE ? ESCAPE '\\' OR
        t.genre LIKE ? ESCAPE '\\' OR
        t.file_name LIKE ? ESCAPE '\\'
      )`);
      trackArgs.push(like, like, like, like, like);
    }
    albumWhere.push(`(
      al.title LIKE ? ESCAPE '\\' OR
      a.name LIKE ? ESCAPE '\\'
    )`);
    albumArgs.push(like, like);
  }
  return {
    q,
    artistId,
    albumId,
    genre,
    language,
    smartId: smartMix?.id || "",
    favorite,
    needsState: favorite || Boolean(smartMix),
    searchKind,
    trackWhere: trackWhere.join(" AND "),
    trackArgs,
    albumWhere: albumWhere.join(" AND "),
    albumArgs
  };
}
