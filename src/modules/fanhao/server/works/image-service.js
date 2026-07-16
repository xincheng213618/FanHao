export function createWorkImageService({
  getCoreDb,
  getPersonById,
  getStamp,
  getWorkById,
  hasCoreDb,
  proxiedRemoteImageUrl
}) {
  let localWorkCoreCoverCache = null;

  function coreImageUrl(row) {
    if (!row) return "";
    if (row.image_blob || row.has_image_blob) return `/media/core-image/${encodeURIComponent(String(row.id))}?v=${encodeURIComponent(row.updated_at || "")}`;
    if (row.remote_url) return proxiedRemoteImageUrl(row.remote_url) || row.remote_url || "";
    if (row.local_path) return row.local_path;
    return "";
  }

  function corePersonAvatarMetadataRow(personId) {
    const coreId = Number(personId);
    if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
    try {
      return getCoreDb()
        .prepare(
          `
          SELECT id, owner_id, remote_url, local_path, source, updated_at, legacy_key,
                 image_blob IS NOT NULL AS has_image_blob
          FROM images
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
      const params = [Number(coreId)];
      if (source) params.push(source);
      return getCoreDb()
        .prepare(
          `
          SELECT *
          FROM images
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
    const coreId = Number(workId);
    if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
    try {
      return getCoreDb()
        .prepare(
          `
          SELECT id, owner_id, remote_url, local_path, source, updated_at,
                 image_blob IS NOT NULL AS has_image_blob
          FROM images
          WHERE owner_type = 'work'
            AND owner_id = ?
            AND kind = 'cover'
          ORDER BY CASE WHEN image_blob IS NOT NULL THEN 0 ELSE 1 END, sort_order ASC, id ASC
          LIMIT 1
          `
        )
        .get(coreId) || null;
    } catch (error) {
      console.warn("[core-image]", error.message);
      return null;
    }
  }

  function coreWorkCoverRow(workId) {
    const coreId = Number(workId);
    if (!Number.isFinite(coreId) || !hasCoreDb()) return null;
    try {
      return getCoreDb()
        .prepare(
          `
          SELECT *
          FROM images
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
                FROM images i
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

  function coreImageRow(imageId) {
    if (!hasCoreDb()) return null;
    try {
      return getCoreDb().prepare("SELECT * FROM images WHERE id = ?").get(Number(imageId)) || null;
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
    publicCoreWorkCover,
    publicPersonAvatar,
    publicWorkCover,
    workCoverRow,
    workHasCoreCover
  };
}
