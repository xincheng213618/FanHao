const QUALITY_AND_SITE_NOISE = [
  /\b(?:2160P|1440P|1080P|720P|480P|4K|8K|UHD|FHD|HD|SD)\b/gi,
  /\b(?:H\.?264|H\.?265|X264|X265|HEVC|AVC|AAC|MP3)\b/gi,
  /\b(?:UNCENSORED|LEAK|HACK|CHS|CHT|SUB|SUBBED|字幕|中文字幕)\b/gi,
  /(?:^|[\s._@-])(?:WWW\.)?[A-Z0-9][A-Z0-9]{1,63}\.(?:COM|NET|ORG|XYZ|TV|CC|ME|CLUB|JP|INFO|BIZ|VIP|ONE|LA|APP|TW|US|DE)(?:\s*[@._-]|\s+|$)/gi
];

const SPECIAL_PATTERNS = [
  {
    type: "fc2",
    pattern: /\bFC2(?:[-_\s.]?PPV)?[-_\s.]?0*(\d{4,9})(?=$|\D)/i,
    format: (match) => `FC2-PPV-${stripLeadingZeros(match[1])}`
  },
  {
    type: "heyzo",
    pattern: /\bHEYZO(?:[-_\s.]?(?:HD|LT|FULL))*[-_\s.]*0*(\d{3,6})(?:[-_\s.]?(?:HD|LT|FULL))*\b/i,
    format: (match) => `HEYZO-${stripLeadingZeros(match[1])}`
  },
  {
    type: "heydouga",
    pattern: /\bHEYDOUGA[-_\s.]?(\d{4})[-_\s.]?(\d{3,5})\b/i,
    format: (match) => `HEYDOUGA-${match[1]}-${stripLeadingZeros(match[2])}`
  },
  {
    type: "xxx-av",
    pattern: /\bXXX[-_\s.]?AV[-_\s.]?0*(\d{3,6})\b/i,
    format: (match) => `XXX-AV-${stripLeadingZeros(match[1])}`
  },
  {
    type: "date-id",
    pattern: /\b(\d{6})[-_](\d{2,4})\b/i,
    format: (match) => `${match[1]}-${match[2]}`
  },
  {
    type: "western-date",
    pattern: /\b([A-Z][A-Z0-9]{1,17}[A-Z])[-_.](\d{2})[-_.](\d{2})[-_.](\d{2})\b/i,
    format: (match) => `${match[1].toUpperCase()}.${match[2]}.${match[3]}.${match[4]}`
  },
  {
    type: "prefix-code",
    pattern: /\b(3DSVR|CW3D2D?BD|MCB3D(?:BD)?|S2M(?:BD)?|T28|T38|TH101|KIN8(?:TENGOKU)?|GACHI|C0930|H0930|H4610|RED|GEDO|CZ|N|K|SE)[-_\s.]?0*([A-Z]?\d{2,8}(?:[-_]\d{2,6})?[A-Z]?)\b/i,
    format: (match) => `${normalizePrefix(match[1])}-${normalizeCodeNumber(match[2])}`
  }
];

const STANDARD_PATTERNS = [
  {
    type: "standard",
    pattern: /\b\d{2,6}[-_\s.]?([A-Z]{2,12})[-_\s﹣－–—.]?0*(\d{2,8}[A-Z]?)\b/i,
    format: (match) => `${match[1].toUpperCase()}-${normalizeCodeNumber(match[2])}`
  },
  {
    type: "standard",
    pattern: /\b([A-Z]{2,12})[-_\s﹣－–—.]?0*(\d{2,8}[A-Z]?)\b/i,
    format: (match) => `${match[1].toUpperCase()}-${normalizeCodeNumber(match[2])}`
  },
  {
    type: "lettered",
    pattern: /\b([A-Z]{2,12})[-_\s﹣－–—.]?([A-Z]{1,5}0*\d{2,8}[A-Z]?)\b/i,
    format: (match) => `${match[1].toUpperCase()}-${normalizeCodeNumber(match[2])}`
  }
];

const BAD_PREFIXES = new Set([
  "AAC",
  "AVC",
  "BLURAY",
  "CARIBBEANCOM",
  "CHANNEL",
  "CHS",
  "CHT",
  "FHD",
  "FULL",
  "HD",
  "HEVC",
  "LT",
  "MP4",
  "PPV",
  "SUB",
  "TOKYOHOT",
  "UHD",
  "WEB",
  "X264",
  "X265"
]);

export function normalizeWorkCode(value) {
  return parseWorkCode(value)?.code || "";
}

export function workCodeKey(value) {
  const code = normalizeWorkCode(value);
  return code ? code.replace(/[^A-Z0-9]/gi, "").toLowerCase() : "";
}

export function extractWorkCodes(value) {
  const text = cleanCodeText(value);
  if (!text) return [];

  const matches = [];
  for (const definition of [...SPECIAL_PATTERNS, ...STANDARD_PATTERNS]) {
    collectMatches(matches, text, definition);
  }

  matches.sort((a, b) => b.score - a.score || a.index - b.index);
  const seen = new Set();
  return matches
    .filter((item) => {
      const key = item.code.replace(/[^A-Z0-9]/gi, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => item.code);
}

export function parseWorkCode(value) {
  const text = cleanCodeText(value);
  if (!text) return null;

  const candidates = [];
  for (const definition of SPECIAL_PATTERNS) {
    collectMatches(candidates, text, definition);
  }
  for (const definition of STANDARD_PATTERNS) {
    collectMatches(candidates, text, definition);
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0] || null;
}

function collectMatches(target, text, definition) {
  const flags = definition.pattern.flags.includes("g") ? definition.pattern.flags : `${definition.pattern.flags}g`;
  const pattern = new RegExp(definition.pattern.source, flags);
  for (const match of text.matchAll(pattern)) {
    const code = definition.format(match);
    if (!isUsefulCode(code)) continue;
    target.push({
      code,
      key: code.replace(/[^A-Z0-9]/gi, "").toLowerCase(),
      type: definition.type,
      index: match.index || 0,
      score: scoreCode(code, definition.type, match.index || 0)
    });
  }
}

function cleanCodeText(value) {
  let text = String(value || "")
    .normalize("NFKC")
    .replace(/\\/g, "/")
    .replace(/_/g, "-")
    .replace(/\.[A-Z0-9]{1,5}$/i, " ")
    .replace(/\b20\d{2}[-_.年]\d{1,2}[-_.月]\d{1,2}日?\b/g, " ")
    .replace(/\b\d{4}[-_.]\d{1,2}[-_.]\d{1,2}\b/g, " ")
    .toUpperCase()
    .replace(/[()[\]{}【】]/g, " ");

  for (const pattern of QUALITY_AND_SITE_NOISE) {
    text = text.replace(pattern, " ");
  }

  return text
    .replace(/[-\s.]{2,}/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePrefix(value) {
  return String(value || "").toUpperCase().replace(/TENGOKU$/, "");
}

function normalizeCodeNumber(value) {
  const raw = String(value || "").toUpperCase().replace(/[_\s.]/g, "-");
  const match = /^([A-Z]*?)0*(\d+)(.*)$/.exec(raw);
  if (!match) return raw;
  const [, head, digits, tail] = match;
  const minWidth = digits.length <= 3 ? 3 : digits.length;
  return `${head}${stripLeadingZeros(digits).padStart(minWidth, "0")}${tail}`;
}

function stripLeadingZeros(value) {
  const stripped = String(value || "").replace(/^0+/, "");
  return stripped || "0";
}

function isUsefulCode(code) {
  const prefix = String(code || "").split("-", 1)[0].toUpperCase();
  if (!prefix || BAD_PREFIXES.has(prefix)) return false;
  if (/^HEYDOUGA-\d{4}$/i.test(code)) return false;
  if (/^\d{3,4}P$/.test(prefix)) return false;
  if (/^20\d{2}$/.test(prefix)) return false;
  return /[A-Z]/i.test(code) || /^\d{6}-\d{2,4}$/.test(code);
}

function scoreCode(code, type, index) {
  let score = 100;
  if (type !== "standard" && type !== "lettered") score += 30;
  if (type === "standard") score += 12;
  if (code.includes("-")) score += 8;
  if (index === 0) score += 6;
  if (/^(FC2|HEYZO|HEYDOUGA|XXX-AV)/i.test(code)) score += 20;
  if (/^[A-Z]{2,12}-\d{3,}/.test(code)) score += 10;
  if (/^\d{6}-\d{2,4}$/.test(code)) score += 8;
  return score;
}
