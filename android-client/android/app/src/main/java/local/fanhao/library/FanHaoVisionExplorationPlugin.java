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
    JSObject result = new JSObject();
    result.put("sessions", VisionExplorationStore.listSessions(getContext()));
    call.resolve(result);
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

  private void open(PluginCall call, String mode) {
    Intent intent = new Intent(getActivity(), NativeVisionExplorationActivity.class);
    intent.putExtra(NativeVisionExplorationActivity.EXTRA_MODE, mode);
    try {
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
    if (completed) {
      result.put("sessionId", data.getStringExtra(NativeVisionExplorationActivity.RESULT_SESSION_ID));
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
