import fs from "node:fs";
import path from "node:path";
import { SERVER_CONFIG } from "../src/bootstrap/server-config.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { imageLibraryCacheIdentity, imageLibraryIndexMatches } from "../src/modules/content-index/server/image-library-index-contract.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";

const [file, ...extra] = process.argv.slice(2);
if (!file || extra.length) throw new Error("用法 node tools/import_gallery_index.mjs <旧索引路径>");
const config = SERVER_CONFIG;
if (config.PRODUCT.id !== "suite") throw new Error("请使用 FanHao 主服务配置导入图库索引");
const inputs = { archiveExts: config.ARCHIVE_EXTS, photoSetRoots: config.PHOTO_SET_ROOTS,
  directVideoExts: config.DIRECT_VIDEO_EXTS, galleryMediaSources: config.GALLERY_MEDIA_SOURCES, videoExts: config.VIDEO_EXTS };
const index = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
if (!imageLibraryIndexMatches(index, imageLibraryCacheIdentity(inputs)) || !Number.isFinite(Date.parse(index.scannedAt))) {
  throw new Error("旧图库索引与当前配置不匹配");
}

const galleryDb = createImageGalleryDbService({ dbPath: config.IMAGE_GALLERY_DB_PATH,
  ensureDataDir: () => fs.mkdirSync(config.DATA_DIR, { recursive: true }) });
const project = createImageLibraryService({ photoCollectionRootValue: config.PHOTO_COLLECTION_ROOT_VALUE, photoSetService: {
  coverUrl: (id, updatedAt) => `/media/gallery-cover/${encodeURIComponent(id)}${updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : ""}`
} }).projectPhotoIndex;
const store = createPhotoLibraryStore({ ...inputs, getDb: galleryDb.getDb, project });
try {
  const expectedRevision = store.revision(), expectedMediaRevision = store.mediaRevision();
  const photo = !expectedRevision, media = !expectedMediaRevision;
  store.publish(index, { photo, media, expectedRevision, expectedMediaRevision });
  console.log(JSON.stringify({ importedPhotos: photo, importedMedia: media,
    photoSets: store.summary().totals.photoSets, mediaItems: store.mediaIndex().mediaItems.length }));
} finally {
  galleryDb.close();
}
