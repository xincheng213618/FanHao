import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Save -> a genuinely new host -> real Activity startup/restore/binding methods.
// Android UI, Bundle transport and decoder/player IO are controlled boundaries;
// the feed models, JSON codec and playback intent owner are production classes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const activity = fs.readFileSync(path.join(nativeRoot, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
function member(name, required = true) {
  const start = new RegExp(`^  (?:private|protected) [^\\n]+ ${name}\\([^\\n]*`, "m").exec(activity)?.index;
  if (start == null) { assert(!required, `missing actual Activity ${name}`); return ""; }
  const end = activity.indexOf("\n  }", start); assert(end > start);
  return activity.slice(start, end + 4).replace(/private |protected /, "").replace(/@(?:Nullable|NonNull) /g, "");
}
const previous = fs.readFileSync(path.join(root, "tests/verify_native_short_video_playback.mjs"), "utf8").replace(/\r\n/g, "\n");
const begin = previous.indexOf("const doubles = {"), end = previous.indexOf("  for (const [relative, source] of Object.entries(doubles))");
assert(begin >= 0 && end > begin);
const environment = vm.createContext({ assert, fs, path, root, nativeRoot, advisories: { check() {} } });
vm.runInContext(`${previous.slice(begin, end).replace("\ntry {\n", "\n{\n")}\nglobalThis.fixture = { doubles };\n}`, environment);
const { doubles } = environment.fixture;
delete doubles["org/json/JSONObject.java"];
delete doubles["local/fanhao/library/ShortVideoItem.java"];
delete doubles["local/fanhao/library/FeedPage.java"];
delete doubles["local/fanhao/library/NativeShortVideoHttpResponse.java"];
const base = "local/fanhao/library/NativeShortVideoPlaybackHost.java";
doubles[base] = doubles[base].replace("      void onResume() {}", "      void onCreate(android.os.Bundle state) {}\n      void onSaveInstanceState(android.os.Bundle state) {}\n      void onResume() {}");
const feed = "local/fanhao/library/NativeShortVideoFeedPlaybackHost.java";
doubles[feed] = doubles[feed].replace(/    class GalleryMedia \{[\s\S]*?    class NativeNoNetworkExecutor/, "    class NativeNoNetworkExecutor");
doubles[feed] = doubles[feed].replace("private final class GallerySegmentCallback", "final class GallerySegmentCallback");
const soundPrelude = member("playGallerySound").split("    if (gallerySoundPlayer == null)")[0];
doubles[feed] = doubles[feed].replace("void playGallerySound(int feedIndex, ShortVideoItem item) {\n        if (gallerySoundPlayer == null)", `${soundPrelude.trim()}\n        if (gallerySoundPlayer == null)`);
doubles[feed] = doubles[feed].replace("final ReadRequests feedRequests = new ReadRequests();", "final NativeShortVideoFeedRequests feedRequests = new NativeShortVideoFeedRequests();");
doubles[feed] = doubles[feed].replace("void markPendingAutoAdvance(int index) {}", "void markPendingAutoAdvance(int index) {}void clearPendingAutoAdvance(){}");
doubles["android/os/Handler.java"] = doubles["android/os/Handler.java"].replace("public final ArrayList<Runnable> pending = new ArrayList<>();", "public final java.util.List<Runnable> pending = java.util.Collections.synchronizedList(new ArrayList<>());")
  .replace("ArrayList<Runnable> batch = new ArrayList<>(pending); pending.clear();", "ArrayList<Runnable> batch; synchronized(pending){batch=new ArrayList<>(pending);pending.clear();}");
doubles["androidx/media3/exoplayer/ExoPlayer.java"] = doubles["androidx/media3/exoplayer/ExoPlayer.java"]
  .replace("public long position = 4567;", "public long position = 0;")
  .replace("public void clearMediaItems() { touch(); }", "public void clearMediaItems() { touch(); media=null;position=0; }")
  .replace("public void setMediaItem(MediaItem value) { touch(); media = value; }", "public void setMediaItem(MediaItem value) { touch(); media = value;position=0; }");
doubles["android/net/Uri.java"] = doubles["android/net/Uri.java"].replace("public static Uri parse(", "public static String encode(String value){return java.net.URLEncoder.encode(value,java.nio.charset.StandardCharsets.UTF_8).replace(\"+\",\"%20\");}public static Uri parse(")
  .replace("public Builder path(String value)", "public Builder encodedPath(String value){path=value;return this;}public Builder encodedQuery(String value){query=value;return this;}public Builder path(String value)");
doubles["android/util/Log.java"] = doubles["android/util/Log.java"].replace("public static int i(", "public static int e(String tag,String message,Throwable error){return 0;}public static int i(");
doubles["android/os/Bundle.java"] = `package android.os;import java.util.*;public class Bundle{
  public final Map<String,Object> values=new LinkedHashMap<>();public Bundle(){}public Bundle(Bundle other){values.putAll(other.values);}
  public void putString(String key,String value){values.put(key,value);}public String getString(String key){return (String)values.get(key);}public String getString(String key,String fallback){return values.get(key) instanceof String?(String)values.get(key):fallback;}
  public void putInt(String key,int value){values.put(key,value);}public int getInt(String key,int fallback){return values.get(key) instanceof Number?((Number)values.get(key)).intValue():fallback;}public int getInt(String key){return getInt(key,0);}
  public void putLong(String key,long value){values.put(key,value);}public long getLong(String key,long fallback){return values.get(key) instanceof Number?((Number)values.get(key)).longValue():fallback;}
  public void putBoolean(String key,boolean value){values.put(key,value);}public boolean getBoolean(String key,boolean fallback){return values.get(key) instanceof Boolean?(Boolean)values.get(key):fallback;}public boolean getBoolean(String key){return getBoolean(key,false);}
  public boolean containsKey(String key){return values.containsKey(key);}public void remove(String key){values.remove(key);}public Set<String> keySet(){return values.keySet();}public Object get(String key){return values.get(key);}public int size(){return values.size();}
}`;
const constants = [...activity.matchAll(/^  (?:public|private) static final String (?:EXTRA_\w+|CHECKPOINT_\w+|PREFS_NAME) = .*;$/gm)].map(match => match[0].replace(/public |private /, "")).join("\n");
const checkpointMethods = ["checkpointScope", "checkpointDirectory", "checkpointGallerySourceKey", "captureCheckpointFeed", "rememberCheckpointLifecycle", "rememberCheckpointOverlay", "savePlaybackCheckpoint", "checkpointResolvedScreen", "restorePlaybackCheckpoint", "showCheckpointRecovery", "retryCheckpointRecovery"].map(name => member(name)).join("\n");
const save = member("onSaveInstanceState", false) || "void onSaveInstanceState(Bundle state){super.onSaveInstanceState(state);}";
const soundOwner = activity.match(/  private final class GallerySoundCallback \{[\s\S]*?\n  \}/)?.[0];assert(soundOwner);
const methods = [member("onCreate"), member("readVideos"), member("setPlayerMedia"), member("handlePlaybackError"), member("handleAudioInterruption"), soundOwner.replace("private ", ""), member("captureGallerySoundCallback"), member("applyCommittedDelete"), member("nextVideoAfterDelete"), member("purgeDeletedFromNavigationStack"), member("purgeDeletedFromScreen"), save, checkpointMethods].join("\n");
const fixture = fs.readFileSync(path.join(root, "tests/fixtures/NativeShortVideoCheckpointHarness.java"), "utf8")
  .replace("/* ACTIVITY_CONSTANTS */", constants).replace("/* ACTIVITY_METHODS */", methods);
doubles["local/fanhao/library/NativeShortVideoCheckpointHarness.java"] = fixture;

const gradleHome = process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle");
const jsonRoot = path.join(gradleHome, "caches/modules-2/files-2.1/org.json/json");
let jsonJar = "";
if (fs.existsSync(jsonRoot)) for (const version of fs.readdirSync(jsonRoot).sort().reverse()) {
  for (const hash of fs.readdirSync(path.join(jsonRoot, version))) {
    const folder = path.join(jsonRoot, version, hash);
    if (fs.statSync(folder).isDirectory()) for (const name of fs.readdirSync(folder)) if (/^json-.+\.jar$/.test(name)) jsonJar ||= path.join(folder, name);
  }
}
assert(jsonJar, "checkpoint fixture requires the existing cached org.json runtime");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-checkpoint-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const tool = name => path.join(javaHome, "bin", `${name}.exe`);
try {
  const production = new Map(["NativeShortVideoPlaybackFallback.java", "NativeShortVideoFeedPlayback.java", "NativeShortVideoScreenState.java", "NativeShortVideoActionSnapshots.java", "ShortVideoFeedModels.java", "ShortVideoFeedContract.java", "ShortVideoDeleteResult.java", "NativeShortVideoCheckpoint.java", "NativeShortVideoFeedRequests.java", "NativeShortVideoFeedPaging.java", "NativeShortVideoFeedTransport.java", "NativeShortVideoHttpResponse.java"].map(name => [name, fs.readFileSync(path.join(nativeRoot, name), "utf8")]));
  function execute(label, { host = fixture, mutated = new Map(), filter = "", failure } = {}) {
    const folder = path.join(temporary, label); fs.mkdirSync(folder);
    const sources = [];
    const write = (relative, text) => { const target = path.join(folder, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); sources.push(target); };
    for (const [relative, text] of Object.entries(doubles)) write(relative, relative.endsWith("NativeShortVideoCheckpointHarness.java") ? host : text);
    for (const [name, text] of production) write(`local/fanhao/library/${name}`, mutated.get(name) || text);
    const compiled = spawnSync(tool("javac"), ["-encoding", "UTF-8", "-cp", jsonJar, "-d", folder, ...sources], { cwd: root, encoding: "utf8" });
    assert.equal(compiled.status, 0, `${label}: actual Activity checkpoint fixture must compile:\n${compiled.stderr || compiled.stdout}`);
    const run = spawnSync(tool("java"), [`-Dcheckpoint.filter=${filter}`, "-cp", [folder, jsonJar].join(path.delimiter), "local.fanhao.library.NativeShortVideoCheckpointHarness", folder], { cwd: root, encoding: "utf8" });
    if (failure) { assert.notEqual(run.status, 0, `${label}: removing the production behavior must fail the actual new-instance case`); assert.match(`${run.stderr}\n${run.stdout}`, failure); }
    else { process.stdout.write(run.stdout || ""); assert.equal(run.status, 0, `actual new-instance checkpoint behavior must pass:\n${run.stderr || run.stdout}`); }
  }
  execute("actual");
  const mutate = (text, before, after) => { const next = text.replace(before, after); assert(next !== text, `negative control anchor: ${before}`); return next; };
  const selection = "video matrix B 19000 false false";
  const restoreHook = fixture.match(/^    if \(restorePlaybackCheckpoint\([^\n]+\)\) return;$/m)?.[0]; assert(restoreHook);
  execute("missing-restore-hook", { host: mutate(fixture, restoreHook, restoreHook.replace("if (", "if (false && ")), filter: selection, failure: /saved selected id/ });
  execute("missing-save-hook", { host: mutate(fixture, "savePlaybackCheckpoint(outState);", "/* removed real save hook */"), filter: selection, failure: /saved selected id/ });
  execute("lost-position", { mutated: new Map([["NativeShortVideoFeedPlayback.java", mutate(production.get("NativeShortVideoFeedPlayback.java"), "target.seekTo(track.position);", "/* lost saved track position */")]]), filter: selection, failure: /exact position/ });
  execute("lost-paused-intent", { mutated: new Map([["NativeShortVideoFeedPlayback.java", mutate(production.get("NativeShortVideoFeedPlayback.java"), "target.setPlayWhenReady(requested);", "target.setPlayWhenReady(true);")]]), filter: selection, failure: /logical play\/pause/ });
  execute("unowned-source-recovery", { host: mutate(fixture, "boolean sameSource = owner.sourceHash.equals(NativeShortVideoCheckpoint.sourceHash(item, media));", "boolean sameSource = true;"), filter: "oversize explicit recovery new-source", failure: /source replacement must not inherit/ });
  execute("cache-key-is-not-source-owner", { host: mutate(fixture, "playbackFallback.isBoundToItem(activePlayer, item)", "playbackFallback.bindingOwner(activePlayer) != null"), filter: "cached player logical binding rejects wrong source", failure: /wrong logical binding cannot persist/ });
  execute("wrong-detail-http-route", { host: mutate(fixture, 'String url = base + "/api/short-videos/videos/" + Uri.encode(owner.itemId);', 'String url = base + "/api/short-videos/unknown-prefix/" + Uri.encode(owner.itemId);'), filter: "canonical recovery read route", failure: /canonical detail route must restore/ });
  execute("missing-new-role-restore", { host: mutate(fixture, "hasVideo ? (sameSource && old != null && old.hasVideo() ? old.videoPosition() : 0L) : null, false,", "old != null && old.hasVideo() ? (sameSource ? old.videoPosition() : 0L) : null, false,"), filter: "recovery image without tracks becomes video and new sound", failure: /missing old video track must not/ });
  console.log("native-short-video-checkpoint: 8 compiled Activity/track/source/HTTP-route/role negative controls rejected");
} finally {
  const resolved = path.resolve(temporary); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith("fanhao-native-checkpoint-"));
  const escaped = resolved.replaceAll("'", "''");
  const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${escaped}' -Recurse -Force`], { encoding: "utf8" });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}
