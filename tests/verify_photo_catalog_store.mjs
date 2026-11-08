import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { createPhotoCatalogService } from "../src/modules/photos/server/photo-catalog-service.js";
import { ARCHIVE_IMAGE_INDEXER_VERSION, archiveDiskSignature } from "../src/platform/server/archive-image-service.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temp = createVerifiedTempDir("fanhao-photo-catalog-");
const media = path.join(temp.tempDir, "photo-root");
const collectionDirectory = path.join(media, "COS", "推断人物");
const firstFile = path.join(collectionDirectory, "Archive First.zip");
const secondFile = path.join(collectionDirectory, "Archive Second.zip");
const thirdFile = path.join(collectionDirectory, "Archive Third.zip");
const mergeFile = path.join(collectionDirectory, "Archive Merge.zip");
const createLegacyId = (prefix, value) => `${prefix}_${Buffer.from(value).toString("base64url")}`;
const gallery = createImageGalleryDbService({ dbPath: path.join(temp.tempDir, "gallery.sqlite"), ensureDataDir: () => {} });

try {
  fs.mkdirSync(collectionDirectory, { recursive: true });
  fs.writeFileSync(firstFile, "synthetic archive bytes");
  fs.writeFileSync(secondFile, "different synthetic archive bytes");
  fs.writeFileSync(thirdFile, "third synthetic archive bytes");
  fs.writeFileSync(mergeFile, "merge synthetic archive bytes");
  const index = createImageLibraryIndexService({
    archiveExts: new Set([".zip"]), createId: createLegacyId, directVideoExts: new Set(),
    galleryMediaSources: [], isExcludedDirName: () => false,
    isVideo: () => false, normalizeExt: name => path.extname(name).toLowerCase(), photoSetCoverUrl: () => "",
    photoSetRoots: [media], safeStat: value => fs.statSync(value, { throwIfNoEntry: false })
  });
  const firstId = createLegacyId("ps", firstFile);
  const secondId = createLegacyId("ps", secondFile);
  const thirdId = createLegacyId("ps", thirdFile);
  const mergeArchiveId = createLegacyId("ps", mergeFile);
  assert.equal(index.photoSetById(firstId).personName, "推断人物");
  let sequence = 0;
  let canonicalId = "7";
  const serviceOptions = {
    getImageGalleryDb: gallery.getDb, photoSetById: index.photoSetById,
    resolvePersonId: value => value === "99" ? { id: canonicalId, displayName: "已确认人物" } : null,
    createId: () => `pw_fixture-${++sequence}`, now: () => "2026-11-07T00:00:00.000Z"
  };
  const catalog = createPhotoCatalogService(serviceOptions);
  const db = gallery.getDb();
  const seedImageCount = (file, imageCount, identity) => {
    const stamp = archiveDiskSignature(file, fs.statSync(file));
    db.prepare(`INSERT OR REPLACE INTO photo_set_image_indexes(archive_path,archive_size,archive_mtime_ms,
      archive_identity,image_count,images_json,indexer_version,indexed_at,updated_at) VALUES (?,?,?,?,?,'[]',?,?,?)`)
      .run(stamp.archivePath, stamp.archiveSize, stamp.archiveMtimeMs, identity ?? stamp.archiveIdentity,
        imageCount, ARCHIVE_IMAGE_INDEXER_VERSION, serviceOptions.now(), serviceOptions.now());
  };
  seedImageCount(firstFile, 7);
  seedImageCount(secondFile, 999, "previous archive generation");

  const commit = (preview, requestId, service = catalog) => service.confirm({
    plan: preview.plan, confirmationToken: preview.confirmationToken, requestId
  });
  const invalid = { code: "PHOTO_CATALOG_INVALID", statusCode: 400 };
  const stale = { code: "PHOTO_CATALOG_STALE", statusCode: 409 };
  assert.throws(() => catalog.preview({ title: "Missing anchors" }), invalid);
  assert.throws(() => catalog.preview({ sources: [{ provider: "demo", externalId: "1", url: "file:///secret" }] }), invalid);
  assert.throws(() => catalog.preview({ sources: [{ provider: "demo", externalId: "1", declaredImageCount: -1 }] }), invalid);
  assert.throws(() => catalog.preview({ archiveIds: [firstId], releaseDate: "2026-02-29" }), invalid);
  assert.deepEqual(catalog.preview({ archiveIds: ["../outside.zip"] }).conflicts, [{ code: "archive-not-found", id: "../outside.zip" }]);
  assert.deepEqual(catalog.preview({ archiveIds: [firstId], people: [{ personId: "missing" }] }).conflicts, [
    { code: "person-not-found", id: "missing" }
  ]);

  const source = { provider: "DEMO", externalId: "001", title: "Source title", url: "https://example.invalid/issue/1",
    issueCode: "113", issueLabel: "113-2",
    declaredImageCount: 50, declaredVideoCount: 0, declaredSizeLabel: "400 MB", releaseDate: "2024-01-01",
    metadata: { z: 0, a: "imported" } };
  const collection = { name: "合集 A", provider: "demo", externalId: "A", declaredCount: 20,
    url: "https://example.invalid/collection/A", issueListUrl: "https://example.invalid/collection/A/issues",
    declaredCountLabel: "约 20 套", declaredImageCount: 300, declaredVideoCount: 2, declaredSizeLabel: "4 GB" };
  const draft = catalog.preview({ archiveIds: [firstId], issueCode: "No. 001", sources: [source], collections: [collection],
    people: [{ personId: 99 }, { name: "独立人物" }, { personId: 99, role: "photographer" }] });
  assert.equal(draft.plan.workId, "");
  assert.deepEqual(draft.candidates, []);
  assert.deepEqual(draft.conflicts, []);
  assert.deepEqual(draft.personCandidates, ["推断人物"]);
  assert.equal(draft.archives[0].measuredImageCount, 7);
  assert.equal(draft.archives[0].size, fs.statSync(firstFile).size);
  assert.equal(draft.archives[0].coverUrl.includes(encodeURIComponent(firstId)), true);
  assert.equal(JSON.stringify(draft).includes(temp.tempDir), false, "no raw root or absolute path in the public preview");
  assert.deepEqual(catalog.list().counts, { local: 0, source: 0 });
  assert.throws(() => commit({ ...draft, plan: { ...draft.plan, title: "Tampered" } }, "tampered"), stale);
  canonicalId = "8";
  assert.throws(() => commit(draft, "identity-changed"), stale);
  canonicalId = "7";

  const result = commit(draft, "create-first");
  const id = result.work.id;
  assert.equal(result.replayed, false);
  assert.match(id, /^pw_/u);
  assert.deepEqual(catalog.detail(firstId), result.work, "the existing archive id locates the stable work");
  assert.equal(result.work.title, "Source title");
  assert.deepEqual(result.work.fieldSources, { title: "source:demo", issueCode: "manual", releaseDate: "" });
  assert.equal(result.work.releaseDate, "", "the source date remains a declaration until confirmed as the work date");
  assert.equal(result.work.sources[0].releaseDate, source.releaseDate);
  assert.equal(result.work.sources[0].issueCode, "113");
  assert.equal(result.work.sources[0].issueLabel, "113-2");
  assert.equal(result.work.sources[0].declaredImageCount, 50);
  assert.equal(result.work.sources[0].declaredVideoCount, 0);
  assert.equal(result.work.measuredImageCount, 7);
  assert.deepEqual(result.work.collections, [collection]);
  assert.deepEqual(result.work.people, [
    { personId: "7", name: "已确认人物", role: "model" },
    { personId: "", name: "独立人物", role: "model" },
    { personId: "7", name: "已确认人物", role: "photographer" }
  ]);
  assert.deepEqual(commit(draft, "create-first"), { work: result.work, replayed: true });
  assert.throws(() => commit({ ...draft, plan: { ...draft.plan, title: "Other" } }, "create-first"), {
    code: "PHOTO_CATALOG_REQUEST_CONFLICT", statusCode: 409
  });

  const sourceUpdate = catalog.preview({ title: "人工标题", releaseDate: "2025-05-01", sources: [{ provider: "demo", externalId: "001", title: "Updated source" }] });
  assert.equal(sourceUpdate.plan.workId, id, "an exact owned source preselects its work");
  assert.deepEqual(sourceUpdate.candidates[0].reasons, ["source"]);
  const manual = commit(sourceUpdate, "source-refresh").work;
  assert.equal(manual.archives[0].id, firstId, "source-only refresh keeps existing local bindings");
  assert.equal(manual.sources[0].declaredSizeLabel, "400 MB");
  assert.equal(manual.title, "人工标题");
  assert.equal(manual.releaseDate, "2025-05-01");

  const duplicateIssue = catalog.preview({ archiveIds: [secondId], issueCode: "NO. 001" });
  assert.equal(duplicateIssue.plan.workId, "");
  assert.deepEqual(duplicateIssue.candidates.map(row => [row.id, row.reasons]), [[id, ["issue-code"]]]);
  assert.equal(duplicateIssue.archives[0].measuredImageCount, null, "stale cached counts are excluded");
  fs.appendFileSync(secondFile, " changed after preview");
  assert.throws(() => commit(duplicateIssue, "create-second"), stale);
  const other = commit(catalog.preview(duplicateIssue.plan), "create-second").work;
  assert.notEqual(other.id, id, "same issue code does not merge distinct works");
  assert.equal(other.measuredImageCount, null);
  assert.equal(other.fieldSources.title, "archive");
  seedImageCount(secondFile, 13);
  assert.equal(catalog.detail(secondId).measuredImageCount, 13, "a cache fill becomes visible without changing the directory row");
  assert.equal(catalog.list({ scope: "local" }).items.find(row => row.id === other.id).measuredImageCount, 13);
  const attachSource = catalog.preview({ workId: other.id, suggestedIssueCode: "Filename", sources: [{
    provider: "demo", externalId: "002", title: "Confirmed external title", issueCode: "Source issue"
  }] });
  const attached = commit(attachSource, "attach-source").work;
  assert.equal(attached.title, "Confirmed external title");
  assert.equal(attached.issueCode, "NO. 001", "an existing issue code survives a newly attached source");
  assert.equal(catalog.preview({ archiveIds: [firstId] }).plan.workId, id);
  const collision = catalog.preview({ archiveIds: [secondId], sources: [source] });
  assert.deepEqual(collision.conflicts.map(row => row.code), ["archive-owned", "source-owned"]);
  assert.equal(collision.confirmationToken, "");
  assert.equal(catalog.preview({ workId: id, archiveIds: [secondId] }).conflicts[0].workId, other.id);

  const standalone = commit(catalog.preview({
    suggestedIssueCode: "Filename suggestion",
    sources: [{ provider: "demo", externalId: "003", title: "Standalone source", issueCode: "Confirmed source issue" }], collections: [collection]
  }), "create-standalone").work;
  assert.equal(standalone.measuredSize, null);
  assert.equal(standalone.measuredImageCount, null);
  assert.equal(standalone.issueCode, "Confirmed source issue");
  assert.equal(standalone.fieldSources.issueCode, "source:demo");
  const all = catalog.list({ limit: 1 });
  assert.equal(all.total, 3);
  assert.equal(all.items.length, 1);
  assert.deepEqual(all.counts, { local: 2, source: 3 });
  assert.deepEqual(all.facets.people.map(row => [row.name, row.count]), [["已确认人物", 1], ["独立人物", 1]]);
  const selected = catalog.list({ collection: all.facets.collections[0].key, scope: "local" });
  assert.deepEqual(selected.counts, { local: 1, source: 2 });
  assert.deepEqual(selected.items.map(row => row.id), [id]);
  assert.deepEqual(catalog.list({ q: "UPDATED source", person: all.facets.people[0].key, scope: "source" }).items.map(row => row.id), [id]);
  assert.equal(catalog.list({ scope: "source", offset: 50 }).total, 3);
  assert.deepEqual(catalog.list({ scope: "source", offset: 50 }).items, []);

  const extraArchive = catalog.preview({ workId: id, archiveIds: [thirdId] });
  assert.equal(extraArchive.archives[0].measuredImageCount, null);
  seedImageCount(thirdFile, 5);
  const withExtraArchive = commit(extraArchive, "attach-extra-archive").work;
  assert.deepEqual(withExtraArchive.archives.map(row => row.id), [firstId, thirdId]);
  assert.equal(withExtraArchive.measuredImageCount, 12, "an index fill between preview and confirm adds the new measured count");
  assert.equal(withExtraArchive.measuredSize, fs.statSync(firstFile).size + fs.statSync(thirdFile).size);

  const earlierEdit = catalog.preview({ workId: id, title: "Earlier" });
  commit(catalog.preview({ workId: id, title: "Later" }), "later-edit");
  assert.throws(() => commit(earlierEdit, "earlier-edit"), stale);
  const rollback = catalog.preview({ workId: id, title: "Should roll back", sources: [{ provider: "demo", externalId: "rejected" }] });
  db.exec(`CREATE TRIGGER catalog_fixture_rollback BEFORE INSERT ON photo_catalog_sources WHEN NEW.external_id='rejected'
    BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`);
  assert.throws(() => commit(rollback, "recoverable"), /fixture rollback/u);
  assert.equal(catalog.detail(id).title, "Later");
  assert.equal(db.prepare("SELECT count(*) AS n FROM photo_catalog_receipts WHERE request_id='recoverable'").get().n, 0);
  db.exec("DROP TRIGGER catalog_fixture_rollback");
  assert.equal(commit(rollback, "recoverable").work.title, "Should roll back");

  const localDraft = catalog.preview({ archiveIds: [mergeArchiveId], title: "Manual local title", issueCode: "Local Issue",
    collections: [{ name: collection.name, provider: collection.provider, externalId: collection.externalId }],
    people: [{ name: "Local model" }] });
  const donorSources = [{ provider: "demo", externalId: "merge-donor", issueCode: "Source Issue" }, { provider: "other", externalId: "extra-donor" }];
  const donorDraft = catalog.preview({ sources: donorSources, title: "Manual donor title", issueCode: "Donor Issue", releaseDate: "2025-08-02",
    collections: [collection], people: [{ name: "Local model" }, { name: "Donor model" }] });
  const local = commit(localDraft, "make-local").work;
  const donor = commit(donorDraft, "make-donor").work;
  const selectedPair = { archiveIds: [mergeArchiveId], sources: [donorSources[0]] };
  assert.equal(catalog.preview(selectedPair).confirmationToken, "", "ordinary confirmation never merges separately owned works");
  const pair = { ...selectedPair, mergeWorkIds: [local.id, donor.id] };
  const needChoice = catalog.preview(pair);
  assert.deepEqual(needChoice.merge.target, { id: local.id, title: local.title, issueCode: local.issueCode,
    releaseDate: local.releaseDate, fieldSources: local.fieldSources });
  assert.deepEqual(needChoice.conflicts.map(row => [row.code, row.id]), [["merge-field-conflict", "title"], ["merge-field-conflict", "issueCode"]]);
  assert.equal(needChoice.confirmationToken, "");
  const chosenPair = { ...pair, title: "Chosen title", issueCode: "Chosen issue" };
  commit(catalog.preview({ workId: local.id, releaseDate: "2025-08-04" }), "set-local-date");
  assert.deepEqual(catalog.preview(chosenPair).conflicts.map(row => row.id), ["releaseDate"]);
  assert.deepEqual(catalog.preview({ ...chosenPair, releaseDate: "2025-08-05" }).conflicts, []);
  commit(catalog.preview({ workId: local.id, releaseDate: "" }), "clear-local-date");
  const pendingMerge = catalog.preview(chosenPair);
  assert.equal(pendingMerge.plan.workId, local.id);
  commit(catalog.preview({ workId: donor.id, releaseDate: "2025-08-03" }), "refresh-donor");
  assert.throws(() => commit(pendingMerge, "merge-pair"), stale, "both work revisions participate in confirmation");
  assert.equal(catalog.preview({ ...chosenPair, mergeWorkIds: [id, donor.id], archiveIds: [firstId] }).conflicts[0].code, "merge-target-has-source");
  assert.equal(catalog.preview({ ...chosenPair, mergeWorkIds: [local.id, other.id], sources: [{ provider: "demo", externalId: "002" }] }).conflicts[0].code, "merge-donor-has-archive");
  assert.equal(catalog.preview({ ...chosenPair, sources: [{ provider: "demo", externalId: "unowned" }] }).conflicts[0].code, "merge-source-unbound");
  const freshMerge = catalog.preview(chosenPair);
  db.exec(`CREATE TRIGGER catalog_merge_fixture_rollback BEFORE INSERT ON photo_catalog_receipts WHEN NEW.request_id='merge-pair'
    BEGIN SELECT RAISE(ABORT, 'fixture merge rollback'); END`);
  assert.throws(() => commit(freshMerge, "merge-pair"), /fixture merge rollback/u);
  assert.equal(catalog.detail(donor.id).id, donor.id, "rollback retains donor ownership and its identity");
  assert.deepEqual(catalog.detail(local.id).sources, []);
  db.exec("DROP TRIGGER catalog_merge_fixture_rollback");
  const mergeResult = commit(freshMerge, "merge-pair");
  assert.equal(mergeResult.work.id, local.id);
  assert.equal(mergeResult.work.title, "Chosen title");
  assert.equal(mergeResult.work.issueCode, "Chosen issue");
  assert.equal(mergeResult.work.releaseDate, "2025-08-03", "preserve the donor date when the recipient has none");
  assert.deepEqual(mergeResult.work.people.map(row => row.name), ["Local model", "Donor model"]);
  assert.deepEqual(mergeResult.work.collections, [collection]);
  assert.deepEqual(mergeResult.work.sources.map(row => row.externalId), ["merge-donor", "extra-donor"]);
  assert.deepEqual(catalog.detail(donor.id), mergeResult.work);
  assert.deepEqual(catalog.detail(mergeArchiveId), mergeResult.work);
  assert.equal(catalog.list({ q: "Chosen title" }).total, 1);
  assert.deepEqual(commit(freshMerge, "merge-pair"), { work: mergeResult.work, replayed: true });

  const offline = createPhotoCatalogService({ ...serviceOptions, photoSetById() { throw new Error("bulk seed must not load the scan or media"); } });
  const offlineCollection = { provider: "local", externalId: "offline-group", name: "离线合集" };
  const makeSeed = (archiveName, category, size) => {
    const archivePath = path.join(media, category, archiveName);
    return {
      archive: { id: createLegacyId("ps", archivePath), title: path.basename(archiveName, ".zip"), category,
        relativePath: path.join(category, archiveName), rootLabel: "fixture", archiveExt: "zip", size, modifiedAt: serviceOptions.now(),
        coverUrl: "https://not-used.invalid/", personHint: "候选人物", issueHint: "NO.12" },
      collection: offlineCollection, suggestedIssueCode: "VOL.12"
    };
  };
  const seedOne = makeSeed("No disk check.zip", "离线分类", 200);
  const seedTwo = makeSeed("Reader cache.zip", "读图分类", 300);
  seedOne.archive.declaredImageCount = 20;
  seedOne.archive.declaredVideoCount = 0;
  seedTwo.archive.declaredVideoCount = 2;
  const secondSeedPath = path.join(media, seedTwo.archive.relativePath);
  const secondSeedStamp = archiveDiskSignature(secondSeedPath, {
    isFile: () => true, mtimeMs: Date.parse(seedTwo.archive.modifiedAt) + 0.625, size: seedTwo.archive.size, dev: "fixture-device", ino: "fixture-file"
  });
  seedTwo.archive.archivePath = secondSeedPath;
  seedTwo.archive.archiveIdentity = secondSeedStamp.archiveIdentity;
  db.prepare(`INSERT INTO photo_set_image_indexes(archive_path,archive_size,archive_mtime_ms,archive_identity,image_count,
    images_json,indexer_version,indexed_at,updated_at) VALUES (?,?,?,?,9,'[]',?,?,?)`)
    .run(secondSeedPath, seedTwo.archive.size, secondSeedStamp.archiveMtimeMs, secondSeedStamp.archiveIdentity,
      ARCHIVE_IMAGE_INDEXER_VERSION, serviceOptions.now(), serviceOptions.now());
  const original = offline.stats();
  const receiptCount = db.prepare("SELECT count(*) AS n FROM photo_catalog_receipts");
  const beforeSeedReceipts = receiptCount.get().n;
  assert.deepEqual(offline.seedScannedArchives([seedOne, { archive: { id: firstId } }, seedTwo, seedOne]), { inserted: 2, skipped: 2 });
  assert.deepEqual(offline.seedScannedArchives([seedOne, seedTwo]), { inserted: 0, skipped: 2 });
  assert.equal(receiptCount.get().n, beforeSeedReceipts);
  const seededOne = offline.detail(seedOne.archive.id), seededTwo = offline.detail(seedTwo.archive.id);
  assert.notEqual(seededOne.id, seededTwo.id, "a shared issue never collapses separately indexed archives");
  assert.deepEqual(seededOne.fieldSources, { title: "archive", issueCode: "archive", releaseDate: "" });
  assert.equal(seededOne.archives[0].personHint, "候选人物");
  assert.equal(seededOne.archives[0].issueHint, "NO.12");
  assert.equal(seededOne.archives[0].declaredImageCount, 20);
  assert.equal(seededOne.archives[0].declaredVideoCount, 0);
  assert.equal(seededOne.archives[0].scanMtimeMs, undefined);
  assert.match(seededOne.archives[0].coverUrl, /^\/media\/gallery-cover\//u);
  assert.equal(seededOne.measuredImageCount, null);
  assert.equal(seededTwo.measuredImageCount, 9);
  const firstSeedPath = path.join(media, seedOne.archive.relativePath);
  const firstSeedTime = Date.parse(seedOne.archive.modifiedAt);
  const saveReadIndex = db.prepare(`INSERT OR REPLACE INTO photo_set_image_indexes(archive_path,archive_size,archive_mtime_ms,archive_identity,image_count,
    images_json,indexer_version,indexed_at,updated_at) VALUES (?,?,?,?,5,'[]',?,?,?)`);
  const publishCount = (size, mtimeMs) => {
    const stamp = archiveDiskSignature(firstSeedPath, { isFile: () => true, mtimeMs, size, dev: "fixture", ino: "late-read" });
    saveReadIndex.run(firstSeedPath, size, mtimeMs, stamp.archiveIdentity,
      ARCHIVE_IMAGE_INDEXER_VERSION, serviceOptions.now(), serviceOptions.now());
  };
  publishCount(199, firstSeedTime + 0.5);
  assert.equal(offline.detail(seedOne.archive.id).measuredImageCount, null);
  publishCount(200, firstSeedTime + 1.5);
  assert.equal(offline.detail(seedOne.archive.id).measuredImageCount, null);
  publishCount(200, firstSeedTime + 0.5);
  assert.equal(offline.detail(seedOne.archive.id).measuredImageCount, 5);
  assert.deepEqual(seededOne.people, []);
  assert.equal(offline.detail(firstId).title, "Should roll back", "batch registration preserves existing manual works and their sources");
  assert.equal(offline.list({ category: "离线分类" }).total, 1);
  assert.equal(offline.list({ category: "离线分类" }).items[0].id, seededOne.id);
  assert.equal(offline.list({ category: "离线分类" }).facets.categories.find(row => row.key === "读图分类").count, 1);
  const seedStats = offline.stats();
  assert.equal(seedStats.works, original.works + 2);
  assert.equal(seedStats.archives, original.archives + 2);
  assert.equal(seedStats.bytes, original.bytes + 500);
  assert.equal(seedStats.collections, original.collections + 1);
  assert.equal(seedStats.withIssue, original.withIssue + 2);
  assert.equal(seedStats.withPeople, original.withPeople);
  assert.equal(seedStats.measuredArchives, original.measuredArchives + 2);
  assert.equal(seedStats.measuredImages, original.measuredImages + 14);
  assert.equal(seedStats.declaredImageArchives, original.declaredImageArchives + 1);
  assert.equal(seedStats.declaredImages, original.declaredImages + 20);
  assert.equal(seedStats.declaredVideoArchives, original.declaredVideoArchives + 2);
  assert.equal(seedStats.declaredVideos, original.declaredVideos + 2);
  assert.equal(seedStats.personHintArchives, original.personHintArchives + 2);
  assert.deepEqual(seedStats.categories.find(row => row.key === "离线分类"), { key: "离线分类", name: "离线分类", works: 1, archives: 1, bytes: 200 });
  const shouldRollback = makeSeed("Rollback.zip", "离线分类", 100);
  const mismatched = makeSeed("Mismatch.zip", "离线分类", 900);
  mismatched.archive.archiveIdentity = secondSeedStamp.archiveIdentity;
  assert.throws(() => offline.seedScannedArchives([shouldRollback, mismatched]), invalid);
  assert.equal(offline.detail(shouldRollback.archive.id), null);
  assert.deepEqual(offline.stats(), seedStats);
  assert.throws(() => offline.seedScannedArchives(Array.from({ length: 401 }, () => seedOne)), invalid);

  gallery.close();
  const reopened = createPhotoCatalogService(serviceOptions);
  assert.equal(reopened.detail(firstId).id, id);
  assert.deepEqual(commit(draft, "create-first", reopened), { work: result.work, replayed: true });
  assert.equal(reopened.detail(donor.id).id, local.id);
  assert.deepEqual(commit(freshMerge, "merge-pair", reopened), { work: mergeResult.work, replayed: true });
  assert.equal(reopened.detail(id).title, "Should roll back");
  assert.deepEqual(reopened.stats(), seedStats);
  console.log("photo catalog store verification passed");
} finally {
  gallery.close();
  temp.cleanup();
}
