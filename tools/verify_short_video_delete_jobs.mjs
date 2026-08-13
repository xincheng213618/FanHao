import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { createShortVideoCoverDatabase } from "../src/modules/short-videos/server/cover-database.js";
import { SHORT_VIDEO_DELETE_QUARANTINE_DIR } from "../src/modules/short-videos/server/delete-job-service.js";
import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "short_video_delete_fault_child.mjs");
const WORKER_THREAD_CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "short_video_delete_worker_thread.mjs"
);
const REBASE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "rebase_short_video_storage.mjs");
const QUEUED_WRITER_CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "short_video_delete_queued_writer_child.mjs"
);
const SUCCESS_KEYS = [
  "ok",
  "id",
  "ids",
  "count",
  "scope",
  "groupDir",
  "title",
  "deletedFiles",
  "deletedStoredCovers",
  "coverCleanupError",
  "missingFiles",
  "skippedFiles",
  "emptyRemovedPaths"
];

await verifySuccessfulCompatibilityAndReservations();
await verifyBatchMissingIdsFailAtomically();
await verifyV3ActiveJournalMigration();
await verifyProtocolMigrationAndTombstones();
await verifyCanonicalScannerTombstoneConsumption();
await verifyAssetTransferSnapshotCas();
await verifyRollbackAndCleanupRecovery();
await verifyPathEscapeAndBusyFailure();
await verifyGuardNoClobberAndExclusiveFallback();
await verifyPublishedGuardTempCleanupRecovery();
await verifyExclusiveGuardTempCleanupRecovery();
await verifyActiveExecuteRecoveryFencing();
await verifyWorkerThreadDurableExecutionFence();
await verifyInPlaceOverwriteFailsClosed();
await verifyPostIsolationOpenHandleOverwriteFailsClosed();
await verifyAfterAllIsolatedBusyRecovery();
await verifyLargeUnrelatedReferenceSetIsBounded();
await verifySameRootJunctionSharedReference();
await verifyOutsideJunctionProbeFailureRetains();
await verifyOutsideAndCrossRootPhysicalReferences();
await verifyHardlinkRetentionAndTombstones();
await verifyJunctionRetargetAfterOwnerSnapshot();
await verifyDeleteRouteStatusContract();
await verifyDeleteRouteAuthBeforeBody();
await verifyGeneratedCoverUnlinkSafety();
verifyOfflineRebaseBoundary();
await verifyScannerExclusion();
await verifyStartupRecoveryIsExplicit();
await verifyLeaseClaimFencing();
await verifyQueuedCleanupWriterFence();
await verifyKilledProcessRecovery("planned", "rolled_back");
await verifyKilledProcessRecovery("partially_isolated", "rolled_back");
await verifyKilledProcessRecovery("restore_renamed_pre_journal", "rolled_back");
await verifyKilledProcessRecovery("guard_half_written", "rolled_back");
await verifyKilledProcessRecovery("guard_pre_publish", "rolled_back");
await verifyKilledProcessRecovery("fallback_guard_published", "rolled_back");
await verifyKilledProcessRecovery("db_committed", "completed");
await verifyKilledProcessRecovery("post_cleanup_unlinks_pre_journal", "completed");
await verifyKilledProcessRecovery("partially_cleaned", "completed");

console.log("short-video-delete-jobs: ok (durable plan, same-volume quarantine, rollback, cleanup retry, reservation fencing, scanner exclusion, SIGKILL recovery)");

function verifyOfflineRebaseBoundary() {
  const denied = spawnSync(process.execPath, [REBASE_SCRIPT, "--apply"], {
    cwd: path.dirname(REBASE_SCRIPT),
    encoding: "utf8",
    windowsHide: true
  });
  assert.notEqual(denied.status, 0, "online storage rebase must be rejected before touching a database");
  assert.match(
    `${denied.stdout || ""}\n${denied.stderr || ""}`,
    /offline-confirmed/,
    "the rejected rebase must identify the explicit offline boundary"
  );

  const source = fs.readFileSync(REBASE_SCRIPT, "utf8");
  for (const table of [
    "short_video_delete_jobs",
    "short_video_delete_items",
    "short_video_delete_reservations",
    "short_video_delete_video_tombstones",
    "short_video_path_references",
    "short_video_path_tombstones"
  ]) {
    assert.match(source, new RegExp(`\\b${table}\\b`), `storage rebase must explicitly exclude internal table ${table}`);
  }
  assert.match(source, /assertDeleteProtocolOfflineBoundary/, "storage rebase must reject active protocol ownership");
  assert.match(source, /assertShortVideoReferenceProjection/, "storage rebase must reconcile the 4+1 path projection before commit");
}

async function verifyV3ActiveJournalMigration() {
  const fixture = createFixture({ openStore: false });
  let store = null;
  try {
    const bootstrap = createShortVideoStore(storeOptions(fixture));
    bootstrap.summary();
    bootstrap.close();
    const db = openDb(fixture.dbPath);
    try {
      const tableNames = [
        "short_video_delete_reservations",
        "short_video_delete_items",
        "short_video_delete_jobs",
        "short_video_path_references",
        "short_video_path_tombstones",
        "short_video_delete_video_tombstones"
      ];
      const schemas = new Map(db.prepare(`
        SELECT name, sql FROM sqlite_schema
        WHERE type = 'table' AND name IN (${tableNames.map(() => "?").join(", ")})
      `).all(...tableNames).map((row) => [row.name, row.sql]));
      for (const trigger of db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'trigger' AND name LIKE 'trg_short_video_%'
      `).all()) {
        db.exec(`DROP TRIGGER ${trigger.name}`);
      }
      db.exec("PRAGMA foreign_keys = OFF");
      for (const table of tableNames) db.exec(`DROP TABLE ${table}`);
      for (const table of tableNames.slice().reverse()) {
        let sql = String(schemas.get(table) || "");
        if (table === "short_video_delete_jobs") {
          sql = sql.replace(/,\s*execution_token TEXT NOT NULL DEFAULT ''/u, "");
        }
        if (table === "short_video_delete_items") {
          sql = sql.replace(/,\s*guard_publish_mode TEXT NOT NULL DEFAULT ''/u, "");
        }
        assert(sql, `v3 migration fixture requires captured schema for ${table}`);
        db.exec(sql);
      }
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('short_video_delete_protocol_version', '3')").run();
      db.prepare(`
        INSERT INTO short_videos (id, source_path, imported_at, updated_at)
        VALUES ('v3-active-video', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO short_video_delete_jobs (
          id, status, phase, scope, anchor_id, video_ids_json, quarantine_token,
          owner_id, lease_until, version, attempts, created_at, updated_at
        ) VALUES ('v3-active-job', 'running', 'planned', 'single', 'v3-active-video',
                  '["v3-active-video"]', 'v3-active-token', '', '', 3, 1,
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO short_video_delete_reservations (
          job_id, kind, reservation_key, original_value, mutation_mode,
          released_at, created_at, updated_at
        ) VALUES ('v3-active-job', 'video', 'v3-active-video', 'v3-active-video', '', '',
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
      assert.equal(schemaColumnCount(db, "short_video_delete_jobs", "execution_token"), 0);
      assert.equal(schemaColumnCount(db, "short_video_delete_items", "guard_publish_mode"), 0);
      assert.equal(
        db.prepare("SELECT value FROM short_video_meta WHERE key = 'short_video_delete_protocol_version'").get()?.value,
        "3"
      );
    } finally {
      db.close();
    }

    store = createShortVideoStore(storeOptions(fixture));
    const migratedStatus = store.summary();
    assert(migratedStatus, "opening the v3 fixture must initialize the ordinary store");
    const migrated = openDb(fixture.dbPath);
    try {
      assert.equal(
        migrated.prepare("SELECT value FROM short_video_meta WHERE key = 'short_video_delete_protocol_version'").get()?.value,
        "4"
      );
      assert.equal(schemaColumnCount(migrated, "short_video_delete_jobs", "execution_token"), 1);
      assert.equal(schemaColumnCount(migrated, "short_video_delete_items", "guard_publish_mode"), 1);
      assert.equal(migrated.prepare("SELECT status FROM short_video_delete_jobs WHERE id = 'v3-active-job'").get()?.status, "running");
    } finally {
      migrated.close();
    }
    await store.recoverDeleteJobs({ jobId: "v3-active-job" });
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back");
    assert.equal(videoExists(fixture.dbPath, "v3-active-video"), true);
    assertNoActiveReservations(fixture.dbPath);
  } finally {
    store?.close();
    closeFixture(fixture);
  }
}

function schemaColumnCount(db, table, column) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column)?.count || 0);
}

async function verifyProtocolMigrationAndTombstones() {
  const fixture = createFixture({ openStore: false });
  let store = null;
  try {
    const bootstrap = createShortVideoStore(storeOptions(fixture));
    bootstrap.summary();
    bootstrap.close();
    const videoId = "123456789012";
    const source = writeMedia(fixture.root, `migration/2026-08-13_protocol_${videoId}.mp4`, "protocol-old");
    seedVideo(fixture.dbPath, { id: videoId, sourcePath: source });

    const stale = openDb(fixture.dbPath);
    try {
      stale.prepare("DELETE FROM short_video_meta WHERE key = 'short_video_delete_protocol_version'").run();
      stale.prepare("DELETE FROM short_video_path_references").run();
    } finally {
      stale.close();
    }

    const migrated = createShortVideoStore(storeOptions(fixture));
    migrated.summary();
    migrated.close();
    const afterMigration = openDb(fixture.dbPath);
    let schemaVersion;
    try {
      assert.equal(
        afterMigration.prepare("SELECT value FROM short_video_meta WHERE key = 'short_video_delete_protocol_version'").get()?.value,
        "4"
      );
      assert.equal(
        Number(afterMigration.prepare(`
          SELECT COUNT(*) AS count
          FROM pragma_table_info('short_video_delete_items')
          WHERE name = 'guard_publish_mode'
        `).get()?.count || 0),
        1,
        "protocol v4 must persist the guard publication mode"
      );
      assert.equal(schemaColumnCount(afterMigration, "short_video_delete_jobs", "execution_token"), 1);
      assert.equal(Number(afterMigration.prepare("SELECT COUNT(*) AS count FROM short_video_path_references").get()?.count || 0), 1);
      assertReferenceProjectionMatches(afterMigration);
      const propertyPaths = ["source", "cover", "music", "data", "asset"]
        .map((name) => path.join(fixture.root, "projection", `${name}.bin`));
      afterMigration.prepare(`
        INSERT INTO short_videos (id, source_path, cover_path, music_path, data_path)
        VALUES ('projection-video', ?, ?, ?, ?)
      `).run(...propertyPaths.slice(0, 4));
      afterMigration.prepare(`
        INSERT INTO short_video_assets (id, video_id, asset_type, local_path)
        VALUES ('projection-asset', 'projection-video', 'poster', ?)
      `).run(propertyPaths[4]);
      assertReferenceProjectionMatches(afterMigration);
      afterMigration.prepare(`
        UPDATE short_videos
        SET source_path = ?, cover_path = ?, music_path = ?, data_path = ?
        WHERE id = 'projection-video'
      `).run(...propertyPaths.slice(0, 4).map((value) => `${value}.updated`));
      afterMigration.prepare(`
        UPDATE short_video_assets
        SET id = 'projection-asset-replaced', video_id = 'projection-video', asset_type = 'cover', local_path = ?
        WHERE id = 'projection-asset'
      `).run(`${propertyPaths[4]}.updated`);
      assertReferenceProjectionMatches(afterMigration);
      afterMigration.prepare(`
        INSERT OR REPLACE INTO short_videos (id, source_path, cover_path, music_path, data_path)
        VALUES ('projection-video', ?, ?, ?, ?)
      `).run(...propertyPaths.slice(0, 4).map((value) => `${value}.replaced`));
      assertReferenceProjectionMatches(afterMigration);
      afterMigration.prepare("DELETE FROM short_video_assets WHERE video_id = 'projection-video'").run();
      afterMigration.prepare("DELETE FROM short_videos WHERE id = 'projection-video'").run();
      assertReferenceProjectionMatches(afterMigration);
      for (const name of [
        "trg_short_video_video_tombstone_insert_v1",
        "trg_short_video_path_tombstone_video_source_insert_v1",
        "trg_short_video_path_ref_video_source_insert_v2"
      ]) {
        assert.equal(
          Number(afterMigration.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.count || 0),
          1,
          `migration must atomically install ${name}`
        );
      }
      schemaVersion = Number(afterMigration.prepare("PRAGMA schema_version").get()?.schema_version || 0);
    } finally {
      afterMigration.close();
    }

    let physicalProbeCount = 0;
    const noProbeFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (["lstatSync", "statSync", "realpathSync"].includes(String(property))) {
          return (...args) => {
            physicalProbeCount += 1;
            return Reflect.get(target, property, receiver)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const second = createShortVideoStore({ ...storeOptions(fixture), deleteJobFsOps: noProbeFs });
    second.summary();
    second.close();
    assert.equal(second.deleteJobStatus().ok, true, "the same store must reopen a fresh delete owner after close");
    second.close();
    const afterSecondOpen = openDb(fixture.dbPath);
    try {
      assert.equal(Number(afterSecondOpen.prepare("PRAGMA schema_version").get()?.schema_version || 0), schemaVersion);
    } finally {
      afterSecondOpen.close();
    }
    assert.equal(physicalProbeCount, 0, "a current protocol second open must not rebuild or physically probe the reference catalog");

    store = createShortVideoStore(storeOptions(fixture));
    store.summary();
    await store.deleteVideo(videoId);
    const raw = openDb(fixture.dbPath);
    try {
      assert.throws(
        () => raw.prepare("INSERT INTO short_videos (id, source_path) VALUES (?, ?)").run(videoId, path.join(fixture.root, "new-path.mp4")),
        /video tombstone conflict/i,
        "a terminal delete must block raw reuse of the same video id at a new path"
      );
      assert.throws(
        () => raw.prepare("INSERT INTO short_videos (id, source_path) VALUES (?, ?)").run("raw-new-id", source),
        /path tombstone conflict/i,
        "a terminal delete must block raw reuse of the same path under a new id"
      );
    } finally {
      raw.close();
    }

    fs.mkdirSync(path.dirname(source), { recursive: true });
    const staged = path.join(fixture.temp.tempDir, "protocol-replacement.mp4");
    fs.writeFileSync(staged, "protocol-new-identity");
    fs.renameSync(staged, source);
    const failDb = openDb(fixture.dbPath);
    try {
      failDb.exec(`
        CREATE TRIGGER test_short_video_protocol_upsert_failure
        BEFORE INSERT ON short_videos
        WHEN NEW.id = '${videoId}'
        BEGIN
          SELECT RAISE(ABORT, 'injected official upsert failure');
        END
      `);
    } finally {
      failDb.close();
    }
    assert.throws(() => store.scan(fixture.root), /injected official upsert failure/);
    const afterFailure = openDb(fixture.dbPath);
    try {
      assert.equal(Number(afterFailure.prepare("SELECT COUNT(*) AS count FROM short_video_delete_video_tombstones WHERE video_id = ?").get(videoId)?.count || 0), 1);
      assert.equal(Number(afterFailure.prepare("SELECT COUNT(*) AS count FROM short_video_path_tombstones WHERE path_key = lower(replace(?, char(92), '/'))").get(source)?.count || 0), 1);
      afterFailure.exec("DROP TRIGGER test_short_video_protocol_upsert_failure");
    } finally {
      afterFailure.close();
    }
    const scan = store.scan(fixture.root);
    assert.equal(scan.ok, true);
    const afterSuccess = openDb(fixture.dbPath);
    try {
      assert.equal(Number(afterSuccess.prepare("SELECT COUNT(*) AS count FROM short_video_delete_video_tombstones WHERE video_id = ?").get(videoId)?.count || 0), 0);
      assert.equal(Number(afterSuccess.prepare("SELECT COUNT(*) AS count FROM short_video_path_tombstones WHERE path_key = lower(replace(?, char(92), '/'))").get(source)?.count || 0), 0);
      assert.equal(Boolean(afterSuccess.prepare("SELECT 1 FROM short_videos WHERE id = ? AND source_path = ?").get(videoId, source)), true);
    } finally {
      afterSuccess.close();
    }
  } finally {
    store?.close();
    closeFixture(fixture);
  }
}

function assertReferenceProjectionMatches(db) {
  const mismatch = Number(db.prepare(`
    WITH expected AS (
      SELECT 'short_videos' owner_table, id owner_key, id owner_video_id, 'source_path' path_column,
             trim(source_path) raw_path, lower(replace(trim(source_path), char(92), '/')) path_key
      FROM short_videos WHERE trim(source_path) <> ''
      UNION ALL SELECT 'short_videos', id, id, 'cover_path', trim(cover_path), lower(replace(trim(cover_path), char(92), '/'))
      FROM short_videos WHERE trim(cover_path) <> ''
      UNION ALL SELECT 'short_videos', id, id, 'music_path', trim(music_path), lower(replace(trim(music_path), char(92), '/'))
      FROM short_videos WHERE trim(music_path) <> ''
      UNION ALL SELECT 'short_videos', id, id, 'data_path', trim(data_path), lower(replace(trim(data_path), char(92), '/'))
      FROM short_videos WHERE trim(data_path) <> ''
      UNION ALL SELECT 'short_video_assets', id, video_id, 'local_path', trim(local_path), lower(replace(trim(local_path), char(92), '/'))
      FROM short_video_assets WHERE trim(local_path) <> ''
    )
    SELECT COUNT(*) AS count FROM (
      SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM expected
      EXCEPT
      SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM short_video_path_references
      UNION ALL
      SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM short_video_path_references
      EXCEPT
      SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM expected
    )
  `).get()?.count || 0);
  assert.equal(mismatch, 0, "the four video path slots and asset path projection must reconcile bidirectionally");
}

async function verifyAssetTransferSnapshotCas() {
  const fixture = createFixture();
  try {
    const selected = writeMedia(fixture.root, "asset-transfer/selected.mp4", "selected");
    const survivor = writeMedia(fixture.root, "asset-transfer/survivor.mp4", "survivor");
    const asset = writeMedia(fixture.root, "asset-transfer/shared.jpg", "shared-asset");
    seedVideo(fixture.dbPath, { id: "asset-transfer-selected", sourcePath: selected });
    seedVideo(fixture.dbPath, { id: "asset-transfer-survivor", sourcePath: survivor });
    seedAsset(fixture.dbPath, "asset-transfer-row", "asset-transfer-selected", asset);
    let moved = false;
    fixture.hooks.afterReferenceSnapshot = ({ phase }) => {
      if (phase !== "plan" || moved) return;
      moved = true;
      const writer = openDb(fixture.dbPath);
      try {
        writer.prepare("UPDATE short_video_assets SET video_id = ? WHERE id = ?")
          .run("asset-transfer-survivor", "asset-transfer-row");
      } finally {
        writer.close();
      }
    };
    await assert.rejects(
      () => fixture.store.deleteVideo("asset-transfer-selected"),
      (error) => error?.code === "SHORT_VIDEO_DELETE_REFERENCE_CHANGED"
    );
    assert.equal(moved, true);
    assert.equal(jobRows(fixture.dbPath).length, 0, "a stale owner snapshot must fail before journaling a delete plan");
    assert.equal(videoExists(fixture.dbPath, "asset-transfer-selected"), true);
    assert.equal(videoExists(fixture.dbPath, "asset-transfer-survivor"), true);
    assert.equal(fs.readFileSync(asset, "utf8"), "shared-asset");
    const check = openDb(fixture.dbPath);
    try {
      assert.equal(check.prepare("SELECT video_id FROM short_video_assets WHERE id = ?").get("asset-transfer-row")?.video_id, "asset-transfer-survivor");
    } finally {
      check.close();
    }
  } finally {
    closeFixture(fixture);
  }
}

async function verifyCanonicalScannerTombstoneConsumption() {
  const fixture = createFixture();
  try {
    const shortId = "12345678";
    const canonicalId = "1234567890123456789";
    const source = writeMedia(fixture.root, `canonical/2026-08-13_shared_${shortId}.mp4`, "canonical-survivor");
    const deletedMissing = path.join(fixture.root, "canonical", "deleted-short.mp4");
    seedVideo(fixture.dbPath, { id: canonicalId, sourcePath: source });
    seedVideo(fixture.dbPath, { id: shortId, sourcePath: deletedMissing });
    await fixture.store.deleteVideo(shortId);
    const before = openDb(fixture.dbPath);
    try {
      assert.equal(Number(before.prepare("SELECT COUNT(*) AS count FROM short_video_delete_video_tombstones WHERE video_id = ?").get(shortId)?.count || 0), 1);
    } finally {
      before.close();
    }

    const scan = fixture.store.scan(fixture.root);
    assert.equal(scan.ok, true);
    const after = openDb(fixture.dbPath);
    try {
      assert.equal(
        Number(after.prepare("SELECT COUNT(*) AS count FROM short_video_delete_video_tombstones WHERE video_id = ?").get(shortId)?.count || 0),
        1,
        "canonical convergence must not consume the incoming short-id tombstone when the long id is actually upserted"
      );
      assert.equal(Boolean(after.prepare("SELECT 1 FROM short_videos WHERE id = ? AND source_path = ?").get(canonicalId, source)), true);
      assert.equal(Boolean(after.prepare("SELECT 1 FROM short_videos WHERE id = ?").get(shortId)), false);
    } finally {
      after.close();
    }
  } finally {
    closeFixture(fixture);
  }
}

async function verifySuccessfulCompatibilityAndReservations() {
  const fixture = createFixture();
  try {
    const source = writeMedia(fixture.root, "one/video.mp4", "video-one");
    const asset = writeMedia(fixture.root, "one/poster.jpg", "poster-one");
    const shared = writeMedia(fixture.root, "shared/shared.mp4", "shared-video");
    const missing = path.join(fixture.root, "one", "missing.m4a");
    const outside = path.join(fixture.temp.tempDir, "outside.json");
    fs.writeFileSync(outside, "outside-sentinel");
    seedVideo(fixture.dbPath, {
      id: "video-1",
      sourcePath: source,
      coverPath: shared,
      musicPath: missing,
      dataPath: outside,
      title: "Video One"
    });
    seedVideo(fixture.dbPath, { id: "video-2", sourcePath: shared, title: "Video Two" });
    seedAsset(fixture.dbPath, "asset-1", "video-1", asset);
    const covers = createShortVideoCoverDatabase({ dbPath: fixture.coverDbPath });
    covers.put("video-1", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    covers.close();

    let duplicateConflict = null;
    let lateWriterConflict = null;
    let cleanupWriterConflict = null;
    fixture.hooks.afterPlanPersisted = async () => {
      const competing = createShortVideoStore(storeOptions(fixture));
      try {
        await competing.deleteVideo("video-1");
      } catch (error) {
        duplicateConflict = error;
      } finally {
        competing.close();
      }
    };
    fixture.hooks.afterItemIsolated = ({ ordinal }) => {
      if (ordinal !== 0) return;
      const writer = openDb(fixture.dbPath);
      try {
        writer.prepare("INSERT INTO short_videos (id, source_path) VALUES (?, ?)").run("late-video", source);
      } catch (error) {
        lateWriterConflict = error;
      } finally {
        writer.close();
      }
    };
    fixture.hooks.beforeQuarantineCleanup = ({ ordinal }) => {
      if (ordinal !== 0 || cleanupWriterConflict) return;
      const writer = openDb(fixture.dbPath);
      try {
        writer.exec("PRAGMA busy_timeout = 0");
        writer.prepare("INSERT INTO short_videos (id, source_path) VALUES (?, ?)").run("cleanup-writer", source);
      } catch (error) {
        cleanupWriterConflict = error;
      } finally {
        writer.close();
      }
    };

    const result = await fixture.store.deleteVideo("video-1");
    assertLegacyDeleteResultFields(result);
    assert.equal(result.ok, true);
    assert.equal(result.id, "video-1");
    assert.deepEqual(result.ids, ["video-1"]);
    assert.equal(result.count, 1);
    assert.equal(result.scope, "single");
    assert.equal(result.accepted, true);
    assert.equal(result.pending, false);
    assert.equal(result.status, "completed");
    assert.equal(result.logicalDeleteCommitted, true);
    assert.equal(result.physicalCleanupComplete, true);
    assert.equal(result.cleanupPendingFiles, 0);
    assert.equal(result.deletedStoredCovers, 1, "post-commit recovery lane must clean the separate cover store");
    assert.deepEqual([...result.deletedFiles].sort(), [relative(fixture.root, asset), relative(fixture.root, source)].sort());
    assert.deepEqual(result.missingFiles, [relative(fixture.root, missing)]);
    assert(result.skippedFiles.some((entry) => entry.path === relative(fixture.root, shared) && /其他短视频/.test(entry.reason)));
    assert(result.skippedFiles.some((entry) => entry.path === outside && /不在短视频目录/.test(entry.reason)));
    assert.equal(duplicateConflict?.statusCode, 409, "the active video reservation must reject a duplicate request");
    assert.match(String(lateWriterConflict?.message || ""), /reservation conflict|path tombstone conflict/i, "the path trigger or durable tombstone must reject a late writer");
    assert.match(
      String(cleanupWriterConflict?.message || ""),
      /path tombstone conflict/i,
      "the durable exact-path tombstone must reject a raw writer after logical commit"
    );
    assert.equal(videoExists(fixture.dbPath, "cleanup-writer"), false);
    assert.equal(videoExists(fixture.dbPath, "video-1"), false);
    assert.equal(videoExists(fixture.dbPath, "video-2"), true);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(asset), false);
    assert.equal(fs.readFileSync(shared, "utf8"), "shared-video");
    assert.equal(fs.readFileSync(outside, "utf8"), "outside-sentinel");
    const coverCheck = createShortVideoCoverDatabase({ dbPath: fixture.coverDbPath });
    assert.equal(coverCheck.has("video-1"), false);
    coverCheck.close();
    assertNoQuarantine(fixture.root);
    await assert.rejects(() => fixture.store.deleteVideo("video-1"), (error) => error?.statusCode === 404);

    const retained = writeMedia(fixture.root, "retained/retained.mp4", "retained");
    seedVideo(fixture.dbPath, { id: "retained", sourcePath: retained });
    const retainedResult = await fixture.store.deleteVideo("retained", { deleteFiles: false });
    assert.deepEqual(Object.keys(retainedResult), SUCCESS_KEYS);
    assert.equal(fs.readFileSync(retained, "utf8"), "retained", "deleteFiles=false must not create or move file state");
    assert.deepEqual(retainedResult.deletedFiles, []);
    assert.deepEqual(retainedResult.missingFiles, []);
    assert.deepEqual(retainedResult.skippedFiles, []);

    const fourth = writeMedia(fixture.root, "shared/fourth.mp4", "fourth");
    seedVideo(fixture.dbPath, { id: "video-4", sourcePath: fourth, coverPath: shared });
    const batch = await fixture.store.deleteVideos(["video-2", "video-4", "video-2"]);
    assert.equal(batch.scope, "batch");
    assert.equal(batch.count, 2);
    assert.equal(batch.deletedFiles.filter((entry) => entry === relative(fixture.root, shared)).length, 1, "a shared path selected by the same batch must be isolated once");
    assert.equal(fs.existsSync(shared), false);

    const groupDir = path.join(fixture.root, "group");
    const groupOne = writeMedia(fixture.root, "group/one.mp4", "group-one");
    const groupTwo = writeMedia(fixture.root, "group/two.mp4", "group-two");
    seedVideo(fixture.dbPath, { id: "group-1", sourcePath: groupOne });
    seedVideo(fixture.dbPath, { id: "group-2", sourcePath: groupTwo });
    const group = await fixture.store.deleteVideoGroup("group-1");
    assert.equal(group.scope, "group");
    assert.equal(group.count, 2);
    assert.equal(group.groupDir, relative(fixture.root, groupDir));
    assertNoQuarantine(fixture.root);
  } finally {
    closeFixture(fixture);
  }
}

async function verifyBatchMissingIdsFailAtomically() {
  for (const testCase of [
    { ids: ["stale-video", "valid-video"], deleteFiles: true, label: "missing-first" },
    { ids: ["valid-video", "stale-video"], deleteFiles: false, label: "valid-first-logical-only" }
  ]) {
    const fixture = createFixture();
    try {
      const source = writeMedia(fixture.root, `${testCase.label}/valid.mp4`, `${testCase.label}-bytes`);
      seedVideo(fixture.dbPath, { id: "valid-video", sourcePath: source, title: "Valid Video" });
      const covers = createShortVideoCoverDatabase({ dbPath: fixture.coverDbPath });
      covers.put("valid-video", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      covers.close();

      await assert.rejects(
        () => fixture.store.deleteVideos(testCase.ids, { deleteFiles: testCase.deleteFiles }),
        (error) => error?.statusCode === 409
          && error?.code === "SHORT_VIDEO_DELETE_BATCH_INCOMPLETE"
          && /失效/.test(String(error?.message || ""))
      );

      assert.equal(videoExists(fixture.dbPath, "valid-video"), true, `${testCase.label}: valid DB row must remain`);
      assert.equal(fixture.store.videoDetail("valid-video")?.video?.id, "valid-video", `${testCase.label}: valid public model must remain`);
      assert.equal(fs.readFileSync(source, "utf8"), `${testCase.label}-bytes`, `${testCase.label}: valid file must remain byte-exact`);
      const db = openDb(fixture.dbPath);
      try {
        for (const table of [
          "short_video_delete_jobs",
          "short_video_delete_reservations",
          "short_video_path_tombstones",
          "short_video_delete_video_tombstones"
        ]) {
          assert.equal(
            Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0),
            0,
            `${testCase.label}: incomplete batch must not create ${table} side effects`
          );
        }
      } finally {
        db.close();
      }
      const coverCheck = createShortVideoCoverDatabase({ dbPath: fixture.coverDbPath });
      assert.equal(coverCheck.has("valid-video"), true, `${testCase.label}: valid stored cover must remain`);
      coverCheck.close();
      assertNoQuarantine(fixture.root);
    } finally {
      closeFixture(fixture);
    }
  }
}

async function verifyRollbackAndCleanupRecovery() {
  const rollback = createFixture();
  try {
    const source = writeMedia(rollback.root, "rollback/video.mp4", "rollback-video");
    const cover = writeMedia(rollback.root, "rollback/cover.jpg", "rollback-cover");
    seedVideo(rollback.dbPath, { id: "rollback", sourcePath: source, coverPath: cover });
    rollback.hooks.afterItemIsolated = ({ ordinal }) => {
      if (ordinal === 0) throw Object.assign(new Error("injected isolate failure"), { code: "EACCES" });
    };
    await assert.rejects(() => rollback.store.deleteVideo("rollback"), /删除本地文件失败/);
    assert.equal(videoExists(rollback.dbPath, "rollback"), true);
    assert.equal(fs.readFileSync(source, "utf8"), "rollback-video");
    assert.equal(fs.readFileSync(cover, "utf8"), "rollback-cover");
    assert.equal(jobRows(rollback.dbPath)[0]?.status, "rolled_back");
    assertNoActiveReservations(rollback.dbPath);
    assertNoQuarantine(rollback.root);
  } finally {
    closeFixture(rollback);
  }

  const occupied = createFixture();
  try {
    const source = writeMedia(occupied.root, "occupied/video.mp4", "original-video");
    seedVideo(occupied.dbPath, { id: "occupied", sourcePath: source });
    occupied.hooks.afterItemIsolated = () => {
      fs.unlinkSync(source);
      fs.writeFileSync(source, "foreign-replacement");
      throw new Error("injected occupied rollback target");
    };
    await assert.rejects(() => occupied.store.deleteVideo("occupied"));
    assert.equal(videoExists(occupied.dbPath, "occupied"), true);
    assert.equal(fs.readFileSync(source, "utf8"), "foreign-replacement", "rollback must preserve a replacement at the original path");
    const occupiedJob = jobRows(occupied.dbPath)[0];
    assert.equal(occupiedJob?.status, "rollback_pending");
    const automatic = await occupied.store.recoverDeleteJobs();
    assert.equal(automatic.jobs.find((job) => job.id === occupiedJob.id)?.manualInterventionRequired, true);
    assert.equal(fs.readFileSync(source, "utf8"), "foreign-replacement", "automatic recovery must not touch a manual-intervention replacement");
    fs.unlinkSync(source);
    occupied.hooks.afterItemIsolated = null;
    await occupied.store.recoverDeleteJobs({ jobId: occupiedJob.id });
    assert.equal(fs.readFileSync(source, "utf8"), "original-video");
    assert.equal(jobRows(occupied.dbPath)[0]?.status, "rolled_back");
    assertNoActiveReservations(occupied.dbPath);
  } finally {
    closeFixture(occupied);
  }

  const cleanup = createFixture();
  try {
    const source = writeMedia(cleanup.root, "cleanup/video.mp4", "cleanup-video");
    seedVideo(cleanup.dbPath, { id: "cleanup", sourcePath: source });
    let failCleanup = true;
    cleanup.hooks.beforeQuarantineCleanup = () => {
      if (failCleanup) throw Object.assign(new Error(`injected cleanup failure at ${source}`), { code: "EBUSY" });
    };
    const result = await cleanup.store.deleteVideo("cleanup");
    assertLegacyDeleteResultFields(result);
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.pending, true);
    assert.equal(result.status, "cleanup_pending");
    assert.equal(result.logicalDeleteCommitted, true);
    assert.equal(result.physicalCleanupComplete, false);
    assert.equal(result.cleanupPendingFiles, 1);
    assert.deepEqual(result.deletedFiles, [], "pending cleanup must not report planned paths as physically deleted");
    assert.equal(videoExists(cleanup.dbPath, "cleanup"), false);
    const pending = cleanup.store.deleteJobStatus();
    assert.equal(pending.cleanupPending, 1);
    assert.doesNotMatch(JSON.stringify(pending), new RegExp(escapeRegExp(cleanup.temp.tempDir), "i"), "delete status must not disclose absolute paths");
    assert.equal(activeReservationCount(cleanup.dbPath) > 0, true, "cleanup_pending must keep its durable reservations");
    failCleanup = false;
    await cleanup.store.recoverDeleteJobs();
    assert.equal(cleanup.store.deleteJobStatus().cleanupPending, 0);
    assert.equal(jobRows(cleanup.dbPath)[0]?.status, "completed");
    assertNoActiveReservations(cleanup.dbPath);
    assert.equal(fs.existsSync(source), false);
    assertNoQuarantine(cleanup.root);
  } finally {
    closeFixture(cleanup);
  }
}

async function verifyPathEscapeAndBusyFailure() {
  const escapeFixture = createFixture();
  try {
    const outsideDir = path.join(escapeFixture.temp.tempDir, "outside-target");
    fs.mkdirSync(outsideDir);
    const sentinel = path.join(outsideDir, "sentinel.mp4");
    fs.writeFileSync(sentinel, "outside-sentinel");
    const link = path.join(escapeFixture.root, "escape-link");
    fs.symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
    const escapedPath = path.join(link, "sentinel.mp4");
    seedVideo(escapeFixture.dbPath, { id: "escape", sourcePath: escapedPath });
    await assert.rejects(
      () => escapeFixture.store.deleteVideo("escape"),
      (error) => error?.code === "SHORT_VIDEO_DELETE_PATH_ESCAPE",
      "a junction that leaves the configured root must fail before a durable file mutation"
    );
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside-sentinel");
    assert.equal(videoExists(escapeFixture.dbPath, "escape"), true);
    assert.equal(jobRows(escapeFixture.dbPath).length, 0);
  } finally {
    closeFixture(escapeFixture);
  }

  const busy = createFixture({ busyTimeoutMs: 30 });
  try {
    const source = writeMedia(busy.root, "busy/video.mp4", "busy-video");
    seedVideo(busy.dbPath, { id: "busy", sourcePath: source });
    const locker = openDb(busy.dbPath);
    locker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
      await assert.rejects(
        () => busy.store.deleteVideo("busy"),
        (error) => error?.statusCode === 503 && error?.code === "SHORT_VIDEO_DELETE_BUSY"
      );
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    assert.equal(fs.readFileSync(source, "utf8"), "busy-video");
    assert.equal(videoExists(busy.dbPath, "busy"), true);
    assert.equal(jobRows(busy.dbPath).length, 0, "SQLITE_BUSY before plan commit must leave no journal or filesystem mutation");
  } finally {
    closeFixture(busy);
  }
}

async function verifyInPlaceOverwriteFailsClosed() {
  const fixture = createFixture();
  try {
    const source = writeMedia(fixture.root, "overwrite/video.mp4", Buffer.alloc(256 * 1024, 0x41));
    const fixedTime = new Date("2024-01-02T03:04:05.000Z");
    fs.utimesSync(source, fixedTime, fixedTime);
    seedVideo(fixture.dbPath, { id: "overwrite", sourcePath: source });
    const originalIdentity = fs.lstatSync(source, { bigint: true });
    const replacement = Buffer.alloc(4096, 0x42);
    fixture.hooks.afterPlanPersisted = () => {
      const handle = fs.openSync(source, "r+");
      try {
        fs.writeSync(handle, replacement, 0, replacement.length, 96 * 1024);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.utimesSync(source, fixedTime, fixedTime);
      const replacedIdentity = fs.lstatSync(source, { bigint: true });
      assert.equal(replacedIdentity.dev, originalIdentity.dev);
      assert.equal(replacedIdentity.ino, originalIdentity.ino);
      assert.equal(replacedIdentity.size, originalIdentity.size);
      assert.equal(replacedIdentity.mtimeNs, originalIdentity.mtimeNs, "the fixture must restore mtime so metadata-only checks cannot make it pass");
    };

    await assert.rejects(
      () => fixture.store.deleteVideo("overwrite"),
      (error) => error?.code === "SHORT_VIDEO_DELETE_FILE_REPLACED"
    );
    assert.equal(videoExists(fixture.dbPath, "overwrite"), true);
    const preserved = fs.readFileSync(source);
    assert.deepEqual(preserved.subarray(96 * 1024, 100 * 1024), replacement, "fail-closed recovery must preserve the in-place replacement");
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back");
    assert.equal(activeReservationCount(fixture.dbPath), 0, "a source changed before isolation must not remain permanently reserved");
    assertNoQuarantine(fixture.root);

    const retry = await fixture.store.recoverDeleteJobs();
    assert.equal(retry.rollbackPending, 0);
    assert.deepEqual(fs.readFileSync(source).subarray(96 * 1024, 100 * 1024), replacement);

    fixture.hooks.afterPlanPersisted = () => {
      throw Object.assign(new Error("stop after retry plan"), { code: "EACCES" });
    };
    await assert.rejects(() => fixture.store.deleteVideo("overwrite"), /删除本地文件失败/);
    assert.equal(jobRows(fixture.dbPath).length, 2, "the replacement must be eligible for a fresh durable delete plan");
    assert(jobRows(fixture.dbPath).every((row) => row.status === "rolled_back"));
    assertNoActiveReservations(fixture.dbPath);
    assert.deepEqual(fs.readFileSync(source).subarray(96 * 1024, 100 * 1024), replacement);
  } finally {
    closeFixture(fixture);
  }

  const untouched = createFixture();
  try {
    const source = writeMedia(untouched.root, "planned-missing/video.mp4", "planned-missing");
    seedVideo(untouched.dbPath, { id: "planned-missing", sourcePath: source });
    untouched.hooks.afterPlanPersisted = () => fs.unlinkSync(source);
    await assert.rejects(() => untouched.store.deleteVideo("planned-missing"));
    assert.equal(videoExists(untouched.dbPath, "planned-missing"), true);
    assert.equal(jobRows(untouched.dbPath)[0]?.status, "rolled_back", "a never-isolated external disappearance must converge without claiming a restore");
    assertNoActiveReservations(untouched.dbPath);
  } finally {
    closeFixture(untouched);
  }
}

async function verifyGuardNoClobberAndExclusiveFallback() {
  const race = createFixture();
  try {
    const source = writeMedia(race.root, "guard-race/video.mp4", "guard-original");
    seedVideo(race.dbPath, { id: "guard-race", sourcePath: source });
    race.hooks.beforeGuardPublish = () => {
      fs.writeFileSync(source, "guard-race-replacement", { flag: "wx" });
    };
    await assert.rejects(
      () => race.store.deleteVideo("guard-race"),
      (error) => [
        "SHORT_VIDEO_DELETE_GUARD_NO_CLOBBER",
        "SHORT_VIDEO_DELETE_GUARD_REPLACED",
        "SHORT_VIDEO_DELETE_RECOVERY_REQUIRED"
      ].includes(error?.code)
    );
    assert.equal(fs.readFileSync(source, "utf8"), "guard-race-replacement", "guard publication must never replace a newly-created destination");
    assert.equal(videoExists(race.dbPath, "guard-race"), true);
    const raceJob = jobRows(race.dbPath)[0];
    assert.equal(raceJob?.status, "rollback_pending");
    fs.unlinkSync(source);
    race.hooks.beforeGuardPublish = null;
    await race.store.recoverDeleteJobs({ jobId: raceJob.id });
    assert.equal(fs.readFileSync(source, "utf8"), "guard-original");
    assert.equal(jobRows(race.dbPath)[0]?.status, "rolled_back");
  } finally {
    closeFixture(race);
  }

  const fallback = createFixture({ openStore: false });
  let fallbackStore = null;
  try {
    const unsupportedLinks = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === "linkSync") {
          return () => { throw Object.assign(new Error("links unsupported"), { code: "EPERM" }); };
        }
        return Reflect.get(target, property, receiver);
      }
    });
    fallbackStore = createShortVideoStore({ ...storeOptions(fallback), deleteJobFsOps: unsupportedLinks });
    fallbackStore.summary();
    const source = writeMedia(fallback.root, "guard-fallback/video.mp4", "guard-fallback");
    seedVideo(fallback.dbPath, { id: "guard-fallback", sourcePath: source });
    const result = await fallbackStore.deleteVideo("guard-fallback");
    assert.equal(result.status, "completed");
    assert.equal(fs.existsSync(source), false, "exclusive-create fallback must complete without hardlink support");
    assertNoQuarantine(fallback.root);
  } finally {
    fallbackStore?.close();
    closeFixture(fallback);
  }
}

async function verifyPublishedGuardTempCleanupRecovery() {
  const fixture = createFixture({ openStore: false });
  let source = "";
  let injected = false;
  const interruptedGuardCleanup = new Proxy(fs, {
    get(target, property, receiver) {
      if (property === "unlinkSync") {
        return (targetPath, ...args) => {
          const text = String(targetPath || "");
          if (!injected && source && text.endsWith(".prepared") && fs.existsSync(source)) {
            const sourceEntry = fs.lstatSync(source, { bigint: true });
            const preparedEntry = fs.lstatSync(text, { bigint: true });
            if (String(sourceEntry.dev) === String(preparedEntry.dev)
              && String(sourceEntry.ino) === String(preparedEntry.ino)) {
              injected = true;
              throw Object.assign(new Error("injected guard temp cleanup interruption"), { code: "EACCES" });
            }
          }
          return fs.unlinkSync(targetPath, ...args);
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  try {
    fixture.store = createShortVideoStore({
      ...storeOptions(fixture),
      deleteJobFsOps: interruptedGuardCleanup
    });
    fixture.store.summary();
    source = writeMedia(fixture.root, "guard-published/video.mp4", "guard-published-original");
    seedVideo(fixture.dbPath, { id: "guard-published", sourcePath: source });

    await assert.rejects(
      () => fixture.store.deleteVideo("guard-published"),
      (error) => error?.code === "SHORT_VIDEO_DELETE_GUARD_TEMP_CLEANUP"
    );
    assert.equal(injected, true, "the fixture must interrupt after the hardlink guard is published");
    assert.equal(videoExists(fixture.dbPath, "guard-published"), true);
    assert.equal(fs.readFileSync(source, "utf8"), "guard-published-original");
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back");
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);

    await fixture.store.recoverDeleteJobs();
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back", "published guard recovery must be idempotent");
    assert.equal(fs.readFileSync(source, "utf8"), "guard-published-original");
  } finally {
    closeFixture(fixture);
  }
}

async function verifyExclusiveGuardTempCleanupRecovery() {
  const fixture = createFixture({ openStore: false });
  let source = "";
  let injected = false;
  const interruptedExclusiveGuard = new Proxy(fs, {
    get(target, property, receiver) {
      if (property === "linkSync") {
        return () => { throw Object.assign(new Error("links unsupported"), { code: "EPERM" }); };
      }
      if (property === "unlinkSync") {
        return (targetPath, ...args) => {
          const text = String(targetPath || "");
          if (!injected && source && text.endsWith(".prepared") && fs.existsSync(source)) {
            const sourceEntry = fs.lstatSync(source, { bigint: true });
            const preparedEntry = fs.lstatSync(text, { bigint: true });
            if (String(sourceEntry.dev) === String(preparedEntry.dev)
              && String(sourceEntry.ino) !== String(preparedEntry.ino)) {
              injected = true;
              throw Object.assign(new Error("injected exclusive guard temp cleanup interruption"), { code: "EACCES" });
            }
          }
          return fs.unlinkSync(targetPath, ...args);
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  try {
    fixture.store = createShortVideoStore({
      ...storeOptions(fixture),
      deleteJobFsOps: interruptedExclusiveGuard
    });
    fixture.store.summary();
    source = writeMedia(fixture.root, "guard-exclusive-published/video.mp4", "guard-exclusive-original");
    seedVideo(fixture.dbPath, { id: "guard-exclusive-published", sourcePath: source });

    await assert.rejects(
      () => fixture.store.deleteVideo("guard-exclusive-published"),
      (error) => error?.code === "SHORT_VIDEO_DELETE_GUARD_TEMP_CLEANUP"
    );
    assert.equal(injected, true, "the fixture must interrupt an independently published exclusive-create guard");
    assert.equal(deleteItemRows(fixture.dbPath)[0]?.guard_publish_mode, "exclusive_create");
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back");
    assert.equal(fs.readFileSync(source, "utf8"), "guard-exclusive-original");
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);

    await fixture.store.recoverDeleteJobs();
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back", "exclusive guard recovery must be idempotent");
  } finally {
    closeFixture(fixture);
  }
}

async function verifyActiveExecuteRecoveryFencing() {
  const windows = [
    { name: "plan", hook: "afterPlanPersisted", expectedStatus: "running", expectedPhase: "planned" },
    { name: "isolation", hook: "afterItemIsolated", expectedStatus: "running", expectedPhase: "isolating" },
    { name: "db-commit-cleanup", hook: "afterDatabaseCommit", expectedStatus: "cleanup_pending", expectedPhase: "db_committed" }
  ];
  for (const window of windows) {
    const fixture = createFixture();
    let releaseHook = null;
    let releaseEntered = null;
    let deletion = null;
    const entered = new Promise((resolve) => { releaseEntered = resolve; });
    const blocked = new Promise((resolve) => { releaseHook = resolve; });
    try {
      fixture.hooks[window.hook] = async () => {
        releaseEntered();
        await blocked;
      };
      const id = `active-${window.name}`;
      const source = writeMedia(fixture.root, `${window.name}/video.mp4`, `active-${window.name}`);
      seedVideo(fixture.dbPath, { id, sourcePath: source });
      deletion = fixture.store.deleteVideo(id);
      await entered;

      const before = jobRows(fixture.dbPath)[0];
      assert.equal(before?.status, window.expectedStatus);
      assert.equal(before?.phase, window.expectedPhase);
      const listed = fixture.store.deleteJobStatus().jobs.find((job) => job.id === before.id);
      assert(listed, `${window.name} must be visible in the pending status list`);
      assert.equal(listed.blockedByActiveOwner, true, `${window.name} must advertise an active execution fence`);
      assert.equal(listed.recoverable, false, `${window.name} must not advertise recovery while execute is active`);

      const recovery = await fixture.store.recoverDeleteJobs({ jobId: before.id });
      assert.equal(recovery.job?.blockedByActiveOwner, true);
      assert.equal(recovery.job?.recoverable, false);
      const afterRecovery = jobRows(fixture.dbPath)[0];
      assert.equal(afterRecovery.status, before.status, `${window.name} recovery must not change status`);
      assert.equal(afterRecovery.phase, before.phase, `${window.name} recovery must not change phase`);
      assert.equal(afterRecovery.owner_id, before.owner_id, `${window.name} recovery must not steal the active owner`);
      assert.equal(afterRecovery.version, before.version, `${window.name} recovery must not mutate the active journal`);
      assert.equal(afterRecovery.attempts, before.attempts, `${window.name} recovery must not increment attempts`);

      releaseHook();
      const result = await deletion;
      deletion = null;
      assert.equal(result.status, "completed", `${window.name} execute must finish after the recovery probe`);
      assert.equal(fs.existsSync(source), false);
      assertNoActiveReservations(fixture.dbPath);
      assertNoQuarantine(fixture.root);
    } finally {
      releaseHook?.();
      if (deletion) await deletion.catch(() => {});
      closeFixture(fixture);
    }
  }
}

async function verifyWorkerThreadDurableExecutionFence() {
  const fixture = createFixture({ openStore: false });
  let executeWorker = null;
  try {
    const initializer = createShortVideoStore(storeOptions(fixture));
    initializer.summary();
    initializer.close();
    const source = writeMedia(fixture.root, "worker-fence/video.mp4", "worker-fence-original");
    seedVideo(fixture.dbPath, { id: "worker-fence", sourcePath: source });

    executeWorker = new Worker(WORKER_THREAD_CHILD, {
      workerData: {
        role: "execute",
        dbPath: fixture.dbPath,
        coverDbPath: fixture.coverDbPath,
        root: fixture.root,
        videoId: "worker-fence"
      }
    });
    const paused = await waitForWorkerMessage(executeWorker, "paused");
    assert.equal(paused.pid, process.pid, "worker_threads must share the process PID for this fence test");
    const before = jobRows(fixture.dbPath)[0];
    assert.equal(before?.id, paused.jobId);
    assert.equal(before?.phase, "isolating");
    assert.equal(deleteItemRows(fixture.dbPath)[0]?.state, "isolating");
    assert.equal(fs.readFileSync(source, "utf8"), "worker-fence-original", "A must pause before physical rename");
    assert.match(before?.execution_token || "", /^[0-9a-f]{48}$/);
    const expired = openDb(fixture.dbPath);
    try {
      expired.prepare("UPDATE short_video_delete_jobs SET lease_until = ? WHERE id = ?")
        .run(new Date(Date.now() - 60_000).toISOString(), before.id);
    } finally {
      expired.close();
    }

    const firstRecovery = await runRecoveryWorker(fixture, before.id);
    assert.equal(firstRecovery.pid, process.pid);
    assert.equal(firstRecovery.result.job?.blockedByActiveOwner, true);
    assert.equal(firstRecovery.result.job?.recoverable, false);
    assert.equal(firstRecovery.result.job?.owner_id, before.owner_id);
    assert.match(firstRecovery.result.job?.lease_until || "", /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(firstRecovery.result.job?.processRestartRequired, true);
    assertWorkerFenceUnchanged(fixture, before, source, "cross-isolate recovery");

    executeWorker.postMessage({ type: "close" });
    const closeResult = await waitForWorkerMessage(executeWorker, "close-result");
    assert.equal(closeResult.closed, false, "close must defer database shutdown while execute owns a durable token");
    const secondRecovery = await runRecoveryWorker(fixture, before.id);
    assert.equal(secondRecovery.result.job?.blockedByActiveOwner, true);
    assert.equal(secondRecovery.result.job?.recoverable, false);
    assert.equal(secondRecovery.result.job?.retryable, false);
    assert.equal(secondRecovery.result.job?.manualInterventionRequired, true);
    assert.equal(secondRecovery.result.job?.processRestartRequired, true);
    assertWorkerFenceUnchanged(fixture, before, source, "close-while-execute recovery");

    executeWorker.postMessage({ type: "resume" });
    const finished = await waitForWorkerMessage(executeWorker, "finished");
    assert.equal(finished.result.status, "completed");
    await waitForWorkerExit(executeWorker);
    executeWorker = null;
    assert.equal(fs.existsSync(source), false);
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "completed");
    assert.equal(jobRows(fixture.dbPath)[0]?.execution_token, "");
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);
  } finally {
    if (executeWorker) await terminateWorker(executeWorker);
    closeFixture(fixture);
  }
}

async function runRecoveryWorker(fixture, jobId) {
  const worker = new Worker(WORKER_THREAD_CHILD, {
    workerData: {
      role: "recover",
      dbPath: fixture.dbPath,
      coverDbPath: fixture.coverDbPath,
      root: fixture.root,
      jobId
    }
  });
  try {
    const result = await waitForWorkerMessage(worker, "recovered");
    await waitForWorkerExit(worker);
    return result;
  } catch (error) {
    await terminateWorker(worker);
    throw error;
  }
}

function assertWorkerFenceUnchanged(fixture, before, source, label) {
  const after = jobRows(fixture.dbPath)[0];
  assert.equal(after.status, before.status, `${label} must not change status`);
  assert.equal(after.phase, before.phase, `${label} must not change phase`);
  assert.equal(after.owner_id, before.owner_id, `${label} must not replace owner`);
  assert.equal(after.execution_token, before.execution_token, `${label} must not replace execution token`);
  assert.equal(after.attempts, before.attempts, `${label} must not increment attempts`);
  assert.equal(activeReservationCount(fixture.dbPath) > 0, true);
  assert.equal(fs.readFileSync(source, "utf8"), "worker-fence-original");
}

function waitForWorkerMessage(worker, expectedType, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`timed out waiting for worker message: ${expectedType}`)), timeoutMs);
    const onMessage = (message) => {
      if (message?.type === "error") {
        finish(new Error(`worker failed: ${message.code} ${message.message}\n${message.stack}`));
        return;
      }
      if (message?.type !== expectedType) return;
      finish(null, message);
    };
    const onError = (error) => finish(error);
    const onExit = (code) => {
      if (code !== 0) finish(new Error(`worker exited with code ${code} before ${expectedType}`));
    };
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (error) reject(error);
      else resolve(value);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function waitForWorkerExit(worker, timeoutMs = 10_000) {
  if (worker.threadId === -1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for worker exit")), timeoutMs);
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}`));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function terminateWorker(worker) {
  try { await worker.terminate(); } catch {}
}

async function verifyPostIsolationOpenHandleOverwriteFailsClosed() {
  const fixture = createFixture();
  const fileSize = 256 * 1024;
  const middleBytes = Buffer.alloc(64 * 1024, 0x42);
  const middleOffset = Math.floor((fileSize - middleBytes.length) / 2);
  const original = Buffer.alloc(fileSize, 0x41);
  const fixedTime = new Date("2024-01-02T03:04:05.000Z");
  let sourceHandle = null;
  try {
    const source = writeMedia(fixture.root, "open-handle/video.mp4", original);
    fs.utimesSync(source, fixedTime, fixedTime);
    seedVideo(fixture.dbPath, { id: "open-handle-overwrite", sourcePath: source });
    const originalIdentity = fs.lstatSync(source, { bigint: true });
    sourceHandle = fs.openSync(source, "r+");
    let overwriteObserved = false;

    fixture.hooks.afterItemIsolated = ({ ordinal }) => {
      if (ordinal !== 0) return;
      const item = deleteItemRows(fixture.dbPath)[0];
      const quarantinedIdentity = fs.lstatSync(item.quarantine_path, { bigint: true });
      const handleIdentity = fs.fstatSync(sourceHandle, { bigint: true });
      assert.equal(handleIdentity.dev, quarantinedIdentity.dev);
      assert.equal(handleIdentity.ino, quarantinedIdentity.ino, "the handle opened before delete must still address the isolated file");

      fs.writeSync(sourceHandle, middleBytes, 0, middleBytes.length, middleOffset);
      fs.fsyncSync(sourceHandle);
      fs.futimesSync(sourceHandle, fixedTime, fixedTime);
      const replacedIdentity = fs.lstatSync(item.quarantine_path, { bigint: true });
      assert.equal(replacedIdentity.dev, originalIdentity.dev);
      assert.equal(replacedIdentity.ino, originalIdentity.ino);
      assert.equal(replacedIdentity.size, originalIdentity.size);
      assert.equal(replacedIdentity.mtimeNs, originalIdentity.mtimeNs, "the fixture must restore mtime after the isolated-file overwrite");
      assert.deepEqual(
        fs.readFileSync(item.quarantine_path).subarray(middleOffset, middleOffset + middleBytes.length),
        middleBytes,
        "the pre-opened handle must change the quarantined middle bytes"
      );
      overwriteObserved = true;
    };

    await assert.rejects(
      () => fixture.store.deleteVideo("open-handle-overwrite"),
      (error) => error?.code === "SHORT_VIDEO_DELETE_FILE_REPLACED"
    );
    assert.equal(overwriteObserved, true);
    assert.equal(videoExists(fixture.dbPath, "open-handle-overwrite"), true);
    const repairedJob = jobRows(fixture.dbPath)[0];
    assert.equal(repairedJob?.status, "rollback_pending");
    assert.equal(activeReservationCount(fixture.dbPath) > 0, true);
    const pendingItem = deleteItemRows(fixture.dbPath)[0];
    assert.equal(pendingItem.state, "isolated");
    assert.equal(fs.existsSync(pendingItem.quarantine_path), true);

    fs.writeSync(sourceHandle, original.subarray(middleOffset, middleOffset + middleBytes.length), 0, middleBytes.length, middleOffset);
    fs.fsyncSync(sourceHandle);
    fs.futimesSync(sourceHandle, fixedTime, fixedTime);
    fs.closeSync(sourceHandle);
    sourceHandle = null;
    fixture.hooks.afterItemIsolated = null;

    await fixture.store.recoverDeleteJobs({ jobId: repairedJob.id });
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back");
    assert.equal(videoExists(fixture.dbPath, "open-handle-overwrite"), true);
    assert.deepEqual(fs.readFileSync(source), original, "repairing the owned quarantine bytes must allow a byte-exact rollback");
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);
    await fixture.store.recoverDeleteJobs();
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back");
  } finally {
    if (sourceHandle !== null) fs.closeSync(sourceHandle);
    closeFixture(fixture);
  }
}

async function verifyAfterAllIsolatedBusyRecovery() {
  const fixture = createFixture({ busyTimeoutMs: 30 });
  let locker = null;
  try {
    const first = writeMedia(fixture.root, "commit-busy/first.mp4", "commit-busy-first");
    const second = writeMedia(fixture.root, "commit-busy/second.mp4", "commit-busy-second");
    seedVideo(fixture.dbPath, { id: "commit-busy-1", sourcePath: first });
    seedVideo(fixture.dbPath, { id: "commit-busy-2", sourcePath: second });
    fixture.hooks.afterAllIsolated = () => {
      locker = openDb(fixture.dbPath);
      locker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    };

    await assert.rejects(
      () => fixture.store.deleteVideos(["commit-busy-1", "commit-busy-2"]),
      (error) => error?.statusCode === 503 && error?.code === "SHORT_VIDEO_DELETE_BUSY"
    );
    const job = jobRows(fixture.dbPath)[0];
    const items = deleteItemRows(fixture.dbPath);
    assert.equal(job?.status, "running");
    assert.equal(job?.phase, "isolated");
    assert.deepEqual(items.map((item) => item.state), ["isolated", "isolated"]);
    assert(items.every((item) => fs.existsSync(item.quarantine_path)));
    assert(items.every((item) => /^FANHAO_SHORT_VIDEO_DELETE_GUARD:/.test(fs.readFileSync(item.original_path, "utf8"))));
    assert.equal(videoExists(fixture.dbPath, "commit-busy-1"), true);
    assert.equal(videoExists(fixture.dbPath, "commit-busy-2"), true);
    assert.equal(activeReservationCount(fixture.dbPath) > 0, true);

    locker.exec("ROLLBACK");
    locker.close();
    locker = null;
    fixture.hooks.afterAllIsolated = null;
    await fixture.store.recoverDeleteJobs();
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back");
    assert.equal(fs.readFileSync(first, "utf8"), "commit-busy-first");
    assert.equal(fs.readFileSync(second, "utf8"), "commit-busy-second");
    assert.equal(videoExists(fixture.dbPath, "commit-busy-1"), true);
    assert.equal(videoExists(fixture.dbPath, "commit-busy-2"), true);
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);
    await fixture.store.recoverDeleteJobs();
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back");
  } finally {
    if (locker) {
      try {
        locker.exec("ROLLBACK");
      } catch {}
      locker.close();
    }
    closeFixture(fixture);
  }
}

async function verifyLargeUnrelatedReferenceSetIsBounded() {
  const fixture = createFixture({ openStore: false });
  const missingDirectory = path.join(fixture.root, "missing-unrelated");
  const probeCounts = new Map();
  let unrelatedLeafProbeCount = 0;
  const countProbe = (operation, targetPath) => {
    const text = String(targetPath || "");
    if (!text.includes(missingDirectory)) return;
    probeCounts.set(operation, Number(probeCounts.get(operation) || 0) + 1);
    if (/unrelated-\d+\.missing$/u.test(text)) unrelatedLeafProbeCount += 1;
  };
  const guardedFsOps = new Proxy(fs, {
    get(target, property, receiver) {
      if (["existsSync", "accessSync", "lstatSync", "statSync", "realpathSync"].includes(String(property))) {
        return (targetPath, ...args) => {
          countProbe(String(property), targetPath);
          return Reflect.get(target, property, receiver)(targetPath, ...args);
        };
      }
      if (property === "realpathSyncNative") {
        return (targetPath, ...args) => {
          countProbe("realpathSyncNative", targetPath);
          return fs.realpathSync.native(targetPath, ...args);
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  try {
    fixture.store = createShortVideoStore({
      ...storeOptions(fixture),
      deleteJobFsOps: guardedFsOps
    });
    fixture.store.summary();
    const target = writeMedia(fixture.root, "bounded/target.mp4", "bounded-target-video");
    seedVideo(fixture.dbPath, { id: "bounded-target", sourcePath: target });

    const rowCount = 2_001;
    const db = openDb(fixture.dbPath);
    try {
      const insert = db.prepare(`
        INSERT INTO short_videos (id, source_path, size_bytes, file_name)
        VALUES (?, ?, ?, ?)
      `);
      db.exec("BEGIN");
      for (let index = 0; index < rowCount; index += 1) {
        const id = `unrelated-${String(index).padStart(5, "0")}`;
        const inaccessible = path.join(missingDirectory, `${id}.missing`);
        const badPath = `\0fanhao-unrelated-${index}.invalid`;
        insert.run(id, index % 997 === 0 ? badPath : inaccessible, 1_000_000 + index, `${id}.blocked`);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      db.close();
    }

    const startedAt = performance.now();
    const result = await fixture.store.deleteVideo("bounded-target");
    const elapsedMs = performance.now() - startedAt;
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(videoExists(fixture.dbPath, "bounded-target"), false);
    assert.equal(countVideosWithPrefix(fixture.dbPath, "unrelated-"), rowCount);
    assert.equal(Number(probeCounts.get("existsSync") || 0), 0, "reference scans must not use existsSync for every missing row");
    assert.equal(Number(probeCounts.get("accessSync") || 0), 0, "reference scans must not use accessSync for every missing row");
    assert.equal(unrelatedLeafProbeCount, 0, "a shared missing ancestor must avoid per-row filesystem probes");
    assert(
      [...probeCounts.values()].reduce((sum, count) => sum + count, 0) <= 4,
      `unrelated missing references must have a bounded ancestor probe count: ${JSON.stringify(Object.fromEntries(probeCounts))}`
    );
    assert(
      elapsedMs < 2_500,
      `deleting one target among ${rowCount} unrelated rows must remain bounded (elapsed ${elapsedMs.toFixed(1)}ms)`
    );
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);
  } finally {
    closeFixture(fixture);
  }
}

async function verifyOutsideJunctionProbeFailureRetains() {
  const fixture = createFixture({ openStore: false });
  const targetDir = path.join(fixture.root, "outside-inaccessible-target");
  const outsideAliasDir = path.join(fixture.temp.tempDir, "outside-inaccessible-junction");
  const shared = path.join(targetDir, "shared.mp4");
  const aliasPath = path.join(outsideAliasDir, "shared.mp4");
  let failedProbeCount = 0;
  const inaccessibleAlias = new Proxy(fs, {
    get(target, property, receiver) {
      if (property === "statSync") {
        return (targetPath, ...args) => {
          if (path.resolve(String(targetPath || "")) === path.resolve(aliasPath)) {
            failedProbeCount += 1;
            throw Object.assign(new Error("injected outside junction access denial"), { code: "EACCES" });
          }
          return fs.statSync(targetPath, ...args);
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  try {
    fs.mkdirSync(targetDir);
    fs.writeFileSync(shared, "outside-inaccessible-shared");
    fs.symlinkSync(targetDir, outsideAliasDir, process.platform === "win32" ? "junction" : "dir");
    fixture.store = createShortVideoStore({ ...storeOptions(fixture), deleteJobFsOps: inaccessibleAlias });
    fixture.store.summary();
    seedVideo(fixture.dbPath, { id: "outside-inaccessible-delete", sourcePath: shared });
    seedVideo(fixture.dbPath, { id: "outside-inaccessible-survivor", sourcePath: aliasPath });

    const result = await fixture.store.deleteVideo("outside-inaccessible-delete");
    assert.equal(failedProbeCount > 0, true, "the actual outside-root junction path must reach the failing stat probe");
    assert(result.skippedFiles.some((item) => item.path === relative(fixture.root, shared) && /引用/.test(item.reason)));
    assert.equal(videoExists(fixture.dbPath, "outside-inaccessible-delete"), false);
    assert.equal(videoExists(fixture.dbPath, "outside-inaccessible-survivor"), true);
    assert.equal(fs.readFileSync(shared, "utf8"), "outside-inaccessible-shared");
    assert.equal(fs.readFileSync(aliasPath, "utf8"), "outside-inaccessible-shared");
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);
  } finally {
    closeFixture(fixture);
  }
}

async function verifySameRootJunctionSharedReference() {
  const fixture = createFixture();
  try {
    const targetDir = path.join(fixture.root, "junction-target");
    const aliasDir = path.join(fixture.root, "junction-alias");
    fs.mkdirSync(targetDir);
    const shared = path.join(targetDir, "shared.mp4");
    fs.writeFileSync(shared, "junction-shared-video");
    fs.symlinkSync(targetDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = path.join(aliasDir, "shared.mp4");
    seedVideo(fixture.dbPath, { id: "junction-direct", sourcePath: shared });
    seedVideo(fixture.dbPath, { id: "junction-alias", sourcePath: aliasPath });

    const result = await fixture.store.deleteVideo("junction-direct");
    assert.equal(result.ok, true);
    assert(result.skippedFiles.some((item) => item.path === relative(fixture.root, shared) && /其他短视频/.test(item.reason)));
    assert.equal(videoExists(fixture.dbPath, "junction-direct"), false);
    assert.equal(videoExists(fixture.dbPath, "junction-alias"), true);
    assert.equal(fs.readFileSync(shared, "utf8"), "junction-shared-video");
    assert.equal(fs.readFileSync(aliasPath, "utf8"), "junction-shared-video", "a same-root junction alias survivor must remain readable");
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);
  } finally {
    closeFixture(fixture);
  }
}

async function verifyOutsideAndCrossRootPhysicalReferences() {
  const outsideAlias = createFixture();
  try {
    const targetDir = path.join(outsideAlias.root, "outside-target");
    const aliasDir = path.join(outsideAlias.temp.tempDir, "outside-junction");
    fs.mkdirSync(targetDir);
    const shared = path.join(targetDir, "shared.mp4");
    fs.writeFileSync(shared, "outside-junction-shared");
    fs.symlinkSync(targetDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = path.join(aliasDir, "shared.mp4");
    seedVideo(outsideAlias.dbPath, { id: "outside-direct", sourcePath: shared });
    seedVideo(outsideAlias.dbPath, { id: "outside-survivor", sourcePath: aliasPath });

    const result = await outsideAlias.store.deleteVideo("outside-direct");
    assert(result.skippedFiles.some((item) => item.path === relative(outsideAlias.root, shared)));
    assert.equal(videoExists(outsideAlias.dbPath, "outside-direct"), false);
    assert.equal(videoExists(outsideAlias.dbPath, "outside-survivor"), true);
    assert.equal(fs.readFileSync(shared, "utf8"), "outside-junction-shared");
    assert.equal(fs.readFileSync(aliasPath, "utf8"), "outside-junction-shared");
  } finally {
    closeFixture(outsideAlias);
  }

  const crossRoot = createFixture({ openStore: false });
  try {
    const secondRoot = path.join(crossRoot.temp.tempDir, "media-two");
    fs.mkdirSync(secondRoot);
    crossRoot.store = createShortVideoStore({ ...storeOptions(crossRoot), roots: [crossRoot.root, secondRoot] });
    crossRoot.store.summary();
    const selected = writeMedia(crossRoot.root, "cross-root/selected.mp4", "cross-root-hardlink");
    const survivor = path.join(secondRoot, "survivor.mp4");
    fs.linkSync(selected, survivor);
    seedVideo(crossRoot.dbPath, { id: "cross-selected", sourcePath: selected });
    seedVideo(crossRoot.dbPath, { id: "cross-survivor", sourcePath: survivor });

    const result = await crossRoot.store.deleteVideo("cross-selected");
    assert(result.skippedFiles.some((item) => /引用|硬链接/.test(item.reason)));
    assert.equal(videoExists(crossRoot.dbPath, "cross-selected"), false);
    assert.equal(videoExists(crossRoot.dbPath, "cross-survivor"), true);
    assert.equal(fs.readFileSync(selected, "utf8"), "cross-root-hardlink");
    assert.equal(fs.readFileSync(survivor, "utf8"), "cross-root-hardlink");
  } finally {
    closeFixture(crossRoot);
  }
}

async function verifyHardlinkRetentionAndTombstones() {
  const selected = createFixture();
  try {
    const first = writeMedia(selected.root, "hardlinks/first.mp4", "all-selected-hardlinks");
    const second = path.join(selected.root, "hardlinks", "second.mp4");
    fs.linkSync(first, second);
    seedVideo(selected.dbPath, { id: "hardlink-first", sourcePath: first });
    seedVideo(selected.dbPath, { id: "hardlink-second", sourcePath: second });

    const result = await selected.store.deleteVideos(["hardlink-first", "hardlink-second"]);
    assert.equal(result.status, "completed");
    assert.equal(result.skippedFiles.filter((item) => /硬链接/.test(item.reason)).length, 2);
    assert.equal(videoExists(selected.dbPath, "hardlink-first"), false);
    assert.equal(videoExists(selected.dbPath, "hardlink-second"), false);
    assert.equal(fs.readFileSync(first, "utf8"), "all-selected-hardlinks");
    assert.equal(fs.readFileSync(second, "utf8"), "all-selected-hardlinks");
    const db = openDb(selected.dbPath);
    try {
      assert.equal(Number(db.prepare(`
        SELECT COUNT(*) AS count FROM short_video_path_tombstones
        WHERE original_path IN (?, ?) AND state = 'active'
      `).get(first, second)?.count || 0), 2, "each selected hardlink lexical path needs its own durable tombstone");
    } finally {
      db.close();
    }
  } finally {
    closeFixture(selected);
  }

  const survivor = createFixture();
  try {
    const selectedPath = writeMedia(survivor.root, "hardlink-survivor/selected.mp4", "selected-survivor-hardlinks");
    const survivorPath = path.join(survivor.root, "hardlink-survivor", "survivor.mp4");
    fs.linkSync(selectedPath, survivorPath);
    seedVideo(survivor.dbPath, { id: "hardlink-selected", sourcePath: selectedPath });
    seedVideo(survivor.dbPath, { id: "hardlink-survivor", sourcePath: survivorPath });
    const result = await survivor.store.deleteVideo("hardlink-selected");
    assert(result.skippedFiles.some((item) => /引用|硬链接/.test(item.reason)));
    assert.equal(videoExists(survivor.dbPath, "hardlink-selected"), false);
    assert.equal(videoExists(survivor.dbPath, "hardlink-survivor"), true);
    assert.equal(fs.readFileSync(selectedPath, "utf8"), "selected-survivor-hardlinks");
    assert.equal(fs.readFileSync(survivorPath, "utf8"), "selected-survivor-hardlinks");
  } finally {
    closeFixture(survivor);
  }
}

async function verifyJunctionRetargetAfterOwnerSnapshot() {
  const fixture = createFixture();
  try {
    const selectedDir = path.join(fixture.root, "retarget-selected");
    const initialDir = path.join(fixture.root, "retarget-initial");
    const aliasDir = path.join(fixture.root, "retarget-alias");
    fs.mkdirSync(selectedDir);
    fs.mkdirSync(initialDir);
    const selectedPath = path.join(selectedDir, "video.mp4");
    const initialPath = path.join(initialDir, "video.mp4");
    fs.writeFileSync(selectedPath, "retarget-selected-content");
    fs.writeFileSync(initialPath, "retarget-initial-content");
    fs.symlinkSync(initialDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = path.join(aliasDir, "video.mp4");
    seedVideo(fixture.dbPath, { id: "retarget-delete", sourcePath: selectedPath });
    seedVideo(fixture.dbPath, { id: "retarget-survivor", sourcePath: aliasPath });
    let retargeted = false;
    fixture.hooks.afterReferenceSnapshot = ({ phase }) => {
      if (phase !== "plan" || retargeted) return;
      retargeted = true;
      fs.unlinkSync(aliasDir);
      fs.symlinkSync(selectedDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    };

    const result = await fixture.store.deleteVideo("retarget-delete");
    assert.equal(retargeted, true);
    assert(result.skippedFiles.some((item) => /引用/.test(item.reason)));
    assert.equal(videoExists(fixture.dbPath, "retarget-delete"), false);
    assert.equal(videoExists(fixture.dbPath, "retarget-survivor"), true);
    assert.equal(fs.readFileSync(selectedPath, "utf8"), "retarget-selected-content");
    assert.equal(fs.readFileSync(aliasPath, "utf8"), "retarget-selected-content");
  } finally {
    closeFixture(fixture);
  }
}

async function verifyDeleteRouteStatusContract() {
  const completed = { ok: true, accepted: true, pending: false, status: "completed" };
  const cleanupPending = {
    ok: true,
    accepted: true,
    pending: true,
    status: "cleanup_pending",
    logicalDeleteCommitted: true,
    physicalCleanupComplete: false
  };
  const rollbackPending = {
    ok: false,
    accepted: false,
    pending: true,
    recoveryRequired: true,
    status: "rollback_pending"
  };
  for (const [pathname, methodName] of [
    ["/api/short-videos", "deleteVideos"],
    ["/api/short-videos/route-video", "deleteVideo"],
    ["/api/short-videos/videos/route-video", "deleteVideo"]
  ]) {
    for (const [result, expectedStatus] of [[completed, 200], [cleanupPending, 202], [rollbackPending, 500]]) {
      const response = await invokeDeleteRoute(pathname, {
        [methodName]: async () => result
      });
      assert.equal(response.status, expectedStatus, `${pathname} must map ${result.status} to ${expectedStatus}`);
      assert.equal(response.payload, result);
    }
  }

  const recoveryPending = await invokeDeleteRoute("/api/short-videos/delete-jobs", {
    recoverDeleteJobs: async () => ({ ok: true, jobs: [{ id: "pending", pending: true }] })
  }, { method: "POST", body: { jobId: "pending" } });
  assert.equal(recoveryPending.status, 202);
  const recoveryDone = await invokeDeleteRoute("/api/short-videos/delete-jobs", {
    recoverDeleteJobs: async () => ({ ok: true, job: { id: "done", pending: false } })
  }, { method: "POST", body: { jobId: "done" } });
  assert.equal(recoveryDone.status, 200);

  const collection = await invokeDeleteRoute("/api/short-videos/collections/collection-1", {
    renameCollection: () => ({ ok: true, pending: true, status: "cleanup_pending" })
  }, { method: "PATCH", body: { name: "renamed" } });
  assert.equal(collection.status, 200, "collection PATCH must not inherit delete-job status semantics");
}

async function verifyDeleteRouteAuthBeforeBody() {
  for (const { pathname, method, storeMethod } of [
    { pathname: "/api/short-videos", method: "DELETE", storeMethod: "deleteVideos" },
    { pathname: "/api/short-videos/videos/auth-video", method: "DELETE", storeMethod: "deleteVideo" },
    { pathname: "/api/short-videos/auth-video", method: "DELETE", storeMethod: "deleteVideo" },
    { pathname: "/api/short-videos/delete-jobs", method: "GET", storeMethod: "deleteJobStatus" },
    { pathname: "/api/short-videos/delete-jobs", method: "POST", storeMethod: "recoverDeleteJobs" }
  ]) {
    let bodyReads = 0;
    let storeCalls = 0;
    let sends = 0;
    const handled = await routeShortVideoApi(
      { method },
      {},
      new URL(`http://127.0.0.1${pathname}`),
      {
        notFound() { assert.fail(`unauthorized route unexpectedly fell through: ${pathname}`); },
        onMutation() { assert.fail(`unauthorized route mutated state: ${pathname}`); },
        readJsonBody: async () => { bodyReads += 1; return {}; },
        requireLocalAdmin: () => false,
        sendJson() { sends += 1; },
        shortVideoStore: { [storeMethod]() { storeCalls += 1; return {}; } }
      }
    );
    assert.equal(handled, true, `unauthorized route must be handled: ${method} ${pathname}`);
    assert.equal(bodyReads, 0, `authorization must run before body parsing: ${method} ${pathname}`);
    assert.equal(storeCalls, 0, `authorization must run before store access: ${method} ${pathname}`);
    assert.equal(sends, 0, `the admin guard owns the denied response: ${method} ${pathname}`);
  }
}

async function verifyGeneratedCoverUnlinkSafety() {
  const startup = createFixture();
  try {
    fs.mkdirSync(startup.coverCacheDir, { recursive: true });
    const generatedCover = path.join(startup.coverCacheDir, "startup-legacy-cover.jpg");
    const nativeCover = writeMedia(startup.root, "startup/native-cover.jpg", "startup-native-cover");
    const source = writeMedia(startup.root, "startup/video.mp4", "startup-video");
    fs.writeFileSync(generatedCover, "startup-generated-cover");
    seedVideo(startup.dbPath, { id: "startup-cover", sourcePath: source, coverPath: generatedCover });
    const db = openDb(startup.dbPath);
    try {
      const insert = db.prepare(`
        INSERT INTO short_video_assets (id, video_id, asset_type, local_path)
        VALUES (?, 'startup-cover', ?, ?)
      `);
      insert.run("startup-cover:ffmpeg_cover", "ffmpeg_cover", generatedCover);
      insert.run("startup-cover:native_cover", "native_cover", nativeCover);
    } finally {
      db.close();
    }
    startup.store.close();
    startup.store = createShortVideoStore({ ...storeOptions(startup), skipStartupMaintenance: false });
    startup.store.summary();
    assert.equal(fs.readFileSync(generatedCover, "utf8"), "startup-generated-cover", "startup reference cleanup must retain an unjournaled physical cover");
    const after = openDb(startup.dbPath);
    try {
      assert.equal(Number(after.prepare("SELECT COUNT(*) AS count FROM short_video_assets WHERE video_id = 'startup-cover' AND asset_type = 'ffmpeg_cover'").get()?.count || 0), 0);
      assert.equal(after.prepare("SELECT value FROM short_video_meta WHERE key = 'cover_physical_cleanup_mode'").get()?.value, "retained_unjournaled");
      assert.equal(after.prepare("SELECT value FROM short_video_meta WHERE key = 'cover_cleanup_at'").get(), undefined, "the retained-file lane must not advertise physical cleanup completion");
    } finally {
      after.close();
    }
  } finally {
    closeFixture(startup);
  }

  const shared = createFixture();
  try {
    fs.mkdirSync(shared.coverCacheDir, { recursive: true });
    const generatedCover = path.join(shared.coverCacheDir, "shared-legacy-cover.jpg");
    fs.writeFileSync(generatedCover, "shared-generated-cover");
    const first = writeScannerVideo(shared.root, "7000000000000000001", "first");
    const second = writeScannerVideo(shared.root, "7000000000000000002", "second");
    seedVideo(shared.dbPath, { id: first.id, sourcePath: first.videoPath, coverPath: generatedCover });
    seedVideo(shared.dbPath, { id: second.id, sourcePath: second.videoPath, coverPath: generatedCover });
    const db = openDb(shared.dbPath);
    try {
      const insert = db.prepare(`
        INSERT INTO short_video_assets (id, video_id, asset_type, local_path)
        VALUES (?, ?, 'ffmpeg_cover', ?)
      `);
      insert.run(`${first.id}:ffmpeg_cover`, first.id, generatedCover);
      insert.run(`${second.id}:ffmpeg_cover`, second.id, generatedCover);
    } finally {
      db.close();
    }
    shared.store.scan(shared.root);
    assert.equal(fs.readFileSync(generatedCover, "utf8"), "shared-generated-cover", "superseding one or more shared covers must retain the physical file");
    const after = openDb(shared.dbPath);
    try {
      assert.equal(Number(after.prepare("SELECT COUNT(*) AS count FROM short_video_assets WHERE local_path = ? AND asset_type = 'ffmpeg_cover'").get(generatedCover)?.count || 0), 0);
    } finally {
      after.close();
    }
  } finally {
    closeFixture(shared);
  }

  const rollback = createFixture();
  try {
    fs.mkdirSync(rollback.coverCacheDir, { recursive: true });
    const generatedCover = path.join(rollback.coverCacheDir, "rollback-legacy-cover.jpg");
    fs.writeFileSync(generatedCover, "rollback-generated-cover");
    const video = writeScannerVideo(rollback.root, "7000000000000000003", "rollback");
    seedVideo(rollback.dbPath, { id: video.id, sourcePath: video.videoPath, coverPath: generatedCover });
    const db = openDb(rollback.dbPath);
    try {
      db.prepare(`
        INSERT INTO short_video_assets (id, video_id, asset_type, local_path)
        VALUES (?, ?, 'ffmpeg_cover', ?)
      `).run(`${video.id}:ffmpeg_cover`, video.id, generatedCover);
      db.exec(`
        CREATE TRIGGER verify_scan_rollback_after_cover_delete
        BEFORE INSERT ON short_video_meta
        WHEN NEW.key = 'scanned_at'
        BEGIN
          SELECT RAISE(ABORT, 'verify scanner rollback');
        END;
      `);
    } finally {
      db.close();
    }
    rollback.store.close();
    rollback.store = createShortVideoStore(storeOptions(rollback));
    rollback.store.summary();
    assert.throws(() => rollback.store.scan(rollback.root), /verify scanner rollback/);
    assert.equal(fs.readFileSync(generatedCover, "utf8"), "rollback-generated-cover", "a later scanner transaction rollback must never lose the generated cover file");
    const after = openDb(rollback.dbPath);
    try {
      assert.equal(Number(after.prepare("SELECT COUNT(*) AS count FROM short_video_assets WHERE video_id = ? AND asset_type = 'ffmpeg_cover'").get(video.id)?.count || 0), 1, "the DB owner must roll back with the failed scan");
    } finally {
      after.close();
    }
  } finally {
    closeFixture(rollback);
  }
}

function writeScannerVideo(root, id, label) {
  const directory = path.join(root, `scanner-${label}`);
  fs.mkdirSync(directory, { recursive: true });
  const videoPath = path.join(directory, `${id}.mp4`);
  fs.writeFileSync(videoPath, `${label}-video`);
  fs.writeFileSync(path.join(directory, `${id}-cover.jpg`), `${label}-native-cover`);
  fs.writeFileSync(path.join(directory, `${id}_data.json`), JSON.stringify({ aweme_id: id, desc: label }));
  return { id, videoPath };
}

async function invokeDeleteRoute(pathname, shortVideoStore, { method = "DELETE", body = {} } = {}) {
  let response = null;
  const handled = await routeShortVideoApi(
    { method },
    {},
    new URL(`http://127.0.0.1${pathname}`),
    {
      notFound() { assert.fail(`route unexpectedly fell through: ${pathname}`); },
      onMutation() {},
      readJsonBody: async () => body,
      requireLocalAdmin: () => true,
      sendJson(_res, status, payload) { response = { status, payload }; },
      shortVideoStore
    }
  );
  assert.equal(handled, true);
  return response;
}

async function verifyScannerExclusion() {
  const fixture = createFixture();
  try {
    const normal = writeMedia(fixture.root, "scan/normal.mp4", "normal-video");
    const quarantineVariant = SHORT_VIDEO_DELETE_QUARANTINE_DIR.toUpperCase();
    const quarantined = writeMedia(fixture.root, `${quarantineVariant}/foreign/pending.mp4`, "quarantined-video");
    const result = fixture.store.scan(fixture.root);
    assert.equal(result.scannedFiles, 1, "the filesystem scanner must skip case variants of the reserved quarantine tree");
    const db = openDb(fixture.dbPath);
    try {
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM short_videos WHERE source_path = ?").get(normal)?.count || 0), 1);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM short_videos WHERE source_path = ?").get(quarantined)?.count || 0), 0);
    } finally {
      db.close();
    }
  } finally {
    closeFixture(fixture);
  }
}

async function verifyStartupRecoveryIsExplicit() {
  const fixture = createFixture({ openStore: false });
  try {
    const first = createShortVideoStore(storeOptions(fixture));
    first.summary();
    first.close();
    seedVideo(fixture.dbPath, { id: "probe", sourcePath: path.join(fixture.root, "missing-probe.mp4") });
    const db = openDb(fixture.dbPath);
    try {
      db.prepare(`
        INSERT INTO short_video_delete_jobs (
          id, status, phase, scope, anchor_id, video_ids_json, quarantine_token,
          owner_id, lease_until, created_at, updated_at
        ) VALUES ('startup-probe', 'running', 'planned', 'single', 'probe', '["probe"]',
                  'probe-token', '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO short_video_delete_reservations (
          job_id, kind, reservation_key, original_value, mutation_mode,
          released_at, created_at, updated_at
        ) VALUES ('startup-probe', 'video', 'probe', 'probe', '', '',
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
    } finally {
      db.close();
    }
    const workerLikeStore = createShortVideoStore(storeOptions(fixture));
    workerLikeStore.summary();
    workerLikeStore.close();
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "running", "ordinary writable worker stores must not execute filesystem recovery on open");

    const runtimeLikeStore = createShortVideoStore(storeOptions(fixture));
    await runtimeLikeStore.recoverDeleteJobs();
    runtimeLikeStore.close();
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back", "the explicit runtime startup hook must recover pending delete jobs");
  } finally {
    closeFixture(fixture);
  }
}

async function verifyLeaseClaimFencing() {
  const fixture = createFixture({ openStore: false });
  let first = null;
  let recovery = null;
  try {
    const firstOwner = `short-video-delete-owner-${process.pid}-lease-first`;
    const recoveryOwner = `short-video-delete-owner-${process.pid}-lease-recovery`;
    first = createShortVideoStore({ ...storeOptions(fixture), deleteJobOwnerId: firstOwner });
    first.summary();
    const missing = path.join(fixture.root, "lease", "missing.mp4");
    seedVideo(fixture.dbPath, { id: "lease-probe", sourcePath: missing });
    const expiredLease = new Date(Date.now() - 60_000).toISOString();
    const db = openDb(fixture.dbPath);
    try {
      db.prepare(`
        INSERT INTO short_video_delete_jobs (
          id, status, phase, scope, anchor_id, video_ids_json, quarantine_token,
          owner_id, lease_until, version, created_at, updated_at
        ) VALUES ('lease-probe-job', 'running', 'planned', 'single', 'lease-probe',
                  '["lease-probe"]', 'lease-probe-token', ?, ?, 7,
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run(firstOwner, expiredLease);
      db.prepare(`
        INSERT INTO short_video_delete_reservations (
          job_id, kind, reservation_key, original_value, mutation_mode,
          released_at, created_at, updated_at
        ) VALUES ('lease-probe-job', 'video', 'lease-probe', 'lease-probe', '', '',
                  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
    } finally {
      db.close();
    }

    recovery = createShortVideoStore({ ...storeOptions(fixture), deleteJobOwnerId: recoveryOwner });
    const fenced = await recovery.recoverDeleteJobs({ jobId: "lease-probe-job" });
    assert.equal(fenced.job?.pending, true, "a registered live owner must remain exclusive even after its lease timestamp expires");
    assert.equal(fenced.job?.leaseExpired, true);
    assert.equal(fenced.job?.blockedByActiveOwner, true);
    assert.equal(fenced.job?.stalled, true);
    assert.equal(fenced.job?.recoverable, false);
    const stillOwned = jobRows(fixture.dbPath)[0];
    assert.equal(stillOwned.owner_id, firstOwner);
    assert.equal(stillOwned.lease_until, expiredLease);
    assert.equal(stillOwned.version, 7);
    assert.equal(stillOwned.status, "running");
    assert.equal(activeReservationCount(fixture.dbPath), 1);

    first.close();
    first = null;
    const afterClose = jobRows(fixture.dbPath)[0];
    assert.equal(afterClose?.status, "running", "close must not release an execution without its exact durable token");
    assert.equal(afterClose?.owner_id, firstOwner);
    const restarted = openDb(fixture.dbPath);
    try {
      restarted.prepare(`
        UPDATE short_video_delete_jobs
        SET owner_id = 'short-video-delete-owner-2147483647-dead'
        WHERE id = 'lease-probe-job' AND owner_id = ? AND execution_token = ''
      `).run(firstOwner);
    } finally {
      restarted.close();
    }
    await recovery.recoverDeleteJobs({ jobId: "lease-probe-job" });
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "rolled_back", "a provably dead previous process must remain recoverable");
    assert.equal(videoExists(fixture.dbPath, "lease-probe"), true);
    assertNoActiveReservations(fixture.dbPath);
  } finally {
    recovery?.close();
    first?.close();
    closeFixture(fixture);
  }
}

async function verifyQueuedCleanupWriterFence() {
  const fixture = createFixture();
  const signals = path.join(fixture.temp.tempDir, "queued-writer-signals");
  const readyPath = path.join(signals, "ready");
  const startPath = path.join(signals, "start");
  const attemptingPath = path.join(signals, "attempting");
  const writerResultPath = path.join(signals, "result.json");
  let child = null;
  let childClosePromise = null;
  try {
    fs.mkdirSync(signals);
    const source = writeMedia(fixture.root, "queued-writer/video.mp4", "queued-writer-video");
    seedVideo(fixture.dbPath, { id: "queued-writer-source", sourcePath: source });
    child = spawn(process.execPath, [
      QUEUED_WRITER_CHILD,
      fixture.dbPath,
      fixture.root,
      readyPath,
      startPath,
      attemptingPath,
      writerResultPath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    childClosePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await waitForPath(readyPath, 5_000, () => child.exitCode !== null ? stderr || stdout : "");

    let writerAttemptedBeforeCleanupUnlink = false;
    fixture.hooks.beforeQuarantineCleanup = ({ ordinal }) => {
      if (ordinal !== 0) return;
      fs.writeFileSync(startPath, "start", { flag: "wx" });
      waitForPathSync(attemptingPath, 5_000);
      waitForPathSync(writerResultPath, 5_000);
      writerAttemptedBeforeCleanupUnlink = true;
    };

    const result = await fixture.store.deleteVideo("queued-writer-source");
    assert.equal(result.ok, true);
    assert.equal(writerAttemptedBeforeCleanupUnlink, true, "the official writer must revalidate after logical commit and before physical cleanup");
    const closed = await Promise.race([
      childClosePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`queued writer timed out: ${stderr || stdout}`)), 10_000))
    ]);
    assert.equal(closed.code, 0, `queued writer fixture failed: ${stderr || stdout}`);
    const writerResult = JSON.parse(fs.readFileSync(writerResultPath, "utf8"));
    assert.equal(writerResult.ok, false, "the queued writer must not insert after the cleanup lock is released");
    assert.equal(writerResult.code, "SHORT_VIDEO_PATH_WRITE_UNAVAILABLE");
    assert.match(writerResult.error, /短视频本地文件不可用/);
    assert.equal(countVideosBySourcePath(fixture.dbPath, source), 0);
    assert.equal(fs.existsSync(source), false);
    assert.equal(jobRows(fixture.dbPath)[0]?.status, "completed");
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);
    child = null;
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (childClosePromise) {
        await Promise.race([
          childClosePromise,
          new Promise((resolve) => setTimeout(resolve, 5_000))
        ]);
      }
    }
    closeFixture(fixture);
  }
}

async function verifyKilledProcessRecovery(boundary, expectedStatus) {
  const fixture = createFixture({ openStore: false });
  let primaryError = null;
  try {
    const first = writeMedia(fixture.root, `${boundary}/first.mp4`, `${boundary}-first`);
    const second = writeMedia(fixture.root, `${boundary}/second.mp4`, `${boundary}-second`);
    const initializer = createShortVideoStore(storeOptions(fixture));
    initializer.summary();
    initializer.close();
    seedVideo(fixture.dbPath, { id: `${boundary}-1`, sourcePath: first });
    seedVideo(fixture.dbPath, { id: `${boundary}-2`, sourcePath: second });

    const child = spawn(process.execPath, [
      CHILD,
      fixture.dbPath,
      fixture.root,
      boundary,
      `${boundary}-1`,
      `${boundary}-2`
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await killAtBoundary(child, boundary, closePromise);

    const before = jobRows(fixture.dbPath)[0];
    assert(before, `the ${boundary} child must persist a journal row before it is killed`);
    const interruptedItems = deleteItemRows(fixture.dbPath);
    if (["guard_half_written", "guard_pre_publish"].includes(boundary)) {
      const interrupted = interruptedItems.filter((item) => item.state === "isolating"
        && !fs.existsSync(item.original_path)
        && fs.existsSync(item.quarantine_path));
      assert.equal(interrupted.length, 1, `${boundary} must stop after media isolation and before guard journal persistence`);
      const prepared = fs.readdirSync(path.dirname(interrupted[0].quarantine_path))
        .filter((name) => name.endsWith(".prepared"));
      assert.equal(prepared.length, 1, `${boundary} must leave exactly one owned prepared guard temp`);
      const preparedBytes = fs.readFileSync(path.join(path.dirname(interrupted[0].quarantine_path), prepared[0]), "utf8");
      if (boundary === "guard_half_written") {
        assert.equal(preparedBytes, "FANHAO_SHORT", "the half-write fixture must stop with durable partial guard bytes");
      } else {
        assert.equal(
          preparedBytes,
          `FANHAO_SHORT_VIDEO_DELETE_GUARD:${before.id}:${before.quarantine_token}:${interrupted[0].ordinal}`,
          "the pre-publish fixture must stop after the complete guard bytes are fsynced"
        );
      }
    }
    if (boundary === "fallback_guard_published") {
      const interrupted = interruptedItems.filter((item) => item.state === "isolating"
        && item.guard_publish_mode === "exclusive_create"
        && fs.existsSync(item.original_path)
        && fs.existsSync(item.quarantine_path));
      assert.equal(interrupted.length, 1, "fallback publish must persist its mode before the child is killed");
      const prepared = fs.readdirSync(path.dirname(interrupted[0].quarantine_path))
        .map((name) => path.join(path.dirname(interrupted[0].quarantine_path), name))
        .find((name) => name.endsWith(".prepared"));
      assert(prepared, "fallback publish must retain the prepared guard across SIGKILL");
      const sourceEntry = fs.lstatSync(interrupted[0].original_path, { bigint: true });
      const preparedEntry = fs.lstatSync(prepared, { bigint: true });
      assert.notEqual(String(sourceEntry.ino), String(preparedEntry.ino), "exclusive-create guards must use independent inodes");
    }
    if (boundary === "post_cleanup_unlinks_pre_journal") {
      assert.equal(before.status, "cleanup_pending");
      assert.equal(before.phase, "cleanup");
      const interrupted = interruptedItems.filter((item) => item.state === "cleaning"
        && !fs.existsSync(item.original_path)
        && !fs.existsSync(item.quarantine_path));
      assert.equal(interrupted.length, 1, "the cleanup fixture must stop after both unlinks and before the item journal update commits");
    }
    if (boundary === "restore_renamed_pre_journal") {
      const interrupted = interruptedItems.filter((item) => item.state === "restoring"
        && fs.existsSync(item.original_path)
        && !fs.existsSync(item.quarantine_path));
      assert.equal(interrupted.length, 1, "restore crash fixture must stop after quarantine rename and before the restored checkpoint");
    }
    const expectedCommitted = expectedStatus === "completed";
    assert.equal(videoExists(fixture.dbPath, `${boundary}-1`), !expectedCommitted);
    assert.equal(videoExists(fixture.dbPath, `${boundary}-2`), !expectedCommitted);

    const recovery = createShortVideoStore(storeOptions(fixture));
    if (boundary === "fallback_guard_published") {
      const db = openDb(fixture.dbPath);
      try {
        db.prepare(`
          UPDATE short_video_delete_items
          SET guard_publish_mode = ''
          WHERE state = 'isolating' AND guard_publish_mode = 'exclusive_create'
        `).run();
      } finally {
        db.close();
      }
      const manualStatus = await recovery.recoverDeleteJobs();
      const manualJob = manualStatus.jobs.find((job) => job.id === before.id);
      assert.equal(manualJob?.manualInterventionRequired, true);
      assert.equal(manualJob?.recoverable, false);
      assert.equal(manualJob?.retryable, false);
      assert.equal(jobRows(fixture.dbPath)[0]?.status, "rollback_pending");
      assert.equal(jobRows(fixture.dbPath)[0]?.error_code, "SHORT_VIDEO_DELETE_GUARD_MODE_MISSING");
      assert.equal(activeReservationCount(fixture.dbPath) > 0, true);
      const restoreMode = openDb(fixture.dbPath);
      try {
        restoreMode.prepare(`
          UPDATE short_video_delete_items
          SET guard_publish_mode = 'exclusive_create'
          WHERE state = 'restoring' AND guard_publish_mode = ''
        `).run();
      } finally {
        restoreMode.close();
      }
      await recovery.recoverDeleteJobs();
      assert.equal(
        jobRows(fixture.dbPath)[0]?.status,
        "rollback_pending",
        "automatic recovery must skip a manual-intervention job even after the fixture repairs its guard mode"
      );
    }

    // Production passes skipStartupMaintenance=true. Opening through this call
    // must still run delete recovery before serving ordinary store work.
    await recovery.recoverDeleteJobs(boundary === "fallback_guard_published" ? { jobId: before.id } : undefined);

    const recovered = jobRows(fixture.dbPath)[0];
    assert.equal(recovered?.status, expectedStatus, `${boundary} recovery must converge to ${expectedStatus}`);
    if (expectedCommitted) {
      assert.equal(fs.existsSync(first), false, "post-commit recovery must never restore a file without its deleted DB row");
      assert.equal(fs.existsSync(second), false);
    } else {
      assert.equal(fs.readFileSync(first, "utf8"), `${boundary}-first`, "pre-commit recovery must restore the original bytes");
      assert.equal(fs.readFileSync(second, "utf8"), `${boundary}-second`);
    }
    assertNoActiveReservations(fixture.dbPath);
    assertNoQuarantine(fixture.root);

    await recovery.recoverDeleteJobs();
    assert.equal(recovery.close(), true, `${boundary} recovery must release its database handles`);
    assert.equal(jobRows(fixture.dbPath)[0]?.status, expectedStatus, "recovery must be idempotent");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      closeFixture(fixture);
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      console.error(`fixture cleanup also failed after ${boundary}: ${cleanupError?.message || cleanupError}`);
    }
  }
}

async function killAtBoundary(child, boundary, closePromise) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 15_000;
  while (!stdout.includes(`BOUNDARY:${boundary}\n`)) {
    if (child.exitCode !== null) throw new Error(`fault child exited before ${boundary}: ${stderr || stdout}`);
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      throw new Error(`timed out waiting for delete boundary ${boundary}: ${stderr || stdout}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill("SIGKILL");
  const closed = await Promise.race([
    closePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`fault child did not exit after SIGKILL at ${boundary}`)), 5_000))
  ]);
  assert(closed.signal || closed.code !== 0, `fault child must not exit normally at ${boundary}`);
}

async function waitForPath(targetPath, timeoutMs, earlyExitMessage = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(targetPath)) {
    const message = earlyExitMessage();
    if (message) throw new Error(`fixture exited before ${targetPath}: ${message}`);
    if (Date.now() >= deadline) throw new Error(`timed out waiting for fixture path: ${targetPath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForPathSync(targetPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(targetPath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for queued writer path: ${targetPath}`);
    Atomics.wait(waitState, 0, 0, 10);
  }
}

function createFixture(options = {}) {
  const temp = createVerifiedTempDir("fanhao-short-video-delete-");
  const root = path.join(temp.tempDir, "media");
  fs.mkdirSync(root);
  const fixture = {
    temp,
    root,
    dbPath: path.join(temp.tempDir, "short-videos.sqlite"),
    coverDbPath: path.join(temp.tempDir, "short-video-covers.sqlite"),
    coverCacheDir: path.join(temp.tempDir, "legacy-covers"),
    hooks: {},
    busyTimeoutMs: options.busyTimeoutMs || 250,
    store: null
  };
  if (options.openStore !== false) {
    fixture.store = createShortVideoStore(storeOptions(fixture));
    fixture.store.summary();
  }
  return fixture;
}

function storeOptions(fixture) {
  return {
    dbPath: fixture.dbPath,
    coverDbPath: fixture.coverDbPath,
    coverCacheDir: fixture.coverCacheDir,
    roots: [fixture.root],
    busyTimeoutMs: fixture.busyTimeoutMs,
    deleteJobTestHooks: fixture.hooks,
    deleteJobWarn() {},
    skipStartupMaintenance: true
  };
}

function closeFixture(fixture) {
  try {
    fixture.store?.close();
  } finally {
    fixture.temp.cleanup();
  }
}

function seedVideo(dbPath, { id, sourcePath, coverPath = "", musicPath = "", dataPath = "", title = "" }) {
  const db = openDb(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO short_videos (
        id, source_path, cover_path, music_path, data_path, title, file_name,
        imported_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, sourcePath, coverPath, musicPath, dataPath, title, path.basename(sourcePath), now, now);
  } finally {
    db.close();
  }
}

function seedAsset(dbPath, id, videoId, localPath) {
  const db = openDb(dbPath);
  try {
    db.prepare(`
      INSERT INTO short_video_assets (id, video_id, asset_type, local_path)
      VALUES (?, ?, 'poster', ?)
    `).run(id, videoId, localPath);
  } finally {
    db.close();
  }
}

function writeMedia(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 250; PRAGMA foreign_keys = ON");
  return db;
}

function videoExists(dbPath, id) {
  const db = openDb(dbPath);
  try {
    return Boolean(db.prepare("SELECT 1 FROM short_videos WHERE id = ?").get(id));
  } finally {
    db.close();
  }
}

function countVideosBySourcePath(dbPath, sourcePath) {
  const db = openDb(dbPath);
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM short_videos WHERE source_path = ?").get(sourcePath)?.count || 0);
  } finally {
    db.close();
  }
}

function countVideosWithPrefix(dbPath, prefix) {
  const db = openDb(dbPath);
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM short_videos WHERE id LIKE ?").get(`${prefix}%`)?.count || 0);
  } finally {
    db.close();
  }
}

function jobRows(dbPath) {
  const db = openDb(dbPath);
  try {
    return db.prepare("SELECT * FROM short_video_delete_jobs ORDER BY created_at DESC, id DESC").all();
  } finally {
    db.close();
  }
}

function deleteItemRows(dbPath) {
  const db = openDb(dbPath);
  try {
    return db.prepare(`
      SELECT ordinal, state, original_path, quarantine_path, guard_identity_json, guard_publish_mode
      FROM short_video_delete_items
      ORDER BY ordinal
    `).all();
  } finally {
    db.close();
  }
}

function activeReservationCount(dbPath) {
  const db = openDb(dbPath);
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM short_video_delete_reservations WHERE released_at = ''").get()?.count || 0);
  } finally {
    db.close();
  }
}

function assertNoActiveReservations(dbPath) {
  assert.equal(activeReservationCount(dbPath), 0, "a terminal delete job must release every reservation");
}

function assertLegacyDeleteResultFields(result) {
  for (const key of SUCCESS_KEYS) {
    assert(Object.hasOwn(result, key), `delete result must preserve legacy field ${key}`);
  }
}

function assertNoQuarantine(root) {
  assert.equal(fs.existsSync(path.join(root, SHORT_VIDEO_DELETE_QUARANTINE_DIR)), false, "a converged job must not leave a quarantine tree");
}

function relative(root, value) {
  return path.relative(root, value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
