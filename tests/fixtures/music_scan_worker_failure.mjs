import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

parentPort?.postMessage({ type: "ready", ok: true });

parentPort?.on("message", (message) => {
  if (message?.type !== "scan") return;
  if (workerData.mode === "hang") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    return;
  }
  if (workerData.mode === "commit-exit") {
    commitFixtureCatalog();
    process.exit(Number(workerData.exitCode || 27));
  }
  process.exit(Number(workerData.exitCode || 17));
});

function commitFixtureCatalog() {
  const database = new DatabaseSync(String(workerData.dbPath || ""));
  let transactionActive = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionActive = true;
    database.exec(`
      UPDATE music_artists
      SET name = 'New Artist', sort_name = 'New Artist'
      WHERE id = 'old-artist';
      UPDATE music_tracks
      SET title = 'New Track', sort_title = 'New Track', display_artist = 'New Artist'
      WHERE id = 'old-track';
    `);
    database.exec("COMMIT");
    transactionActive = false;
  } catch (error) {
    if (transactionActive) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    database.close();
  }
}
