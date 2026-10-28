import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Actual gallery timers, continuation, paging commit, request and noisy handler.
// Only time/HTTP/UI/decoder leaves are controlled. No device, service or media.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const sourceFile=new URL('./verify_native_short_video_gallery_continuation.mjs',import.meta.url);
const source=fs.readFileSync(sourceFile,'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('const root ='),end=source.indexOf('doubles["local/fanhao/library/NativeGalleryContinuationHarness.java"] =');assert(start>=0&&end>start);
const context=vm.createContext({fs,path,assert,os,vm,spawnSync,fileURLToPath,process,URL});
vm.runInContext(`${source.slice(start,end).replace(/(?<!["'])import\.meta\.url(?!["'])/g,JSON.stringify(sourceFile.href))}\nglobalThis.bootstrap={doubles,activity,member};`,context);
const {doubles,activity,member}=context.bootstrap;
const feed='local/fanhao/library/NativeShortVideoFeedPlaybackHost.java';
doubles[feed]=doubles[feed].replace('class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {',`class NativeShortVideoFeedPlaybackHost extends NativeShortVideoPlaybackHost {${member('handleAudioInterruption')}`);
doubles['local/fanhao/library/NativeInterruptionAdvanceHarness.java']=`package local.fanhao.library;
import java.util.*;import android.os.SystemClock;import androidx.media3.exoplayer.ExoPlayer;
public final class NativeInterruptionAdvanceHarness {
static int cases;static final List<String> failures=new ArrayList<>();static void require(boolean value,String message){if(!value)throw new AssertionError(message);}static void check(String name,Runnable test){cases++;try{test.run();}catch(Throwable error){failures.add(name+": "+error.getMessage());}}
static class Fixture extends NativeShortVideoFeedPlaybackHost {
 final ShortVideoItem item;final boolean withSound;Fixture(boolean sound,int count,boolean attached,boolean next){SystemClock.now=0;withSound=sound;autoNext=true;item=new ShortVideoItem("gallery");for(int i=0;i<count;i++)item.galleryItems.add(new GalleryMedia(false,"http://fixture/image/"+i));videos.add(item);if(next)videos.add(new ShortVideoItem("next"));adapter.notifyDataSetChanged();if(!attached)attachedHolders.remove(0);currentIndex=-1;startPlaybackAt(0);drain();}
 void playGallerySound(int index,ShortVideoItem item){if(withSound)super.playGallerySound(index,item);}
 ShortVideoHolder holder(){return attachedHolders.get(0);}void last(){bindGallery(holder(),item,item.galleryItems.size()-1,0);}
 void noisy(){handleAudioInterruption();if(activePlayer!=null)activePlayer.pause();if(gallerySoundPlayer!=null)gallerySoundPlayer.pause();}
 void finish(){Runnable timer=galleryAutoAdvanceRunnable;if(timer!=null){SystemClock.now+=GALLERY_IMAGE_AUTO_ADVANCE_MS;timer.run();}}
 void bound(){attachedHolders.put(0,new ShortVideoHolder(0));flushSelectedPlaybackRequest();drain();}
 void more(){hasMoreVideos=true;nextFeedCursor="start";feedPaging.replaceFeed(pendingFeedUrl,nextFeedCursor,true);}
 void page(){FeedPage page=new FeedPage();page.nextCursor="end";page.offset=1;page.hasMore=false;page.items.add(new ShortVideoItem("loaded-next"));response=NativeShortVideoFeedPaging.ReadResult.success(page,false,"end");feedRequests.reply();drain();}
 void playSelectedNext(){int index=pager.getCurrentItem();if(index>0){handlePlaybackPageSelected(index);handlePlaybackPageScrollStateChanged(0);drain();}}
}
public static void main(String[]args){
 for(boolean sound:new boolean[]{false,true})check("noisy image timer stops next work sound="+sound,()->{Fixture f=new Fixture(sound,1,true,true);Runnable old=f.galleryAutoAdvanceRunnable;require(old!=null,"normal image timer missing");f.noisy();old.run();f.playSelectedNext();require(f.pager.getCurrentItem()==0,"noisy timer automatically selected the next work, next audible="+(f.activePlayer!=null&&f.activePlayer.getPlayWhenReady()));});
 check("noisy stops middle image auto step",()->{Fixture f=new Fixture(true,2,true,true);f.noisy();f.finish();require(f.holder().galleryIndex==0,"noisy allowed an automatic middle-image step");});
 check("pending noisy page cannot start fresh image timer",()->{Fixture f=new Fixture(true,1,false,true);require(f.gallerySoundPlayer==null,"pending fixture unexpectedly bound sound");f.noisy();f.bound();require(f.currentIndex==0&&!f.gallerySoundPlayer.getPlayWhenReady(),"pending noisy binding failed paused sound control");f.finish();f.playSelectedNext();require(f.pager.getCurrentItem()==0,"paused pending image still auto-selected an audible next work");});
 check("page waiting noisy cannot rearm a new epoch continuation",()->{Fixture f=new Fixture(true,1,true,false);f.more();f.finish();require(f.galleryContinuation!=null&&f.loadingMoreVideos,"missing controlled gallery page continuation");f.noisy();f.page();require(f.pager.getCurrentItem()==0,"old page continuation ignored audio epoch");f.resumeGalleryAutoAdvanceIfNeeded();f.finish();f.playSelectedNext();require(f.pager.getCurrentItem()==0,"rearmed image captured fresh epoch and bypassed interrupted intent");});
 for(boolean sound:new boolean[]{false,true})check("normal image advances without requiring audio sound="+sound,()->{Fixture f=new Fixture(sound,1,true,true);require(sound?f.gallerySoundPlayer!=null:f.gallerySoundPlayer==null,"wrong physical audio fixture");f.finish();require(f.pager.getCurrentItem()==1,"normal silent/sound gallery lost automatic continuation");});
 for(String pause:List.of("mute","temporary-focus","independent-sound-pause"))check("ordinary audio suppression does not cancel image flow "+pause,()->{Fixture f=new Fixture(true,1,true,true);long epoch=f.feedPlayback.audioInterruptionGeneration();if(pause.equals("mute"))f.gallerySoundPlayer.setVolume(0);else f.gallerySoundPlayer.pause();f.finish();require(f.pager.getCurrentItem()==1&&f.feedPlayback.audioInterruptionGeneration()==epoch,"non-noisy sound suppression was mistaken for logical pause");});
 check("repeated binding and lifecycle do not restore interrupted flow",()->{Fixture f=new Fixture(true,1,true,true);f.noisy();f.playAt(0);f.onPause();f.onResume();f.drain();f.resumeGalleryAutoAdvanceIfNeeded();f.finish();require(f.pager.getCurrentItem()==0&&!f.feedPlayback.allowsAutomaticAdvance(),"repeat bind/lifecycle washed interrupted permission");});
 check("manual gallery flip remains available while interrupted",()->{Fixture f=new Fixture(true,2,true,true);f.noisy();f.bindGallery(f.holder(),f.item,1,1);require(f.holder().galleryIndex==1&&f.pager.getCurrentItem()==0,"manual gallery flip was blocked");require(!f.feedPlayback.allowsAutomaticAdvance()&&f.galleryAutoAdvanceRunnable==null,"visual flip silently authorized automatic audio flow");});
 check("explicit playback can authorize a new current timer",()->{Fixture f=new Fixture(true,1,true,true);f.noisy();f.feedPlayback.requestExplicitPlayback();f.resumeGalleryAutoAdvanceIfNeeded();f.finish();require(f.pager.getCurrentItem()==1,"accepted explicit playback could not restart current continuation");});
 check("fresh work selection authorizes new playback",()->{Fixture f=new Fixture(true,1,true,true);f.noisy();f.pager.setCurrentItem(1,false);f.handlePlaybackPageSelected(1);f.handlePlaybackPageScrollStateChanged(0);f.drain();require(f.feedPlayback.allowsAutomaticAdvance()&&f.activePlayer.getPlayWhenReady(),"fresh user selection inherited interrupted previous work");});
 check("interrupted author return retains blocked permission",()->{Fixture f=new Fixture(true,1,true,true);f.noisy();f.showAuthorPanel(f.item);f.navigateBack();f.drain();f.resumeGalleryAutoAdvanceIfNeeded();f.finish();require(f.pager.getCurrentItem()==0&&!f.feedPlayback.allowsAutomaticAdvance(),"author return reauthorized interrupted image flow");});
 check("snapshot permission and old epoch survive later selections",()->{NativeShortVideoFeedPlayback intent=new NativeShortVideoFeedPlayback();intent.select("A");NativeShortVideoFeedPlayback.Snapshot before=intent.captureCurrent("A",0,null,null);intent.interruptAudio();NativeShortVideoFeedPlayback.Snapshot stopped=intent.captureCurrent("A",0,null,null);intent.select("B");require(intent.allowsAutomaticAdvance(),"new selection not authorized");intent.restore(stopped);intent.select("A");require(!intent.allowsAutomaticAdvance(),"same-epoch stopped snapshot lost permission");intent.select("B");intent.restore(before);intent.select("A");require(!intent.allowsAutomaticAdvance(),"old audio epoch snapshot revived permission");intent.restore(null);require(!intent.allowsAutomaticAdvance(),"clearing restore authorized playback");intent.requestExplicitPlayback();require(intent.allowsAutomaticAdvance(),"explicit playback failed to authorize");});
 check("pending suppression cannot launder a new source selection",()->{NativeShortVideoFeedPlayback intent=new NativeShortVideoFeedPlayback();intent.select("A");intent.interruptAudio();intent.bindWithoutAutoplay(()->intent.select("B"));require(!intent.allowsAutomaticAdvance(),"suppressed pending B became an authorized new selection");intent.select("B");require(!intent.allowsAutomaticAdvance(),"duplicate B bind revived authorization");intent.select("C");require(intent.allowsAutomaticAdvance(),"actual later selection remained blocked");});
 check("suppressed binding always records blocked logical intent",()->{NativeShortVideoFeedPlayback intent=new NativeShortVideoFeedPlayback();intent.select("A");intent.bindWithoutAutoplay(()->intent.select("B"));require(!intent.allowsAutomaticAdvance(),"suppressed binding kept a previously authorized logical intent");});
 if(!failures.isEmpty())throw new AssertionError(String.join("\\n",failures));System.out.println("native-short-video-interruption-advance: "+cases+" actual noisy/gallery/request/paging cases passed");
}
}`;
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'fanhao-native-interruption-advance-'));
const javaHome=process.env.JAVA_HOME||'C:/Program Files/Android/openjdk/jdk-21.0.8';const exe=name=>fs.existsSync(path.join(javaHome,'bin',name+'.exe'))?path.join(javaHome,'bin',name+'.exe'):name;
const intentSource=fs.readFileSync(path.join(native,'NativeShortVideoFeedPlayback.java'),'utf8').replace(/\r\n/g,'\n');
function run(label,host=doubles[feed],intent=intentSource){
 const folder=path.join(temporary,label),files=[];for(const [relative,text] of Object.entries({...doubles,[feed]:host,'local/fanhao/library/NativeShortVideoFeedPlayback.java':intent})){const target=path.join(folder,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);files.push(target);}
 for(const name of ['NativeShortVideoPlaybackFallback.java','NativeShortVideoScreenState.java','NativeShortVideoSeekSession.java','NativeShortVideoFeedPaging.java','NativeShortVideoFeedAutoAdvance.java'])files.push(path.join(native,name));
 const compiled=spawnSync(exe('javac'),['-encoding','UTF-8','-d',folder,...files],{encoding:'utf8',timeout:20000});assert.equal(compiled.status,0,compiled.stderr);
 return spawnSync(exe('java'),['-cp',folder,'local.fanhao.library.NativeInterruptionAdvanceHarness'],{encoding:'utf8',timeout:15000});
}
try{
 const result=run('current');assert.equal(result.status,0,result.stderr);process.stdout.write(result.stdout);
 const discardedNoisy=intentSource.replace('    automaticAdvanceRequested = false;','');assert.notEqual(discardedNoisy,intentSource);
 const discardedSnapshot=intentSource.replace('automaticAdvanceRequested = snapshot.automaticAdvanceRequested\n      && snapshot.audioInterruptionGeneration','automaticAdvanceRequested = snapshot.audioInterruptionGeneration');assert.notEqual(discardedSnapshot,intentSource);
 const discardedSuppression=intentSource.replace('    bindingWithoutAutoplay = true;\n    automaticAdvanceRequested = false;','    bindingWithoutAutoplay = true;');assert.notEqual(discardedSuppression,intentSource);
 const noisy=member('handleAudioInterruption'),unsafeNoisy=noisy.replace('    cancelGalleryAutoAdvance();','').replace('    cancelGalleryContinuation();','');
 const unsafeTimers=doubles[feed].replace(noisy,unsafeNoisy).replaceAll('feedPlayback.allowsAutomaticAdvance()','true');assert.notEqual(unsafeTimers,doubles[feed]);
 const negatives=[['forgot-noisy',doubles[feed],discardedNoisy,/repeated binding and lifecycle do not restore interrupted flow|snapshot permission/],['forgot-snapshot',doubles[feed],discardedSnapshot,/snapshot permission and old epoch/],['forgot-suppression',doubles[feed],discardedSuppression,/suppressed binding always records/],['old-image-advance',unsafeTimers,intentSource,/noisy image timer stops next work/]];
 for(const [label,host,intent,oracle] of negatives){const rejected=run(label,host,intent);assert.equal(rejected.status,1,label+' accepted the regression: '+rejected.stderr);assert.match(rejected.stderr,oracle);}
 console.log('native-short-video-interruption-advance: four compiled noisy/snapshot/pending/image-advance negative controls rejected');
}finally{
 const target=fs.realpathSync(temporary);assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));assert(path.basename(target).startsWith('fanhao-native-interruption-advance-'));
 const cleanup=spawnSync('powershell.exe',['-NoProfile','-Command',`Remove-Item -LiteralPath '${target.replace(/'/g,"''")}' -Recurse -Force`],{encoding:'utf8',timeout:10000});assert.equal(cleanup.status,0,cleanup.stderr);
}
