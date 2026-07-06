package local.fanhao.library;

import android.graphics.Color;
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
}
