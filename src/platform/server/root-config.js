import path from "node:path";

export function parseRootList(rawValue, fallback) {
  const raw = rawValue || fallback;
  const seen = new Set();
  return raw
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = path.parse(item);
      return parsed.root && parsed.root.toLowerCase() === item.toLowerCase() ? parsed.root : path.resolve(item);
    })
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function parseLibraryRoots(env = process.env) {
  const baseRaw =
    env.LIBRARY_ROOTS ||
    env.LIBRARY_ROOT ||
    "G:\\;F:\\;O:\\;O:\\[珍藏]\\;O:\\[珍藏1]\\;O:\\[稀有]\\;O:\\[动漫]\\;V:\\[A]\\;V:\\[A1]\\;V:\\AV\\";
  const raw = [baseRaw, env.FANHAO_WESTERN_ROOTS || "R:\\"].filter(Boolean).join(";");
  const roots = raw
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = path.parse(item);
      const root = item.endsWith("\\") || item.endsWith("/") ? item : item + path.sep;
      return parsed.root ? root : path.resolve(root);
    });

  return [...new Set(roots)];
}

export function parseShortVideoRoots(env = process.env) {
  const storageRoot = env.FANHAO_SHORT_VIDEO_STORAGE_ROOT || "D:\\Media";
  const fallback = path.join(storageRoot, "ShortVideos");
  return parseRootList(env.FANHAO_SHORT_VIDEO_ROOTS || env.FANHAO_DOUYIN_LIKES_ROOT || fallback, fallback);
}

export function parseMusicRoots(env = process.env) {
  const fallback = "D:\\Media\\Music";
  return parseRootList(env.FANHAO_MUSIC_ROOTS || env.FANHAO_MUSIC_ROOT || fallback, fallback);
}

export function parsePhotoSetRoots(env = process.env) {
  return parseRootList(env.FANHAO_PHOTO_SET_ROOTS, "T:\\;T:\\[套图1]");
}

export function galleryMediaSources(env = process.env) {
  return [
    { kind: "movie", label: "电影", roots: parseRootList(env.FANHAO_MOVIE_ROOTS, "Z:\\") },
    { kind: "tv", label: "电视剧", roots: parseRootList(env.FANHAO_TV_ROOTS, "Y:\\") }
  ];
}
