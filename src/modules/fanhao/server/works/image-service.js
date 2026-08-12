import { hasActorProfilePublicationReadModel } from "../people/actor-profile-publication-schema.js";

const WORK_COVER_METADATA_BATCH_SIZE = 200;

export function createWorkImageService({
  getCoreDb,
  getPersonById,
  getStamp,
  getWorkById,
  hasCoreDb,
  proxiedRemoteImageUrl
}) {
  let localWorkCoreCoverCache = null;
  let workCoverMetadataCache = null;

  function coreImageUrl(row) {
    if (!row) return "";
    if (row.actor_profile_operation_id && (row.image_blob || row.has_image_blob)) {
      return `/media/actor/${encodeURIComponent(String(row.owner_id))}/avatar?v=${encodeURIComponent(row.actor_profile_operation_id)}`;
    }
    if (row.image_blob || row.has_image_blob) return `/media/core-image/${encodeURIComponent(String(row.id))}?v=${encodeURIComponent(row.updated_at || "")}`;
    if (row.remote_url) return proxiedRemoteImageUrl(row.remote_url) || row.remote_url || "";
    if (row.local_path) return row.local_path;
    return "";
  }

  function corePersonAvatarMetadataRow(personId) {
    const coreId = Number(personId);
    if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
    try {
      const db = getCoreDb();
      if (hasActorProfilePublicationReadModel(db)) {
        return db
          .prepare(
            `
            WITH avatar_candidates AS (
              SELECT image.id, image.owner_id, image.remote_url, image.local_path,
                     image.source, image.updated_at, image.legacy_key,
                     image.image_blob IS NOT NULL AS has_image_blob,
                     NULL AS actor_profile_operation_id
              FROM fanhao_images.images image
              WHERE image.owner_type = 'person' AND image.owner_id = ? AND image.kind = 'avatar'
              UNION ALL
              SELECT stage.operation_id AS id, stage.person_id AS owner_id, stage.remote_url, stage.local_path,
                     stage.source, stage.updated_at, stage.legacy_key,
                     stage.image_blob IS NOT NULL AS has_image_blob,
                     stage.operation_id AS actor_profile_operation_id
              FROM actor_profile_publications publication
              JOIN cross_store_operation_state state
                ON state.op_id = publication.operation_id AND state.status = 'completed'
              JOIN cross_store_main_receipts receipt
                ON receipt.op_id = publication.operation_id
               AND receipt.step = 'visibility_switch'
               AND receipt.intent_sha256 = publication.intent_sha256
              JOIN fanhao_images.actor_profile_image_staging stage
                ON stage.operation_id = publication.operation_id
               AND stage.person_id = publication.person_id
               AND stage.intent_sha256 = publication.intent_sha256
              LEFT JOIN actor_profile_image_revocations revocation
                ON revocation.operation_id = publication.operation_id
               AND revocation.person_id = publication.person_id
               AND revocation.intent_sha256 = publication.intent_sha256
              WHERE publication.person_id = ?
                AND revocation.operation_id IS NULL
            )
            SELECT * FROM avatar_candidates
            ORDER BY
              CASE
                WHEN source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
                WHEN source = 'actor_profiles' THEN 1
                ELSE 2
              END,
              CASE WHEN actor_profile_operation_id IS NOT NULL THEN 0 ELSE 1 END,
              CASE WHEN has_image_blob THEN 0 ELSE 1 END,
              updated_at DESC,
              id ASC
            LIMIT 1
            `
          )
          .get(coreId, coreId) || null;
      }
      return db
        .prepare(
          `
          SELECT id, owner_id, remote_url, local_path, source, updated_at, legacy_key,
                 image_blob IS NOT NULL AS has_image_blob
          FROM fanhao_images.images
          WHERE owner_type = 'person'
            AND owner_id = ?
            AND kind = 'avatar'
          ORDER BY
            CASE
              WHEN source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
              WHEN source = 'actor_profiles' THEN 1
              ELSE 2
            END,
            CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END,
            updated_at DESC,
            id ASC
          LIMIT 1
          `
        )
        .get(coreId) || null;
    } catch (error) {
      console.warn("[core-image]", error.message);
      return null;
    }
  }

  function corePersonAvatarRow(personId, options = {}) {
    const coreId = Number(personId);
    if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
    const source = String(options.source || "").trim();
    try {
      const db = getCoreDb();
      if (hasActorProfilePublicationReadModel(db)) {
        const params = [Number(coreId), Number(coreId)];
        if (source) params.push(source);
        return db
          .prepare(
            `
            WITH avatar_candidates AS (
              SELECT image.id, image.owner_type, image.owner_id, image.kind, image.source_type,
                     image.local_path, image.remote_url, image.storage_path, image.mime, image.image_blob,
                     image.width, image.height, image.byte_size, image.sort_order, image.status, image.error,
                     image.source, image.legacy_table, image.legacy_key, image.created_at, image.updated_at,
                     NULL AS actor_profile_operation_id
              FROM fanhao_images.images image
              WHERE image.owner_type = 'person' AND image.owner_id = ? AND image.kind = 'avatar'
              UNION ALL
              SELECT NULL AS id, 'person' AS owner_type, stage.person_id AS owner_id, 'avatar' AS kind, stage.source_type,
                     stage.local_path, stage.remote_url, NULL AS storage_path, stage.mime, stage.image_blob,
                     NULL AS width, NULL AS height, stage.byte_size, 0 AS sort_order, stage.status, NULL AS error,
                     stage.source, 'actor_profile_staging' AS legacy_table, stage.legacy_key, stage.created_at, stage.updated_at,
                     stage.operation_id AS actor_profile_operation_id
              FROM actor_profile_publications publication
              JOIN cross_store_operation_state state
                ON state.op_id = publication.operation_id AND state.status = 'completed'
              JOIN cross_store_main_receipts receipt
                ON receipt.op_id = publication.operation_id
               AND receipt.step = 'visibility_switch'
               AND receipt.intent_sha256 = publication.intent_sha256
              JOIN fanhao_images.actor_profile_image_staging stage
                ON stage.operation_id = publication.operation_id
               AND stage.person_id = publication.person_id
               AND stage.intent_sha256 = publication.intent_sha256
              LEFT JOIN actor_profile_image_revocations revocation
                ON revocation.operation_id = publication.operation_id
               AND revocation.person_id = publication.person_id
               AND revocation.intent_sha256 = publication.intent_sha256
              WHERE publication.person_id = ?
                AND revocation.operation_id IS NULL
            )
            SELECT * FROM avatar_candidates
            WHERE 1 = 1 ${source ? "AND source = ?" : ""}
            ORDER BY
              CASE
                WHEN source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
                WHEN source = 'actor_profiles' THEN 1
                ELSE 2
              END,
              CASE WHEN actor_profile_operation_id IS NOT NULL THEN 0 ELSE 1 END,
              CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END,
              updated_at DESC,
              COALESCE(id, actor_profile_operation_id) ASC
            LIMIT 1
            `
          )
          .get(...params) || null;
      }
      const params = [Number(coreId)];
      if (source) params.push(source);
      return db
        .prepare(
          `
          SELECT *
          FROM fanhao_images.images
          WHERE owner_type = 'person'
            AND owner_id = ?
            AND kind = 'avatar'
            ${source ? "AND source = ?" : ""}
          ORDER BY
            CASE
              WHEN source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
              WHEN source = 'actor_profiles' THEN 1
              ELSE 2
            END,
            CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END,
            updated_at DESC,
            id ASC
          LIMIT 1
          `
        )
        .get(...params) || null;
    } catch (error) {
      console.warn("[core-image]", error.message);
      return null;
    }
  }

  function publicPersonAvatar(personId) {
    const row = corePersonAvatarMetadataRow(personId);
    const avatarUrl = coreImageUrl(row);
    if (!row || !avatarUrl) return null;
    return {
      personId: String(personId || ""),
      avatarUrl,
      sourceAvatarUrl: row.remote_url || row.local_path || "",
      source: row.source || "",
      updatedAt: row.updated_at || "",
      coverWorkId: row.source === "manual_person_cover" ? String(row.legacy_key || "") : ""
    };
  }

  function coreWorkCoverMetadataRow(workId) {
    const normalizedId = normalizeWorkId(workId);
    if (!normalizedId) return null;
    return prewarmCoreWorkCoverMetadata([normalizedId]).get(normalizedId) || null;
  }

  function ensureWorkCoverMetadataCache() {
    const stamp = getStamp();
    if (workCoverMetadataCache?.stamp !== stamp) {
      workCoverMetadataCache = { stamp, rows: new Map() };
    }
    return workCoverMetadataCache;
  }

  function normalizeWorkId(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? String(number) : "";
  }

  function prewarmCoreWorkCoverMetadata(workIds = []) {
    const cache = ensureWorkCoverMetadataCache();
    const pending = [...new Set((Array.isArray(workIds) ? workIds : [])
      .map(normalizeWorkId)
      .filter((workId) => workId && !cache.rows.has(workId)))];
    if (!pending.length) return cache.rows;

    for (let offset = 0; offset < pending.length; offset += WORK_COVER_METADATA_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + WORK_COVER_METADATA_BATCH_SIZE);
      if (hasCoreDb()) {
        try {
          const placeholders = batch.map(() => "?").join(", ");
          const rows = getCoreDb()
            .prepare(
              `
              SELECT id, CAST(owner_id AS TEXT) AS work_id, owner_id, remote_url, local_path, source, updated_at,
                     image_blob IS NOT NULL AS has_image_blob
              FROM fanhao_images.images
              WHERE owner_type = 'work'
                AND owner_id IN (${placeholders})
                AND kind = 'cover'
              ORDER BY owner_id ASC, CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END, sort_order ASC, id ASC
              `
            )
            .all(...batch.map(Number));
          for (const row of rows) {
            if (!cache.rows.has(row.work_id)) cache.rows.set(row.work_id, row);
          }
        } catch (error) {
          console.warn("[core-image]", error.message);
        }
      }
      for (const workId of batch) {
        if (!cache.rows.has(workId)) cache.rows.set(workId, null);
      }
    }

    return cache.rows;
  }

  function prewarmCoreWorkCovers(works = []) {
    return prewarmCoreWorkCoverMetadata((Array.isArray(works) ? works : []).map((work) => work?.id));
  }

  function coreWorkCoverRow(workId) {
    const coreId = Number(workId);
    if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
    try {
      return getCoreDb()
        .prepare(
          `
          SELECT *
          FROM fanhao_images.images
          WHERE owner_type = 'work'
            AND owner_id = ?
            AND kind = 'cover'
          ORDER BY CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END, sort_order ASC, id ASC
          LIMIT 1
          `
        )
        .get(Number(coreId)) || null;
    } catch (error) {
      console.warn("[core-image]", error.message);
      return null;
    }
  }

  function publicCoreWorkCover(workId) {
    const row = coreWorkCoverMetadataRow(workId);
    const coverUrl = coreImageUrl(row);
    if (!row || !coverUrl) return null;
    return {
      workId: String(workId || ""),
      coverUrl,
      sourceCoverUrl: row.remote_url || row.local_path || "",
      source: row.source || "",
      updatedAt: row.updated_at || ""
    };
  }

  function localWorkCoreCoverStates() {
    const stamp = getStamp();
    if (localWorkCoreCoverCache?.stamp === stamp) return localWorkCoreCoverCache.states;
    const states = new Map();
    if (hasCoreDb()) {
      try {
        for (const row of getCoreDb()
          .prepare(
            `
            SELECT
              CAST(lw.work_id AS TEXT) AS work_id,
              EXISTS (
                SELECT 1
                FROM fanhao_images.images i
                WHERE i.owner_type = 'work'
                  AND i.owner_id = lw.work_id
                  AND i.kind = 'cover'
              ) AS has_cover
            FROM local_works lw
            `
          )
          .all()) {
          states.set(row.work_id, Boolean(row.has_cover));
        }
      } catch (error) {
        console.warn("[core-image]", error.message);
        if (localWorkCoreCoverCache?.states) return localWorkCoreCoverCache.states;
      }
    }
    localWorkCoreCoverCache = { stamp, states };
    return states;
  }

  function workHasCoreCover(workId) {
    return localWorkCoreCoverStates().get(String(workId || "")) === true;
  }

  function invalidate() {
    localWorkCoreCoverCache = null;
    workCoverMetadataCache = null;
  }

  function coreImageRow(imageId) {
    if (!hasCoreDb()) return null;
    try {
      return getCoreDb().prepare("SELECT * FROM fanhao_images.images WHERE id = ?").get(Number(imageId)) || null;
    } catch (error) {
      console.warn("[core-image]", error.message);
      return null;
    }
  }

  function workCoverRow(workId) {
    const coreRow = coreWorkCoverRow(workId);
    if (!coreRow?.image_blob) return null;
    const work = getWorkById(workId);
    const person = work?.personId ? getPersonById(work.personId) : null;
    return {
      work_id: work?.id || String(workId || ""),
      person_id: work?.personId || "",
      person_name: person?.name || "",
      video_id: work?.videos?.[0]?.id || "",
      title: work?.title || "",
      cover_url: coreRow.remote_url || coreRow.local_path || "",
      cover_mime: coreRow.mime || "image/jpeg",
      cover_blob: coreRow.image_blob,
      source: coreRow.source || "",
      fetched_at: coreRow.created_at || "",
      updated_at: coreRow.updated_at || ""
    };
  }

  function publicWorkCover(row) {
    if (!row?.cover_blob) return null;

    const coreRow = coreWorkCoverRow(row.work_id);
    const coverUrl = coreImageUrl(coreRow) || `/media/work/${encodeURIComponent(row.work_id)}/cover?v=${encodeURIComponent(row.updated_at || "")}`;
    return {
      workId: String(row.work_id || ""),
      personId: String(row.person_id || ""),
      videoId: row.video_id || "",
      title: row.title || "",
      coverUrl,
      sourceCoverUrl: row.cover_url || "",
      source: row.source || "",
      fetchedAt: row.fetched_at || "",
      updatedAt: row.updated_at || ""
    };
  }

  return {
    coreImageRow,
    coreImageUrl,
    corePersonAvatarRow,
    corePersonAvatarMetadataRow,
    coreWorkCoverRow,
    coreWorkCoverMetadataRow,
    invalidate,
    prewarmCoreWorkCoverMetadata,
    prewarmCoreWorkCovers,
    publicCoreWorkCover,
    publicPersonAvatar,
    publicWorkCover,
    workCoverRow,
    workHasCoreCover
  };
}
