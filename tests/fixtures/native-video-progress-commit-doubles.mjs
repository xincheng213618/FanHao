// Boundary declarations only. The verifier compiles the complete production
// writer/plugin and extracted Activity methods; no platform behavior is claimed.
export const commitDoubles = {
  'android/os/Parcelable.java': 'package android.os; public interface Parcelable {}',
  'android/os/Looper.java': 'package android.os; public class Looper { public static Looper getMainLooper(){return new Looper();} }',
  'android/os/Bundle.java': `package android.os; public class Bundle extends java.util.HashMap<String,Object> { public void putString(String key,String value){put(key,value);} }`,
  'android/os/ResultReceiver.java': `package android.os;
    public class ResultReceiver implements Parcelable {
      private final Handler handler;
      public ResultReceiver(Handler handler){this.handler=handler;}
      public void send(int code,Bundle data){handler.post(()->onReceiveResult(code,data));}
      protected void onReceiveResult(int code,Bundle data){}
    }`,
  'android/app/Activity.java': `package android.app; import android.content.Intent;
    public class Activity {
      public static final int RESULT_OK=-1, RESULT_CANCELED=0;
      public Intent started; public int starts; public boolean failStart;
      public void startActivity(Intent intent){if(failStart)throw new IllegalStateException("synthetic launch failure");started=intent;starts++;}
      public void overridePendingTransition(int enter,int exit){}
    }`,
  'android/content/Intent.java': `package android.content;
    public class Intent {
      public final java.util.Map<String,Object> extras=new java.util.HashMap<>();
      public Intent(android.app.Activity activity,Class<?> target){if(activity==null)throw new NullPointerException("detached");}
      public Intent putExtra(String key,Object value){extras.put(key,value);return this;}
      public String getStringExtra(String key){return (String)extras.get(key);}
      @SuppressWarnings("unchecked") public <T> T getParcelableExtra(String key){return (T)extras.get(key);}
    }`,
  'android/util/Log.java': `package android.util; public class Log { public static int i(String t,String m){return 0;} public static int w(String t,String m,Throwable e){return 0;} }`,
  'androidx/annotation/OptIn.java': 'package androidx.annotation; public @interface OptIn { Class<?>[] markerClass(); }',
  'androidx/media3/common/util/UnstableApi.java': 'package androidx.media3.common.util; public @interface UnstableApi {}',
  'androidx/activity/result/ActivityResult.java': `package androidx.activity.result; public class ActivityResult { public int getResultCode(){return 0;} public android.content.Intent getData(){return null;} }`,
  'com/getcapacitor/JSObject.java': `package com.getcapacitor; public class JSObject extends java.util.HashMap<String,Object> {}`,
  'com/getcapacitor/PluginMethod.java': 'package com.getcapacitor; public @interface PluginMethod {}',
  'com/getcapacitor/annotation/ActivityCallback.java': 'package com.getcapacitor.annotation; public @interface ActivityCallback {}',
  'com/getcapacitor/annotation/CapacitorPlugin.java': 'package com.getcapacitor.annotation; public @interface CapacitorPlugin { String name(); }',
  'com/getcapacitor/PluginCall.java': `package com.getcapacitor;
    public class PluginCall {
      public final java.util.Map<String,Object> values=new java.util.HashMap<>();
      public JSObject result; public String error; public int resolves,rejects;
      public String getString(String key){return (String)values.get(key);}
      public Double getDouble(String key,double fallback){return values.containsKey(key)?((Number)values.get(key)).doubleValue():fallback;}
      public Integer getInt(String key,int fallback){return values.containsKey(key)?((Number)values.get(key)).intValue():fallback;}
      public Boolean getBoolean(String key,boolean fallback){return values.containsKey(key)?(Boolean)values.get(key):fallback;}
      public void resolve(JSObject result){this.result=result;resolves++;}
      public void reject(String error){this.error=error;rejects++;}
      public void reject(String error,Exception exception){reject(error);}
    }`,
  'com/getcapacitor/Plugin.java': `package com.getcapacitor;
    public class Plugin {
      public android.app.Activity activity=new android.app.Activity();
      public final java.util.ArrayDeque<Runnable> tasks=new java.util.ArrayDeque<>();
      public final java.util.List<JSObject> events=new java.util.ArrayList<>();
      public boolean executing,failExecute,failNotify; public int destroyCalls;
      public android.app.Activity getActivity(){return activity;}
      public void execute(Runnable task){if(failExecute)throw new IllegalStateException("closed bridge");tasks.add(task);}
      public void drainTasks(){while(!tasks.isEmpty()){executing=true;try{tasks.removeFirst().run();}finally{executing=false;}}}
      protected void notifyListeners(String event,JSObject data,boolean retain){
        if(!executing)throw new AssertionError("notify must run on Capacitor task handler");
        if(retain)throw new AssertionError("receipts must not be retained");
        if(!"progressCommitted".equals(event))throw new AssertionError("wrong event");
        if(failNotify)throw new IllegalStateException("listener unavailable");events.add(data);
      }
      protected void handleOnDestroy(){destroyCalls++;}
      public void startActivityForResult(PluginCall call,android.content.Intent intent,String method){activity.startActivity(intent);}
    }`,
  'org/json/JSONArray.java': 'package org.json; public class JSONArray {}',
  'local/fanhao/library/NativePlayerActivity.java': `package local.fanhao.library; public class NativePlayerActivity {
    public static final String EXTRA_URL="url",EXTRA_FALLBACK_URL="fallbackUrl",EXTRA_TITLE="title",EXTRA_SUBTITLE="subtitle",EXTRA_PROGRESS_URL="progressUrl",EXTRA_WORK_ID="workId",EXTRA_VIDEO_ID="videoId",EXTRA_MODE="mode",EXTRA_POSITION="position",EXTRA_DURATION="duration",EXTRA_PROGRESS_RECEIVER="progressReceiver",EXTRA_PROGRESS_AUTH_TOKEN="progressAuthToken";
  }`,
  'local/fanhao/library/NativeShortVideoActivity.java': `package local.fanhao.library; public class NativeShortVideoActivity {
    public static final String EXTRA_VIDEOS_JSON="videos",EXTRA_START_INDEX="startIndex",EXTRA_START_ID="startId",EXTRA_BASE_URL="baseUrl",EXTRA_FEED_URL="feedUrl",EXTRA_NEXT_OFFSET="nextOffset",EXTRA_NEXT_CURSOR="nextCursor",EXTRA_HAS_MORE="hasMore",EXTRA_OPEN_AUTHOR_PANEL="openAuthorPanel";
  }`,
  'local/fanhao/library/ShortVideoFeedContract.java': `package local.fanhao.library; public class ShortVideoFeedContract { public static java.util.List<Object> decode(String json,String base){return java.util.List.of(new Object());} }`,
  'local/fanhao/library/NativeShortVideoActionState.java': `package local.fanhao.library; public class NativeShortVideoActionState { public static String serverScope(String base){return base==null?"":base;} }`,
  'local/fanhao/library/NativeShortVideoActionResult.java': `package local.fanhao.library; public class NativeShortVideoActionResult { public static final String EXTRA_SERVER_BASE="base",EXTRA_SNAPSHOTS_JSON="snapshots"; }`,
  'local/fanhao/library/NativeShortVideoActionResultDecoder.java': `package local.fanhao.library; public class NativeShortVideoActionResultDecoder { public static org.json.JSONArray decode(String json){return new org.json.JSONArray();} }`
};
