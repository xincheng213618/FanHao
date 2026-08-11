import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createAdminCoreMutationService } from "../src/modules/fanhao/server/admin/admin-core-mutation-service.js";
import { createCrossStoreOutboxService } from "../src/modules/fanhao/server/library/cross-store-outbox-service.js";
import { ACTOR_PROFILE_CACHE_TABLES } from "../src/modules/fanhao/server/library/cache-contracts.js";
import { readTableStampRow } from "../src/modules/fanhao/server/library/table-stamp-query.js";
import { createActorProfileService } from "../src/modules/fanhao/server/people/actor-profile-service.js";
import { createPersonDetailService } from "../src/modules/fanhao/server/people/person-detail-service.js";
import { createManualCoverStateService } from "../src/modules/fanhao/server/works/manual-cover-state-service.js";
import { createWorkImageService } from "../src/modules/fanhao/server/works/image-service.js";
import { createWorkPresenterService } from "../src/modules/fanhao/server/works/presenter-service.js";
import { routeWorksApi } from "../src/modules/fanhao/server/works/routes-api.js";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { saveActorProfileRequest } from "../public/modules/fanhao/person-profile.js";
import { createVerifiedTempDir, removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cross_store_staging_fault_child.mjs");
const MEDIA_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "actor_profile_media_probe_child.mjs");

function createFixture(name) {
  const temporary = createVerifiedTempDir(`fanhao-actor-staging-${name}-`);
  const mainDbPath = path.join(temporary.tempDir, "main.sqlite");
  const imageDbPath = path.join(temporary.tempDir, "images.sqlite");
  const db = new DatabaseSync(mainDbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE people (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_search TEXT NOT NULL,
      display_name TEXT, folder_path TEXT, gender TEXT NOT NULL DEFAULT 'unknown',
      movie_count INTEGER, status TEXT NOT NULL DEFAULT 'ok', error TEXT,
      source TEXT NOT NULL DEFAULT 'migration', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE person_external_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, provider TEXT NOT NULL,
      external_key TEXT NOT NULL, url TEXT, source TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(provider, external_key)
    );
    CREATE TABLE person_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, alias TEXT NOT NULL,
      alias_search TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '',
      UNIQUE(person_id, alias_search, source)
    );
    INSERT INTO people VALUES
      (1, 'Actor One', 'actorone', 'Actor One', NULL, 'unknown', 1, 'ok', NULL, 'migration', 'old', 'old'),
      (2, 'Actor Two', 'actortwo', 'Actor Two', NULL, 'unknown', 2, 'ok', NULL, 'migration', 'old', 'old'),
      (3, 'Actor Three', 'actorthree', 'Actor Three', NULL, 'unknown', 3, 'ok', NULL, 'migration', 'old', 'old'),
      (4, 'Actor Four', 'actorfour', 'Actor Four', NULL, 'unknown', 4, 'ok', NULL, 'migration', 'old', 'old'),
      (5, 'Actor Five', 'actorfive', 'Actor Five', NULL, 'unknown', 5, 'ok', NULL, 'migration', 'old', 'old');
    INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
      VALUES (2, 'javdb-actor', 'shared-owner', 'https://javdb.test/actors/shared-owner', 'fixture', 'old', 'old');
  `);
  attachCoreImageStore(db, { dbPath: imageDbPath });
  db.prepare(`
    INSERT INTO fanhao_images.images(
      owner_type, owner_id, kind, source_type, remote_url, mime, image_blob, byte_size,
      sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
    ) VALUES ('person', 1, 'avatar', 'unknown', '', 'image/legacy', ?, ?, 0, 'ok',
      'actor_profiles', 'fixture', 'legacy-one', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
  `).run(Buffer.from("old-avatar"), Buffer.byteLength("old-avatar"));
  const insertOrderingAvatar = db.prepare(`
    INSERT INTO fanhao_images.images(
      id, owner_type, owner_id, kind, source_type, remote_url, mime, image_blob, byte_size,
      sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
    ) VALUES (?, 'person', 2, 'avatar', 'unknown', ?, 'image/edge', ?, ?, 0, 'ok',
      'actor_profiles', 'fixture', ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
  `);
  insertOrderingAvatar.run(2, "edge-two", Buffer.from("edge-id-two"), Buffer.byteLength("edge-id-two"), "edge-two");
  insertOrderingAvatar.run(10, "edge-ten", Buffer.from("edge-id-ten"), Buffer.byteLength("edge-id-ten"), "edge-ten");
  return { ...temporary, db, mainDbPath, imageDbPath };
}

function actorIdFromUrl(url) {
  return String(url || "").split("/").filter(Boolean).pop() || "";
}

function uniqueNames(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function createRuntime(fixture) {
  let cacheVersion = 0;
  let outbox = null;
  let failMain = false;
  const openedOutboxConnections = [];
  const invalidations = [];
  const getCoreDb = () => fixture.db;
  const workImages = createWorkImageService({
    getCoreDb,
    getPersonById: () => null,
    getStamp: () => String(cacheVersion),
    getWorkById: () => null,
    hasCoreDb: () => true,
    proxiedRemoteImageUrl: (url) => String(url || "")
  });
  let actorProfiles = null;
  const parseAliases = (row) => {
    try { return JSON.parse(row?.aliases_json || "[]") || []; } catch { return []; }
  };
  const parseRefs = (row) => {
    try { return JSON.parse(row?.javdb_refs_json || "[]") || []; } catch { return []; }
  };
  actorProfiles = createActorProfileService({
    actorProfileAliases: parseAliases,
    actorProfileJavdbRefs: parseRefs,
    coreImageUrl: workImages.coreImageUrl,
    getCoreDb,
    getStamp: () => String(cacheVersion),
    mergedPersonAliasNames: () => [],
    normalizePersonGender: (value) => String(value || "unknown"),
    preferredPersonDisplayName: (row, fallback) => row?.display_name || row?.person_name || fallback || "",
    uniquePersonNames: uniqueNames
  });
  const invalidate = (name) => {
    invalidations.push(name);
    cacheVersion += 1;
    actorProfiles.invalidate();
    workImages.invalidate();
  };
  const publicActorProfile = (row) => actorProfiles.publicProfile(row);
  const admin = createAdminCoreMutationService({
    actorIdFromJavdbUrl: actorIdFromUrl,
    actorProfileRow: (personId) => actorProfiles.row(String(personId)),
    canonicalJavdbActorUrl: (value) => String(value || "").trim(),
    canonicalJavdbActorUrls: (values) => uniqueNames(Array.isArray(values) ? values : [values]),
    cleanPersonNamePart: (value) => String(value || "").trim(),
    getActorProfileOutboxService: () => outbox,
    getCoreDb,
    hasCoreDb: () => true,
    invalidateActorMovies: () => invalidate("movies"),
    invalidateActorProfiles: () => invalidate("profiles"),
    invalidatePersonMerge: () => invalidate("merge"),
    invalidateTableStamp: () => invalidate("stamp"),
    normalizePersonGender: (value) => String(value || "unknown"),
    normalizePersonSearchValue: (value) => String(value || "").toLowerCase().replaceAll(" ", ""),
    publicActorProfile,
    uniquePersonNames: uniqueNames,
    uniqueTextArray: uniqueNames
  });
  outbox = createCrossStoreOutboxService({
    autoReconcile: false,
    busyTimeoutMs: 25,
    createDatabase(filePath) {
      const connection = new DatabaseSync(filePath);
      openedOutboxConnections.push(connection);
      return connection;
    },
    handlers: {
      actor_profile_upsert: {
        applyMain(db, payload, context) {
          if (failMain) throw new Error("deterministic main fixture failure");
          return admin.applyActorProfileMain(db, payload, context);
        },
        assertCanPrepare: admin.assertActorProfileMutationPreparation,
        onCompleted: admin.publishActorProfileMutation,
        reservationKeys: admin.actorProfileReservationKeys,
        stageImage: admin.stageActorProfileImage,
        verifyImageStage: admin.verifyActorProfileImageStage,
        verifyMain: admin.verifyActorProfileMainProjection
      }
    },
    imageDbPath: fixture.imageDbPath,
    leaseMs: 100,
    mainDbPath: fixture.mainDbPath,
    retryDelayMs: 0,
    warn: () => {}
  });
  const people = new Map([1, 2, 3, 4, 5].map((id) => [String(id), { id: String(id), name: `Actor ${["One", "Two", "Three", "Four", "Five"][id - 1]}`, gender: "unknown" }]));
  const detail = createPersonDetailService({
    actorProfileMergeCandidates: () => [],
    actorProfileRow: (personId) => actorProfiles.row(String(personId)),
    adminCoreMutationService: admin,
    publicActorProfile,
    resolveLibraryPersonByPublicId: (personId) => people.get(String(personId)) || null
  });
  const manualCover = createManualCoverStateService({
    getCoreDb,
    invalidateActorProfiles: () => invalidate("manual-profile")
  });
  return {
    actorProfiles,
    admin,
    detail,
    invalidations,
    manualCover,
    openedOutboxConnections,
    outbox,
    people,
    setFailMain(value) { failMain = Boolean(value); },
    snapshot(personId = 1) {
      actorProfiles.invalidate();
      workImages.invalidate();
      const row = actorProfiles.row(String(personId));
      const snapshot = actorProfiles.publicSnapshot(row);
      const avatarRow = workImages.corePersonAvatarRow(personId);
      return {
        profileJson: JSON.stringify(snapshot.profile),
        avatarJson: JSON.stringify(snapshot.avatar),
        avatarBytes: Buffer.from(avatarRow?.image_blob || [])
      };
    },
    workImages
  };
}

async function verifyRealActorProtocol({ cleanup = true, announce = false } = {}) {
  const fixture = createFixture("real");
  if (announce) console.log(`REAL_TEMP ${fixture.tempDir}`);
  let holder = null;
  let runtime = null;
  try {
    runtime = createRuntime(fixture);
    const beforeSchema = runtime.snapshot(1);
    const beforeOrderingSchema = runtime.snapshot(2);
    runtime.outbox.start();
    assert.equal(runtime.openedOutboxConnections.length, 2);
    for (const connection of runtime.openedOutboxConnections) {
      assert.equal(connection.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(Number(connection.prepare("PRAGMA synchronous").get().synchronous), 2, "both dedicated outbox databases must use FULL durability");
    }
    const afterSchema = runtime.snapshot(1);
    const afterOrderingSchema = runtime.snapshot(2);
    assert.equal(afterSchema.profileJson, beforeSchema.profileJson, "adding the empty publication read model must preserve profile JSON bytes");
    assert.equal(afterSchema.avatarJson, beforeSchema.avatarJson, "adding the empty publication read model must preserve avatar JSON bytes");
    assert.ok(afterSchema.avatarBytes.equals(beforeSchema.avatarBytes), "adding the empty publication read model must preserve avatar bytes");
    assert.equal(afterOrderingSchema.profileJson, beforeOrderingSchema.profileJson, "empty publication tables must preserve numeric live-image tie ordering");
    assert.equal(afterOrderingSchema.avatarJson, beforeOrderingSchema.avatarJson, "empty publication tables must preserve edge-order avatar JSON");
    assert.ok(afterOrderingSchema.avatarBytes.equals(Buffer.from("edge-id-two")), "live image id 2 must continue to sort before id 10");
    assert.equal(ACTOR_PROFILE_CACHE_TABLES.includes("actor_profile_image_staging"), false, "invisible staging writes must not invalidate the public actor cache");
    assert.equal(ACTOR_PROFILE_CACHE_TABLES.includes("actor_profile_publications"), true, "the visibility pointer must invalidate the public actor cache");

    const intentsBeforeMainBusy = fixture.db.prepare("SELECT COUNT(*) AS count FROM cross_store_intents").get().count;
    holder = new DatabaseSync(fixture.mainDbPath);
    holder.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
    assert.throws(() => runtime.admin.upsertActorProfile(runtime.people.get("5"), {
      displayName: "Must Not Prepare While Main Busy",
      idempotencyKey: "main-busy-five",
      source: "manual"
    }), (error) => error.statusCode === 503 && error.retryable === true, "main-store BUSY must be retryable before any intent becomes visible");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM cross_store_intents").get().count, intentsBeforeMainBusy);
    assert.equal(fixture.db.prepare("SELECT display_name FROM people WHERE id = 5").get().display_name, "Actor Five");
    holder.exec("ROLLBACK");
    holder.close();
    holder = null;

    holder = new DatabaseSync(fixture.imageDbPath);
    holder.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
    const busy = runtime.admin.upsertActorProfile(runtime.people.get("3"), {
      avatarBase64: Buffer.from("busy-avatar").toString("base64"),
      displayName: "Actor Three Busy",
      idempotencyKey: "busy-three",
      source: "manual"
    });
    assert.equal(busy.completed, false);
    assert.equal(busy.operation.status, "retry_wait");
    assert.equal(fixture.db.prepare("SELECT display_name FROM people WHERE id = 3").get().display_name, "Actor Three");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM actor_profile_publications WHERE person_id = 3").get().count, 0);
    holder.exec("ROLLBACK");
    holder.close();
    holder = null;
    assert.equal(runtime.outbox.reconcilePending()[0].status, "completed");
    assert.equal(fixture.db.prepare("SELECT display_name FROM people WHERE id = 3").get().display_name, "Actor Three Busy");
    const completedHttp = runtime.detail.updateActorProfile("3", {
      displayName: "Actor Three HTTP 200",
      idempotencyKey: "three-http-completed",
      source: "manual"
    });
    assert.equal(completedHttp.statusCode, 200);
    assert.deepEqual(Object.keys(completedHttp.payload).sort(), ["mergeCandidates", "ok", "profile"]);
    assert.equal(completedHttp.payload.profile.displayName, "Actor Three HTTP 200");
    assert.equal(Object.hasOwn(completedHttp.payload, "operation"), false, "the legacy 200 payload must not acquire an operation envelope");

    runtime.setFailMain(true);
    let blockedError = null;
    try {
      runtime.admin.upsertActorProfile(runtime.people.get("1"), {
        aliases: ["One Alias"],
        avatarBase64: Buffer.from("blocked-avatar").toString("base64"),
        avatarMime: "image/blocked",
        displayName: "Actor One Blocked",
        idempotencyKey: "blocked-one",
        javdbUrls: ["https://javdb.test/actors/shared-owner"],
        source: "manual"
      });
    } catch (error) {
      blockedError = error;
    }
    assert.equal(blockedError?.operation?.status, "blocked");
    const blockedId = blockedError.operation.id;
    const blockedSnapshot = runtime.snapshot(1);
    assert.equal(blockedSnapshot.profileJson, beforeSchema.profileJson, "a deterministic main failure must keep the old profile byte-for-byte");
    assert.equal(blockedSnapshot.avatarJson, beforeSchema.avatarJson, "a blocked staged image must keep the old avatar JSON byte-for-byte");
    assert.ok(blockedSnapshot.avatarBytes.equals(Buffer.from("old-avatar")), "a blocked staged image must not reach media readers");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM actor_profile_publications WHERE person_id = 1").get().count, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.actor_profile_image_staging WHERE operation_id = ?").get(blockedId).count, 1);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM cross_store_aggregate_reservations WHERE op_id = ?").get(blockedId).count, 3, "target, actor key and current actor-key owner must be reserved atomically");
    assert.deepEqual(
      fixture.db.prepare("SELECT aggregate_key FROM cross_store_aggregate_reservations WHERE op_id = ? ORDER BY aggregate_key").all(blockedId).map((row) => row.aggregate_key),
      ["javdb-actor:shared-owner", "person-avatar:1", "person-avatar:2"]
    );
    assert.equal(Object.hasOwn(blockedError.operation, "aggregateKey"), false);
    assert.equal(Object.hasOwn(blockedError.operation, "lastError"), false);

    assert.throws(() => runtime.manualCover.replaceManualPersonAvatar(2, {
      sourceType: "local", localPath: "", remoteUrl: "", mime: "image/manual",
      blob: Buffer.from("must-not-write"), byteSize: 14, source: "manual_upload",
      legacyKey: "guard", now: new Date().toISOString()
    }), (error) => error.code === "ACTOR_PROFILE_RESERVED");
    assert.throws(() => runtime.admin.upsertActorProfile(runtime.people.get("3"), {
      displayName: "Must Not Steal",
      idempotencyKey: "same-actor-other-target",
      javdbUrls: ["https://javdb.test/actors/shared-owner"],
      source: "manual"
    }), (error) => error.statusCode === 409 && error.operation?.id === blockedId, "the actor-key reservation must fence another target");

    runtime.setFailMain(false);
    const recovered = runtime.outbox.retryOperation(blockedId);
    assert.equal(recovered.status, "completed");
    const completedSnapshot = runtime.snapshot(1);
    assert.equal(JSON.parse(completedSnapshot.profileJson).displayName, "Actor One Blocked");
    assert.ok(completedSnapshot.avatarBytes.equals(Buffer.from("blocked-avatar")));
    const publication = fixture.db.prepare("SELECT operation_id, intent_sha256 FROM actor_profile_publications WHERE person_id = 1").get();
    assert.equal(publication.operation_id, blockedId);
    assert.equal(fixture.db.prepare("SELECT status FROM cross_store_operation_state WHERE op_id = ?").get(blockedId).status, "completed");
    assert.equal(fixture.db.prepare("SELECT intent_sha256 FROM cross_store_main_receipts WHERE op_id = ? AND step = 'visibility_switch'").get(blockedId).intent_sha256, publication.intent_sha256);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM cross_store_aggregate_reservations WHERE op_id = ?").get(blockedId).count, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM cross_store_intent_blobs WHERE op_id = ?").get(blockedId).count, 0);

    runtime.manualCover.replaceManualPersonAvatar(1, {
      sourceType: "local", localPath: "", remoteUrl: "", mime: "image/manual",
      blob: Buffer.from("manual-override"), byteSize: Buffer.byteLength("manual-override"),
      source: "manual_upload", legacyKey: "manual-override", now: new Date().toISOString()
    });
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM actor_profile_publications WHERE person_id = 1").get().count, 0, "a later direct avatar writer must clear the old publication pointer");
    assert.ok(runtime.snapshot(1).avatarBytes.equals(Buffer.from("manual-override")));

    const stampBefore = readTableStampRow(fixture.db, "actor_profile_publications");
    const second = runtime.admin.upsertActorProfile(runtime.people.get("1"), {
      avatarBase64: Buffer.from("avatar-b").toString("base64"),
      avatarMime: "image/b",
      displayName: "Actor One B",
      idempotencyKey: "actor-one-b",
      source: "manual"
    });
    assert.equal(second.completed, true);
    const secondId = fixture.db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 1").get().operation_id;
    assert.notEqual(secondId, blockedId);
    assert.ok(runtime.snapshot(1).avatarBytes.equals(Buffer.from("avatar-b")), "a later outbox publication must replace an earlier direct override intentionally");
    const stampAfter = readTableStampRow(fixture.db, "actor_profile_publications");
    assert.notDeepEqual(stampAfter, stampBefore, "the public cache stamp must change only when the publication pointer changes");
    fixture.db.prepare(`
      INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
      VALUES (5, 'stamp-a', 'ignored', 'same-time', 'same-time')
    `).run();
    const sameTimeStampA = readTableStampRow(fixture.db, "actor_profile_publications");
    fixture.db.prepare("UPDATE actor_profile_publications SET operation_id = 'stamp-b' WHERE person_id = 5").run();
    const sameTimeStampB = readTableStampRow(fixture.db, "actor_profile_publications");
    assert.notDeepEqual(sameTimeStampB, sameTimeStampA, "the public cache stamp must include pointer identity even when wall-clock timestamps tie");
    fixture.db.prepare("DELETE FROM actor_profile_publications WHERE person_id = 5").run();

    const noAvatar = runtime.admin.upsertActorProfile(runtime.people.get("1"), {
      displayName: "Actor One No Avatar Change",
      idempotencyKey: "actor-one-no-avatar",
      source: "manual"
    });
    assert.equal(noAvatar.completed, true);
    assert.equal(fixture.db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 1").get().operation_id, secondId, "a profile-only update must retain the current image publication");
    assert.ok(runtime.snapshot(1).avatarBytes.equals(Buffer.from("avatar-b")));

    const aba = [];
    for (const value of ["avatar-a", "avatar-b-2", "avatar-a"]) {
      const result = runtime.admin.upsertActorProfile(runtime.people.get("1"), {
        avatarBase64: Buffer.from(value).toString("base64"),
        avatarMime: "image/aba",
        displayName: `Actor One ${value}`,
        source: "manual"
      });
      assert.equal(result.completed, true);
      aba.push(fixture.db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 1").get().operation_id);
    }
    assert.equal(new Set(aba).size, 3, "A -> B -> A without an explicit action key must create three ordered operations");
    assert.ok(runtime.snapshot(1).avatarBytes.equals(Buffer.from("avatar-a")));

    const idempotentBody = {
      avatarBase64: Buffer.from("idempotent-avatar").toString("base64"),
      avatarMime: "image/idempotent",
      displayName: "Actor One Idempotent",
      idempotencyKey: "actor-one-idempotent",
      source: "manual"
    };
    runtime.admin.upsertActorProfile(runtime.people.get("1"), idempotentBody);
    const idempotentId = fixture.db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 1").get().operation_id;
    runtime.admin.upsertActorProfile(runtime.people.get("1"), idempotentBody);
    assert.equal(fixture.db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 1").get().operation_id, idempotentId);
    assert.throws(() => runtime.admin.upsertActorProfile(runtime.people.get("1"), { ...idempotentBody, displayName: "Different" }), (error) => error.code === "IDEMPOTENCY_CONFLICT");

    const mediaProbe = await runMediaProbe(fixture, idempotentId);
    assert.equal(mediaProbe.bytes, "idempotent-avatar", "media worker must serve the immutable version named by the completed publication");
    assert.equal(mediaProbe.wrong, null, "media worker must reject an unknown or uncompleted version token");
    const historicalMediaProbe = await runMediaProbe(fixture, blockedId);
    assert.equal(historicalMediaProbe.bytes, "blocked-avatar", "a completed immutable media version must remain readable after a later publication becomes current");
    const inlineHistorical = await readInlineActorAvatar(fixture, blockedId);
    assert.equal(inlineHistorical.statusCode, 200);
    assert.equal(inlineHistorical.bytes, "blocked-avatar", "the inline media reader and a fresh worker must agree on historical completed versions");

    runtime.manualCover.replaceManualPersonAvatar(2, {
      sourceType: "local", localPath: "", remoteUrl: "", mime: "image/manual",
      blob: Buffer.from("manual-before-publication"), byteSize: Buffer.byteLength("manual-before-publication"),
      source: "manual_upload", legacyKey: "manual-before-publication", now: new Date().toISOString()
    });
    const fallback = runtime.admin.upsertActorProfile(runtime.people.get("2"), {
      avatarBase64: Buffer.from("published-actor-profile-fallback").toString("base64"),
      avatarMime: "image/fallback",
      displayName: "Actor Two Published Fallback",
      idempotencyKey: "actor-two-fallback",
      source: "actor_profiles"
    });
    assert.equal(fallback.completed, true);
    const fallbackPublication = fixture.db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 2").get().operation_id;
    assert.ok(runtime.snapshot(2).avatarBytes.equals(Buffer.from("manual-before-publication")), "a live manual avatar must retain precedence over a completed actor_profiles publication");
    runtime.manualCover.replaceManualPersonAvatar(2, null);
    assert.equal(fixture.db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 2").get().operation_id, fallbackPublication,
      "deleting a manual override must retain a lower-priority actor_profiles publication for fallback");
    assert.ok(runtime.snapshot(2).avatarBytes.equals(Buffer.from("published-actor-profile-fallback")), "manual deletion must reveal the published actor_profiles fallback");

    const asyncHolder = new DatabaseSync(fixture.imageDbPath);
    asyncHolder.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
    const accepted = runtime.detail.updateActorProfile("4", {
      acceptAsyncOperation: true,
      avatarBase64: Buffer.from("four").toString("base64"),
      displayName: "Actor Four Async",
      idempotencyKey: "four-async",
      source: "manual"
    });
    assert.equal(accepted.statusCode, 202, "only an opt-in client may receive a pending operation as 202");
    assert.equal(runtime.detail.actorProfileOperation(accepted.payload.operation.id).id, accepted.payload.operation.id);
    assert.throws(() => runtime.detail.updateActorProfile("4", {
      avatarBase64: Buffer.from("four").toString("base64"),
      displayName: "Actor Four Async",
      idempotencyKey: "four-async",
      source: "manual"
    }), (error) => error.statusCode === 503 && error.operation?.id === accepted.payload.operation.id,
    "the async opt-in transport flag must not change idempotency, while a legacy retry still receives 503");
    assert.throws(() => runtime.detail.updateActorProfile("5", {
      avatarBase64: Buffer.from("five").toString("base64"),
      displayName: "Actor Five Legacy",
      idempotencyKey: "five-legacy",
      source: "manual"
    }), (error) => error.statusCode === 503 && error.retryable === true && Boolean(error.operation), "a legacy client must receive retryable 503 instead of treating pending work as success");
    asyncHolder.exec("ROLLBACK");
    asyncHolder.close();
    runtime.outbox.reconcilePending();

    verifyPresenterUsesOneSnapshot();
    verifyCompletedPayloadEquivalence();
    verifyTerminalActorProfileContract();
    await verifyActorAvatarCacheContract();
    verifyLeaseTakeoverReceiptRecheck();
    await verifyActorProfileRouteAndNetworkContract();
  } finally {
    if (holder) {
      try { holder.exec("ROLLBACK"); } catch {}
      holder.close();
    }
    runtime?.outbox.close();
    fixture.db.close();
    if (cleanup) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      fixture.cleanup();
    }
  }
  return fixture.tempDir;
}

function runMediaProbe(fixture, operationId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MEDIA_CHILD, fixture.mainDbPath, fixture.imageDbPath, "1", operationId], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`media probe exited ${code}: ${errors}`));
      else {
        try { resolve(JSON.parse(output.trim())); }
        catch (error) { reject(new AggregateError([error], `invalid media probe output: ${output}`)); }
      }
    });
  });
}

async function readInlineActorAvatar(fixture, operationId) {
  const service = createMediaResponseService({
    coreImageRow: () => null,
    corePersonAvatarRow: () => null,
    getCoreDb: () => fixture.db,
    isAllowedRemoteImageUrl: () => false,
    maxRemoteImageBytes: 1,
    mimeTypes: {},
    normalizeExt: () => "",
    notFound(res) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end();
    },
    proxiedRemoteImageUrl: () => "",
    publicRemoteUrl: () => "",
    safeStat: () => null,
    sendText: (res, statusCode) => {
      res.writeHead(statusCode, {});
      res.end();
    },
    workCoverRow: () => null
  });
  let statusCode = 0;
  let bytes = Buffer.alloc(0);
  const response = {
    writeHead(status) { statusCode = Number(status); },
    end(body) { bytes = Buffer.from(body || []); }
  };
  await service.serveActorAvatar(response, 1, { version: operationId });
  return { bytes: bytes.toString(), statusCode };
}

async function verifyActorAvatarCacheContract() {
  let currentBytes = "published-stage";
  let currentReads = 0;
  let immutableBytes = "historical-stage";
  let immutableReads = 0;
  const service = createMediaResponseService({
    coreImageRow: () => null,
    corePersonAvatarRow: () => null,
    getCoreDb: () => null,
    isAllowedRemoteImageUrl: () => false,
    maxRemoteImageBytes: 1,
    mediaBlobStore: {
      async actorAvatar(_personId, version) {
        if (version) {
          immutableReads += 1;
          return { image_blob: Buffer.from(immutableBytes), mime: "image/test" };
        }
        currentReads += 1;
        return { image_blob: Buffer.from(currentBytes), mime: "image/test" };
      }
    },
    mimeTypes: {},
    normalizeExt: () => "",
    notFound: () => { throw new Error("unexpected not found"); },
    proxiedRemoteImageUrl: () => "",
    publicRemoteUrl: () => "",
    safeStat: () => null,
    sendText: () => { throw new Error("unexpected text response"); },
    workCoverRow: () => null
  });
  const read = async (version = "") => {
    let statusCode = 0;
    let headers = {};
    let bytes = Buffer.alloc(0);
    await service.serveActorAvatar({
      writeHead(status, nextHeaders) { statusCode = Number(status); headers = nextHeaders; },
      end(body) { bytes = Buffer.from(body || []); }
    }, 1, { version });
    return { bytes: bytes.toString(), cacheControl: headers["Cache-Control"], statusCode };
  };

  const publishedCurrent = await read();
  currentBytes = "manual-live";
  const manualCurrent = await read();
  assert.equal(publishedCurrent.bytes, "published-stage");
  assert.equal(manualCurrent.bytes, "manual-live", "the same media service must re-read an unversioned current avatar after a manual override");
  assert.equal(currentReads, 2, "unversioned current avatars must not enter the process media cache");
  assert.equal(manualCurrent.cacheControl, "no-store", "unversioned current avatar responses must not be pinned by a browser cache");

  const historical = await read("completed-op");
  immutableBytes = "must-not-replace-cached-history";
  const historicalAgain = await read("completed-op");
  assert.equal(historical.bytes, "historical-stage");
  assert.equal(historicalAgain.bytes, "historical-stage", "the completed immutable version may remain cached by its operation token");
  assert.equal(immutableReads, 1);
  assert.equal(historical.cacheControl, "public, max-age=31536000, immutable");
}

function verifyPresenterUsesOneSnapshot() {
  let separateAvatarReads = 0;
  const presenter = createWorkPresenterService({
    actorProfileRow: () => ({ person_id: "1", display_name: "old" }),
    favoriteStateService: { has: () => false },
    getLibrary: () => ({ worksById: new Map() }),
    isGPerson: () => false,
    localWorkMarkers: () => ({}),
    manualCoverStateService: { manualCoverForWork: () => null },
    playbackProgressService: { item: () => null },
    publicActorProfile: () => ({ displayName: "must-not-be-used" }),
    publicActorProfileSnapshot: () => ({
      profile: { displayName: "old" },
      avatar: { avatarUrl: "/media/actor/1/avatar?v=old", source: "manual" }
    }),
    publicPersonAvatar: () => {
      separateAvatarReads += 1;
      return { avatarUrl: "/media/actor/1/avatar?v=new" };
    },
    uniqueTextArray: uniqueNames
  });
  const result = presenter.publicPerson({ id: "1", name: "Actor One", works: [] }, { skipFallbackAvatar: true });
  assert.equal(result.actorProfile.displayName, "old");
  assert.equal(result.avatarUrl, "/media/actor/1/avatar?v=old");
  assert.equal(separateAvatarReads, 0, "presenter must not re-read the avatar after taking the actor-profile snapshot");
}

function verifyCompletedPayloadEquivalence() {
  const person = { id: "1", name: "Actor One" };
  const completedProfile = {
    personId: "1",
    displayName: "Shared Input",
    aliases: ["Shared Alias"]
  };
  let mode = "direct";
  const detail = createPersonDetailService({
    actorProfileMergeCandidates: (personId, names) => [{ id: "merge-1", personId, matchedNames: [...names] }],
    actorProfileRow: () => completedProfile,
    adminCoreMutationService: {
      upsertActorProfile() {
        return mode === "direct"
          ? { completed: true, profile: completedProfile }
          : { completed: false, operation: { id: "pending-equivalence", status: "retry_wait" } };
      }
    },
    maxActorAvatarBytes: 1024,
    publicActorProfile: (row) => row,
    resolveLibraryPersonByPublicId: () => person
  });
  const body = {
    acceptAsyncOperation: true,
    aliases: ["Shared Alias"],
    displayName: "Shared Input",
    idempotencyKey: "same-logical-input"
  };
  const direct = detail.updateActorProfile("1", body);
  assert.equal(direct.statusCode, 200);
  mode = "async";
  const accepted = detail.updateActorProfile("1", body);
  assert.equal(accepted.statusCode, 202);
  const asyncCompleted = detail.actorProfilePayload("1");
  assert.deepEqual(asyncCompleted, direct.payload, "direct 200 and 202 -> completed GET must return identical profile and merge candidates for the same input");
}

function verifyTerminalActorProfileContract() {
  const person = { id: "1", name: "Actor One" };
  const blocked = {
    id: "blocked-contract", kind: "actor_profile_upsert", status: "blocked",
    sequence: 1, attempts: 1, createdAt: "created", updatedAt: "updated"
  };
  let mode = "first-failure";
  const detail = createPersonDetailService({
    actorProfileMergeCandidates: () => [],
    actorProfileRow: () => null,
    adminCoreMutationService: {
      upsertActorProfile() {
        if (mode === "first-failure") {
          const error = new Error("C:\\private\\deterministic.sqlite");
          error.operation = blocked;
          throw error;
        }
        if (mode === "blocked-replay") return { completed: false, operation: blocked };
        return { completed: false, operation: { ...blocked, id: "cancelled-contract", status: "cancelled" } };
      }
    },
    maxActorAvatarBytes: 1024,
    publicActorProfile: (row) => row,
    resolveLibraryPersonByPublicId: () => person
  });
  const assertBlocked = (error) => error.code === "ACTOR_PROFILE_BLOCKED"
    && error.statusCode === 409
    && error.operation === blocked
    && error.retryable !== true;
  assert.throws(() => detail.updateActorProfile("1", { acceptAsyncOperation: true }), assertBlocked,
    "a first deterministic failure must be normalized to the same stable blocked 409 contract");
  mode = "blocked-replay";
  assert.throws(() => detail.updateActorProfile("1", { acceptAsyncOperation: true }), assertBlocked,
    "an async opt-in replay of a blocked operation must not return 202");
  assert.throws(() => detail.updateActorProfile("1", { acceptAsyncOperation: false }), assertBlocked,
    "a legacy replay of a blocked operation must not advertise retryable 503");
  mode = "cancelled-replay";
  assert.throws(() => detail.updateActorProfile("1", { acceptAsyncOperation: true }),
    (error) => error.code === "ACTOR_PROFILE_CANCELLED" && error.statusCode === 409 && error.retryable !== true,
    "cancelled operations are terminal and must not use the pending transport contract");
}

async function verifyActorProfileRouteAndNetworkContract() {
  const completedPayload = {
    ok: true,
    profile: { personId: "1", displayName: "Completed", aliases: ["Alias"] },
    mergeCandidates: [{ id: "merge-1", matchedNames: ["Alias"] }]
  };
  const sent = [];
  const deps = {
    notFound: () => { throw new Error("unexpected not found"); },
    personDetailService: {
      actorProfilePayload: () => completedPayload,
      coverBodyLimit: 2048,
      updateActorProfile: () => ({ statusCode: 200, payload: completedPayload })
    },
    readJsonBody: async () => ({ displayName: "Completed" }),
    requireLocalAdmin: () => true,
    requireTrustedFileMutation: () => true,
    sendJson: (_res, statusCode, payload) => sent.push({ statusCode, payload })
  };
  await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/actor-profiles/person-1"), deps);
  await routeWorksApi({ method: "PUT" }, {}, new URL("http://fixture/api/actor-profiles/person-1"), deps);
  assert.deepEqual(sent, [
    { statusCode: 200, payload: completedPayload },
    { statusCode: 200, payload: completedPayload }
  ], "actor-profile GET and completed PUT routes must expose the same completed payload contract");

  let unauthorizedBodyReads = 0;
  let unauthorizedWrites = 0;
  deps.requireLocalAdmin = (_req, res) => {
    deps.sendJson(res, 403, { error: "local admin required" });
    return false;
  };
  deps.readJsonBody = async () => {
    unauthorizedBodyReads += 1;
    return {};
  };
  deps.personDetailService.updateActorProfile = () => {
    unauthorizedWrites += 1;
    return { statusCode: 200, payload: completedPayload };
  };
  sent.length = 0;
  await routeWorksApi({ method: "PUT" }, {}, new URL("http://fixture/api/actor-profiles/person-1"), deps);
  assert.deepEqual(sent, [{ statusCode: 403, payload: { error: "local admin required" } }]);
  assert.equal(unauthorizedBodyReads, 0, "actor-profile PUT must reject remote callers before reading a potentially large avatar body");
  assert.equal(unauthorizedWrites, 0, "actor-profile PUT must not call the mutation service after a failed local-admin gate");
  deps.requireLocalAdmin = () => true;
  deps.readJsonBody = async () => ({ displayName: "Completed" });

  const privateFailure = new Error("SQLITE_BUSY C:\\private\\fanhao.sqlite");
  privateFailure.code = "SQLITE_BUSY";
  privateFailure.statusCode = 503;
  privateFailure.retryable = true;
  privateFailure.operation = {
    id: "op-safe", kind: "actor_profile_upsert", status: "retry_wait", aggregateKey: "person-avatar:1",
    attempts: 1, createdAt: "created", updatedAt: "updated", privatePath: "C:\\private\\fanhao.sqlite"
  };
  deps.personDetailService.actorProfilePayload = () => { throw privateFailure; };
  sent.length = 0;
  await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/actor-profiles/person-1"), deps);
  assert.equal(sent[0].statusCode, 503);
  assert.equal(JSON.stringify(sent[0].payload).includes("private"), false, "GET actor-profile errors must not leak SQLite paths");

  deps.personDetailService.updateActorProfile = () => { throw privateFailure; };
  sent.length = 0;
  await routeWorksApi({ method: "PUT" }, {}, new URL("http://fixture/api/actor-profiles/person-1"), deps);
  assert.equal(sent[0].statusCode, 503);
  assert.equal(sent[0].payload.error, "人物资料服务暂时不可用，请使用同一请求键重试");
  assert.equal(Object.hasOwn(sent[0].payload, "code"), false, "unapproved SQLite codes must not leave the route");
  assert.equal(JSON.stringify(sent[0].payload).includes("private"), false, "SQLite paths and private operation fields must not leave the route");
  assert.deepEqual(Object.keys(sent[0].payload.operation).sort(), [
    "attempts", "completedAt", "createdAt", "id", "kind", "recoverable", "requiresManualRetry", "sequence", "status", "updatedAt"
  ]);

  const pendingFailure = new Error("C:\\private\\must-not-leak.sqlite");
  pendingFailure.code = "ACTOR_PROFILE_PENDING";
  pendingFailure.statusCode = 503;
  pendingFailure.retryable = true;
  deps.personDetailService.updateActorProfile = () => { throw pendingFailure; };
  sent.length = 0;
  await routeWorksApi({ method: "PUT" }, {}, new URL("http://fixture/api/actor-profiles/person-1"), deps);
  assert.deepEqual(sent[0], {
    statusCode: 503,
    payload: {
      error: "人物资料任务仍在恢复中，请使用同一请求键重试",
      code: "ACTOR_PROFILE_PENDING",
      retryable: true
    }
  });

  const blockedFailure = new Error("C:\\private\\blocked.sqlite");
  blockedFailure.code = "ACTOR_PROFILE_BLOCKED";
  blockedFailure.statusCode = 409;
  blockedFailure.operation = {
    id: "blocked-safe", kind: "actor_profile_upsert", status: "blocked",
    sequence: 2, attempts: 3, createdAt: "created", updatedAt: "updated", lastError: "C:\\private\\blocked.sqlite"
  };
  deps.personDetailService.updateActorProfile = () => { throw blockedFailure; };
  sent.length = 0;
  await routeWorksApi({ method: "PUT" }, {}, new URL("http://fixture/api/actor-profiles/person-1"), deps);
  assert.equal(sent[0].statusCode, 409);
  assert.equal(sent[0].payload.error, "人物资料任务已被阻断，请修复原因后手动重试");
  assert.equal(sent[0].payload.code, "ACTOR_PROFILE_BLOCKED");
  assert.equal(sent[0].payload.retryable, undefined);
  assert.equal(sent[0].payload.operation.status, "blocked");
  assert.equal(sent[0].payload.operation.requiresManualRetry, true);
  assert.equal(JSON.stringify(sent[0].payload).includes("private"), false, "blocked route responses must not expose the deterministic failure detail");

  const body = Object.freeze({ acceptAsyncOperation: true, displayName: "Network Retry", idempotencyKey: "network-idempotency" });
  const bodies = [];
  let attempts = 0;
  const response = await saveActorProfileRequest({
    api: async (_path, options) => {
      bodies.push(options.body);
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      if (attempts === 2) {
        const error = new Error("offline");
        error.code = "NETWORK_ERROR";
        throw error;
      }
      return completedPayload;
    },
    body,
    path: "/api/actor-profiles/person-1",
    sleep: async () => {}
  });
  assert.equal(response, completedPayload);
  assert.equal(attempts, 3);
  assert.ok(bodies.every((item) => item === body), "network retries must reuse the exact body and idempotency key");
}

function verifyLeaseTakeoverReceiptRecheck() {
  const fixture = createCrashFixture("lease-takeover");
  let clock = Date.parse("2026-08-11T00:00:00.000Z");
  let staleReceiptReads = 1;
  let serviceB = null;
  const handler = {
    stageImage(db, payload, blobs, context) {
      db.prepare(`
        INSERT INTO actor_profile_image_staging(
          operation_id, person_id, intent_sha256, source_type, remote_url, mime,
          image_blob, byte_size, status, source, legacy_key, created_at, updated_at
        ) VALUES (?, ?, ?, 'unknown', '', 'application/octet-stream', ?, ?, 'ok', 'actor_profiles', ?, ?, ?)
      `).run(context.operationId, payload.personId, context.intentSha256, blobs.avatar, blobs.avatar.length, String(payload.personId), context.createdAt, context.createdAt);
      return { staged: true };
    },
    verifyImageStage(db, payload, blobs, context) {
      const row = db.prepare("SELECT intent_sha256, image_blob FROM actor_profile_image_staging WHERE operation_id = ?").get(context.operationId);
      return row?.intent_sha256 === context.intentSha256 && Buffer.from(row.image_blob || []).equals(blobs.avatar);
    },
    applyMain(db, payload, context) {
      db.prepare("UPDATE people SET value = ?, updated_at = ? WHERE id = ?").run(payload.value, context.createdAt, payload.personId);
      db.prepare(`
        INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(payload.personId, context.operationId, context.intentSha256, context.publishedAt, context.publishedAt);
      return { published: true };
    },
    verifyMain(db, payload, context) {
      return db.prepare("SELECT value FROM people WHERE id = ?").get(payload.personId)?.value === payload.value
        && db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = ?").get(payload.personId)?.operation_id === context.operationId;
    }
  };
  const common = {
    autoReconcile: false,
    busyTimeoutMs: 25,
    handlers: { fixture_upsert: handler },
    imageDbPath: fixture.imageDbPath,
    leaseMs: 10,
    mainDbPath: fixture.mainDbPath,
    now: () => clock,
    retryDelayMs: 0,
    warn: () => {}
  };
  const serviceA = createCrossStoreOutboxService({
    ...common,
    boundaryHook(name) {
      if (name !== "image_staged") return;
      clock += 11;
      const recovered = serviceB.reconcilePending();
      assert.equal(recovered[0]?.status, "completed", "the new lease owner must complete after observing the prior image commit");
    }
  });
  serviceB = createCrossStoreOutboxService({
    ...common,
    createDatabase(filePath) {
      const real = new DatabaseSync(filePath);
      if (path.resolve(filePath) !== path.resolve(fixture.imageDbPath)) return real;
      return {
        close: (...args) => real.close(...args),
        exec: (...args) => real.exec(...args),
        prepare(sql) {
          const statement = real.prepare(sql);
          if (staleReceiptReads > 0 && /SELECT intent_sha256 FROM cross_store_receipts/.test(String(sql))) {
            return {
              get() {
                staleReceiptReads -= 1;
                return undefined;
              }
            };
          }
          return statement;
        }
      };
    }
  });
  try {
    serviceA.start();
    serviceB.start();
    const operation = serviceA.submit({
      aggregateKey: "person-avatar:1",
      blobs: { avatar: Buffer.from("lease-image") },
      idempotencyKey: "lease-takeover",
      kind: "fixture_upsert",
      payload: { personId: 1, value: "lease-new" }
    });
    assert.equal(operation.status, "completed");
    assert.equal(staleReceiptReads, 0, "the fixture must inject one stale transaction-external receipt read");
    const snapshot = crashSnapshot(fixture);
    assert.equal(snapshot.state, "completed");
    assert.equal(snapshot.person, "lease-new");
    assert.equal(snapshot.staged, 1);
    assert.equal(snapshot.imageReceipts, 1);
    assert.equal(snapshot.mainReceipts, 1);
  } finally {
    serviceB.close();
    serviceA.close();
    fixture.cleanup();
  }
}

function createCrashFixture(name) {
  const temporary = createVerifiedTempDir(`fanhao-staging-crash-${name}-`);
  const mainDbPath = path.join(temporary.tempDir, "main.sqlite");
  const imageDbPath = path.join(temporary.tempDir, "images.sqlite");
  const main = new DatabaseSync(mainDbPath);
  main.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE people(id INTEGER PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO people VALUES (1, 'old', 'old');");
  main.close();
  const image = new DatabaseSync(imageDbPath);
  image.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  image.close();
  return { ...temporary, mainDbPath, imageDbPath };
}

function spawnChild(args, env = {}) {
  return spawn(process.execPath, [CHILD, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

function waitForLine(child, prefix, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${prefix}: ${output}\n${errors}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
      if (!line) return;
      clearTimeout(timer);
      resolve(line);
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("exit", (code) => {
      if (output.includes(prefix)) return;
      clearTimeout(timer);
      reject(new Error(`child exited ${code}: ${output}\n${errors}`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function crashSnapshot(fixture) {
  const db = new DatabaseSync(fixture.mainDbPath);
  db.prepare("ATTACH DATABASE ? AS fanhao_images").run(fixture.imageDbPath);
  try {
    const state = db.prepare("SELECT status FROM cross_store_operation_state").get()?.status || null;
    const person = db.prepare("SELECT value FROM people WHERE id = 1").get().value;
    const publication = db.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 1").get()?.operation_id || null;
    const visible = db.prepare(`
      SELECT stage.image_blob
      FROM actor_profile_publications publication
      JOIN cross_store_operation_state state ON state.op_id = publication.operation_id AND state.status = 'completed'
      JOIN cross_store_main_receipts receipt ON receipt.op_id = publication.operation_id AND receipt.step = 'visibility_switch'
      JOIN fanhao_images.actor_profile_image_staging stage ON stage.operation_id = publication.operation_id
      WHERE publication.person_id = 1
    `).get();
    return {
      state,
      person,
      publication,
      visible: visible ? Buffer.from(visible.image_blob).toString() : "old-image",
      staged: Number(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.actor_profile_image_staging").get().count),
      imageReceipts: Number(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.cross_store_receipts").get().count),
      mainReceipts: Number(db.prepare("SELECT COUNT(*) AS count FROM cross_store_main_receipts").get().count)
    };
  } finally {
    db.close();
  }
}

async function verifyCrashBoundaries() {
  for (const boundary of ["prepared", "image_staged", "visibility_before_commit", "visibility_committed"]) {
    const fixture = createCrashFixture(boundary);
    try {
      const child = spawnChild(["submit", fixture.mainDbPath, fixture.imageDbPath], { FANHAO_KILL_BOUNDARY: boundary });
      const line = await waitForLine(child, `BOUNDARY ${boundary} `);
      const operation = JSON.parse(line.slice(`BOUNDARY ${boundary} `.length));
      child.kill("SIGKILL");
      await waitForExit(child);
      const before = crashSnapshot(fixture);
      if (boundary === "prepared") {
        assert.deepEqual(before, { state: "prepared", person: "old", publication: null, visible: "old-image", staged: 0, imageReceipts: 0, mainReceipts: 0 });
      } else if (boundary === "image_staged" || boundary === "visibility_before_commit") {
        assert.deepEqual(before, { state: "applying", person: "old", publication: null, visible: "old-image", staged: 1, imageReceipts: 1, mainReceipts: 0 });
      } else {
        assert.equal(before.state, "completed");
        assert.equal(before.person, "new");
        assert.equal(before.publication, operation.id);
        assert.equal(before.visible, "new-image");
        assert.equal(before.mainReceipts, 1);
      }
      if (boundary !== "visibility_committed") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const recovery = spawnChild(["recover", fixture.mainDbPath, fixture.imageDbPath, operation.id]);
        const done = await waitForLine(recovery, "DONE ");
        const recovered = JSON.parse(done.slice(5));
        await waitForExit(recovery);
        assert.equal(recovered.status, "completed");
        const after = crashSnapshot(fixture);
        assert.equal(after.person, "new");
        assert.equal(after.visible, "new-image");
        assert.equal(after.publication, operation.id);
      }
    } finally {
      fixture.cleanup();
    }
  }
}

async function runRealProtocolChild() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--real-child"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const { code } = await waitForExit(child);
  const tempLine = output.split(/\r?\n/).find((line) => line.startsWith("REAL_TEMP "));
  const tempDir = tempLine?.slice("REAL_TEMP ".length) || "";
  try {
    assert.equal(code, 0, `real actor protocol child failed:\n${output}\n${errors}`);
  } finally {
    if (tempDir) removeVerifiedTempDir(tempDir);
  }
}

if (process.argv[2] === "--real-child") {
  await verifyRealActorProtocol({ cleanup: false, announce: true });
} else {
  await runRealProtocolChild();
  await verifyCrashBoundaries();
  console.log("actor profile staged outbox verification passed");
}
