import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { writeSubtitleBesideVideo, discoverVideoSubtitles } from "../src/modules/fanhao/server/playback/subtitle-sidecars.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temporary = createVerifiedTempDir("fanhao-subtitle-sidecars-");
const directory = fs.realpathSync.native(temporary.tempDir);
const media = path.join(directory, "media");
const other = path.join(directory, "outside");
fs.mkdirSync(media); fs.mkdirSync(other);
const roots = [media];
const content = Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n字幕测试\n");
const file = (name, parent = media) => {
  const filePath = path.join(parent, name);
  fs.writeFileSync(filePath, "fixture-video-must-remain-unchanged");
  return { id: name, name, path: filePath, type: "video", size: fs.statSync(filePath).size };
};
const video = file("ABC-001.CD2.mp4");
const originalVideo = fs.readFileSync(video.path);
let checks = 0;
const reject = async (promise, code, statusCode) => {
  await assert.rejects(promise, error => (!code || error.code === code) && (!statusCode || error.statusCode === statusCode));
  checks++;
};
const noTemporary = () => assert(!fs.readdirSync(media).some(name => name.startsWith(".fanhao-subtitle-")));
const options = extra => ({ roots, ...extra });

try {
  const written = await writeSubtitleBesideVideo({ ...video, name: "wrong-index-name.mp4" }, content, options());
  assert.deepEqual(written, { path: path.join(media, "ABC-001.CD2.zh-CN.srt"), name: "ABC-001.CD2.zh-CN.srt", created: true });
  assert(fs.readFileSync(written.path).equals(content));
  assert(fs.readFileSync(video.path).equals(originalVideo)); noTemporary(); checks++;
  assert.equal((await writeSubtitleBesideVideo(video, content, options())).created, false); checks++;
  await reject(writeSubtitleBesideVideo(video, Buffer.from("different"), options()), "SUBTITLE_SIDECAR_CONFLICT", 409);
  assert(fs.readFileSync(written.path).equals(content)); noTemporary(); checks++;

  const traditional = await writeSubtitleBesideVideo(video, new Uint8Array(content), options({ language: "ZH-tw", name: "../../provider.ass" }));
  assert.equal(traditional.name, "ABC-001.CD2.zh-TW.ass");
  assert.equal(path.dirname(traditional.path), media); checks++;
  assert.equal((await writeSubtitleBesideVideo(video, content, options({ language: "en", name: "provider.VTT" }))).name, "ABC-001.CD2.en.vtt"); checks++;
  await reject(writeSubtitleBesideVideo(video, content, options({ name: "name.txt" })), "SUBTITLE_FORMAT", 415);
  await reject(writeSubtitleBesideVideo(video, content, options({ language: "../../zh-CN" })), "SUBTITLE_LANGUAGE_INVALID", 400);
  await reject(writeSubtitleBesideVideo(video, "text", options()), "SUBTITLE_INVALID", 400);
  await reject(writeSubtitleBesideVideo(video, Buffer.alloc(0), options()), "SUBTITLE_NO_CUES", 422);
  await reject(writeSubtitleBesideVideo(video, Buffer.alloc(2097153), options()), "SUBTITLE_TOO_LARGE", 413);
  const capped = file("CAP-001.mp4");
  assert((await writeSubtitleBesideVideo(capped, Buffer.alloc(2097152, 97), options())).created); checks++;

  await reject(writeSubtitleBesideVideo(video, content, {}), "SUBTITLE_SIDECAR_UNSAFE", 400);
  await reject(writeSubtitleBesideVideo(video, content, { roots: ["media"] }), "SUBTITLE_SIDECAR_UNSAFE", 400);
  await reject(writeSubtitleBesideVideo({ ...video, path: "ABC-001.mp4" }, content, options()), "SUBTITLE_SIDECAR_UNSAFE", 400);
  await reject(writeSubtitleBesideVideo(file("ESC-001.mp4", other), content, options()), "SUBTITLE_SIDECAR_UNSAFE", 400);
  await reject(writeSubtitleBesideVideo({ ...video, size: video.size + 1 }, content, options()), "SUBTITLE_VIDEO_CHANGED", 409);
  await reject(writeSubtitleBesideVideo({ ...video, path: path.join(media, "missing.mp4") }, content, options()), "ENOENT");
  await reject(writeSubtitleBesideVideo({ ...video, path: media, size: undefined }, content, { roots: [directory] }), "SUBTITLE_VIDEO_CHANGED", 409);

  const cancelled = new AbortController(); cancelled.abort();
  await reject(writeSubtitleBesideVideo(video, content, options({ language: "ja", signal: cancelled.signal })), undefined);
  assert(!fs.existsSync(path.join(media, "ABC-001.CD2.ja.srt"))); checks++;
  await reject(discoverVideoSubtitles(video, options({ signal: cancelled.signal })), undefined);

  const abortDuringWrite = new AbortController();
  const open = fsp.open;
  try {
    fsp.open = async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])).startsWith(".fanhao-subtitle-")) abortDuringWrite.abort();
      return handle;
    };
    await reject(writeSubtitleBesideVideo(video, content, options({ language: "ja", signal: abortDuringWrite.signal })), undefined);
  } finally { fsp.open = open; }
  noTemporary(); assert(!fs.existsSync(path.join(media, "ABC-001.CD2.ja.srt"))); checks++;

  const changed = file("CHANGE-001.mp4");
  try {
    fsp.open = async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])).startsWith(".fanhao-subtitle-")) fs.appendFileSync(changed.path, "replacement");
      return handle;
    };
    await reject(writeSubtitleBesideVideo(changed, content, options()), "SUBTITLE_VIDEO_CHANGED", 409);
  } finally { fsp.open = open; }
  noTemporary(); assert(!fs.existsSync(path.join(media, "CHANGE-001.zh-CN.srt"))); checks++;

  const abortBeforePublish = new AbortController();
  const beforePublish = file("PUBLISH-001.mp4");
  try {
    fsp.open = async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])).startsWith(".fanhao-subtitle-")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); abortBeforePublish.abort(); };
      }
      return handle;
    };
    await reject(writeSubtitleBesideVideo(beforePublish, content, options({ signal: abortBeforePublish.signal })), undefined);
  } finally { fsp.open = open; }
  noTemporary(); assert(!fs.existsSync(path.join(media, "PUBLISH-001.zh-CN.srt"))); checks++;
  try {
    fsp.open = async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])).startsWith(".fanhao-subtitle-")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); fs.appendFileSync(beforePublish.path, "replacement"); };
      }
      return handle;
    };
    await reject(writeSubtitleBesideVideo(beforePublish, content, options()), "SUBTITLE_VIDEO_CHANGED", 409);
  } finally { fsp.open = open; }
  noTemporary(); assert(!fs.existsSync(path.join(media, "PUBLISH-001.zh-CN.srt"))); checks++;

  // Two simultaneous identical downloads can publish once, but never overwrite.
  const concurrent = file("RACE-001.mp4");
  const race = await Promise.all([writeSubtitleBesideVideo(concurrent, content, options()), writeSubtitleBesideVideo(concurrent, content, options())]);
  assert.equal(race.filter(result => result.created).length, 1); noTemporary(); checks++;
  const conflictVideo = file("RACE-002.mp4");
  const competing = await Promise.allSettled([writeSubtitleBesideVideo(conflictVideo, content, options()), writeSubtitleBesideVideo(conflictVideo, Buffer.from("other"), options())]);
  assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(competing.find(result => result.status === "rejected").reason.code, "SUBTITLE_SIDECAR_CONFLICT"); noTemporary(); checks++;

  const longVideo = file("X".repeat(246) + ".mp4");
  const long = await writeSubtitleBesideVideo(longVideo, content, options({ language: "zh-CN" }));
  assert(long.name.length <= 255); assert.match(long.name, /~[a-f0-9]{12}\.zh-CN\.srt$/);
  assert.equal((await discoverVideoSubtitles(longVideo, options()))[0].path, long.path); checks++;

  fs.writeFileSync(path.join(media, "ABC-001.CD2.ja.ssa"), content);
  fs.writeFileSync(path.join(media, "ABC-001.CD1.zh-CN.srt"), content);
  fs.writeFileSync(path.join(media, "ABC-001.CD2.fr.srt"), content);
  fs.writeFileSync(path.join(media, "ABC-001.CD2.und.vtt"), Buffer.alloc(2097153));
  fs.mkdirSync(path.join(media, "ABC-001.CD2.und.srt"));
  const nested = path.join(media, "nested"); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "ABC-001.CD2.und.ass"), content);
  const found = await discoverVideoSubtitles(video, options());
  assert.deepEqual(found.map(item => item.name), ["ABC-001.CD2.zh-CN.srt", "ABC-001.CD2.zh-TW.ass", "ABC-001.CD2.en.vtt", "ABC-001.CD2.ja.ssa"]);
  assert(found.every(item => /^sidecar:[a-f0-9]{64}$/.test(item.id) && item.type === "info"));
  assert.deepEqual(await discoverVideoSubtitles(video, options()), found); checks++;
  assert.deepEqual(await discoverVideoSubtitles(file("EMPTY-001.mp4"), options()), []); checks++;

  const junction = path.join(media, "escape");
  fs.symlinkSync(other, junction, process.platform === "win32" ? "junction" : "dir");
  try {
    const escapedVideo = { ...video, path: path.join(junction, "ESC-001.mp4") };
    await reject(writeSubtitleBesideVideo(escapedVideo, content, options()), "SUBTITLE_SIDECAR_UNSAFE", 409);
    await reject(discoverVideoSubtitles(escapedVideo, options()), "SUBTITLE_SIDECAR_UNSAFE", 409);
    await reject(writeSubtitleBesideVideo(escapedVideo, content, { roots: [junction] }), "SUBTITLE_SIDECAR_UNSAFE", 409);
    assert(!fs.existsSync(path.join(other, "ESC-001.zh-CN.srt"))); checks++;
  } finally { fs.unlinkSync(junction); }

  // An alias within the authorized real root may point to another directory
  // inside that same root. Keep both link and followed-target identities.
  const aliasTarget = path.join(media, "alias-target");
  const internalAlias = path.join(media, "internal-alias");
  const aliasNested = path.join(aliasTarget, "nested");
  fs.mkdirSync(aliasNested, { recursive: true });
  const physicalAliasVideo = file("ALIAS-001.mp4", aliasNested);
  const createAlias = targetPath => fs.symlinkSync(targetPath, internalAlias, process.platform === "win32" ? "junction" : "dir");
  createAlias(aliasTarget);
  try {
    const aliasVideo = { ...physicalAliasVideo, path: path.join(internalAlias, "nested", physicalAliasVideo.name) };
    const sidecar = await writeSubtitleBesideVideo(aliasVideo, content, options());
    assert.equal(sidecar.path, path.join(internalAlias, "nested", "ALIAS-001.zh-CN.srt"));
    assert(fs.readFileSync(path.join(aliasNested, sidecar.name)).equals(content));
    assert.equal((await writeSubtitleBesideVideo(aliasVideo, content, options())).created, false);
    assert.equal((await discoverVideoSubtitles(aliasVideo, options()))[0].path, sidecar.path); checks++;
    await reject(writeSubtitleBesideVideo(aliasVideo, content, { roots: [internalAlias] }), "SUBTITLE_SIDECAR_UNSAFE", 409);

    try {
      fsp.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === sidecar.path) {
          fs.unlinkSync(internalAlias);
          createAlias(other);
        }
        return handle;
      };
      await reject(writeSubtitleBesideVideo(aliasVideo, content, options()), "SUBTITLE_SIDECAR_UNSAFE", 409);
    } finally {
      fsp.open = open;
      fs.unlinkSync(internalAlias);
      createAlias(aliasTarget);
    }
    assert(!fs.existsSync(path.join(other, "nested", sidecar.name)));
    assert(fs.readFileSync(path.join(aliasNested, sidecar.name)).equals(content)); checks++;

    const statSync = fs.statSync;
    let changedTarget = false;
    try {
      fs.statSync = (value, ...args) => {
        const stat = statSync(value, ...args);
        if (changedTarget && String(value) === internalAlias) {
          return { ...stat, ino: stat.ino + 1n, isDirectory: () => stat.isDirectory() };
        }
        return stat;
      };
      fsp.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === sidecar.path) changedTarget = true;
        return handle;
      };
      await reject(writeSubtitleBesideVideo(aliasVideo, content, options()), "SUBTITLE_SIDECAR_UNSAFE", 409);
    } finally { fsp.open = open; fs.statSync = statSync; }
    assert(fs.readFileSync(physicalAliasVideo.path).equals(originalVideo));
    assert(!fs.readdirSync(aliasNested).some(name => name.startsWith(".fanhao-subtitle-"))); checks++;
  } finally { fs.unlinkSync(internalAlias); }

  // A sidecar junction/symlink cannot become a read or an overwrite target.
  const target = path.join(media, "ABC-001.CD2.und.ass");
  fs.symlinkSync(other, target, process.platform === "win32" ? "junction" : "dir");
  try {
    await reject(writeSubtitleBesideVideo(video, content, options({ language: "und", name: "track.ass" })), "SUBTITLE_SIDECAR_UNSAFE", 409);
    assert(!(await discoverVideoSubtitles(video, options())).some(item => item.path === target)); checks++;
  } finally { fs.unlinkSync(target); }
  const hugeExisting = path.join(media, "ABC-001.CD2.und.vtt");
  await reject(writeSubtitleBesideVideo(video, content, options({ language: "und", name: "track.vtt" })), "SUBTITLE_TOO_LARGE", 413);
  assert.equal(fs.statSync(hugeExisting).size, 2097153); checks++;

  // A mapped drive can canonicalize to a UNC share without being a junction.
  // Only canonical names are mocked; actual reads/writes use ordinary temp files.
  const mappedRoot = path.join(directory, "mapped-drive");
  const mappedDirectory = path.join(mappedRoot, "folder");
  fs.mkdirSync(mappedDirectory, { recursive: true });
  const mappedVideo = file("SMB-001.mp4", mappedDirectory);
  const mappedOptions = { roots: [mappedRoot] };
  const nativeRealpath = fs.realpathSync.native;
  const canonicalRoot = process.platform === "win32" ? "\\\\fixture-smb\\media" : path.join(directory, "canonical-share");
  const otherCanonical = process.platform === "win32" ? "\\\\other-smb\\media" : path.join(directory, "other-share");
  let mapping = canonicalRoot;
  let escape = "";
  fs.realpathSync.native = (value, ...args) => {
    const absolute = path.resolve(String(value));
    const relative = path.relative(mappedRoot, absolute);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      const escaped = escape === "directory" && relative === "folder" || escape === "video" && relative === path.join("folder", mappedVideo.name)
        || escape === "subtitle" && relative.endsWith(".srt");
      return path.join(escaped ? otherCanonical : mapping, relative);
    }
    return nativeRealpath(value, ...args);
  };
  try {
    const mapped = await writeSubtitleBesideVideo(mappedVideo, content, mappedOptions);
    assert.equal(mapped.path, path.join(mappedDirectory, "SMB-001.zh-CN.srt"));
    assert(fs.readFileSync(mapped.path).equals(content));
    assert.equal((await writeSubtitleBesideVideo(mappedVideo, content, mappedOptions)).created, false);
    assert.equal((await discoverVideoSubtitles(mappedVideo, mappedOptions))[0].path, mapped.path); checks++;

    escape = "directory";
    await reject(writeSubtitleBesideVideo(mappedVideo, content, mappedOptions), "SUBTITLE_SIDECAR_UNSAFE", 409);
    escape = "video";
    await reject(writeSubtitleBesideVideo(mappedVideo, content, mappedOptions), "SUBTITLE_VIDEO_CHANGED", 409);
    escape = "subtitle";
    await reject(writeSubtitleBesideVideo(mappedVideo, content, mappedOptions), "SUBTITLE_SIDECAR_UNSAFE", 409);
    assert.deepEqual(await discoverVideoSubtitles(mappedVideo, mappedOptions), []); checks++;
    escape = "";
    try {
      fsp.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === mapped.path) mapping = otherCanonical;
        return handle;
      };
      await reject(writeSubtitleBesideVideo(mappedVideo, content, mappedOptions), "SUBTITLE_SIDECAR_UNSAFE", 409);
    } finally { fsp.open = open; mapping = canonicalRoot; }
    assert(fs.readFileSync(mapped.path).equals(content));
    assert(!fs.readdirSync(mappedDirectory).some(name => name.startsWith(".fanhao-subtitle-"))); checks++;
  } finally { fs.realpathSync.native = nativeRealpath; }

  const unsupported = file("NO-LINK-001.mp4");
  const link = fs.linkSync;
  try {
    fs.linkSync = () => { throw Object.assign(new Error("fixture filesystem does not support links"), { code: "EOPNOTSUPP" }); };
    await reject(writeSubtitleBesideVideo(unsupported, content, options()), "SUBTITLE_SIDECAR_PUBLISH_UNSUPPORTED", 409);
  } finally { fs.linkSync = link; }
  noTemporary(); assert(!fs.existsSync(path.join(media, "NO-LINK-001.zh-CN.srt"))); checks++;
  assert(fs.readFileSync(video.path).equals(originalVideo)); noTemporary(); checks++;
  console.log(`subtitle sidecars: ${checks} checks passed`);
} finally {
  temporary.cleanup();
}
