import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacy = process.argv.includes("--legacy");
const LEGACY_REVISION = "1f6ddf213f0fbab4d417fdf61636b957d1909338";
const relative = "public/modules/music/music-progress-writer.js";
const webSource = fs.readFileSync(path.join(root, relative), "utf8");
const androidSource = fs.readFileSync(path.join(root, "android-client/www/modules/music/music-progress-writer.js"), "utf8");
if (!legacy) assert.equal(webSource, androidSource, "Web and Android share the exact scheduler contract");
const previous = legacy ? spawnSync("git", ["show", LEGACY_REVISION + ":" + relative], { cwd: root, encoding: "utf8" }) : null;
if (legacy) {
  assert.equal(previous.status, 0, previous.stderr);
  assert.match(previous.stdout, /tracks = new Map/);
  assert.doesNotMatch(previous.stdout, /maxConcurrent/);
}
const loadSource = source => import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const web = legacy ? await loadSource(previous.stdout) : await import("../public/modules/music/music-progress-writer.js");
const android = legacy ? web : await import("../android-client/www/modules/music/music-progress-writer.js");
const platforms = legacy ? [["legacy " + LEGACY_REVISION.slice(0, 7), web.createMusicProgressWriter]] : [
  ["Web", web.createMusicProgressWriter], ["Android", android.createMusicProgressWriter]
];
const STARTED = 1800000000000;
const UUID = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const tick = () => new Promise(resolve => setImmediate(resolve));
const busy = () => Object.assign(new Error("write rolled back: busy"), { status: 503, code: "MUSIC_WRITE_BUSY", retryable: true });
const record = (sequence, options = {}) => ({
  activeUrl: "http://fixture-a", trackId: "track-1", positionMs: sequence, durationMs: 20000,
  progressSessionId: UUID(1), progressSessionStartedAt: STARTED, progressSequence: sequence, ...options
});
const played = (n, options = {}) => record(n, {
  reportKey: "play-" + n, session: n, playedReportId: UUID(1000 + n), playedReportStartedAt: STARTED, ...options
});

// Actual source with controlled Promise transports and timers. This fixture does
// not start a server/browser, use a real account, SQLite, media, or credentials.
function fixture(createWriter, options = {}) {
  let nextTimer = 0, now = 0, active = 0, peak = 0;
  const timers = new Map(), normal = [], keepalive = [], errors = [], successful = [];
  const writer = createWriter({
    setTimeoutFn(callback, delayMs) {
      const id = ++nextTimer;
      timers.set(id, { callback, delayMs, due: now + delayMs });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    send(value, isPlayed) {
      active += 1; peak = Math.max(peak, active);
      return new Promise((resolve, reject) => normal.push({
        record: value, played: isPlayed,
        resolve(data = { progressApplied: true, playedApplied: Boolean(isPlayed) }) { active -= 1; resolve(data); },
        reject(error) { active -= 1; reject(error); }
      }));
    },
    sendKeepalive(value, isPlayed) {
      return new Promise((resolve, reject) => keepalive.push({ record: value, played: isPlayed, resolve, reject }));
    },
    onError(error, value) { errors.push({ error, record: value }); },
    onPlayed(value) { successful.push(value); },
    ...options
  });
  async function runNext(expectedDelay) {
    const entry = [...timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
    assert(entry, "expected a scheduled dispatch");
    const [id, timer] = entry;
    if (expectedDelay !== undefined) assert.equal(timer.delayMs, expectedDelay);
    timers.delete(id); now = timer.due; timer.callback(); await tick();
  }
  async function runTimers(limit = 1000) {
    let count = 0;
    while (timers.size) { assert(count++ < limit, "scheduler must not spin"); await runNext(); }
  }
  return { writer, timers, normal, keepalive, errors, successful, runNext, runTimers, peak: () => peak };
}
async function acknowledge(f, index) { f.normal[index].resolve(); await tick(); }
async function acceptLeave(f, index) {
  const entry = f.keepalive[index];
  entry.resolve({ progressApplied: true, playedApplied: Boolean(entry.played) }); await tick();
}
async function drainAll(f, limit = 1000) {
  for (let index = 0; ; index++) {
    await f.runTimers();
    if (!f.normal[index]) break;
    assert(index < limit);
    await acknowledge(f, index);
  }
}

for (const [name, createWriter] of platforms) {
  test(name + ": 200 distinct keys admit 64 and never exceed four normal transports", async () => {
    const f = fixture(createWriter);
    const admitted = [];
    for (let n = 0; n < 200; n++) admitted.push(f.writer.save(record(n + 1, { trackId: "track-" + n }), { immediate: true }));
    await f.runTimers();
    assert.equal(f.peak(), 4, "legacy source starts 200 simultaneous writes here");
    assert.equal(f.normal.length, 4);
    assert.equal(admitted.filter(Boolean).length, 64);
    assert.equal(f.errors.length, 136);
    assert(f.errors.every(entry => entry.error.code === "MUSIC_PROGRESS_QUEUE_FULL"));
    assert.equal(f.writer.diagnostics().pendingKeys, 64);
    assert.equal(f.writer.diagnostics().ready, 60);
    for (let index = 0; index < 64; index++) await acknowledge(f, index);
    assert.equal(f.normal.length, 64);
    assert.equal(f.peak(), 4);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.writer.save(record(201, { trackId: "previously-rejected" }), { immediate: true }), true);
    await f.runTimers(); await acknowledge(f, 64);
  });

  // The pinned pre-change negative control ends at actual unbounded concurrency
  // evidence, rather than failing subsequent tests on newly added methods.
  if (legacy) continue;

  test(name + ": 10,000 same-key captures keep one active and one latest cursor", async () => {
    const f = fixture(createWriter);
    assert.equal(f.writer.save(record(1), { immediate: true }), true);
    await f.runTimers();
    for (let n = 2; n <= 10000; n++) assert.equal(f.writer.save(record(n), { immediate: true }), true);
    assert.equal(f.normal.length, 1);
    assert.equal(f.writer.diagnostics().pendingKeys, 1);
    assert.equal(f.writer.diagnostics().timers, 0);
    await acknowledge(f, 0); await f.runTimers();
    assert.equal(f.normal.length, 2);
    assert.equal(f.normal[1].record.progressSequence, 10000);
    assert.equal(f.normal[1].record.positionMs, 10000);
    await acknowledge(f, 1);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
  });

  test(name + ": snapshots retain only frozen scalars, account ownership and caller-issued sequences", async () => {
    const f = fixture(createWriter);
    const original = record(5, {
      webAccountOwner: "web-a", webAccountRevision: 7,
      accountOrigin: "http://fixture-a", accountOwner: "android-a", accountRevision: 8, accountTokenKnown: true,
      extraLibrary: { rows: Array(1000).fill("not retained") }
    });
    f.writer.save(original, { immediate: true });
    original.trackId = "mutated"; original.positionMs = 999; original.webAccountOwner = "web-b";
    await f.runTimers();
    const sent = f.normal[0].record;
    assert.notEqual(sent, original); assert(Object.isFrozen(sent));
    assert.equal(sent.trackId, "track-1"); assert.equal(sent.positionMs, 5); assert.equal(sent.progressSequence, 5);
    assert.equal(sent.webAccountOwner, "web-a"); assert.equal(sent.webAccountRevision, 7);
    assert.equal(sent.accountOrigin, "http://fixture-a"); assert.equal(sent.accountOwner, "android-a");
    assert.equal(sent.accountRevision, 8); assert.equal(sent.accountTokenKnown, true);
    assert.equal(sent.extraLibrary, undefined);
    for (const invalid of [
      record(1, { trackId: "汉".repeat(171) }),
      record(1, { activeUrl: "x".repeat(4097) }),
      played(1, { reportKey: "x".repeat(513) }),
      record(1, { progressSessionId: { cannotRetain: true } })
    ]) assert.equal(f.writer.save(invalid), false);
    assert.equal(f.errors.length, 4);
    assert(f.errors.every(entry => entry.error.code === "MUSIC_PROGRESS_RECORD_INVALID"));
    await acknowledge(f, 0);
  });

  test(name + ": origin and track tuple avoids legacy server and delimiter collisions", async () => {
    const f = fixture(createWriter);
    for (const value of [
      record(1, { activeUrl: "http://A", trackId: "same" }),
      record(2, { activeUrl: "http://B", trackId: "same" }),
      record(3, { activeUrl: "http://A|same", trackId: "other" }),
      record(4, { activeUrl: "http://A", trackId: "same|other" })
    ]) f.writer.reportPlayed({ ...value, reportKey: "same-report", session: 1 });
    await f.runTimers();
    assert.equal(f.normal.length, 4);
    assert.deepEqual(f.normal.map(entry => [entry.record.activeUrl, entry.record.trackId, entry.record.positionMs]), [
      ["http://A", "same", 1], ["http://B", "same", 2], ["http://A|same", "other", 3], ["http://A", "same|other", 4]
    ]);
    for (let n = 0; n < 4; n++) await acknowledge(f, n);
    assert.equal(f.successful.length, 4);
  });

  test(name + ": 128 played tokens include active; rejected tokens may be retried after capacity frees", async () => {
    const f = fixture(createWriter);
    assert.equal(f.writer.reportPlayed(played(1)), true); await f.runTimers();
    for (let n = 2; n <= 128; n++) assert.equal(f.writer.reportPlayed(played(n)), true);
    assert.equal(f.writer.reportPlayed(played(129)), false);
    assert.equal(f.writer.diagnostics().playedTokens, 128);
    assert.equal(f.normal.length, 1);
    assert.equal(f.errors[0].error.code, "MUSIC_PLAYED_QUEUE_FULL");
    await acknowledge(f, 0);
    assert.equal(f.writer.reportPlayed(played(129)), true, "over-capacity does not remember an attempt");
    await f.runTimers();
    for (let index = 1; index < 129; index++) { await acknowledge(f, index); await f.runTimers(); }
    assert.deepEqual(f.normal.map(entry => entry.record.reportKey), Array.from({ length: 129 }, (_, n) => "play-" + (n + 1)));
    for (let n = 1; n <= 129; n++) {
      assert.equal(f.normal[n - 1].record.playedReportId, UUID(1000 + n));
      assert.equal(f.normal[n - 1].record.playedReportStartedAt, STARTED);
      assert.equal(f.normal[n - 1].record.session, n);
    }
    assert.equal(f.successful.length, 129);
    assert.equal(f.writer.diagnostics().playedTokens, 0);
    assert(f.writer.diagnostics().rememberedPlayed <= 128);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
  });

  test(name + ": busy rollback retries fairly and merges only same-key latest cursor into stable played tokens", async () => {
    const f = fixture(createWriter, { maxConcurrent: 1 });
    const first = played(1, { webAccountOwner: "old-owner", webAccountRevision: 1 });
    f.writer.reportPlayed(first); await f.runNext(0);
    f.normal[0].reject(busy()); await tick();
    assert.equal(f.timers.size, 1);
    f.writer.save(record(30, { webAccountOwner: "new-owner", webAccountRevision: 2 }), { delayMs: 800 });
    f.writer.save(record(90, { trackId: "other" }), { immediate: true });
    await f.runNext(0);
    assert.equal(f.normal[1].record.trackId, "other", "one busy key cannot block other keys");
    await acknowledge(f, 1);
    await f.runNext(800);
    assert.equal(f.normal[2].played, false); assert.equal(f.normal[2].record.progressSequence, 30);
    await acknowledge(f, 2); await f.runNext(0);
    const retry = f.normal[3].record;
    assert.equal(retry.positionMs, 30); assert.equal(retry.progressSequence, 30);
    assert.equal(retry.reportKey, first.reportKey); assert.equal(retry.session, first.session);
    assert.equal(retry.playedReportId, first.playedReportId);
    assert.equal(retry.playedReportStartedAt, first.playedReportStartedAt);
    assert.equal(retry.webAccountOwner, "old-owner"); assert.equal(retry.webAccountRevision, 1);
    await acknowledge(f, 3);
    assert.equal(f.errors.length, 0); assert.equal(f.timers.size, 0);
  });

  test(name + ": unknown commit and non-busy capacity errors never cause automatic normal replay", async () => {
    const f = fixture(createWriter);
    const value = played(1);
    f.writer.reportPlayed(value); await f.runTimers();
    f.normal[0].reject(new Error("reply lost after possible commit")); await tick();
    assert.equal(f.writer.reportPlayed(value), false);
    assert.equal(f.normal.length, 1); assert.equal(f.timers.size, 0);
    assert.equal(f.successful.length, 0); assert.equal(f.errors.length, 1);
    f.writer.reportPlayed(played(2)); await f.runTimers();
    f.normal[1].reject(Object.assign(new Error("receipt capacity"), { status: 503, code: "MUSIC_PROGRESS_CAPACITY", retryable: true }));
    await tick();
    assert.equal(f.normal.length, 2); assert.equal(f.timers.size, 0);
    assert.equal(f.writer.diagnostics().playedTokens, 0);
  });

  test(name + ": synchronous transport errors and throwing callbacks cannot strand global slots", async () => {
    let calls = 0, successful = 0;
    const f = fixture(createWriter, {
      send() { if (++calls === 1) throw new Error("sync send"); return undefined; },
      onError() { throw new Error("error banner failed"); },
      onPlayed() { successful++; throw new Error("render failed"); }
    });
    for (let n = 1; n <= 8; n++) f.writer.reportPlayed(played(n, { trackId: "track-" + n }));
    await f.runTimers();
    assert.equal(calls, 8); assert.equal(successful, 7);
    assert.equal(f.writer.diagnostics().active, 0);
    assert.equal(f.writer.diagnostics().playedTokens, 0);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
    assert.equal(f.timers.size, 0);
  });

  test(name + ": stale same-session captures cannot rewind the latest sequence; rereading may lower position", async () => {
    const f = fixture(createWriter);
    f.writer.save(record(100, { positionMs: 9000 }), { immediate: true });
    f.writer.save(record(99, { positionMs: 1000 }), { immediate: true });
    await f.runTimers();
    assert.equal(f.normal[0].record.progressSequence, 100); assert.equal(f.normal[0].record.positionMs, 9000);
    f.writer.save(record(101, { positionMs: 1000 }), { immediate: true });
    await acknowledge(f, 0); await f.runTimers();
    assert.equal(f.normal[1].record.progressSequence, 101); assert.equal(f.normal[1].record.positionMs, 1000);
    await acknowledge(f, 1);
  });

  test(name + ": leave starts current progress first, stable played next, other keys last without waiting for normal", async () => {
    const f = fixture(createWriter);
    const first = played(1);
    f.writer.reportPlayed(first); await f.runTimers();
    f.writer.save(record(90), { immediate: true });
    f.writer.save(record(50, { trackId: "other" }), { immediate: true });
    assert.equal(f.writer.flushKeepalive(record(99)), true);
    assert.deepEqual(f.keepalive.map(entry => [entry.record.trackId, entry.played, entry.record.progressSequence]), [
      ["track-1", false, 99], ["track-1", true, 99], ["other", false, 50]
    ]);
    assert.equal(f.keepalive[1].record.playedReportId, first.playedReportId);
    assert.equal(f.keepalive[1].record.playedReportStartedAt, first.playedReportStartedAt);
    assert.equal(f.keepalive[1].record.session, 1);
    assert.equal(f.successful.length, 0, "synchronous admission is not confirmation");
    assert.equal(f.timers.size, 0); assert.equal(f.writer.diagnostics().paused, true);
    f.writer.flushKeepalive(record(99));
    assert.equal(f.keepalive.length, 3, "duplicate pagehide/beforeunload shares one captured cursor and token");
    await acceptLeave(f, 1);
    assert.equal(f.successful.length, 1);
    assert.equal(f.writer.diagnostics().playedTokens, 1, "normal active token still occupies capacity until it settles");
    await acknowledge(f, 0);
    assert.equal(f.successful.length, 1, "normal and leave receipt callback is confirmed once");
    assert.equal(f.writer.diagnostics().playedTokens, 0);
    assert.equal(f.normal.length, 1, "normal draining stays paused after its active request finishes");
    await acceptLeave(f, 0); await acceptLeave(f, 2);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
    assert.equal(f.writer.diagnostics().keepaliveBytes, 0);
    f.writer.resume(); await f.runTimers();
    assert.equal(f.normal.length, 1);
  });

  test(name + ": legacy played queue is not duplicated by leave; no keepalive transport preserves old API", async () => {
    const f = fixture(createWriter);
    f.writer.reportPlayed(played(1, { playedReportId: undefined, playedReportStartedAt: undefined }));
    await f.runTimers();
    f.writer.reportPlayed(played(2, { playedReportId: undefined, playedReportStartedAt: undefined }));
    f.writer.flushKeepalive(record(90));
    assert.equal(f.keepalive.length, 1); assert.equal(f.keepalive[0].played, false);
    await acceptLeave(f, 0); await acknowledge(f, 0);
    assert.equal(f.normal.length, 1);
    f.writer.resume(); await f.runTimers();
    assert.equal(f.normal.length, 2); assert.equal(f.normal[1].played, true);
    assert.equal(f.normal[1].record.reportKey, "play-2"); await acknowledge(f, 1);
    const noLeave = fixture(createWriter, { sendKeepalive: undefined });
    noLeave.writer.save(record(1), { immediate: true });
    assert.equal(noLeave.writer.flushKeepalive(record(99)), false);
    assert.equal(noLeave.writer.diagnostics().paused, false);
    await noLeave.runTimers(); assert.equal(noLeave.normal[0].record.progressSequence, 1);
    await acknowledge(noLeave, 0);
  });

  test(name + ": 48 KiB outstanding leave budget rejects explicitly and retains unsubmitted work for resume", async () => {
    const f = fixture(createWriter);
    const longUrl = "http://fixture/" + "x".repeat(3500);
    for (let n = 1; n <= 20; n++) f.writer.save(record(n, { activeUrl: longUrl, trackId: "track-" + n }), { immediate: true });
    const current = record(21, { activeUrl: longUrl, trackId: "track-20" });
    assert.equal(f.writer.flushKeepalive(current), false);
    assert.equal(f.keepalive[0].record.trackId, "track-20");
    assert(f.keepalive.length > 1 && f.keepalive.length < 20);
    assert(f.writer.diagnostics().keepaliveBytes <= 48 * 1024);
    assert(f.errors.some(entry => entry.error.code === "MUSIC_PROGRESS_KEEPALIVE_FULL"));
    assert.equal(f.writer.diagnostics().pendingKeys, 20);
    assert.equal(f.writer.diagnostics().pendingProgress, 20, "admission alone cannot discard normal work");
    const delivered = f.keepalive.length;
    for (let n = 0; n < delivered; n++) await acceptLeave(f, n);
    assert.equal(f.writer.diagnostics().keepaliveBytes, 0);
    assert.equal(f.writer.diagnostics().pendingKeys, 20 - delivered);
    f.writer.resume(); await drainAll(f);
    assert.equal(f.normal.length, 20 - delivered);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
  });

  test(name + ": unconfirmed or failed keepalive retains latest cursor and every token for pageshow", async () => {
    const f = fixture(createWriter, { sendKeepalive: () => true });
    f.writer.reportPlayed(played(1));
    assert.equal(f.writer.flushKeepalive(record(90)), true);
    await tick();
    assert.equal(f.successful.length, 0);
    assert.equal(f.writer.diagnostics().playedTokens, 1);
    assert.equal(f.writer.diagnostics().pendingProgress, 1);
    assert(f.errors.every(entry => entry.error.code === "MUSIC_PROGRESS_KEEPALIVE_UNCONFIRMED"));
    f.writer.resume(); await f.runTimers();
    assert.equal(f.normal[0].played, true); assert.equal(f.normal[0].record.progressSequence, 90);
    await acknowledge(f, 0); await f.runTimers();
    assert.equal(f.normal[1].played, false); assert.equal(f.normal[1].record.progressSequence, 90);
    await acknowledge(f, 1);
    const failed = fixture(createWriter);
    failed.writer.save(record(1)); failed.writer.flushKeepalive(record(2));
    failed.keepalive[0].reject(new Error("unload network failure")); await tick();
    assert.equal(failed.writer.diagnostics().pendingProgress, 1);
    failed.writer.resume(); await failed.runTimers();
    assert.equal(failed.normal[0].record.progressSequence, 2);
    await acknowledge(failed, 0);
  });

  test(name + ": resume before leave replies keeps newer normal ownership and does not re-label the played receipt", async () => {
    const f = fixture(createWriter);
    const token = played(1, { progressSessionId: UUID(20) });
    f.writer.reportPlayed(token); await f.runTimers();
    f.writer.save(record(50, { progressSessionId: UUID(21) }), { immediate: true });
    f.writer.flushKeepalive(record(90, { progressSessionId: UUID(21) }));
    const leaveProgress = f.keepalive[0], leavePlayed = f.keepalive[1];
    assert.equal(leavePlayed.record.progressSessionId, UUID(21));
    assert.equal(leavePlayed.record.playedReportId, token.playedReportId);
    f.writer.resume();
    f.writer.save(record(91, { progressSessionId: UUID(21) }), { immediate: true });
    await acknowledge(f, 0); await f.runTimers();
    assert.equal(f.normal[1].record.progressSequence, 91);
    leaveProgress.resolve({ progressApplied: true }); await tick();
    assert.equal(f.writer.diagnostics().pendingProgress, 1, "old leave finally cannot clear the new normal version");
    leavePlayed.resolve({ progressApplied: false, playedApplied: false }); await tick();
    assert.equal(f.successful.length, 1, "an existing UUID receipt confirms delivery even when both applied flags are false");
    await acknowledge(f, 1);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
    assert.equal(f.writer.diagnostics().active, 0);
  });

  test(name + ": old leave errors cannot clear a newer leave owner or duplicate the latest UUID", async () => {
    const f = fixture(createWriter);
    f.writer.reportPlayed(played(1)); await f.runTimers();
    f.writer.flushKeepalive(record(90));
    f.writer.resume();
    f.writer.flushKeepalive(record(91));
    assert.equal(f.keepalive.length, 4);
    f.keepalive[0].reject(new Error("old progress leave failed"));
    f.keepalive[1].reject(new Error("old played leave failed")); await tick();
    f.writer.flushKeepalive(record(91));
    assert.equal(f.keepalive.length, 4, "late failure must not reset the newer leave marker");
    await acceptLeave(f, 2); await acceptLeave(f, 3);
    f.normal[0].reject(busy()); await tick();
    assert.equal(f.writer.diagnostics().playedTokens, 0);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
    assert.equal(f.writer.diagnostics().keepaliveBytes, 0);
    f.writer.resume(); await f.runTimers();
    assert.equal(f.normal.length, 1, "confirmed keepalive receipt must not be replayed after normal rollback");
  });

  test(name + ": leave transport and view exceptions preserve pending work and release outstanding bytes", async () => {
    let confirmed = 0;
    const f = fixture(createWriter, {
      sendKeepalive() { throw new Error("synchronous leave failure"); },
      onError() { throw new Error("banner failed"); },
      onPlayed() { confirmed++; throw new Error("view failed"); }
    });
    f.writer.reportPlayed(played(1));
    f.writer.flushKeepalive(record(20)); await tick();
    assert.equal(f.writer.diagnostics().keepaliveBytes, 0);
    assert.equal(f.writer.diagnostics().keepaliveActive, 0);
    assert.equal(f.writer.diagnostics().playedTokens, 1);
    f.writer.resume(); await f.runTimers(); await acknowledge(f, 0); await f.runTimers();
    await acknowledge(f, 1);
    assert.equal(confirmed, 1);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
    assert.equal(f.writer.diagnostics().playedTokens, 0);
  });

  test(name + ": full 64-key normal queue still sends current key 65 first through one emergency snapshot", async () => {
    const f = fixture(createWriter);
    for (let n = 1; n <= 64; n++) f.writer.save(record(n, { trackId: "track-" + n }), { immediate: true });
    const current = record(999, { trackId: "current-65" });
    assert.equal(f.writer.flushKeepalive(current), false, "normal queue admission remains explicit backpressure");
    assert.equal(f.keepalive[0].record.trackId, "current-65");
    assert.equal(f.keepalive[0].record.positionMs, 999);
    assert.equal(f.writer.diagnostics().pendingKeys, 64);
    assert.equal(f.writer.diagnostics().emergencyPending, true);
    assert.equal(f.writer.save(record(1, { trackId: "ordinary-66" })), false);
    assert(f.errors.some(entry => entry.error.code === "MUSIC_PROGRESS_QUEUE_FULL"));
    await acceptLeave(f, 0);
    assert.equal(f.writer.diagnostics().emergencyPending, false);
    assert.equal(f.writer.diagnostics().pendingKeys, 64);
    for (let n = 1; n < f.keepalive.length; n++) await acceptLeave(f, n);
    f.writer.resume(); await f.runTimers();
    assert.equal(f.normal.length, 0, "confirmed emergency leave needs no normal replay");
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
  });

  test(name + ": failed current key 65 promotes on pageshow once a normal slot is released", async () => {
    const f = fixture(createWriter);
    for (let n = 1; n <= 64; n++) f.writer.save(record(n, { trackId: "track-" + n }), { immediate: true });
    await f.runTimers();
    f.writer.flushKeepalive(record(999, { trackId: "current-65" }));
    f.keepalive[0].reject(new Error("emergency leave failed")); await tick();
    f.writer.resume();
    assert.equal(f.writer.diagnostics().pendingKeys, 64);
    assert.equal(f.writer.diagnostics().emergencyPending, true);
    await acknowledge(f, 0);
    assert.equal(f.writer.diagnostics().emergencyPending, true, "the active leave Promise still owns the occupied key");
    await acceptLeave(f, 1);
    assert.equal(f.writer.diagnostics().pendingKeys, 64, "promotion takes the released slot without expanding normal capacity");
    assert.equal(f.writer.diagnostics().emergencyPending, false);
    for (let n = 2; n < f.keepalive.length; n++) await acceptLeave(f, n);
    await f.runTimers();
    for (let n = 1; n < f.normal.length; n++) await acknowledge(f, n);
    await f.runTimers();
    const emergency = f.normal.find(entry => entry.record.trackId === "current-65");
    assert(emergency); assert.equal(emergency.record.progressSequence, 999);
    assert.equal(f.peak(), 4);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
  });

  test(name + ": repeated full-queue current changes retain one snapshot; old leave cleanup cannot delete a later normal owner", async () => {
    const f = fixture(createWriter);
    for (let n = 1; n <= 64; n++) f.writer.save(record(n, { trackId: "track-" + n }));
    f.writer.flushKeepalive(record(10, { trackId: "emergency-A" }));
    const old = f.keepalive[0];
    f.writer.flushKeepalive(record(20, { trackId: "emergency-B" }));
    assert.equal(f.writer.diagnostics().emergencyPending, true);
    assert.equal(f.writer.diagnostics().emergencyKey, JSON.stringify(["http://fixture-a", "emergency-B"]));
    f.writer.flushKeepalive(record(30, { trackId: "emergency-A" }));
    const current = f.keepalive.at(-1);
    assert.equal(current.record.trackId, "emergency-A");
    assert.equal(current.record.progressSequence, 30);
    for (const entry of f.keepalive.slice(1, 65)) entry.resolve({ progressApplied: true });
    await tick();
    f.writer.resume(); await f.runTimers();
    assert.equal(f.writer.diagnostics().emergencyPending, false);
    assert.equal(f.normal[0].record.progressSequence, 30);
    old.reject(new Error("old emergency reply lost")); await tick();
    assert.equal(f.writer.diagnostics().pendingKeys, 1, "old state cannot delete the promoted current state with the same key");
    current.reject(new Error("new leave failed")); await tick();
    for (const entry of f.keepalive) {
      if (entry !== old && entry !== current) entry.resolve({ progressApplied: true });
    }
    await tick();
    assert.equal(f.writer.diagnostics().pendingKeys, 1);
    await acknowledge(f, 0);
    assert.equal(f.writer.diagnostics().pendingKeys, 0);
    assert.equal(f.writer.diagnostics().keepaliveBytes, 0);
  });
}
