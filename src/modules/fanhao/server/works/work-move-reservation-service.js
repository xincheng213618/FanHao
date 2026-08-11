import path from "node:path";

const IMAGE_SCHEMA = "fanhao_images";

function normalizedPathKey(value) {
  return path.resolve(String(value || ""))
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function pathKeysOverlap(left, right) {
  const first = String(left || "");
  const second = String(right || "");
  if (!first || !second) return false;
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

function reservationPathsOverlap(row, expected) {
  return [row?.old_path_key, row?.new_path_key]
    .filter(Boolean)
    .some((reservedPath) => [expected.oldPathKey, expected.newPathKey]
      .some((candidatePath) => pathKeysOverlap(reservedPath, candidatePath)));
}

function reservationError(message, code = "WORK_MOVE_RESERVATION_CONFLICT") {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function rollback(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

export function createWorkMoveReservationService({
  getCoreDb,
  now = () => new Date().toISOString()
}) {
  ensureSchema();

  function ensureSchema() {
    const db = getCoreDb();
    const attached = db.prepare("PRAGMA database_list").all().some((row) => String(row.name || "") === IMAGE_SCHEMA);
    if (!attached) throw reservationError("图片库未附加，无法安装文件移动 reservation 门禁", "WORK_MOVE_RESERVATION_SCHEMA");
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_move_path_reservations (
        job_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        local_work_id INTEGER NOT NULL,
        old_path TEXT NOT NULL,
        old_path_key TEXT NOT NULL,
        new_path TEXT NOT NULL,
        new_path_key TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        lease_until TEXT NOT NULL DEFAULT '',
        mutation_mode TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT NOT NULL DEFAULT '',
        terminal_status TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_move_reservation_active_work
        ON work_move_path_reservations(work_id) WHERE released_at = '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_move_reservation_active_old_path
        ON work_move_path_reservations(old_path_key) WHERE released_at = '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_move_reservation_active_new_path
        ON work_move_path_reservations(new_path_key) WHERE released_at = '';

      CREATE TABLE IF NOT EXISTS ${IMAGE_SCHEMA}.work_move_path_reservations (
        job_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        local_work_id INTEGER NOT NULL,
        old_path TEXT NOT NULL,
        old_path_key TEXT NOT NULL,
        new_path TEXT NOT NULL,
        new_path_key TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        lease_until TEXT NOT NULL DEFAULT '',
        mutation_mode TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT NOT NULL DEFAULT '',
        terminal_status TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ${IMAGE_SCHEMA}.idx_work_move_reservation_active_work
        ON work_move_path_reservations(work_id) WHERE released_at = '';
      CREATE UNIQUE INDEX IF NOT EXISTS ${IMAGE_SCHEMA}.idx_work_move_reservation_active_old_path
        ON work_move_path_reservations(old_path_key) WHERE released_at = '';
      CREATE UNIQUE INDEX IF NOT EXISTS ${IMAGE_SCHEMA}.idx_work_move_reservation_active_new_path
        ON work_move_path_reservations(new_path_key) WHERE released_at = '';

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_works_insert
      BEFORE INSERT ON local_works
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              CAST(NEW.work_id AS TEXT) = r.work_id
              OR lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) = r.old_path_key
              OR substr(lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) = r.new_path_key
              OR substr(lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_works_update
      BEFORE UPDATE ON local_works
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              OLD.id = r.local_work_id OR NEW.id = r.local_work_id
              OR CAST(OLD.work_id AS TEXT) = r.work_id OR CAST(NEW.work_id AS TEXT) = r.work_id
              OR lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')) IN (r.old_path_key, r.new_path_key)
              OR substr(lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR substr(lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
              OR lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) IN (r.old_path_key, r.new_path_key)
              OR substr(lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR substr(lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_works_delete
      BEFORE DELETE ON local_works
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              OLD.id = r.local_work_id OR CAST(OLD.work_id AS TEXT) = r.work_id
              OR lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')) IN (r.old_path_key, r.new_path_key)
              OR substr(lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR substr(lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_files_insert
      BEFORE INSERT ON local_files
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              NEW.local_work_id = r.local_work_id
              OR lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')) = r.old_path_key
              OR substr(lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')) = r.new_path_key
              OR substr(lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_files_update
      BEFORE UPDATE ON local_files
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              OLD.local_work_id = r.local_work_id OR NEW.local_work_id = r.local_work_id
              OR lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')) = r.old_path_key
              OR substr(lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')) = r.new_path_key
              OR substr(lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
              OR lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')) = r.old_path_key
              OR substr(lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')) = r.new_path_key
              OR substr(lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_files_delete
      BEFORE DELETE ON local_files
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              OLD.local_work_id = r.local_work_id
              OR lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')) = r.old_path_key
              OR substr(lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')) = r.new_path_key
              OR substr(lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS ${IMAGE_SCHEMA}.trg_work_move_reserve_images_insert
      BEFORE INSERT ON images
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              (NEW.owner_type = 'work' AND CAST(NEW.owner_id AS TEXT) = r.work_id)
              OR lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) = r.old_path_key
              OR substr(lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) = r.new_path_key
              OR substr(lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS ${IMAGE_SCHEMA}.trg_work_move_reserve_images_update
      BEFORE UPDATE ON images
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              (OLD.owner_type = 'work' AND CAST(OLD.owner_id AS TEXT) = r.work_id)
              OR (NEW.owner_type = 'work' AND CAST(NEW.owner_id AS TEXT) = r.work_id)
              OR lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')) IN (r.old_path_key, r.new_path_key)
              OR substr(lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR substr(lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
              OR lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) IN (r.old_path_key, r.new_path_key)
              OR substr(lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR substr(lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS ${IMAGE_SCHEMA}.trg_work_move_reserve_images_delete
      BEFORE DELETE ON images
      BEGIN
        SELECT RAISE(ABORT, 'work move path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              (OLD.owner_type = 'work' AND CAST(OLD.owner_id AS TEXT) = r.work_id)
              OR lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')) IN (r.old_path_key, r.new_path_key)
              OR substr(lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')), 1, length(r.old_path_key) + 1) = r.old_path_key || '/'
              OR substr(lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')), 1, length(r.new_path_key) + 1) = r.new_path_key || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_works_ancestor_insert
      BEFORE INSERT ON local_works
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) <> ''
            AND (
              substr(r.old_path_key, 1, length(lower(rtrim(replace(NEW.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.local_path, char(92), '/'), '/')) || '/'
              OR substr(r.new_path_key, 1, length(lower(rtrim(replace(NEW.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.local_path, char(92), '/'), '/')) || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_works_ancestor_update
      BEFORE UPDATE ON local_works
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              (
                lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')) <> ''
                AND (
                  substr(r.old_path_key, 1, length(lower(rtrim(replace(OLD.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.local_path, char(92), '/'), '/')) || '/'
                  OR substr(r.new_path_key, 1, length(lower(rtrim(replace(OLD.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.local_path, char(92), '/'), '/')) || '/'
                )
              )
              OR (
                lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) <> ''
                AND (
                  substr(r.old_path_key, 1, length(lower(rtrim(replace(NEW.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.local_path, char(92), '/'), '/')) || '/'
                  OR substr(r.new_path_key, 1, length(lower(rtrim(replace(NEW.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.local_path, char(92), '/'), '/')) || '/'
                )
              )
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_works_ancestor_delete
      BEFORE DELETE ON local_works
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')) <> ''
            AND (
              substr(r.old_path_key, 1, length(lower(rtrim(replace(OLD.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.local_path, char(92), '/'), '/')) || '/'
              OR substr(r.new_path_key, 1, length(lower(rtrim(replace(OLD.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.local_path, char(92), '/'), '/')) || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_files_ancestor_insert
      BEFORE INSERT ON local_files
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')) <> ''
            AND (
              substr(r.old_path_key, 1, length(lower(rtrim(replace(NEW.file_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.file_path, char(92), '/'), '/')) || '/'
              OR substr(r.new_path_key, 1, length(lower(rtrim(replace(NEW.file_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.file_path, char(92), '/'), '/')) || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_files_ancestor_update
      BEFORE UPDATE ON local_files
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              (
                lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')) <> ''
                AND (
                  substr(r.old_path_key, 1, length(lower(rtrim(replace(OLD.file_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.file_path, char(92), '/'), '/')) || '/'
                  OR substr(r.new_path_key, 1, length(lower(rtrim(replace(OLD.file_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.file_path, char(92), '/'), '/')) || '/'
                )
              )
              OR (
                lower(rtrim(replace(COALESCE(NEW.file_path, ''), char(92), '/'), '/')) <> ''
                AND (
                  substr(r.old_path_key, 1, length(lower(rtrim(replace(NEW.file_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.file_path, char(92), '/'), '/')) || '/'
                  OR substr(r.new_path_key, 1, length(lower(rtrim(replace(NEW.file_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.file_path, char(92), '/'), '/')) || '/'
                )
              )
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_work_move_reserve_local_files_ancestor_delete
      BEFORE DELETE ON local_files
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND lower(rtrim(replace(COALESCE(OLD.file_path, ''), char(92), '/'), '/')) <> ''
            AND (
              substr(r.old_path_key, 1, length(lower(rtrim(replace(OLD.file_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.file_path, char(92), '/'), '/')) || '/'
              OR substr(r.new_path_key, 1, length(lower(rtrim(replace(OLD.file_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.file_path, char(92), '/'), '/')) || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS ${IMAGE_SCHEMA}.trg_work_move_reserve_images_ancestor_insert
      BEFORE INSERT ON images
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) <> ''
            AND (
              substr(r.old_path_key, 1, length(lower(rtrim(replace(NEW.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.local_path, char(92), '/'), '/')) || '/'
              OR substr(r.new_path_key, 1, length(lower(rtrim(replace(NEW.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.local_path, char(92), '/'), '/')) || '/'
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS ${IMAGE_SCHEMA}.trg_work_move_reserve_images_ancestor_update
      BEFORE UPDATE ON images
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND (
              (
                lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')) <> ''
                AND (
                  substr(r.old_path_key, 1, length(lower(rtrim(replace(OLD.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.local_path, char(92), '/'), '/')) || '/'
                  OR substr(r.new_path_key, 1, length(lower(rtrim(replace(OLD.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.local_path, char(92), '/'), '/')) || '/'
                )
              )
              OR (
                lower(rtrim(replace(COALESCE(NEW.local_path, ''), char(92), '/'), '/')) <> ''
                AND (
                  substr(r.old_path_key, 1, length(lower(rtrim(replace(NEW.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.local_path, char(92), '/'), '/')) || '/'
                  OR substr(r.new_path_key, 1, length(lower(rtrim(replace(NEW.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(NEW.local_path, char(92), '/'), '/')) || '/'
                )
              )
            )
        );
      END;

      CREATE TRIGGER IF NOT EXISTS ${IMAGE_SCHEMA}.trg_work_move_reserve_images_ancestor_delete
      BEFORE DELETE ON images
      BEGIN
        SELECT RAISE(ABORT, 'work move ancestor path reserved')
        WHERE EXISTS (
          SELECT 1 FROM work_move_path_reservations r
          WHERE r.released_at = '' AND r.mutation_mode = ''
            AND lower(rtrim(replace(COALESCE(OLD.local_path, ''), char(92), '/'), '/')) <> ''
            AND (
              substr(r.old_path_key, 1, length(lower(rtrim(replace(OLD.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.local_path, char(92), '/'), '/')) || '/'
              OR substr(r.new_path_key, 1, length(lower(rtrim(replace(OLD.local_path, char(92), '/'), '/'))) + 1) = lower(rtrim(replace(OLD.local_path, char(92), '/'), '/')) || '/'
            )
        );
      END;
    `);
  }

  function values(plan) {
    const jobId = String(plan?.jobId || "").trim();
    const workId = String(plan?.workId || "").trim();
    const localWorkId = Number(plan?.localWorkId);
    const oldPath = path.resolve(String(plan?.oldDir || ""));
    const newPath = path.resolve(String(plan?.newDir || ""));
    if (!jobId || !workId || !Number.isFinite(localWorkId) || !plan?.oldDir || !plan?.newDir) {
      throw reservationError("文件移动计划缺少 reservation 身份", "WORK_MOVE_RESERVATION_INVALID");
    }
    return {
      jobId,
      workId,
      localWorkId,
      oldPath,
      oldPathKey: normalizedPathKey(oldPath),
      newPath,
      newPathKey: normalizedPathKey(newPath)
    };
  }

  function assertIdentity(row, expected, label) {
    if (!row) return;
    if (
      String(row.work_id) !== expected.workId
      || Number(row.local_work_id) !== expected.localWorkId
      || String(row.old_path_key) !== expected.oldPathKey
      || String(row.new_path_key) !== expected.newPathKey
    ) {
      throw reservationError(`${label} reservation 与 journal 路径不一致`, "WORK_MOVE_RESERVATION_MISMATCH");
    }
  }

  function acquire(plan, { ownerId, leaseUntil, claimedAt = now(), takeover = true } = {}) {
    const db = getCoreDb();
    const expected = values(plan);
    const owner = String(ownerId || "");
    if (!owner || !leaseUntil) throw reservationError("文件移动 reservation 缺少 lease owner", "WORK_MOVE_RESERVATION_INVALID");
    db.exec("BEGIN IMMEDIATE");
    try {
      const mainRow = db.prepare("SELECT * FROM work_move_path_reservations WHERE job_id = ?").get(expected.jobId);
      const imageRow = db.prepare(`SELECT * FROM ${IMAGE_SCHEMA}.work_move_path_reservations WHERE job_id = ?`).get(expected.jobId);
      assertIdentity(mainRow, expected, "主库");
      assertIdentity(imageRow, expected, "图片库");

      const activeReservations = [
        ...db.prepare(`
          SELECT job_id, work_id, old_path_key, new_path_key, created_at
          FROM work_move_path_reservations
          WHERE released_at = '' AND job_id <> ?
        `).all(expected.jobId),
        ...db.prepare(`
          SELECT job_id, work_id, old_path_key, new_path_key, created_at
          FROM ${IMAGE_SCHEMA}.work_move_path_reservations
          WHERE released_at = '' AND job_id <> ?
        `).all(expected.jobId)
      ].sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")) || String(left.job_id).localeCompare(String(right.job_id)));
      const conflict = activeReservations.find((row) => String(row.work_id) === expected.workId || reservationPathsOverlap(row, expected));
      if (conflict) throw reservationError(`路径已由任务 ${conflict.job_id} 保留`);

      const reservedLocalWork = db.prepare(`
        SELECT work_id, lower(rtrim(replace(COALESCE(local_path, ''), char(92), '/'), '/')) AS path_key
        FROM local_works WHERE id = ?
      `).get(expected.localWorkId);
      if (
        !reservedLocalWork
        || String(reservedLocalWork.work_id) !== expected.workId
        || ![expected.oldPathKey, expected.newPathKey].includes(reservedLocalWork.path_key)
      ) {
        throw reservationError("reservation 获取时源 local_work 已变化", "WORK_MOVE_RESERVATION_MISMATCH");
      }

      const sharedLocalWork = db.prepare(`
        WITH candidates AS (
          SELECT id, lower(rtrim(replace(COALESCE(local_path, ''), char(92), '/'), '/')) AS path_key
          FROM local_works
          WHERE id <> ? AND trim(COALESCE(local_path, '')) <> ''
        ), wanted(path_key) AS (VALUES (?), (?))
        SELECT candidates.id
        FROM candidates JOIN wanted
          ON candidates.path_key = wanted.path_key
          OR substr(candidates.path_key, 1, length(wanted.path_key) + 1) = wanted.path_key || '/'
          OR substr(wanted.path_key, 1, length(candidates.path_key) + 1) = candidates.path_key || '/'
        ORDER BY candidates.id LIMIT 1
      `).get(expected.localWorkId, expected.oldPathKey, expected.newPathKey);
      const sharedLocalFile = db.prepare(`
        WITH candidates AS (
          SELECT id, lower(rtrim(replace(COALESCE(file_path, ''), char(92), '/'), '/')) AS path_key
          FROM local_files
          WHERE COALESCE(local_work_id, -1) <> ? AND trim(COALESCE(file_path, '')) <> ''
        ), wanted(path_key) AS (VALUES (?), (?))
        SELECT candidates.id
        FROM candidates JOIN wanted
          ON candidates.path_key = wanted.path_key
          OR substr(candidates.path_key, 1, length(wanted.path_key) + 1) = wanted.path_key || '/'
          OR substr(wanted.path_key, 1, length(candidates.path_key) + 1) = candidates.path_key || '/'
        ORDER BY candidates.id LIMIT 1
      `).get(expected.localWorkId, expected.oldPathKey, expected.newPathKey);
      const sharedImage = db.prepare(`
        WITH candidates AS (
          SELECT id, lower(rtrim(replace(COALESCE(local_path, ''), char(92), '/'), '/')) AS path_key
          FROM ${IMAGE_SCHEMA}.images
          WHERE NOT (owner_type = 'work' AND CAST(owner_id AS TEXT) = ?)
            AND trim(COALESCE(local_path, '')) <> ''
        ), wanted(path_key) AS (VALUES (?), (?))
        SELECT candidates.id
        FROM candidates JOIN wanted
          ON candidates.path_key = wanted.path_key
          OR substr(candidates.path_key, 1, length(wanted.path_key) + 1) = wanted.path_key || '/'
          OR substr(wanted.path_key, 1, length(candidates.path_key) + 1) = candidates.path_key || '/'
        ORDER BY candidates.id LIMIT 1
      `).get(expected.workId, expected.oldPathKey, expected.newPathKey);
      if (sharedLocalWork || sharedLocalFile || sharedImage) {
        throw reservationError("源作品路径已新增其他数据库引用，拒绝取得 reservation");
      }

      const createdAt = now();
      const insert = (schema) => db.prepare(`
        INSERT INTO ${schema}work_move_path_reservations (
          job_id, work_id, local_work_id, old_path, old_path_key, new_path, new_path_key,
          owner_id, lease_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        expected.jobId, expected.workId, expected.localWorkId, expected.oldPath, expected.oldPathKey,
        expected.newPath, expected.newPathKey, owner, leaseUntil, createdAt, createdAt
      );
      if (!mainRow) insert("");
      if (!imageRow) insert(`${IMAGE_SCHEMA}.`);

      const ownershipClause = takeover
        ? "(owner_id = '' OR owner_id = ? OR lease_until = '' OR lease_until <= ?)"
        : "owner_id = ?";
      const update = (schema) => db.prepare(`
        UPDATE ${schema}work_move_path_reservations
        SET owner_id = ?, lease_until = ?, mutation_mode = '', released_at = '', terminal_status = '', updated_at = ?
        WHERE job_id = ? AND ${ownershipClause}
      `).run(...(
        takeover
          ? [owner, leaseUntil, now(), expected.jobId, owner, claimedAt]
          : [owner, leaseUntil, now(), expected.jobId, owner]
      ));
      if (Number(update("").changes || 0) !== 1 || Number(update(`${IMAGE_SCHEMA}.`).changes || 0) !== 1) {
        throw reservationError("文件移动 reservation 仍由旧 lease owner 持有", "WORK_MOVE_RESERVATION_BUSY");
      }
      db.exec("COMMIT");
      return { reserved: true, ...expected };
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function setMutationMode(plan, { ownerId, mode, schema = "main" } = {}) {
    const db = getCoreDb();
    const expected = values(plan);
    const table = schema === "images" ? `${IMAGE_SCHEMA}.work_move_path_reservations` : "work_move_path_reservations";
    const result = db.prepare(`
      UPDATE ${table}
      SET mutation_mode = ?, updated_at = ?
      WHERE job_id = ? AND owner_id = ? AND released_at = ''
    `).run(String(mode || ""), now(), expected.jobId, String(ownerId || ""));
    if (Number(result.changes || 0) !== 1) {
      throw reservationError("文件移动 reservation lease 已丢失", "WORK_MOVE_LEASE_LOST");
    }
  }

  function assertOwnership(plan, { ownerId, schema = "main" } = {}) {
    const db = getCoreDb();
    const expected = values(plan);
    const table = schema === "images" ? `${IMAGE_SCHEMA}.work_move_path_reservations` : "work_move_path_reservations";
    const row = db.prepare(`SELECT * FROM ${table} WHERE job_id = ?`).get(expected.jobId);
    assertIdentity(row, expected, schema === "images" ? "图片库" : "主库");
    if (!row || row.released_at || String(row.owner_id || "") !== String(ownerId || "")) {
      throw reservationError("文件移动 reservation lease 已丢失", "WORK_MOVE_LEASE_LOST");
    }
    return row;
  }

  function release(jobId, { ownerId, terminalStatus } = {}) {
    const db = getCoreDb();
    const id = String(jobId || "");
    const owner = String(ownerId || "");
    const releasedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["work_move_path_reservations", `${IMAGE_SCHEMA}.work_move_path_reservations`]) {
        const existing = db.prepare(`SELECT owner_id, released_at FROM ${table} WHERE job_id = ?`).get(id);
        if (!existing || existing.released_at) continue;
        if (String(existing.owner_id || "") !== owner) {
          throw reservationError("不能释放其他 lease owner 的 reservation", "WORK_MOVE_LEASE_LOST");
        }
        db.prepare(`
          UPDATE ${table}
          SET released_at = ?, terminal_status = ?, mutation_mode = '', owner_id = '', lease_until = '', updated_at = ?
          WHERE job_id = ? AND owner_id = ? AND released_at = ''
        `).run(releasedAt, String(terminalStatus || ""), releasedAt, id, owner);
      }
      db.exec("COMMIT");
      return { released: true };
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function park(plan, { ownerId } = {}) {
    const db = getCoreDb();
    const expected = values(plan);
    const owner = String(ownerId || "");
    const parkedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["work_move_path_reservations", `${IMAGE_SCHEMA}.work_move_path_reservations`]) {
        const row = db.prepare(`SELECT owner_id, released_at FROM ${table} WHERE job_id = ?`).get(expected.jobId);
        if (!row || row.released_at) continue;
        if (String(row.owner_id || "") !== owner) {
          throw reservationError("不能停放其他 lease owner 的 reservation", "WORK_MOVE_LEASE_LOST");
        }
        const result = db.prepare(`
          UPDATE ${table}
          SET owner_id = '', lease_until = '', mutation_mode = '', updated_at = ?
          WHERE job_id = ? AND owner_id = ? AND released_at = ''
        `).run(parkedAt, expected.jobId, owner);
        if (Number(result.changes || 0) !== 1) throw reservationError("reservation 停放 CAS 失败", "WORK_MOVE_LEASE_LOST");
      }
      db.exec("COMMIT");
      return { parked: true };
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  function repairTerminalReservations() {
    const db = getCoreDb();
    const hasJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_move_jobs'").get();
    if (!hasJobs) return { repaired: 0 };
    const repairedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      let repaired = 0;
      const terminal = db.prepare(`
        SELECT j.id AS job_id, j.status
        FROM work_move_jobs j
        WHERE j.status IN ('completed', 'rolled_back')
          AND (
            EXISTS (SELECT 1 FROM work_move_path_reservations main WHERE main.job_id = j.id AND main.released_at = '')
            OR EXISTS (SELECT 1 FROM ${IMAGE_SCHEMA}.work_move_path_reservations image WHERE image.job_id = j.id AND image.released_at = '')
          )
      `).all();
      for (const row of terminal) {
        for (const table of ["work_move_path_reservations", `${IMAGE_SCHEMA}.work_move_path_reservations`]) {
          repaired += Number(db.prepare(`
            UPDATE ${table}
            SET released_at = ?, terminal_status = ?, mutation_mode = '', owner_id = '', lease_until = '', updated_at = ?
            WHERE job_id = ? AND released_at = ''
          `).run(repairedAt, row.status, repairedAt, row.job_id).changes || 0);
        }
      }
      const orphanImages = db.prepare(`
        SELECT image.job_id
        FROM ${IMAGE_SCHEMA}.work_move_path_reservations image
        LEFT JOIN work_move_path_reservations main ON main.job_id = image.job_id
        LEFT JOIN work_move_jobs job ON job.id = image.job_id
        WHERE image.released_at = '' AND main.job_id IS NULL AND job.id IS NULL
      `).all();
      for (const row of orphanImages) {
        repaired += Number(db.prepare(`
          UPDATE ${IMAGE_SCHEMA}.work_move_path_reservations
          SET released_at = ?, terminal_status = 'orphaned', mutation_mode = '', owner_id = '', lease_until = '', updated_at = ?
          WHERE job_id = ? AND released_at = ''
        `).run(repairedAt, repairedAt, row.job_id).changes || 0);
      }
      db.exec("COMMIT");
      return { repaired };
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  return {
    acquire,
    assertOwnership,
    ensureSchema,
    park,
    release,
    repairTerminalReservations,
    renew(plan, context) {
      return acquire(plan, { ...context, takeover: false });
    },
    setMutationMode
  };
}
