// Issue numbers for photo sets, derived from archive titles. The label is
// display text; `prefix` + `number` identify a numbering family for gap and
// duplicate checks inside one collection.

export { BOBO_SOCKS_CATEGORY, parseBoBoSocksAlbum } from "../../../../lib/bobosocks-album.js";

const PHOTO_STATS_SUFFIX = /\s*[\[(（【][^\]）)】]*(?:\d+\s*[PV]|(?:MB|GB)\b|\d+(?:\.\d+)?\s*[MG]\b)[^\]）)】]*[\])）】]\s*$/iu;
const YEAR_LIKE = /^(?:19|20)\d{2}$/u;
const DATE_IN_TEXT = /(?:19|20)\d{2}[.\-_/年]\d{1,2}[.\-_/月]\d{1,2}/u;

function stripStats(value) {
  return String(value || "").normalize("NFKC").replace(PHOTO_STATS_SUFFIX, "").replace(/_+$/u, "").trim();
}

function result(label, prefix, digits, match, offset = 0) {
  const number = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(number)) return null;
  return { label, prefix, number, index: match.index + offset, length: match[0].length - offset };
}

const RULES = [
  // VOL.123 / NO.123 / N0.123 / VO.2636
  (text) => {
    const match = text.match(/(?<![A-Za-z])(VOL|VO|N[O0])\.?\s*(\d{1,5})(?!\d)/i);
    if (!match) return null;
    const prefix = /^VO/i.test(match[1]) ? "VOL." : "NO.";
    return result(`${prefix}${match[2]}`, prefix, match[2], match);
  },
  // 第84期
  (text) => {
    const match = text.match(/第\s*(\d{1,5})\s*[期辑弹]/u);
    return match ? result(`NO.${match[1]}`, "NO.", match[1], match) : null;
  },
  // 009.title / [Site]134 title / [Site] 176 title / 174-title
  (text) => {
    const match = text.match(/^(\[[^\]]{1,80}\]\s*)?(\d{2,4})(?!\d)/u);
    if (!match || YEAR_LIKE.test(match[2])) return null;
    // 23.11.24 is a date; 108.120斤 is an issue followed by its title.
    if (match[2].length < 3 && /^[.\-_]\d/u.test(text.slice(match.index + match[0].length))) return null;
    const offset = match[1]?.length || 0;
    return result(`NO.${match[2]}`, "NO.", match[2], match, offset);
  },
  // 学妹校园寝室短丝系列045
  (text) => {
    const match = text.match(/系列\s*(\d{2,4})(?!\d)/u);
    return match ? result(`NO.${match[1]}`, "NO.", match[1], match, 2) : null;
  },
  // NZ058 / Y-005 / EXC#137
  (text) => {
    const match = text.match(/(?<![A-Za-z0-9])([A-Z]{1,8})[-#]?(\d{2,5})(?![\dA-Za-z]|\.\d)/u);
    if (!match) return null;
    const prefix = match[1].toUpperCase();
    return result(`${prefix}${match[2]}`, prefix, match[2], match);
  },
  // 月下007 小夜 / 舞蹈生日记 047 - 金星: zero padding marks an issue number.
  (text) => {
    if (DATE_IN_TEXT.test(text)) return null;
    const match = text.match(/(?<=[\s㐀-鿿])(0\d{1,3})(?=$|[\s\-–—_])/u);
    return match ? result(`NO.${match[1]}`, "NO.", match[1], match) : null;
  },
  // 舞蹈生日记 109 - 羽 / 月下-01
  (text) => {
    if (DATE_IN_TEXT.test(text)) return null;
    const match = text.match(/(?<=[\s\u3400-\u9fff])(\d{2,4})(?=\s+[-–—]\s)/u)
      || text.match(/(?<=[\u3400-\u9fff])-(\d{2,3})(?=$|\s)/u);
    if (!match || YEAR_LIKE.test(match[1])) return null;
    return result(`NO.${match[1]}`, "NO.", match[1], match);
  },
  // 森萝财团写真 朝露 04E4K
  (text) => {
    if (DATE_IN_TEXT.test(text)) return null;
    const match = text.match(/(?<=[\s㐀-鿿])(\d{2,3})(?:E?\d?K)?$/u);
    return match ? result(`NO.${match[1]}`, "NO.", match[1], match) : null;
  }
];

export function parsePhotoAlbumNumber(title) {
  const text = stripStats(title);
  if (!text) return null;
  for (const rule of RULES) {
    const parsed = rule(text);
    if (parsed) return { ...parsed, text };
  }
  return null;
}

export function photoAlbumNumber(title) {
  return parsePhotoAlbumNumber(title)?.label || "";
}

const MAX_GAP_RANGES = 120;
const MAX_DUPLICATE_GROUPS = 60;

function compressMissing(numbers) {
  const ranges = [];
  let missing = 0;
  for (let index = 1; index < numbers.length; index++) {
    const from = numbers[index - 1] + 1;
    const to = numbers[index] - 1;
    if (from > to) continue;
    missing += to - from + 1;
    if (ranges.length < MAX_GAP_RANGES) ranges.push(from === to ? [from] : [from, to]);
  }
  return { ranges, missing };
}

/**
 * Read-only completeness and duplicate report for the albums of one collection.
 * Items need `id`, `title`, `size`, and optionally `imageCount`, `archiveDate`,
 * `albumSubject`.
 */
export function photoCollectionHealth(items = []) {
  const families = new Map();
  const groups = new Map();
  let numbered = 0;
  for (const item of items) {
    const parsed = parsePhotoAlbumNumber(item.title);
    let key = "";
    if (parsed) {
      numbered++;
      // Sites spell the same series as VOL.123 and No.123 interchangeably.
      const familyKey = parsed.prefix === "VOL." || parsed.prefix === "NO." ? "issue" : parsed.prefix;
      let family = families.get(familyKey);
      if (!family) families.set(familyKey, family = { prefixes: new Map(), numbers: new Set(), count: 0 });
      family.prefixes.set(parsed.prefix, (family.prefixes.get(parsed.prefix) || 0) + 1);
      family.numbers.add(parsed.number);
      family.count++;
      key = `n:${familyKey}:${parsed.number}`;
    } else if (item.archiveDate && item.albumSubject) {
      key = `d:${item.photoSite || ""}:${item.archiveDate}:${String(item.albumSubject).normalize("NFKC").toLowerCase().replace(/\s+/gu, "")}`;
    }
    if (!key) continue;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { label: parsed?.label || `${item.archiveDate} ${item.albumSubject}`, items: [] });
    group.items.push({
      id: item.id, title: item.title, size: Number(item.size || 0),
      imageCount: item.imageCount == null ? null : Number(item.imageCount), routePath: item.routePath || ""
    });
  }

  const numbering = [...families.values()]
    // A family with only a couple of entries is not a numbering scheme.
    .filter(family => family.numbers.size >= 5)
    .map((family) => {
      const numbers = [...family.numbers].sort((a, b) => a - b);
      const { ranges, missing } = compressMissing(numbers);
      const prefix = [...family.prefixes].sort((a, b) => b[1] - a[1])[0][0];
      return { prefix, count: numbers.length, min: numbers[0], max: numbers.at(-1), missing, missingRanges: ranges,
        truncated: ranges.length >= MAX_GAP_RANGES };
    })
    .sort((a, b) => b.count - a.count);

  const duplicateGroups = [...groups.values()].filter(group => group.items.length > 1);
  const duplicates = duplicateGroups
    .map(group => ({ ...group, items: group.items.sort((a, b) => b.size - a.size),
      reclaimableBytes: group.items.slice(1).reduce((sum, item) => sum + item.size, 0) }))
    .sort((a, b) => b.reclaimableBytes - a.reclaimableBytes)
    .slice(0, MAX_DUPLICATE_GROUPS);

  return {
    total: items.length,
    numbered,
    numbering,
    duplicateGroupCount: duplicateGroups.length,
    duplicateReclaimableBytes: duplicateGroups.reduce((sum, group) => sum + group.items.slice(1).reduce((s, i) => s + i.size, 0), 0),
    duplicates
  };
}
