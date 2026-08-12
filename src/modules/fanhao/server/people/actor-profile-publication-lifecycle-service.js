import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ACTOR_PROFILE_REVOCATION_AUDIT_VERSION,
  ACTOR_PROFILE_REVOCATION_CALLER,
  ensureActorProfileImageStagingTable,
  ensureActorProfilePublicationTable
} from "./actor-profile-publication-schema.js";

const DEFAULT_GC_BATCH_SIZE = 50;
const MAX_GC_BATCH_SIZE = 50;
const DEFAULT_GC_MAX_BYTES = 64 * 1024 * 1024;
const MAX_GC_MAX_BYTES = 64 * 1024 * 1024;
const ACTIVE_OPERATION_STATUSES = new Set(["prepared", "applying", "retry_wait", "blocked"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function configureDurableConnection(db, busyTimeoutMs) {
  db.exec(`
    PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) || 0)};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
  `);
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeReason(value) {
  const text = String(value || "").trim().replace(/[\u0000-\u001f\u007f]+/g, " ");
  const bounded = text.slice(0, 80);
  if (!bounded) return "manual";
  if (!/^[\p{L}\p{N}_ -]+$/u.test(bounded)) return "manual-redacted";
  if (/\b(?:busy|database|error|exception|ioerr|locked|sqlite|errno|stack|traceback)\b/i.test(bounded)) return "manual-redacted";
  if (/(?:数据库|文件路径|堆栈|错误|异常|锁定)/u.test(bounded)) return "manual-redacted";
  return bounded;
}

function tombstoneSha256({
  auditVersion = 1,
  caller = "",
  intentSha256,
  operationId,
  personId,
  reason,
  requestId = "",
  revokedAt
}) {
  const record = {
    intentSha256: String(intentSha256),
    operationId: String(operationId),
    personId: Number(personId),
    reason: String(reason),
    revokedAt: String(revokedAt)
  };
  if (Number(auditVersion) >= ACTOR_PROFILE_REVOCATION_AUDIT_VERSION) {
    record.auditVersion = ACTOR_PROFILE_REVOCATION_AUDIT_VERSION;
    record.caller = String(caller);
    record.requestId = String(requestId);
  }
  return sha256(JSON.stringify(record));
}

function rollbackQuietly(db) {
  try { db.exec("ROLLBACK"); } catch {}
}

function lifecycleError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isBusyError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
  return text.includes("SQLITE_BUSY") || text.includes("DATABASE IS LOCKED") || text.includes("DATABASE TABLE IS LOCKED");
}

function publicBusyError(cause) {
  const error = lifecycleError("ACTOR_PROFILE_LIFECYCLE_BUSY", "人物头像撤销服务暂时繁忙，请稍后重试", 503);
  error.retryable = true;
  error.cause = cause;
  return error;
}

function publicLimitations() {
  return {
    browserCacheRecall: false,
    forensicErasure: false,
    retainedMetadata: ["intent", "mainReceipt", "imageReceipt", "revocation", "gcReceipt"]
  };
}

export function createActorProfilePublicationLifecycleService({
  autoDrainOnStart = true,
  batchSize = DEFAULT_GC_BATCH_SIZE,
  boundaryHook = () => {},
  busyTimeoutMs = 250,
  createDatabase = (filePath) => new DatabaseSync(filePath),
  generateRequestId = randomUUID,
  imageDbPath,
  mainDbPath,
  maxBatchBytes = DEFAULT_GC_MAX_BYTES,
  now = Date.now,
  onChanged = () => {},
  warn = console.warn
}) {
  const configuredBatchSize = boundedPositiveInteger(batchSize, DEFAULT_GC_BATCH_SIZE, MAX_GC_BATCH_SIZE);
  const configuredMaxBytes = boundedPositiveInteger(maxBatchBytes, DEFAULT_GC_MAX_BYTES, MAX_GC_MAX_BYTES);
  const deleteAuthorizations = new Map();
  const revokeAuthorizations = new Map();
  let imageDb = null;
  let mainDb = null;
  let mainAttachedToImage = false;
  let ready = false;
  let scheduled = null;

  function requireReady() {
    if (ready) return;
    throw lifecycleError("ACTOR_PROFILE_LIFECYCLE_NOT_READY", "人物头像撤销服务尚未就绪", 503);
  }

  function notifyChanged() {
    try { onChanged(); } catch (error) { warn("[actor-profile-publication-invalidate]", error?.message || error); }
  }

  function installDeleteAuthorizationFunction() {
    imageDb.function("fanhao_actor_profile_gc_authorized", { deterministic: false }, (
      operationId,
      personId,
      intentSha256,
      tombstoneDigest,
      contentSha256,
      byteSize
    ) => {
      const expected = deleteAuthorizations.get(String(operationId));
      return expected
        && Number(expected.personId) === Number(personId)
        && String(expected.intentSha256) === String(intentSha256)
        && String(expected.tombstoneSha256) === String(tombstoneDigest)
        && String(expected.contentSha256) === String(contentSha256)
        && Number(expected.byteSize) === Number(byteSize)
        ? 1
        : 0;
    });
  }

  function installRevokeAuthorizationFunction() {
    mainDb.function("fanhao_actor_profile_revoke_authorized", { deterministic: false }, (
      operationId,
      personId,
      intentSha256,
      reason,
      revokedAt,
      tombstoneDigest,
      requestId,
      caller,
      auditVersion
    ) => {
      const expected = revokeAuthorizations.get(String(operationId));
      return expected
        && Number(expected.personId) === Number(personId)
        && String(expected.intentSha256) === String(intentSha256)
        && String(expected.reason) === String(reason)
        && String(expected.revokedAt) === String(revokedAt)
        && String(expected.tombstoneSha256) === String(tombstoneDigest)
        && String(expected.requestId) === String(requestId)
        && String(expected.caller) === String(caller)
        && Number(expected.auditVersion) === Number(auditVersion)
        ? 1
        : 0;
    });
  }

  function ensureSchemas() {
    let migratedRevocationAudit = false;
    try {
      mainDb.exec("BEGIN IMMEDIATE");
      ({ migratedRevocationAudit } = ensureActorProfilePublicationTable(mainDb, {
        boundaryHook,
        generateRequestId
      }));
      mainDb.exec("COMMIT");
      if (migratedRevocationAudit) boundaryHook("revocation_audit_schema_committed");
    } catch (error) {
      rollbackQuietly(mainDb);
      throw isBusyError(error) ? publicBusyError(error) : error;
    }
    imageDb.exec("BEGIN IMMEDIATE");
    try {
      ensureActorProfileImageStagingTable(imageDb, "main");
      imageDb.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(imageDb);
      throw isBusyError(error) ? publicBusyError(error) : error;
    }
  }

  function start() {
    if (ready) return;
    let nextMainDb = null;
    let nextImageDb = null;
    try {
      nextMainDb = createDatabase(mainDbPath);
      nextImageDb = createDatabase(imageDbPath);
      configureDurableConnection(nextMainDb, busyTimeoutMs);
      configureDurableConnection(nextImageDb, busyTimeoutMs);
      mainDb = nextMainDb;
      imageDb = nextImageDb;
      installRevokeAuthorizationFunction();
      ensureSchemas();
      imageDb.prepare("ATTACH DATABASE ? AS fanhao_main").run(mainDbPath);
      mainAttachedToImage = true;
      installDeleteAuthorizationFunction();
      ready = true;
      if (autoDrainOnStart) scheduleGc();
    } catch (error) {
      ready = false;
      deleteAuthorizations.clear();
      revokeAuthorizations.clear();
      try { nextImageDb?.close(); } catch {}
      try { nextMainDb?.close(); } catch {}
      imageDb = null;
      mainDb = null;
      mainAttachedToImage = false;
      throw error;
    }
  }

  function close() {
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
    ready = false;
    deleteAuthorizations.clear();
    revokeAuthorizations.clear();
    try { imageDb?.close(); } finally {
      imageDb = null;
      mainAttachedToImage = false;
      try { mainDb?.close(); } finally { mainDb = null; }
    }
  }

  function readVersionForRevoke(operationId) {
    return mainDb.prepare(`
      SELECT intent.op_id AS operation_id, intent.intent_sha256, intent.payload_json,
             state.status, main_receipt.intent_sha256 AS main_receipt_sha256,
             revocation.person_id AS revoked_person_id,
             revocation.intent_sha256 AS revoked_intent_sha256,
              revocation.reason AS revoked_reason,
              revocation.revoked_at,
              revocation.tombstone_sha256,
              revocation.request_id AS revoked_request_id,
              revocation.caller AS revoked_caller,
              revocation.audit_version AS revoked_audit_version
      FROM cross_store_intents intent
      JOIN cross_store_operation_state state ON state.op_id = intent.op_id
      LEFT JOIN cross_store_main_receipts main_receipt
        ON main_receipt.op_id = intent.op_id
       AND main_receipt.step = 'visibility_switch'
      LEFT JOIN actor_profile_image_revocations revocation
        ON revocation.operation_id = intent.op_id
      WHERE intent.op_id = ? AND intent.kind = 'actor_profile_upsert'
    `).get(operationId);
  }

  function imageStageProof(operationId, personId, intentSha256) {
    return imageDb.prepare(`
      SELECT stage.operation_id, stage.person_id, stage.intent_sha256,
             image_receipt.intent_sha256 AS image_receipt_sha256
      FROM actor_profile_image_staging stage
      JOIN cross_store_receipts image_receipt
        ON image_receipt.op_id = stage.operation_id
       AND image_receipt.step = 'image_stage'
       AND image_receipt.kind = 'actor_profile_upsert'
       AND image_receipt.intent_sha256 = stage.intent_sha256
      WHERE stage.operation_id = ?
        AND stage.person_id = ?
        AND stage.intent_sha256 = ?
    `).get(operationId, personId, intentSha256);
  }

  function verifiedPersistedTombstone(row) {
    if (!row?.revoked_at) return null;
    const auditVersion = Number(row.revoked_audit_version || 1);
    const requestId = String(row.revoked_request_id || "");
    const caller = String(row.revoked_caller || "");
    const expected = tombstoneSha256({
      auditVersion,
      caller,
      intentSha256: row.revoked_intent_sha256,
      operationId: row.operation_id,
      personId: row.revoked_person_id,
      reason: row.revoked_reason,
      requestId,
      revokedAt: row.revoked_at
    });
    if (Number(row.revoked_person_id) <= 0
      || String(row.revoked_intent_sha256) !== String(row.intent_sha256)
      || ![1, ACTOR_PROFILE_REVOCATION_AUDIT_VERSION].includes(auditVersion)
      || !UUID_PATTERN.test(requestId)
      || caller !== ACTOR_PROFILE_REVOCATION_CALLER
      || String(row.tombstone_sha256) !== expected) {
      throw lifecycleError("ACTOR_PROFILE_REVOCATION_CONFLICT", "人物头像撤销记录与已完成版本不一致");
    }
    return {
      intentSha256: String(row.revoked_intent_sha256),
      operationId: String(row.operation_id),
      personId: Number(row.revoked_person_id),
      reason: String(row.revoked_reason),
      requestId,
      revokedAt: String(row.revoked_at),
      tombstoneSha256: String(row.tombstone_sha256),
      caller,
      auditVersion
    };
  }

  function revokeVersion(personIdInput, operationId, options = {}) {
    requireReady();
    const id = String(operationId || "").trim();
    const requestedPersonId = Number(personIdInput);
    if (!id) return null;
    if (!Number.isSafeInteger(requestedPersonId) || requestedPersonId <= 0) return null;
    let result = null;
    let changed = false;
    try {
      mainDb.exec("BEGIN IMMEDIATE");
      const row = readVersionForRevoke(id);
      if (!row) {
        mainDb.exec("COMMIT");
        return null;
      }
      if (String(row.status) !== "completed") {
        const active = ACTIVE_OPERATION_STATUSES.has(String(row.status));
        throw lifecycleError(
          active ? "ACTOR_PROFILE_OPERATION_ACTIVE" : "ACTOR_PROFILE_VERSION_NOT_COMPLETED",
          active ? "人物资料任务尚未完成，不能撤销头像版本" : "只有已完成的人物头像版本可以撤销"
        );
      }
      let payload = null;
      try { payload = JSON.parse(row.payload_json); } catch {}
      const personId = Number(payload?.personId);
      if (!payload?.hasAvatarMutation || !Number.isSafeInteger(personId) || personId <= 0) {
        throw lifecycleError("ACTOR_PROFILE_VERSION_HAS_NO_AVATAR", "该已完成任务没有可撤销的头像版本");
      }
      if (personId !== requestedPersonId) {
        throw lifecycleError("ACTOR_PROFILE_VERSION_PERSON_MISMATCH", "人物与头像版本不匹配", 404);
      }
      if (String(row.main_receipt_sha256 || "") !== String(row.intent_sha256)) {
        throw lifecycleError("ACTOR_PROFILE_REVOCATION_CONFLICT", "人物头像主库完成凭据不一致");
      }

      const persisted = verifiedPersistedTombstone(row);
      const stage = imageStageProof(id, personId, row.intent_sha256);
      if (!persisted && (!stage || String(stage.image_receipt_sha256) !== String(row.intent_sha256))) {
        throw lifecycleError("ACTOR_PROFILE_REVOCATION_CONFLICT", "人物头像图片库完成凭据或版本内容缺失");
      }
      const revokedAt = persisted?.revokedAt || isoNow(now);
      const reason = persisted?.reason || safeReason(options.reason);
      const requestId = persisted?.requestId || String(generateRequestId());
      const caller = persisted?.caller || ACTOR_PROFILE_REVOCATION_CALLER;
      const auditVersion = persisted?.auditVersion || ACTOR_PROFILE_REVOCATION_AUDIT_VERSION;
      if (!UUID_PATTERN.test(requestId) || caller !== ACTOR_PROFILE_REVOCATION_CALLER) {
        throw lifecycleError("ACTOR_PROFILE_REVOCATION_CONFLICT", "人物头像撤销审计身份无效");
      }
      const digest = persisted?.tombstoneSha256 || tombstoneSha256({
        auditVersion,
        caller,
        intentSha256: row.intent_sha256,
        operationId: id,
        personId,
        reason,
        requestId,
        revokedAt
      });
      if (!persisted) {
        const authorization = {
          auditVersion,
          caller,
          intentSha256: String(row.intent_sha256),
          personId,
          reason,
          requestId,
          revokedAt,
          tombstoneSha256: digest
        };
        revokeAuthorizations.set(id, authorization);
        try {
          mainDb.prepare(`
            INSERT INTO actor_profile_image_revocations(
              operation_id, person_id, intent_sha256, reason, revoked_at, tombstone_sha256,
              request_id, caller, audit_version, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id,
            personId,
            row.intent_sha256,
            reason,
            revokedAt,
            digest,
            requestId,
            caller,
            auditVersion,
            revokedAt
          );
        } finally {
          revokeAuthorizations.delete(id);
        }
        changed = true;
      }
      const current = mainDb.prepare(`
        SELECT person_id, intent_sha256
        FROM actor_profile_publications
        WHERE operation_id = ?
      `).get(id);
      if (current && (Number(current.person_id) !== personId || String(current.intent_sha256) !== String(row.intent_sha256))) {
        throw lifecycleError("ACTOR_PROFILE_REVOCATION_CONFLICT", "当前人物头像指针与待撤销版本不一致");
      }
      const cleared = mainDb.prepare(`
        DELETE FROM actor_profile_publications
        WHERE operation_id = ? AND person_id = ? AND intent_sha256 = ?
      `).run(id, personId, row.intent_sha256);
      boundaryHook("revoke_before_commit", { operationId: id, personId: String(personId) });
      mainDb.exec("COMMIT");
      changed ||= Number(cleared.changes) === 1;
      result = {
        ok: true,
        operationId: id,
        personId: String(personId),
        reason: safeReason(reason),
        revokedAt,
        alreadyRevoked: Boolean(persisted),
        wasCurrent: Number(cleared.changes) === 1,
        purgeStatus: stage ? "pending" : "completed",
        limitations: publicLimitations()
      };
      boundaryHook("revoke_committed", result);
    } catch (error) {
      rollbackQuietly(mainDb);
      throw isBusyError(error) ? publicBusyError(error) : error;
    }
    if (changed) notifyChanged();
    if (result.purgeStatus === "pending") scheduleGc();
    return result;
  }

  function pendingTombstones(limit) {
    if (!mainAttachedToImage) {
      imageDb.prepare("ATTACH DATABASE ? AS fanhao_main").run(mainDbPath);
      mainAttachedToImage = true;
    }
    return imageDb.prepare(`
        SELECT revocation.operation_id, revocation.person_id, revocation.intent_sha256,
               revocation.reason, revocation.revoked_at, revocation.tombstone_sha256
        FROM actor_profile_image_staging stage
        JOIN fanhao_main.actor_profile_image_revocations revocation
          ON revocation.operation_id = stage.operation_id
         AND revocation.person_id = stage.person_id
         AND revocation.intent_sha256 = stage.intent_sha256
        JOIN fanhao_main.cross_store_operation_state state
          ON state.op_id = revocation.operation_id AND state.status = 'completed'
        JOIN fanhao_main.cross_store_main_receipts receipt
          ON receipt.op_id = revocation.operation_id
         AND receipt.step = 'visibility_switch'
         AND receipt.intent_sha256 = revocation.intent_sha256
        LEFT JOIN fanhao_main.actor_profile_publications publication
          ON publication.operation_id = revocation.operation_id
        WHERE publication.operation_id IS NULL
        ORDER BY revocation.revoked_at, revocation.operation_id
        LIMIT ?
      `).all(limit);
  }

  function stageForGc(tombstone) {
    const row = imageDb.prepare(`
      SELECT operation_id, person_id, intent_sha256, image_blob,
             COALESCE(byte_size, length(image_blob), 0) AS byte_size
      FROM actor_profile_image_staging
      WHERE operation_id = ?
    `).get(tombstone.operation_id);
    if (!row) return null;
    if (Number(row.person_id) !== Number(tombstone.person_id)
      || String(row.intent_sha256) !== String(tombstone.intent_sha256)) {
      throw lifecycleError("ACTOR_PROFILE_REVOCATION_CONFLICT", "撤销记录与图片库暂存版本不一致");
    }
    const buffer = Buffer.from(row.image_blob || []);
    const declaredByteSize = Math.max(0, Number(row.byte_size || 0));
    if (!Number.isSafeInteger(declaredByteSize) || declaredByteSize !== buffer.byteLength) {
      throw lifecycleError("ACTOR_PROFILE_GC_RECEIPT_CONFLICT", "人物头像暂存内容长度不一致");
    }
    return {
      ...tombstone,
      byteSize: buffer.byteLength,
      contentSha256: sha256(buffer)
    };
  }

  function verifyTombstoneForGc(candidate) {
    const row = mainDb.prepare(`
      SELECT revocation.person_id, revocation.intent_sha256, revocation.reason,
             revocation.revoked_at, revocation.tombstone_sha256,
             revocation.request_id, revocation.caller, revocation.audit_version,
             publication.operation_id AS current_operation_id
      FROM actor_profile_image_revocations revocation
      LEFT JOIN actor_profile_publications publication
        ON publication.operation_id = revocation.operation_id
      WHERE revocation.operation_id = ?
    `).get(candidate.operation_id);
    if (!row || row.current_operation_id
      || Number(row.person_id) !== Number(candidate.person_id)
      || String(row.intent_sha256) !== String(candidate.intent_sha256)
      || String(row.tombstone_sha256) !== String(candidate.tombstone_sha256)
      || String(row.tombstone_sha256) !== tombstoneSha256({
        auditVersion: row.audit_version,
        caller: row.caller,
        intentSha256: row.intent_sha256,
        operationId: candidate.operation_id,
        personId: row.person_id,
        reason: row.reason,
        requestId: row.request_id,
        revokedAt: row.revoked_at
      })) {
      throw lifecycleError("ACTOR_PROFILE_REVOCATION_CONFLICT", "人物头像撤销凭据已变化，拒绝回收");
    }
  }

  function drainRevoked(options = {}) {
    requireReady();
    try {
      return drainRevokedInternal(options);
    } catch (error) {
      throw isBusyError(error) ? publicBusyError(error) : error;
    }
  }

  function drainRevokedInternal(options = {}) {
    const limit = boundedPositiveInteger(options.limit, configuredBatchSize, MAX_GC_BATCH_SIZE);
    const maxBytes = boundedPositiveInteger(options.maxBytes, configuredMaxBytes, MAX_GC_MAX_BYTES);
    const tombstones = pendingTombstones(limit);
    const candidates = [];
    let selectedBytes = 0;
    for (const tombstone of tombstones) {
      const candidate = stageForGc(tombstone);
      if (!candidate) continue;
      if (selectedBytes + candidate.byteSize > maxBytes) continue;
      candidates.push(candidate);
      selectedBytes += candidate.byteSize;
    }
    if (!candidates.length) {
      return {
        ok: true,
        selected: 0,
        selectedBytes: 0,
        deleted: 0,
        deletedBytes: 0,
        pending: tombstones.length,
        limitations: publicLimitations()
      };
    }
    for (const candidate of candidates) verifyTombstoneForGc(candidate);

    let deleted = 0;
    let deletedBytes = 0;
    imageDb.exec("DETACH DATABASE fanhao_main");
    mainAttachedToImage = false;
    imageDb.exec("BEGIN IMMEDIATE");
    try {
      const findStage = imageDb.prepare(`
        SELECT person_id, intent_sha256, image_blob,
               COALESCE(byte_size, length(image_blob), 0) AS byte_size
        FROM actor_profile_image_staging
        WHERE operation_id = ?
      `);
      const findReceipt = imageDb.prepare(`
        SELECT person_id, intent_sha256, tombstone_sha256, content_sha256, byte_size
        FROM actor_profile_image_gc_receipts
        WHERE operation_id = ?
      `);
      const insertReceipt = imageDb.prepare(`
        INSERT INTO actor_profile_image_gc_receipts(
          operation_id, person_id, intent_sha256, tombstone_sha256,
          content_sha256, byte_size, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const deleteStage = imageDb.prepare(`
        DELETE FROM actor_profile_image_staging
        WHERE operation_id = ? AND person_id = ? AND intent_sha256 = ?
      `);
      boundaryHook("gc_before_receipt", { count: candidates.length, selectedBytes });
      for (const candidate of candidates) {
        const stage = findStage.get(candidate.operation_id);
        if (!stage) continue;
        const buffer = Buffer.from(stage.image_blob || []);
        const declaredByteSize = Math.max(0, Number(stage.byte_size || 0));
        if (!Number.isSafeInteger(declaredByteSize) || declaredByteSize !== buffer.byteLength) {
          throw lifecycleError("ACTOR_PROFILE_GC_RECEIPT_CONFLICT", "人物头像暂存内容长度不一致");
        }
        const currentProof = {
          byteSize: buffer.byteLength,
          contentSha256: sha256(buffer),
          intentSha256: String(stage.intent_sha256),
          personId: Number(stage.person_id),
          tombstoneSha256: String(candidate.tombstone_sha256)
        };
        if (currentProof.personId !== Number(candidate.person_id)
          || currentProof.intentSha256 !== String(candidate.intent_sha256)
          || currentProof.byteSize !== Number(candidate.byteSize)
          || currentProof.contentSha256 !== String(candidate.contentSha256)) {
          throw lifecycleError("ACTOR_PROFILE_GC_RECEIPT_CONFLICT", "待回收人物头像内容已变化");
        }
        deleteAuthorizations.set(String(candidate.operation_id), currentProof);
        try {
          const receipt = findReceipt.get(candidate.operation_id);
          if (receipt) {
            if (Number(receipt.person_id) !== currentProof.personId
              || String(receipt.intent_sha256) !== currentProof.intentSha256
              || String(receipt.tombstone_sha256) !== currentProof.tombstoneSha256
              || String(receipt.content_sha256) !== currentProof.contentSha256
              || Number(receipt.byte_size) !== currentProof.byteSize) {
              throw lifecycleError("ACTOR_PROFILE_GC_RECEIPT_CONFLICT", "人物头像回收凭据与暂存内容不一致");
            }
          } else {
            insertReceipt.run(
              candidate.operation_id,
              currentProof.personId,
              currentProof.intentSha256,
              currentProof.tombstoneSha256,
              currentProof.contentSha256,
              currentProof.byteSize,
              isoNow(now)
            );
          }
          boundaryHook("gc_after_receipt", { operationId: String(candidate.operation_id) });
          const removed = deleteStage.run(candidate.operation_id, currentProof.personId, currentProof.intentSha256);
          if (Number(removed.changes) !== 1) throw lifecycleError("ACTOR_PROFILE_GC_RECEIPT_CONFLICT", "人物头像暂存内容未按回收凭据删除");
        } finally {
          deleteAuthorizations.delete(String(candidate.operation_id));
        }
        deleted += 1;
        deletedBytes += currentProof.byteSize;
        boundaryHook("gc_after_delete", { operationId: String(candidate.operation_id) });
      }
      boundaryHook("gc_before_commit", { deleted, deletedBytes });
      imageDb.exec("COMMIT");
      boundaryHook("gc_committed", { deleted, deletedBytes });
    } catch (error) {
      deleteAuthorizations.clear();
      rollbackQuietly(imageDb);
      throw error;
    } finally {
      if (!mainAttachedToImage) {
        imageDb.prepare("ATTACH DATABASE ? AS fanhao_main").run(mainDbPath);
        mainAttachedToImage = true;
      }
    }
    return {
      ok: true,
      selected: candidates.length,
      selectedBytes,
      deleted,
      deletedBytes,
      pending: Math.max(0, tombstones.length - deleted),
      limitations: publicLimitations()
    };
  }

  function scheduleGc() {
    if (!ready || scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      try { drainRevoked(); } catch (error) { warn("[actor-profile-publication-gc]", error?.message || error); }
    }, 0);
    scheduled.unref?.();
  }

  return {
    close,
    drainRevoked,
    isReady: () => ready,
    revokeVersion,
    scheduleGc,
    start
  };
}

export const ACTOR_PROFILE_PUBLICATION_GC_DEFAULTS = Object.freeze({
  batchSize: DEFAULT_GC_BATCH_SIZE,
  maxBatchBytes: DEFAULT_GC_MAX_BYTES,
  retentionEnabled: false
});
