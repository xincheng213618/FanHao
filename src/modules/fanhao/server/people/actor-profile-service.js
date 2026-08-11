import { hasActorProfilePublicationReadModel } from "./actor-profile-publication-schema.js";

const PUBLISHED_PROFILE_ROWS_SQL = `
  WITH avatar_candidates AS (
    SELECT CAST(image.id AS TEXT) AS stable_id, image.id AS image_id, image.owner_id,
           image.remote_url, image.local_path, image.mime, image.source, image.updated_at,
           image.legacy_key, image.image_blob IS NOT NULL AS has_image_blob,
           NULL AS actor_profile_operation_id
    FROM fanhao_images.images image
    WHERE image.owner_type = 'person' AND image.kind = 'avatar'
    UNION ALL
    SELECT stage.operation_id AS stable_id, NULL AS image_id, stage.person_id AS owner_id,
           stage.remote_url, stage.local_path, stage.mime, stage.source, stage.updated_at,
           stage.legacy_key, stage.image_blob IS NOT NULL AS has_image_blob,
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
  ),
  ranked_avatars AS (
    SELECT avatar_candidates.*,
           ROW_NUMBER() OVER (
             PARTITION BY owner_id
             ORDER BY
               CASE
                 WHEN source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
                 WHEN source = 'actor_profiles' THEN 1
                 ELSE 2
               END,
               CASE WHEN actor_profile_operation_id IS NOT NULL THEN 0 ELSE 1 END,
               CASE WHEN has_image_blob THEN 0 ELSE 1 END,
               updated_at DESC,
               image_id ASC,
               stable_id ASC
           ) AS avatar_rank
    FROM avatar_candidates
  )
  SELECT
    p.id AS core_person_id,
    CAST(p.id AS TEXT) AS person_id,
    p.name AS person_name,
    p.display_name,
    p.gender,
    p.movie_count,
    p.source,
    p.status,
    p.error,
    p.created_at AS fetched_at,
    p.updated_at,
    (
      SELECT json_group_array(json_object('actorId', pref.external_key, 'url', pref.url))
      FROM person_external_refs pref
      WHERE pref.person_id = p.id AND pref.provider = 'javdb-actor'
    ) AS javdb_refs_json,
    (
      SELECT pref.external_key FROM person_external_refs pref
      WHERE pref.person_id = p.id AND pref.provider = 'javdb-actor'
      ORDER BY pref.id LIMIT 1
    ) AS javdb_actor_id,
    (
      SELECT pref.url FROM person_external_refs pref
      WHERE pref.person_id = p.id AND pref.provider = 'javdb-actor'
      ORDER BY pref.id LIMIT 1
    ) AS javdb_url,
    avatar.remote_url AS avatar_url,
    avatar.local_path AS avatar_local_path,
    avatar.mime AS avatar_mime,
    NULL AS avatar_blob,
    avatar.image_id AS avatar_image_id,
    avatar.has_image_blob AS avatar_has_image_blob,
    avatar.source AS avatar_source,
    avatar.updated_at AS avatar_updated_at,
    avatar.legacy_key AS avatar_legacy_key,
    avatar.actor_profile_operation_id AS avatar_operation_id,
    avatar.stable_id IS NOT NULL AS avatar_candidate_present,
    (
      SELECT json_group_array(alias) FROM person_aliases pa WHERE pa.person_id = p.id
    ) AS aliases_json
  FROM people p
  LEFT JOIN ranked_avatars avatar ON avatar.owner_id = p.id AND avatar.avatar_rank = 1
  WHERE EXISTS (SELECT 1 FROM person_external_refs pref WHERE pref.person_id = p.id AND pref.provider = 'javdb-actor')
     OR avatar.stable_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM person_aliases pa WHERE pa.person_id = p.id)
     OR COALESCE(NULLIF(LOWER(TRIM(p.gender)), ''), 'unknown') <> 'unknown'
`;

export function createActorProfileService({
  actorProfileAliases,
  actorProfileJavdbRefs,
  coreImageUrl,
  getCoreDb,
  getStamp,
  mergedPersonAliasNames,
  normalizePersonGender,
  preferredPersonDisplayName,
  uniquePersonNames
}) {
  let actorProfileCache = null;

  function rowsById() {
    const stamp = getStamp();
    if (actorProfileCache?.stamp === stamp) return actorProfileCache.rows;

    const rows = new Map();
    try {
      const db = getCoreDb();
      const query = hasActorProfilePublicationReadModel(db)
        ? PUBLISHED_PROFILE_ROWS_SQL
        : `
          SELECT
            p.id AS core_person_id,
            CAST(p.id AS TEXT) AS person_id,
            p.name AS person_name,
            p.display_name,
            p.gender,
            p.movie_count,
            p.source,
            p.status,
            p.error,
            p.created_at AS fetched_at,
            p.updated_at,
            (
              SELECT json_group_array(json_object('actorId', pref.external_key, 'url', pref.url))
              FROM person_external_refs pref
              WHERE pref.person_id = p.id
                AND pref.provider = 'javdb-actor'
            ) AS javdb_refs_json,
            (
              SELECT pref.external_key
              FROM person_external_refs pref
              WHERE pref.person_id = p.id
                AND pref.provider = 'javdb-actor'
              ORDER BY pref.id
              LIMIT 1
            ) AS javdb_actor_id,
            (
              SELECT pref.url
              FROM person_external_refs pref
              WHERE pref.person_id = p.id
                AND pref.provider = 'javdb-actor'
              ORDER BY pref.id
              LIMIT 1
            ) AS javdb_url,
            avatar.remote_url AS avatar_url,
            avatar.local_path AS avatar_local_path,
            avatar.mime AS avatar_mime,
            NULL AS avatar_blob,
            avatar.id AS avatar_image_id,
            avatar.image_blob IS NOT NULL AS avatar_has_image_blob,
            avatar.source AS avatar_source,
            avatar.updated_at AS avatar_updated_at,
            avatar.legacy_key AS avatar_legacy_key,
            NULL AS avatar_operation_id,
            avatar.id IS NOT NULL AS avatar_candidate_present,
            (
              SELECT json_group_array(alias)
              FROM person_aliases pa
              WHERE pa.person_id = p.id
            ) AS aliases_json
          FROM people p
          LEFT JOIN fanhao_images.images avatar
            ON avatar.id = (
              SELECT i.id
              FROM fanhao_images.images i
              WHERE i.owner_type = 'person'
                AND i.owner_id = p.id
                AND i.kind = 'avatar'
              ORDER BY
                CASE
                  WHEN i.source IN ('manual_upload', 'manual_person_cover', 'manual') THEN 0
                  WHEN i.source = 'actor_profiles' THEN 1
                  ELSE 2
                END,
                CASE WHEN i.image_blob IS NOT NULL THEN 0 ELSE 1 END,
                i.updated_at DESC,
                i.id ASC
              LIMIT 1
            )
          WHERE EXISTS (SELECT 1 FROM person_external_refs pref WHERE pref.person_id = p.id AND pref.provider = 'javdb-actor')
             OR avatar.id IS NOT NULL
             OR EXISTS (SELECT 1 FROM person_aliases pa WHERE pa.person_id = p.id)
             OR COALESCE(NULLIF(LOWER(TRIM(p.gender)), ''), 'unknown') <> 'unknown'
          `;
      for (const row of db.prepare(query).all()) {
        rows.set(String(row.core_person_id), { ...row, person_id: String(row.core_person_id) });
      }
    } catch (error) {
      console.warn("[core-actor-profile]", error.message);
      if (actorProfileCache?.rows) return actorProfileCache.rows;
    }

    actorProfileCache = { stamp, rows };
    return rows;
  }

  function row(personId) {
    return rowsById().get(personId) || null;
  }

  function avatarForProfileRow(profileRow) {
    if (!profileRow) return null;
    if (!profileRow.avatar_candidate_present) return null;
    const avatarUrl = coreImageUrl?.({
      id: profileRow.avatar_image_id,
      owner_id: profileRow.core_person_id,
      remote_url: profileRow.avatar_url,
      local_path: profileRow.avatar_local_path,
      source: profileRow.avatar_source,
      updated_at: profileRow.avatar_updated_at,
      has_image_blob: profileRow.avatar_has_image_blob,
      actor_profile_operation_id: profileRow.avatar_operation_id
    }) || "";
    if (!avatarUrl) return null;
    return {
      personId: String(profileRow.person_id || ""),
      avatarUrl,
      sourceAvatarUrl: profileRow.avatar_url || profileRow.avatar_local_path || "",
      source: profileRow.avatar_source || "",
      updatedAt: profileRow.avatar_updated_at || "",
      coverWorkId: profileRow.avatar_source === "manual_person_cover" ? String(profileRow.avatar_legacy_key || "") : ""
    };
  }

  function publicProfile(profileRow) {
    if (!profileRow) return null;

    const aliases = uniquePersonNames([...actorProfileAliases(profileRow), ...mergedPersonAliasNames(profileRow.person_id)]);
    const displayName = preferredPersonDisplayName(profileRow, profileRow.person_name);
    const avatar = avatarForProfileRow(profileRow);
    const avatarUrl = avatar?.avatarUrl || "";
    const javdbRefs = actorProfileJavdbRefs(profileRow);
    const primaryJavdb = javdbRefs[0] || { actorId: profileRow.javdb_actor_id || "", url: profileRow.javdb_url || "" };

    return {
      personId: String(profileRow.person_id || ""),
      personName: profileRow.person_name,
      javdbActorId: primaryJavdb.actorId || "",
      javdbUrl: primaryJavdb.url || "",
      javdbRefs,
      javdbUrls: javdbRefs.map((ref) => ref.url),
      displayName,
      aliases,
      gender: normalizePersonGender(profileRow.gender),
      movieCount: profileRow.movie_count ?? null,
      avatarUrl,
      sourceAvatarUrl: avatar?.sourceAvatarUrl || profileRow.avatar_url || "",
      source: profileRow.source || "",
      status: profileRow.status || "ok",
      error: profileRow.error || "",
      fetchedAt: profileRow.fetched_at || "",
      updatedAt: profileRow.updated_at || ""
    };
  }

  function publicSnapshot(profileRow) {
    return {
      avatar: avatarForProfileRow(profileRow),
      profile: publicProfile(profileRow)
    };
  }

  function invalidate() {
    actorProfileCache = null;
  }

  return {
    invalidate,
    publicProfile,
    publicSnapshot,
    row,
    rowsById
  };
}
