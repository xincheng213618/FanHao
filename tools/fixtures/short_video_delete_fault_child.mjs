import { createShortVideoStore } from "../../src/modules/short-videos/server/store.js";
import fs from "node:fs";
import path from "node:path";

const [dbPath, root, boundary, ...videoIds] = process.argv.slice(2);
if (!dbPath || !root || !boundary || !videoIds.length) {
  throw new Error("usage: short_video_delete_fault_child.mjs <db> <root> <boundary> <video-id...>");
}

const waitState = new Int32Array(new SharedArrayBuffer(4));
let cleanedItems = 0;
let quarantineUnlinked = false;
let exclusiveDestinationHandle = null;

function stopAt(name) {
  if (name !== boundary) return;
  process.stdout.write(`BOUNDARY:${name}\n`);
  Atomics.wait(waitState, 0, 0);
}

const faultFsOps = new Proxy(fs, {
  get(target, property) {
    if (property === "linkSync" && boundary === "unsupported_isolate_pending_restart") {
      return () => { throw Object.assign(new Error("hardlinks unsupported"), { code: "ENOTSUP" }); };
    }
    if (property === "linkSync" && boundary.startsWith("fallback_guard_")) {
      return (sourcePath, targetPath) => {
        if (String(sourcePath).endsWith(".prepared")) {
          throw Object.assign(new Error("links unsupported"), { code: "EPERM" });
        }
        return fs.linkSync(sourcePath, targetPath);
      };
    }
    if (property === "openSync") {
      return (targetPath, flags, ...args) => {
        const handle = fs.openSync(targetPath, flags, ...args);
        if (boundary === "fallback_guard_half_written"
          && flags === "wx"
          && !String(targetPath).endsWith(".prepared")) {
          exclusiveDestinationHandle = handle;
        }
        return handle;
      };
    }
    if (property === "writeFileSync") {
      return (targetValue, content, ...args) => {
        if (
          boundary === "guard_half_written"
          && typeof targetValue === "number"
          && String(content).startsWith("FANHAO_SHORT_VIDEO_DELETE_GUARD:")
        ) {
          const prefix = String(content).slice(0, 12);
          const result = fs.writeFileSync(targetValue, prefix, ...args);
          fs.fsyncSync(targetValue);
          stopAt("guard_half_written");
          return result;
        }
        if (boundary === "fallback_guard_half_written"
          && targetValue === exclusiveDestinationHandle
          && String(content).startsWith("FANHAO_SHORT_VIDEO_DELETE_GUARD:")) {
          const prefix = String(content).slice(0, 20);
          const result = fs.writeFileSync(targetValue, prefix, ...args);
          fs.fsyncSync(targetValue);
          stopAt("fallback_guard_half_written");
          return result;
        }
        return fs.writeFileSync(targetValue, content, ...args);
      };
    }
    if (property === "fsyncSync") {
      return (handle) => {
        const result = fs.fsyncSync(handle);
        if (boundary === "guard_pre_publish") stopAt("guard_pre_publish");
        return result;
      };
    }
    if (property === "renameSync") {
      return (sourcePath, targetPath) => {
        if (["fallback_guard_published", "hardlink_guard_published"].includes(boundary)
          && String(sourcePath).endsWith(".prepared")
          && String(targetPath).endsWith("captured")) {
          stopAt(boundary);
        }
        return fs.renameSync(sourcePath, targetPath);
      };
    }
    if (property === "unlinkSync") {
      return (targetPath) => {
        if (["fallback_guard_published", "hardlink_guard_published"].includes(boundary)
          && String(targetPath).endsWith(".prepared")) {
          stopAt(boundary);
        }
        const result = fs.unlinkSync(targetPath);
        if (String(targetPath).endsWith(".quarantine")) {
          quarantineUnlinked = true;
        } else if (
          boundary === "post_cleanup_unlinks_pre_journal"
          && quarantineUnlinked
          && !String(targetPath).endsWith(".prepared")
        ) {
          stopAt("post_cleanup_unlinks_pre_journal");
        }
        return result;
      };
    }
    return Reflect.get(target, property, target);
  }
});

const store = createShortVideoStore({
  dbPath,
  coverCacheDir: path.join(root, "covers"),
  roots: [root],
  skipStartupMaintenance: true,
  deleteJobFsOps: faultFsOps,
  deleteJobTestHooks: {
    afterPlanPersisted() {
      stopAt("planned");
    },
    afterItemIsolated({ ordinal }) {
      if ((boundary === "restore_renamed_pre_journal" || boundary.startsWith("fs_restore_media_"))
        && ordinal === 0) {
        throw Object.assign(new Error("injected rollback after first isolation"), { code: "EACCES" });
      }
      if (ordinal === 0) stopAt("partially_isolated");
    },
    afterAllIsolated() {
      stopAt("isolated");
    },
    afterDatabaseCommit() {
      stopAt("db_committed");
    },
    afterItemCleaned() {
      cleanedItems += 1;
      if (cleanedItems === 1) stopAt("partially_cleaned");
    },
    afterRestoreRenamed({ ordinal }) {
      if (ordinal === 0) stopAt("restore_renamed_pre_journal");
    },
    afterFsActionNeutralized({ kind }) {
      if (boundary === "post_cleanup_unlinks_pre_journal" && kind === "guard-published-cleanup") {
        stopAt("post_cleanup_unlinks_pre_journal");
      }
    },
    afterFsActionSystemCall({ kind, boundary: actionBoundary }) {
      stopAt(`fs_${String(kind).replaceAll("-", "_")}_${actionBoundary}`);
    },
    afterDeletePendingRemembered({ errorCode }) {
      if (errorCode === "SHORT_VIDEO_DELETE_ISOLATE_NO_REPLACE_UNAVAILABLE") {
        stopAt("unsupported_isolate_pending_restart");
      }
    },
    afterExclusiveGuardOpen() {
      stopAt("fallback_guard_open_pre_identity");
    }
  }
});

try {
  await store.deleteVideos(videoIds, { deleteFiles: true });
} finally {
  store.close();
}
