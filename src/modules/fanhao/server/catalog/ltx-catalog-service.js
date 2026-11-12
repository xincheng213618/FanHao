import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { workCodeKey } from "../../../../../lib/code-parser.js";
import { deriveWorkTraits } from "../../../../../lib/work-traits.js";
import { intakeCode } from "../workflows/intake-catalog.js";
import { assertFinished, inside, pathKey, VIDEO } from "../workflows/intake-files.js";

const ED2K = /^ed2k:\/\/\|file\|([^|]+)\|(\d+)\|[a-f0-9]{32}\|/i;
const MAGNET = /^magnet:\?/i;
const SIDECAR_SUFFIX = /\.(?:(zh(?:-(?:cn|tw|hans|hant))?|en|ja|und)\.)?(?:srt|ass|ssa|vtt)$/i;
const SKIP_DIRECTORY = /^(?:[.$]|CVTest$|Organized$|Recovery$|System Volume Information$)/i;
const SYNC_SCRIPT = fileURLToPath(new URL("../../../../../tools/sync_ltx_catalog.ps1", import.meta.url));
const execFileAsync = promisify(execFile);
const HIDDEN_GENRES = new Set(["c7=28", "c7=348", "c7=83", "c7=390"]);

function catalogLink(value, type) {
  if (typeof value !== "string" || value.length > 1500) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    const hostname = url.hostname.replace(/^www\./, "");
    if (type === "subtitle") {
      const pathname = decodeURIComponent(url.pathname);
      if (hostname === "subtitlecat.com" && !url.search && !url.hash &&
        /^\/subs\/\d{1,8}\/[^/\\\x00-\x1f\x7f]+\.srt$/i.test(pathname)) return url.href;
    } else if (/^javdb(?:\d+)?\.com$/.test(hostname) && /^\/v\/[a-z0-9]+\/?$/i.test(url.pathname) ||
      hostname === "javbus.com" && /^\/[a-z0-9]+(?:-[a-z0-9]+)+\/?$/i.test(url.pathname)) {
      url.search = "";
      url.hash = "";
      return url.href;
    }
  } catch { /* An optional upstream URL may be malformed. */ }
  return "";
}

function isSubtitledLtx(name) {
  const { ltx, subtitled } = deriveWorkTraits({ videos: [{ name }] }).flags;
  return ltx && subtitled;
}

function ed2kFilename(encoded) {
  try { return decodeURIComponent(encoded); }
  catch { return encoded; }
}

function projectItem(raw, genres) {
  if (typeof raw?.code !== "string" || !Array.isArray(raw.links)) return null;
  const code = raw.code.trim();
  if (!code) return null;
  const pendingLinks = new Set(Array.isArray(raw.pending_links) ? raw.pending_links : []);
  const links = [];
  for (const url of new Set(raw.links)) {
    if (typeof url !== "string" || /[\r\n]/.test(url) || pendingLinks.has(url)) continue;
    const ed2k = ED2K.exec(url);
    const size = Number(ed2k?.[2]);
    if (ed2k && Number.isSafeInteger(size) && size > 0) {
      const name = ed2kFilename(ed2k[1]);
      links.push({ type: "ed2k", url, size, subtitledLtx: isSubtitledLtx(name) });
    }
    else if (MAGNET.test(url)) links.push({ type: "magnet", url });
  }
  const genreNames = [];
  for (const id of Array.isArray(raw.genres) ? raw.genres : []) {
    if (typeof id !== "string" || HIDDEN_GENRES.has(id)) continue;
    const translations = genres?.[id];
    if (Array.isArray(translations) && typeof translations[0] === "string" && translations[0]) {
      genreNames.push(translations[0]);
    }
  }
  return {
    code,
    key: workCodeKey(code) || code.replace(/[^a-z0-9]/gi, "").toLowerCase(),
    title: raw.title_zh || raw.title || "",
    originalTitle: raw.title || "",
    actors: Array.isArray(raw.actors) ? raw.actors.filter((actor) => typeof actor === "string") : [],
    maker: raw.maker || "",
    cover: raw.cover || "",
    detailUrl: catalogLink(raw.url, "detail"),
    subtitleUrl: catalogLink(raw.subtitle, "subtitle"),
    addedAt: Number(raw.added_at) || 0,
    date: typeof raw.date === "string" ? raw.date : "",
    rawScore: Number.isFinite(raw.score) ? raw.score : null,
    votes: Number.isSafeInteger(raw.votes) && raw.votes > 0 ? raw.votes : 0,
    genres: [...new Set(genreNames)],
    pending: raw.pending === true,
    waiting: raw.waiting === true,
    missing: raw.missing === true,
    links
  };
}

function catalogDetails(db, keys) {
  const details = new Map();
  if (!db?.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='work_external_refs'").get()) return details;
  // Start with the snapshot keys so SQLite only walks json_each once.
  const rows = db.prepare(`
    SELECT wanted.value AS key, r.url
    FROM json_each(?) wanted
    CROSS JOIN works w ON w.code_search = wanted.value
    CROSS JOIN work_external_refs r ON r.work_id = w.id AND r.provider = 'javdb-video'
  `).all(JSON.stringify([...keys]));
  for (const { key, url } of rows) {
    const detail = catalogLink(url, "detail");
    if (!detail) continue;
    details.set(key, details.has(key) && details.get(key) !== detail ? "" : detail);
  }
  return details;
}

function ratingPrior(items) {
  const rated = items.filter((item) => item.rawScore !== null);
  const voteCounts = rated.map((item) => item.votes).sort((a, b) => a - b);
  return {
    score: rated.length ? rated.reduce((sum, item) => sum + item.rawScore, 0) / rated.length : 0,
    votes: Math.max(1, voteCounts[Math.floor(voteCounts.length / 4)] ?? 0)
  };
}

async function getLocalFile(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

function addLocal(files, { key, file, size, source, indexedFile, indexedSidecars, subtitleFlags }) {
  if (!files.has(key)) files.set(key, new Map());
  const group = files.get(key);
  const id = pathKey(file);
  if (group.has(id)) return;
  const name = path.basename(file);
  const { ltx: marked, ltxLocal } = deriveWorkTraits({ videos: [{ name }] }).flags;
  const folderMarked = !marked && deriveWorkTraits({ directoryName: path.basename(path.dirname(file)) }).flags.ltx;
  group.set(id, { file, indexedFile, size, source, marked, ltxLocal, folderMarked, indexedSidecars, ...subtitleFlags });
}

function localStemKey(row, suffix) {
  if (row.localWorkId == null || !suffix) return null;
  const stem = path.resolve(row.file.slice(0, -suffix.length));
  return JSON.stringify([row.workId, row.localWorkId, process.platform === "win32" ? stem.toLowerCase() : stem]);
}

async function availableSidecars(sidecars = []) {
  let hasSidecar = false;
  for (const { file, chinese } of sidecars) {
    if (!await getLocalFile(file).catch(() => null)) continue;
    if (chinese) return { hasSidecar: true, hasChineseSidecar: true };
    hasSidecar = true;
  }
  return { hasSidecar, hasChineseSidecar: false };
}

async function collectLibrary(files, keys, db) {
  if (!db) return false;
  const rows = db.prepare(`
    SELECT wanted.value AS key, f.file_path AS file, f.file_id AS id, f.size, f.modified_at AS modifiedAt,
      f.work_id AS workId, f.local_work_id AS localWorkId, f.file_type AS fileType
    FROM json_each(?) wanted
    JOIN works w ON w.code_search = wanted.value
    JOIN local_files f ON f.work_id = w.id
    WHERE f.file_type = 'video' OR (f.file_type = 'info' AND lower(f.ext) IN ('.srt','.ass','.ssa','.vtt'))
  `).all(JSON.stringify([...keys])).filter(({ file }) => typeof file === "string" && path.isAbsolute(file));
  const videos = [];
  const videoStems = new Map();
  const sidecars = new Map();
  for (const row of rows) {
    if (row.fileType === "video") {
      const stem = localStemKey(row, path.extname(row.file));
      videos.push({ ...row, stem });
      if (stem) videoStems.set(stem, (videoStems.get(stem) || 0) + 1);
    } else {
      const suffix = SIDECAR_SUFFIX.exec(row.file);
      const stem = localStemKey(row, suffix?.[0]);
      if (!stem) continue;
      if (!sidecars.has(stem)) sidecars.set(stem, []);
      sidecars.get(stem).push({ file: row.file, chinese: /^zh(?:-|$)/i.test(suffix[1] || "") });
    }
  }
  let complete = true;
  for (let offset = 0; offset < videos.length; offset += 24) {
    await Promise.all(videos.slice(offset, offset + 24).map(async (row) => {
      try {
        const stat = await getLocalFile(row.file);
        if (!stat) return;
        const indexedSidecars = videoStems.get(row.stem) === 1 ? sidecars.get(row.stem) : undefined;
        addLocal(files, {
          ...row, size: stat.size, source: "library",
          indexedSidecars, subtitleFlags: await availableSidecars(indexedSidecars),
          indexedFile: { id: row.id, path: row.file, size: row.size, modifiedAt: row.modifiedAt }
        });
      } catch { complete = false; }
    }));
  }
  return complete;
}

async function collectDownloads(files, keys, incomingRoots, libraryRoots) {
  if (!incomingRoots.length) return false;
  let complete = true;
  async function collect(directory, visitChildren) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && visitChildren && !SKIP_DIRECTORY.test(entry.name)
        && !libraryRoots.some((root) => inside(file, root))) {
        await collect(file, false);
      } else if (entry.isFile() && VIDEO.test(entry.name)) {
        const key = workCodeKey(intakeCode(file));
        if (!keys.has(key)) continue;
        try {
          const stat = await getLocalFile(file);
          if (!stat) continue;
          assertFinished(file);
          addLocal(files, { key, file, size: stat.size, source: "download" });
        } catch (error) {
          if (!error.statusCode) complete = false;
        }
      }
    }
  }
  for (const root of incomingRoots) {
    if (!libraryRoots.some((libraryRoot) => inside(root, libraryRoot))) await collect(root, true);
  }
  return complete;
}

function runCatalogSync(snapshotPath) {
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  return execFileAsync(shell, ["-NoProfile", "-NonInteractive", "-File", SYNC_SCRIPT, "-Refresh", "-CachePath", snapshotPath], {
    timeout: 60_000,
    windowsHide: true
  });
}

export function createLtxCatalogService({ snapshotPath, getDb, incomingRoots, libraryRoots, coverUrl,
  videoProbeService, refreshSnapshot = runCatalogSync }) {
  let cached;
  let loading;
  let syncing;

  async function syncSnapshot() {
    await refreshSnapshot(snapshotPath);
    // An earlier read may still be scanning local files against the old snapshot.
    cached = null;
    loading = null;
    return { ok: true };
  }

  async function loadSnapshot() {
    let snapshot;
    try {
      snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    } catch (error) {
      const message = error.code === "ENOENT" ? "尚无 LTX 本地快照，请点击「更新目录」。" : "无法读取 LTX 本地快照，请检查文件或重新同步。";
      throw Object.assign(new Error(message, { cause: error }), { publicMessage: message });
    }
    if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.items)) {
      const message = "LTX 本地快照的格式不受支持，请重新同步。";
      throw Object.assign(new Error(message), { publicMessage: message });
    }
    return snapshot;
  }

  async function readSnapshot() {
    const snapshot = await loadSnapshot();
    const items = snapshot.items.map((item) => projectItem(item, snapshot.genres)).filter(Boolean);
    const prior = ratingPrior(items);
    const actors = new Set(items.flatMap((item) => item.actors));
    const avatars = Object.fromEntries([...actors].flatMap((actor) => {
      const value = snapshot.avatars?.[actor];
      const url = typeof value === "string" ? coverUrl(value) : "";
      return url ? [[actor, url]] : [];
    }));
    const keys = new Set(items.map((item) => item.key).filter(Boolean));
    const files = new Map();
    const db = getDb();
    const details = catalogDetails(db, keys);
    const libraryChecked = await collectLibrary(files, keys, db);
    const downloadsChecked = await collectDownloads(files, keys, incomingRoots, libraryRoots);
    const payload = {
      fetchedAt: snapshot.fetched_at,
      libraryChecked,
      downloadsChecked,
      avatars,
      items: items.map(({ key, links, cover, ...item }) => {
        const copies = [...(files.get(key)?.values() || [])];
        const sizes = new Set(copies.map((file) => file.size));
        return {
          ...item,
          detailUrl: item.detailUrl || details.get(key) || "",
          score: item.rawScore === null ? null : (item.votes * item.rawScore + prior.votes * prior.score) / (item.votes + prior.votes),
          coverUrl: coverUrl(cover),
          local: {
            library: copies.filter((file) => file.source === "library").length,
            downloads: copies.filter((file) => file.source === "download").length,
            marked: copies.filter((file) => file.marked).length,
            ltxLocal: copies.filter((file) => file.ltxLocal).length,
            folderMarked: copies.filter((file) => file.folderMarked).length,
            copies: copies.map(({ source, size, marked, ltxLocal, hasSidecar = false, hasChineseSidecar = false }) =>
              ({ source, size, marked, ltxLocal, hasSidecar, hasChineseSidecar }))
          },
          links: links.map((link) => ({ ...link, sizeMatch: sizes.has(link.size) }))
        };
      })
    };
    return { payload, files };
  }

  async function readCatalog({ refresh = false } = {}) {
    // The on-disk snapshot can also be replaced by the sync script.
    const stat = await fs.stat(snapshotPath).catch(() => null);
    const version = stat && `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (!refresh && version && cached?.version === version) return cached.catalog;
    if (loading?.version === version) return loading.request;

    const request = readSnapshot().then((catalog) => {
      if (loading?.request === request) cached = { version, catalog };
      return catalog;
    }).finally(() => { if (loading?.request === request) loading = null; });
    loading = { version, request };
    return request;
  }

  async function readLocalMedia(code) {
    const key = workCodeKey(code);
    if (!key) return { copies: [] };
    const catalog = await (loading?.request ?? cached?.catalog ?? readCatalog());
    const copies = [];
    for (const { file, indexedFile, source, indexedSidecars } of catalog.files.get(key)?.values() ?? []) {
      let stat;
      try {
        stat = await getLocalFile(file);
        if (!stat) continue;
        if (source === "download") assertFinished(file);
      } catch {
        continue;
      }
      const probe = await videoProbeService.probeCachedAsync(indexedFile ?? { path: file }, {
        verifiedStat: stat, background: true
      });
      copies.push({ source, size: stat.size, width: probe?.width ?? null, height: probe?.height ?? null,
        ...await availableSidecars(indexedSidecars) });
    }
    return { copies };
  }

  return {
    async findIntakeMetadata(code, localFile) {
      const key = workCodeKey(code);
      if (!key) return null;
      const snapshot = await loadSnapshot();
      const matches = snapshot.items.filter((item) => workCodeKey(item?.code) === key);
      if (matches.length !== 1) return null;
      const item = projectItem(matches[0], snapshot.genres);
      if (!item) return null;
      const matchesFile = localFile ? item.links.some((link) => {
        if (link.type !== "ed2k" || link.size !== localFile.size) return false;
        const [, encoded] = ED2K.exec(link.url);
        return ed2kFilename(encoded).toLowerCase() === localFile.name.toLowerCase();
      }) : false;
      return { code: item.code, title: item.originalTitle || item.title, actors: item.actors, date: item.date,
        maker: item.maker, rating: item.rawScore, imageUrl: item.cover, subtitleUrl: item.subtitleUrl, matchesFile };
    },
    sync() {
      syncing ??= syncSnapshot().finally(() => { syncing = null; });
      return syncing;
    },
    readLocalMedia,
    async read(options) { return (await readCatalog(options)).payload; }
  };
}
