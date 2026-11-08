import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { workCodeKey } from "../../../../../lib/code-parser.js";
import { deriveWorkTraits } from "../../../../../lib/work-traits.js";
import { intakeCode } from "../workflows/intake-catalog.js";
import { assertFinished, inside, pathKey, VIDEO } from "../workflows/intake-files.js";

const ED2K = /^ed2k:\/\/\|file\|[^|]+\|(\d+)\|[a-f0-9]{32}\|/i;
const MAGNET = /^magnet:\?/i;
const SKIP_DIRECTORY = /^(?:[.$]|CVTest$|Organized$|Recovery$|System Volume Information$)/i;
const CACHE_MS = 15_000;
const SYNC_SCRIPT = fileURLToPath(new URL("../../../../../tools/sync_ltx_catalog.ps1", import.meta.url));
const execFileAsync = promisify(execFile);
const HIDDEN_GENRES = new Set(["c7=28", "c7=348", "c7=83", "c7=390"]);

function projectItem(raw, genres) {
  if (typeof raw?.code !== "string" || !Array.isArray(raw.links)) return null;
  const code = raw.code.trim();
  if (!code) return null;
  const pendingLinks = new Set(Array.isArray(raw.pending_links) ? raw.pending_links : []);
  const links = [];
  for (const url of new Set(raw.links)) {
    if (typeof url !== "string" || /[\r\n]/.test(url) || pendingLinks.has(url)) continue;
    const ed2k = ED2K.exec(url);
    const size = Number(ed2k?.[1]);
    if (ed2k && Number.isSafeInteger(size) && size > 0) links.push({ type: "ed2k", url, size });
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

function addLocal(files, { key, file, size, source }) {
  if (!files.has(key)) files.set(key, new Map());
  const group = files.get(key);
  const id = pathKey(file);
  if (group.has(id)) return;
  const name = path.basename(file);
  const marked = deriveWorkTraits({ videos: [{ name }] }).flags.ltx;
  const folderMarked = !marked && deriveWorkTraits({ directoryName: path.basename(path.dirname(file)) }).flags.ltx;
  group.set(id, { size, source, marked, folderMarked });
}

async function collectLibrary(files, keys, getDb) {
  const db = getDb();
  if (!db) return false;
  const rows = db.prepare(`
    SELECT wanted.value AS key, f.file_path AS file
    FROM json_each(?) wanted
    JOIN works w ON w.code_search = wanted.value
    JOIN local_files f ON f.work_id = w.id AND f.file_type = 'video'
  `).all(JSON.stringify([...keys]));
  let complete = true;
  for (let offset = 0; offset < rows.length; offset += 24) {
    await Promise.all(rows.slice(offset, offset + 24).map(async (row) => {
      if (!path.isAbsolute(row.file)) return;
      try {
        const stat = await getLocalFile(row.file);
        if (stat) addLocal(files, { ...row, size: stat.size, source: "library" });
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

export function createLtxCatalogService({ snapshotPath, getDb, incomingRoots, libraryRoots, coverUrl, refreshSnapshot = runCatalogSync }) {
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

  async function readSnapshot() {
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
    const libraryChecked = await collectLibrary(files, keys, getDb);
    const downloadsChecked = await collectDownloads(files, keys, incomingRoots, libraryRoots);
    return {
      fetchedAt: snapshot.fetched_at,
      libraryChecked,
      downloadsChecked,
      avatars,
      items: items.map(({ key, links, cover, ...item }) => {
        const copies = [...(files.get(key)?.values() || [])];
        const sizes = new Set(copies.map((file) => file.size));
        return {
          ...item,
          score: item.rawScore === null ? null : (item.votes * item.rawScore + prior.votes * prior.score) / (item.votes + prior.votes),
          coverUrl: coverUrl(cover),
          local: {
            library: copies.filter((file) => file.source === "library").length,
            downloads: copies.filter((file) => file.source === "download").length,
            marked: copies.filter((file) => file.marked).length,
            folderMarked: copies.filter((file) => file.folderMarked).length
          },
          links: links.map((link) => ({ ...link, sizeMatch: sizes.has(link.size) }))
        };
      })
    };
  }

  return {
    sync() {
      syncing ??= syncSnapshot().finally(() => { syncing = null; });
      return syncing;
    },
    async read({ refresh = false } = {}) {
      if (!refresh && cached?.expiresAt > Date.now()) return cached.payload;
      if (!loading) {
        const request = readSnapshot().then((payload) => {
          if (loading === request) cached = { payload, expiresAt: Date.now() + CACHE_MS };
          return payload;
        }).finally(() => { if (loading === request) loading = null; });
        loading = request;
      }
      return loading;
    }
  };
}
