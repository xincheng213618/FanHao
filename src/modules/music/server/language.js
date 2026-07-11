export const MUSIC_LANGUAGES = ["中文", "英文", "日文", "韩文", "其他", "待识别"];

const CORE_MUSIC_LANGUAGES = new Set(["中文", "英文", "日文", "韩文"]);
const MIXED_ARTIST_NAMES = new Set([
  "various artists",
  "various artist",
  "v.a.",
  "v.a",
  "群星",
  "华语群星",
  "日本群星",
  "未知歌手",
  "unknown artist"
]);

const MUSIC_ARTIST_LANGUAGE_RULES = [
  {
    language: "中文",
    pattern: /^(?:s\.?\s*h\.?\s*e|beyond|3d\s*beyond|tfboys|a-?lin|twins|f\.?\s*i\.?\s*r\.?|tank|by2|selina|into1|f4|4\s*in\s*love|sing女团|snh48(?:\s*group)?|oner|nineone\s*#?|hita|ice\s*paper|t\.?\s*r\.?\s*y\.?|maria\s*cordero|soler)(?:$|[&、,，/])/iu
  },
  {
    language: "日文",
    pattern: /^(?:坂本龍一|広橋真紀子|宗次郎|中村由利子|伊賀拓郎|喜多郎|工藤静香|持田香織|橋本由香利|渡辺美里|磯村由紀子|経田康子|藤原育郎|美波|宇多田ヒカル|押尾コータロー|大橋トリオ|初音ミク|yoasobi|garnet\s*crow|garnidelia|greeeen|kitaro|s\.?\s*e\.?\s*n\.?\s*s\.?(?:\s*project)?)(?:$|[&、,，/])/iu
  },
  {
    language: "韩文",
    pattern: /^(?:blackpink|bigbang|iu|exo|g-?dragon|psy|twice|newjeans|nmixx|ive|treasure|shaun|kep1er|mamamoo|nct\s*dream|2ne1|t-?ara|wonder\s*girls|girls'?\s*generation|少女时代|李贞贤|黄致列)(?:$|[&、,，/\[(（])/iu
  }
];

export function normalizeMusicLanguage(value) {
  const clean = String(value || "").trim();
  if (!clean || clean === "all" || clean === "全部") return "";
  return MUSIC_LANGUAGES.includes(clean) ? clean : "";
}

export function musicLanguageFromPath(value) {
  const parts = String(value || "").split(/[\\/]/u).filter(Boolean);
  return parts.find((part) => MUSIC_LANGUAGES.includes(part)) || "其他";
}

export function explicitMusicLanguageForArtist(value) {
  const artist = String(value || "").normalize("NFKC").trim();
  if (!artist) return "";
  return MUSIC_ARTIST_LANGUAGE_RULES.find((rule) => rule.pattern.test(artist))?.language || "";
}

export function buildArtistLanguageConsensus(entries = []) {
  const countsByArtist = new Map();
  for (const entry of entries) {
    const artist = String(entry?.artist || "").normalize("NFKC").trim();
    const language = normalizeMusicLanguage(entry?.language);
    if (!artist || !language) continue;
    const key = artist.toLocaleLowerCase();
    if (!countsByArtist.has(key)) countsByArtist.set(key, { artist, counts: new Map() });
    const counts = countsByArtist.get(key).counts;
    counts.set(language, Number(counts.get(language) || 0) + 1);
  }

  const result = new Map();
  for (const [key, item] of countsByArtist) {
    const explicit = explicitMusicLanguageForArtist(item.artist);
    if (explicit) {
      result.set(key, explicit);
      continue;
    }
    if (MIXED_ARTIST_NAMES.has(key)) continue;
    const coreCounts = [...item.counts.entries()]
      .filter(([language]) => CORE_MUSIC_LANGUAGES.has(language))
      .sort((a, b) => b[1] - a[1] || MUSIC_LANGUAGES.indexOf(a[0]) - MUSIC_LANGUAGES.indexOf(b[0]));
    if (!coreCounts.length) continue;
    if (coreCounts.length === 1 || coreCounts[0][1] > coreCounts[1][1]) result.set(key, coreCounts[0][0]);
  }
  return result;
}

export function musicLanguageForArtist(value, fallbackLanguage, consensus = null) {
  const artist = String(value || "").normalize("NFKC").trim();
  const explicit = explicitMusicLanguageForArtist(artist);
  if (explicit) return explicit;
  const agreed = artist && consensus instanceof Map ? consensus.get(artist.toLocaleLowerCase()) : "";
  return normalizeMusicLanguage(agreed) || normalizeMusicLanguage(fallbackLanguage) || "其他";
}
