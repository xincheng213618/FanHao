package local.fanhao.library;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.os.BatteryManager;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

@CapacitorPlugin(name = "FanHaoSystem")
public class FanHaoSystemPlugin extends Plugin {
  @PluginMethod
  public void setImmersive(PluginCall call) {
    boolean immersive = call.getBoolean("immersive", false);
    getActivity().runOnUiThread(() -> {
      if (immersive) hideSystemBars();
      else showSystemBars();

      JSObject result = new JSObject();
      result.put("immersive", immersive);
      call.resolve(result);
    });
  }

  @PluginMethod
  public void getStatusInfo(PluginCall call) {
    JSObject result = new JSObject();
    int battery = getBatteryPercent();
    result.put("time", new SimpleDateFormat("MM/dd HH:mm", Locale.CHINA).format(new Date()));
    if (battery >= 0) result.put("battery", battery);
    result.put("charging", isCharging());
    call.resolve(result);
  }

  private void hideSystemBars() {
    Window window = getActivity().getWindow();
    if (window == null) return;

    window.setStatusBarColor(Color.BLACK);
    window.setNavigationBarColor(Color.BLACK);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      WindowManager.LayoutParams attrs = window.getAttributes();
      attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      window.setAttributes(attrs);
    }
    View decor = window.getDecorView();

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(false);
      WindowInsetsController controller = window.getInsetsController();
      if (controller != null) {
        controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
      decor.setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_FULLSCREEN
          | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
          | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
          | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
          | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
          | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
      );
    }
  }

  private void showSystemBars() {
    Window window = getActivity().getWindow();
    if (window == null) return;

    window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
    window.setStatusBarColor(Color.rgb(246, 247, 249));
    window.setNavigationBarColor(Color.WHITE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      WindowManager.LayoutParams attrs = window.getAttributes();
      attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
      window.setAttributes(attrs);
    }
    View decor = window.getDecorView();

    int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    }
    decor.setSystemUiVisibility(flags);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(true);
      WindowInsetsController controller = window.getInsetsController();
      if (controller != null) {
        controller.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
      }
    }
  }

  private int getBatteryPercent() {
    Context context = getPluginContext();
    if (context == null) return -1;

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      BatteryManager manager = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
      if (manager != null) {
        int value = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        if (value >= 0 && value <= 100) return value;
      }
    }

    Intent status = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    if (status == null) return -1;
    int level = status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
    int scale = status.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
    if (level < 0 || scale <= 0) return -1;
    return Math.round(level * 100f / scale);
  }

  private boolean isCharging() {
    Context context = getPluginContext();
    if (context == null) return false;
    Intent status = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    if (status == null) return false;
    int plugged = status.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
    return plugged == BatteryManager.BATTERY_PLUGGED_AC
      || plugged == BatteryManager.BATTERY_PLUGGED_USB
      || plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS;
  }

  private Context getPluginContext() {
    if (getActivity() != null) return getActivity();
    return getContext();
  }
}
