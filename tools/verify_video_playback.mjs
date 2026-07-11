import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRange } from "../src/platform/server/file-server.js";
import { createVideoProbeService } from "../src/platform/server/video-probe-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=900-2000", 1000), { start: 900, end: 999 });
assert.equal(parseRange("bytes=1000-", 1000), null);
assert.equal(parseRange("bytes=-0", 1000), null);

assertPlaybackMode({ ext: ".mp4", videoCodec: "h264", audioCodec: "aac", expected: "direct" });
assertPlaybackMode({ ext: ".mp4", videoCodec: "hevc", audioCodec: "aac", expected: "transcode" });
assertPlaybackMode({ ext: ".mp4", videoCodec: "h264", audioCodec: "ac3", expected: "remux" });
assertPlaybackMode({ ext: ".mkv", videoCodec: "h264", audioCodec: "aac", expected: "remux" });
assertPlaybackMode({ ext: ".mkv", videoCodec: "hevc", audioCodec: "aac", expected: "transcode" });
assertPlaybackMode({ ext: ".wmv", videoCodec: "vc1", audioCodec: "wmapro", expected: "transcode" });

const serverConfigSource = fs.readFileSync(path.join(root, "src", "bootstrap", "server-config.js"), "utf8");
const routeSource = fs.readFileSync(path.join(root, "src", "modules", "fanhao", "server", "works", "routes-media.js"), "utf8");
const streamSource = fs.readFileSync(path.join(root, "src", "platform", "server", "media-stream-service.js"), "utf8");
const playerSource = fs.readFileSync(path.join(root, "public", "js", "player-page.js"), "utf8");

assert(serverConfigSource.includes("DEFAULT_VIDEO_CHUNK_BYTES: 4 * 1024 * 1024"), "video initial ranges should avoid 1 MB request churn");
assert(routeSource.includes('cacheControl: "private, max-age=0, must-revalidate"'), "native video ranges should be reusable with validators");
assert(playerSource.includes('els.video.preload = mode === "direct" ? "auto" : "none";'), "native MP4 should preload while generated streams start on demand");
assert(playerSource.includes("if (customControls && autoPlay)"), "generated stream seeks should restart playback without waiting for metadata preload");
assert(playerSource.includes("const deferGeneratedStream = customControls && !autoPlay;"), "generated streams should not start FFmpeg during page load");
assert(!playerSource.includes('addEventListener("click", activateGeneratedStreamFromInteraction'), "the first generated-stream play gesture must remain native");
assert(playerSource.includes("function requestVideoPlayback()"), "play promise failures should stay retryable and visible");
assert(playerSource.includes('els.streamStart?.addEventListener("click", startDeferredStream);'), "generated streams need a dedicated trusted start control");
for (const option of ['"-fflags", "+genpts"', '"-avoid_negative_ts", "make_zero"', '"-pix_fmt", "yuv420p"']) {
  assert(streamSource.includes(option), `missing compatibility option: ${option}`);
}

console.log("video-playback: ok (range, native MP4, MKV remux, WMV/MKV transcode)");

function assertPlaybackMode({ ext, videoCodec, audioCodec, expected }) {
  const service = createVideoProbeService({
    directVideoExts: new Set([".mp4", ".m4v", ".webm"]),
    ffprobePath: "ffprobe",
    hasNvenc: true,
    safeStat: () => ({ size: 1, mtimeMs: 1 }),
    spawnSyncFn: () => ({
      status: 0,
      stdout: JSON.stringify({
        format: { duration: 60 },
        streams: [
          { codec_type: "video", codec_name: videoCodec, width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: audioCodec }
        ]
      })
    })
  });
  const info = service.playInfoForFile({ id: `${videoCodec}-${audioCodec}`, path: `sample${ext}`, ext });
  assert.equal(info.mode, expected, `${ext} ${videoCodec}/${audioCodec}`);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
}
