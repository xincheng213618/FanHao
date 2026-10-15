import { createCrossStoreOutboxService } from "../../src/modules/fanhao/server/library/cross-store-outbox-service.js";

const [mode, mainDbPath, imageDbPath, operationId = ""] = process.argv.slice(2);
const killBoundary = process.env.FANHAO_KILL_BOUNDARY || "";

function handlers() {
  return {
    fixture_upsert: {
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
        const row = db.prepare("SELECT person_id, intent_sha256, image_blob FROM actor_profile_image_staging WHERE operation_id = ?").get(context.operationId);
        return Number(row?.person_id) === Number(payload.personId)
          && row?.intent_sha256 === context.intentSha256
          && Buffer.from(row?.image_blob || []).equals(blobs.avatar);
      },
      applyMain(db, payload, context) {
        db.prepare("UPDATE people SET value = ?, updated_at = ? WHERE id = ?").run(payload.value, context.createdAt, payload.personId);
        db.prepare(`
          INSERT INTO actor_profile_publications(person_id, operation_id, intent_sha256, published_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(person_id) DO UPDATE SET
            operation_id = excluded.operation_id,
            intent_sha256 = excluded.intent_sha256,
            published_at = excluded.published_at,
            updated_at = excluded.updated_at
        `).run(payload.personId, context.operationId, context.intentSha256, context.publishedAt, context.publishedAt);
        return { published: true };
      },
      verifyMain(db, payload, context) {
        const person = db.prepare("SELECT value FROM people WHERE id = ?").get(payload.personId);
        const publication = db.prepare("SELECT operation_id, intent_sha256 FROM actor_profile_publications WHERE person_id = ?").get(payload.personId);
        return person?.value === payload.value
          && publication?.operation_id === context.operationId
          && publication?.intent_sha256 === context.intentSha256;
      }
    }
  };
}

function stopAtBoundary(name, operation) {
  if (name !== killBoundary) return;
  console.log(`BOUNDARY ${name} ${JSON.stringify(operation)}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const service = createCrossStoreOutboxService({
  autoReconcile: false,
  boundaryHook: stopAtBoundary,
  busyTimeoutMs: 25,
  handlers: handlers(),
  imageDbPath,
  leaseMs: 100,
  mainDbPath,
  retryDelayMs: 0,
  warn: () => {}
});

try {
  service.start();
  if (mode === "submit") {
    const operation = service.submit({
      aggregateKey: "person-avatar:1",
      blobs: { avatar: Buffer.from("new-image") },
      idempotencyKey: "fault-fixture",
      kind: "fixture_upsert",
      payload: { personId: 1, value: "new" }
    });
    console.log(`DONE ${JSON.stringify(operation)}`);
  } else if (mode === "recover") {
    const operation = service.getOperation(operationId);
    console.log(`DONE ${JSON.stringify(operation)}`);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  service.close();
}
