import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createActorProfilePublicationLifecycleService } from "../src/modules/fanhao/server/people/actor-profile-publication-lifecycle-service.js";
import { createMediaResponseService } from "../src/platform/server/media-response-service.js";
import { routeWorksApi } from "../src/modules/fanhao/server/works/routes-api.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

function createFixture() {
  const temporary = createVerifiedTempDir("fanhao-actor-revoke-gc-");
  const mainDbPath = path.join(temporary.tempDir, "main.sqlite");
  const imageDbPath = path.join(temporary.tempDir, "images.sqlite");
  const main = new DatabaseSync(mainDbPath);
  main.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE cross_store_intents(
      op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, intent_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE cross_store_operation_state(
      op_id TEXT PRIMARY KEY, status TEXT NOT NULL
    );
    CREATE TABLE cross_store_main_receipts(
      op_id TEXT NOT NULL, step TEXT NOT NULL, intent_sha256 TEXT NOT NULL,
      PRIMARY KEY(op_id, step)
    );
  `);
  main.close();
  const image = new DatabaseSync(imageDbPath);
  image.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE actor_profile_image_staging (
      operation_id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      intent_sha256 TEXT NOT NULL,
      source_type TEXT NOT NULL,
      local_path TEXT,
      remote_url TEXT,
      mime TEXT,
      image_blob BLOB,
      byte_size INTEGER,
      status TEXT NOT NULL DEFAULT 'ok',
      source TEXT NOT NULL,
      legacy_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER actor_profile_image_staging_immutable_update
      BEFORE UPDATE ON actor_profile_image_staging BEGIN
        SELECT RAISE(ABORT, 'actor profile image staging rows are immutable');
      END;
    CREATE TRIGGER actor_profile_image_staging_immutable_delete
      BEFORE DELETE ON actor_profile_image_staging BEGIN
        SELECT RAISE(ABORT, 'actor profile image staging rows are immutable');
      END;
    CREATE TABLE cross_store_receipts(
      op_id TEXT NOT NULL, step TEXT NOT NULL, kind TEXT NOT NULL,
      aggregate_key TEXT NOT NULL, intent_sha256 TEXT NOT NULL,
      PRIMARY KEY(op_id, step)
    );
  `);
  image.close();
  return { ...temporary, imageDbPath, mainDbPath };
}

function insertVersion(fixture, { operationId, personId = 1, status = "completed", value = operationId }) {
  const digest = `digest-${operationId}`;
  const main = new DatabaseSync(fixture.mainDbPath);
  main.prepare(`
    INSERT INTO cross_store_intents(op_id, kind, intent_sha256, payload_json)
    VALUES (?, 'actor_profile_upsert', ?, ?)
  `).run(operationId, digest, JSON.stringify({ hasAvatarMutation: true, personId }));
  main.prepare("INSERT INTO cross_store_operation_state(op_id, status) VALUES (?, ?)").run(operationId, status);
  if (status === "completed") {
    main.prepare("INSERT INTO cross_store_main_receipts(op_id, step, intent_sha256) VALUES (?, 'visibility_switch', ?)").run(operationId, digest);
  }
  main.close();
  const buffer = Buffer.from(value);
  const image = new DatabaseSync(fixture.imageDbPath);
  image.prepare(`
    INSERT INTO actor_profile_image_staging(
      operation_id, person_id, intent_sha256, source_type, mime, image_blob,
      byte_size, status, source, legacy_key, created_at, updated_at
    ) VALUES (?, ?, ?, 'unknown', 'image/test', ?, ?, 'ok', 'manual', ?, 'created', 'updated')
  `).run(operationId, personId, digest, buffer, buffer.length, String(personId));
  image.prepare(`
    INSERT INTO cross_store_receipts(op_id, step, kind, aggregate_key, intent_sha256)
    VALUES (?, 'image_stage', 'actor_profile_upsert', ?, ?)
  `).run(operationId, `person-avatar:${personId}`, digest);
  image.close();
  return digest;
}

function mainConnection(fixture) {
  const db = new DatabaseSync(fixture.mainDbPath);
  db.prepare("ATTACH DATABASE ? AS fanhao_images").run(fixture.imageDbPath);
  return db;
}

function createLifecycle(fixture, options = {}) {
  const service = createActorProfilePublicationLifecycleService({
    autoDrainOnStart: false,
    busyTimeoutMs: 25,
    imageDbPath: fixture.imageDbPath,
    mainDbPath: fixture.mainDbPath,
    warn: () => {},
    ...options
  });
  service.start();
  return service;
}

function gcSnapshot(fixture) {
  const image = new DatabaseSync(fixture.imageDbPath);
  try {
    return {
      receipts: Number(image.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_gc_receipts").get().count),
      stages: Number(image.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_staging").get().count)
    };
  } finally {
    image.close();
  }
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitFor(condition, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await wait(5);
  }
  assert.fail(message);
}

function installLegacyRevocationSchema(fixture, operationId = "legacy-revocation") {
  const main = new DatabaseSync(fixture.mainDbPath);
  main.exec(`
    CREATE TABLE actor_profile_image_revocations (
      operation_id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL,
      intent_sha256 TEXT NOT NULL,
      reason TEXT NOT NULL,
      revoked_at TEXT NOT NULL,
      tombstone_sha256 TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER actor_profile_image_revocations_immutable_update
      BEFORE UPDATE ON actor_profile_image_revocations BEGIN
        SELECT RAISE(ABORT, 'actor profile image revocations are immutable');
      END;
    CREATE TRIGGER actor_profile_image_revocations_immutable_delete
      BEFORE DELETE ON actor_profile_image_revocations BEGIN
        SELECT RAISE(ABORT, 'actor profile image revocations are immutable');
      END;
  `);
  main.prepare(`
    INSERT INTO actor_profile_image_revocations(
      operation_id, person_id, intent_sha256, reason, revoked_at, tombstone_sha256, updated_at
    ) VALUES (?, 1, 'legacy-intent', 'legacy', 'legacy-time', 'legacy-digest', 'legacy-time')
  `).run(operationId);
  main.close();
}

function revocationAuditSnapshot(fixture, operationId = "legacy-revocation") {
  const main = new DatabaseSync(fixture.mainDbPath);
  try {
    const columns = main.prepare("PRAGMA table_info(actor_profile_image_revocations)").all().map((row) => String(row.name));
    const upgraded = ["request_id", "caller", "audit_version"].every((column) => columns.includes(column));
    const row = upgraded
      ? main.prepare(`
          SELECT request_id, caller, audit_version
          FROM actor_profile_image_revocations
          WHERE operation_id = ?
        `).get(operationId)
      : null;
    return { columns, row };
  } finally {
    main.close();
  }
}

function verifySchemaMigrationAndAuthorization() {
  const fixture = createFixture();
  let service = null;
  try {
    installLegacyRevocationSchema(fixture);
    const oldImage = new DatabaseSync(fixture.imageDbPath);
    const oldTrigger = oldImage.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'actor_profile_image_staging_immutable_delete'").get().sql;
    assert.match(oldTrigger, /immutable/);
    assert.doesNotMatch(oldTrigger, /fanhao_actor_profile_gc_authorized/);
    oldImage.close();
    service = createLifecycle(fixture);
    const firstAudit = revocationAuditSnapshot(fixture);
    assert.deepEqual(firstAudit.columns.slice(-3), ["request_id", "caller", "audit_version"]);
    assert.match(firstAudit.row.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(firstAudit.row.caller, "local-admin");
    assert.equal(firstAudit.row.audit_version, 1, "a migrated legacy digest must retain its v1 digest contract");
    const migratedMain = new DatabaseSync(fixture.mainDbPath);
    assert.throws(() => migratedMain.prepare(`
      INSERT INTO actor_profile_image_revocations(
        operation_id, person_id, intent_sha256, reason, revoked_at, tombstone_sha256,
        request_id, caller, audit_version, updated_at
      ) VALUES ('forged-revocation', 1, 'x', 'manual', 'now', 'digest',
        '00000000-0000-4000-8000-000000000000', 'local-admin', 2, 'now')
    `).run(), /no such function|local authorization/i);
    assert.throws(() => migratedMain.prepare(`
      UPDATE actor_profile_image_revocations SET caller = 'forged' WHERE operation_id = 'legacy-revocation'
    `).run(), /immutable/i);
    migratedMain.close();
    const migrated = new DatabaseSync(fixture.imageDbPath);
    const migratedTrigger = migrated.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'actor_profile_image_staging_immutable_delete'").get().sql;
    assert.match(migratedTrigger, /fanhao_actor_profile_gc_authorized/);
    assert.throws(() => migrated.prepare("DELETE FROM actor_profile_image_staging WHERE operation_id = 'never'").run(), /no such function|immutable/i);
    migrated.close();

    service.close();
    service = createLifecycle(fixture);
    const secondAudit = revocationAuditSnapshot(fixture);
    assert.deepEqual(secondAudit, firstAudit, "opening a current schema twice must not rewrite immutable audit identity");
  } finally {
    service?.close();
    fixture.cleanup();
  }
}

function verifyRevokeAndGc() {
  const fixture = createFixture();
  let service = null;
  try {
    const digest = insertVersion(fixture, { operationId: "version-one", value: "secret-avatar" });
    service = createLifecycle(fixture);
    const db = mainConnection(fixture);
    db.prepare(`
      INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
      VALUES (1, 'version-one', ?, 'published', 'published')
    `).run(digest);
    db.close();

    assert.throws(
      () => service.revokeVersion(2, "version-one", { reason: "wrong person" }),
      (error) => error.code === "ACTOR_PROFILE_VERSION_PERSON_MISMATCH" && error.statusCode === 404
    );
    const revoked = service.revokeVersion(1, "version-one", {
      caller: "client-forged-caller",
      path: "C:\\private\\actor.sqlite",
      rawError: "SQLITE_BUSY C:\\private\\actor.sqlite",
      reason: "sensitive",
      requestId: "00000000-0000-4000-8000-000000000000",
      url: "https://private.invalid/avatar"
    });
    assert.equal(revoked.purgeStatus, "pending");
    assert.equal(revoked.alreadyRevoked, false);
    assert.equal(revoked.wasCurrent, true);
    for (const internalField of ["requestId", "caller", "tombstoneSha256", "intentSha256", "path", "url", "rawError"]) {
      assert.equal(Object.hasOwn(revoked, internalField), false, `public revoke response must omit ${internalField}`);
    }
    const replay = service.revokeVersion(1, "version-one", { reason: "must-not-change" });
    assert.equal(replay.alreadyRevoked, true);
    assert.equal(replay.reason, "sensitive");
    const beforeGc = mainConnection(fixture);
    assert.equal(beforeGc.prepare("SELECT COUNT(*) AS count FROM actor_profile_publications").get().count, 0);
    assert.equal(beforeGc.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_revocations").get().count, 1);
    const audit = beforeGc.prepare(`
      SELECT request_id, caller, audit_version, reason
      FROM actor_profile_image_revocations
      WHERE operation_id = 'version-one'
    `).get();
    assert.match(audit.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(audit.request_id, "00000000-0000-4000-8000-000000000000");
    assert.equal(audit.caller, "local-admin");
    assert.equal(audit.audit_version, 2);
    assert.equal(audit.reason, "sensitive");
    const persistedAudit = JSON.stringify(audit);
    assert.equal(persistedAudit.includes("client-forged"), false);
    assert.equal(persistedAudit.includes("private"), false);
    assert.throws(() => beforeGc.prepare(`
      INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
      VALUES (1, 'version-one', 'digest-version-one', 'again', 'again')
    `).run(), /revoked/);
    beforeGc.close();

    const rawImage = new DatabaseSync(fixture.imageDbPath);
    assert.throws(() => rawImage.prepare(`
      INSERT INTO actor_profile_image_gc_receipts(
        operation_id, person_id, intent_sha256, tombstone_sha256,
        content_sha256, byte_size, deleted_at
      ) VALUES ('forged', 1, 'x', 'y', 'z', 1, 'now')
    `).run(), /no such function|local authorization/i);
    assert.throws(() => rawImage.prepare("UPDATE actor_profile_image_staging SET status = 'changed' WHERE operation_id = 'version-one'").run(), /immutable/);
    assert.throws(() => rawImage.prepare("DELETE FROM actor_profile_image_staging WHERE operation_id = 'version-one'").run(), /no such function|immutable/i);
    rawImage.close();
    const collected = service.drainRevoked();
    assert.equal(collected.deleted, 1);
    assert.equal(collected.deletedBytes, Buffer.byteLength("secret-avatar"));
    const afterGc = new DatabaseSync(fixture.imageDbPath);
    assert.equal(afterGc.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_staging").get().count, 0);
    const receipt = afterGc.prepare("SELECT * FROM actor_profile_image_gc_receipts WHERE operation_id = 'version-one'").get();
    assert.equal(receipt.person_id, 1);
    assert.equal(receipt.intent_sha256, "digest-version-one");
    assert.equal(receipt.byte_size, Buffer.byteLength("secret-avatar"));
    assert.match(receipt.content_sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => afterGc.prepare("DELETE FROM actor_profile_image_gc_receipts WHERE operation_id = 'version-one'").run(), /immutable/);
    assert.throws(() => afterGc.prepare(`
      INSERT INTO actor_profile_image_staging(
        operation_id, person_id, intent_sha256, source_type, image_blob, byte_size,
        status, source, created_at, updated_at
      ) VALUES ('version-one', 1, 'digest-version-one', 'unknown', X'01', 1, 'ok', 'manual', 'x', 'x')
    `).run(), /cannot be recreated/);
    afterGc.close();
    const completedReplay = service.revokeVersion(1, "version-one", { reason: "must-stay-sensitive" });
    assert.equal(completedReplay.alreadyRevoked, true);
    assert.equal(completedReplay.reason, "sensitive");
    assert.equal(completedReplay.purgeStatus, "completed", "an idempotent replay must expose the public completed purge status");

    insertVersion(fixture, { operationId: "audit-redaction", value: "redacted-secret" });
    const redacted = service.revokeVersion(1, "audit-redaction", {
      caller: "https://client.invalid/forged",
      path: "C:\\private\\actor.sqlite",
      rawError: "SQLITE_BUSY C:\\private\\actor.sqlite",
      reason: "SQLITE_BUSY C:\\private\\actor.sqlite https://private.invalid/avatar",
      requestId: "attacker-request-id",
      url: "https://private.invalid/avatar"
    });
    assert.equal(redacted.reason, "manual-redacted");
    const redactedDb = new DatabaseSync(fixture.mainDbPath);
    const persisted = redactedDb.prepare(`
      SELECT request_id, caller, reason
      FROM actor_profile_image_revocations
      WHERE operation_id = 'audit-redaction'
    `).get();
    redactedDb.close();
    assert.match(persisted.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(persisted.caller, "local-admin");
    assert.equal(persisted.reason, "manual-redacted");
    assert.equal(JSON.stringify(persisted).includes("private"), false);
    assert.equal(JSON.stringify(persisted).includes("SQLITE_BUSY"), false);
    assert.equal(service.drainRevoked().deleted, 1);
  } finally {
    service?.close();
    fixture.cleanup();
  }
}

function verifyTerminalAndBusyErrors() {
  const fixture = createFixture();
  let service = null;
  let holder = null;
  try {
    insertVersion(fixture, { operationId: "active-version", status: "applying", value: "active" });
    const digest = insertVersion(fixture, { operationId: "no-avatar-version", value: "unused" });
    const main = new DatabaseSync(fixture.mainDbPath);
    main.prepare("UPDATE cross_store_intents SET payload_json = ? WHERE op_id = 'no-avatar-version'").run(JSON.stringify({ hasAvatarMutation: false, personId: 1 }));
    main.close();
    service = createLifecycle(fixture, { busyTimeoutMs: 1 });
    assert.throws(() => service.revokeVersion(1, "active-version"),
      (error) => error.code === "ACTOR_PROFILE_OPERATION_ACTIVE" && error.statusCode === 409);
    assert.throws(() => service.revokeVersion(1, "no-avatar-version"),
      (error) => error.code === "ACTOR_PROFILE_VERSION_HAS_NO_AVATAR" && error.statusCode === 409);
    assert.equal(service.revokeVersion(1, "unknown-version"), null);
    holder = new DatabaseSync(fixture.mainDbPath);
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    assert.throws(() => service.revokeVersion(1, "no-avatar-version"),
      (error) => error.code === "ACTOR_PROFILE_LIFECYCLE_BUSY" && error.statusCode === 503 && error.retryable === true
        && !String(error.message).includes(fixture.mainDbPath));
    holder.exec("ROLLBACK");
    holder.close();
    holder = null;
    assert.equal(digest, "digest-no-avatar-version");
  } finally {
    if (holder) {
      try { holder.exec("ROLLBACK"); } catch {}
      holder.close();
    }
    service?.close();
    fixture.cleanup();
  }
}

function verifyConcurrentPublishAndRevoke() {
  const fixture = createFixture();
  let service = null;
  let concurrentRejected = false;
  try {
    const oldDigest = insertVersion(fixture, { operationId: "concurrent-old", value: "old-secret" });
    const newDigest = insertVersion(fixture, { operationId: "concurrent-new", value: "new-current" });
    service = createLifecycle(fixture, {
      boundaryHook(boundary) {
        if (boundary !== "revoke_before_commit") return;
        const concurrent = new DatabaseSync(fixture.mainDbPath);
        concurrent.exec("PRAGMA busy_timeout = 0;");
        try {
          assert.throws(() => concurrent.prepare(`
            INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
            VALUES (1, 'concurrent-new', ?, 'new', 'new')
            ON CONFLICT(person_id) DO UPDATE SET
              operation_id = excluded.operation_id,
              intent_sha256 = excluded.intent_sha256,
              published_at = excluded.published_at,
              updated_at = excluded.updated_at
          `).run(newDigest), /busy|locked/i);
          concurrentRejected = true;
        } finally {
          concurrent.close();
        }
      }
    });
    const db = mainConnection(fixture);
    db.prepare(`
      INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
      VALUES (1, 'concurrent-old', ?, 'old', 'old')
    `).run(oldDigest);
    db.close();
    service.revokeVersion(1, "concurrent-old", { reason: "concurrent" });
    assert.equal(concurrentRejected, true, "a publication write must serialize behind the revoke main transaction");
    const publish = new DatabaseSync(fixture.mainDbPath);
    publish.prepare(`
      INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
      VALUES (1, 'concurrent-new', ?, 'new', 'new')
    `).run(newDigest);
    publish.close();
    assert.equal(service.drainRevoked().deleted, 1);
    const after = mainConnection(fixture);
    assert.equal(after.prepare("SELECT operation_id FROM actor_profile_publications WHERE person_id = 1").get().operation_id, "concurrent-new");
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM fanhao_images.actor_profile_image_staging WHERE operation_id = 'concurrent-old'").get().count, 0);
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM fanhao_images.actor_profile_image_staging WHERE operation_id = 'concurrent-new'").get().count, 1,
      "collecting a revoked predecessor must never delete the concurrently published successor");
    after.close();
  } finally {
    service?.close();
    fixture.cleanup();
  }
}

function verifyExplicitOnlyAndBounds() {
  const unrevokedFixture = createFixture();
  let service = null;
  try {
    insertVersion(unrevokedFixture, { operationId: "unrevoked-history", value: "keep" });
    service = createLifecycle(unrevokedFixture);
    assert.equal(service.drainRevoked().deleted, 0, "GC must not infer retention deletion for an unrevoked completed history row");
    const image = new DatabaseSync(unrevokedFixture.imageDbPath);
    assert.equal(image.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_staging").get().count, 1);
    image.close();
  } finally {
    service?.close();
    unrevokedFixture.cleanup();
  }

  const countFixture = createFixture();
  service = null;
  try {
    for (let index = 0; index < 51; index += 1) {
      insertVersion(countFixture, { operationId: `count-${String(index).padStart(2, "0")}`, value: "x" });
    }
    service = createLifecycle(countFixture, { batchSize: 999 });
    for (let index = 0; index < 51; index += 1) {
      service.revokeVersion(1, `count-${String(index).padStart(2, "0")}`, { reason: "count-bound" });
    }
    assert.equal(service.drainRevoked({ limit: 999 }).deleted, 50, "one GC transaction must collect at most fifty stages");
    assert.equal(service.drainRevoked({ limit: 999 }).deleted, 1);
  } finally {
    service?.close();
    countFixture.cleanup();
  }

  const byteFixture = createFixture();
  service = null;
  try {
    insertVersion(byteFixture, { operationId: "bytes-one", value: "123456" });
    insertVersion(byteFixture, { operationId: "bytes-two", value: "abcdef" });
    service = createLifecycle(byteFixture, { maxBatchBytes: 10 });
    service.revokeVersion(1, "bytes-one", { reason: "byte-bound" });
    service.revokeVersion(1, "bytes-two", { reason: "byte-bound" });
    const first = service.drainRevoked();
    assert.equal(first.deleted, 1);
    assert.equal(first.deletedBytes, 6);
    assert.ok(first.deletedBytes <= 10, "one GC transaction must stay under its configured byte cap");
    assert.equal(service.drainRevoked().deleted, 1);
  } finally {
    service?.close();
    byteFixture.cleanup();
  }

  const oversizedFixture = createFixture();
  service = null;
  try {
    insertVersion(oversizedFixture, { operationId: "bytes-oversized", value: "12345678901" });
    service = createLifecycle(oversizedFixture, { maxBatchBytes: 10 });
    service.revokeVersion(1, "bytes-oversized", { reason: "byte-bound" });
    const oversized = service.drainRevoked();
    assert.equal(oversized.deleted, 0);
    assert.equal(oversized.deletedBytes, 0);
    assert.equal(oversized.pending, 1, "an over-limit stage must remain visibly pending rather than bypassing the byte cap");
    const image = new DatabaseSync(oversizedFixture.imageDbPath);
    assert.equal(image.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_staging").get().count, 1);
    image.close();
  } finally {
    service?.close();
    oversizedFixture.cleanup();
  }

  const forgedSizeFixture = createFixture();
  service = null;
  try {
    insertVersion(forgedSizeFixture, { operationId: "bytes-forged", value: "actual-eleven" });
    const image = new DatabaseSync(forgedSizeFixture.imageDbPath);
    image.exec("DROP TRIGGER actor_profile_image_staging_immutable_update");
    image.prepare("UPDATE actor_profile_image_staging SET byte_size = 1 WHERE operation_id = 'bytes-forged'").run();
    image.close();
    service = createLifecycle(forgedSizeFixture, { maxBatchBytes: 10 });
    service.revokeVersion(1, "bytes-forged", { reason: "byte-bound" });
    assert.throws(() => service.drainRevoked(),
      (error) => error.code === "ACTOR_PROFILE_GC_RECEIPT_CONFLICT",
      "a forged byte_size must not let a larger BLOB bypass the transaction byte bound");
    const after = new DatabaseSync(forgedSizeFixture.imageDbPath);
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_staging").get().count, 1);
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_gc_receipts").get().count, 0);
    after.close();
  } finally {
    service?.close();
    forgedSizeFixture.cleanup();
  }
}

async function verifyScheduledGcContinuationAndRetry() {
  const continuationFixture = createFixture();
  let service = null;
  try {
    let committedBatches = 0;
    service = createLifecycle(continuationFixture, {
      batchSize: 50,
      boundaryHook(name) {
        if (name === "gc_committed") committedBatches += 1;
      },
      gcRetryBaseDelayMs: 5
    });
    for (let index = 0; index < 51; index += 1) {
      const operationId = `scheduled-${String(index).padStart(2, "0")}`;
      insertVersion(continuationFixture, { operationId, value: "x" });
      service.revokeVersion(1, operationId, { reason: "scheduled-continuation" });
    }
    await waitFor(
      () => gcSnapshot(continuationFixture).stages === 0,
      "scheduled GC must continue after the first fifty-item batch"
    );
    assert.deepEqual(gcSnapshot(continuationFixture), { receipts: 51, stages: 0 });
    assert.equal(committedBatches, 2, "a 51-item backlog must use two bounded GC commits");
    await wait(30);
    assert.equal(committedBatches, 2, "an empty backlog must not schedule another GC commit");
  } finally {
    service?.close();
    continuationFixture.cleanup();
  }

  const retryFixture = createFixture();
  service = null;
  try {
    let attempts = 0;
    let firstFailureAt = 0;
    let recoveredAt = 0;
    const warnings = [];
    service = createLifecycle(retryFixture, {
      boundaryHook(name) {
        if (name !== "gc_before_receipt") return;
        attempts += 1;
        if (attempts === 1) {
          firstFailureAt = Date.now();
          throw new Error("temporary GC failure");
        }
        recoveredAt = Date.now();
      },
      gcRetryBaseDelayMs: 20,
      warn: (...args) => warnings.push(args)
    });
    insertVersion(retryFixture, { operationId: "scheduled-retry", value: "retry" });
    service.revokeVersion(1, "scheduled-retry", { reason: "scheduled-retry" });
    await waitFor(
      () => gcSnapshot(retryFixture).stages === 0,
      "a failed scheduled GC batch must retry with backoff"
    );
    assert.deepEqual(gcSnapshot(retryFixture), { receipts: 1, stages: 0 });
    assert.equal(attempts, 2);
    assert.equal(warnings.length, 1);
    assert.ok(recoveredAt - firstFailureAt >= 15, "scheduled GC retries must yield through the configured backoff delay");
  } finally {
    service?.close();
    retryFixture.cleanup();
  }

  const closeFixture = createFixture();
  service = null;
  try {
    let attempts = 0;
    const warnings = [];
    service = createLifecycle(closeFixture, {
      boundaryHook(name) {
        if (name !== "gc_before_receipt") return;
        attempts += 1;
        throw new Error("retry must be cancelled by close");
      },
      gcRetryBaseDelayMs: 75,
      warn: (...args) => warnings.push(args)
    });
    insertVersion(closeFixture, { operationId: "scheduled-close", value: "close" });
    service.revokeVersion(1, "scheduled-close", { reason: "scheduled-close" });
    await waitFor(() => warnings.length === 1, "the first scheduled GC attempt must fail before close");
    service.close();
    await wait(120);
    assert.equal(attempts, 1, "close must cancel a pending GC retry");
    assert.deepEqual(gcSnapshot(closeFixture), { receipts: 0, stages: 1 });
  } finally {
    service?.close();
    closeFixture.cleanup();
  }
}

async function verifyRouteAuthorizationAndBinding() {
  const sent = [];
  let bodyReads = 0;
  let revokeCalls = 0;
  let gcCalls = 0;
  const deps = {
    notFound: () => { throw new Error("unexpected not found"); },
    personDetailService: {
      revokeActorProfileVersion(personId, operationId, body) {
        revokeCalls += 1;
        assert.equal(personId, "person/one");
        assert.equal(operationId, "operation/one");
        assert.deepEqual(body, { reason: "route-test" }, "the route must discard client-forged audit identity and internal fields");
        return {
          ok: true,
          operationId,
          personId,
          reason: "SQLITE_BUSY C:\\private\\actor.sqlite",
          revokedAt: "route-time",
          alreadyRevoked: false,
          purgeStatus: "pending",
          caller: "must-not-leak",
          requestId: "must-not-leak",
          tombstoneSha256: "must-not-leak",
          path: "C:\\private\\actor.sqlite"
        };
      },
      collectRevokedActorProfileImages() {
        gcCalls += 1;
        return { ok: true, selected: 0, selectedBytes: 0, deleted: 0, deletedBytes: 0, pending: 0, path: "C:\\private\\actor.sqlite" };
      }
    },
    readJsonBody: async () => {
      bodyReads += 1;
      return {
        caller: "client-forged-caller",
        path: "C:\\private\\actor.sqlite",
        rawError: "SQLITE_BUSY C:\\private\\actor.sqlite",
        reason: "route-test",
        requestId: "00000000-0000-4000-8000-000000000000",
        url: "https://private.invalid/avatar"
      };
    },
    requireLocalAdmin: (_req, res) => {
      deps.sendJson(res, 403, { error: "local admin required" });
      return false;
    },
    requireTrustedFileMutation: () => true,
    sendJson: (_res, statusCode, payload) => sent.push({ statusCode, payload })
  };
  const encodedRoute = "http://fixture/api/actor-profiles/person%2Fone/versions/operation%2Fone/revoke";
  await routeWorksApi({ method: "POST" }, {}, new URL(encodedRoute), deps);
  await routeWorksApi({ method: "POST" }, {}, new URL("http://fixture/api/actor-profile-image-gc"), deps);
  assert.equal(bodyReads, 0, "unauthorized revoke must be rejected before reading its body");
  assert.equal(revokeCalls, 0, "unauthorized revoke must not reach the database service");
  assert.equal(gcCalls, 0, "unauthorized GC must not reach the database service");
  assert.deepEqual(sent.map((item) => item.statusCode), [403, 403]);

  deps.requireLocalAdmin = () => true;
  sent.length = 0;
  await routeWorksApi({ method: "POST" }, {}, new URL(encodedRoute), deps);
  assert.equal(bodyReads, 1);
  assert.equal(revokeCalls, 1);
  assert.equal(sent[0].statusCode, 200, "a durable logical revoke remains a 200 even while stage purge is pending");
  assert.equal(sent[0].payload.purgeStatus, "pending");
  assert.equal(sent[0].payload.reason, "manual-redacted", "the HTTP boundary must redact an unexpected internal reason shape");
  for (const internalField of ["caller", "requestId", "tombstoneSha256", "path"]) {
    assert.equal(Object.hasOwn(sent[0].payload, internalField), false, `the route response must omit ${internalField}`);
  }
  await routeWorksApi({ method: "POST" }, {}, new URL("http://fixture/api/actor-profile-image-gc"), deps);
  assert.equal(gcCalls, 1);
  assert.equal(Object.hasOwn(sent[1].payload, "path"), false, "the GC route must whitelist its public response fields");

  const busy = new Error(`SQLITE_BUSY C:\\private\\actor.sqlite`);
  busy.code = "ACTOR_PROFILE_LIFECYCLE_BUSY";
  busy.statusCode = 503;
  busy.retryable = true;
  deps.personDetailService.revokeActorProfileVersion = () => { throw busy; };
  sent.length = 0;
  await routeWorksApi({ method: "POST" }, {}, new URL(encodedRoute), deps);
  assert.equal(sent[0].statusCode, 503);
  assert.equal(sent[0].payload.code, "ACTOR_PROFILE_LIFECYCLE_BUSY");
  assert.equal(sent[0].payload.retryable, true);
  assert.equal(JSON.stringify(sent[0].payload).includes("private"), false, "revoke route must sanitize SQLite paths and raw errors");
}

function crashSnapshot(fixture) {
  const db = mainConnection(fixture);
  try {
    return {
      publications: Number(db.prepare("SELECT COUNT(*) AS count FROM actor_profile_publications").get().count),
      revocations: Number(db.prepare("SELECT COUNT(*) AS count FROM actor_profile_image_revocations").get().count),
      stages: Number(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.actor_profile_image_staging").get().count),
      gcReceipts: Number(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.actor_profile_image_gc_receipts").get().count)
    };
  } finally {
    db.close();
  }
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
    child.once("exit", (code) => {
      if (output.includes(prefix)) return;
      clearTimeout(timer);
      reject(new Error(`crash child exited ${code}: ${output}\n${errors}`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function holdAtBoundary(boundary) {
  console.log(`BOUNDARY ${boundary}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

function prepareCrashFixture(action, boundary) {
  const fixture = createFixture();
  if (action === "schema") {
    installLegacyRevocationSchema(fixture, "legacy-revocation");
    return fixture;
  }
  insertVersion(fixture, { operationId: "crash-version", value: "crash-secret" });
  const service = createLifecycle(fixture);
  const db = mainConnection(fixture);
  db.prepare(`
    INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
    VALUES (1, 'crash-version', 'digest-crash-version', 'published', 'published')
  `).run();
  db.close();
  if (action === "gc") service.revokeVersion(1, "crash-version", { reason: `crash-${boundary}` });
  service.close();
  return fixture;
}

async function verifySchemaMigrationCrashBoundaries() {
  const oldColumns = [
    "operation_id",
    "person_id",
    "intent_sha256",
    "reason",
    "revoked_at",
    "tombstone_sha256",
    "updated_at"
  ];
  for (const boundary of [
    "revocation_audit_schema_columns_added",
    "revocation_audit_schema_backfilled",
    "revocation_audit_schema_committed"
  ]) {
    const fixture = prepareCrashFixture("schema", boundary);
    try {
      const child = spawn(process.execPath, [process.argv[1], "--crash-child", "schema", boundary, fixture.mainDbPath, fixture.imageDbPath], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      await waitForLine(child, `BOUNDARY ${boundary}`);
      child.kill("SIGKILL");
      await waitForExit(child);
      const killed = revocationAuditSnapshot(fixture);
      if (boundary === "revocation_audit_schema_committed") {
        assert.deepEqual(killed.columns.slice(-3), ["request_id", "caller", "audit_version"]);
        assert.match(killed.row.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        assert.equal(killed.row.caller, "local-admin");
        assert.equal(killed.row.audit_version, 1);
      } else {
        assert.deepEqual(killed.columns, oldColumns, `${boundary} must roll the full audit schema migration back`);
        assert.equal(killed.row, null);
      }
      const integrity = new DatabaseSync(fixture.mainDbPath);
      assert.equal(integrity.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      integrity.close();
      const recovery = createLifecycle(fixture);
      recovery.close();
      const recovered = revocationAuditSnapshot(fixture);
      assert.deepEqual(recovered.columns.slice(-3), ["request_id", "caller", "audit_version"]);
      assert.match(recovered.row.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.equal(recovered.row.caller, "local-admin");
      assert.equal(recovered.row.audit_version, 1);
      if (boundary === "revocation_audit_schema_committed") {
        assert.equal(recovered.row.request_id, killed.row.request_id, "recovery must not rewrite a committed legacy audit request id");
      }
    } finally {
      fixture.cleanup();
    }
  }
}

async function verifyCrashBoundaries() {
  const cases = [
    ["revoke", "revoke_before_commit", { publications: 1, revocations: 0, stages: 1, gcReceipts: 0 }],
    ["revoke", "revoke_committed", { publications: 0, revocations: 1, stages: 1, gcReceipts: 0 }],
    ["gc", "gc_before_receipt", { publications: 0, revocations: 1, stages: 1, gcReceipts: 0 }],
    ["gc", "gc_after_receipt", { publications: 0, revocations: 1, stages: 1, gcReceipts: 0 }],
    ["gc", "gc_after_delete", { publications: 0, revocations: 1, stages: 1, gcReceipts: 0 }],
    ["gc", "gc_before_commit", { publications: 0, revocations: 1, stages: 1, gcReceipts: 0 }],
    ["gc", "gc_committed", { publications: 0, revocations: 1, stages: 0, gcReceipts: 1 }]
  ];
  for (const [action, boundary, expected] of cases) {
    const fixture = prepareCrashFixture(action, boundary);
    try {
      const child = spawn(process.execPath, [process.argv[1], "--crash-child", action, boundary, fixture.mainDbPath, fixture.imageDbPath], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      await waitForLine(child, `BOUNDARY ${boundary}`);
      child.kill("SIGKILL");
      await waitForExit(child);
      assert.deepEqual(crashSnapshot(fixture), expected, `${boundary} must leave only a fully committed durable boundary`);
      const recovery = createLifecycle(fixture);
      const recovered = recovery.drainRevoked();
      recovery.close();
      if (boundary === "revoke_before_commit") {
        assert.equal(recovered.deleted, 0, "a rolled-back revoke must not authorize stage collection");
        assert.deepEqual(crashSnapshot(fixture), expected);
      } else {
        assert.equal(crashSnapshot(fixture).stages, 0, `${boundary} must recover to a collected hidden stage`);
        assert.equal(crashSnapshot(fixture).gcReceipts, 1, `${boundary} recovery must retain the immutable GC receipt`);
      }
    } finally {
      fixture.cleanup();
    }
  }
}

function responseRecorder() {
  let statusCode = 0;
  let headers = {};
  let bytes = Buffer.alloc(0);
  return {
    response: {
      writeHead(status, nextHeaders) { statusCode = Number(status); headers = nextHeaders || {}; },
      end(body) { bytes = Buffer.from(body || []); }
    },
    result: () => ({ bytes: bytes.toString(), headers, statusCode })
  };
}

async function verifySameProcessCachedVersionRevoke() {
  let revoked = false;
  let reads = 0;
  const service = createMediaResponseService({
    coreImageRow: () => null,
    corePersonAvatarRow: () => null,
    getCoreDb: () => null,
    isAllowedRemoteImageUrl: () => false,
    maxRemoteImageBytes: 1,
    mediaBlobStore: {
      async actorAvatar() { throw new Error("version reader bypassed authority"); },
      async actorAvatarVersion() {
        reads += 1;
        return revoked
          ? { status: "revoked", row: null }
          : { status: "available", row: { image_blob: Buffer.from("cached-secret"), mime: "image/test" } };
      }
    },
    mimeTypes: {},
    normalizeExt: () => "",
    notFound: () => { throw new Error("unexpected not found"); },
    proxiedRemoteImageUrl: () => "",
    publicRemoteUrl: () => "",
    safeStat: () => null,
    sendText: () => { throw new Error("unexpected text"); },
    workCoverRow: () => null
  });
  const first = responseRecorder();
  await service.serveActorAvatar(first.response, 1, { version: "cached-version" });
  assert.equal(first.result().statusCode, 200);
  assert.equal(first.result().bytes, "cached-secret");
  assert.equal(first.result().headers["Cache-Control"], "private, no-store");
  revoked = true;
  const second = responseRecorder();
  await service.serveActorAvatar(second.response, 1, { version: "cached-version" });
  assert.equal(second.result().statusCode, 410);
  assert.equal(second.result().bytes, "");
  assert.equal(second.result().headers["Cache-Control"], "private, no-store");
  assert.equal(reads, 2, "a cached version must still recheck the durable revoke authority on every request");
}

if (process.argv[2] === "--crash-child") {
  const [, , , action, boundary, mainDbPath, imageDbPath] = process.argv;
  const service = createActorProfilePublicationLifecycleService({
    autoDrainOnStart: false,
    boundaryHook(name) {
      if (name === boundary) holdAtBoundary(boundary);
    },
    imageDbPath,
    mainDbPath,
    warn: () => {}
  });
  service.start();
  if (action === "revoke") service.revokeVersion(1, "crash-version", { reason: `crash-${boundary}` });
  else service.drainRevoked();
  service.close();
} else {
  verifySchemaMigrationAndAuthorization();
  verifyRevokeAndGc();
  verifyTerminalAndBusyErrors();
  verifyConcurrentPublishAndRevoke();
  verifyExplicitOnlyAndBounds();
  await verifyScheduledGcContinuationAndRetry();
  await verifySameProcessCachedVersionRevoke();
  await verifyRouteAuthorizationAndBinding();
  await verifySchemaMigrationCrashBoundaries();
  await verifyCrashBoundaries();
  console.log("actor profile revoke and bounded GC verification passed");
}
