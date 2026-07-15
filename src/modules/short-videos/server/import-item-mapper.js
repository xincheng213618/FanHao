import fs from "node:fs";
import path from "node:path";

const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac"]);

export function createShortVideoImportItemMapper(dependencies = {}) {
  const {
    hashText,
    optionalInteger,
    parseJsonObject,
    safeStat
  } = dependencies;

  if (![hashText, optionalInteger, parseJsonObject, safeStat].every((dependency) => typeof dependency === "function")) {
    throw new TypeError("short-video import item mapper dependencies are required");
  }

  function parseVideoFile(root, filePath) {
    const stat = safeStat(filePath);
    if (!stat?.isFile()) return null;
    const dir = path.dirname(filePath);
    const author = parseAuthorFolder(root, filePath);
    const files = safeReadDir(dir);
    const dataPath = findCompanion(files, dir, filePath, ".json", (name) => /_data\.json$/i.test(name)) || "";
    const data = readVideoJson(dataPath);
    const parentInfo = parseVideoName(path.basename(dir));
    const fileInfo = parseVideoName(path.basename(filePath, path.extname(filePath)));
    const awemeId = String(data?.aweme_id || parentInfo.awemeId || fileInfo.awemeId || "").trim();
    const id = awemeId || `local-${hashText(path.resolve(filePath)).slice(0, 18)}`;
    const description = String(data?.desc || parentInfo.title || fileInfo.title || path.basename(filePath, path.extname(filePath))).trim();
    const title = description || awemeId || path.basename(filePath, path.extname(filePath));
    const tags = tagsFromText(description);
    const coverPath = findCover(files, dir, filePath);
    const musicPath = findCompanion(files, dir, filePath, "", (name) => AUDIO_EXTS.has(path.extname(name).toLowerCase())) || "";
    const createTime = Number(data?.create_time || 0) || null;
    const publishedAt = isoFromCreateTime(createTime) || dateOnlyIso(parentInfo.date || fileInfo.date) || "";
    const likedAt = new Date(stat.mtimeMs || Date.now()).toISOString();
    const video = data?.video || {};
    const statistics = data?.statistics || {};
    const authorData = data?.author || {};
    const livePhoto = /_live_\d+$/i.test(path.basename(filePath, path.extname(filePath)));
    const mediaMetadata = {
      ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
      fanhaoMedia: {
        type: "video",
        galleryCount: 0,
        livePhoto
      }
    };
    const finalAuthor = {
      secUid: String(authorData.sec_uid || author.secUid || "").trim(),
      uid: String(authorData.uid || "").trim(),
      name: String(authorData.nickname || author.name || "").trim() || "未知作者",
      avatarUrl: firstUrl(authorData.avatar_thumb)
    };
    return {
      id,
      awemeId,
      author: finalAuthor,
      title,
      description,
      tags,
      createTime,
      publishedAt,
      likedAt,
      durationMs: Number(data?.duration || video.duration || 0) || null,
      width: Number(video.width || video.play_addr?.width || 0) || null,
      height: Number(video.height || video.play_addr?.height || 0) || null,
      diggCount: Number(statistics.digg_count || 0) || 0,
      commentCount: Number(statistics.comment_count || 0) || 0,
      collectCount: Number(statistics.collect_count || 0) || 0,
      shareCount: Number(statistics.share_count || 0) || 0,
      playCount: Number(statistics.play_count || 0) || 0,
      shareUrl: normalizedDouyinShareUrl(data?.share_url, awemeId),
      metadataJson: JSON.stringify(mediaMetadata),
      sourcePath: path.resolve(filePath),
      coverPath,
      coverSource: coverPath ? "native" : "",
      musicPath,
      dataPath,
      relativePath: path.relative(root, filePath),
      fileName: path.basename(filePath),
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs || 0)
    };
  }

  function parseGalleryDirectory(root, dir) {
    const files = safeReadDir(dir);
    const dataName = files.find((name) => /_data\.json$/i.test(name));
    if (!dataName) return null;
    const dataPath = path.join(dir, dataName);
    const data = readVideoJson(dataPath);
    const metadataImages = Array.isArray(data?.images) ? data.images : [];
    const isGalleryMetadata = Number(data?.aweme_type || 0) === 68 || metadataImages.length > 0;
    if (!isGalleryMetadata) return null;
    const imageNames = files.filter((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()));
    const numberedImageNames = imageNames.filter((name) => /_\d+$/i.test(path.basename(name, path.extname(name))));
    const selectedImageNames = numberedImageNames.length ? numberedImageNames : imageNames;
    const videoNames = files.filter((name) => VIDEO_EXTS.has(path.extname(name).toLowerCase()));
    const galleryItems = [...selectedImageNames, ...videoNames]
      .sort(galleryDirectoryMediaCompare)
      .map((name) => ({
        path: path.join(dir, name),
        type: VIDEO_EXTS.has(path.extname(name).toLowerCase()) ? "video" : "image"
      }))
      .filter((item) => safeStat(item.path)?.isFile());
    if (!galleryItems.length) return null;

    const sourcePath = galleryItems[0].path;
    const coverPath = galleryItems.find((item) => item.type === "image")?.path || sourcePath;
    const author = parseAuthorFolder(root, sourcePath);
    const parentInfo = parseVideoName(path.basename(dir));
    const awemeId = String(data?.aweme_id || parentInfo.awemeId || "").trim();
    const id = awemeId || `local-${hashText(path.resolve(dir)).slice(0, 18)}`;
    const description = String(data?.desc || parentInfo.title || path.basename(dir)).trim();
    const authorData = data?.author || {};
    const statistics = data?.statistics || {};
    const firstImage = metadataImages[0] || {};
    const galleryStats = galleryItems.map((item) => safeStat(item.path)).filter(Boolean);
    const createTime = Number(data?.create_time || 0) || null;
    const latestMtime = Math.max(0, ...galleryStats.map((stat) => Number(stat.mtimeMs || 0)));
    const mediaMetadata = {
      ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
      fanhaoMedia: {
        type: "gallery",
        galleryCount: galleryItems.length,
        galleryItems: galleryItems.map((item) => item.type)
      }
    };
    return {
      id,
      awemeId,
      author: {
        secUid: String(authorData.sec_uid || author.secUid || "").trim(),
        uid: String(authorData.uid || "").trim(),
        name: String(authorData.nickname || author.name || "").trim() || "未知作者",
        avatarUrl: firstUrl(authorData.avatar_thumb)
      },
      title: description || awemeId || path.basename(dir),
      description,
      tags: tagsFromText(description),
      createTime,
      publishedAt: isoFromCreateTime(createTime) || dateOnlyIso(parentInfo.date) || "",
      likedAt: new Date(latestMtime || Date.now()).toISOString(),
      mediaType: "gallery",
      galleryItems,
      durationMs: null,
      width: Number(firstImage.width || firstImage.display_image?.width || 0) || null,
      height: Number(firstImage.height || firstImage.display_image?.height || 0) || null,
      diggCount: Number(statistics.digg_count || 0) || 0,
      commentCount: Number(statistics.comment_count || 0) || 0,
      collectCount: Number(statistics.collect_count || 0) || 0,
      shareCount: Number(statistics.share_count || 0) || 0,
      playCount: Number(statistics.play_count || 0) || 0,
      shareUrl: String(data?.share_url || "").trim() || douyinNoteUrl(awemeId),
      metadataJson: JSON.stringify(mediaMetadata),
      sourcePath,
      coverPath,
      coverSource: "native",
      musicPath: findCompanion(files, dir, sourcePath, "", (name) => AUDIO_EXTS.has(path.extname(name).toLowerCase())) || "",
      dataPath,
      relativePath: path.relative(root, sourcePath),
      fileName: path.basename(sourcePath),
      sizeBytes: galleryStats.reduce((sum, stat) => sum + Number(stat.size || 0), 0),
      mtimeMs: Math.floor(latestMtime)
    };
  }

  function downloadManagerRowToItem(row) {
    const outputDir = String(row.output_dir || "").trim() ? path.resolve(String(row.output_dir).trim()) : "";
    const localPaths = parseDownloadManagerPaths(row.local_file_paths)
      .map((filePath) => resolveDownloadManagerPath(outputDir, filePath));
    const galleryItems = isDownloadManagerGallery(row)
      ? localPaths
        .filter((filePath) => (IMAGE_EXTS.has(path.extname(filePath).toLowerCase()) || VIDEO_EXTS.has(path.extname(filePath).toLowerCase()))
          && safeStat(filePath)?.isFile())
        .map((filePath) => ({
          path: filePath,
          type: VIDEO_EXTS.has(path.extname(filePath).toLowerCase()) ? "video" : "image"
        }))
        .sort((left, right) => galleryDirectoryMediaCompare(path.basename(left.path), path.basename(right.path)))
      : [];
    const mediaType = galleryItems.length ? "gallery" : "video";
    const sourcePath = mediaType === "gallery"
      ? galleryItems[0].path
      : firstExistingDownloadManagerPath(localPaths, VIDEO_EXTS);
    if (!sourcePath) return null;

    const stat = safeStat(sourcePath);
    if (!stat?.isFile()) return null;
    const dataPath = firstExistingDownloadManagerPath(localPaths, new Set([".json"]));
    const data = readVideoJson(dataPath) || parseJsonObject(row.metadata_json);
    const rawMetadata = rawAwemeMetadata(data);
    const rawProfile = parseJsonObject(row.profile_raw_json);
    const video = data?.video || {};
    const statistics = rawMetadata?.statistics || data?.statistics || {};
    const authorData = rawMetadata?.author || data?.author || {};
    const awemeId = String(row.aweme_id || data?.aweme_id || "").trim();
    const id = awemeId || `local-${hashText(sourcePath).slice(0, 18)}`;
    const description = String(row.desc || data?.desc || path.basename(sourcePath, path.extname(sourcePath))).trim();
    const title = description.split(/\r?\n/)[0]?.trim() || awemeId || path.basename(sourcePath, path.extname(sourcePath));
    const tags = mergeTags(Array.isArray(data?.tags) ? data.tags : [], tagsFromText(description));
    const createTime = Number(row.create_time || data?.create_time || data?.publish_timestamp || 0) || null;
    const likedAt = normalizeIsoDate(row.discovered_at || row.last_seen_at || row.downloaded_at || data?.recorded_at)
      || new Date(stat.mtimeMs || Date.now()).toISOString();
    const publishedAt = isoFromCreateTime(createTime) || dateOnlyIso(data?.date) || "";
    const coverPath = mediaType === "gallery"
      ? galleryItems.find((item) => item.type === "image")?.path || galleryItems[0]?.path || ""
      : downloadManagerCoverPath(row, localPaths, sourcePath, outputDir);
    const musicPath = firstExistingDownloadManagerPath(localPaths, AUDIO_EXTS);
    const durationMs = mediaType === "gallery" ? null : (Number(row.duration_ms || data?.duration || video.duration || 0) || null);
    const galleryStats = galleryItems.map((item) => safeStat(item.path)).filter(Boolean);
    const mediaSizeBytes = mediaType === "gallery"
      ? galleryStats.reduce((sum, item) => sum + Number(item.size || 0), 0)
      : stat.size;
    const mediaMtimeMs = mediaType === "gallery"
      ? Math.max(0, ...galleryStats.map((item) => Math.floor(item.mtimeMs || 0)))
      : Math.floor(stat.mtimeMs || 0);
    const mediaMetadata = {
      ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
      fanhaoMedia: {
        type: mediaType,
        galleryCount: mediaType === "gallery" ? galleryItems.length : 0,
        galleryItems: mediaType === "gallery" ? galleryItems.map((item) => item.type) : []
      }
    };

    const authorSecUid = String(row.author_sec_uid || data?.author_sec_uid || authorData.sec_uid || row.profile_sec_uid || rawProfile.sec_uid || "").trim();
    const authorProfileUrl = normalizedDouyinUserUrl(row.author_url || data?.author_url, authorSecUid);
    return {
      id,
      awemeId,
      author: {
        secUid: authorSecUid,
        uid: String(row.author_uid || authorData.uid || row.profile_uid || rawProfile.uid || "").trim(),
        name: String(row.author_nickname || authorData.nickname || data?.author_name || row.profile_nickname || rawProfile.nickname || "").trim() || "未知作者",
        avatarUrl: firstUrlAny(row.author_avatar_url, data?.author_avatar_url, authorData.avatar_thumb, authorData.avatar_medium, authorData.avatar_larger, row.profile_avatar_url, rawProfile.avatar_url),
        profileUrl: authorProfileUrl,
        uniqueId: String(row.profile_unique_id || authorData.unique_id || authorData.uniqueId || rawProfile.unique_id || "").trim(),
        shortId: String(row.profile_short_id || authorData.short_id || authorData.shortId || rawProfile.short_id || "").trim(),
        signature: String(row.profile_signature || authorData.signature || rawProfile.signature || "").trim(),
        ipLocation: String(row.profile_ip_location || authorData.ip_location || authorData.ipLocation || rawProfile.ip_location || "").trim(),
        followerCount: optionalInteger(row.profile_follower_count ?? authorData.follower_count ?? authorData.followerCount ?? rawProfile.follower_count),
        followingCount: optionalInteger(row.profile_following_count ?? authorData.following_count ?? authorData.followingCount ?? rawProfile.following_count),
        totalFavorited: optionalInteger(row.profile_total_favorited ?? authorData.total_favorited ?? authorData.totalFavorited ?? rawProfile.total_favorited),
        awemeCount: optionalInteger(row.profile_aweme_count ?? authorData.aweme_count ?? authorData.awemeCount ?? rawProfile.aweme_count),
        favoritingCount: optionalInteger(row.profile_favoriting_count ?? authorData.favoriting_count ?? authorData.favoritingCount ?? rawProfile.favoriting_count),
        gender: optionalInteger(row.profile_gender ?? authorData.gender ?? rawProfile.gender),
        age: optionalInteger(row.profile_age ?? authorData.age ?? rawProfile.age),
        verification: String(row.profile_verification || authorData.custom_verify || authorData.customVerify || rawProfile.verification || "").trim(),
        profileCollectedAt: String(row.profile_collected_at || rawProfile.profile_collected_at || "").trim(),
        rawJson: JSON.stringify({
          profileUrl: authorProfileUrl,
          sourceProfileUrl: row.profile_url || "",
          profile: rawProfile || {},
          metadata: rawMetadata || data || {}
        })
      },
      title,
      description,
      tags,
      createTime,
      publishedAt,
      likedAt,
      mediaType,
      galleryItems,
      durationMs,
      width: Number(video.width || video.play_addr?.width || 0) || null,
      height: Number(video.height || video.play_addr?.height || 0) || null,
      actualVideo: mediaType === "video" ? {
        width: Math.max(0, Number(row.actual_width || 0)),
        height: Math.max(0, Number(row.actual_height || 0)),
        bitRate: Math.max(0, Number(row.actual_bit_rate || 0)),
        codec: String(row.actual_codec || "").trim().toLowerCase(),
        frameRate: Math.max(0, Number(row.actual_frame_rate || 0)),
        pixels: Math.max(0, Number(row.actual_pixels || 0)),
        longEdge: Math.max(0, Number(row.actual_long_edge || 0)),
        probedAt: String(row.actual_probed_at || "").trim(),
        probeError: String(row.actual_probe_error || "").trim()
      } : null,
      diggCount: Math.max(0, Number(row.digg_count || 0), Number(statistics.digg_count || 0)),
      commentCount: Math.max(0, Number(row.comment_count || 0), Number(statistics.comment_count || 0)),
      collectCount: Math.max(0, Number(row.collect_count || 0), Number(statistics.collect_count || 0)),
      shareCount: Math.max(0, Number(row.share_count || 0), Number(statistics.share_count || 0)),
      playCount: Number(statistics.play_count || 0) || 0,
      shareUrl: normalizedDouyinShareUrl(row.url || data?.share_url, awemeId),
      metadataJson: JSON.stringify(mediaMetadata),
      sourcePath,
      coverPath,
      coverSource: coverPath ? "native" : "",
      musicPath,
      dataPath,
      relativePath: outputDir ? path.relative(outputDir, sourcePath) : sourcePath,
      fileName: path.basename(sourcePath),
      sizeBytes: mediaSizeBytes,
      mtimeMs: mediaMtimeMs,
      origin: row.profile_tab === "post" ? "douyin_download_manager_post" : "douyin_download_manager_like"
    };
  }

  function parseAuthorFolder(root, filePath) {
    const relative = path.relative(root, filePath);
    const first = relative.split(/[\\/]/)[0] || "";
    const markerIndex = first.lastIndexOf("_MS4w");
    if (markerIndex >= 0) {
      return {
        name: first.slice(0, markerIndex).trim() || "未命名作者",
        secUid: first.slice(markerIndex + 1).trim()
      };
    }
    return { name: first.trim() || "未知作者", secUid: "" };
  }

  function parseVideoName(name) {
    const match = /^(20\d{2}-\d{2}-\d{2})_(.+?)_([0-9]{8,})$/u.exec(String(name || ""));
    if (!match) return { date: "", title: "", awemeId: "" };
    return { date: match[1], title: match[2].trim(), awemeId: match[3] };
  }

  function findCompanion(files, dir, videoPath, ext, predicate) {
    const videoBase = path.basename(videoPath, path.extname(videoPath));
    const exact = files.find((name) => {
      if (ext && path.extname(name).toLowerCase() !== ext) return false;
      return predicate ? predicate(name) : name.startsWith(videoBase);
    });
    if (exact) return path.join(dir, exact);
    const loose = files.find((name) => {
      if (ext && path.extname(name).toLowerCase() !== ext) return false;
      return predicate ? predicate(name) : true;
    });
    return loose ? path.join(dir, loose) : "";
  }

  function findCover(files, dir, videoPath) {
    const coverBases = companionCoverBases(videoPath);
    const local = files.find((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return false;
      const base = path.basename(name, ext).toLowerCase();
      return coverBases.some((item) => base === item || base.startsWith(`${item}_`) || base.startsWith(`${item}-`));
    }) || files.find((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return false;
      const base = path.basename(name, ext).toLowerCase();
      return base.includes("cover") || base.includes("封面");
    }) || files.find((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()));
    return local ? path.join(dir, local) : "";
  }

  function companionCoverBases(videoPath) {
    const videoBase = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
    const bases = new Set([videoBase]);
    const liveMatch = /^(.*)_live_(\d+)$/i.exec(videoBase);
    if (liveMatch) {
      bases.add(`${liveMatch[1]}_${Number(liveMatch[2])}`);
      bases.add(`${liveMatch[1]}_${liveMatch[2]}`);
    }
    return [...bases].filter(Boolean);
  }

  function naturalFileNameCompare(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, {
      numeric: true,
      sensitivity: "base"
    });
  }

  function galleryDirectoryMediaCompare(left, right) {
    const leftSequence = galleryDirectoryMediaSequence(left);
    const rightSequence = galleryDirectoryMediaSequence(right);
    if (leftSequence.index !== rightSequence.index) return leftSequence.index - rightSequence.index;
    if (leftSequence.typeOrder !== rightSequence.typeOrder) return leftSequence.typeOrder - rightSequence.typeOrder;
    return naturalFileNameCompare(left, right);
  }

  function galleryDirectoryMediaSequence(fileName) {
    const ext = path.extname(String(fileName || ""));
    const base = path.basename(String(fileName || ""), ext);
    const liveMatch = /_live_(\d+)$/i.exec(base);
    if (liveMatch) return { index: Number(liveMatch[1]) || 0, typeOrder: 1 };
    const numberedMatch = /_(\d+)$/i.exec(base);
    if (numberedMatch) {
      return {
        index: Number(numberedMatch[1]) || 0,
        typeOrder: VIDEO_EXTS.has(ext.toLowerCase()) ? 1 : 0
      };
    }
    return { index: Number.MAX_SAFE_INTEGER, typeOrder: VIDEO_EXTS.has(ext.toLowerCase()) ? 1 : 0 };
  }

  function parseDownloadManagerPaths(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.flat(Infinity).filter((item) => typeof item === "string" && item.trim());
      if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
    } catch {}
    return raw.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean);
  }

  function isDownloadManagerGallery(row = {}) {
    const kind = String(row.kind || "").trim().toLowerCase();
    const mediaType = String(row.media_type || "").trim().toLowerCase();
    return kind === "note" || mediaType === "gallery" || mediaType === "image" || mediaType === "images";
  }

  function resolveDownloadManagerPath(outputDir, filePath) {
    const value = String(filePath || "").trim();
    if (!value) return "";
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(outputDir || "", value);
  }

  function firstExistingDownloadManagerPath(paths, exts, predicate = null) {
    return paths.find((filePath) => {
      if (!filePath || !exts.has(path.extname(filePath).toLowerCase())) return false;
      if (predicate && !predicate(filePath)) return false;
      return safeStat(filePath)?.isFile();
    }) || "";
  }

  function downloadManagerCoverPath(row, localPaths, sourcePath, outputDir) {
    const rowCoverPath = row.local_cover_path ? resolveDownloadManagerPath(outputDir, row.local_cover_path) : "";
    if (rowCoverPath && IMAGE_EXTS.has(path.extname(rowCoverPath).toLowerCase()) && safeStat(rowCoverPath)?.isFile()) {
      return rowCoverPath;
    }
    const localCover = firstExistingDownloadManagerPath(localPaths, IMAGE_EXTS, (filePath) => {
      const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
      const coverBases = companionCoverBases(sourcePath);
      return coverBases.some((item) => base === item || base.startsWith(`${item}_`) || base.startsWith(`${item}-`))
        || base.includes("cover")
        || base.includes("封面");
    }) || firstExistingDownloadManagerPath(localPaths, IMAGE_EXTS);
    if (localCover) return localCover;
    const previewPath = row.preview_path ? resolveDownloadManagerPath(outputDir, row.preview_path) : "";
    if (previewPath && IMAGE_EXTS.has(path.extname(previewPath).toLowerCase()) && safeStat(previewPath)?.isFile()) {
      return previewPath;
    }
    return "";
  }

  function readVideoJson(filePath) {
    if (!filePath) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function firstUrl(value) {
    const list = value?.url_list;
    if (Array.isArray(list)) return String(list[0] || "").trim();
    if (Array.isArray(value)) return value.map((item) => firstUrl(item)).find(Boolean) || "";
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
    return "";
  }

  function firstUrlAny(...values) {
    for (const value of values) {
      const url = firstUrl(value);
      if (url) return url;
    }
    return "";
  }

  function rawAwemeMetadata(data = {}) {
    const raw = data?.metadata;
    if (!raw) return null;
    if (typeof raw === "object" && !Array.isArray(raw)) return raw;
    if (typeof raw !== "string") return null;
    return parseJsonObject(raw);
  }

  function tagsFromText(text) {
    const tags = [];
    for (const match of String(text || "").matchAll(/[#_＃]([^\s#_＃@，,。；;]+)/gu)) {
      const tag = match[1].trim();
      if (tag && tag.length <= 30 && !tags.includes(tag)) tags.push(tag);
    }
    return tags.slice(0, 20);
  }

  function mergeTags(...groups) {
    const tags = [];
    const seen = new Set();
    for (const group of groups) {
      for (const tag of group || []) {
        const value = String(tag || "").trim();
        const key = value.toLowerCase();
        if (!value || seen.has(key)) continue;
        seen.add(key);
        tags.push(value);
        if (tags.length >= 20) return tags;
      }
    }
    return tags;
  }

  function isoFromCreateTime(value) {
    const seconds = Number(value || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    try {
      return new Date(seconds * 1000).toISOString();
    } catch {
      return "";
    }
  }

  function normalizeIsoDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString();
  }

  function dateOnlyIso(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
    return `${value}T00:00:00.000Z`;
  }

  function safeReadDir(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  return Object.freeze({
    downloadManagerRowToItem,
    parseGalleryDirectory,
    parseVideoFile
  });
}

export function normalizedDouyinShareUrl(value, awemeId = "") {
  const url = String(value || "").trim();
  if (url) return url;
  return douyinVideoUrl(awemeId);
}

export function normalizedDouyinUserUrl(value, secUid = "") {
  const url = String(value || "").trim();
  if (url) return url;
  return douyinUserUrl(secUid);
}

export function douyinVideoUrl(awemeId) {
  const id = String(awemeId || "").trim();
  if (!/^\d{8,}$/.test(id)) return "";
  return `https://www.douyin.com/video/${id}`;
}

export function douyinNoteUrl(awemeId) {
  const id = String(awemeId || "").trim();
  if (!/^\d{8,}$/.test(id)) return "";
  return `https://www.douyin.com/note/${id}`;
}

export function douyinUserUrl(secUid) {
  const id = String(secUid || "").trim();
  if (!id) return "";
  return `https://www.douyin.com/user/${encodeURIComponent(id)}`;
}
