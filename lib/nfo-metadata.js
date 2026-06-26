const RAW_LIMIT = 24000;

export function parseNfoMetadata(rawInput, defaults = {}) {
  const rawText = normalizeRawText(rawInput);
  if (!looksLikeNfo(rawText)) return null;

  const parseText = withoutExternalIdTags(withoutBlocks(rawText, ["script", "style"]));
  const mediaText = withoutBlocks(parseText, ["actor"]);
  const imageUrl = nfoImageUrl(mediaText);
  const rating = parseRating(parseText);
  const actors = actorNames(parseText);
  const info = {
    code: nfoCode(parseText),
    title: firstText(parseText, ["title", "originaltitle", "sorttitle"]) || defaults.title || "",
    originalTitle: firstText(parseText, ["originaltitle"]),
    sortTitle: firstText(parseText, ["sorttitle"]),
    releaseDate: firstText(parseText, ["premiered", "releasedate", "release", "date"]),
    year: parseYear(firstText(parseText, ["year"])),
    durationMinutes: parseRuntime(firstText(parseText, ["runtime", "duration", "length"])),
    rating: rating.rating,
    ratingCount: rating.count,
    criticRating: firstText(parseText, ["criticrating"]),
    contentRating: firstText(parseText, ["mpaa", "customrating", "certification"]),
    country: firstText(parseText, ["country"]),
    wanted: firstText(parseText, ["wanted"]),
    director: firstText(parseText, ["director"]),
    maker: firstText(parseText, ["studio", "maker", "producer"]),
    label: firstText(parseText, ["label", "publisher"]),
    series: parseSeries(parseText),
    description: firstText(parseText, ["plot", "outline", "originalplot", "tagline", "description", "storyline"]),
    javdbUrl: nfoJavdbUrl(parseText),
    imageUrl,
    previewImages: [],
    previewVideoUrl: firstUrl(parseText, ["trailer", "preview_video_url", "preview_video", "sample_video"], /\.(?:mp4|webm|m3u8)(?:[?#]|$)/i),
    actors,
    tags: nfoTags(parseText, actors),
    fields: [],
    rawText: parseText.slice(0, RAW_LIMIT),
    rawTextTruncated: parseText.length > RAW_LIMIT
  };
  info.previewImages = previewImageUrls(mediaText, info.imageUrl);

  info.fields = publicFields(info);
  if (!hasUsefulInfo(info)) return null;
  return info;
}

function normalizeRawText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function looksLikeNfo(text) {
  if (!text) return false;
  return /<\?xml\b/i.test(text) || /<movie[\s>]/i.test(text) || /<(?:uniqueid|num|premiered|actor|javdbsearchid)[\s>]/i.test(text);
}

function hasUsefulInfo(info) {
  return Boolean(
    info.code ||
      info.title ||
      info.originalTitle ||
      info.sortTitle ||
      info.releaseDate ||
      info.year ||
      info.durationMinutes ||
      info.contentRating ||
      info.country ||
      info.director ||
      info.maker ||
      info.label ||
      info.series ||
      info.description ||
      info.imageUrl ||
      info.previewImages.length ||
      info.previewVideoUrl ||
      info.javdbUrl ||
      info.actors.length ||
      info.tags.length
  );
}

function firstText(xml, tags) {
  for (const tag of tags) {
    const value = allTexts(xml, tag)[0];
    if (value) return value;
  }
  return "";
}

function allTexts(xml, tag) {
  const pattern = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, "gi");
  const results = [];
  for (const match of xml.matchAll(pattern)) {
    const value = cleanXmlText(match[1]);
    if (value) results.push(value);
  }
  return unique(results);
}

function tagEntries(xml, tag) {
  const pattern = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*)>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, "gi");
  const results = [];
  for (const match of xml.matchAll(pattern)) {
    const value = cleanXmlText(match[2]);
    if (value) results.push({ attrs: match[1] || "", value });
  }
  return results;
}

function withoutBlocks(xml, tags) {
  let result = String(xml || "");
  for (const tag of tags) {
    const pattern = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRegExp(tag)}>`, "gi");
    result = result.replace(pattern, " ");
  }
  return result;
}

function withoutExternalIdTags(xml) {
  return String(xml || "").replace(/<id\b[^>]*>([\s\S]*?)<\/id>/gi, (match, value) => {
    return isExternalId(cleanXmlText(value)) ? " " : match;
  });
}

function nfoCode(xml) {
  const direct = firstText(xml, ["num", "video_id", "code", "javdbsearchid", "javdb_search_id"]);
  if (direct) return direct;

  const numUniqueId = uniqueId(xml, "num");
  if (numUniqueId) return numUniqueId;

  for (const value of allTexts(xml, "id")) {
    if (!isExternalId(value)) return value;
  }
  return "";
}

function uniqueId(xml, preferredType) {
  const pattern = /<uniqueid\b([^>]*)>([\s\S]*?)<\/uniqueid>/gi;
  const fallback = [];
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] || "";
    const value = cleanXmlText(match[2]);
    if (!value) continue;
    const type = attrValue(attrs, "type").toLowerCase();
    const isDefault = /default\s*=\s*["']?true/i.test(attrs);
    if (preferredType === "num" && (type === "num" || isDefault) && !isExternalId(value)) return value;
    if (preferredType === "javdb" && /javdb/i.test(type)) return value;
    fallback.push(value);
  }
  if (preferredType === "num") return fallback.find((value) => !isExternalId(value)) || "";
  return fallback[0] || "";
}

function actorNames(xml) {
  const actors = [];
  const blockPattern = /<actor\b[^>]*>([\s\S]*?)<\/actor>/gi;
  for (const match of xml.matchAll(blockPattern)) {
    const block = match[1] || "";
    const name = firstText(block, ["name"]) || cleanXmlText(block);
    if (name) actors.push(name);
  }
  actors.push(...allTexts(xml, "actress"));
  actors.push(...allTexts(xml, "performer"));
  return unique(actors.flatMap(splitPeople));
}

function nfoTags(xml, actors) {
  const actorKeys = new Set((actors || []).map((actor) => actor.trim().toLowerCase()).filter(Boolean));
  return unique([...allTexts(xml, "genre"), ...allTexts(xml, "tag")]).filter((tag) => !actorKeys.has(tag.trim().toLowerCase()));
}

function splitPeople(value) {
  return String(value || "")
    .split(/[,，、;；/|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function nfoImageUrl(xml) {
  const direct = firstRemoteText(xml, ["poster", "cover", "image_url", "image"]);
  if (direct) return direct;

  const posterThumb = firstThumbUrl(xml, isPosterThumb);
  if (posterThumb) return posterThumb;

  const plainThumb = firstThumbUrl(withoutBlocks(xml, ["fanart", "art"]), (attrs) => !thumbAspect(attrs));
  if (plainThumb) return plainThumb;

  return firstRemoteText(xml, ["fanart", "art"]);
}

function firstRemoteText(xml, tags) {
  for (const tag of tags) {
    const url = uniqueRemoteUrls(allTexts(xml, tag))[0];
    if (url) return url;
  }
  return "";
}

function firstThumbUrl(xml, predicate) {
  for (const entry of tagEntries(xml, "thumb")) {
    if (!predicate(entry.attrs || "")) continue;
    const url = uniqueRemoteUrls([entry.value])[0];
    if (url) return url;
  }
  return "";
}

function thumbAspect(attrs) {
  return attrValue(attrs, "aspect").trim().toLowerCase();
}

function isPosterThumb(attrs) {
  return /^(?:poster|cover|front|primary)$/.test(thumbAspect(attrs));
}

function previewImageUrls(xml, coverUrl) {
  const urls = uniqueRemoteUrls([
    ...allTexts(xml, "poster"),
    ...allTexts(xml, "cover"),
    ...allTexts(xml, "image_url"),
    ...allTexts(xml, "image"),
    ...allTexts(xml, "preview_image"),
    ...allTexts(xml, "previewimage"),
    ...allTexts(xml, "sample_image"),
    ...allTexts(xml, "sampleimage"),
    ...allTexts(xml, "screenshot"),
    ...allTexts(xml, "fanart"),
    ...tagEntries(xml, "thumb")
      .filter((entry) => !isPosterThumb(entry.attrs))
      .map((entry) => entry.value)
  ]);
  return urls.filter((url) => url !== coverUrl).slice(0, 40);
}

function isExternalId(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  if (/^(?:tt|nm)\d{5,}$/.test(text)) return true;
  if (/^(?:imdb|tmdb|themoviedb|douban|kodi|jellyfin|plex)[:_\s-]?[a-z0-9.-]+$/.test(text)) return true;
  if (/^\d{1,10}$/.test(text)) return true;
  return /^https?:\/\/(?:www\.)?(?:imdb\.com|themoviedb\.org|tmdb\.org|douban\.com)\b/i.test(text);
}

function parseSeries(xml) {
  const setBlocks = [...xml.matchAll(/<set\b[^>]*>([\s\S]*?)<\/set>/gi)].map((match) => match[1] || "");
  for (const block of setBlocks) {
    const name = firstText(block, ["name"]) || cleanXmlText(block);
    if (name) return name;
  }
  return firstText(xml, ["series"]);
}

function parseRuntime(value) {
  const text = String(value || "");
  const match = /(\d{1,4})/.exec(text);
  if (!match) return null;
  const minutes = Number(match[1]);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

function parseRating(xml) {
  const preferredEntry = preferredRatingEntry(xml);
  if (preferredEntry) {
    return {
      rating: parseRatingNumber(preferredEntry.value),
      count: parseVoteCount(preferredEntry.count)
    };
  }

  const value = firstText(xml, ["rating", "userrating", "criticrating", "value"]);
  return {
    rating: parseRatingNumber(value),
    count: parseVoteCount(firstText(xml, ["votes", "ratingcount", "rating_count"]))
  };
}

function preferredRatingEntry(xml) {
  const entries = ratingEntries(xml).filter((entry) => parseRatingNumber(entry.value) !== null);
  return (
    entries.find((entry) => /^(?:jdb|javdb)$/i.test(entry.name)) ||
    entries.find((entry) => entry.isDefault) ||
    null
  );
}

function ratingEntries(xml) {
  const entries = [];
  const pattern = /<rating\b([^>]*)>([\s\S]*?)<\/rating>/gi;
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    entries.push({
      name: attrValue(attrs, "name").trim().toLowerCase(),
      isDefault: /default\s*=\s*["']?true/i.test(attrs),
      value: firstText(body, ["value"]) || cleanXmlText(body),
      count: firstText(body, ["votes", "ratingcount", "rating_count"])
    });
  }
  return entries;
}

function parseRatingNumber(value) {
  const rating = Number.parseFloat(String(value || ""));
  return Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating : null;
}

function parseVoteCount(value) {
  const votes = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(votes) && votes > 0 ? votes : null;
}

function parseYear(value) {
  const match = /\b(19\d{2}|20\d{2})\b/.exec(String(value || ""));
  return match ? match[1] : "";
}

function firstUrl(xml, tags, requiredPattern) {
  for (const tag of tags) {
    for (const value of allTexts(xml, tag)) {
      if (/^https?:\/\//i.test(value) && (!requiredPattern || requiredPattern.test(value))) return value;
    }
  }

  const uniqueIdValue = uniqueId(xml, "javdb");
  if (/^https?:\/\//i.test(uniqueIdValue) && (!requiredPattern || requiredPattern.test(uniqueIdValue))) return uniqueIdValue;

  const urlMatch = xml.match(/https?:\/\/[^\s<>"']+/gi) || [];
  return urlMatch.find((value) => !requiredPattern || requiredPattern.test(value)) || "";
}

function nfoJavdbUrl(xml) {
  const directUrl = firstUrl(xml, ["javdb_url", "javdburl", "website", "url", "javdbid", "javdb_id"], /javdb\./i);
  if (directUrl) return directUrl;

  const javdbId = firstText(xml, ["javdbid", "javdb_id"]).trim();
  if (/^[A-Za-z0-9]{3,}$/.test(javdbId)) return `https://javdb.com/v/${javdbId}`;
  return "";
}

function uniqueRemoteUrls(values) {
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    for (const url of String(value || "").match(/https?:\/\/[^\s<>"',]+/gi) || []) {
      const clean = url.trim();
      const key = clean.toLowerCase();
      if (!clean || seen.has(key)) continue;
      seen.add(key);
      urls.push(clean);
    }
  }
  return urls;
}

function cleanXmlText(value) {
  return decodeXmlEntities(
    String(value || "")
      .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|span|strong|em)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (entity, code) => decodeCodePointEntity(entity, Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (entity, code) => decodeCodePointEntity(entity, Number.parseInt(code, 16)));
}

function decodeCodePointEntity(entity, codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return entity;
  }
}

function publicFields(info) {
  const fields = [];
  const push = (label, value) => {
    const text = Array.isArray(value) ? value.join(", ") : String(value ?? "").trim();
    if (text) fields.push({ label, value: text });
  };

  push("番号", info.code);
  push("标题", info.title);
  push("原始标题", info.originalTitle);
  push("排序标题", info.sortTitle);
  push("日期", info.releaseDate);
  push("年份", info.year);
  push("时长", info.durationMinutes ? `${info.durationMinutes} 分钟` : "");
  push("分级", info.contentRating);
  push("国家", info.country);
  push("评论评分", info.criticRating);
  push("想看", info.wanted);
  push("导演", info.director);
  push("片商", info.maker);
  push("发行商", info.label);
  push("系列", info.series);
  push("简介", info.description);
  push("评分", nfoRatingText(info));
  push("类别", info.tags);
  push("演员", info.actors);
  push("预览图", info.previewImages);
  push("预览视频", info.previewVideoUrl);
  push("JavDB", info.javdbUrl);
  return fields;
}

function nfoRatingText(info) {
  if (info.rating === null || info.rating === undefined) return "";
  const count = info.ratingCount ? `，${info.ratingCount} 人评价` : "";
  return `${info.rating} 分${count}`;
}

function unique(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function attrValue(attrs, name) {
  const match = new RegExp(`${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, "i").exec(attrs || "");
  return match?.[1] || match?.[2] || match?.[3] || "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
