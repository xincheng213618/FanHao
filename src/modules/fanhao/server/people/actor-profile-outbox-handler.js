function stableStringList(values) {
  return JSON.stringify([...values].map(String).sort());
}

export function stageActorProfileImage(imageDb, plan, blobs, context) {
  if (!plan.hasAvatarMutation) return { avatarStaged: false };
  const avatarBlob = blobs.avatar || null;
  const sourceType = plan.avatarUrl.startsWith("http://") || plan.avatarUrl.startsWith("https://")
    ? "remote"
    : plan.avatarUrl
      ? "local"
      : "unknown";
  imageDb.prepare(`
    INSERT INTO actor_profile_image_staging (
      operation_id, person_id, intent_sha256, source_type, local_path, remote_url,
      mime, image_blob, byte_size, status, source, legacy_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)
  `).run(
    context.operationId,
    plan.personId,
    context.intentSha256,
    sourceType,
    plan.avatarUrl,
    plan.avatarMime,
    avatarBlob,
    avatarBlob?.length || null,
    plan.source,
    String(plan.personId),
    context.createdAt,
    context.createdAt
  );
  return { avatarStaged: true, byteSize: avatarBlob?.length || 0 };
}

export function verifyActorProfileImageStage(imageDb, plan, blobs, context) {
  if (!plan.hasAvatarMutation) return true;
  const row = imageDb.prepare(`
    SELECT person_id, intent_sha256, remote_url, mime, image_blob, byte_size, source
    FROM actor_profile_image_staging
    WHERE operation_id = ?
  `).get(context.operationId);
  if (!row
    || Number(row.person_id) !== Number(plan.personId)
    || row.intent_sha256 !== context.intentSha256
    || String(row.remote_url || "") !== String(plan.avatarUrl || "")
    || String(row.mime || "") !== String(plan.avatarMime || "")
    || String(row.source || "") !== String(plan.source || "")) return false;
  if (plan.hasAvatarBlob) {
    const expected = blobs.avatar || Buffer.alloc(0);
    if (Number(row.byte_size || 0) !== expected.length) return false;
    if (!Buffer.from(row.image_blob || []).equals(expected)) return false;
  }
  return true;
}

export function verifyActorProfileMainProjection(mainDb, plan, context) {
  const personRow = mainDb.prepare(`
    SELECT name, name_search, display_name, gender, movie_count, source, status, error
    FROM people WHERE id = ?
  `).get(plan.personId);
  if (!personRow
    || personRow.name !== plan.personName
    || personRow.name_search !== plan.personNameSearch
    || personRow.display_name !== plan.displayName
    || personRow.gender !== plan.gender
    || Number(personRow.movie_count) !== Number(plan.movieCount)
    || personRow.source !== plan.source
    || personRow.status !== plan.status
    || (personRow.error || null) !== plan.error) return false;

  if (plan.hasActorUrlInput) {
    const urls = mainDb.prepare("SELECT url FROM person_external_refs WHERE person_id = ? AND provider = 'javdb-actor' ORDER BY url").all(plan.personId).map((row) => row.url);
    if (stableStringList(urls) !== stableStringList(plan.javdbUrls)) return false;
  }
  if (plan.hasAliasesInput) {
    const aliases = mainDb.prepare("SELECT alias FROM person_aliases WHERE person_id = ? AND source = ? ORDER BY alias").all(plan.personId, plan.aliasSource).map((row) => row.alias);
    if (stableStringList(aliases) !== stableStringList(plan.aliases)) return false;
  }
  if (plan.hasAvatarMutation) {
    const publication = mainDb.prepare(`
      SELECT operation_id, intent_sha256
      FROM actor_profile_publications
      WHERE person_id = ?
    `).get(plan.personId);
    if (publication?.operation_id !== context.operationId || publication?.intent_sha256 !== context.intentSha256) return false;
  }
  return true;
}
