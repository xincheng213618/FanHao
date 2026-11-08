import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotosRuntime } from "../src/modules/photos/server/runtime.js";
import { fetchPublicPhotoSource } from "../src/modules/photos/server/photo-catalog-fetch.js";
import { archiveDiskSignature, ARCHIVE_IMAGE_INDEXER_VERSION } from "../src/platform/server/archive-image-service.js";
import { readJsonBody, safeChildPath } from "../src/platform/server/request-io.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const sourceUrl = "https://www.5280k.com/category/ggtt/limerence";
const sourceDirectory = "https://www.5280k.com/category/zzhj";
const otherCollectionUrl = "https://www.5280k.com/344773.html";
const otherCategory = "https://www.5280k.com/category/ggtt/aigirl";
const otherPageTwo = `${otherCategory}/page/2`;
const sourceArticle = (id, title, { classes = "", issue = "" } = {}) => `
  <article id="post-${id}" class="${classes}">
    <h2 class="entry-title"><a href="/${id}.html">${title}</a></h2>
    <span class="girl-nums">${issue}</span>
  </article>`;
const sourceCollection = sourceArticle("49581", "Limerence原创图集+影像合辑 [113套/330G]", {
  classes: "category-zzhj category-sticky", issue: "113+"
});
const htmlPages = new Map([
  [sourceDirectory, sourceCollection],
  [sourceUrl, `${sourceCollection}
    ${sourceArticle("345199", "Limerence VOL.113 春景 [189P+1V/2.74GB]", { issue: "113-2" })}
    ${sourceArticle("345196", "Limerence VOL.113 春日 [155P+1V/4.34GB]", { issue: "113" })}
    <a rel="next" href="${sourceUrl}/page/2">Next</a>`],
  [`${sourceUrl}/page/2`, sourceArticle("345191", "Limerence VOL.112 [30P/1G]")],
  [otherCollectionUrl, `<article id="post-344773" class="category-aigirl category-zzhj">
    <h1 class="entry-title">AiGirl 合辑 [001-398期/50G]</h1>
    <a href="${otherCategory}" rel="category tag">AiGirl</a></article>`],
  [otherCategory, `${sourceArticle("344773", "AiGirl 合辑 [001-398期/50G]", { classes: "category-zzhj category-aigirl" })}
    ${sourceArticle("388400", "AiGirl VOL.409 [50P-1.16GB]")}
    <a class="nextpostslink" href="${otherPageTwo}">Next</a>`],
  [otherPageTwo, sourceArticle("388398", "AiGirl VOL.408 [1V／2.74GB]")]
]);

const temp = mkdtempSync(path.join(os.tmpdir(), "fanhao-photo-catalog-intake-"));
const db = createImageGalleryDbService({ dbPath: path.join(temp, "gallery.sqlite"), ensureDataDir() {} });
const albums = [];
function addAlbum(id, folder, title, bytes = "fixture archive bytes") {
  const relativePath = path.join(folder, `${title}.rar`);
  const file = path.join(temp, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const stat = statSync(file);
  const album = { id, sourceRoot: temp, rootLabel: "fixture", relativePath, title, category: folder.split("/")[0], archiveExt: "rar",
    size: stat.size, updatedAt: new Date(stat.mtimeMs).toISOString(), imageCount: null };
  albums.push(album);
  return album;
}
const a = addAlbum("ps_test_limerence_a", "来源/Limerence", "Limerence VOL.113 春景", "fixture archive with extra bytes");
const b = addAlbum("ps_test_limerence_b", "来源/Limerence", "Limerence VOL.113 春日");
const separate = addAlbum("ps_test_limerence_c", "来源/其他扫描目录", "Limerence VOL.112");
const personal = addAlbum("ps_test_local", "本地/嵌套/个人收藏", "春游 NO.013");
const stale = addAlbum("ps_test_stale", "本地/嵌套/个人收藏", "秋游");
const otherPersonal = addAlbum("ps_test_other_local", "其他/嵌套/个人收藏", "周末作品");
const imageLibraryService = createImageLibraryService({ photoCollectionRootValue: "__fixture_root__" });
const photoSetService = {
  byId: (id) => albums.find((album) => album.id === id),
  archivePath: (album) => safeChildPath(album.sourceRoot, album.relativePath),
  publicDetail: async (album) => ({ ...album, images: [], imageCount: 0 })
};
function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
let sourceRequests = 0;
let bodyReads = 0;
const runtime = createPhotosRuntime({
  appConfigService: {},
  imageLibraryService,
  getImageGalleryDb: db.getDb,
  getPhotoSets: () => albums,
  imageReaderCacheStatus: async () => ({}),
  loadPublicPhotoSource: async (url) => {
    sourceRequests += 1;
    assert.ok(htmlPages.has(url), `unexpected fixture URL ${url}`);
    return { url, html: htmlPages.get(url) };
  },
  notFound: (res) => json(res, 404, { error: "not found" }),
  photoSetService,
  readJsonBody(req) { bodyReads += 1; return readJsonBody(req); },
  requireLocalAdmin(req, res) {
    if (req.headers["x-fixture-admin"] === "1") return true;
    json(res, 403, { error: "forbidden" });
    return false;
  },
  sendJson: json
});
const staticFiles = createStaticFileServer({ publicDir: fileURLToPath(new URL("../public/", import.meta.url)) });
const server = createServer(async (req, res) => {
  try {
    if (!await runtime.routeApi(req, res, new URL(req.url, "http://fixture"))) json(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    json(res, error.statusCode || 500, { error: error.message });
  }
});
try {
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(suffix, body, { status = 200, admin = true, raw = false } = {}) {
    const response = await fetch(`${base}${raw ? "" : "/api/photo-catalog"}${suffix}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(admin ? { "x-fixture-admin": "1" } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  const catalogPage = staticFiles.publicFilePath("/photo/catalog");
  assert.match(catalogPage, /modules[\\/]photos[\\/]catalog[\\/]index\.html$/);
  assert.equal(staticFiles.publicFilePath("/photo/set/catalog"), catalogPage);
  assert.equal(staticFiles.publicFilePath("/photo/set/catalog/"), catalogPage);
  assert.notEqual(staticFiles.publicFilePath("/photo/set/ps_test_limerence_a"), catalogPage);
  await api("/intake/options", undefined, { admin: false, status: 403 });
  await api("/intake/preview", { mode: "source", url: sourceUrl }, { admin: false, status: 403 });
  assert.equal(sourceRequests + bodyReads, 0);
  await api("/intake/preview", { mode: "source", url: "https://www.5280k.com.example.org/49581.html" }, { status: 400 });
  await api("/intake/preview", { mode: "source", url: "https://user@www.5280k.com/49581.html" }, { status: 400 });
  assert.equal(sourceRequests, 0);
  await assert.rejects(fetchPublicPhotoSource(sourceUrl, { fetchImpl: async () => new Response(null, {
    status: 302, headers: { location: "http://127.0.0.1/private" }
  }) }), /5280k/);

  const { localCollections, sampleSourceUrl } = await api("/intake/options");
  assert.equal(sampleSourceUrl, sourceDirectory);
  const localCollectionId = localCollections.find((group) => group.title === "Limerence").id;
  const personalCollection = localCollections.find((group) => group.directory === "本地/嵌套/个人收藏");
  const otherPersonalCollection = localCollections.find((group) => group.directory === "其他/嵌套/个人收藏");
  assert.equal(personalCollection.title, otherPersonalCollection.title);
  assert.equal(personalCollection.legacyKey, imageLibraryService.describePhotoCollection(personal).key);
  assert.notEqual(personalCollection.catalogKey, otherPersonalCollection.catalogKey);
  const directory = await api("/intake/preview", { mode: "source", url: sourceDirectory });
  assert.equal(directory.changes.length, 0);
  assert.equal(directory.sourceCollections[0].externalId, "49581");

  const alternate = await api("/intake/preview", { mode: "source", url: otherCollectionUrl });
  assert.equal(alternate.collection.externalId, "344773");
  assert.equal(alternate.sourceCollectionUrl, otherCollectionUrl);
  assert.equal(alternate.nextPage, otherPageTwo);
  assert.equal(alternate.changes[0].source.externalId, "388400");
  assert.equal(alternate.changes[0].source.declaredImageCount, 50);
  assert.equal(alternate.changes[0].source.declaredSizeLabel, "1.16GB");
  const alternateNext = await api("/intake/preview", { mode: "source", url: alternate.nextPage, sourceCollectionUrl: alternate.sourceCollectionUrl });
  assert.equal(alternateNext.collection.externalId, "344773");
  assert.equal(alternateNext.changes[0].source.declaredVideoCount, 1);
  assert.equal(alternateNext.changes[0].source.declaredImageCount, undefined);
  assert.equal((await api("/intake/preview", { mode: "source", url: otherPageTwo })).collection.externalId, "344773");
  await api("/intake/preview", { mode: "source", url: sourceUrl, sourceCollectionUrl: otherCollectionUrl }, { status: 400 });

  const plan = await api("/intake/preview", { mode: "source", url: sourceUrl, localCollectionId });
  assert.equal(plan.collection.declaredCount, 113);
  assert.equal(plan.collection.declaredSizeLabel, "330G");
  assert.ok(plan.warnings.some((warning) => warning.includes("同一期号")));
  assert.deepEqual(plan.changes.map((row) => [row.issueCode, row.source.issueLabel, row.source.declaredImageCount]), [
    ["VOL.113", "113-2", 189], ["VOL.113", "113", 155]
  ]);
  assert.deepEqual(plan.changes.map((row) => row.archiveIds), [[], []]);
  assert.deepEqual(plan.changes[0].localAlbums.map(({ id }) => id), [a.id]);
  assert.equal(plan.changes[1].localAlbums[0].id, b.id);
  assert.equal((await api("")).total, 0);

  const [first, second] = plan.changes;
  const confirm = { planId: plan.planId, confirmed: true, changes: [
    { key: first.key, archiveIds: [a.id], people: [{ name: "测试人物" }], releaseDate: "2025-04-15" },
    { key: second.key }
  ] };
  await api("/intake/commit", { ...confirm, confirmed: false }, { status: 400 });
  await api("/intake/commit", { ...confirm, changes: [{ key: first.key, archiveIds: [personal.id] }] }, { status: 400 });
  await api("/intake/commit", { ...confirm, changes: confirm.changes.map((row) => ({ ...row, archiveIds: [a.id] })) }, { status: 400 });
  assert.equal((await api("")).total, 0);
  const imported = await api("/intake/commit", confirm);
  assert.equal(imported.imported, 2, JSON.stringify(imported));
  const [one, two] = imported.results.map((row) => row.work);
  assert.notEqual(one.id, two.id);
  assert.deepEqual([one.issueCode, two.issueCode], ["VOL.113", "VOL.113"]);
  assert.deepEqual([one.measuredSize, one.measuredImageCount, two.measuredSize], [a.size, null, null]);
  assert.equal(one.releaseDate, "2025-04-15");
  assert.equal(one.sources[0].declaredVideoCount, 1);
  assert.equal(one.sources[0].issueLabel, "113-2");
  assert.deepEqual((await api("?sort=release")).items.map((item) => item.id), [one.id, two.id]);
  assert.deepEqual((await api("?sort=size")).items.map((item) => item.id), [one.id, two.id]);
  assert.equal((await api("/intake/commit", confirm)).replayed, 2);

  const signature = archiveDiskSignature(photoSetService.archivePath(a), statSync(photoSetService.archivePath(a)));
  db.getDb().prepare(`INSERT INTO photo_set_image_indexes
    (archive_path,archive_identity,archive_size,archive_mtime_ms,image_count,images_json,indexer_version,indexed_at,updated_at)
    VALUES (?,?,?,?,?,'[]',?,?,?)`).run(signature.archivePath, signature.archiveIdentity, signature.archiveSize,
      signature.archiveMtimeMs, 3, ARCHIVE_IMAGE_INDEXER_VERSION, "2026-11-07", "2026-11-07");
  assert.equal((await api(`/${a.id}`)).work.id, one.id);
  assert.equal((await api(`/${one.id}`)).work.measuredImageCount, 3);
  assert.equal((await api(`/api/photo-sets/${a.id}`, undefined, { raw: true })).album.id, a.id);

  const retryPlan = await api("/intake/preview", { mode: "source", url: sourceUrl, localCollectionId });
  const retrySecond = retryPlan.changes[1];
  assert.equal(retrySecond.workId, two.id);
  const lateArchive = await api("/intake/commit", { planId: retryPlan.planId, confirmed: true, changes: [{ key: retrySecond.key, archiveIds: [b.id] }] });
  assert.equal(lateArchive.results[0].work.id, two.id);
  assert.equal(lateArchive.results[0].work.archives[0].id, b.id);
  const pageTwo = await api("/intake/preview", { mode: "source", url: plan.nextPage });
  assert.equal(pageTwo.collection.externalId, "49581", "pagination must retain the same collection identity");

  const local = await api("/intake/preview", { mode: "local", localCollectionId: personalCollection.id });
  writeFileSync(photoSetService.archivePath(stale), "different archive bytes from preview");
  const result = await api("/intake/commit", { planId: local.planId, confirmed: true, changes: local.changes.map((row) => ({
    key: row.key, ...(row.archiveIds[0] === personal.id ? { people: [{ name: "测试人物" }] } : {})
  })) });
  assert.deepEqual([result.imported, result.failed], [1, 1]);
  const savedLocal = result.results.find((row) => row.status === "imported").work;
  assert.equal(savedLocal.issueCode, "NO.013");
  const list = await api(`?person=${encodeURIComponent("测试人物")}`);
  assert.equal(list.total, 2);
  assert.deepEqual(list.counts, { local: 2, source: 1 });
  assert.equal((await api("?q=VOL.113")).total, 2);

  const manifest = await api("/intake/preview", { mode: "manifest", manifest: {
    schema_version: 1, complete: true,
    plan: { roots: [{ post_id: "49220", destination_name: "历史合集" }] },
    results: [{ status: "imported", post_id: "49220", sequence: 42, rar_path: photoSetService.archivePath(personal),
      bytes: personal.size, image_count: 200 }]
  } });
  assert.equal(manifest.changes[0].workId, savedLocal.id);
  assert.equal(manifest.changes[0].manifestObservation.importSequence, 42);
  const enriched = await api("/intake/commit", { planId: manifest.planId, confirmed: true, changes: [{ key: manifest.changes[0].key }] });
  const enrichedWork = enriched.results[0].work;
  assert.equal(enrichedWork.id, savedLocal.id);
  assert.equal(enrichedWork.issueCode, "NO.013");
  assert.equal(enrichedWork.measuredImageCount, null);
  assert.equal(enrichedWork.collections.find((collection) => collection.provider === "tuimzz").externalId, "49220");
  assert.equal((await api("")).total, 3);

  const sourceOnly = await api("/intake/commit", { planId: pageTwo.planId, confirmed: true, changes: [{ key: pageTwo.changes[0].key }] });
  const sourceWork = sourceOnly.results[0].work;
  const separateCollection = localCollections.find((group) => group.title === "其他扫描目录");
  const separatePlan = await api("/intake/preview", { mode: "local", localCollectionId: separateCollection.id });
  const localOnly = await api("/intake/commit", { planId: separatePlan.planId, confirmed: true, changes: [
    { key: separatePlan.changes[0].key, people: [{ name: "测试创作者", role: "creator" }] }
  ] });
  const localWork = localOnly.results[0].work;
  assert.equal((await api("")).total, 5);
  const merge = await api("/intake/preview", { mode: "source", url: plan.nextPage, localCollectionId: separateCollection.id });
  const mergeRow = merge.changes[0];
  assert.deepEqual(mergeRow.mergeCandidates, [{ archiveId: separate.id, localWorkId: localWork.id,
    sourceWorkId: sourceWork.id, localTitle: localWork.title, sourceTitle: sourceWork.title }]);
  const mergeBody = { planId: merge.planId, confirmed: true };
  const selectArchive = { key: mergeRow.key, archiveIds: [separate.id] };
  const declined = await api("/intake/commit", { ...mergeBody, changes: [selectArchive] });
  assert.equal(declined.failed, 1);
  await api("/intake/commit", { ...mergeBody, changes: [{ ...selectArchive, mergeWorkIds: [localWork.id, one.id] }] }, { status: 400 });
  assert.equal((await api("")).total, 5);
  const approved = { ...mergeBody, changes: [{ ...selectArchive, mergeWorkIds: [localWork.id, sourceWork.id] }] };
  const merged = await api("/intake/commit", approved);
  assert.equal(merged.imported, 1, JSON.stringify(merged));
  const mergedWork = merged.results[0].work;
  assert.equal(mergedWork.id, localWork.id);
  assert.deepEqual(mergedWork.people.map(({ name, role }) => [name, role]), [["测试创作者", "creator"]]);
  assert.equal((await api(`/${sourceWork.id}`)).work.id, localWork.id);
  assert.equal((await api(`/${separate.id}`)).work.id, localWork.id);
  assert.equal((await api("")).total, 4);
  assert.equal((await api("/intake/commit", approved)).replayed, 1);

  const manifestOnly = await api("/intake/preview", { mode: "manifest", manifest: {
    schema_version: 1, complete: true, plan: { roots: [] },
    results: [{ status: "imported", rar_path: photoSetService.archivePath(otherPersonal), bytes: otherPersonal.size }]
  } });
  const fromManifest = await api("/intake/commit", { planId: manifestOnly.planId, confirmed: true, changes: [{ key: manifestOnly.changes[0].key }] });
  assert.equal(fromManifest.imported, 1);
  assert.deepEqual((await api(`?collection=${encodeURIComponent(otherPersonalCollection.catalogKey)}`)).items.map((work) => work.archives[0].id), [otherPersonal.id]);
  assert.deepEqual((await api(`?collection=${encodeURIComponent(personalCollection.catalogKey)}`)).items.map((work) => work.archives[0].id), [personal.id]);
  console.log("photo-catalog intake: multiple collections, source pagination, exact local folders, manifest, explicit merge, freshness and idempotency passed");
} finally {
  await runtime.stop();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  removeVerifiedTempDir(temp);
}
