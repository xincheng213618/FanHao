package local.fanhao.library;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.media3.ui.PlayerView;
import androidx.recyclerview.widget.RecyclerView;

final class NativeShortVideoPageView {
  private NativeShortVideoPageView() {}

  static ShortVideoHolder create(
    @NonNull ViewGroup parent,
    @NonNull LayoutInflater inflater,
    int resizeMode,
    @NonNull View.OnTouchListener progressTouchListener
  ) {
    Context context = parent.getContext();
    FrameLayout root = new FrameLayout(parent.getContext());
    root.setBackgroundColor(Color.BLACK);
    root.setClipChildren(false);
    root.setClipToPadding(false);
    root.setClickable(true);
    root.setFocusable(true);
    root.setLayoutParams(new ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    FrameLayout stage = new FrameLayout(parent.getContext());
    stage.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    root.addView(stage, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    ImageView videoBackdrop = new ImageView(parent.getContext());
    videoBackdrop.setScaleType(ImageView.ScaleType.CENTER_CROP);
    videoBackdrop.setBackgroundColor(Color.BLACK);
    videoBackdrop.setAlpha(0.62f);
    videoBackdrop.setScaleX(1.08f);
    videoBackdrop.setScaleY(1.08f);
    videoBackdrop.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    videoBackdrop.setVisibility(View.GONE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      videoBackdrop.setRenderEffect(RenderEffect.createBlurEffect(24f, 24f, Shader.TileMode.CLAMP));
    }
    stage.addView(videoBackdrop, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    FrameLayout galleryCurrentLayer = new FrameLayout(parent.getContext());
    stage.addView(galleryCurrentLayer, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    PlayerView galleryVideo = (PlayerView) inflater.inflate(R.layout.native_short_player_view, galleryCurrentLayer, false);
    galleryVideo.setClickable(false);
    galleryVideo.setFocusable(false);
    galleryVideo.setEnabled(false);
    galleryVideo.setUseController(false);
    galleryVideo.setKeepContentOnPlayerReset(false);
    galleryVideo.setResizeMode(resizeMode);
    galleryVideo.setVisibility(View.GONE);
    galleryCurrentLayer.addView(galleryVideo, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    ImageView cover = new ImageView(parent.getContext());
    cover.setScaleType(ImageView.ScaleType.CENTER_CROP);
    cover.setBackgroundColor(Color.BLACK);
    cover.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    galleryCurrentLayer.addView(cover, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    FrameLayout galleryPreviewLayer = new FrameLayout(parent.getContext());
    galleryPreviewLayer.setVisibility(View.GONE);
    stage.addView(galleryPreviewLayer, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    ImageView galleryPreview = new ImageView(parent.getContext());
    galleryPreview.setScaleType(ImageView.ScaleType.FIT_CENTER);
    galleryPreview.setBackgroundColor(Color.BLACK);
    galleryPreview.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    galleryPreviewLayer.addView(galleryPreview, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    FrameLayout gestureLayer = new FrameLayout(parent.getContext());
    gestureLayer.setClickable(true);
    gestureLayer.setFocusable(false);
    gestureLayer.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    root.addView(gestureLayer, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    ImageView playIndicator = new ImageView(parent.getContext());
    playIndicator.setImageResource(R.drawable.ic_short_play);
    playIndicator.setImageTintList(ColorStateList.valueOf(Color.WHITE));
    playIndicator.setPadding(dp(context, 20), dp(context, 20), dp(context, 18), dp(context, 20));
    playIndicator.setBackground(circleDrawable(0x73000000));
    playIndicator.setClickable(false);
    playIndicator.setFocusable(false);
    playIndicator.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    playIndicator.setVisibility(View.GONE);
    root.addView(playIndicator, new FrameLayout.LayoutParams(dp(context, 72), dp(context, 72), Gravity.CENTER));

    LinearLayout galleryProgress = new LinearLayout(parent.getContext());
    galleryProgress.setOrientation(LinearLayout.HORIZONTAL);
    galleryProgress.setGravity(Gravity.CENTER_VERTICAL);
    galleryProgress.setVisibility(View.GONE);
    galleryProgress.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    FrameLayout.LayoutParams galleryProgressParams = new FrameLayout.LayoutParams(
      dp(context, 286),
      dp(context, 24),
      Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
    );
    galleryProgressParams.bottomMargin = dp(context, 196);
    root.addView(galleryProgress, galleryProgressParams);

    TextView galleryCounter = new TextView(parent.getContext());
    galleryCounter.setTextColor(Color.WHITE);
    galleryCounter.setTextSize(12);
    galleryCounter.setTypeface(Typeface.DEFAULT_BOLD);
    galleryCounter.setGravity(Gravity.CENTER);
    galleryCounter.setPadding(dp(context, 10), dp(context, 5), dp(context, 10), dp(context, 5));
    galleryCounter.setBackground(roundedDrawable(0x75000000, dp(context, 16)));
    galleryCounter.setVisibility(View.GONE);
    FrameLayout.LayoutParams galleryCounterParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(context, 30),
      Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
    );
    galleryCounterParams.bottomMargin = dp(context, 160);
    root.addView(galleryCounter, galleryCounterParams);

    LinearLayout caption = new LinearLayout(parent.getContext());
    caption.setOrientation(LinearLayout.VERTICAL);
    caption.setGravity(Gravity.LEFT);
    caption.setClipChildren(false);
    caption.setClipToPadding(false);

    TextView captionAuthor = new TextView(parent.getContext());
    captionAuthor.setTextColor(Color.WHITE);
    captionAuthor.setTextSize(16);
    captionAuthor.setTypeface(Typeface.DEFAULT_BOLD);
    captionAuthor.setShadowLayer(6, 0, 2, 0xAA000000);
    captionAuthor.setMinHeight(dp(context, 48));
    captionAuthor.setGravity(Gravity.CENTER_VERTICAL);
    captionAuthor.setClickable(true);
    captionAuthor.setFocusable(true);
    caption.addView(captionAuthor, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    TextView captionTitle = new TextView(parent.getContext());
    captionTitle.setTextColor(0xF2FFFFFF);
    captionTitle.setTextSize(15);
    captionTitle.setTypeface(Typeface.DEFAULT_BOLD);
    captionTitle.setLineSpacing(dp(context, 2), 1f);
    captionTitle.setMaxLines(2);
    captionTitle.setEllipsize(TextUtils.TruncateAt.END);
    captionTitle.setShadowLayer(6, 0, 2, 0xAA000000);
    captionTitle.setMinHeight(dp(context, 48));
    captionTitle.setClickable(true);
    captionTitle.setFocusable(true);
    caption.addView(captionTitle, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));

    TextView captionToggle = new TextView(parent.getContext());
    captionToggle.setText("展开");
    captionToggle.setTextColor(0xCCFFFFFF);
    captionToggle.setTextSize(12);
    captionToggle.setTypeface(Typeface.DEFAULT_BOLD);
    captionToggle.setGravity(Gravity.CENTER);
    captionToggle.setMinWidth(dp(context, 48));
    captionToggle.setMinHeight(dp(context, 48));
    captionToggle.setPadding(dp(context, 8), 0, dp(context, 8), 0);
    captionToggle.setBackground(roundedDrawable(0x52000000, dp(context, 16)));
    captionToggle.setClickable(true);
    captionToggle.setFocusable(true);
    captionToggle.setVisibility(View.GONE);
    LinearLayout.LayoutParams toggleParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(context, 48)
    );
    toggleParams.topMargin = dp(context, 4);
    caption.addView(captionToggle, toggleParams);

    FrameLayout.LayoutParams captionParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.BOTTOM | Gravity.LEFT
    );
    captionParams.leftMargin = dp(context, 14);
    captionParams.rightMargin = dp(context, 96);
    captionParams.bottomMargin = dp(context, 54);
    root.addView(caption, captionParams);

    ImageView likeBurst = new ImageView(parent.getContext());
    likeBurst.setImageResource(R.drawable.ic_short_heart);
    likeBurst.setImageTintList(ColorStateList.valueOf(0xFFFF4D6D));
    likeBurst.setPadding(dp(context, 10), dp(context, 10), dp(context, 10), dp(context, 10));
    likeBurst.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    likeBurst.setVisibility(View.GONE);
    root.addView(likeBurst, new FrameLayout.LayoutParams(
      dp(context, 116),
      dp(context, 116),
      Gravity.CENTER
    ));

    LinearLayout rail = new LinearLayout(parent.getContext());
    rail.setOrientation(LinearLayout.VERTICAL);
    rail.setGravity(Gravity.CENTER);
    rail.setClipChildren(false);
    rail.setClipToPadding(false);
    FrameLayout.LayoutParams railParams = new FrameLayout.LayoutParams(dp(context, 56), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.RIGHT | Gravity.BOTTOM);
    railParams.rightMargin = dp(context, 6);
    railParams.bottomMargin = dp(context, 68);
    root.addView(rail, railParams);

    FrameLayout progressTouch = new FrameLayout(parent.getContext());
    progressTouch.setClickable(true);
    progressTouch.setFocusable(true);
    progressTouch.setContentDescription("播放进度，拖动调整");
    progressTouch.setOnTouchListener(progressTouchListener);
    FrameLayout.LayoutParams progressTouchParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(context, 48),
      Gravity.BOTTOM
    );
    root.addView(progressTouch, progressTouchParams);

    FrameLayout progressTrack = new FrameLayout(parent.getContext());
    progressTrack.setAlpha(0f);
    progressTrack.setBackgroundColor(0x44FFFFFF);
    FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      dp(context, 3),
      Gravity.BOTTOM
    );
    progressTouch.addView(progressTrack, progressParams);

    View progressFill = new View(parent.getContext());
    progressFill.setBackgroundColor(0xEFFFFFFF);
    progressFill.setPivotX(0f);
    progressFill.setScaleX(0f);
    progressTrack.addView(progressFill, new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    TextView progressTime = new TextView(parent.getContext());
    progressTime.setTextColor(Color.WHITE);
    progressTime.setTextSize(13);
    progressTime.setTypeface(Typeface.DEFAULT_BOLD);
    progressTime.setGravity(Gravity.CENTER);
    progressTime.setPadding(dp(context, 10), dp(context, 5), dp(context, 10), dp(context, 5));
    progressTime.setBackground(roundedDrawable(0xCC161823, dp(context, 6)));
    progressTime.setVisibility(View.GONE);
    FrameLayout.LayoutParams progressTimeParams = new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
    );
    progressTimeParams.bottomMargin = dp(context, 34);
    root.addView(progressTime, progressTimeParams);

    return new ShortVideoHolder(root, stage, videoBackdrop, galleryCurrentLayer, galleryVideo, cover, galleryPreviewLayer, galleryPreview, gestureLayer, caption, captionAuthor, captionTitle, captionToggle, playIndicator, galleryProgress, galleryCounter, rail, progressTouch, progressTrack, progressFill, progressTime, likeBurst);
  }

  private static int dp(Context context, int value) {
    return Math.round(value * context.getResources().getDisplayMetrics().density);
  }

  private static GradientDrawable circleDrawable(int color) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setShape(GradientDrawable.OVAL);
    drawable.setColor(color);
    return drawable;
  }

  private static GradientDrawable roundedDrawable(int color, int radius) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(color);
    drawable.setCornerRadius(radius);
    return drawable;
  }
}
final class ShortVideoHolder extends RecyclerView.ViewHolder {
  final FrameLayout stage;
  final ImageView videoBackdrop;
  final FrameLayout galleryCurrentLayer;
  final PlayerView galleryVideo;
  final ImageView cover;
  final FrameLayout galleryPreviewLayer;
  final ImageView galleryPreview;
  final FrameLayout gestureLayer;
  final LinearLayout caption;
  final TextView captionAuthor;
  final TextView captionTitle;
  final TextView captionToggle;
  final ImageView playIndicator;
  final LinearLayout galleryProgress;
  final TextView galleryCounter;
  final LinearLayout rail;
  final FrameLayout progressTouch;
  final FrameLayout progressTrack;
  final View progressFill;
  final TextView progressTime;
  final ImageView likeBurst;
  int index = -1;
  float touchStartX;
  float touchStartY;
  float lastTapX = Float.NaN;
  float lastTapY = Float.NaN;
  long touchStartAtMs;
  boolean touchActive;
  boolean horizontalGesture;
  boolean verticalGesture;
  boolean longPressTriggered;
  boolean captionExpanded;
  boolean captionCanExpand;
  int galleryIndex;
  int galleryDragDirection;
  int galleryDragTargetIndex = -1;
  float galleryDragVisualX;
  boolean galleryDragActive;
  boolean galleryDragSettling;
  float galleryZoomScale = 1f;
  float galleryZoomLastX;
  float galleryZoomLastY;
  boolean galleryScaling;
  boolean galleryPanning;
  boolean galleryPanMoved;
  Runnable longPressRunnable;
  Runnable hideSeekPreviewRunnable;

  ShortVideoHolder(@NonNull FrameLayout root, FrameLayout stage, ImageView videoBackdrop, FrameLayout galleryCurrentLayer, PlayerView galleryVideo, ImageView cover, FrameLayout galleryPreviewLayer, ImageView galleryPreview, FrameLayout gestureLayer, LinearLayout caption, TextView captionAuthor, TextView captionTitle, TextView captionToggle, ImageView playIndicator, LinearLayout galleryProgress, TextView galleryCounter, LinearLayout rail, FrameLayout progressTouch, FrameLayout progressTrack, View progressFill, TextView progressTime, ImageView likeBurst) {
    super(root);
    this.stage = stage;
    this.videoBackdrop = videoBackdrop;
    this.galleryCurrentLayer = galleryCurrentLayer;
    this.galleryVideo = galleryVideo;
    this.cover = cover;
    this.galleryPreviewLayer = galleryPreviewLayer;
    this.galleryPreview = galleryPreview;
    this.gestureLayer = gestureLayer;
    this.caption = caption;
    this.captionAuthor = captionAuthor;
    this.captionTitle = captionTitle;
    this.captionToggle = captionToggle;
    this.playIndicator = playIndicator;
    this.galleryProgress = galleryProgress;
    this.galleryCounter = galleryCounter;
    this.rail = rail;
    this.progressTouch = progressTouch;
    this.progressTrack = progressTrack;
    this.progressFill = progressFill;
    this.progressTime = progressTime;
    this.likeBurst = likeBurst;
  }
}
