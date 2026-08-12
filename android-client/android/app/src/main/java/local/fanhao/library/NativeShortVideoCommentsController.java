package local.fanhao.library;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Handler;
import android.text.Editable;
import android.text.InputFilter;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.animation.PathInterpolator;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;

final class NativeShortVideoCommentsController {
  interface Host {
    String apiBaseUrl();
    void beforeCommentsOpen();
    void afterCommentsClose(boolean restorePlayback);
    void setPlaybackAccessibilitySuppressed(boolean suppressed);
    void showTransientStatus(String message);
    void hideSystemBars();
    String originalVideoUrl(ShortVideoItem item);
    void openOriginalVideo(ShortVideoItem item);
  }

  private static final PathInterpolator SETTLE_INTERPOLATOR = new PathInterpolator(0.2f, 0.85f, 0.25f, 1f);

  private final Activity activity;
  private final FrameLayout rootView;
  private final ExecutorService executor;
  private final Handler mainHandler;
  private final Host host;
  private View overlay;

  NativeShortVideoCommentsController(
    Activity activity,
    FrameLayout rootView,
    ExecutorService executor,
    Handler mainHandler,
    Host host
  ) {
    this.activity = activity;
    this.rootView = rootView;
    this.executor = executor;
    this.mainHandler = mainHandler;
    this.host = host;
  }

  boolean isOpen() {
    return overlay != null;
  }

  void show(ShortVideoItem item) {
    if (item == null || overlay != null) return;
    String endpoint = commentsEndpoint(item);
    if (endpoint.length() == 0) {
      host.showTransientStatus("本地评论接口不可用");
      return;
    }
    host.beforeCommentsOpen();

    FrameLayout nextOverlay = new FrameLayout(activity);
    nextOverlay.setClickable(true);
    nextOverlay.setFocusable(true);
    nextOverlay.setBackgroundColor(0x88000000);
    nextOverlay.setContentDescription("评论面板");
    nextOverlay.setOnClickListener(view -> dismiss(true));

    LinearLayout sheet = new LinearLayout(activity);
    sheet.setOrientation(LinearLayout.VERTICAL);
    sheet.setPadding(dp(14), dp(8), dp(14), dp(12));
    sheet.setBackground(roundedDrawable(0xFF171922, dp(22)));
    sheet.setClickable(true);
    sheet.setFocusable(true);
    sheet.setOnClickListener(view -> {});

    FrameLayout dragArea = new FrameLayout(activity);
    dragArea.setClickable(true);
    dragArea.setFocusable(true);
    dragArea.setContentDescription("向下拖动关闭评论面板");
    View handle = new View(activity);
    handle.setBackground(roundedDrawable(0x66FFFFFF, dp(2)));
    FrameLayout.LayoutParams handleParams = new FrameLayout.LayoutParams(dp(42), dp(4), Gravity.TOP | Gravity.CENTER_HORIZONTAL);
    handleParams.topMargin = dp(3);
    dragArea.addView(handle, handleParams);
    installDismissGesture(dragArea, sheet, nextOverlay);
    sheet.addView(dragArea, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(20)));

    FrameLayout header = new FrameLayout(activity);
    TextView title = new TextView(activity);
    title.setText(compact(item.comments) + " 条评论");
    title.setTextColor(Color.WHITE);
    title.setTextSize(17);
    title.setTypeface(Typeface.DEFAULT_BOLD);
    title.setGravity(Gravity.CENTER);
    header.addView(title, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    ImageView close = new ImageView(activity);
    close.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
    close.setColorFilter(0xD9FFFFFF);
    close.setPadding(dp(13), dp(13), dp(13), dp(13));
    close.setContentDescription("关闭评论面板");
    close.setClickable(true);
    close.setFocusable(true);
    close.setOnClickListener(view -> dismiss(true));
    header.addView(close, new FrameLayout.LayoutParams(dp(48), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.RIGHT | Gravity.CENTER_VERTICAL));
    sheet.addView(header, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

    LinearLayout remoteCard = new LinearLayout(activity);
    remoteCard.setOrientation(LinearLayout.VERTICAL);
    remoteCard.setPadding(dp(12), dp(10), dp(12), dp(10));
    remoteCard.setBackground(roundedDrawable(0xFF222530, dp(14)));
    TextView remoteTitle = new TextView(activity);
    remoteTitle.setText(item.comments > 0 ? compact(item.comments) + " 条抖音评论未同步" : "原视频暂无评论正文");
    remoteTitle.setTextColor(Color.WHITE);
    remoteTitle.setTextSize(14);
    remoteTitle.setTypeface(Typeface.DEFAULT_BOLD);
    remoteCard.addView(remoteTitle);
    TextView remoteMessage = new TextView(activity);
    remoteMessage.setText(item.comments > 0
      ? "这里只显示保存在本机的评论；原评论请前往抖音查看。"
      : "当前资料库没有保存原视频评论正文。");
    remoteMessage.setTextColor(0xAFFFFFFF);
    remoteMessage.setTextSize(12);
    remoteMessage.setPadding(0, dp(4), 0, 0);
    remoteCard.addView(remoteMessage);
    String originalUrl = host.originalVideoUrl(item);
    if (originalUrl.length() > 0) {
      TextView openOriginal = compactSheetAction("查看原评论", false);
      openOriginal.setOnClickListener(view -> {
        dismiss(true);
        host.openOriginalVideo(item);
      });
      LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(dp(104), dp(38));
      openParams.gravity = Gravity.RIGHT;
      openParams.topMargin = dp(8);
      remoteCard.addView(openOriginal, openParams);
    }
    LinearLayout.LayoutParams remoteParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    remoteParams.bottomMargin = dp(12);
    sheet.addView(remoteCard, remoteParams);

    LinearLayout localHeader = new LinearLayout(activity);
    localHeader.setOrientation(LinearLayout.HORIZONTAL);
    localHeader.setGravity(Gravity.CENTER_VERTICAL);
    TextView localTitle = new TextView(activity);
    localTitle.setText("我的本地评论");
    localTitle.setTextColor(Color.WHITE);
    localTitle.setTextSize(15);
    localTitle.setTypeface(Typeface.DEFAULT_BOLD);
    localHeader.addView(localTitle, new LinearLayout.LayoutParams(0, dp(34), 1f));
    TextView localCount = new TextView(activity);
    localCount.setText("读取中");
    localCount.setTextColor(0x99FFFFFF);
    localCount.setTextSize(12);
    localCount.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
    localHeader.addView(localCount, new LinearLayout.LayoutParams(dp(74), dp(34)));
    sheet.addView(localHeader);

    ScrollView scroll = new ScrollView(activity);
    scroll.setFillViewport(true);
    LinearLayout commentsList = new LinearLayout(activity);
    commentsList.setOrientation(LinearLayout.VERTICAL);
    TextView loading = commentsStatus("正在读取本地评论", false);
    commentsList.addView(loading, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(86)));
    scroll.addView(commentsList, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    sheet.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

    LinearLayout privacyRow = new LinearLayout(activity);
    privacyRow.setOrientation(LinearLayout.HORIZONTAL);
    privacyRow.setGravity(Gravity.LEFT | Gravity.CENTER_VERTICAL);
    ImageView privacyIcon = new ImageView(activity);
    privacyIcon.setImageResource(android.R.drawable.checkbox_on_background);
    privacyIcon.setColorFilter(0xCC5FE1B7);
    privacyIcon.setContentDescription(null);
    privacyRow.addView(privacyIcon, new LinearLayout.LayoutParams(dp(16), dp(16)));
    TextView privacyNote = new TextView(activity);
    privacyNote.setText("只保存在这台设备，不会发布到抖音");
    privacyNote.setTextColor(0xB35FE1B7);
    privacyNote.setTextSize(11);
    privacyNote.setGravity(Gravity.LEFT | Gravity.CENTER_VERTICAL);
    LinearLayout.LayoutParams privacyNoteParams = new LinearLayout.LayoutParams(0, dp(30), 1f);
    privacyNoteParams.leftMargin = dp(6);
    privacyRow.addView(privacyNote, privacyNoteParams);
    privacyRow.setContentDescription("只保存在这台设备，不会发布到抖音");
    sheet.addView(privacyRow, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(30)));

    LinearLayout composer = new LinearLayout(activity);
    composer.setOrientation(LinearLayout.VERTICAL);
    LinearLayout composerRow = new LinearLayout(activity);
    composerRow.setOrientation(LinearLayout.HORIZONTAL);
    composerRow.setGravity(Gravity.CENTER_VERTICAL);
    TextView me = new TextView(activity);
    me.setText("我");
    me.setTextColor(Color.WHITE);
    me.setTextSize(13);
    me.setTypeface(Typeface.DEFAULT_BOLD);
    me.setGravity(Gravity.CENTER);
    me.setBackground(circleDrawable(0xFFFE2C55));
    composerRow.addView(me, new LinearLayout.LayoutParams(dp(38), dp(38)));
    EditText input = new EditText(activity);
    input.setSingleLine(true);
    input.setHint("说点什么，只保存在本机…");
    input.setHintTextColor(0x77FFFFFF);
    input.setTextColor(Color.WHITE);
    input.setTextSize(14);
    input.setPadding(dp(13), 0, dp(10), 0);
    input.setBackground(roundedDrawable(0xFF252832, dp(20)));
    input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(500) });
    input.setImeOptions(EditorInfo.IME_ACTION_SEND);
    LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(0, dp(42), 1f);
    inputParams.leftMargin = dp(8);
    inputParams.rightMargin = dp(8);
    composerRow.addView(input, inputParams);
    TextView send = compactSheetAction("发送", true);
    send.setEnabled(false);
    send.setAlpha(0.45f);
    composerRow.addView(send, new LinearLayout.LayoutParams(dp(64), dp(42)));
    composer.addView(composerRow);
    TextView composerNotice = new TextView(activity);
    composerNotice.setText("");
    composerNotice.setTextColor(0xFFFF8A9E);
    composerNotice.setTextSize(11);
    composerNotice.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
    composer.addView(composerNotice, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(22)));
    sheet.addView(composer, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64)));

    Runnable sendComment = () -> createLocalComment(item, endpoint, nextOverlay, input, send, composerNotice, commentsList, localCount);
    send.setOnClickListener(view -> sendComment.run());
    input.setOnEditorActionListener((view, actionId, event) -> {
      if (actionId != EditorInfo.IME_ACTION_SEND) return false;
      sendComment.run();
      return true;
    });
    input.addTextChangedListener(new TextWatcher() {
      @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
      @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
        boolean ready = value != null && value.toString().trim().length() > 0;
        send.setEnabled(ready);
        send.setAlpha(ready ? 1f : 0.45f);
        if (ready) composerNotice.setText("");
      }
      @Override public void afterTextChanged(Editable value) {}
    });

    int sheetHeight = Math.round(activity.getResources().getDisplayMetrics().heightPixels * 0.82f);
    nextOverlay.addView(sheet, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      sheetHeight,
      Gravity.BOTTOM
    ));
    overlay = nextOverlay;
    host.setPlaybackAccessibilitySuppressed(true);
    rootView.addView(nextOverlay, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    sheet.setTranslationY(sheetHeight);
    sheet.animate().translationY(0f).setDuration(220).setInterpolator(SETTLE_INTERPOLATOR).start();
    sheet.post(() -> sheet.announceForAccessibility("评论面板已打开，" + compact(item.comments) + " 条原视频评论"));
    loadLocalComments(item, endpoint, nextOverlay, commentsList, localCount);
    host.hideSystemBars();
  }

  boolean dismiss(boolean restorePlayback) {
    if (overlay == null) return false;
    View dismissed = overlay;
    overlay = null;
    InputMethodManager keyboard = (InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
    if (keyboard != null) keyboard.hideSoftInputFromWindow(dismissed.getWindowToken(), 0);
    rootView.removeView(dismissed);
    host.setPlaybackAccessibilitySuppressed(false);
    host.afterCommentsClose(restorePlayback);
    host.hideSystemBars();
    return true;
  }

  private TextView compactSheetAction(String label, boolean accent) {
    TextView view = new TextView(activity);
    view.setText(label);
    view.setTextColor(Color.WHITE);
    view.setTextSize(12);
    view.setTypeface(Typeface.DEFAULT_BOLD);
    view.setGravity(Gravity.CENTER);
    view.setBackground(roundedDrawable(accent ? 0xFFFE2C55 : 0xFF343744, dp(10)));
    view.setClickable(true);
    view.setFocusable(true);
    view.setContentDescription(label);
    return view;
  }

  private TextView commentsStatus(String value, boolean error) {
    TextView view = new TextView(activity);
    view.setText(value);
    view.setTextColor(error ? 0xFFFF8A9E : 0x99FFFFFF);
    view.setTextSize(13);
    view.setGravity(Gravity.CENTER);
    return view;
  }

  private void installDismissGesture(View target, View sheet, View targetOverlay) {
    final float[] startY = new float[1];
    target.setOnTouchListener((view, event) -> {
      if (event == null || overlay != targetOverlay) return true;
      int action = event.getActionMasked();
      if (action == MotionEvent.ACTION_DOWN) {
        startY[0] = event.getRawY();
        sheet.animate().cancel();
        setParentInterceptDisallowed(target, true);
        return true;
      }
      if (action == MotionEvent.ACTION_MOVE) {
        float delta = Math.max(0f, event.getRawY() - startY[0]);
        sheet.setTranslationY(delta);
        targetOverlay.setAlpha(Math.max(0.45f, 1f - delta / Math.max(1f, sheet.getHeight())));
        return true;
      }
      if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
        setParentInterceptDisallowed(target, false);
        float delta = Math.max(0f, event.getRawY() - startY[0]);
        if (action == MotionEvent.ACTION_UP && delta >= dp(96)) {
          target.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
          dismiss(true);
        } else {
          targetOverlay.setAlpha(1f);
          sheet.animate().translationY(0f).setDuration(180).setInterpolator(SETTLE_INTERPOLATOR).start();
        }
        return true;
      }
      return true;
    });
  }

  private void setParentInterceptDisallowed(View view, boolean disallow) {
    ViewParent parent = view == null ? null : view.getParent();
    while (parent != null) {
      parent.requestDisallowInterceptTouchEvent(disallow);
      parent = parent.getParent();
    }
  }

  private String commentsEndpoint(ShortVideoItem item) {
    if (item == null || item.id.length() == 0) return "";
    String base = host.apiBaseUrl() == null ? "" : host.apiBaseUrl().trim();
    if (base.length() == 0 && item.streamUrl.length() > 0) {
      try {
        Uri media = Uri.parse(item.streamUrl);
        if (media.getScheme() != null && media.getAuthority() != null) base = media.getScheme() + "://" + media.getAuthority();
      } catch (Exception ignored) {}
    }
    while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
    return base.length() == 0 ? "" : base + "/api/short-videos/" + Uri.encode(item.id) + "/comments";
  }

  private void loadLocalComments(ShortVideoItem item, String endpoint, View targetOverlay, LinearLayout list, TextView count) {
    executor.execute(() -> {
      try {
        JSONObject data = requestComments(endpoint, "GET", null);
        mainHandler.post(() -> {
          if (overlay != targetOverlay) return;
          renderLocalComments(item, endpoint, targetOverlay, list, count, data.optJSONArray("comments"));
        });
      } catch (Exception error) {
        String message = error.getMessage() == null ? "本地评论读取失败" : error.getMessage();
        mainHandler.post(() -> {
          if (overlay != targetOverlay) return;
          count.setText("读取失败");
          list.removeAllViews();
          list.addView(commentsStatus(message, true), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(96)));
        });
      }
    });
  }

  private void renderLocalComments(ShortVideoItem item, String endpoint, View targetOverlay, LinearLayout list, TextView count, @Nullable JSONArray comments) {
    if (overlay != targetOverlay) return;
    JSONArray values = comments == null ? new JSONArray() : comments;
    count.setText(values.length() + " 条");
    list.removeAllViews();
    if (values.length() == 0) {
      list.addView(commentsStatus("还没有本地评论，写下第一条只给自己看的评论。", false),
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(96)));
      return;
    }
    for (int index = 0; index < values.length(); index++) {
      JSONObject comment = values.optJSONObject(index);
      if (comment == null) continue;
      String commentId = comment.optString("id", "");
      LinearLayout card = new LinearLayout(activity);
      card.setOrientation(LinearLayout.VERTICAL);
      card.setPadding(dp(12), dp(10), dp(12), dp(10));
      card.setBackground(roundedDrawable(0xFF222530, dp(13)));
      LinearLayout meta = new LinearLayout(activity);
      meta.setOrientation(LinearLayout.HORIZONTAL);
      meta.setGravity(Gravity.CENTER_VERTICAL);
      TextView author = new TextView(activity);
      author.setText("我");
      author.setTextColor(0xFFFF6F8F);
      author.setTextSize(12);
      author.setTypeface(Typeface.DEFAULT_BOLD);
      meta.addView(author, new LinearLayout.LayoutParams(dp(34), dp(28)));
      TextView date = new TextView(activity);
      date.setText(formatLocalCommentDate(comment.optString("createdAt", "")));
      date.setTextColor(0x88FFFFFF);
      date.setTextSize(11);
      date.setGravity(Gravity.LEFT | Gravity.CENTER_VERTICAL);
      meta.addView(date, new LinearLayout.LayoutParams(0, dp(28), 1f));
      TextView delete = compactSheetAction("删除", false);
      delete.setTextColor(0xFFFF9AAD);
      delete.setOnClickListener(view -> confirmDeleteLocalComment(item, endpoint, targetOverlay, list, count, commentId));
      meta.addView(delete, new LinearLayout.LayoutParams(dp(58), dp(30)));
      card.addView(meta);
      TextView body = new TextView(activity);
      body.setText(comment.optString("body", ""));
      body.setTextColor(Color.WHITE);
      body.setTextSize(14);
      body.setLineSpacing(dp(2), 1f);
      body.setTextIsSelectable(true);
      card.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
      LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
      cardParams.bottomMargin = dp(8);
      list.addView(card, cardParams);
    }
  }

  private String formatLocalCommentDate(String value) {
    String text = value == null ? "" : value.trim();
    if (text.length() == 0) return "";
    Date parsed = null;
    for (String pattern : new String[] { "yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX" }) {
      try {
        parsed = new SimpleDateFormat(pattern, Locale.US).parse(text);
        if (parsed != null) break;
      } catch (Exception ignored) {}
    }
    if (parsed == null) {
      String fallback = text.replace('T', ' ');
      return fallback.length() >= 16 ? fallback.substring(0, 16) : fallback;
    }
    SimpleDateFormat day = new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA);
    if (day.format(parsed).equals(day.format(new Date()))) {
      return "今天 " + new SimpleDateFormat("HH:mm", Locale.CHINA).format(parsed);
    }
    return new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(parsed);
  }

  private void createLocalComment(ShortVideoItem item, String endpoint, View targetOverlay, EditText input, TextView send,
                                  TextView notice, LinearLayout list, TextView count) {
    String body = input.getText() == null ? "" : input.getText().toString().trim();
    if (body.length() == 0 || overlay != targetOverlay || !send.isEnabled()) return;
    send.setEnabled(false);
    send.setAlpha(0.55f);
    send.setText("发送中");
    notice.setText("");
    executor.execute(() -> {
      try {
        JSONObject payload = new JSONObject();
        payload.put("body", body);
        JSONObject data = requestComments(endpoint, "POST", payload);
        mainHandler.post(() -> {
          if (overlay != targetOverlay) return;
          input.setText("");
          send.setText("发送");
          renderLocalComments(item, endpoint, targetOverlay, list, count, data.optJSONArray("comments"));
          notice.setText("已保存到本机");
          notice.setTextColor(0xB35FE1B7);
          mainHandler.postDelayed(() -> {
            if (overlay == targetOverlay && "已保存到本机".contentEquals(notice.getText())) notice.setText("");
          }, 1800);
        });
      } catch (Exception error) {
        String message = error.getMessage() == null ? "本地评论保存失败" : error.getMessage();
        mainHandler.post(() -> {
          if (overlay != targetOverlay) return;
          send.setText("发送");
          send.setEnabled(true);
          send.setAlpha(1f);
          notice.setText(message);
          notice.setTextColor(0xFFFF8A9E);
        });
      }
    });
  }

  private void confirmDeleteLocalComment(ShortVideoItem item, String endpoint, View targetOverlay, LinearLayout list,
                                         TextView count, String commentId) {
    if (commentId.length() == 0 || overlay != targetOverlay) return;
    AlertDialog dialog = new AlertDialog.Builder(activity)
      .setTitle("删除这条本地评论？")
      .setMessage("只会删除保存在这台设备上的评论。")
      .setNegativeButton("取消", null)
      .setPositiveButton("删除", (ignored, which) -> deleteLocalComment(item, endpoint, targetOverlay, list, count, commentId))
      .create();
    dialog.setOnDismissListener(ignored -> host.hideSystemBars());
    dialog.show();
  }

  private void deleteLocalComment(ShortVideoItem item, String endpoint, View targetOverlay, LinearLayout list,
                                  TextView count, String commentId) {
    executor.execute(() -> {
      try {
        JSONObject data = requestComments(endpoint + "/" + Uri.encode(commentId), "DELETE", null);
        mainHandler.post(() -> {
          if (overlay != targetOverlay) return;
          renderLocalComments(item, endpoint, targetOverlay, list, count, data.optJSONArray("comments"));
        });
      } catch (Exception error) {
        String message = error.getMessage() == null ? "本地评论删除失败" : error.getMessage();
        mainHandler.post(() -> {
          if (overlay == targetOverlay) host.showTransientStatus(message);
        });
      }
    });
  }

  private JSONObject requestComments(String endpoint, String method, @Nullable JSONObject payload) throws Exception {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(endpoint).openConnection();
      connection.setRequestMethod(method);
      connection.setConnectTimeout(8000);
      connection.setReadTimeout(12000);
      connection.setRequestProperty("Accept", "application/json");
      if (payload != null) {
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setFixedLengthStreamingMode(bytes.length);
        connection.getOutputStream().write(bytes);
      }
      int status = connection.getResponseCode();
      String body = NativeShortVideoHttpResponse.readUtf8(connection, status >= 200 && status < 300);
      JSONObject data = body.length() > 0 ? new JSONObject(body) : new JSONObject();
      if (status < 200 || status >= 300) {
        String message = data.optString("error", "");
        throw new Exception(message.length() > 0 ? message : "本地评论请求失败");
      }
      return data;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private int dp(int value) {
    return Math.round(value * activity.getResources().getDisplayMetrics().density);
  }

  private String compact(long value) {
    if (value >= 10000) return String.format(Locale.CHINA, "%.1f万", value / 10000.0);
    return String.valueOf(value);
  }

  private GradientDrawable circleDrawable(int color) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setShape(GradientDrawable.OVAL);
    drawable.setColor(color);
    return drawable;
  }

  private GradientDrawable roundedDrawable(int color, int radius) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(color);
    drawable.setCornerRadius(radius);
    return drawable;
  }
}
