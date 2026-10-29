import assert from "node:assert/strict";
import { createShortVideoBufferedProgress } from "../public/modules/short-videos/buffered-progress.js";

// Real controller and controlled DOM/TimeRanges. No media, browser, service or
// database is involved; count reads/writes to verify the update budget as well.
function fixture(options = {}) {
  const operations = { created: 0, appended: 0, removed: 0, styleWrites: 0, reads: 0 };
  const container = {
    children: [],
    ownerDocument: {
      createElement(tag) {
        assert.equal(tag, "span"); operations.created += 1;
        const values = { left: "", width: "" };
        const node = { parent: null, style: new Proxy(values, { set(target, key, value) { operations.styleWrites += 1; target[key] = value; return true; } }),
          remove() {
            if (!this.parent) return;
            operations.removed += 1;
            this.parent.children = this.parent.children.filter((child) => child !== this);
            this.parent = null;
          }
        };
        return node;
      }
    },
    append(node) { operations.appended += 1; node.parent = this; this.children.push(node); }
  };
  let clock = 0, ranges = [], activePlayer;
  const player = {
    duration: 100, dataset: { videoId: "A", shortVideoSourceGeneration: "1" },
    getAttribute: () => "/fixture/A", currentSrc: "/fixture/A",
    get buffered() {
      operations.reads += 1;
      return { length: ranges.length, start: (index) => ranges[index][0], end: (index) => ranges[index][1] };
    }
  };
  activePlayer = player;
  const progress = createShortVideoBufferedProgress({ container, getPlayer: () => activePlayer, now: () => clock, ...options });
  const values = () => container.children.map((node) => ({ left: node.style.left, width: node.style.width }));
  return { progress, player, container, operations, values,
    setRanges: (value) => { ranges = value; }, setPlayer: (value) => { activePlayer = value; }, setTime: (value) => { clock = value; } };
}

{
  const f = fixture(); f.setRanges([[30, 45], [0, 10], [8, 20], [20, 25], [50, 65]]);
  assert.equal(f.progress.sync(), true);
  assert.deepEqual(f.values(), [{ left: "0%", width: "25%" }, { left: "30%", width: "15%" }, { left: "50%", width: "15%" }]);
  assert(f.container.children.every((node) => node.className === "short-video-buffered-range"));
  const original = [...f.container.children], before = { ...f.operations };
  for (let time = 1; time < 250; time += 16) { f.setTime(time); assert.equal(f.progress.sync(), false); }
  assert.deepEqual(f.operations, before, "per-frame sync must neither read ranges nor rebuild DOM inside the update interval");
  f.setTime(250); assert.equal(f.progress.sync(), false);
  assert.equal(f.operations.reads, before.reads + 1);
  assert.equal(f.operations.styleWrites, before.styleWrites);
  assert.deepEqual(f.container.children, original, "unchanged intervals reuse the exact nodes");
  f.setRanges([[0, 30], [40, 60]]); f.progress.sync({ force: true });
  assert.equal(f.container.children[0], original[0]); assert.equal(f.container.children[1], original[1]);
  assert.equal(original[2].parent, null);
  assert.deepEqual(f.values(), [{ left: "0%", width: "30%" }, { left: "40%", width: "20%" }]); f.progress.dispose();
}

{
  const f = fixture();
  f.setRanges([[-5, 10], [90, 110], [15, 15], [30, 20], [NaN, 40], [50, Infinity], [-10, -1], [110, 120], [40, 45], [45.001, 50]]);
  f.progress.sync();
  assert.equal(f.container.children.length, 4, "invalid, reversed and empty intervals must be ignored without filling real gaps");
  assert.deepEqual(f.values().slice(0, 2), [{ left: "0%", width: "10%" }, { left: "40%", width: "5%" }]);
  assert.equal(f.values()[2].left, "45.001%");
  assert.equal(f.values()[3].left, "90%"); assert.equal(f.values()[3].width, "10%"); f.progress.dispose();
}

for (const change of [
  (f) => { f.player.getAttribute = () => "/fixture/replaced"; },
  (f) => { f.player.dataset.videoId = "B"; },
  (f) => { f.player.dataset.shortVideoSourceGeneration = "2"; },
  (f) => { f.player.duration = 200; },
  (f) => { f.setPlayer({ duration: 100, dataset: {}, getAttribute: () => "/fixture/B", buffered: { length: 0 } }); }
]) {
  const f = fixture(); f.setRanges([[0, 20]]); f.progress.sync();
  const old = f.container.children[0]; change(f); f.setRanges([]);
  f.setTime(1); f.progress.sync();
  assert.equal(old.parent, null, "player/source/id/generation/duration changes clear stale segments immediately despite throttling");
  assert.equal(f.container.children.length, 0); f.progress.dispose();
}

for (const duration of [0, -1, NaN, Infinity, undefined]) {
  const f = fixture(); f.setRanges([[0, 20]]); f.progress.sync();
  f.player.duration = duration; f.setTime(1); f.progress.sync();
  assert.equal(f.container.children.length, 0, "a missing or non-finite duration must never retain an old percentage"); f.progress.dispose();
}

{
  const f = fixture(); f.setRanges([[0, 20]]); f.progress.sync();
  Object.defineProperty(f.player, "buffered", { get() { throw new Error("media detached"); } });
  assert.doesNotThrow(() => f.progress.sync({ force: true }));
  assert.equal(f.container.children.length, 0); f.progress.dispose();
}
{
  const f = fixture();
  Object.defineProperty(f.player, "buffered", { get() { return { length: 3,
    start: (index) => { if (index === 1) throw new Error("range gone"); return [0, 0, 60][index]; }, end: (index) => [20, 40, 80][index] }; } });
  assert.doesNotThrow(() => f.progress.sync());
  assert.deepEqual(f.values(), [{ left: "0%", width: "20%" }, { left: "60%", width: "20%" }]); f.progress.dispose();
}
{
  const f = fixture(); f.setRanges([[0, 20]]); f.progress.sync();
  f.setPlayer(null); f.progress.sync(); assert.equal(f.container.children.length, 0);
  f.progress.dispose(); f.setPlayer(f.player); f.setRanges([[0, 100]]);
  assert.equal(f.progress.sync({ force: true }), false); assert.equal(f.container.children.length, 0);
  const before = { ...f.operations }; f.progress.dispose(); assert.deepEqual(f.operations, before, "disposal is idempotent and sync cannot resurrect released segments");
}

console.log("short-video-buffered-progress: real ranges, gaps, clipping, source ownership, read failures, throttling and disposal passed");
