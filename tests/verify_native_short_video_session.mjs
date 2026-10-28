import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { commitDoubles } from "./fixtures/native-video-progress-commit-doubles.mjs";

// Actual Plugin -> AndroidX SavedStateRegistry -> private session/checkpoint ->
// actual Native startup. Two independent JVMs discard every old static owner.
// Android delivery/Bundle/Activity UI are boundaries; no ATMS or Parcel claim.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "android-client/android/app/src/main/java/local/fanhao/library");
const gradle = process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle");
function artifact(group, name, extension) {
  const folder = path.join(gradle, "caches/modules-2/files-2.1", group, name);
  if (!fs.existsSync(folder)) return "";
  for (const version of fs.readdirSync(folder).sort((a,b) => b.localeCompare(a,undefined,{numeric:true}))) for (const hash of fs.readdirSync(path.join(folder, version))) {
    const candidate = path.join(folder, version, hash);
    if (fs.statSync(candidate).isDirectory()) for (const file of fs.readdirSync(candidate)) if (file.endsWith(extension)) return path.join(candidate, file);
  }
  return "";
}
function zipEntry(archive, wanted) {
  const bytes = fs.readFileSync(archive), end = bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])); assert(end >= 0);
  let cursor = bytes.readUInt32LE(end + 16);
  for (let i=0; i<bytes.readUInt16LE(end+10); i++) {
    assert.equal(bytes.readUInt32LE(cursor),0x02014b50);
    const method=bytes.readUInt16LE(cursor+10),size=bytes.readUInt32LE(cursor+20),length=bytes.readUInt16LE(cursor+28),local=bytes.readUInt32LE(cursor+42);
    if(bytes.subarray(cursor+46,cursor+46+length).toString("utf8")===wanted){const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);const value=bytes.subarray(start,start+size);assert(method===0||method===8);return method===8?inflateRawSync(value):value;}
    cursor+=46+length+bytes.readUInt16LE(cursor+30)+bytes.readUInt16LE(cursor+32);
  }
  throw Error(`missing ${wanted}`);
}
const checkpointFile = new URL("./verify_native_short_video_checkpoint.mjs", import.meta.url);
const checkpointText = fs.readFileSync(checkpointFile,"utf8").replace(/\r\n/g,"\n");
const prefix = checkpointText.slice(checkpointText.indexOf("const root = "), checkpointText.indexOf("const temporary = fs.mkdtempSync"))
  .replaceAll("import.meta.url",JSON.stringify(checkpointFile.href));
const seed = vm.runInNewContext(`${prefix}\n({doubles,fixture,jsonJar,member});`,{assert,fs,os,path,vm,process,URL,fileURLToPath});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),"fanhao-native-session-"));
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const tool = name => path.join(javaHome,"bin",`${name}.exe`);
const write = (folder,name,text) => {const file=path.join(folder,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
function platform() {
  const doubles={...commitDoubles,...seed.doubles};
  for(const name of Object.keys(doubles))if(name.startsWith("org/json/"))delete doubles[name];
  delete doubles["local/fanhao/library/ShortVideoFeedContract.java"];
  delete doubles["local/fanhao/library/NativeShortVideoActionState.java"];
  delete doubles["local/fanhao/library/NativeShortVideoActionResult.java"];
  delete doubles["local/fanhao/library/NativeShortVideoActionResultDecoder.java"];
  delete doubles["local/fanhao/library/NativeShortVideoRecovery.java"];
  delete doubles["androidx/savedstate/SavedStateRegistry.java"];
  const base="local/fanhao/library/NativeShortVideoPlaybackHost.java";
  doubles[base]=doubles[base].replace(/\n    class NativeShortVideoRecovery \{[\s\S]*$/,"")
    .replace("class NativeShortVideoPlaybackHost {","class NativeShortVideoPlaybackHost extends android.app.Activity {")
    .replace("void finish() { finishing = true; }", "public void finish() { finishing = true; }")
    .replace("boolean isFinishing() {","public boolean isFinishing() {");
  doubles["local/fanhao/library/NativeShortVideoCheckpointHarness.java"]=seed.fixture
    .replace("final class CheckpointHost extends", "class CheckpointHost extends")
    .replace("final class Intent {", "final class Intent extends android.content.Intent {")
    .replace("final Map<String,Object> values=new HashMap<>();", "final Map<String,Object> values=extras;")
    .replace("Intent getIntent(){", "public Intent getIntent(){")
    .replace("File getNoBackupFilesDir(){", "public File getNoBackupFilesDir(){")
    .replace("  String getStringExtra(","  public String getStringExtra(").replace("}int getIntExtra(","}public int getIntExtra(").replace("  boolean getBooleanExtra(","  public boolean getBooleanExtra(")
    .replace("final class NativeShortVideoActionPreferences{", "final class NativeShortVideoActionPreferences{String serverScope(){return \"http://fixture.invalid:29998\";}")
    .replace("  /* ACTIVITY_METHODS */", "  /* ACTIVITY_METHODS */");
  doubles["android/os/Bundle.java"]=`package android.os;import java.util.*;
public class Bundle extends HashMap<String,Object> implements java.io.Serializable {
 public static final Bundle EMPTY=new Bundle();public final Map<String,Object> values=this;public Bundle(){}public Bundle(Bundle copy){super(copy);}
 public void putString(String k,String v){put(k,v);}public String getString(String k){return (String)get(k);}public String getString(String k,String d){return get(k) instanceof String?(String)get(k):d;}
 public void putInt(String k,int v){put(k,v);}public int getInt(String k){return getInt(k,0);}public int getInt(String k,int d){return get(k) instanceof Number?((Number)get(k)).intValue():d;}
 public void putLong(String k,long v){put(k,v);}public long getLong(String k,long d){return get(k) instanceof Number?((Number)get(k)).longValue():d;}
 public void putBoolean(String k,boolean v){put(k,v);}public boolean getBoolean(String k){return getBoolean(k,false);}public boolean getBoolean(String k,boolean d){return get(k) instanceof Boolean?(Boolean)get(k):d;}
 public void putBundle(String k,Bundle v){put(k,v);}public Bundle getBundle(String k){return (Bundle)get(k);}public void putAll(Bundle b){super.putAll(b);}public void remove(String k){super.remove(k);}public boolean containsKey(String k){return super.containsKey(k);}
 public void putStringArrayList(String k,ArrayList<String> v){put(k,v);}@SuppressWarnings("unchecked")public ArrayList<String> getStringArrayList(String k){return (ArrayList<String>)get(k);}
}`;
  doubles["android/os/Handler.java"]=`package android.os;import java.util.*;public class Handler{
 public static final List<Handler> handlers=new ArrayList<>();public final ArrayList<Runnable> pending=new ArrayList<>();public Handler(){handlers.add(this);}public Handler(Looper looper){this();}
 public boolean post(Runnable r){pending.add(r);return true;}public boolean postDelayed(Runnable r,long ms){return post(r);}public void removeCallbacks(Runnable r){pending.removeIf(v->v==r);}public void runPending(){List<Runnable> batch=new ArrayList<>(pending);pending.clear();for(Runnable r:batch)r.run();}public static void pump(){for(Handler h:new ArrayList<>(handlers))h.runPending();}
}`;
  doubles["android/content/ComponentName.java"]=`package android.content;public final class ComponentName implements java.io.Serializable {final String pkg,name;public ComponentName(String p,String n){pkg=p;name=n;}public String getClassName(){return name;}public boolean equals(Object o){return o instanceof ComponentName&&pkg.equals(((ComponentName)o).pkg)&&name.equals(((ComponentName)o).name);}public int hashCode(){return name.hashCode();}public String toString(){return pkg+"/"+name;}}`;
  doubles["android/content/Intent.java"]=`package android.content;import java.util.*;import android.net.Uri;
public class Intent implements java.io.Serializable{
 public static final String ACTION_MAIN="android.intent.action.MAIN",CATEGORY_LAUNCHER="android.intent.category.LAUNCHER",ACTION_VIEW="android.intent.action.VIEW";
 public final Map<String,Object> extras=new HashMap<>();public final Set<String> categories=new HashSet<>();public String action;public Uri data;public Class<?> target;
 public Intent(){}public Intent(android.app.Activity activity,Class<?> target){this.target=target;}public Intent(Intent source){extras.putAll(source.extras);categories.addAll(source.categories);action=source.action;data=source.data;target=source.target;}
 public Intent putExtra(String k,Object v){extras.put(k,v);return this;}public Intent removeExtra(String k){extras.remove(k);return this;}public boolean hasExtra(String k){return extras.containsKey(k);}public String getStringExtra(String k){return (String)extras.get(k);}public Set<String> getCategories(){return categories.isEmpty()?null:categories;}public Object getClipData(){return null;}public ComponentName getComponent(){return target==null?null:new ComponentName("local.fanhao.library",target.getName());}
 public int getIntExtra(String k,int d){return extras.get(k) instanceof Number?((Number)extras.get(k)).intValue():d;}public boolean getBooleanExtra(String k,boolean d){return extras.get(k) instanceof Boolean?(Boolean)extras.get(k):d;}
 @SuppressWarnings("unchecked")public <T>T getParcelableExtra(String k){return (T)extras.get(k);}public Intent setAction(String a){action=a;return this;}public String getAction(){return action;}public Intent addCategory(String c){categories.add(c);return this;}public boolean hasCategory(String c){return categories.contains(c);}public Uri getData(){return data;}public Intent setData(Uri d){data=d;return this;}
}`;
  doubles["android/app/ActivityManager.java"]=`package android.app;import java.util.*;import android.content.ComponentName;public class ActivityManager{
 public static ComponentName top=new ComponentName("local.fanhao.library","local.fanhao.library.MainActivity");public static int task=41;public static boolean unavailable;
 public static class RecentTaskInfo{public int id;public ComponentName topActivity;}public static class AppTask{public RecentTaskInfo getTaskInfo(){RecentTaskInfo i=new RecentTaskInfo();i.id=task;i.topActivity=top;return i;}}
 public List<AppTask> getAppTasks(){if(unavailable)throw new SecurityException("controlled task query failure");return List.of(new AppTask());}
}`;
  doubles["android/app/Activity.java"]=`package android.app;import java.io.File;import java.util.*;import android.content.*;
public class Activity{
 public static final int RESULT_OK=-1,RESULT_CANCELED=0;public static final String ACTIVITY_SERVICE="activity";public static File directory;public int taskId=ActivityManager.task,starts,launchAttempts,resultCode;public boolean testFinishing,testDestroyed,failStart;public Intent started,resultData;public final android.os.Handler ui=new android.os.Handler();
 public final List<Intent> launches=new ArrayList<>();private Intent intent=new Intent().setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
 public Intent getIntent(){return intent;}public void setIntent(Intent i){intent=i;}public File getNoBackupFilesDir(){return directory;}public int getTaskId(){return taskId;}public Object getSystemService(String n){return new ActivityManager();}
 public ComponentName getComponentName(){return new ComponentName("local.fanhao.library","local.fanhao.library.MainActivity");}public boolean isFinishing(){return testFinishing;}public boolean isDestroyed(){return testDestroyed;}
 public void startActivity(Intent i){launchAttempts++;if(failStart)throw new IllegalStateException("controlled start failure");started=new Intent(i);launches.add(started);starts++;}public void runOnUiThread(Runnable r){ui.post(r);}public void overridePendingTransition(int enter,int exit){}public void setResult(int result,Intent data){resultCode=result;resultData=data;}public void finish(){testFinishing=true;}
}`;
  doubles["androidx/appcompat/app/AppCompatActivity.java"]=`package androidx.appcompat.app;import android.os.Bundle;import androidx.lifecycle.*;import androidx.savedstate.*;import java.util.*;
public class AppCompatActivity extends android.app.Activity implements SavedStateRegistryOwner{
 public final Life life=new Life(this);public final SavedStateRegistryController controller=SavedStateRegistryController.create(this);public final androidx.activity.result.ActivityResultRegistry results=new androidx.activity.result.ActivityResultRegistry(this);
 public void restoreRegistry(Bundle saved){controller.performAttach();controller.performRestore(saved);}public Bundle saveRegistry(){Bundle out=new Bundle();controller.performSave(out);return out;}
 public SavedStateRegistry getSavedStateRegistry(){return controller.getSavedStateRegistry();}public androidx.activity.result.ActivityResultRegistry getActivityResultRegistry(){return results;}public Lifecycle getLifecycle(){return life;}
 public static class Life extends Lifecycle{final LifecycleOwner owner;final List<LifecycleObserver> observers=new ArrayList<>();State state=State.INITIALIZED;Life(LifecycleOwner owner){this.owner=owner;}public void addObserver(LifecycleObserver o){observers.add(o);}public void removeObserver(LifecycleObserver o){observers.remove(o);}public State getCurrentState(){return state;}public void event(Event e){state=e.getTargetState();for(LifecycleObserver o:new ArrayList<>(observers))if(o instanceof LifecycleEventObserver)((LifecycleEventObserver)o).onStateChanged(owner,e);}}
}`;
  doubles["androidx/activity/result/ActivityResult.java"]=`package androidx.activity.result;public class ActivityResult{final int code;final android.content.Intent data;public ActivityResult(int c,android.content.Intent d){code=c;data=d;}public int getResultCode(){return code;}public android.content.Intent getData(){return data;}}`;
  doubles["androidx/activity/result/ActivityResultCallback.java"]=`package androidx.activity.result;public interface ActivityResultCallback<T>{void onActivityResult(T result);}`;
  doubles["androidx/activity/result/ActivityResultLauncher.java"]=`package androidx.activity.result;public abstract class ActivityResultLauncher<I>{public abstract void launch(I value);public void unregister(){}}`;
  doubles["androidx/activity/result/contract/ActivityResultContracts.java"]=`package androidx.activity.result.contract;public class ActivityResultContracts{public static class StartActivityForResult{}}`;
  doubles["androidx/activity/result/ActivityResultRegistry.java"]=`package androidx.activity.result;import java.util.*;import android.content.Intent;import androidx.lifecycle.LifecycleOwner;import androidx.activity.result.contract.ActivityResultContracts;
public class ActivityResultRegistry{final android.app.Activity owner;public final Map<String,ActivityResultCallback<ActivityResult>> callbacks=new HashMap<>();public ActivityResultRegistry(android.app.Activity a){owner=a;}public ActivityResultLauncher<Intent> register(String key,LifecycleOwner ignored,ActivityResultContracts.StartActivityForResult contract,ActivityResultCallback<ActivityResult> callback){return register(key,contract,callback);}public ActivityResultLauncher<Intent> register(String key,ActivityResultContracts.StartActivityForResult contract,ActivityResultCallback<ActivityResult> callback){if(callbacks.putIfAbsent(key,callback)!=null)throw new IllegalStateException("duplicate launcher");return new ActivityResultLauncher<>(){public void launch(Intent value){owner.startActivity(value);}};}public void deliver(String key,int code,Intent data){callbacks.get(key).onActivityResult(new ActivityResult(code,data));}}
`;
  doubles["com/getcapacitor/Plugin.java"]=`package com.getcapacitor;import android.content.Intent;import android.os.Bundle;public class Plugin{
 public androidx.appcompat.app.AppCompatActivity activity;public final java.util.List<JSObject> events=new java.util.ArrayList<>();public final java.util.List<String> eventNames=new java.util.ArrayList<>();public final java.util.ArrayDeque<Runnable> tasks=new java.util.ArrayDeque<>();public boolean executing;public androidx.appcompat.app.AppCompatActivity getActivity(){return activity;}
 public void load(){}protected void handleOnStart(){}protected void handleOnResume(){}protected void handleOnPause(){}protected void handleOnDestroy(){}protected void handleOnNewIntent(Intent value){}protected Bundle saveInstanceState(){return null;}protected void restoreState(Bundle state){}
 public void execute(Runnable r){tasks.add(r);}public void drainTasks(){while(!tasks.isEmpty()){executing=true;try{tasks.removeFirst().run();}finally{executing=false;}}}protected void notifyListeners(String name,JSObject data,boolean retain){if(!executing)throw new AssertionError("notify must enter Plugin task queue");eventNames.add(name);events.add(data);}public void startActivityForResult(PluginCall call,Intent intent,String callback){activity.startActivity(intent);}
 public void testStart(){handleOnStart();}public void testResume(){handleOnResume();}public void testPause(){handleOnPause();}public void testDestroy(){handleOnDestroy();}public void testIntent(Intent i){handleOnNewIntent(i);}
}`;
  doubles["local/fanhao/library/ServerAuthSession.java"]=`package local.fanhao.library;final class ServerAuthSession{static String captureToken(String url){return "fixture-token";}}`;
  doubles["local/fanhao/library/NativeShortVideoActivity.java"]=`package local.fanhao.library;public final class NativeShortVideoActivity extends CheckpointHost{final NativeShortVideoActionResult acknowledgedActionResult=new NativeShortVideoActionResult();public NativeShortVideoActivity(android.content.Intent source,android.os.Bundle saved,java.io.File dir){super(convert(source),dir);launch(saved);}private static Intent convert(android.content.Intent source){Intent out=new Intent();out.values.putAll(source.extras);return out;}\n${seed.member("finishWithActionResult").replace("Intent result =", "android.content.Intent result =")}\nvoid exitForTest(){finishWithActionResult();}void detachForTest(){if(nativeSession!=null)nativeSession.destroy();}}`;
  doubles["com/getcapacitor/PluginCall.java"]=doubles["com/getcapacitor/PluginCall.java"].replace('public String getCallbackId(){return "progress-fixture";}','public String callbackId="normal";public String getCallbackId(){return callbackId;}');
  doubles["local/fanhao/library/MainActivity.java"]="package local.fanhao.library;public class MainActivity extends androidx.appcompat.app.AppCompatActivity{}";
  return doubles;
}
try {
  const registryAar=artifact("androidx.savedstate","savedstate",".aar");assert(registryAar,"cached AndroidX SavedStateRegistry AAR required");
  const registryJar=write(temporary,"savedstate.jar",zipEntry(registryAar,"classes.jar"));
  const dependencies=[seed.jsonJar,registryJar,artifact("androidx.lifecycle","lifecycle-common",".jar"),artifact("androidx.arch.core","core-common",".jar"),artifact("org.jetbrains.kotlin","kotlin-stdlib",".jar")];
  assert(dependencies.every(Boolean),"existing lifecycle/arch/Kotlin runtimes required");
  const classpath=dependencies.join(path.delimiter);
  const inspected=spawnSync(tool("javap"),["-classpath",classpath,"androidx.savedstate.SavedStateRegistry","androidx.savedstate.SavedStateRegistryController"],{encoding:"utf8"});
  assert.equal(inspected.status,0,inspected.stderr);
  assert(inspected.stdout.includes("consumeRestoredStateForKey")&&inspected.stdout.includes("performRestore"),"real AndroidX restore/provider API required");
  const production=new Map(["NativeShortVideoPlaybackFallback.java","NativeShortVideoFeedPlayback.java","NativeShortVideoScreenState.java","NativeShortVideoActionSnapshots.java","ShortVideoFeedModels.java","ShortVideoFeedContract.java","ShortVideoDeleteResult.java","NativeShortVideoCheckpoint.java","NativeShortVideoFeedRequests.java","NativeShortVideoFeedPaging.java","NativeShortVideoFeedTransport.java","NativeShortVideoHttpResponse.java","NativeShortVideoActionState.java","NativeShortVideoActionResult.java","NativeShortVideoActionResultDecoder.java","NativeShortVideoSession.java","NativeShortVideoRecovery.java","FanHaoPlayerPlugin.java"].map(name=>[name,fs.readFileSync(path.join(nativeRoot,name),"utf8").replace(/\r\n/g,"\n")]));
  function compile(label,mutated=new Map(),boundaryMutation=(doubles)=>doubles){
    const folder=path.join(temporary,label);fs.mkdirSync(folder);const sources=[];
    for(const [name,text] of Object.entries(boundaryMutation(platform())))sources.push(write(folder,name,text));
    for(const [name,text] of production)sources.push(write(folder,`local/fanhao/library/${name}`,mutated.get(name)||text));
    sources.push(write(folder,"local/fanhao/library/NativeShortVideoSessionHarness.java",fs.readFileSync(path.join(root,"tests/fixtures/NativeShortVideoSessionHarness.java"),"utf8")));
    const compiled=spawnSync(tool("javac"),["-encoding","UTF-8","-cp",classpath,"-d",folder,...sources],{encoding:"utf8"});assert.equal(compiled.status,0,`${label}: actual Plugin/Native/registry compile:\n${compiled.stderr}`);return folder;
  }
  function run(folder,phase,data,mode="paused"){
    const result=spawnSync(tool("java"),["-cp",[folder,classpath].join(path.delimiter),"local.fanhao.library.NativeShortVideoSessionHarness",phase,data,mode],{encoding:"utf8",timeout:30000});
    assert.equal(result.status,0,`${phase}/${mode}:\n${result.stdout}\n${result.stderr}`);process.stdout.write(result.stdout);return result;
  }
  const actual=compile("actual");
  const modes=["paused","playing-zero","gallery","closed","new-intent","fresh","fresh-before-ui","system-native","launch-failure","destroyed","cold","result-recreated","result-stale","result-destroyed","wrong-task","missing-checkpoint","corrupt-session","unavailable-top","top-native","paused-before-dispatch","optional-session-io","rejected-live","duplicate-main","lost-after-claim","oversize-descriptor","save-failure"];
  const selected=modes.filter(mode=>!process.env.SESSION_FILTER||mode.includes(process.env.SESSION_FILTER));
  for(const mode of selected){const data=path.join(temporary,`data-${mode}`);fs.mkdirSync(data);run(actual,"save",data,mode);run(actual,"restore",data,mode);}
  console.log(`native-short-video-session: ${selected.length} actual Plugin/Registry/Native two-JVM cases passed`);
  if(!process.env.SESSION_FILTER){
    const replace=(source,before,after)=>{const updated=source.replace(before,after);assert(updated!==source,`negative control anchor: ${before}`);return updated;};
    const oracles={"missing-provider":/actual SavedStateRegistry provider/,"missing-native-publish":/actual Native save\/exit/,"missing-native-close":/actual Native save\/exit/,"missing-top-task-guard":/Main behind Native/,"missing-pending-fresh-guard":/pending fresh Plugin invocation/,"missing-plugin-task-owner":/queued restored receipt/,"missing-empty-state-guard":/failed empty Native save must invalidate/,"lost-recovery-descriptor":/resaved recovery descriptor must survive/,"missing-durable-receipt-consume":/durably consumed restored result cannot re-emit/};
    function negative(label,mode,mutations,boundaryMutation){const folder=compile(label,mutations,boundaryMutation),data=path.join(temporary,`negative-${label}`);fs.mkdirSync(data);const first=spawnSync(tool("java"),["-cp",[folder,classpath].join(path.delimiter),"local.fanhao.library.NativeShortVideoSessionHarness","save",data,mode],{encoding:"utf8",timeout:30000});const second=first.status===0?spawnSync(tool("java"),["-cp",[folder,classpath].join(path.delimiter),"local.fanhao.library.NativeShortVideoSessionHarness","restore",data,mode],{encoding:"utf8",timeout:30000}):first;assert.notEqual(second.status,0,`${label}: removing real owning behavior must fail two-JVM chain`);assert.match(second.stderr,/AssertionError/,`${label}: require behavioral rejection`);assert.match(second.stderr,oracles[label],`${label}: require its owning safety oracle`);console.log(`negative ${label}: rejected`);}
    const recovery=production.get("NativeShortVideoRecovery.java"),plugin=production.get("FanHaoPlayerPlugin.java");
    negative("missing-provider","paused",new Map([["FanHaoPlayerPlugin.java",replace(plugin,/      getActivity\(\)\.getSavedStateRegistry\(\)\.registerSavedStateProvider\(NativeShortVideoRecovery\.STATE_KEY,\n        \(\) -> [^\n]+\);/,"/* removed provider */")]]));
    negative("missing-native-publish","paused",new Map(),doubles=>{const key="local/fanhao/library/NativeShortVideoCheckpointHarness.java";doubles[key]=replace(doubles[key],/nativeSession\.publish\(scope, key\);/g,"; /* lost publish */");return doubles;});
    negative("missing-native-close","closed",new Map(),doubles=>{const key="local/fanhao/library/NativeShortVideoActivity.java";doubles[key]=replace(doubles[key],"nativeSession.close();","nativeSession.resumed();");return doubles;});
    negative("missing-top-task-guard","top-native",new Map([["NativeShortVideoRecovery.java",replace(recovery,/ \|\| !topMain\(\)/g,"")]]));
    negative("missing-pending-fresh-guard","fresh-before-ui",new Map([["NativeShortVideoRecovery.java",replace(recovery,"!externalBlocked.getAsBoolean() && ","")]]));
    negative("missing-plugin-task-owner","result-destroyed",new Map([["FanHaoPlayerPlugin.java",replace(plugin,/        if \(destroyed \|\| pendingShortFeedPlay != 0L[^\n]+\) return;/g,"/* lost delayed result owner guard */")]]));
    negative("missing-empty-state-guard","lost-after-claim",new Map(),doubles=>{const key="local/fanhao/library/NativeShortVideoCheckpointHarness.java";doubles[key]=replace(doubles[key],/nativeSession\.invalidateCheckpoint\(\);/g,"; /* lost failed auxiliary reference invalidation */");return doubles;});
    negative("lost-recovery-descriptor","oversize-descriptor",new Map(),doubles=>{const key="local/fanhao/library/NativeShortVideoCheckpointHarness.java";doubles[key]=replace(doubles[key],"if (checkpointRecovery != null) {","if (false && checkpointRecovery != null) {");return doubles;});
    negative("missing-durable-receipt-consume","result-recreated",new Map([["NativeShortVideoSession.java",replace(production.get("NativeShortVideoSession.java"),'write(record.change("", "closed", "", record.claim, record.attempts, now, record.sequence)); return true;','return true; /* lost persisted receipt consumption */')]]));
    console.log("native-short-video-session: 9 compiled provider/publish/close/top-task/fresh/task-owner/failed-state/descriptor/receipt negative controls rejected");
  }
} finally {
  const target=path.resolve(temporary);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert(path.basename(target).startsWith("fanhao-native-session-"));
  const removed=spawnSync("powershell.exe",["-NoProfile","-Command",`Remove-Item -LiteralPath '${target.replaceAll("'","''")}' -Recurse -Force`],{encoding:"utf8"});assert.equal(removed.status,0,removed.stderr);assert(!fs.existsSync(target));
}
