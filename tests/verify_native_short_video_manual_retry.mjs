import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Actual terminal-error/manual-retry/normal playback methods, real fallback and
// feed intent. UI/player/clock are controlled; no device, network or media.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const template = fs.readFileSync(path.join(root, "tests/verify_native_short_video_playback.mjs"), "utf8").replace(/\r\n/g, "\n");
const start = template.indexOf("const doubles = {"), end = template.indexOf("  for (const [relative, source] of Object.entries(doubles))");
const context = vm.createContext({ fs, path, assert, root, nativeRoot: native, advisories: { check() {} } });
vm.runInContext(`${template.slice(start, end).replace("try {\n  const sources = [];", "const sources = [];")}\nglobalThis.generated=doubles;`, context);
const doubles = context.generated;
const activity = fs.readFileSync(path.join(native, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
function member(name) {
  const found = activity.match(new RegExp(`  private [^\\n]+ ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert(found, name); return found.replace("private ", "final ");
}
const feedPath = "local/fanhao/library/NativeShortVideoFeedPlaybackHost.java";
doubles[feedPath] = doubles[feedPath]
  .replace("import androidx.media3.common.MediaItem;", "import androidx.media3.common.MediaItem; import androidx.media3.common.PlaybackException;")
  .replace("playbackFallback.mediaUri(activePlayer, videos.get(index)); activePlayer.prepare();", "setPlayerMedia(activePlayer, videos.get(index));")
  .replace("playbackFallback.mediaUri(player, videos.get(index));", "setPlayerMedia(player, videos.get(index));")
  .replace(/      void releaseAllPlayers\(\) \{[\s\S]*?\n      \}/, member("releaseAllPlayers"))
  .replace("\n    }\n    class View", `
      final Map<Integer,PlayerView> playerViews=new HashMap<>();
      void cancelGalleryContinuation(){}
      ${member("setPlayerMedia")}
      ${member("handlePlaybackError")}
    }
    class PlayerView extends Surface {Object getParent(){return null;}}
    class ViewGroup {void removeView(Object view){}}
    class View`);
doubles["androidx/media3/exoplayer/ExoPlayer.java"] = doubles["androidx/media3/exoplayer/ExoPlayer.java"]
  .replace("public void clearMediaItems() { touch(); }", "public void clearMediaItems() { touch(); media=null; position=0; }");
doubles["local/fanhao/library/ShortVideoItem.java"] = doubles["local/fanhao/library/ShortVideoItem.java"]
  .replace('ShortVideoItem(String id) { this.id = id; streamUrl = "http://127.0.0.1/media/short-video/" + id; }',
    'ShortVideoItem(String id) { this(id,"http://127.0.0.1/media/short-video/"+id); } ShortVideoItem(String id,String url) { this.id=id;streamUrl=url; }');
doubles["local/fanhao/library/NativeManualRetryHarness.java"] = `package local.fanhao.library;
import java.util.*;import androidx.media3.common.*;import androidx.media3.exoplayer.ExoPlayer;
public final class NativeManualRetryHarness {
  static int checks;static final List<String> failures=new ArrayList<>();
  static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
  static void check(String name,Runnable test){checks++;try{test.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
  static class Fixture extends NativeShortVideoFeedPlaybackHost {
    boolean search;Runnable onPrepared;
    Fixture(){videos.add(new ShortVideoItem("A"));videos.add(new ShortVideoItem("B"));adapter.notifyDataSetChanged();currentIndex=-1;startPlaybackAt(0);drain();}
    boolean feedSearchOpen(){return search;}
    ExoPlayer preparePlayerAt(int index){ExoPlayer player=super.preparePlayerAt(index);if(onPrepared!=null){Runnable task=onPrepared;onPrepared=null;task.run();}return player;}
    void terminal(){handlePlaybackError(currentIndex,activePlayer,new PlaybackException(1000));}
    void retry(){retryPlaybackAt(currentIndex);drain();}
  }
  public static void main(String[]args){
    check("terminal retry retains recent position",()->{Fixture f=new Fixture();f.activePlayer.seekTo(27000);f.terminal();f.retry();require(f.activePlayer.position==27000,"expected27000 actual"+f.activePlayer.position);require(f.activePlayer.getPlayWhenReady(),"explicit retry did not request play");});
    for(long target:new long[]{0,4000})check("latest pending-retry seek="+target,()->{Fixture f=new Fixture();f.activePlayer.seekTo(21000);f.handlePlaybackError(0,f.activePlayer,new PlaybackException(2002));f.activePlayer.seekTo(target);f.terminal();f.retry();require(f.activePlayer.position==target,"latest seek expected"+target+" actual"+f.activePlayer.position);});
    check("explicit retry supersedes old pause",()->{Fixture f=new Fixture();f.activePlayer.seekTo(19000);f.activePlayer.pause();f.terminal();f.retry();require(f.activePlayer.getPlayWhenReady(),"clicked retry kept old pause");});
    check("retry cannot return a departed work",()->{Fixture f=new Fixture();f.terminal();f.retryPlaybackAt(0);f.selectForTest(1);f.drain();require(f.currentIndex==1,"queued retry navigated back to"+f.currentIndex);});
    check("explicit retry supersedes stale lifecycle seek and pause",()->{Fixture f=new Fixture();f.activePlayer.seekTo(5000);f.activePlayer.pause();f.feedPlayback.restore(f.feedPlayback.captureCurrent("A",-1,f.activePlayer,null));f.activePlayer.seekTo(19000);f.terminal();f.retry();require(f.activePlayer.getPlayWhenReady()&&f.activePlayer.position==19000,"older restore overrode the newer retry intent/position");});
    for(long target:new long[]{0,4000})check("latest active rewind supersedes older failure="+target,()->{Fixture f=new Fixture();f.activePlayer.seekTo(21000);f.terminal();f.selectForTest(0);f.activePlayer.seekTo(target);f.retry();require(f.activePlayer.position==target,"live retry ignored the latest rewind to"+target);});
    check("zero terminal overwrites an earlier failure",()->{Fixture f=new Fixture();f.activePlayer.seekTo(21000);f.terminal();f.selectForTest(0);f.activePlayer.seekTo(0);f.terminal();f.retry();require(f.activePlayer.position==0,"zero terminal position retained the previous failure seek");});
    check("same id replacement source never inherits failure seek",()->{Fixture f=new Fixture();f.activePlayer.seekTo(21000);f.terminal();f.videos.set(0,new ShortVideoItem("A","http://127.0.0.1/media/short-video/A?v=2"));f.retry();require(f.activePlayer.position==0&&f.activePlayer.media.uri.getQueryParameters("v").equals(List.of("2")),"old source failure seek leaked to the same id new source: "+f.activePlayer.position+" "+f.activePlayer.media.uri);});
    check("different work at same index never inherits failure seek",()->{Fixture f=new Fixture();f.activePlayer.seekTo(21000);f.terminal();f.videos.set(0,new ShortVideoItem("replacement"));f.retry();require(f.activePlayer.position==0&&f.activePlayer.media.uri.getPath().equals("/media/short-video/replacement"),"old item failure seek leaked to a replacement work: "+f.activePlayer.position+" "+f.activePlayer.media.uri);});
    for(String owner:List.of("background","author","comments","search","destroying","finishing","pager","holder","gallery"))check("hidden or departed retry="+owner,()->{Fixture f=new Fixture();f.terminal();int prepared=f.prepared;
      if(owner.equals("background"))f.activityResumed=false;if(owner.equals("author"))f.authorOverlay=new Object();if(owner.equals("comments"))f.comments=true;if(owner.equals("search"))f.search=true;if(owner.equals("destroying"))f.destroying=true;if(owner.equals("finishing"))f.finishing=true;if(owner.equals("pager"))f.pager.index=1;if(owner.equals("holder"))f.attachedHolders.remove(0);if(owner.equals("gallery"))f.videos.get(0).galleryItems.add(new GalleryMedia(false));
      f.retry();require(f.prepared==prepared&&f.activePlayer==null,"obsolete/hidden retry prepared or played a new owner");});
    for(String owner:List.of("source","holder","pager"))check("prepare boundary ownership="+owner,()->{Fixture f=new Fixture();f.activePlayer.seekTo(21000);f.terminal();f.onPrepared=()->{if(owner.equals("source"))f.videos.set(0,new ShortVideoItem("A","http://127.0.0.1/A-v2"));if(owner.equals("holder"))f.attachedHolders.put(0,new ShortVideoHolder(0));if(owner.equals("pager"))f.pager.index=1;};f.retry();ExoPlayer player=f.playerCache.get(0);require(f.activePlayer==null&&!player.getPlayWhenReady()&&player.position==0,"reentrant prepare rebound the obsolete retry");});
    check("release clears terminal snapshot",()->{Fixture f=new Fixture();f.activePlayer.seekTo(21000);f.terminal();require(f.failedVideoRetry!=null,"terminal snapshot missing");f.releaseAllPlayers();require(f.failedVideoRetry==null,"released feed retained terminal recovery state");});
    if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));
    System.out.println("native-short-video-manual-retry: "+checks+" actual terminal-error/position/intent/source cases passed");
  }
}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-manual-retry-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const tool = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;
function run(label, files) {
  const folder = path.join(temp, label), sources = [];
  for (const [relative, source] of Object.entries(files)) { const target = path.join(folder, relative);fs.mkdirSync(path.dirname(target), { recursive: true });fs.writeFileSync(target, source);sources.push(target); }
  sources.push(...["NativeShortVideoPlaybackFallback.java", "NativeShortVideoFeedPlayback.java", "NativeShortVideoScreenState.java"].map(name => path.join(native, name)));
  const compiled = spawnSync(tool("javac"), ["-encoding", "UTF-8", "-d", folder, ...sources], { encoding: "utf8", timeout: 30000 });assert.equal(compiled.status, 0, compiled.stderr);
  return spawnSync(tool("java"), ["-cp", folder, "local.fanhao.library.NativeManualRetryHarness"], { encoding: "utf8", timeout: 15000 });
}
try {
  const passed = run("current", doubles);assert.equal(passed.status, 0, passed.stderr);process.stdout.write(passed.stdout);
  const retry = member("retryPlaybackAt"), terminal = member("handlePlaybackError");
  const mutations = [
    ["lost-terminal-position", terminal, terminal.replace("Math.max(0L, player.getCurrentPosition())", "0L"), /terminal retry retains recent position/],
    ["ignored-live-zero", retry, retry.replace("previous != null && previous == activePlayer ?", "previous != null && previous == activePlayer && previous.getCurrentPosition() > 0L ?"), /latest active rewind supersedes older failure=0/],
    ["same-id-old-source", retry, retry.replace("failedVideoRetry.item == item", "failedVideoRetry.item.id.equals(item.id)"), /same id replacement source never inherits failure seek/],
    ["old-lifecycle-intent", retry, retry.replace("    feedPlayback.restore(null);", ""), /explicit retry supersedes stale lifecycle seek and pause/],
  ];
  for (const [name, before, after, oracle] of mutations) {
    assert.notEqual(after, before, `${name} mutation anchor`);assert(doubles[feedPath].includes(before), `${name} actual method`);
    const rejected = run(name, { ...doubles, [feedPath]: doubles[feedPath].replace(before, after) });
    assert.equal(rejected.status, 1, `${name} did not reject the regression: ${rejected.stderr}`);assert.match(rejected.stderr, oracle);
  }
  console.log("native-short-video-manual-retry: four compiled lost-position/live-zero/source/intent negative controls rejected");
} finally {
  const resolved = fs.realpathSync(temp);assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith("fanhao-native-manual-retry-"));
  const clean = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${resolved.replace(/'/g, "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 10000 });assert.equal(clean.status, 0, clean.stderr);
}
