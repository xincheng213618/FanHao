import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createServerConfig } from "../src/bootstrap/server-config.js";
import { ensureOfficialPhotoCoverColumns } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { photoShelfCollectionScope } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { officialPhotoCoverRevision, photoCoverHintScore, readOfficialCoverRevision } from "../src/modules/photos/server/photo-cover-source.js";
import { archiveDiskSignature, ARCHIVE_IMAGE_INDEXER_VERSION } from "../src/platform/server/archive-image-service.js";
import { ensureRealPathWithinRoots } from "../src/platform/server/library-path-safety.js";
import { safeChildPath } from "../src/platform/server/request-io.js";
import { fetchMetartCover, fetchMetartModel, metartModelSlug } from "./metart_photo_source.mjs";

const usage = "用法：npm run photo:sync-official-covers -- --collection <本地合集链接或 ID> --model <MetArt 人物页或标识> [--apply]";
const nameKey = value => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
const workKey = (date, title) => `${date}\n${nameKey(title)}`;
const provider = "metart";

export function collectionIdFromArg(input) {
  let id = input;
  if (input.includes("://") || input.startsWith("/photo/")) {
    const url = new URL(input, "http://127.0.0.1");
    const match = /^\/photo\/collection\/([^/]+)\/?$/u.exec(url.pathname);
    if (!match) throw new Error("请使用 FanHao 套图合集链接");
    id = decodeURIComponent(match[1]);
  }
  if (/^raw-[\w-]+$/u.test(id)) {
    const decoded = Buffer.from(id.slice(4), "base64url").toString("utf8");
    if (`raw-${Buffer.from(decoded).toString("base64url")}` !== id) throw new Error("合集编号编码无效");
    id = decoded;
  }
  if (!id || id.includes("\0") || Buffer.byteLength(id) > 4085) throw new Error("合集编号无效");
  return id;
}

export function metartLocalWork(title, modelName) {
  const name = nameKey(modelName).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^metart\\s*-\\s*(\\d{4}-\\d{2}-\\d{2})\\s*-?\\s*${name}\\s+-\\s+(.+)$`, "u").exec(nameKey(title));
  if (!match) return "";
  const work = match[2]
    .replace(/\s+_by\s+.+$/u, "")
    .replace(/(\d{3,6}\s*[x×х]\s*\d{3,6})\s+by\s+.+$/u, "$1")
    .replace(/\s*\d{3,6}\s*[x×х]\s*\d{3,6}$/u, "")
    .replace(/\s*[([]\s*[x×х]?\d+\s*[)\]]$/u, "").trim();
  return work ? workKey(match[1], work) : "";
}

function collectionRows(db, collectionId) {
  const shelf = photoShelfCollectionScope(collectionId);
  return (shelf ? db.prepare(`SELECT id, data_json FROM photo_library_archives
    WHERE json_extract(data_json, '$.sourceRoot')=? AND json_extract(data_json, '$.category')=?
      AND json_extract(data_json, '$.subCategory')=? ORDER BY position`).all(shelf.sourceRoot, shelf.category, shelf.subCategory)
    : db.prepare("SELECT id, data_json FROM photo_library_archives WHERE collection_id=? ORDER BY position").all(collectionId))
    .map(row => ({ ...JSON.parse(row.data_json), id: row.id }));
}

function currentSignature(album, config) {
  if (typeof album.sourceRoot !== "string" || typeof album.relativePath !== "string" || path.isAbsolute(album.relativePath)
    || !config.PHOTO_SET_ROOTS.some(root => path.resolve(root) === path.resolve(album.sourceRoot))) return null;
  try {
    const candidate = safeChildPath(album.sourceRoot, album.relativePath);
    if (!candidate) return null;
    const target = ensureRealPathWithinRoots(candidate, [album.sourceRoot], "套图归档");
    const signature = archiveDiskSignature(target, statSync(target));
    if (!signature || (album.archiveIdentity ? album.archiveIdentity !== signature.archiveIdentity
      : album.size !== signature.archiveSize || Date.parse(album.updatedAt) !== Math.trunc(signature.archiveMtimeMs))) return null;
    return signature;
  } catch { return null; }
}

export function planOfficialCovers(db, collectionId, model, config) {
  const revision = createPhotoLibraryStore({ getDb: () => db, archiveExts: config.ARCHIVE_EXTS, photoSetRoots: config.PHOTO_SET_ROOTS }).revision();
  if (!revision) throw new Error("没有当前配置对应的已发布套图索引，请先刷新图库");
  const albums = collectionRows(db, collectionId);
  if (!albums.length) throw new Error("找不到这个本地合集");
  if (!albums.every(album => typeof album.subCategory === "string" && nameKey(album.subCategory) === nameKey(model.name))) {
    throw new Error("本地合集名与官网人物名不一致，停止导入");
  }

  const key = `collection:${collectionId}`;
  const hasSource = table => db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === "official_source");
  const collectionCover = db.prepare(`SELECT source, version, ${hasSource("photo_category_covers") ? "official_source" : "NULL AS official_source"}
    FROM photo_category_covers WHERE category_key=?`).get(key);
  const rows = [{ kind: "portrait", key, title: model.name, source: model,
    state: collectionCover ? (collectionCover.source === "upload" && readOfficialCoverRevision(collectionCover.official_source) === collectionCover.version
      ? "already-imported" : "existing-custom-cover")
      : model.asset ? "ready" : "no-official-image" }];
  const works = new Map();
  for (const gallery of model.galleries) {
    const key = workKey(gallery.date, gallery.title);
    works.set(key, works.has(key) ? null : gallery);
  }
  const manual = db.prepare("SELECT 1 FROM photo_set_cover_overrides WHERE album_id=?");
  const cached = db.prepare(`SELECT archive_identity, status, member_path, length(cover_blob) AS blob_size,
    ${hasSource("photo_set_covers") ? "official_source" : "NULL AS official_source"} FROM photo_set_covers WHERE album_id=?`);
  const imageIndex = db.prepare("SELECT archive_identity, indexer_version, image_count, images_json FROM photo_set_image_indexes WHERE archive_path=?");
  for (const album of albums) {
    if (typeof album.title !== "string" || !/^metart\s*-/iu.test(album.title.trim())) continue;
    const work = metartLocalWork(album.title, model.name);
    const source = works.get(work);
    const row = { kind: "album", key: album.id, title: album.title, source };
    rows.push(row);
    row.state = (() => {
      if (!source) return works.has(work) ? "ambiguous" : "unmatched";
      if (!source.asset) return "no-official-image";
      if (manual.get(album.id)) return "existing-custom-cover";
      const signature = currentSignature(album, config);
      if (!signature) return "archive-unverified";
      row.signature = signature;
      const current = cached.get(album.id);
      if (current?.archive_identity === signature.archiveIdentity && current.status === "ok" && current.blob_size) {
        if (officialPhotoCoverRevision(current)) return "already-imported";
        if (photoCoverHintScore(current.member_path, config.COVER_HINTS)) return "existing-embedded-cover";
      }
      const index = imageIndex.get(signature.archivePath);
      if (index?.archive_identity !== signature.archiveIdentity || index.indexer_version !== ARCHIVE_IMAGE_INDEXER_VERSION) return "archive-index-required";
      let images;
      try { images = JSON.parse(index.images_json); } catch { return "archive-index-required"; }
      if (!Array.isArray(images) || images.length !== index.image_count
        || images.some(image => typeof image?.path !== "string" || !image.path)) return "archive-index-required";
      return images.some(image => photoCoverHintScore(image.path, config.COVER_HINTS)) ? "existing-embedded-cover" : "ready";
    })();
  }
  return { revision, rows };
}

export function saveOfficialCovers(db, { collectionId, model, config, initial, downloads }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = planOfficialCovers(db, collectionId, model, config);
    if (current.revision !== initial.revision) throw new Error("图库索引在下载时有变化，请重新预览");
    ensureOfficialPhotoCoverColumns(db);
    const putPortrait = db.prepare(`INSERT INTO photo_category_covers(category_key, source, version, mime, image, official_source)
      VALUES (?, 'upload', ?, 'image/jpeg', ?, ?) ON CONFLICT(category_key) DO NOTHING`);
    const putAlbum = db.prepare(`INSERT INTO photo_set_covers (album_id, archive_path, archive_size, archive_mtime_ms, archive_identity,
      member_path, cover_mime, cover_blob, cover_bytes, source_bytes, generator_version, status, error, generated_at, updated_at, official_source)
      VALUES (?, ?, ?, ?, ?, NULL, 'image/jpeg', ?, ?, ?, ?, 'ok', '', ?, ?, ?)
      ON CONFLICT(album_id) DO UPDATE SET archive_path=excluded.archive_path, archive_size=excluded.archive_size,
        archive_mtime_ms=excluded.archive_mtime_ms, archive_identity=excluded.archive_identity, member_path=NULL,
        cover_mime=excluded.cover_mime, cover_blob=excluded.cover_blob, cover_bytes=excluded.cover_bytes, source_bytes=excluded.source_bytes,
        generator_version=excluded.generator_version, status='ok', error='', generated_at=excluded.generated_at,
        updated_at=excluded.updated_at, official_source=excluded.official_source`);
    const now = new Date().toISOString();
    const previous = new Map(initial.rows.filter(row => row.state === "ready").map(row => [row.key, row]));
    for (const row of current.rows) {
      const before = previous.get(row.key);
      if (row.state !== "ready" || !before) continue;
      if (before.signature?.archiveIdentity !== row.signature?.archiveIdentity || before.source.id !== row.source.id) {
        row.state = "changed-since-preview";
        continue;
      }
      const bytes = downloads.get(row.source.asset);
      if (!bytes) continue;
      const revision = row.kind === "portrait" ? randomUUID() : createHash("sha256").update(bytes).digest("hex");
      const provenance = JSON.stringify({ provider, externalId: row.source.id, page: row.source.page, asset: row.source.asset, revision, importedAt: now });
      const result = row.kind === "portrait" ? putPortrait.run(row.key, revision, bytes, provenance)
        : putAlbum.run(row.key, row.signature.archivePath, row.signature.archiveSize, row.signature.archiveMtimeMs, row.signature.archiveIdentity,
          bytes, bytes.length, bytes.length, config.PHOTO_SET_COVER_GENERATOR_VERSION, now, now, provenance);
      row.state = result.changes ? "imported" : "changed-since-preview";
    }
    db.exec("COMMIT");
    return current;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function useHttpProxy() {
  if (typeof http.setGlobalProxyFromEnv !== "function") return;
  const isHttp = value => /^https?:\/\//iu.test(value || "");
  let proxy = [process.env.https_proxy, process.env.HTTPS_PROXY, process.env.ALL_PROXY].find(isHttp);
  // The script runner may only inherit a SOCKS proxy. Node fetch uses the
  // Windows HTTP proxy in this case, if Windows has one for the source site.
  if (!proxy && process.platform === "win32") {
    const command = "$uri = [uri]'https://www.metart.com/'; $proxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy($uri); "
      + "if ($proxy -and $proxy -ne $uri) { $proxy.GetLeftPart([UriPartial]::Authority) }";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 4096
    });
    if (result.status === 0) proxy = result.stdout.trim();
  }
  if (isHttp(proxy)) http.setGlobalProxyFromEnv({ ...process.env, https_proxy: proxy, HTTPS_PROXY: proxy });
}

async function main() {
  const { values } = parseArgs({ options: { collection: { type: "string" }, model: { type: "string" },
    apply: { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) return console.log(usage);
  if (!values.collection || !values.model) throw new Error(usage);
  const config = createServerConfig();
  if (config.PRODUCT.id !== "suite") throw new Error("请在 FanHao 主产品的图库上运行");
  const collectionId = collectionIdFromArg(values.collection);
  const slug = metartModelSlug(values.model);
  useHttpProxy();
  const model = await fetchMetartModel(slug);
  let initial;
  const reader = new DatabaseSync(config.IMAGE_GALLERY_DB_PATH, { readOnly: true });
  try {
    reader.exec("BEGIN");
    initial = planOfficialCovers(reader, collectionId, model, config);
    reader.exec("COMMIT");
  }
  finally { reader.close(); }
  let outcome = initial;
  const downloads = new Map();
  if (values.apply) {
    // Finish and validate every download before taking a SQLite write lock.
    for (const row of initial.rows) {
      if (row.state === "ready" && !downloads.has(row.source.asset)) {
        downloads.set(row.source.asset, await fetchMetartCover(row.source.asset, { maxBytes: config.IMAGE_GALLERY_COVER_MAX_BYTES }));
      }
    }
    if (downloads.size) {
      const writer = new DatabaseSync(config.IMAGE_GALLERY_DB_PATH);
      try {
        writer.exec("PRAGMA busy_timeout=5000");
        outcome = saveOfficialCovers(writer, { collectionId, model, config, initial, downloads });
      } finally { writer.close(); }
    }
  }
  console.log(JSON.stringify({ mode: values.apply ? "apply" : "preview", provider, collectionId, model: model.name,
    officialWorks: model.galleries.length, items: outcome.rows.map(row => ({ kind: row.kind, title: row.title,
      state: row.state, ...(row.source ? { source: row.source.page } : {}) })) }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message, error.cause?.code || ""); process.exitCode = 1; });
}
