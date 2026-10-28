import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGalleryOwnershipDoubles } from "./fixtures/native-gallery-ownership-harness.mjs";

// Full real playAt/request/bindSelectedPlaybackAt, real image decode scheduling,
// paint, retry and status methods. Android leaves and decoder results are
// controlled; no device, media, service, database or APK is used.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),native=path.join(root,"android-client/android/app/src/main/java/local/fanhao/library");
const fixtureFile=path.join(root,"tests/verify_native_short_video_gallery_image_recovery.mjs"),template=fs.readFileSync(fixtureFile,"utf8");
const prefix=template.slice(template.indexOf("const root="),template.lastIndexOf("\nconst temporary=")).replace("fileURLToPath(import.meta.url)",`fileURLToPath(${JSON.stringify(pathToFileURL(fixtureFile).href)})`);
const env={assert,fs,os,path,vm,spawnSync,fileURLToPath,pathToFileURL,buildGalleryOwnershipDoubles,process};
const {doubles,java:base,member,replaceMethod,activity}=vm.runInNewContext(prefix+"\n({doubles,java,member,replaceMethod,activity})",env);
const host="local/fanhao/library/SurfaceCoverProbe.java";
const request=activity.match(/  private static final class PlaybackRequest \{[\s\S]*?\n  \}/)?.[0];assert(request);
let java=replaceMethod(base,"main","");
java=java.replace("static class PlaybackRequest{}",request.replace("private ",""));
java=replaceMethod(java,"playAt",member("playAt"));
java=java.replace("public class SurfaceCoverProbe {",`public class SurfaceCoverProbe {
 ${["bindSelectedPlaybackAt","playbackPageVisible","isSelectedPlaybackItem","pauseSelectedPlaybackRequest","cancelSelectedPlaybackRequest","requestSelectedPlayback","flushSelectedPlaybackRequest"].map(member).join("\n")}
 void rebound(){playAt(pager.getCurrentItem());}
 void replaceImage(String url){GalleryMedia media=new GalleryMedia();media.video=false;media.url=url;videos.get(3).galleryItems.set(0,media);}
`);
java=java.slice(0,java.lastIndexOf("}"))+`
 public static void main(String[]args){selected=args.length==0?"all":args[0];try{
 check("same-page failed image keeps recovery status",()->{SurfaceCoverProbe h=fresh();h.failed();NativeShortVideoGalleryImageReadiness state=h.state();h.rebound();require(h.showing("图片加载失败，点一下重试"),"real playAt hid the failed image recovery status");require(h.reads==1&&h.state()==state&&state.failed,"repeat bind reset or retried failed image state");});
 check("same-page inflight retry keeps waiting status",()->{SurfaceCoverProbe h=fresh();h.failed();ImageRead read=h.plan(new Bitmap(),false,true);h.tap();h.awaitEntered(read);NativeShortVideoGalleryImageReadiness state=h.state();h.rebound();require(h.showing("正在重试图片"),"real playAt hid the owned slow retry status");h.tick(2000);require(h.reads==2&&h.state()==state&&h.showing("正在重试图片"),"repeat bind duplicated the retry or lost its feedback");read.release.countDown();h.settled();h.drain();require(h.state().ready&&h.statusView.visibility==View.GONE,"rebound retry could not settle and clear its own status");});
 check("replacement source does not revive prior failure",()->{SurfaceCoverProbe h=fresh();h.failed();h.replaceImage("http://fixture/replacement");ImageRead read=h.plan(new Bitmap(),false,true);h.rebound();h.awaitEntered(read);require(h.statusView.visibility==View.GONE&&!h.state().failed,"replacement source borrowed the old failure status");read.release.countDown();h.settled();h.drain();h.rebound();require(h.state().ready&&h.statusView.visibility==View.GONE,"successful replacement revived previous recovery status");});
 check("replacement holder does not borrow prior failure",()->{SurfaceCoverProbe h=fresh();h.failed();h.attachedHolders.put(3,new ShortVideoHolder(3));ImageRead read=h.plan(new Bitmap(),false,true);h.rebound();h.awaitEntered(read);require(h.statusView.visibility==View.GONE&&!h.state().failed,"new holder inherited old failure feedback");read.release.countDown();h.settled();h.drain();require(h.state().ready,"replacement holder could not display a normal successful read");});
 check("new selected work does not inherit recovery status",()->{SurfaceCoverProbe h=fresh();h.failed();ShortVideoItem next=h.videos.get(2);next.galleryItems.clear();GalleryMedia media=new GalleryMedia();media.video=false;media.url="http://fixture/new-work";next.galleryItems.add(media);ImageRead read=h.plan(new Bitmap(),false,true);h.pager.setCurrentItem(2,false);h.rebound();h.awaitEntered(read);require(h.currentIndex==2&&h.statusView.visibility==View.GONE,"different work retained the previous image recovery hint");read.release.countDown();h.settled();h.drain();require(h.attachedHolders.get(2).galleryImageReadiness.ready,"new work failed normal image publication");});
 check("noisy does not authorize failed-image rebind",()->{SurfaceCoverProbe h=fresh();h.failed();h.feedPlayback.interruptAudio();h.rebound();require(h.showing("图片加载失败，点一下重试")&&!h.feedPlayback.allowsAutomaticAdvance(),"rebind lost current failure or undid noisy playback intent");require(h.reads==1&&h.activePlayer==null,"rebind started playback or silently retried after interruption");});
 check("completed retry cannot revive failure after noisy rebind",()->{SurfaceCoverProbe h=fresh();h.failed();h.plan(new Bitmap(),false,false);h.tap();h.settled();h.drain();h.feedPlayback.interruptAudio();h.rebound();require(h.state().ready&&!h.state().failed&&h.statusView.visibility==View.GONE&&!h.feedPlayback.allowsAutomaticAdvance(),"completed failure hint or playback intent revived after interruption");});
 check("old retry cannot hide replacement retry status",()->{SurfaceCoverProbe h=fresh();h.failed();ImageRead old=h.plan(new Bitmap(),false,true);h.tap();h.awaitEntered(old);h.replaceImage("http://fixture/replacement-failed");ImageRead replacement=h.plan(null,false,false);h.rebound();h.awaitEntered(replacement);long until=System.nanoTime()+3_000_000_000L;while(h.frameLoading.activeCount()>1&&System.nanoTime()<until)Thread.yield();h.drain();require(h.state().failed,"replacement failure did not settle");ImageRead current=h.plan(new Bitmap(),false,true);h.tap();h.awaitEntered(current);h.rebound();old.release.countDown();until=System.nanoTime()+3_000_000_000L;while(h.frameLoading.activeCount()>1&&System.nanoTime()<until)Thread.yield();h.drain();require(h.showing("正在重试图片")&&h.state().retrying,"old-source success hid the replacement retry status");current.release.countDown();h.settled();h.drain();require(h.state().ready&&h.statusView.visibility==View.GONE,"current retry could not finish after old source settlement");});
 require(args.length!=0||checks==8,"missing gallery rebind cases: "+checks);System.out.println("native-gallery-rebind: "+checks+" actual full-playAt/image/status owner cases passed");
 }finally{disposeFixtures();}}
}`;
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-gallery-rebind-"));
const javaHome=process.env.JAVA_HOME||"C:/Program Files/Android/openjdk/jdk-21.0.8",exe=name=>path.join(javaHome,"bin",name+".exe");
function run(label,implementation=java,selection=[]){const folder=path.join(temporary,label);fs.mkdirSync(folder,{recursive:true});const sources=[];for(const[relative,value]of Object.entries({...doubles,[host]:implementation})){const target=path.join(folder,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);sources.push(target);}sources.push(path.join(native,"NativeShortVideoFeedPlayback.java"),path.join(native,"NativeShortVideoFrameLoader.java"));const compiled=spawnSync(exe("javac"),["-encoding","UTF-8","-d",folder,...sources],{encoding:"utf8",timeout:30000});assert.equal(compiled.status,0,compiled.stderr);return spawnSync(exe("java"),["-cp",folder,"local.fanhao.library.SurfaceCoverProbe",...selection],{encoding:"utf8",timeout:20000});}
try{const actual=run("actual");assert.equal(actual.status,0,actual.stderr);process.stdout.write(actual.stdout);
 const unconditional=java.replace("if (!restoreGalleryPlaybackStatus()) hideStatus();","hideStatus();");assert.notEqual(unconditional,java,"real rebind footer guard absent");const old=run("unconditional-hide",unconditional,["same-page failed image keeps recovery status"]);assert.notEqual(old.status,0);assert.match(old.stderr,/real playAt hid the failed image recovery status/);console.log("native-gallery-rebind: unconditional footer hide negative control rejected");
}finally{const target=fs.realpathSync(temporary),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(target),parent);assert(path.basename(target).startsWith("fanhao-native-gallery-rebind-"));fs.rmSync(target,{recursive:true,force:true});}
