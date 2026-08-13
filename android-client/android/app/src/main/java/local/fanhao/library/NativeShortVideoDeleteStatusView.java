package local.fanhao.library;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

final class NativeShortVideoDeleteStatusView {
  private final LinearLayout banner;
  private final TextView messageView;
  private final TextView actionView;

  NativeShortVideoDeleteStatusView(Context context, FrameLayout root) {
    banner = new LinearLayout(context);
    banner.setOrientation(LinearLayout.HORIZONTAL);
    banner.setGravity(Gravity.CENTER_VERTICAL);
    banner.setPadding(dp(context, 16), dp(context, 12), dp(context, 12), dp(context, 12));
    GradientDrawable background = new GradientDrawable();
    background.setColor(0xEE20232B);
    background.setCornerRadius(dp(context, 14));
    background.setStroke(dp(context, 1), 0x44FFFFFF);
    banner.setBackground(background);
    banner.setElevation(dp(context, 8));

    messageView = new TextView(context);
    messageView.setTextColor(Color.WHITE);
    messageView.setTextSize(13);
    messageView.setLineSpacing(0, 1.12f);
    messageView.setGravity(Gravity.LEFT | Gravity.CENTER_VERTICAL);
    banner.addView(messageView, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

    actionView = new TextView(context);
    actionView.setTextColor(0xFF8CC8FF);
    actionView.setTextSize(13);
    actionView.setTypeface(Typeface.DEFAULT_BOLD);
    actionView.setGravity(Gravity.CENTER);
    actionView.setPadding(dp(context, 14), dp(context, 10), dp(context, 8), dp(context, 10));
    banner.addView(actionView, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.BOTTOM
    );
    params.leftMargin = dp(context, 14);
    params.rightMargin = dp(context, 14);
    params.bottomMargin = dp(context, 24);
    root.addView(banner, params);
    hide();
  }

  void show(String message, String actionLabel, Runnable action) {
    String safeMessage = message == null ? "" : message;
    String safeLabel = actionLabel == null ? "" : actionLabel.trim();
    messageView.setText(safeMessage);
    actionView.setText(safeLabel);
    actionView.setVisibility(safeLabel.length() > 0 ? View.VISIBLE : View.GONE);
    actionView.setEnabled(action != null);
    actionView.setAlpha(action != null ? 1f : 0.58f);
    actionView.setOnClickListener(action == null ? null : view -> action.run());
    banner.setContentDescription(safeLabel.length() > 0 ? safeMessage + "，" + safeLabel : safeMessage);
    banner.setVisibility(View.VISIBLE);
  }

  void hide() {
    actionView.setOnClickListener(null);
    banner.setVisibility(View.GONE);
  }

  private static int dp(Context context, int value) {
    return Math.round(value * context.getResources().getDisplayMetrics().density);
  }
}
