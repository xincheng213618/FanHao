package local.fanhao.library;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

final class NativeShortVideoFeedSearchController {
  interface Host {
    boolean isFeedLoading();
    String currentQuery();
    Runnable pausePlayback();
    void applySearch(String query);
    void showTransientStatus(String message);
    void hideSystemBars();
  }

  private final Activity activity;
  private final Host host;
  private View overlay;
  private Dialog dialog;

  NativeShortVideoFeedSearchController(Activity activity, Host host) {
    this.activity = activity;
    this.host = host;
  }

  void show() {
    if (host.isFeedLoading()) {
      host.showTransientStatus("作品流正在加载");
      return;
    }
    if (overlay != null) return;
    Runnable restorePlayback = host.pausePlayback();

    EditText input = new EditText(activity);
    input.setSingleLine(true);
    input.setHint("标题、文案或作者");
    input.setHintTextColor(0x99FFFFFF);
    input.setTextColor(Color.WHITE);
    input.setTextSize(15);
    input.setPadding(dp(14), 0, dp(12), 0);
    input.setBackground(roundedDrawable(0xFF2A2D37, dp(20)));
    input.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
    input.setText(host.currentQuery());
    input.setSelection(input.getText().length());

    FrameLayout nextOverlay = new FrameLayout(activity);
    nextOverlay.setClickable(true);
    nextOverlay.setFocusable(true);
    nextOverlay.setBackgroundColor(0x99000000);
    nextOverlay.setContentDescription("短视频搜索");
    nextOverlay.setTag(restorePlayback);

    LinearLayout panel = new LinearLayout(activity);
    panel.setOrientation(LinearLayout.VERTICAL);
    panel.setPadding(dp(10), dp(10), dp(10), dp(12));
    panel.setBackground(roundedDrawable(0xF21B1D25, dp(20)));
    panel.setClickable(true);
    panel.setOnClickListener(view -> {});

    LinearLayout row = new LinearLayout(activity);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER_VERTICAL);
    TextView cancel = action("取消", "关闭搜索");
    row.addView(cancel, new LinearLayout.LayoutParams(dp(54), dp(44)));
    LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(0, dp(44), 1f);
    inputParams.leftMargin = dp(4);
    inputParams.rightMargin = dp(8);
    row.addView(input, inputParams);
    TextView submit = action("搜索", "提交搜索");
    row.addView(submit, new LinearLayout.LayoutParams(dp(54), dp(44)));
    panel.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)));

    TextView helper = new TextView(activity);
    helper.setText("输入标题、文案或作者；清空后搜索可恢复全部作品");
    helper.setTextColor(0xA6FFFFFF);
    helper.setTextSize(11);
    helper.setPadding(dp(68), dp(8), dp(58), 0);
    panel.addView(helper, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.TOP
    );
    panelParams.topMargin = dp(10);
    panelParams.leftMargin = dp(8);
    panelParams.rightMargin = dp(8);
    nextOverlay.addView(panel, panelParams);

    cancel.setOnClickListener(view -> dismiss(true));
    nextOverlay.setOnClickListener(view -> dismiss(true));
    Runnable submitSearch = () -> {
      String query = input.getText().toString();
      dismiss(true);
      host.applySearch(query);
    };
    submit.setOnClickListener(view -> submitSearch.run());
    input.setOnEditorActionListener((view, actionId, event) -> {
      if (actionId != EditorInfo.IME_ACTION_SEARCH) return false;
      submitSearch.run();
      return true;
    });

    Dialog nextDialog = new Dialog(activity);
    nextDialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
    nextDialog.setContentView(nextOverlay);
    nextDialog.setCancelable(true);
    nextDialog.setOnCancelListener(ignored -> dismiss(true));
    overlay = nextOverlay;
    dialog = nextDialog;
    nextDialog.show();
    Window searchWindow = nextDialog.getWindow();
    if (searchWindow != null) {
      searchWindow.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
      searchWindow.setBackgroundDrawableResource(android.R.color.transparent);
      searchWindow.setDimAmount(0f);
      searchWindow.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
      searchWindow.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
    }
    input.requestFocus();
    input.postDelayed(() -> {
      InputMethodManager keyboard = (InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
      if (keyboard != null && overlay == nextOverlay) keyboard.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
    }, 120);
  }

  boolean dismiss(boolean restorePlayback) {
    if (overlay == null) return false;
    View closingOverlay = overlay;
    Dialog closingDialog = dialog;
    overlay = null;
    dialog = null;
    InputMethodManager keyboard = (InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
    View focused = closingOverlay.findFocus();
    if (keyboard != null && focused != null) keyboard.hideSoftInputFromWindow(focused.getWindowToken(), 0);
    if (closingDialog != null && closingDialog.isShowing()) closingDialog.dismiss();
    if (restorePlayback && closingOverlay.getTag() instanceof Runnable) ((Runnable) closingOverlay.getTag()).run();
    host.hideSystemBars();
    return true;
  }

  private TextView action(String text, String description) {
    TextView view = new TextView(activity);
    view.setText(text);
    view.setTextColor(Color.WHITE);
    view.setTextSize(13);
    view.setTypeface(Typeface.DEFAULT_BOLD);
    view.setGravity(Gravity.CENTER);
    view.setMinWidth(dp(48));
    view.setMinHeight(dp(44));
    view.setClickable(true);
    view.setFocusable(true);
    view.setContentDescription(description);
    view.setBackground(roundedDrawable(0x332A2D37, dp(16)));
    return view;
  }

  private GradientDrawable roundedDrawable(int color, int radius) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(color);
    drawable.setCornerRadius(radius);
    return drawable;
  }

  private int dp(int value) {
    return Math.round(value * activity.getResources().getDisplayMetrics().density);
  }
}
