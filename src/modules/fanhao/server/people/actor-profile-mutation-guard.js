export const ACTOR_PROFILE_RESERVATION_PREFIX = "person-avatar:";
export const JAVDB_ACTOR_RESERVATION_PREFIX = "javdb-actor:";

export function personAvatarAggregateKey(personId) {
  const id = Number(personId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error("人物不存在");
    error.statusCode = 404;
    throw error;
  }
  return `${ACTOR_PROFILE_RESERVATION_PREFIX}${id}`;
}

export function javdbActorAggregateKey(actorKey) {
  const key = String(actorKey || "").trim();
  if (!key) return "";
  return `${JAVDB_ACTOR_RESERVATION_PREFIX}${key}`;
}

function reservationTableExists(db) {
  return Boolean(db
    .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'cross_store_aggregate_reservations'")
    .get());
}

// Call only after BEGIN IMMEDIATE (or from the outbox transaction that owns the
// matching operation). That makes this a write fence rather than a racy probe.
export function actorProfileMutationReservationKeys(db, personIds, { actorKeys = [] } = {}) {
  const ids = new Set((Array.isArray(personIds) ? personIds : [personIds]).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
  const keys = [...new Set((actorKeys || []).map(String).map((key) => key.trim()).filter(Boolean))];
  if (keys.length) {
    const findOwner = db.prepare(`
      SELECT person_id FROM person_external_refs
      WHERE provider = 'javdb-actor' AND external_key = ?
    `);
    for (const key of keys) {
      const owner = findOwner.get(key);
      if (owner?.person_id !== null && owner?.person_id !== undefined) ids.add(Number(owner.person_id));
    }
  }
  return [
    ...[...ids].map(personAvatarAggregateKey),
    ...keys.map(javdbActorAggregateKey)
  ].filter(Boolean).sort();
}

export function assertActorProfileMutationAllowed(db, personIds, { actorKeys = [], operationId = "" } = {}) {
  if (!reservationTableExists(db)) return;
  const aggregateKeys = actorProfileMutationReservationKeys(db, personIds, { actorKeys });
  const findReservation = db.prepare(`
    SELECT aggregate_key, op_id
    FROM main.cross_store_aggregate_reservations
    WHERE aggregate_key = ?
  `);
  for (const aggregateKey of aggregateKeys) {
    const reservation = findReservation.get(aggregateKey);
    if (!reservation || String(reservation.op_id) === String(operationId || "")) continue;
    const error = new Error("人物头像正在由可恢复任务更新，请稍后重试");
    error.code = "ACTOR_PROFILE_RESERVED";
    error.statusCode = 409;
    error.operationId = String(reservation.op_id);
    throw error;
  }
}

export function clearActorProfilePublication(db, personIds, { sources = null } = {}) {
  const table = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'actor_profile_publications'").get();
  if (!table) return;
  const sourceList = Array.isArray(sources) ? [...new Set(sources.map(String).filter(Boolean))] : null;
  if (sourceList) {
    const staging = db.prepare("SELECT 1 FROM fanhao_images.sqlite_schema WHERE type = 'table' AND name = 'actor_profile_image_staging'").get();
    if (!staging || !sourceList.length) return;
  }
  const placeholders = sourceList?.map(() => "?").join(", ");
  const remove = sourceList
    ? db.prepare(`
        DELETE FROM main.actor_profile_publications
        WHERE person_id = ?
          AND operation_id IN (
            SELECT operation_id FROM fanhao_images.actor_profile_image_staging
            WHERE person_id = ? AND source IN (${placeholders})
          )
      `)
    : db.prepare("DELETE FROM main.actor_profile_publications WHERE person_id = ?");
  for (const personId of [...new Set((Array.isArray(personIds) ? personIds : [personIds]).map(Number).filter(Number.isFinite))]) {
    remove.run(personId, ...(sourceList ? [personId, ...sourceList] : []));
  }
}
