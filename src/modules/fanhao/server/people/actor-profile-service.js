export function createActorProfileService({
  actorProfileAliases,
  actorProfileJavdbRefs,
  getCoreDb,
  getStamp,
  mergedPersonAliasNames,
  normalizePersonGender,
  preferredPersonDisplayName,
  publicPersonAvatar,
  uniquePersonNames
}) {
  let actorProfileCache = null;

  function rowsById() {
    const stamp = getStamp();
    if (actorProfileCache?.stamp === stamp) return actorProfileCache.rows;

    const rows = new Map();
    try {
      const db = getCoreDb();
      for (const row of db
        .prepare(
          `
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
            avatar.mime AS avatar_mime,
            NULL AS avatar_blob,
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
                AND i.source = 'actor_profiles'
              ORDER BY CASE WHEN i.image_blob IS NOT NULL THEN 0 ELSE 1 END, i.id ASC
              LIMIT 1
            )
          WHERE EXISTS (SELECT 1 FROM person_external_refs pref WHERE pref.person_id = p.id AND pref.provider = 'javdb-actor')
             OR avatar.id IS NOT NULL
             OR EXISTS (SELECT 1 FROM person_aliases pa WHERE pa.person_id = p.id)
             OR COALESCE(NULLIF(LOWER(TRIM(p.gender)), ''), 'unknown') <> 'unknown'
          `
        )
        .all()) {
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

  function publicProfile(profileRow) {
    if (!profileRow) return null;

    const aliases = uniquePersonNames([...actorProfileAliases(profileRow), ...mergedPersonAliasNames(profileRow.person_id)]);
    const displayName = preferredPersonDisplayName(profileRow, profileRow.person_name);
    const avatar = publicPersonAvatar(profileRow.person_id);
    const avatarUrl = avatar?.avatarUrl || (profileRow.avatar_blob ? `/media/actor/${encodeURIComponent(profileRow.person_id)}/avatar?v=${encodeURIComponent(profileRow.updated_at || "")}` : "");
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

  function invalidate() {
    actorProfileCache = null;
  }

  return {
    invalidate,
    publicProfile,
    row,
    rowsById
  };
}
