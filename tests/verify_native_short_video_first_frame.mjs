import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildGalleryOwnershipDoubles, extractPlaybackRequestMethods } from "./fixtures/native-gallery-ownership-harness.mjs";

// Execute actual first-frame/play/single-player-reuse functions with observable
// Android leaves. No device, service, network, Gradle, APK or codec is invoked.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const activity = fs.readFileSync(path.join(native, "NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
const legacy = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/native-gallery-ownership-before-fix.json"), "utf8"));
const take = name => {
  const method = activity.match(new RegExp(`  private [^\\n]+ ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert(method, name); return method.replace("private ", "");
};
const methods = {...Object.fromEntries([...Object.keys(legacy.methods), "isBoundGallery", "isGalleryImageReady", "scheduleGalleryAutoAdvanceAfter", "invalidateGallerySearchAdvance"].map(name => [name, take(name)])), ...extractPlaybackRequestMethods(activity)};
const firstFrame = activity.match(/      public void onRenderedFirstFrame\(\) \{\n        int liveIndex = playerIndex\(preparedPlayer\);[\s\S]*?\n      \}/)?.[0];
assert(firstFrame, "production video first-frame callback");
const verifier = fs.readFileSync(path.join(root, "tests/verify_native_short_video_playback.mjs"), "utf8");
const shared = () => vm.runInNewContext(`${verifier.slice(verifier.indexOf("const doubles = "), verifier.indexOf("\ntry {"))}\ndoubles`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-native-first-frame-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const executable = name => fs.existsSync(path.join(javaHome, "bin", `${name}.exe`)) ? path.join(javaHome, "bin", `${name}.exe`) : name;

function compile(name, callback) {
  const doubles = buildGalleryOwnershipDoubles(shared(), methods, callback);
  // The unchanged prefix includes all live-cache and single-active-player reuse
  // branches. New-player construction needs Android and is outside these cases.
  const reuse = `${take("preparePlayerAt").split("    ExoPlayer.Builder playerBuilder =")[0]}
    throw new AssertionError("unexpected new-player construction in bound-player fixture");\n  }`;
  let probe = doubles["local/fanhao/library/SurfaceCoverProbe.java"];
  probe = probe.replace("void preparePlayersAround(int index){}", take("preparePlayersAround"))
    .replace("ExoPlayer preparePlayerAt(int index){return playerCache.get(index);}void ensurePlayerViewAt(int index){}",
      `${reuse}\n${take("setPlayerMedia")}\nPlayerView ensurePlayerViewAt(int index){return playerViews.computeIfAbsent(index,key->new PlayerView());}`)
    .replace("final Map<Integer,ExoPlayer> playerCache=", "final Map<Integer,PlayerView> playerViews=new HashMap<>(); final PlaybackFallback playbackFallback=new PlaybackFallback();\n      final Map<Integer,ExoPlayer> playerCache=")
    .replace("static class PlayerView extends Visual {", "static class ViewGroup {void removeView(PlayerView view){}} static class PlaybackFallback {Uri mediaUri(ExoPlayer player,ShortVideoItem item){return Uri.parse(item.streamUrl);}}\n      static class PlayerView extends Visual {Object getParent(){return null;}")
    .replace("boolean feedSearchOpen(){return false;}", "boolean search; boolean feedSearchOpen(){return search;}")
    .replace("void loadMoreIfNeeded(int index){}", "final List<Integer> preparations=new ArrayList<>();void loadMoreIfNeeded(int index){preparations.add(index);}")
    .replace("void scheduleVideoPrefetch(int index){}", "final List<Integer> prefetches=new ArrayList<>();void scheduleVideoPrefetch(int index){prefetches.add(index);}");
  assert(probe.includes("unexpected new-player construction"), "real reuse branch must replace the prior cache-only leaf");
  probe = probe.slice(0, probe.indexOf("      public static void main(String[] args){")) + `
      static SurfaceCoverProbe initial(){
        SurfaceCoverProbe host=new SurfaceCoverProbe();host.setPlayerMedia(host.activePlayer,host.videos.get(3));return host;
      }
      static void drain(SurfaceCoverProbe host){host.preparations.clear();host.prefetches.clear();host.mainHandler.runPending();}
      public static void main(String[] args){
        selected=args.length==0?"all":args[0];
        check("current_frame_prepares_current_only",()->{
          SurfaceCoverProbe h=initial();ExoPlayer player=h.activePlayer;int prepares=player.prepares;
          h.firstFrame(player);drain(h);
          require(h.preparations.equals(List.of(3))&&h.prefetches.equals(List.of(4)),"a current first-frame task must still run normal preparation and next prefetch");
          require(player.prepares==prepares&&h.playerIndex(player)==3,"current work must retain the already prepared source");
        });
        check("old_frame_cannot_steal_switched_source",()->{
          SurfaceCoverProbe h=initial();ExoPlayer player=h.activePlayer;h.firstFrame(player);h.selectForTest(0);
          MediaItem intended=player.media;int prepares=player.prepares;drain(h);
          require(h.currentIndex==0&&h.playerIndex(player)==0&&player.media==intended,"old first-frame work stole B's binding and source");
          require(h.preparations.isEmpty()&&h.prefetches.isEmpty()&&player.prepares==prepares,"obsolete work must not prepare or prefetch A again");
        });
        check("aba_old_frame_is_not_current_media",()->{
          SurfaceCoverProbe h=initial();ExoPlayer player=h.activePlayer;MediaItem first=player.media;h.firstFrame(player);
          h.selectForTest(0);h.selectForTest(3);require(player.media!=first,"A-B-A must exercise a new MediaItem on the same physical player");
          drain(h);require(h.preparations.isEmpty()&&h.prefetches.isEmpty(),"old A frame task survived media ABA identity change");
        });
        check("fresh_aba_frame_still_prepares",()->{
          SurfaceCoverProbe h=initial();ExoPlayer player=h.activePlayer;h.firstFrame(player);h.selectForTest(0);h.selectForTest(3);h.firstFrame(player);
          drain(h);require(h.preparations.equals(List.of(3))&&h.prefetches.equals(List.of(4)),"only the fresh A frame may prepare after ABA");
        });
        check("same_role_new_media_invalidates_old_frame",()->{
          SurfaceCoverProbe h=initial();ExoPlayer player=h.activePlayer;h.firstFrame(player);h.setPlayerMedia(player,h.videos.get(3));
          drain(h);require(h.preparations.isEmpty(),"same index/id/source URL still has a distinct media preparation owner");
        });
        for(String change:List.of("paused-activity","author","comments","search","finishing","destroying","left-viewer","cache-unbound","player-replaced")){
          check("obsolete_frame_"+change,()->{
            SurfaceCoverProbe h=initial();ExoPlayer old=h.activePlayer;h.firstFrame(old);
            if(change.equals("paused-activity"))h.activityResumed=false;
            if(change.equals("author"))h.authorOverlay=new Object();
            if(change.equals("comments"))h.comments=true;
            if(change.equals("search"))h.search=true;
            if(change.equals("finishing"))h.finishing=true;
            if(change.equals("destroying")){h.destroying=true;old.release();}
            if(change.equals("left-viewer")){h.currentIndex=-1;h.activePlayer=null;h.playerCache.clear();old.release();}
            if(change.equals("cache-unbound"))h.playerCache.clear();
            if(change.equals("player-replaced")){h.activePlayer=new ExoPlayer();h.playerCache.put(3,h.activePlayer);old.release();}
            int operations=old.operations;drain(h);
            require(h.preparations.isEmpty()&&h.prefetches.isEmpty(),"obsolete owner prepared or prefetched after "+change);
            if(old.released)require(old.operations==operations,"obsolete task touched a released player after "+change);
          });
        }
        require(checks>0,"unknown case");System.out.println("native-short-video-first-frame: "+checks+" actual callback/reuse/lifecycle cases passed");
      }
    }`;
  doubles["local/fanhao/library/SurfaceCoverProbe.java"] = probe;
  const folder = path.join(temp, name), sources = [];
  for (const [relative, source] of Object.entries(doubles)) {
    const target = path.join(folder, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source); sources.push(target);
  }
  sources.push(path.join(native, "NativeShortVideoFeedPlayback.java"));
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", folder, ...sources], { encoding: "utf8", timeout: 30000 });
  assert.equal(compiled.status, 0, compiled.stderr); return folder;
}
function run(folder, name = "all") {
  return spawnSync(executable("java"), ["-cp", folder, "local.fanhao.library.SurfaceCoverProbe", name], { encoding: "utf8", timeout: 10000 });
}
try {
  const current = compile("current", firstFrame), passed = run(current); assert.equal(passed.status, 0, passed.stderr); process.stdout.write(passed.stdout);
  // Removing the actual callback's execution-time guard must reproduce the
  // departed-source rebind; removing only media identity must expose ABA.
  const unguarded = firstFrame.replace(/          if \(!activityResumed[\s\S]*?frameMediaItem\) return;\n/, "");
  assert.notEqual(unguarded, firstFrame, "guard mutation anchor");
  const old = run(compile("unguarded", unguarded), "old_frame_cannot_steal_switched_source");
  assert.equal(old.status, 1); assert.match(old.stderr, /old_frame_cannot_steal_switched_source/);
  const noMediaOwner = firstFrame.replace("\n            || preparedPlayer.getCurrentMediaItem() != frameMediaItem", "");
  assert.notEqual(noMediaOwner, firstFrame, "media identity mutation anchor");
  const aba = run(compile("no-media-owner", noMediaOwner), "aba_old_frame_is_not_current_media");
  assert.equal(aba.status, 1); assert.match(aba.stderr, /aba_old_frame_is_not_current_media/);
  console.log("native-short-video-first-frame: unguarded source-steal and missing-media-owner ABA negative controls rejected");
} finally {
  const resolved = fs.realpathSync(temp); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith("fanhao-native-first-frame-"));
  const clean = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${resolved.replace(/'/g, "''")}' -Recurse -Force`], { encoding: "utf8", timeout: 10000 });
  assert.equal(clean.status, 0, clean.stderr);
}
