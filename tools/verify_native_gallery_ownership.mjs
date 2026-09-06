import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildGalleryOwnershipDoubles } from './fixtures/native-gallery-ownership-harness.mjs';

// Execute real Activity gallery binding/play/timer/frame methods and complete
// FeedPlayback, not a real RecyclerView, SurfaceFlinger or codec. No device/network.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const native=path.join(root,'android-client/android/app/src/main/java/local/fanhao/library');
const activity=fs.readFileSync(path.join(native,'NativeShortVideoActivity.java'),'utf8').replace(/\r\n/g,'\n');
const legacy=JSON.parse(fs.readFileSync(path.join(root,'tools/fixtures/native-gallery-ownership-before-fix.json'),'utf8'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fanhao-gallery-ownership-'));
const javaHome=process.env.JAVA_HOME||'C:/Program Files/Android/openjdk/jdk-21.0.8';
const exe=name=>fs.existsSync(path.join(javaHome,'bin',`${name}.exe`))?path.join(javaHome,'bin',`${name}.exe`):name;
const extract=source=>Object.fromEntries([...Object.keys(legacy.methods),'isBoundGallery'].map(name=>{
  const value=source.match(new RegExp(`  private (?:void|boolean) ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];assert(value,`missing production method: ${name}`);return [name,value];
}));
const firstFrame=activity.match(/      public void onRenderedFirstFrame\(\) \{\n        int liveIndex = playerIndex\(preparedPlayer\);[\s\S]*?\n      \}/)?.[0];
assert(firstFrame,'actual first-frame callback missing');
const verifyWiring=source=>{
  const adapter=source.slice(source.indexOf('public void onBindViewHolder('),source.indexOf('public void onViewRecycled('));
  assert(adapter.includes('attachedHolders.put(position, holder);'),'onBind must register holder identity');
  assert(adapter.includes('bindGallery(holder, item, holder.galleryIndex, 0)'),'RecyclerView binding must reach tested gallery function');
  assert(adapter.indexOf('attachedHolders.put(position, holder);')<adapter.indexOf('bindGallery(holder, item, holder.galleryIndex, 0)'),'holder identity must be registered before binding');
};
verifyWiring(activity);
for(const statement of ['attachedHolders.put(position, holder);','bindGallery(holder, item, holder.galleryIndex, 0)'])assert.throws(()=>verifyWiring(activity.replace(statement,'')),assert.AssertionError);
const verifier=fs.readFileSync(path.join(root,'tools/verify_native_short_video_playback.mjs'),'utf8');
const shared=()=>vm.runInNewContext(verifier.slice(verifier.indexOf('const doubles = '),verifier.indexOf('\ntry {'))+'\ndoubles');
function compile(name,methods,frame){
  const folder=path.join(temp,name),doubles=buildGalleryOwnershipDoubles(shared(),methods,frame),sources=[];
  for(const [file,source] of Object.entries(doubles)){const target=path.join(folder,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);sources.push(target);}
  sources.push(path.join(native,'NativeShortVideoFeedPlayback.java'));
  const result=spawnSync(exe('javac'),['-encoding','UTF-8','-d',folder,...sources],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,`compile ${name}:\n${result.stderr}`);return folder;
}
function run(folder,name='all'){return spawnSync(exe('java'),['-cp',folder,'local.fanhao.library.SurfaceCoverProbe',name],{encoding:'utf8',timeout:10000});}
function rejects(folder,name){const result=run(folder,name);assert.equal(result.status,1,`negative must exit on assertion: ${name}\n${result.error||''}\n${result.stderr}`);assert.match(result.stderr,/AssertionError/);assert(result.stderr.includes(name),`negative missed specific oracle ${name}`);}
try{
  const methods=extract(activity),current=compile('current',methods,firstFrame),passed=run(current);assert.equal(passed.status,0,passed.stderr);process.stdout.write(passed.stdout);
  const before=compile('before',legacy.methods,legacy.firstFrame);
  const oldCases=['offscreen_segment_preserves_owner','first_frame_remains_uncovered','offscreen_video_static_preview_only','offscreen_image_preserves_timer','offscreen_binding_preserves_restore_intent','retired_holder_segment_rejected','old_timer_cannot_consume_new_timer','retired_bitmap_does_not_paint'];
  for(const name of oldCases)rejects(before,name);
  const mutations=[
    ['playGallerySegment','if (!isBoundGallery(holder, item) || holder.index != currentIndex) return;','','offscreen_segment_preserves_owner'],
    ['isBoundGallery','attachedHolders.get(holder.index) == holder && ','','retired_holder_segment_rejected'],
    ['isBoundGallery',' && videos.get(holder.index) == item','','replaced_item_segment_rejected'],
    ['bindGallery','if (currentGallery) cancelGalleryAutoAdvance();','cancelGalleryAutoAdvance();','offscreen_image_preserves_timer'],
    ['bindGallery','if (currentGallery) feedPlayback.selectGalleryMedia(item.id, galleryIndex);','feedPlayback.selectGalleryMedia(item.id, galleryIndex);','offscreen_binding_preserves_restore_intent'],
    ['scheduleGalleryAutoAdvance','if (galleryAutoAdvanceRunnable != this) return;','','old_timer_cannot_consume_new_timer'],
    ['scheduleGalleryAutoAdvance','liveHolder != holder || ','','timer_cannot_advance_recycled_holder'],
    ['scheduleGalleryAutoAdvance','!isBoundGallery(holder, item) || holder.index != currentIndex','holder == null || holder.index != currentIndex','retired_schedule_cannot_replace_timer'],
    ['showGalleryBitmap','!isBoundGallery(holder, item) || ','','retired_bitmap_does_not_paint']
  ];
  for(const [index,[method,from,to,oracle]] of mutations.entries()){
    assert(methods[method].includes(from),`mutation anchor ${index}`);const mutated={...methods,[method]:methods[method].replace(from,to)};rejects(compile(`mutant-${index}`,mutated,firstFrame),oracle);
  }
  console.log(`native-gallery-ownership: ${oldCases.length} frozen-88 negative controls, ${mutations.length} compiled behavior mutants and 2 RecyclerView wiring mutants rejected`);
}finally{
  const resolved=fs.realpathSync(temp);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('fanhao-gallery-ownership-'));
  const clean=spawnSync('powershell.exe',['-NoProfile','-Command',`Remove-Item -LiteralPath '${resolved.replace(/'/g,"''")}' -Recurse -Force`],{encoding:'utf8',timeout:10000});assert.equal(clean.status,0,clean.stderr);
}
