const UNKNOWN_ARTISTS = new Set(["", "待识别", "未知歌手", "未知艺术家", "unknown artist"]);
const GENERIC_ARTISTS = new Set([
  "群星", "华语群星", "日本群星", "various artists", "various artist", "v.a.", "v.a",
  "dj", "纯音乐", "轻音乐", "轻松音乐", "轻音乐馆", "轻音乐钢琴曲", "二胡", "网络歌手",
  "瑜伽音乐", "佛教音乐", "店铺音乐盒", "催眠音乐盒", "胎教音乐", "放松睡眠音乐"
]);
const SUFFIX_DESCRIPTOR_PATTERN = /(?:live|remix|mix|dj|版|伴奏|纯音乐|现场|女声|男声|合唱|粤语|国语|钢琴|cover|翻唱|原唱|激情|环绕|无损|音质|mv|片段|试听|演奏|独奏|剪辑|加速|降调|升调|电音|咚鼓|抖音|instrumental|karaoke|feat\.?|ft\.?)/iu;
const TITLE_VERSION_PATTERN = /(?:[（(]\s*(?:live|remix|mix|version|ver\.?|现场|伴奏|版)\s*[）)]|\b(?:live|remix|version)\b)/iu;

export function normalizeMusicArtistIdentity(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s._·•-]+/gu, "")
    .trim()
    .toLocaleLowerCase();
}

export function isUnknownMusicArtist(value) {
  return UNKNOWN_ARTISTS.has(String(value || "").normalize("NFKC").trim().toLocaleLowerCase());
}

export function buildMusicIdentityKnowledge(entries = []) {
  const artistCounts = new Map();
  const titleArtists = new Map();
  for (const entry of entries) {
    const artist = cleanIdentityText(entry?.artist);
    const title = cleanIdentityText(entry?.title);
    const artistKey = normalizeMusicArtistIdentity(artist);
    if (!artistKey || isUnknownMusicArtist(artist) || GENERIC_ARTISTS.has(artist.toLocaleLowerCase())) continue;
    if (!artistCounts.has(artistKey)) artistCounts.set(artistKey, new Map());
    const spellings = artistCounts.get(artistKey);
    spellings.set(artist, Number(spellings.get(artist) || 0) + 1);
    const titleKey = normalizeMusicTitleIdentity(title);
    if (!isUsefulMusicTitle(title, titleKey)) continue;
    if (!titleArtists.has(titleKey)) titleArtists.set(titleKey, new Map());
    const artists = titleArtists.get(titleKey);
    artists.set(artistKey, Number(artists.get(artistKey) || 0) + 1);
  }

  const artistsByKey = new Map();
  for (const [key, spellings] of artistCounts) {
    const canonical = [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
    if (canonical) artistsByKey.set(key, canonical);
  }
  const artistByTitle = new Map();
  for (const [titleKey, artists] of titleArtists) {
    if (artists.size !== 1) continue;
    const [artistKey, count] = [...artists.entries()][0];
    if (count < 2 || !artistsByKey.has(artistKey)) continue;
    artistByTitle.set(titleKey, artistsByKey.get(artistKey));
  }
  return { artistsByKey, artistByTitle };
}

export function resolveMusicTrackIdentity(input = {}, knowledge = {}) {
  const taggedArtist = cleanIdentityText(input.artist);
  const taggedTitle = cleanIdentityText(input.title);
  const folderArtist = cleanIdentityText(input.folderArtist);
  const parsedArtist = cleanIdentityText(input.parsedArtist);
  const parsedTitle = cleanIdentityText(input.parsedTitle);
  const fileStem = cleanIdentityText(input.fileStem);
  const artistsByKey = knowledge.artistsByKey instanceof Map ? knowledge.artistsByKey : new Map();
  const artistByTitle = knowledge.artistByTitle instanceof Map ? knowledge.artistByTitle : new Map();

  if (taggedArtist && !isUnknownMusicArtist(taggedArtist)) {
    return { artist: taggedArtist, title: taggedTitle || parsedTitle || fileStem, recovered: false, source: "tag" };
  }
  if (folderArtist && !isUnknownMusicArtist(folderArtist)) {
    return { artist: folderArtist, title: taggedTitle || parsedTitle || fileStem, recovered: false, source: "folder" };
  }

  if (parsedArtist && parsedTitle) {
    if (TITLE_VERSION_PATTERN.test(parsedArtist) && !TITLE_VERSION_PATTERN.test(parsedTitle)) {
      return { artist: parsedTitle, title: parsedArtist, recovered: true, source: "filename-reversed" };
    }
    return { artist: parsedArtist, title: taggedTitle || fileStem || parsedTitle, recovered: false, source: "filename" };
  }

  const suffix = parentheticalArtist(fileStem);
  if (suffix) {
    const canonicalArtist = artistsByKey.get(normalizeMusicArtistIdentity(suffix.artist));
    if (canonicalArtist) {
      return { artist: canonicalArtist, title: suffix.title, recovered: true, source: "filename-suffix" };
    }
  }

  const consensusArtist = artistByTitle.get(normalizeMusicTitleIdentity(taggedTitle || parsedTitle || fileStem));
  if (consensusArtist) {
    return { artist: consensusArtist, title: taggedTitle || parsedTitle || fileStem, recovered: true, source: "library-title" };
  }
  return {
    artist: taggedArtist || folderArtist || "待识别",
    title: taggedTitle || parsedTitle || fileStem,
    recovered: false,
    source: "unknown"
  };
}

function parentheticalArtist(value) {
  const match = /^(.+?)[（(]([^()（）]{2,40})[）)]$/u.exec(cleanIdentityText(value));
  if (!match) return null;
  const title = cleanIdentityText(match[1]);
  const artist = cleanIdentityText(match[2]);
  if (!title || !artist || SUFFIX_DESCRIPTOR_PATTERN.test(artist) || /^\d+$/u.test(artist)) return null;
  return { artist, title };
}

function normalizeMusicTitleIdentity(value) {
  return cleanIdentityText(value)
    .replace(/^\d{1,4}[\s._-]+/u, "")
    .toLocaleLowerCase();
}

function isUsefulMusicTitle(title, key) {
  const length = Array.from(key || "").length;
  if (!key || length < (/\p{Script=Han}/u.test(title) ? 2 : 4)) return false;
  return !/(?:^|\b)(?:track|audio|unknown)\s*\d*$|音轨\s*\d*$|电音夜店嗨曲|京城工体车载cd音轨/iu.test(title);
}

function cleanIdentityText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}
