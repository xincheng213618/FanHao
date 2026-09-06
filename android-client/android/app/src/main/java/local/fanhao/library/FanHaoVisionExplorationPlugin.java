package local.fanhao.library;

import android.app.Activity;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "FanHaoVisionExploration")
public class FanHaoVisionExplorationPlugin extends Plugin {
  @PluginMethod
  public void startDocumentScan(PluginCall call) {
    open(call, NativeVisionExplorationActivity.MODE_DOCUMENT);
  }

  @PluginMethod
  public void startFaceVerification(PluginCall call) {
    open(call, NativeVisionExplorationActivity.MODE_FACE);
  }

  @PluginMethod
  public void listSessions(PluginCall call) {
    try {
      JSObject result = new JSObject();
      result.put("sessions", VisionExplorationStore.listSessions(getContext()));
      call.resolve(result);
    } catch (Exception error) {
      call.reject("无法读取本地探索记录", error);
    }
  }

  @PluginMethod
  public void deleteSession(PluginCall call) {
    String sessionId = call.getString("sessionId");
    try {
      boolean deleted = VisionExplorationStore.deleteSession(getContext(), sessionId);
      JSObject result = new JSObject();
      result.put("deleted", deleted);
      call.resolve(result);
    } catch (Exception error) {
      call.reject("无法删除本地探索记录", error);
    }
  }

  @PluginMethod
  public void openSession(PluginCall call) {
    String sessionId = call.getString("sessionId");
    try {
      VisionExplorationStore.getCompletedSession(getContext(), sessionId);
      Intent intent = new Intent(getActivity(), NativeVisionExplorationActivity.class);
      intent.putExtra(NativeVisionExplorationActivity.EXTRA_MODE, NativeVisionExplorationActivity.MODE_REVIEW);
      intent.putExtra(NativeVisionExplorationActivity.EXTRA_SESSION_ID, sessionId);
      startActivityForResult(call, intent, "visionArchiveResult");
    } catch (Exception error) {
      call.reject("无法打开本地探索记录", error);
    }
  }

  @PluginMethod
  public void resumeSession(PluginCall call) {
    String sessionId = call.getString("sessionId");
    try {
      JSONObject manifest = VisionExplorationStore.getRecoverableSession(getContext(), sessionId);
      String mode = "face-verification".equals(manifest.optString("kind", ""))
        ? NativeVisionExplorationActivity.MODE_FACE : NativeVisionExplorationActivity.MODE_DOCUMENT;
      Intent intent = new Intent(getActivity(), NativeVisionExplorationActivity.class);
      intent.putExtra(NativeVisionExplorationActivity.EXTRA_MODE, mode);
      intent.putExtra(NativeVisionExplorationActivity.EXTRA_SESSION_ID, sessionId);
      startActivityForResult(call, intent, "visionExplorationResult");
    } catch (Exception error) {
      call.reject("无法继续本地探索记录", error);
    }
  }

  private void open(PluginCall call, String mode) {
    try {
      Intent intent = new Intent(getActivity(), NativeVisionExplorationActivity.class);
      intent.putExtra(NativeVisionExplorationActivity.EXTRA_MODE, mode);
      startActivityForResult(call, intent, "visionExplorationResult");
    } catch (Exception error) {
      call.reject("无法打开视觉探索工具", error);
    }
  }

  @ActivityCallback
  private void visionExplorationResult(PluginCall call, ActivityResult activityResult) {
    if (call == null) return;
    Intent data = activityResult == null ? null : activityResult.getData();
    boolean completed = activityResult != null
      && activityResult.getResultCode() == Activity.RESULT_OK
      && data != null;
    JSObject result = new JSObject();
    result.put("opened", true);
    result.put("canceled", !completed);
    result.put("preserved", data != null && data.getBooleanExtra(NativeVisionExplorationActivity.RESULT_PRESERVED, false));
    result.put("discarded", data != null && data.getBooleanExtra(NativeVisionExplorationActivity.RESULT_DISCARDED, false));
    String sessionId = data == null ? null : data.getStringExtra(NativeVisionExplorationActivity.RESULT_SESSION_ID);
    if (sessionId != null && !sessionId.isEmpty()) result.put("sessionId", sessionId);
    if (completed) {
      result.put("kind", data.getStringExtra(NativeVisionExplorationActivity.RESULT_KIND));
      result.put("challenge", data.getStringExtra(NativeVisionExplorationActivity.RESULT_CHALLENGE));
      result.put("fileCount", data.getIntExtra(NativeVisionExplorationActivity.RESULT_FILE_COUNT, 0));
    }
    call.resolve(result);
  }

  @ActivityCallback
  private void visionArchiveResult(PluginCall call, ActivityResult activityResult) {
    if (call == null) return;
    Intent data = activityResult == null ? null : activityResult.getData();
    JSObject result = new JSObject();
    result.put("opened", true);
    result.put("deleted", data != null && data.getBooleanExtra(NativeVisionExplorationActivity.RESULT_DELETED, false));
    call.resolve(result);
  }
}
