package local.fanhao.library;

import android.app.Application;

public final class FanHaoApplication extends Application {
  @Override public void onCreate() {
    super.onCreate();
    // Also restores sessions when Android recreates a native player before the main Activity.
    FanHaoAuthPlugin.install(this);
  }
}
