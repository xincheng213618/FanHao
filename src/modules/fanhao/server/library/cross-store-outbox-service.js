import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ensureActorProfileImageStagingTable,
  ensureActorProfilePublicationTable
} from "../people/actor-profile-publication-schema.js";

const TERMINAL_STATUSES = new Set(["completed", "blocked", "cancelled"]);
const RETRYABLE_STATUSES = new Set(["prepared", "applying", "retry_wait"]);

function isoNow(now) {
  return new Date(now()).toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isBusyError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
  return text.includes("SQLITE_BUSY") || text.includes("DATABASE IS LOCKED") || text.includes("DATABASE TABLE IS LOCKED");
}

function isAmbiguousStoreError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
  return text.includes("SQLITE_IOERR") || text.includes("SQLITE_PROTOCOL") || text.includes("SQLITE_INTERRUPT");
}

function publicOperation(row) {
  if (!row) return null;
  return {
    id: String(row.op_id),
    kind: String(row.kind),
    sequence: Number(row.aggregate_seq),
    status: String(row.status),
    attempts: Number(row.attempt_count || 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    recoverable: !["completed", "cancelled"].includes(String(row.status)),
    requiresManualRetry: String(row.status) === "blocked"
  };
}

function configureDurableConnection(db, busyTimeoutMs) {
  db.exec(`
    PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) || 0)};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureMainSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureActorProfilePublicationTable(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cross_store_intents (
        op_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        aggregate_key TEXT NOT NULL,
        aggregate_seq INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(aggregate_key, aggregate_seq)
      );
      CREATE TRIGGER IF NOT EXISTS cross_store_intents_immutable_update
        BEFORE UPDATE ON cross_store_intents BEGIN
          SELECT RAISE(ABORT, 'cross_store_intents are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS cross_store_intents_immutable_delete
        BEFORE DELETE ON cross_store_intents BEGIN
          SELECT RAISE(ABORT, 'cross_store_intents are immutable');
        END;
      CREATE TABLE IF NOT EXISTS cross_store_intent_reservations (
        op_id TEXT NOT NULL REFERENCES cross_store_intents(op_id),
        aggregate_key TEXT NOT NULL,
        PRIMARY KEY(op_id, aggregate_key)
      );
      CREATE TRIGGER IF NOT EXISTS cross_store_intent_reservations_immutable_update
        BEFORE UPDATE ON cross_store_intent_reservations BEGIN
          SELECT RAISE(ABORT, 'cross_store_intent_reservations are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS cross_store_intent_reservations_immutable_delete
        BEFORE DELETE ON cross_store_intent_reservations BEGIN
          SELECT RAISE(ABORT, 'cross_store_intent_reservations are immutable');
        END;
      CREATE TABLE IF NOT EXISTS cross_store_intent_blobs (
        op_id TEXT NOT NULL REFERENCES cross_store_intents(op_id),
        slot TEXT NOT NULL,
        content BLOB NOT NULL,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        PRIMARY KEY(op_id, slot)
      );
      CREATE TRIGGER IF NOT EXISTS cross_store_intent_blobs_immutable_update
        BEFORE UPDATE ON cross_store_intent_blobs BEGIN
          SELECT RAISE(ABORT, 'cross_store_intent_blobs are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS cross_store_intent_blobs_immutable_delete
        BEFORE DELETE ON cross_store_intent_blobs
        WHEN COALESCE((SELECT status FROM cross_store_operation_state WHERE op_id = OLD.op_id), '') NOT IN ('completed', 'cancelled')
        BEGIN
          SELECT RAISE(ABORT, 'cross_store_intent_blobs are immutable');
        END;
      CREATE TABLE IF NOT EXISTS cross_store_intent_blob_manifest (
        op_id TEXT NOT NULL REFERENCES cross_store_intents(op_id),
        slot TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        PRIMARY KEY(op_id, slot)
      );
      CREATE TRIGGER IF NOT EXISTS cross_store_intent_blob_manifest_immutable_update
        BEFORE UPDATE ON cross_store_intent_blob_manifest BEGIN
          SELECT RAISE(ABORT, 'cross_store_intent_blob_manifest is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS cross_store_intent_blob_manifest_immutable_delete
        BEFORE DELETE ON cross_store_intent_blob_manifest BEGIN
          SELECT RAISE(ABORT, 'cross_store_intent_blob_manifest is immutable');
        END;
      CREATE TABLE IF NOT EXISTS cross_store_operation_state (
        op_id TEXT PRIMARY KEY REFERENCES cross_store_intents(op_id),
        status TEXT NOT NULL CHECK(status IN ('prepared', 'applying', 'retry_wait', 'completed', 'blocked', 'cancelled')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        version INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cross_store_operation_reconcile
        ON cross_store_operation_state(status, next_attempt_at, lease_until);
      CREATE TABLE IF NOT EXISTS cross_store_aggregate_order (
        aggregate_key TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cross_store_aggregate_reservations (
        aggregate_key TEXT PRIMARY KEY,
        op_id TEXT NOT NULL REFERENCES cross_store_intents(op_id),
        aggregate_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cross_store_main_receipts (
        op_id TEXT NOT NULL REFERENCES cross_store_intents(op_id),
        step TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(op_id, step)
      );
      CREATE TRIGGER IF NOT EXISTS cross_store_main_receipts_immutable_update
        BEFORE UPDATE ON cross_store_main_receipts BEGIN
          SELECT RAISE(ABORT, 'cross_store_main_receipts are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS cross_store_main_receipts_immutable_delete
        BEFORE DELETE ON cross_store_main_receipts BEGIN
          SELECT RAISE(ABORT, 'cross_store_main_receipts are immutable');
        END;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function ensureImageSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureActorProfileImageStagingTable(db, "main");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cross_store_receipts (
        op_id TEXT NOT NULL,
        step TEXT NOT NULL,
        kind TEXT NOT NULL,
        aggregate_key TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(op_id, step)
      );
      CREATE TRIGGER IF NOT EXISTS cross_store_receipts_immutable_update
        BEFORE UPDATE ON cross_store_receipts BEGIN
          SELECT RAISE(ABORT, 'cross_store_receipts are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS cross_store_receipts_immutable_delete
        BEFORE DELETE ON cross_store_receipts BEGIN
          SELECT RAISE(ABORT, 'cross_store_receipts are immutable');
        END;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function createCrossStoreOutboxService({
  autoReconcile = true,
  boundaryHook = () => {},
  busyTimeoutMs = 250,
  createDatabase = (filePath) => new DatabaseSync(filePath),
  handlers,
  imageDbPath,
  leaseMs = 15000,
  mainDbPath,
  newId = randomUUID,
  now = Date.now,
  reconcileIntervalMs = 5000,
  retryDelayMs = 1000,
  warn = console.warn
}) {
  const instanceId = newId();
  let imageDb = null;
  let mainDb = null;
  let started = false;
  let ready = false;
  let timer = null;

  function requireReady() {
    if (ready) return;
    const error = new Error("人物资料恢复队列尚未就绪");
    error.code = "CROSS_STORE_NOT_READY";
    error.statusCode = 503;
    throw error;
  }

  function operationRow(operationId) {
    return mainDb.prepare(`
      SELECT i.op_id, i.kind, i.aggregate_key, i.aggregate_seq,
             s.status, s.attempt_count, s.last_error, s.created_at, s.updated_at, s.completed_at,
             s.lease_owner, s.lease_until, s.version
      FROM cross_store_intents i
      JOIN cross_store_operation_state s ON s.op_id = i.op_id
      WHERE i.op_id = ?
    `).get(String(operationId || ""));
  }

  function getOperation(operationId) {
    requireReady();
    return publicOperation(operationRow(operationId));
  }

  function readIntent(operationId) {
    const row = mainDb.prepare(`
      SELECT i.*, s.status, s.version
      FROM cross_store_intents i
      JOIN cross_store_operation_state s ON s.op_id = i.op_id
      WHERE i.op_id = ?
    `).get(operationId);
    if (!row) return null;
    const manifest = mainDb.prepare("SELECT slot, sha256, byte_size FROM cross_store_intent_blob_manifest WHERE op_id = ? ORDER BY slot").all(operationId);
    const reservationKeys = mainDb.prepare("SELECT aggregate_key FROM cross_store_intent_reservations WHERE op_id = ? ORDER BY aggregate_key").all(operationId).map((item) => String(item.aggregate_key));
    const readContent = mainDb.prepare("SELECT content FROM cross_store_intent_blobs WHERE op_id = ? AND slot = ?");
    const blobs = {};
    for (const blob of manifest) {
      const stored = readContent.get(operationId, blob.slot);
      if (!stored) throw new Error(`Intent blob content is missing for ${operationId}/${blob.slot}`);
      const content = Buffer.from(stored.content);
      if (content.length !== Number(blob.byte_size) || sha256(content) !== blob.sha256) {
        throw new Error(`Intent blob integrity check failed for ${operationId}/${blob.slot}`);
      }
      blobs[blob.slot] = content;
    }
    if (sha256(row.payload_json) !== row.payload_sha256) throw new Error(`Intent payload integrity check failed for ${operationId}`);
    const intentSha256 = sha256(stableJson({
      payloadSha256: row.payload_sha256,
      blobs: manifest.map((blob) => ({ slot: blob.slot, hash: blob.sha256, byteSize: Number(blob.byte_size) })),
      reservationKeys
    }));
    if (intentSha256 !== row.intent_sha256) throw new Error(`Intent digest check failed for ${operationId}`);
    return { ...row, payload: JSON.parse(row.payload_json), blobs };
  }

  function leaseLostError(operationId) {
    const error = new Error(`Cross-store lease was lost for ${operationId}`);
    error.code = "CROSS_STORE_LEASE_LOST";
    return error;
  }

  function assertLease(db, operationId, fence) {
    const state = db.prepare("SELECT status, lease_owner, version FROM cross_store_operation_state WHERE op_id = ?").get(operationId);
    if (!state || TERMINAL_STATUSES.has(state.status) || state.lease_owner !== instanceId || Number(state.version) !== Number(fence.version)) {
      throw leaseLostError(operationId);
    }
  }

  function takeLease(operationId) {
    const timestamp = isoNow(now);
    const leaseUntil = new Date(now() + leaseMs).toISOString();
    mainDb.exec("BEGIN IMMEDIATE");
    try {
      const state = mainDb.prepare("SELECT status, lease_owner, lease_until, version FROM cross_store_operation_state WHERE op_id = ?").get(operationId);
      if (!state || TERMINAL_STATUSES.has(state.status)) {
        mainDb.exec("COMMIT");
        return null;
      }
      if (state.lease_owner && state.lease_owner !== instanceId && String(state.lease_until || "") > timestamp) {
        mainDb.exec("COMMIT");
        return null;
      }
      const changed = mainDb.prepare(`
        UPDATE cross_store_operation_state
        SET status = 'applying', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_until = ?, next_attempt_at = NULL,
            updated_at = ?, version = version + 1
        WHERE op_id = ? AND version = ?
      `).run(instanceId, leaseUntil, timestamp, operationId, state.version);
      mainDb.exec("COMMIT");
      return Number(changed.changes) === 1 ? { owner: instanceId, version: Number(state.version) + 1 } : null;
    } catch (error) {
      try { mainDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function renewLease(operationId, fence) {
    const timestamp = isoNow(now);
    const leaseUntil = new Date(now() + leaseMs).toISOString();
    mainDb.exec("BEGIN IMMEDIATE");
    try {
      const changed = mainDb.prepare(`
        UPDATE cross_store_operation_state
        SET lease_until = ?, updated_at = ?, version = version + 1
        WHERE op_id = ? AND lease_owner = ? AND version = ? AND status = 'applying'
      `).run(leaseUntil, timestamp, operationId, instanceId, fence.version);
      if (Number(changed.changes) !== 1) throw leaseLostError(operationId);
      mainDb.exec("COMMIT");
      return { owner: instanceId, version: Number(fence.version) + 1 };
    } catch (error) {
      try { mainDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function recordFailure(operationId, error, retryable, fence) {
    const timestamp = isoNow(now);
    const status = retryable ? "retry_wait" : "blocked";
    const nextAttemptAt = retryable ? new Date(now() + retryDelayMs).toISOString() : null;
    mainDb.exec("BEGIN IMMEDIATE");
    try {
      const changed = mainDb.prepare(`
        UPDATE cross_store_operation_state
        SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL,
            last_error = ?, updated_at = ?, version = version + 1
        WHERE op_id = ? AND lease_owner = ? AND version = ?
          AND status NOT IN ('completed', 'cancelled')
      `).run(status, nextAttemptAt, String(error?.message || error).slice(0, 1000), timestamp, operationId, instanceId, fence?.version ?? -1);
      mainDb.exec("COMMIT");
      return Number(changed.changes) === 1;
    } catch (stateError) {
      try { mainDb.exec("ROLLBACK"); } catch {}
      throw new AggregateError([error, stateError], "Cross-store failure could not be recorded durably");
    }
  }

  function applyImageStage(intent, handler) {
    const receipt = imageDb.prepare("SELECT intent_sha256 FROM cross_store_receipts WHERE op_id = ? AND step = 'image_stage'").get(intent.op_id);
    if (receipt) {
      if (receipt.intent_sha256 !== intent.intent_sha256) throw new Error("Cross-store image receipt digest mismatch");
      return;
    }
    imageDb.exec("BEGIN IMMEDIATE");
    try {
      // The preflight read is only a fast path. Another lease owner may commit
      // while this connection waits for the image write lock, so receipt
      // existence must be decided again inside the serialized transaction.
      const committedReceipt = imageDb.prepare("SELECT intent_sha256 FROM cross_store_receipts WHERE op_id = ? AND step = 'image_stage'").get(intent.op_id);
      if (committedReceipt) {
        if (committedReceipt.intent_sha256 !== intent.intent_sha256) throw new Error("Cross-store image receipt digest mismatch");
        imageDb.exec("COMMIT");
        return;
      }
      const result = handler.stageImage(imageDb, intent.payload, intent.blobs, {
        operationId: intent.op_id,
        intentSha256: intent.intent_sha256,
        createdAt: intent.created_at
      }) || {};
      imageDb.prepare(`
        INSERT INTO cross_store_receipts(op_id, step, kind, aggregate_key, intent_sha256, result_json, applied_at)
        VALUES (?, 'image_stage', ?, ?, ?, ?, ?)
      `).run(intent.op_id, intent.kind, intent.aggregate_key, intent.intent_sha256, stableJson(result), isoNow(now));
      imageDb.exec("COMMIT");
    } catch (error) {
      try { imageDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function verifyImageBoundary(intent, handler) {
    const receipt = imageDb.prepare("SELECT intent_sha256 FROM cross_store_receipts WHERE op_id = ? AND step = 'image_stage'").get(intent.op_id);
    if (receipt?.intent_sha256 !== intent.intent_sha256) throw new Error("Cross-store image receipt verification failed");
    if (handler.verifyImageStage && handler.verifyImageStage(imageDb, intent.payload, intent.blobs, {
      operationId: intent.op_id,
      intentSha256: intent.intent_sha256
    }) !== true) throw new Error("Cross-store staged image verification failed");
  }

  // This FULL main transaction is the only visibility switch. Before it commits,
  // the staged image has no reader-visible pointer. After it commits, profile,
  // publication pointer, receipt and completed state become visible together.
  function applyMainAndComplete(intent, handler, fence) {
    verifyImageBoundary(intent, handler);
    const timestamp = isoNow(now);
    mainDb.exec("BEGIN IMMEDIATE");
    try {
      assertLease(mainDb, intent.op_id, fence);
      const existingReceipt = mainDb.prepare("SELECT intent_sha256 FROM cross_store_main_receipts WHERE op_id = ? AND step = 'visibility_switch'").get(intent.op_id);
      if (existingReceipt) {
        if (existingReceipt.intent_sha256 !== intent.intent_sha256) throw new Error("Cross-store main receipt digest mismatch");
      } else {
        const result = handler.applyMain(mainDb, intent.payload, {
          operationId: intent.op_id,
          intentSha256: intent.intent_sha256,
          createdAt: intent.created_at,
          publishedAt: timestamp
        }) || {};
        if (handler.verifyMain && handler.verifyMain(mainDb, intent.payload, {
          operationId: intent.op_id,
          intentSha256: intent.intent_sha256
        }) !== true) throw new Error("Cross-store main projection verification failed");
        mainDb.prepare(`
          INSERT INTO cross_store_main_receipts(op_id, step, intent_sha256, result_json, applied_at)
          VALUES (?, 'visibility_switch', ?, ?, ?)
        `).run(intent.op_id, intent.intent_sha256, stableJson(result), timestamp);
      }
      const changed = mainDb.prepare(`
        UPDATE cross_store_operation_state
        SET status = 'completed', lease_owner = NULL, lease_until = NULL,
            next_attempt_at = NULL, last_error = NULL, updated_at = ?, completed_at = ?, version = version + 1
        WHERE op_id = ? AND lease_owner = ? AND version = ? AND status = 'applying'
      `).run(timestamp, timestamp, intent.op_id, instanceId, fence.version);
      if (Number(changed.changes) !== 1) throw leaseLostError(intent.op_id);
      mainDb.prepare("DELETE FROM cross_store_intent_blobs WHERE op_id = ?").run(intent.op_id);
      mainDb.prepare("DELETE FROM cross_store_aggregate_reservations WHERE op_id = ?").run(intent.op_id);
      boundaryHook("visibility_before_commit", publicOperation(operationRow(intent.op_id)));
      mainDb.exec("COMMIT");
    } catch (error) {
      try { mainDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function processOperation(operationId, { throwDeterministic = false } = {}) {
    const current = operationRow(operationId);
    if (!current || TERMINAL_STATUSES.has(current.status)) return publicOperation(current);
    let fence = null;
    let intent = null;
    let handler = null;
    try {
      fence = takeLease(operationId);
      if (!fence) return publicOperation(operationRow(operationId));
      intent = readIntent(operationId);
      handler = handlers?.[intent.kind];
      if (!handler) throw new Error(`No cross-store handler for ${intent.kind}`);
      applyImageStage(intent, handler);
      boundaryHook("image_staged", publicOperation(operationRow(intent.op_id)));
      fence = renewLease(operationId, fence);
      applyMainAndComplete(intent, handler, fence);
      boundaryHook("visibility_committed", publicOperation(operationRow(intent.op_id)));
    } catch (error) {
      const afterError = operationRow(operationId);
      if (afterError && TERMINAL_STATUSES.has(afterError.status)) return publicOperation(afterError);
      const retryable = isBusyError(error) || isAmbiguousStoreError(error);
      let recorded = false;
      try {
        recorded = fence ? recordFailure(operationId, error, retryable, fence) : false;
      } catch (recordError) {
        const unavailable = new Error("人物资料任务已经持久化，但暂时无法记录执行结果，请使用同一请求键重试");
        unavailable.code = "CROSS_STORE_FAILURE_RECORD_BUSY";
        unavailable.statusCode = 503;
        unavailable.retryable = true;
        try { unavailable.operation = publicOperation(operationRow(operationId)) || publicOperation(current); } catch { unavailable.operation = publicOperation(current); }
        unavailable.cause = new AggregateError([error, recordError]);
        throw unavailable;
      }
      const operation = publicOperation(operationRow(operationId));
      if (!retryable && throwDeterministic && recorded) {
        error.operation = operation;
        throw error;
      }
      return operation;
    }
    const operation = publicOperation(operationRow(operationId));
    try { handler.onCompleted?.(intent.payload, { operationId: intent.op_id }); } catch (error) { warn("[cross-store-publish]", error?.message || error); }
    return operation;
  }

  function submit({ aggregateKey, blobs = {}, idempotencyKey = "", kind, payload, payloadVersion = 1, requestPayload = payload }) {
    requireReady();
    if (!handlers?.[kind]) throw new Error(`No cross-store handler for ${kind}`);
    const payloadJson = stableJson(payload);
    const payloadSha256 = sha256(payloadJson);
    const blobRows = Object.entries(blobs)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([slot, value]) => {
        const content = Buffer.from(value);
        return { slot, content, sha256: sha256(content), byteSize: content.length };
      })
      .sort((a, b) => a.slot.localeCompare(b.slot));
    const requestSha256 = sha256(stableJson({
      aggregateKey,
      blobs: blobRows.map(({ slot, sha256: hash, byteSize }) => ({ slot, hash, byteSize })),
      kind,
      requestPayload: stableValue(requestPayload)
    }));
    const operationId = newId();
    const requestKey = String(idempotencyKey || "").trim();
    const finalIdempotencyKey = `${kind}:${requestKey ? `request:${requestKey}` : `operation:${operationId}`}`;
    const timestamp = isoNow(now);
    let selectedId = operationId;

    try {
      mainDb.exec("BEGIN IMMEDIATE");
      const existing = mainDb.prepare("SELECT op_id, request_sha256 FROM cross_store_intents WHERE idempotency_key = ?").get(finalIdempotencyKey);
      if (existing) {
        if (existing.request_sha256 !== requestSha256) {
          const error = new Error("幂等键已经用于不同的人物资料请求");
          error.code = "IDEMPOTENCY_CONFLICT";
          error.statusCode = 409;
          throw error;
        }
        selectedId = String(existing.op_id);
        mainDb.exec("COMMIT");
      } else {
        handlers[kind].assertCanPrepare?.(mainDb, payload, { operationId: "" });
        const reservationKeys = [...new Set([
          aggregateKey,
          ...(handlers[kind].reservationKeys?.(mainDb, payload) || [])
        ].map(String).filter(Boolean))].sort();
        const findReservation = mainDb.prepare("SELECT op_id FROM cross_store_aggregate_reservations WHERE aggregate_key = ?");
        for (const reservationKey of reservationKeys) {
          const reservation = findReservation.get(reservationKey);
          if (!reservation) continue;
          const error = new Error("人物头像或 JavDB 身份正在由可恢复任务更新，请稍后重试");
          error.code = "ACTOR_PROFILE_RESERVED";
          error.statusCode = 409;
          error.operationId = String(reservation.op_id);
          error.operation = publicOperation(operationRow(reservation.op_id));
          throw error;
        }
        const intentSha256 = sha256(stableJson({
          payloadSha256,
          blobs: blobRows.map(({ slot, sha256: hash, byteSize }) => ({ slot, hash, byteSize })),
          reservationKeys
        }));
        const order = mainDb.prepare("SELECT last_sequence FROM cross_store_aggregate_order WHERE aggregate_key = ?").get(aggregateKey);
        const sequence = Number(order?.last_sequence || 0) + 1;
        mainDb.prepare(`
          INSERT INTO cross_store_aggregate_order(aggregate_key, last_sequence) VALUES (?, ?)
          ON CONFLICT(aggregate_key) DO UPDATE SET last_sequence = excluded.last_sequence
        `).run(aggregateKey, sequence);
        mainDb.prepare(`
          INSERT INTO cross_store_intents(op_id, kind, aggregate_key, aggregate_seq, idempotency_key, payload_version,
            payload_json, payload_sha256, intent_sha256, request_sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(operationId, kind, aggregateKey, sequence, finalIdempotencyKey, payloadVersion, payloadJson, payloadSha256, intentSha256, requestSha256, timestamp);
        const insertIntentReservation = mainDb.prepare("INSERT INTO cross_store_intent_reservations(op_id, aggregate_key) VALUES (?, ?)");
        for (const reservationKey of reservationKeys) insertIntentReservation.run(operationId, reservationKey);
        const insertBlob = mainDb.prepare("INSERT INTO cross_store_intent_blobs(op_id, slot, content, sha256, byte_size) VALUES (?, ?, ?, ?, ?)");
        const insertManifest = mainDb.prepare("INSERT INTO cross_store_intent_blob_manifest(op_id, slot, sha256, byte_size) VALUES (?, ?, ?, ?)");
        for (const blob of blobRows) {
          insertBlob.run(operationId, blob.slot, blob.content, blob.sha256, blob.byteSize);
          insertManifest.run(operationId, blob.slot, blob.sha256, blob.byteSize);
        }
        mainDb.prepare("INSERT INTO cross_store_operation_state(op_id, status, created_at, updated_at) VALUES (?, 'prepared', ?, ?)").run(operationId, timestamp, timestamp);
        const insertReservation = mainDb.prepare("INSERT INTO cross_store_aggregate_reservations(aggregate_key, op_id, aggregate_seq, created_at) VALUES (?, ?, ?, ?)");
        for (const reservationKey of reservationKeys) insertReservation.run(reservationKey, operationId, sequence, timestamp);
        mainDb.exec("COMMIT");
      }
    } catch (error) {
      try { mainDb.exec("ROLLBACK"); } catch {}
      if (!error.operation && error.operationId) {
        try { error.operation = publicOperation(operationRow(error.operationId)); } catch {}
      }
      if (isBusyError(error) || isAmbiguousStoreError(error)) {
        error.statusCode = 503;
        error.retryable = true;
      }
      throw error;
    }
    if (selectedId === operationId) boundaryHook("prepared", publicOperation(operationRow(operationId)));
    return processOperation(selectedId, { throwDeterministic: true });
  }

  function reconcilePending() {
    if (!started) return [];
    const timestamp = isoNow(now);
    const rows = mainDb.prepare(`
      SELECT op_id FROM cross_store_operation_state
      WHERE status IN ('prepared', 'applying', 'retry_wait')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at, op_id
    `).all(timestamp, timestamp);
    const operations = [];
    for (const row of rows) {
      try { operations.push(processOperation(String(row.op_id))); }
      catch (error) { warn("[cross-store-reconcile-operation]", error?.message || error); }
    }
    return operations;
  }

  function retryOperation(operationId) {
    requireReady();
    const timestamp = isoNow(now);
    mainDb.exec("BEGIN IMMEDIATE");
    try {
      const row = mainDb.prepare(`
        SELECT i.aggregate_key, s.status, s.version
        FROM cross_store_intents i
        JOIN cross_store_operation_state s ON s.op_id = i.op_id
        WHERE i.op_id = ?
      `).get(String(operationId || ""));
      if (!row) {
        mainDb.exec("COMMIT");
        return null;
      }
      if (row.status !== "blocked") {
        const error = new Error("只有已阻断的人物资料任务可以重试");
        error.code = "ACTOR_PROFILE_RETRY_NOT_BLOCKED";
        error.statusCode = 409;
        throw error;
      }
      const missingReservation = mainDb.prepare(`
        SELECT intent.aggregate_key
        FROM cross_store_intent_reservations intent
        LEFT JOIN cross_store_aggregate_reservations active
          ON active.aggregate_key = intent.aggregate_key AND active.op_id = intent.op_id
        WHERE intent.op_id = ? AND active.op_id IS NULL
        LIMIT 1
      `).get(String(operationId));
      if (missingReservation) {
        const error = new Error("已阻断任务的 reservation 丢失，拒绝重试");
        error.code = "ACTOR_PROFILE_RESERVATION_LOST";
        error.statusCode = 409;
        throw error;
      }
      const changed = mainDb.prepare(`
        UPDATE cross_store_operation_state
        SET status = 'retry_wait', lease_owner = NULL, lease_until = NULL,
            next_attempt_at = NULL, last_error = NULL, updated_at = ?, completed_at = NULL, version = version + 1
        WHERE op_id = ? AND status = 'blocked' AND version = ?
      `).run(timestamp, String(operationId), row.version);
      if (Number(changed.changes) !== 1) throw leaseLostError(operationId);
      mainDb.exec("COMMIT");
    } catch (error) {
      try { mainDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return processOperation(String(operationId));
  }

  function schedule() {
    if (!autoReconcile || timer) return;
    timer = setInterval(() => {
      try { reconcilePending(); } catch (error) { warn("[cross-store-reconcile]", error?.message || error); }
    }, reconcileIntervalMs);
    timer.unref?.();
  }

  function start() {
    if (ready) return;
    try {
      mainDb = createDatabase(mainDbPath);
      imageDb = createDatabase(imageDbPath);
      configureDurableConnection(mainDb, busyTimeoutMs);
      configureDurableConnection(imageDb, busyTimeoutMs);
      ensureMainSchema(mainDb);
      ensureImageSchema(imageDb);
      started = true;
      const timestamp = isoNow(now);
      mainDb.prepare(`
        UPDATE cross_store_operation_state
        SET status = 'retry_wait', lease_owner = NULL, lease_until = NULL,
            next_attempt_at = NULL, updated_at = ?, version = version + 1
        WHERE status = 'applying' AND lease_owner IS NOT NULL AND lease_until <= ?
      `).run(timestamp, timestamp);
      reconcilePending();
      ready = true;
      schedule();
    } catch (error) {
      started = false;
      ready = false;
      try { imageDb?.close(); } catch {}
      try { mainDb?.close(); } catch {}
      imageDb = null;
      mainDb = null;
      throw error;
    }
  }

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    ready = false;
    started = false;
    try { imageDb?.close(); } finally {
      imageDb = null;
      try { mainDb?.close(); } finally { mainDb = null; }
    }
  }

  return {
    close,
    getOperation,
    isReady: () => ready,
    reconcilePending,
    retryOperation,
    start,
    submit
  };
}

export const CROSS_STORE_TERMINAL_STATUSES = Object.freeze([...TERMINAL_STATUSES]);
export const CROSS_STORE_RETRYABLE_STATUSES = Object.freeze([...RETRYABLE_STATUSES]);
