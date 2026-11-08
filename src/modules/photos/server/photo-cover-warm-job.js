import { setImmediate, setTimeout } from "node:timers/promises";

const batchSize = 2;
const checkpointIntervalMs = 1500;
const emptyCounts = { cached: 0, generated: 0, skipped: 0, missing: 0, failed: 0 };

export function createPhotoCoverWarmJob({ getDb, buildPlan, warmCover, warn = console.warn }) {
  let job, plan, controller, runner;
  let closing = false;

  function load() {
    if (job !== undefined) return;
    const db = getDb();
    const read = db.prepare("SELECT value FROM photo_cover_warm_job WHERE key=?");
    const progress = read.get("progress");
    if (!progress) {
      job = null;
      return;
    }
    const savedPlan = JSON.parse(read.get("plan").value);
    const savedJob = JSON.parse(progress.value);
    if (savedJob.status === "running" || savedJob.status === "pausing") savedJob.status = "paused";
    plan = savedPlan;
    job = savedJob;
  }

  function status() {
    load();
    if (!job) return { status: "idle" };
    const group = plan[job.groupIndex];
    const done = Object.values(job.counts).reduce((total, count) => total + count, 0);
    return {
      status: job.status, total: job.total, done, remaining: job.total - done, counts: { ...job.counts },
      collectionCount: plan.length, finishedCollections: job.groupIndex,
      collection: group ? { title: group.title, index: job.groupIndex + 1, done: job.offset, total: group.albums.length } : null,
      error: job.error || ""
    };
  }

  function save(db, key, value) {
    db.prepare("INSERT OR REPLACE INTO photo_cover_warm_job(key,value) VALUES(?,?)").run(key, JSON.stringify(value));
  }

  async function processCover(id, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await warmCover(id, signal);
      } catch (error) {
        if (signal.aborted) return null;
        const retry = error.errcode === 5 || ["ARCHIVE_READER_BUSY", "ARCHIVE_READER_STOPPED"].includes(error.code);
        if (retry && attempt < 2) {
          await setTimeout(250 * (attempt + 1), undefined, { signal }).catch(() => {});
          if (signal.aborted || job.status !== "running") return null;
          continue;
        }
        return error.statusCode === 404 ? "missing" : "failed";
      }
    }
  }

  async function run(signal) {
    let nextCheckpoint = Date.now() + checkpointIntervalMs;
    while (!signal.aborted && job.status === "running" && job.groupIndex < plan.length) {
      const group = plan[job.groupIndex];
      const batch = group.albums.slice(job.offset, job.offset + batchSize);
      const outcomes = await Promise.all(batch.map(id => processCover(id, signal)));
      if (signal.aborted || outcomes.includes(null)) break;
      for (const outcome of outcomes) job.counts[outcome]++;
      job.offset += batch.length;
      if (job.offset === group.albums.length) {
        job.groupIndex++;
        job.offset = 0;
      }
      if (Date.now() >= nextCheckpoint) {
        save(getDb(), "progress", job);
        nextCheckpoint = Date.now() + checkpointIntervalMs;
      }
      // A long run of cache hits still lets pause requests reach the server.
      await setImmediate();
    }
    job.status = job.groupIndex === plan.length ? "complete" : "paused";
    save(getDb(), "progress", job);
  }

  function launch() {
    controller = new AbortController();
    runner = run(controller.signal).catch(error => {
      warn("[photo-cover-warm]", error);
      job.status = "paused";
      job.error = "预热中断，可以继续重试。";
    }).finally(() => { runner = controller = null; });
  }

  function change(action) {
    load();
    if (closing) throw Object.assign(new Error("服务正在停止"), { statusCode: 503 });
    if (action === "pause" && job?.status === "running") {
      job.status = "pausing";
      save(getDb(), "progress", job);
    } else if (action === "resume" && job?.status === "paused") {
      const next = { ...job, status: "running", error: "" };
      save(getDb(), "progress", next);
      job = next;
      launch();
    } else if (action === "start" && (!job || job.status === "complete")) {
      const nextPlan = buildPlan();
      if (!nextPlan) throw Object.assign(new Error("请先刷新图库索引"), { statusCode: 409 });
      const total = nextPlan.reduce((count, group) => count + group.albums.length, 0);
      const next = { status: total ? "running" : "complete", total, groupIndex: 0, offset: 0, counts: { ...emptyCounts } };
      const db = getDb();
      db.exec("BEGIN IMMEDIATE");
      try {
        save(db, "plan", nextPlan);
        save(db, "progress", next);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      plan = nextPlan;
      job = next;
      if (total) launch();
    }
    return status();
  }

  function beginStop() {
    closing = true;
    controller?.abort();
  }

  return { status, change, start: () => { closing = false; }, beginStop, stop: () => runner };
}
