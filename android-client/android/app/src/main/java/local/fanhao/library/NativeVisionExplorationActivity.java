package local.fanhao.library;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.media.Image;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Rational;
import android.util.Size;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.UseCase;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public class NativeVisionExplorationActivity extends AppCompatActivity {
  public static final String EXTRA_MODE = "fanhao.vision.mode";
  public static final String EXTRA_SESSION_ID = "fanhao.vision.sessionId";
  public static final String MODE_DOCUMENT = "document";
  public static final String MODE_FACE = "face";
  public static final String MODE_REVIEW = "review";
  public static final String RESULT_SESSION_ID = "fanhao.vision.result.sessionId";
  public static final String RESULT_KIND = "fanhao.vision.result.kind";
  public static final String RESULT_CHALLENGE = "fanhao.vision.result.challenge";
  public static final String RESULT_FILE_COUNT = "fanhao.vision.result.fileCount";
  public static final String RESULT_DELETED = "fanhao.vision.result.deleted";
  public static final String RESULT_PRESERVED = "fanhao.vision.result.preserved";
  public static final String RESULT_DISCARDED = "fanhao.vision.result.discarded";
  private static final String STATE_SESSION = "vision.capture.session";
  private static final String STATE_KIND = "vision.capture.kind";
  private static final String STATE_CHALLENGE = "vision.capture.challenge";
  private static final String STATE_EXIT_CONFIRMATION = "vision.capture.exitConfirmation";
  private static final String STATE_FATAL_MESSAGE = "vision.capture.fatalMessage";
  private static final String STATE_PERMISSION_REQUEST = "vision.capture.permissionRequest";
  private static final String STATE_PERMISSION_RESULT = "vision.capture.permissionResult";
  private static final String STATE_COMPLETED_COUNT = "vision.capture.completedCount";
  private static final String STATE_REVIEW_SESSION = "vision.review.session";
  private static final String STATE_REVIEW_DELETE = "vision.review.deletePending";
  private static final String STATE_REVIEW_SHARE = "vision.review.shareInFlight";
  private static final String STATE_REVIEW_ERROR = "vision.review.exportError";

  private enum Step {
    ID_FRONT,
    ID_BACK,
    BANK_FRONT,
    FACE
  }

  private final AtomicBoolean faceBusy = new AtomicBoolean(false);
  private final VisionCaptureLifecycle captureLifecycle = new VisionCaptureLifecycle();
  private final Handler captureHandler = new Handler(Looper.getMainLooper());
  private final SecureRandom secureRandom = new SecureRandom();
  private final ActivityResultLauncher<String> cameraPermissionLauncher = registerForActivityResult(
    new ActivityResultContracts.RequestPermission(),
    this::onCameraPermissionResult
  );
  private final ActivityResultLauncher<Intent> archiveShareLauncher = registerForActivityResult(
    new ActivityResultContracts.StartActivityForResult(),
    result -> onArchiveShareResult()
  );

  private FrameLayout root;
  private PreviewView previewView;
  private VisionScanOverlayView scanOverlay;
  private TextView stepBadge;
  private TextView titleView;
  private TextView instructionView;
  private TextView statusView;
  private ProcessCameraProvider cameraProvider;
  private Preview cameraPreview;
  private ImageCapture imageCapture;
  private ImageAnalysis imageAnalysis;
  private ExecutorService cameraExecutor;
  private FaceDetector faceDetector;
  private TextRecognizer textRecognizer;
  private File sessionDirectory;
  private String mode;
  private String kind = "";
  private String restoredCheckpoint;
  private String pendingSessionId = "";
  private Bundle startupState;
  private boolean startupPending = true;
  private boolean permissionRequestInFlight;
  private Boolean cameraPermissionResult;
  private boolean exitConfirmationPending;
  private String fatalMessage;
  private String reviewSessionId = "";
  private boolean reviewDeletePending;
  private boolean reviewDeleteInProgress;
  private boolean reviewShareInFlight;
  private String reviewExportError;
  private Button reviewExportButton;
  private Button reviewDeleteButton;
  private volatile Step step;
  private boolean terminalResult = false;
  private int completedFileCount;
  private AlertDialog captureDialog;
  private boolean faceChallengeTurn = false;
  private String faceChallenge = "";
  private int facePhase = 0;
  private int stableFrames = 0;
  private volatile boolean faceCaptureStarted = false;
  private Integer activeFaceTrackingId;
  private int documentStableFrames = 0;
  private volatile boolean documentCaptureStarted = false;
  private long documentStepStartedAt = 0L;
  private long documentStableSince = 0L;
  private long lastDocumentUiAt = 0L;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    initializeCaptureState(savedInstanceState);
    String requestedMode = getIntent().getStringExtra(EXTRA_MODE);
    if (MODE_FACE.equals(requestedMode)) mode = MODE_FACE;
    else if (MODE_REVIEW.equals(requestedMode)) mode = MODE_REVIEW;
    else mode = MODE_DOCUMENT;
    configureWindow();
    if (MODE_REVIEW.equals(mode)) {
      showArchivedSession();
      getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
          finishReview(false);
        }
      });
      return;
    }
    cameraExecutor = Executors.newSingleThreadExecutor();
    createUi();
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        confirmExit();
      }
    });
  }

  private void initializeCaptureState(Bundle savedInstanceState) {
    initializeReviewState(savedInstanceState);
    captureLifecycle.suspend(VisionCaptureLifecycle.BACKGROUND);
    startupPending = true;
    startupState = savedInstanceState;
    String requestedSession = getIntent().getStringExtra(EXTRA_SESSION_ID);
    pendingSessionId = requestedSession == null ? "" : requestedSession;
    if (savedInstanceState == null) return;
    kind = savedInstanceState.getString(STATE_KIND, "");
    faceChallenge = savedInstanceState.getString(STATE_CHALLENGE, "");
    pendingSessionId = savedInstanceState.getString(STATE_SESSION, pendingSessionId);
    exitConfirmationPending = savedInstanceState.getBoolean(STATE_EXIT_CONFIRMATION, false);
    fatalMessage = savedInstanceState.getString(STATE_FATAL_MESSAGE, null);
    permissionRequestInFlight = savedInstanceState.getBoolean(STATE_PERMISSION_REQUEST, false);
    int permission = savedInstanceState.getInt(STATE_PERMISSION_RESULT, -1);
    cameraPermissionResult = permission == -1 ? null : permission == 1;
    completedFileCount = savedInstanceState.getInt(STATE_COMPLETED_COUNT, 0);
    if (exitConfirmationPending) captureLifecycle.suspend(VisionCaptureLifecycle.EXIT_CONFIRMATION);
    if (fatalMessage != null) captureLifecycle.suspend(VisionCaptureLifecycle.FATAL_ERROR);
  }

  @Override
  protected void onResume() {
    super.onResume();
    captureLifecycle.resume(VisionCaptureLifecycle.BACKGROUND);
    if (!canControlCapture()) return;
    updateReviewActions();
    if (fatalMessage != null || exitConfirmationPending) {
      presentPendingDialog();
      return;
    }
    if (MODE_REVIEW.equals(mode)) presentReviewDialog();
    else resumeForegroundCapture();
  }

  @Override
  protected void onPause() {
    suspendCapture(VisionCaptureLifecycle.BACKGROUND);
    dismissCaptureDialog();
    updateReviewActions();
    super.onPause();
  }

  private boolean canControlCapture() {
    return captureLifecycle.isAlive() && !terminalResult && !isFinishing() && !isDestroyed();
  }

  private void suspendCapture(int reason) {
    captureLifecycle.suspend(reason);
    captureHandler.removeCallbacksAndMessages(null);
    unbindCamera();
  }

  private void dismissCaptureDialog() {
    AlertDialog dialog = captureDialog;
    captureDialog = null;
    if (dialog != null) dialog.dismiss();
  }

  private void resumeForegroundCapture() {
    if (!canUseUi(captureLifecycle.generation()) || MODE_REVIEW.equals(mode)) return;
    if (captureLifecycle.isCompleted()) {
      deliverSuccess(completedFileCount);
      return;
    }
    // Do not reset faceBusy: an old model task still owns that gate until its
    // completion releases it. Its old generation cannot update the new step.
    step = null;
    if (startupPending) {
      startupPending = false;
      Bundle saved = startupState;
      startupState = null;
      if (restoreRequestedSession(saved)) return;
    } else if (sessionDirectory != null || !pendingSessionId.isEmpty()) {
      restoreCaptureSession(sessionDirectory != null ? sessionDirectory.getName() : pendingSessionId);
      return;
    }
    if (MODE_FACE.equals(mode)) kind = "face-verification";
    if (!kind.isEmpty()) requestCameraAndStart();
    else showDocumentTypePicker();
  }

  private boolean restoreRequestedSession(Bundle savedInstanceState) {
    String sessionId = getIntent().getStringExtra(EXTRA_SESSION_ID);
    if (savedInstanceState != null) {
      kind = savedInstanceState.getString(STATE_KIND, "");
      faceChallenge = savedInstanceState.getString(STATE_CHALLENGE, "");
      sessionId = savedInstanceState.getString(STATE_SESSION, sessionId == null ? "" : sessionId);
    }
    if (sessionId != null && !sessionId.isEmpty()) {
      restoreCaptureSession(sessionId);
      return true;
    }
    if (savedInstanceState != null && !kind.isEmpty()) {
      requestCameraAndStart();
      return true;
    }
    return false;
  }

  @Override
  protected void onSaveInstanceState(@NonNull Bundle outState) {
    saveReviewState(outState);
    outState.putString(STATE_KIND, kind);
    outState.putString(STATE_CHALLENGE, faceChallenge);
    if (sessionDirectory != null) outState.putString(STATE_SESSION, sessionDirectory.getName());
    else if (!pendingSessionId.isEmpty()) outState.putString(STATE_SESSION, pendingSessionId);
    outState.putBoolean(STATE_EXIT_CONFIRMATION, exitConfirmationPending);
    outState.putString(STATE_FATAL_MESSAGE, fatalMessage);
    outState.putBoolean(STATE_PERMISSION_REQUEST, permissionRequestInFlight);
    outState.putInt(STATE_PERMISSION_RESULT, cameraPermissionResult == null ? -1 : cameraPermissionResult ? 1 : 0);
    outState.putInt(STATE_COMPLETED_COUNT, completedFileCount);
    super.onSaveInstanceState(outState);
  }

  private void restoreCaptureSession(String sessionId) {
    if (!canUseUi(captureLifecycle.generation())) return;
    step = null;
    pendingSessionId = sessionId;
    try {
      sessionDirectory = VisionExplorationStore.resolveSessionDirectory(this, sessionId);
      JSONObject completed = null;
      try { completed = VisionExplorationStore.getCompletedSession(this, sessionId); }
      catch (IllegalStateException pending) {
        if (!"探索记录尚未完成".equals(pending.getMessage())) throw pending;
      }
      if (completed != null) {
        kind = completed.optString("kind", "");
        mode = "face-verification".equals(kind) ? MODE_FACE : MODE_DOCUMENT;
        faceChallenge = completed.optString("challenge", "");
        VisionCaptureLifecycle.discardAbandonedCaptures(sessionDirectory);
        step = MODE_FACE.equals(mode) ? Step.FACE : "id-card".equals(kind) ? Step.ID_BACK : Step.BANK_FRONT;
        showCompletion(new String[0], completed.getJSONArray("files").length());
      } else {
        JSONObject pending = VisionExplorationStore.getRecoverableSession(this, sessionId);
        kind = pending.optString("kind", "");
        mode = "face-verification".equals(kind) ? MODE_FACE : MODE_DOCUMENT;
        faceChallenge = pending.optString("challenge", "");
        restoredCheckpoint = pending.optString("nextStep", "");
        VisionCaptureLifecycle.discardAbandonedCaptures(sessionDirectory);
        if ("COMPLETE".equals(restoredCheckpoint)) resumeCaptureSession();
        else requestCameraAndStart();
      }
    } catch (Exception error) {
      showFatal("无法恢复本地演示存档：" + error.getMessage());
    }
  }

  private boolean canUseUi(long token) {
    return captureLifecycle.accepts(token) && !terminalResult && !isFinishing() && !isDestroyed();
  }

  private void postCaptureUi(long token, Runnable action) {
    runOnUiThread(() -> { if (canUseUi(token)) action.run(); });
  }

  private void postCaptureDelayed(long token, Runnable action, long delay) {
    captureHandler.postDelayed(() -> { if (canUseUi(token)) action.run(); }, delay);
  }

  private void unbindCamera() {
    if (imageAnalysis != null) imageAnalysis.clearAnalyzer();
    if (cameraProvider == null) return;
    List<UseCase> useCases = new ArrayList<>();
    if (cameraPreview != null) useCases.add(cameraPreview);
    if (imageCapture != null) useCases.add(imageCapture);
    if (imageAnalysis != null) useCases.add(imageAnalysis);
    if (!useCases.isEmpty()) cameraProvider.unbind(useCases.toArray(new UseCase[0]));
  }

  private void configureWindow() {
    Window window = getWindow();
    window.setStatusBarColor(Color.BLACK);
    window.setNavigationBarColor(Color.BLACK);
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  }

  private void createUi() {
    root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);

    previewView = new PreviewView(this);
    previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
    previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
    root.addView(previewView, matchFrame());

    scanOverlay = new VisionScanOverlayView(this);
    root.addView(scanOverlay, matchFrame());

    LinearLayout top = new LinearLayout(this);
    top.setOrientation(LinearLayout.VERTICAL);
    top.setPadding(dp(2), 0, dp(2), dp(12));
    FrameLayout.LayoutParams topParams = new FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.WRAP_CONTENT,
      Gravity.TOP
    );
    topParams.setMargins(dp(22), dp(48), dp(64), 0);

    stepBadge = label(12, Color.WHITE, true);
    stepBadge.setGravity(Gravity.CENTER);
    stepBadge.setBackground(rounded(Color.argb(150, 30, 36, 46), 999));
    LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT,
      dp(28)
    );
    stepBadge.setPadding(dp(11), 0, dp(11), 0);
    top.addView(stepBadge, badgeParams);

    titleView = label(24, Color.WHITE, true);
    LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT,
      LinearLayout.LayoutParams.WRAP_CONTENT
    );
    titleParams.topMargin = dp(10);
    top.addView(titleView, titleParams);

    instructionView = label(14, Color.rgb(224, 229, 237), false);
    instructionView.setLineSpacing(0, 1.15f);
    LinearLayout.LayoutParams instructionParams = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT,
      LinearLayout.LayoutParams.WRAP_CONTENT
    );
    instructionParams.topMargin = dp(5);
    top.addView(instructionView, instructionParams);
    root.addView(top, topParams);

    Button close = new Button(this);
    close.setText("×");
    close.setTextSize(27);
    close.setTextColor(Color.WHITE);
    close.setGravity(Gravity.CENTER);
    close.setPadding(0, 0, 0, dp(2));
    close.setBackground(rounded(Color.argb(145, 24, 28, 36), 999));
    close.setOnClickListener(view -> confirmExit());
    FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.TOP | Gravity.END);
    closeParams.setMargins(0, dp(43), dp(16), 0);
    root.addView(close, closeParams);

    LinearLayout footer = new LinearLayout(this);
    footer.setOrientation(LinearLayout.VERTICAL);
    footer.setGravity(Gravity.CENTER);
    footer.setPadding(dp(16), dp(12), dp(16), dp(14));
    footer.setBackground(rounded(Color.argb(178, 16, 20, 27), 18));
    FrameLayout.LayoutParams footerParams = new FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.WRAP_CONTENT,
      Gravity.BOTTOM
    );
    footerParams.setMargins(dp(18), 0, dp(18), dp(25));

    statusView = label(13, Color.rgb(218, 226, 237), true);
    statusView.setGravity(Gravity.CENTER);
    statusView.setLineSpacing(0, 1.1f);
    TextView automation = label(11, Color.rgb(111, 186, 255), true);
    automation.setGravity(Gravity.CENTER);
    automation.setText("AUTO · 自动识别  ·  自动拍摄  ·  自动确认");
    LinearLayout.LayoutParams automationParams = new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT,
      LinearLayout.LayoutParams.WRAP_CONTENT
    );
    automationParams.bottomMargin = dp(7);
    footer.addView(automation, automationParams);
    footer.addView(statusView, new LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT,
      LinearLayout.LayoutParams.WRAP_CONTENT
    ));
    root.addView(footer, footerParams);

    setContentView(root);
  }

  private void showArchivedSession() {
    String sessionId = reviewSessionId;
    try {
      JSONObject manifest = VisionExplorationStore.getCompletedSession(this, sessionId);
      File directory = VisionExplorationStore.resolveSessionDirectory(this, sessionId);
      kind = manifest.optString("kind");

      LinearLayout page = new LinearLayout(this);
      page.setOrientation(LinearLayout.VERTICAL);
      page.setPadding(dp(18), dp(34), dp(18), dp(30));
      page.setBackgroundColor(Color.rgb(13, 17, 23));

      LinearLayout toolbar = new LinearLayout(this);
      toolbar.setGravity(Gravity.CENTER_VERTICAL);
      TextView heading = label(23, Color.WHITE, true);
      heading.setText("本地演示复核");
      toolbar.addView(heading, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
      Button close = new Button(this);
      close.setAllCaps(false);
      close.setText("完成");
      close.setTextColor(Color.WHITE);
      close.setTextSize(13);
      close.setBackground(rounded(Color.rgb(39, 47, 59), 999));
      close.setOnClickListener(view -> finishReview(false));
      toolbar.addView(close, new LinearLayout.LayoutParams(dp(78), dp(42)));
      page.addView(toolbar);

      TextView sessionMeta = label(13, Color.rgb(184, 194, 208), false);
      sessionMeta.setLineSpacing(0, 1.18f);
      long completedAt = manifest.optLong("completedAt", manifest.optLong("createdAt", 0L));
      String completed = completedAt > 0L
        ? new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(new Date(completedAt))
        : "时间未知";
      String challenge = manifest.optString("challenge");
      String meta = archiveKindLabel(kind) + " · " + completed;
      if (!challenge.isEmpty()) meta += "\n随机动作：" + challenge;
      sessionMeta.setText(meta);
      LinearLayout.LayoutParams metaParams = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      );
      metaParams.topMargin = dp(8);
      metaParams.bottomMargin = dp(18);
      page.addView(sessionMeta, metaParams);

      JSONArray files = manifest.getJSONArray("files");
      for (int index = 0; index < files.length(); index++) {
        String fileName = files.getJSONObject(index).getString("name");
        File imageFile = VisionExplorationStore.resolveSessionFile(directory, fileName);
        TextView imageLabel = label(14, Color.WHITE, true);
        imageLabel.setText(archiveFileLabel(fileName));
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT,
          LinearLayout.LayoutParams.WRAP_CONTENT
        );
        labelParams.topMargin = index == 0 ? 0 : dp(18);
        labelParams.bottomMargin = dp(8);
        page.addView(imageLabel, labelParams);

        ImageView image = new ImageView(this);
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        image.setBackground(rounded(Color.BLACK, 16));
        Bitmap preview = decodePreview(imageFile, 1400);
        if (preview == null) {
          TextView unavailable = label(13, Color.rgb(255, 206, 147), false);
          unavailable.setText("暂时无法生成照片预览，原文件未改动。可返回后重开，或尝试导出原文件。");
          page.addView(unavailable, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        } else {
          image.setImageBitmap(preview);
          int imageHeight = "face-verification".equals(kind) ? dp(420) : dp(250);
          page.addView(image, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, imageHeight));
        }
      }

      TextView privacy = label(12, Color.rgb(164, 177, 194), false);
      privacy.setLineSpacing(0, 1.25f);
      privacy.setText("照片保存在 App 私有目录，其他普通应用无法读取；该目录已排除 Android 云备份。需要长期保留时，可主动导出副本并自行选择保存位置。分享窗口关闭不代表副本已保存，请确认接收应用保存后再删除本地记录。\n\n此记录只用于技术效果复核，不代表证件、银行卡或真人身份认证通过。");
      LinearLayout.LayoutParams privacyParams = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      );
      privacyParams.topMargin = dp(20);
      page.addView(privacy, privacyParams);

      Button export = new Button(this);
      reviewExportButton = export;
      export.setAllCaps(false);
      export.setText("导出备份副本");
      export.setTextColor(Color.WHITE);
      export.setTextSize(14);
      export.setBackground(rounded(Color.rgb(31, 103, 204), 14));
      export.setOnClickListener(view -> shareArchivedSession(sessionId));
      LinearLayout.LayoutParams exportParams = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        dp(52)
      );
      exportParams.topMargin = dp(20);
      page.addView(export, exportParams);

      Button delete = new Button(this);
      reviewDeleteButton = delete;
      delete.setAllCaps(false);
      delete.setText("删除本次本地记录");
      delete.setTextColor(Color.rgb(255, 199, 194));
      delete.setTextSize(14);
      delete.setBackground(rounded(Color.rgb(77, 35, 38), 14));
      delete.setOnClickListener(view -> confirmDeleteArchivedSession(sessionId));
      LinearLayout.LayoutParams deleteParams = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        dp(52)
      );
      deleteParams.topMargin = dp(10);
      page.addView(delete, deleteParams);

      ScrollView scroll = new ScrollView(this);
      scroll.setFillViewport(true);
      scroll.addView(page);
      setContentView(scroll);
      updateReviewActions();
    } catch (Exception error) {
      showFatal("无法读取本地演示记录：" + error.getMessage());
    }
  }

  private void shareArchivedSession(String sessionId) {
    if (!canStartReviewAction(sessionId)) return;
    reviewShareInFlight = true;
    updateReviewActions();
    try {
      JSONObject manifest = VisionExplorationStore.getCompletedSession(this, sessionId);
      File directory = VisionExplorationStore.resolveSessionDirectory(this, sessionId);
      JSONArray files = manifest.getJSONArray("files");
      ArrayList<Uri> uris = new ArrayList<>();
      for (int index = 0; index < files.length(); index++) {
        String fileName = files.getJSONObject(index).getString("name");
        File file = VisionExplorationStore.resolveSessionFile(directory, fileName);
        uris.add(FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file));
      }
      if (uris.isEmpty()) throw new IllegalStateException("本次记录没有可导出的照片");

      Intent share = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
      share.setType("image/jpeg");
      share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      if (uris.size() == 1) share.putExtra(Intent.EXTRA_STREAM, uris.get(0));
      else share.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
      ClipData clipData = ClipData.newUri(getContentResolver(), "视觉技术探索照片", uris.get(0));
      for (int index = 1; index < uris.size(); index++) clipData.addItem(new ClipData.Item(uris.get(index)));
      share.setClipData(clipData);
      archiveShareLauncher.launch(Intent.createChooser(share, "导出本次演示照片"));
    } catch (Exception error) {
      reviewShareInFlight = false;
      if (!canControlCapture()) return;
      reviewExportError = "无法打开分享窗口：" + error.getMessage();
      updateReviewActions();
      presentReviewDialog();
    }
  }

  private void confirmDeleteArchivedSession(String sessionId) {
    if (!canStartReviewAction(sessionId)) return;
    reviewDeletePending = true;
    updateReviewActions();
    presentReviewDialog();
  }

  private void initializeReviewState(Bundle savedInstanceState) {
    String sessionId = getIntent().getStringExtra(EXTRA_SESSION_ID);
    reviewSessionId = sessionId == null ? "" : sessionId;
    reviewDeletePending = false;
    reviewDeleteInProgress = false;
    reviewShareInFlight = false;
    reviewExportError = null;
    if (savedInstanceState == null || reviewSessionId.isEmpty()
      || !reviewSessionId.equals(savedInstanceState.getString(STATE_REVIEW_SESSION, ""))) return;
    reviewDeletePending = savedInstanceState.getBoolean(STATE_REVIEW_DELETE, false);
    reviewShareInFlight = savedInstanceState.getBoolean(STATE_REVIEW_SHARE, false);
    reviewExportError = savedInstanceState.getString(STATE_REVIEW_ERROR, null);
  }

  private void saveReviewState(Bundle outState) {
    outState.putString(STATE_REVIEW_SESSION, reviewSessionId);
    outState.putBoolean(STATE_REVIEW_DELETE, reviewDeletePending);
    outState.putBoolean(STATE_REVIEW_SHARE, reviewShareInFlight);
    outState.putString(STATE_REVIEW_ERROR, reviewExportError);
  }

  private boolean canReviewUi() {
    return MODE_REVIEW.equals(mode) && canUseUi(captureLifecycle.generation());
  }

  private boolean canStartReviewAction(String sessionId) {
    return canReviewUi() && !reviewSessionId.isEmpty() && reviewSessionId.equals(sessionId)
      && !reviewDeletePending && !reviewDeleteInProgress && !reviewShareInFlight
      && reviewExportError == null && captureDialog == null;
  }

  private void updateReviewActions() {
    boolean enabled = canStartReviewAction(reviewSessionId);
    if (reviewExportButton != null) {
      reviewExportButton.setEnabled(enabled);
      reviewExportButton.setText(reviewShareInFlight ? "分享窗口处理中…" : "导出备份副本");
    }
    if (reviewDeleteButton != null) reviewDeleteButton.setEnabled(enabled);
  }

  private void onArchiveShareResult() {
    if (!canControlCapture() || !MODE_REVIEW.equals(mode)) return;
    // The result only releases our launch gate; a receiver's result is not proof
    // that a backup was saved. In-flight state is restored before result delivery.
    reviewShareInFlight = false;
    updateReviewActions();
  }

  private void presentReviewDialog() {
    if (!canReviewUi() || captureDialog != null || reviewShareInFlight || reviewDeleteInProgress) return;
    if (reviewExportError != null) {
      captureDialog = new AlertDialog.Builder(this)
        .setTitle("无法导出")
        .setMessage(reviewExportError)
        .setPositiveButton("知道了", (dialog, which) -> dismissReviewExportError((AlertDialog) dialog))
        .setOnCancelListener(dialog -> dismissReviewExportError((AlertDialog) dialog))
        .show();
    } else if (reviewDeletePending) {
      final String sessionId = reviewSessionId;
      captureDialog = new AlertDialog.Builder(this)
        .setTitle("删除本次记录？")
        .setMessage("身份证、银行卡或人脸演示照片将从本机永久删除。若刚导出，请先确认接收应用已保存副本。")
        .setPositiveButton("删除", (dialog, which) -> deleteReviewedSession((AlertDialog) dialog, sessionId))
        .setNegativeButton("取消", (dialog, which) -> cancelReviewDelete((AlertDialog) dialog))
        .setOnCancelListener(dialog -> cancelReviewDelete((AlertDialog) dialog))
        .show();
    }
  }

  private void cancelReviewDelete(AlertDialog dialog) {
    if (!canReviewUi() || dialog == null || captureDialog != dialog || !reviewDeletePending) return;
    reviewDeletePending = false;
    dismissCaptureDialog();
    updateReviewActions();
  }

  private void dismissReviewExportError(AlertDialog dialog) {
    if (!canReviewUi() || dialog == null || captureDialog != dialog || reviewExportError == null) return;
    reviewExportError = null;
    dismissCaptureDialog();
    updateReviewActions();
  }

  private void deleteReviewedSession(AlertDialog dialog, String sessionId) {
    if (!canReviewUi() || dialog == null || captureDialog != dialog || !reviewDeletePending || reviewDeleteInProgress
      || reviewShareInFlight || !reviewSessionId.equals(sessionId)) return;
    // Consume explicit confirmation before the synchronous store call so neither
    // duplicate button events nor a dismissed old dialog can delete again.
    reviewDeletePending = false;
    reviewDeleteInProgress = true;
    dismissCaptureDialog();
    updateReviewActions();
    try {
      File directory = VisionExplorationStore.resolveSessionDirectory(this, sessionId);
      if (!VisionExplorationStore.deleteSession(this, sessionId) || directory.exists()) {
        throw new IllegalStateException("记录未被完整删除，请返回列表核对");
      }
      finishReview(true);
    } catch (Exception error) {
      showFatal("无法删除本地演示记录：" + error.getMessage());
    } finally {
      reviewDeleteInProgress = false;
      updateReviewActions();
    }
  }

  private void finishReview(boolean deleted) {
    if (!canControlCapture() || !MODE_REVIEW.equals(mode)
      || captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND)) return;
    reviewDeletePending = false;
    reviewExportError = null;
    dismissCaptureDialog();
    Intent data = new Intent();
    data.putExtra(RESULT_DELETED, deleted);
    terminalResult = true;
    updateReviewActions();
    setResult(Activity.RESULT_OK, data);
    finish();
  }

  private String archiveKindLabel(String value) {
    if ("id-card".equals(value)) return "身份证扫描";
    if ("bank-card".equals(value)) return "银行卡扫描";
    if ("face-verification".equals(value)) return "人脸与真人验证";
    return "视觉技术探索";
  }

  private String archiveFileLabel(String fileName) {
    if ("id-front.jpg".equals(fileName)) return "身份证人像面";
    if ("id-back.jpg".equals(fileName)) return "身份证国徽面";
    if ("bank-card-front.jpg".equals(fileName)) return "银行卡正面";
    if ("face-verification.jpg".equals(fileName)) return "动作完成后的正面定格";
    return "演示照片";
  }

  private void showDocumentTypePicker() {
    if (!canUseUi(captureLifecycle.generation())) return;
    dismissCaptureDialog();
    captureDialog = new AlertDialog.Builder(this)
      .setTitle("证卡自动扫描")
      .setItems(new String[] { "身份证（人像面 → 国徽面）", "银行卡（正面）" }, (dialog, which) -> {
        if (captureDialog != dialog || !canUseUi(captureLifecycle.generation())) return;
        captureDialog = null;
        kind = which == 0 ? "id-card" : "bank-card";
        requestCameraAndStart();
      })
      .setNegativeButton("取消", (dialog, which) -> { if (captureDialog == dialog) finishCanceled(); })
      .setOnCancelListener(dialog -> { if (captureDialog == dialog) finishCanceled(); })
      .show();
  }

  private void requestCameraAndStart() {
    if (!canUseUi(captureLifecycle.generation())) return;
    if (Boolean.FALSE.equals(cameraPermissionResult)) {
      showFatal("需要相机权限才能体验证卡扫描和人脸验证。");
      return;
    }
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      cameraPermissionResult = true;
      permissionRequestInFlight = false;
      beginCaptureSession();
    } else if (!permissionRequestInFlight) {
      cameraPermissionResult = null;
      permissionRequestInFlight = true;
      try {
        cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
      } catch (Exception error) {
        permissionRequestInFlight = false;
        showFatal("无法请求相机权限：" + error.getMessage());
      }
    }
  }

  private void onCameraPermissionResult(boolean granted) {
    if (!canControlCapture()) return;
    permissionRequestInFlight = false;
    cameraPermissionResult = granted;
    if (!granted) showFatal("需要相机权限才能体验证卡扫描和人脸验证。");
    else if (!startupPending && canUseUi(captureLifecycle.generation())) resumeForegroundCapture();
  }

  private void beginCaptureSession() {
    if (!captureLifecycle.canCapture(captureLifecycle.generation()) || !canUseUi(captureLifecycle.generation())) return;
    if (step != null) return;
    try {
      if (sessionDirectory == null) sessionDirectory = VisionExplorationStore.createSession(this, kind);
      pendingSessionId = sessionDirectory.getName();
    } catch (Exception error) {
      showFatal("无法创建本地演示存档：" + error.getMessage());
      return;
    }
    resumeCaptureSession();
  }

  private void resumeCaptureSession() {
    String checkpoint = restoredCheckpoint != null ? restoredCheckpoint : VisionCaptureLifecycle.resumeStep(kind, sessionDirectory);
    restoredCheckpoint = null;
    if (!"COMPLETE".equals(checkpoint)) {
      beginStep(Step.valueOf(checkpoint));
    } else if (MODE_FACE.equals(mode)) {
      step = Step.FACE;
      finishFaceSession(new File(sessionDirectory, "face-verification.jpg"));
    } else {
      step = "id-card".equals(kind) ? Step.ID_BACK : Step.BANK_FRONT;
      finishDocumentSession();
    }
  }

  private void beginStep(Step next) {
    if (!canUseUi(captureLifecycle.generation()) || captureLifecycle.isCompleted()) return;
    captureLifecycle.nextStep();
    step = next;
    documentStableFrames = 0;
    documentCaptureStarted = false;
    documentStepStartedAt = SystemClock.elapsedRealtime();
    documentStableSince = 0L;
    lastDocumentUiAt = 0L;
    if (next == Step.ID_FRONT) {
      stepBadge.setText("证卡扫描 · 1/2");
      titleView.setText("先扫描身份证人像面");
      instructionView.setText("让头像对准框内右侧人像轮廓，四边完整可见");
      statusView.setText("正在寻找证件边缘，请平稳移动到框内");
      scanOverlay.showDocument(VisionScanOverlayView.GUIDE_ID_PORTRAIT, "第 1 步 · 身份证人像面");
    } else if (next == Step.ID_BACK) {
      stepBadge.setText("证卡扫描 · 2/2");
      titleView.setText("再扫描身份证国徽面");
      instructionView.setText("翻转证件，让国徽对准框内左侧圆形轮廓");
      statusView.setText("正在寻找国徽面，识别稳定后自动拍摄");
      scanOverlay.showDocument(VisionScanOverlayView.GUIDE_ID_EMBLEM, "第 2 步 · 身份证国徽面");
    } else if (next == Step.BANK_FRONT) {
      stepBadge.setText("证卡扫描 · 银行卡");
      titleView.setText("银行卡正面");
      instructionView.setText("将芯片与卡片四边对准轮廓，避免反光和遮挡");
      statusView.setText("正在识别卡片边缘，稳定后自动拍摄");
      scanOverlay.showDocument(VisionScanOverlayView.GUIDE_BANK_CARD, "银行卡正面");
    } else {
      stepBadge.setText("人脸识别 · 真人验证");
      titleView.setText("将脸移入圆框");
      instructionView.setText("跟随蓝色扫描光保持居中，系统会自动完成动作验证");
      statusView.setText("正在启动前置摄像头…");
      if (faceChallenge.isEmpty()) {
        faceChallengeTurn = secureRandom.nextBoolean();
        faceChallenge = faceChallengeTurn ? "缓慢转头" : "微笑一下";
      } else faceChallengeTurn = "缓慢转头".equals(faceChallenge);
      try {
        VisionExplorationStore.saveChallenge(sessionDirectory, faceChallenge);
      } catch (Exception error) {
        showFatal("无法保存本地人脸动作：" + error.getMessage());
        return;
      }
      facePhase = 0;
      stableFrames = 0;
      faceCaptureStarted = false;
      activeFaceTrackingId = null;
      scanOverlay.showFace(0.04f, false);
      ensureFaceDetector();
    }
    bindCamera();
  }

  private void bindCamera() {
    long token = captureLifecycle.generation();
    ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
    future.addListener(() -> {
      if (!canUseUi(token) || !captureLifecycle.canCapture(token)) return;
      try {
        cameraProvider = future.get();
        unbindCamera();
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        Preview preview = new Preview.Builder().setTargetRotation(rotation).build();
        cameraPreview = preview;
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        imageCapture = new ImageCapture.Builder()
          .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
          .setTargetRotation(rotation)
          .build();
        if (step != Step.FACE) {
          imageCapture.setCropAspectRatio(new Rational(856, 540));
        }
        CameraSelector selector = step == Step.FACE
          ? CameraSelector.DEFAULT_FRONT_CAMERA
          : CameraSelector.DEFAULT_BACK_CAMERA;
        if (step == Step.FACE) {
          imageAnalysis = new ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setTargetResolution(new Size(640, 480))
            .setTargetRotation(rotation)
            .build();
          imageAnalysis.setAnalyzer(cameraExecutor, createAnalyzer(token, true));
          cameraProvider.bindToLifecycle(this, selector, preview, imageCapture, imageAnalysis);
        } else {
          imageAnalysis = new ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setTargetResolution(new Size(640, 480))
            .setTargetRotation(rotation)
            .build();
          imageAnalysis.setAnalyzer(cameraExecutor, createAnalyzer(token, false));
          cameraProvider.bindToLifecycle(this, selector, preview, imageCapture, imageAnalysis);
        }
      } catch (Exception error) {
        showFatal("无法启动摄像头：" + error.getMessage());
      }
    }, ContextCompat.getMainExecutor(this));
  }

  private ImageAnalysis.Analyzer createAnalyzer(long token, boolean face) {
    // The binding, not eventual executor delivery, owns the frame generation.
    return imageProxy -> {
      if (face) analyzeFace(imageProxy, token);
      else analyzeDocument(imageProxy, token);
    };
  }

  private void analyzeDocument(ImageProxy imageProxy, long token) {
    try {
      if (!captureLifecycle.canCapture(token) || step == null || step == Step.FACE || documentCaptureStarted) return;
      long now = SystemClock.elapsedRealtime();
      DocumentAssessment assessment = assessDocumentFrame(imageProxy);
      postCaptureUi(token, () -> processDocumentAssessment(assessment, now));
    } finally {
      imageProxy.close();
    }
  }

  private void processDocumentAssessment(DocumentAssessment assessment, long now) {
      if (documentCaptureStarted || captureLifecycle.isCompleted()) return;
      if (now - documentStepStartedAt < 650L) {
        updateDocumentUi(0.06f, "正在校准相机与光线…", false);
        return;
      }
      if (assessment.ready) {
        if (documentStableFrames == 0) documentStableSince = now;
        documentStableFrames++;
      } else {
        documentStableFrames = 0;
        documentStableSince = 0L;
      }

      long stableDuration = documentStableSince == 0L ? 0L : now - documentStableSince;

      float progress = assessment.ready
        ? 0.30f + Math.min(1f, stableDuration / 1050f) * 0.64f
        : Math.min(0.28f, assessment.quality * 0.28f);
      String message = assessment.message;
      if (assessment.ready) {
        if (stableDuration < 350L) message = "证卡四边已识别 · 保持稳定 3";
        else if (stableDuration < 750L) message = "自动拍摄倒计时 · 2";
        else message = "自动拍摄倒计时 · 1";
      }
      if (now - lastDocumentUiAt > 80L) {
        lastDocumentUiAt = now;
        updateDocumentUi(progress, message, false);
      }
      if (documentStableFrames >= 8 && stableDuration >= 1050L && !documentCaptureStarted) {
        documentCaptureStarted = true;
        captureDocumentAutomatically();
      }
  }

  private DocumentAssessment assessDocumentFrame(ImageProxy imageProxy) {
    ImageProxy.PlaneProxy plane = imageProxy.getPlanes()[0];
    ByteBuffer buffer = plane.getBuffer();
    int sourceWidth = imageProxy.getWidth();
    int sourceHeight = imageProxy.getHeight();
    int rotation = imageProxy.getImageInfo().getRotationDegrees();
    int width = rotation == 90 || rotation == 270 ? sourceHeight : sourceWidth;
    int height = rotation == 90 || rotation == 270 ? sourceWidth : sourceHeight;
    int regionWidth = Math.max(32, Math.round(width * 0.82f));
    int regionHeight = Math.max(24, Math.round(regionWidth / 1.586f));
    int left = Math.max(4, (width - regionWidth) / 2);
    int top = Math.max(4, Math.round(height * 0.44f - regionHeight / 2f));
    int right = Math.min(width - 5, left + regionWidth);
    int bottom = Math.min(height - 5, top + regionHeight);
    int stride = Math.max(3, width / 120);

    long count = 0L;
    double sum = 0d;
    double square = 0d;
    double sharpness = 0d;
    for (int y = top + stride; y < bottom - stride; y += stride) {
      for (int x = left + stride; x < right - stride; x += stride) {
        int value = uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, x, y);
        int horizontal = uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, x + stride, y);
        int vertical = uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, x, y + stride);
        sum += value;
        square += value * value;
        sharpness += Math.abs(value - horizontal) + Math.abs(value - vertical);
        count++;
      }
    }

    double border = 0d;
    long borderCount = 0L;
    int offset = Math.max(3, stride);
    for (int y = top + stride; y < bottom - stride; y += stride) {
      border += Math.abs(
        uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, left + offset, y)
          - uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, left - offset, y)
      );
      border += Math.abs(
        uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, right - offset, y)
          - uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, right + offset, y)
      );
      borderCount += 2L;
    }
    for (int x = left + stride; x < right - stride; x += stride) {
      border += Math.abs(
        uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, x, top + offset)
          - uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, x, top - offset)
      );
      border += Math.abs(
        uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, x, bottom - offset)
          - uprightLuma(buffer, plane, sourceWidth, sourceHeight, rotation, x, bottom + offset)
      );
      borderCount += 2L;
    }

    double mean = count == 0L ? 0d : sum / count;
    double variance = count == 0L ? 0d : square / count - mean * mean;
    double detail = count == 0L ? 0d : sharpness / (count * 2d);
    double borderScore = borderCount == 0L ? 0d : border / borderCount;
    float quality = (float) Math.min(1d,
      Math.min(1d, variance / 900d) * 0.36d
        + Math.min(1d, detail / 8d) * 0.34d
        + Math.min(1d, borderScore / 8d) * 0.30d
    );

    if (mean < 46d) return new DocumentAssessment(false, quality, "光线偏暗，请移到明亮处");
    if (mean > 222d) return new DocumentAssessment(false, quality, "反光较强，请轻微调整证件角度");
    if (variance < 430d) return new DocumentAssessment(false, quality, "请让证卡内容与四边完整进入框内");
    if (borderScore < 4.2d) return new DocumentAssessment(false, quality, "对齐四个角，使证卡占满取景框");
    if (detail < 4.6d) return new DocumentAssessment(false, quality, "画面轻微抖动，请保持手机稳定");
    return new DocumentAssessment(true, quality, "证卡已识别");
  }

  private int uprightLuma(
    ByteBuffer buffer,
    ImageProxy.PlaneProxy plane,
    int sourceWidth,
    int sourceHeight,
    int rotation,
    int x,
    int y
  ) {
    int sourceX;
    int sourceY;
    if (rotation == 90) {
      sourceX = y;
      sourceY = sourceHeight - 1 - x;
    } else if (rotation == 180) {
      sourceX = sourceWidth - 1 - x;
      sourceY = sourceHeight - 1 - y;
    } else if (rotation == 270) {
      sourceX = sourceWidth - 1 - y;
      sourceY = x;
    } else {
      sourceX = x;
      sourceY = y;
    }
    sourceX = Math.max(0, Math.min(sourceWidth - 1, sourceX));
    sourceY = Math.max(0, Math.min(sourceHeight - 1, sourceY));
    int index = sourceY * plane.getRowStride() + sourceX * plane.getPixelStride();
    if (index < 0 || index >= buffer.limit()) return 0;
    return buffer.get(index) & 0xff;
  }

  private void updateDocumentUi(float progress, String message, boolean completed) {
    postCaptureUi(captureLifecycle.generation(), () -> {
      if (step == null || step == Step.FACE) return;
      statusView.setText(message);
      scanOverlay.updateDocument(progress, message, completed);
    });
  }

  private void captureDocumentAutomatically() {
    if (!canUseUi(captureLifecycle.generation()) || captureLifecycle.isCompleted()
      || step == Step.FACE || imageCapture == null || sessionDirectory == null) {
      documentCaptureStarted = false;
      return;
    }
    statusView.setText("识别稳定，正在自动拍摄…");
    scanOverlay.updateDocument(0.98f, "正在自动拍摄…", false);
    File output = VisionCaptureLifecycle.temporaryCapture(sessionDirectory);
    takePicture(output, () -> confirmCapturedDocument(output), message -> {
      documentCaptureStarted = false;
      documentStableFrames = 0;
      documentStableSince = 0L;
      statusView.setText(message + "，正在重新识别");
      scanOverlay.updateDocument(0.08f, "重新识别证卡", false);
    });
  }

  private void takePicture(File output, Runnable success, java.util.function.Consumer<String> failure) {
    long token = captureLifecycle.generation();
    if (!canUseUi(token) || !captureLifecycle.canCapture(token)) {
      VisionCaptureLifecycle.discardTemporary(output);
      return;
    }
    AtomicInteger outcome = null;
    try {
      // 0=pending, 1=handed to the success owner, 2=failed/aborted. A late
      // callback from a failed launch cannot revive it or delete a newer request.
      AtomicInteger requestOutcome = new AtomicInteger();
      outcome = requestOutcome;
      ImageCapture.OutputFileOptions options = new ImageCapture.OutputFileOptions.Builder(output).build();
      imageCapture.takePicture(options, ContextCompat.getMainExecutor(this), new ImageCapture.OnImageSavedCallback() {
      @Override
      public void onImageSaved(@NonNull ImageCapture.OutputFileResults outputFileResults) {
        if (!requestOutcome.compareAndSet(0, 1)) {
          if (requestOutcome.get() == 2) VisionCaptureLifecycle.discardTemporary(output);
          return;
        }
        if (canUseUi(token) && captureLifecycle.canCapture(token)) success.run();
        else VisionCaptureLifecycle.discardTemporary(output);
      }

      @Override
      public void onError(@NonNull ImageCaptureException exception) {
        if (!requestOutcome.compareAndSet(0, 2)) return;
        VisionCaptureLifecycle.discardTemporary(output);
        if (canUseUi(token) && captureLifecycle.canCapture(token)) failure.accept("拍摄失败：" + exception.getMessage());
      }
      });
    } catch (RuntimeException | OutOfMemoryError error) {
      if (outcome == null || outcome.compareAndSet(0, 2)) {
        VisionCaptureLifecycle.discardTemporary(output);
        if (canUseUi(token) && captureLifecycle.canCapture(token)) failure.accept("拍摄暂时不可用，请重试");
      }
    }
  }

  private void confirmCapturedDocument(File file) {
    long token = captureLifecycle.generation();
    Bitmap preview = null;
    try {
      if (!canUseUi(token) || !captureLifecycle.canCapture(token)) {
        VisionCaptureLifecycle.discardTemporary(file);
        return;
      }
      preview = decodePreview(file, 1100);
      String quality = assessImageQuality(preview);
      if (!canUseUi(token) || !captureLifecycle.canCapture(token)) {
        VisionCaptureLifecycle.discardTemporary(file);
        return;
      }
      if (preview == null || !quality.startsWith("光线与对比度正常")) {
        retryDocumentAutomatically(file, quality + " 正在自动重试");
        return;
      }
      if (step == Step.ID_FRONT || step == Step.ID_BACK) {
        validateIdentityCardSide(file, preview, step);
        // OCR now owns its completion cleanup, including synchronous failure.
        preview = null;
        return;
      }
      acceptCapturedDocument(file);
    } catch (RuntimeException | OutOfMemoryError invalidPreview) {
      if (canUseUi(token) && captureLifecycle.canCapture(token)) {
        retryDocumentAutomatically(file, "无法处理本次预览，正在自动重试");
      } else VisionCaptureLifecycle.discardTemporary(file);
    } finally {
      if (preview != null) preview.recycle();
    }
  }

  private void validateIdentityCardSide(File file, Bitmap preview, Step expectedStep) {
    long token = captureLifecycle.generation();
    Runnable releasePreview = VisionCaptureLifecycle.releaseOnce(preview::recycle);
    AtomicBoolean resultAllowed = new AtomicBoolean(true);
    boolean recognitionOwnsPreview = false;
    try {
      if (textRecognizer == null) {
        textRecognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
      }
      statusView.setText(expectedStep == Step.ID_FRONT ? "正在确认身份证人像面…" : "正在确认身份证国徽面…");
      scanOverlay.updateDocument(0.99f, "正在校验证件面别…", false);
      Task<Text> recognition = textRecognizer.process(InputImage.fromBitmap(preview, 0));
      if (recognition == null) throw new IllegalStateException("Missing recognition task");
      recognitionOwnsPreview = true;
      recognition.addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> {
        releasePreview.run();
        if (task.isCanceled() || !resultAllowed.get() || !captureLifecycle.accepts(token)) VisionCaptureLifecycle.discardTemporary(file);
      })
      .addOnCompleteListener(ContextCompat.getMainExecutor(this), task -> {
        if (resultAllowed.get() && task.isCanceled() && step == expectedStep && canUseUi(token) && captureLifecycle.canCapture(token)) {
          retryDocumentAutomatically(file, "面别识别已取消，正在自动重试");
        }
      })
      .addOnSuccessListener(result -> {
        if (!resultAllowed.get() || step != expectedStep || !canUseUi(token)) {
          VisionCaptureLifecycle.discardTemporary(file);
          return;
        }
        String recognized = result.getText().replaceAll("\\s+", "");
        int portraitScore = countKeywords(recognized, "姓名", "性别", "民族", "出生", "住址", "公民身份号码");
        int emblemScore = countKeywords(recognized, "中华人民共和国", "居民身份证", "签发机关", "有效期限");
        boolean valid = expectedStep == Step.ID_FRONT
          ? portraitScore >= 2 && portraitScore > emblemScore
          : emblemScore >= 1 && emblemScore >= portraitScore;
        if (valid) acceptCapturedDocument(file);
        else retryDocumentAutomatically(
          file,
          expectedStep == Step.ID_FRONT
            ? "未确认到人像面，请按右侧头像轮廓重新对齐"
            : "未确认到国徽面，请翻转证件并对齐国徽轮廓"
        );
      })
      .addOnFailureListener(error -> {
        if (resultAllowed.get() && step == expectedStep && canUseUi(token)) {
          retryDocumentAutomatically(file, "面别识别不清晰，请保持证件平整后重试");
        } else VisionCaptureLifecycle.discardTemporary(file);
      });
    } catch (Exception | OutOfMemoryError error) {
      resultAllowed.set(false);
      // A returned Task may still read the bitmap even if registering its listeners
      // fails. Its completion owns cleanup; if no listener was registered, let the
      // input become GC-eligible with the task instead of recycling it prematurely.
      if (!recognitionOwnsPreview) releasePreview.run();
      if (step == expectedStep && canUseUi(token) && captureLifecycle.canCapture(token)) retryDocumentAutomatically(file, "面别识别暂时不可用，请重新对齐证件");
      else VisionCaptureLifecycle.discardTemporary(file);
    }
  }

  private int countKeywords(String text, String... keywords) {
    int score = 0;
    for (String keyword : keywords) if (text.contains(keyword)) score++;
    return score;
  }

  private void retryDocumentAutomatically(File file, String message) {
    VisionCaptureLifecycle.discardTemporary(file);
    documentCaptureStarted = false;
    documentStableFrames = 0;
    documentStableSince = 0L;
    statusView.setText(message);
    scanOverlay.updateDocument(0.08f, "自动重新识别", false);
  }

  private void acceptCapturedDocument(File file) {
    if (!canUseUi(captureLifecycle.generation()) || captureLifecycle.isCompleted()) {
      VisionCaptureLifecycle.discardTemporary(file);
      return;
    }
    try {
      VisionCaptureLifecycle.promote(file, sessionDirectory, fileNameForStep(step));
    } catch (Exception error) {
      VisionCaptureLifecycle.discardTemporary(file);
      showFatal("无法确认本地演示照片：" + error.getMessage());
      return;
    }
    unbindCamera();
    String confirmed = step == Step.ID_FRONT
      ? "人像面已识别并自动确认"
      : step == Step.ID_BACK ? "国徽面已识别并自动确认" : "银行卡已识别并自动确认";
    statusView.setText(confirmed);
    scanOverlay.updateDocument(1f, confirmed, true);
    root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
    postCaptureDelayed(captureLifecycle.generation(), () -> {
      if (step == Step.ID_FRONT) beginStep(Step.ID_BACK);
      else finishDocumentSession();
    }, 900L);
  }

  private void finishDocumentSession() {
    if (!canUseUi(captureLifecycle.generation()) || captureLifecycle.isCompleted()) return;
    try {
      if ("id-card".equals(kind)) {
        VisionExplorationStore.completeSession(sessionDirectory, kind, "", "id-front.jpg", "id-back.jpg");
        showCompletion(new String[] { "id-front.jpg", "id-back.jpg" }, 2);
      } else {
        VisionExplorationStore.completeSession(sessionDirectory, kind, "", "bank-card-front.jpg");
        showCompletion(new String[] { "bank-card-front.jpg" }, 1);
      }
    } catch (Exception error) {
      showFatal("无法完成本地演示存档：" + error.getMessage());
    }
  }

  private void ensureFaceDetector() {
    if (faceDetector != null) return;
    FaceDetectorOptions options = new FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
      .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
      .enableTracking()
      .setMinFaceSize(0.18f)
      .build();
    faceDetector = FaceDetection.getClient(options);
  }

  private void analyzeFace(ImageProxy imageProxy, long token) {
    FaceDetector detector = faceDetector;
    if (!captureLifecycle.canCapture(token) || step != Step.FACE || detector == null
      || faceCaptureStarted || !faceBusy.compareAndSet(false, true)) {
      imageProxy.close();
      return;
    }
    Runnable frameCleanup = null;
    Runnable busyCleanup = null;
    AtomicBoolean resultAllowed = null;
    Task<List<Face>> detection = null;
    try {
      Runnable releaseFrame = VisionCaptureLifecycle.releaseOnce(imageProxy::close);
      frameCleanup = releaseFrame;
      Runnable releaseBusy = VisionCaptureLifecycle.releaseOnce(() -> faceBusy.set(false));
      busyCleanup = releaseBusy;
      AtomicBoolean allowed = new AtomicBoolean(true);
      resultAllowed = allowed;
      Image mediaImage = imageProxy.getImage();
      if (mediaImage == null) throw new IllegalStateException("Missing camera image");
      int rotation = imageProxy.getImageInfo().getRotationDegrees();
      int uprightWidth = rotation == 90 || rotation == 270 ? imageProxy.getHeight() : imageProxy.getWidth();
      int uprightHeight = rotation == 90 || rotation == 270 ? imageProxy.getWidth() : imageProxy.getHeight();
      InputImage input = InputImage.fromMediaImage(mediaImage, rotation);
      detection = detector.process(input);
      if (detection == null) throw new IllegalStateException("Missing face detection task");
      // A completed Task can enqueue UI work while listeners are still being
      // registered. Publish either the whole setup or its failure before that work.
      synchronized (allowed) {
        try {
          detection.addOnCompleteListener(VisionCaptureLifecycle.RELEASE_EXECUTOR, task -> releaseFrame.run())
            .addOnCompleteListener(ContextCompat.getMainExecutor(this), task -> {
              synchronized (allowed) { if (!allowed.get()) return; }
              try {
                if (!canUseUi(token) || !captureLifecycle.canCapture(token) || step != Step.FACE) return;
                if (task.isSuccessful()) processFaces(task.getResult(), uprightWidth, uprightHeight);
                else resetFaceTracking(task.isCanceled()
                  ? "人脸检测已中断，请重新正对镜头" : "人脸检测暂时失败，请重新正对镜头");
              } catch (RuntimeException | OutOfMemoryError invalidResult) {
                if (canUseUi(token) && captureLifecycle.canCapture(token) && step == Step.FACE) {
                  resetFaceTracking("无法处理人脸结果，请重新正对镜头");
                }
              } finally {
                // This task alone owns the gate, even if fallback also finishes.
                releaseBusy.run();
              }
            });
        } catch (RuntimeException | OutOfMemoryError registrationFailure) {
          allowed.set(false);
          throw registrationFailure;
        }
      }
    } catch (RuntimeException | OutOfMemoryError error) {
      if (resultAllowed != null) resultAllowed.set(false);
      // Only this exceptional path waits, on the existing CameraX analysis worker.
      // ML Kit uses its own default pool. Never close an in-flight camera buffer,
      // or wait for a main-thread callback that may have been dropped on pause.
      if (detection != null) awaitFaceTaskCompletion(detection);
      try {
        if (frameCleanup != null) frameCleanup.run();
        else imageProxy.close();
        postCaptureUi(token, () -> {
          if (step == Step.FACE && captureLifecycle.canCapture(token)) {
            resetFaceTracking("人脸检测暂时失败，请重新正对镜头");
          }
        });
      } finally {
        if (busyCleanup != null) busyCleanup.run();
        else faceBusy.set(false);
      }
    }
  }

  private void awaitFaceTaskCompletion(Task<?> task) {
    boolean interrupted = false;
    try {
      while (!task.isComplete()) {
        try { Thread.sleep(50L); }
        catch (InterruptedException interruption) { interrupted = true; }
      }
    } finally {
      if (interrupted) Thread.currentThread().interrupt();
    }
  }

  private void resetFaceTracking(String message) {
    facePhase = 0;
    stableFrames = 0;
    activeFaceTrackingId = null;
    if (!faceCaptureStarted) updateFaceUi(0.04f, message, false);
  }

  private void processFaces(List<Face> faces, int width, int height) {
    if (faceCaptureStarted || step != Step.FACE) return;
    if (faces == null || width <= 0 || height <= 0) {
      resetFaceTracking("无法确认连续的人脸图像，请重新正对镜头");
      return;
    }
    if (faces.size() != 1) {
      resetFaceTracking(faces.isEmpty() ? "请将脸移入圆框，重新开始动作" : "请保持只有一人入镜，重新开始动作");
      return;
    }

    Face face = faces.get(0);
    if (face == null) {
      resetFaceTracking("无法确认连续的人脸图像，请重新正对镜头");
      return;
    }
    Integer trackingId = face.getTrackingId();
    if (trackingId == null) {
      resetFaceTracking("正在建立连续人脸跟踪，请保持正对镜头");
      return;
    }
    if (activeFaceTrackingId != null && !activeFaceTrackingId.equals(trackingId)) {
      resetFaceTracking("检测到人脸变化，请重新开始动作");
      activeFaceTrackingId = trackingId;
      return;
    }

    Rect box = face.getBoundingBox();
    if (box == null || box.left < 0 || box.top < 0 || box.right > width || box.bottom > height
      || box.right <= box.left || box.bottom <= box.top) {
      resetFaceTracking("请让完整脸部回到圆框，重新开始动作");
      return;
    }
    double centerX = ((long) box.left + box.right) / 2d;
    double centerY = ((long) box.top + box.bottom) / 2d;
    long boxWidth = (long) box.right - box.left;
    boolean centered = Math.abs(centerX - width / 2d) < width * 0.20d
      && Math.abs(centerY - height / 2d) < height * 0.22d
      && boxWidth > width * 0.20d && boxWidth < width * 0.78d;
    float yaw = face.getHeadEulerAngleY();
    float roll = face.getHeadEulerAngleZ();
    Float smileProbability = face.getSmilingProbability();
    if (!centered || !Float.isFinite(yaw) || !Float.isFinite(roll)) {
      resetFaceTracking("请让脸部保持居中，重新开始动作");
      return;
    }
    if (!faceChallengeTurn && facePhase < 2 && (smileProbability == null
      || !Float.isFinite(smileProbability) || smileProbability < 0f || smileProbability > 1f)) {
      resetFaceTracking("暂时无法确认表情，请重新正对镜头");
      return;
    }
    if (activeFaceTrackingId == null) activeFaceTrackingId = trackingId;
    boolean frontal = centered && Math.abs(yaw) < 12f && Math.abs(roll) < 12f;

    if (facePhase == 0) {
      boolean neutralReady = faceChallengeTurn
        || smileProbability != null && smileProbability < 0.45f;
      boolean ready = frontal && neutralReady;
      stableFrames = ready ? stableFrames + 1 : 0;
      float progress = 0.08f + Math.min(1f, stableFrames / 7f) * 0.24f;
      String message;
      if (!frontal) message = "请正对镜头并移到圆框中央";
      else if (!neutralReady) message = "请先放松表情，再按提示完成微笑";
      else message = "已锁定同一张人脸，请保持不动";
      updateFaceUi(progress, message, false);
      if (stableFrames >= 7) {
        facePhase = 1;
        stableFrames = 0;
        updateFaceUi(0.36f, "随机动作：" + faceChallenge, false);
      }
      return;
    }

    if (facePhase == 1) {
      boolean actionPassed = faceChallengeTurn
        ? Math.abs(roll) < 12f && Math.abs(yaw) > 19f
        : frontal && smileProbability != null && smileProbability > 0.72f;
      stableFrames = actionPassed ? stableFrames + 1 : 0;
      float progress = 0.38f + Math.min(1f, stableFrames / 4f) * 0.28f;
      updateFaceUi(progress, actionPassed ? "动作已识别，保持一下" : "请完成动作：" + faceChallenge, false);
      if (stableFrames >= 4) {
        facePhase = 2;
        stableFrames = 0;
        updateFaceUi(0.70f, "动作完成，请重新正对镜头", false);
      }
      return;
    }

    stableFrames = frontal ? stableFrames + 1 : 0;
    float progress = 0.72f + Math.min(1f, stableFrames / 7f) * 0.25f;
    updateFaceUi(progress, frontal ? "验证动作完成，正在定格" : "请重新正对镜头", false);
    if (stableFrames >= 7) captureVerifiedFace();
  }

  private void updateFaceUi(float progress, String message, boolean success) {
    postCaptureUi(captureLifecycle.generation(), () -> {
      if (step != Step.FACE) return;
      statusView.setText(message);
      stepBadge.setText(success ? "真人验证 · 已完成" : "真人验证 · " + Math.round(progress * 100f) + "%");
      if (facePhase == 0) {
        titleView.setText("正在定位人脸");
        instructionView.setText(faceChallengeTurn ? "先正对镜头，随后按提示转头" : "先保持自然表情，随后按提示微笑");
      } else if (facePhase == 1) {
        titleView.setText(faceChallengeTurn ? "请缓慢转头" : "请自然微笑");
        instructionView.setText(faceChallengeTurn ? "跟随扫描光向任意一侧缓慢转动" : "保持脸部居中，让系统识别表情变化");
      } else if (facePhase == 2) {
        titleView.setText("回到正面 · 自动定格");
        instructionView.setText("无需点击，保持脸部居中即可自动完成");
      }
      scanOverlay.showFace(progress, success);
    });
  }

  private void captureVerifiedFace() {
    long token = captureLifecycle.generation();
    if (faceCaptureStarted || step != Step.FACE || !canUseUi(token) || !captureLifecycle.canCapture(token)) return;
    faceCaptureStarted = true;
    AtomicBoolean pendingUi = null;
    try {
      AtomicBoolean uiAttempt = new AtomicBoolean(true);
      pendingUi = uiAttempt;
      postCaptureUi(token, () -> {
        if (!uiAttempt.compareAndSet(true, false)) return;
        File pendingOutput = null;
        try {
          updateFaceUi(0.98f, "动作序列完成，正在保存演示照片", false);
          if (sessionDirectory == null || imageCapture == null) throw new IllegalStateException("Camera session unavailable");
          File output = VisionCaptureLifecycle.temporaryCapture(sessionDirectory);
          pendingOutput = output;
          takePicture(output, () -> {
            try {
              VisionCaptureLifecycle.promote(output, sessionDirectory, "face-verification.jpg");
              finishFaceSession(new File(sessionDirectory, "face-verification.jpg"));
            } catch (Exception | OutOfMemoryError error) {
              VisionCaptureLifecycle.discardTemporary(output);
              showFatal("无法确认人脸演示照片，请关闭后从本地记录检查");
            }
          }, message -> retryFaceCapture(output, token, message));
        } catch (RuntimeException | OutOfMemoryError setupFailure) {
          retryFaceCapture(pendingOutput, token, "无法启动人脸拍照，请重新开始动作");
        }
      });
    } catch (RuntimeException | OutOfMemoryError unavailableUi) {
      if (pendingUi == null || pendingUi.compareAndSet(true, false)) {
        retryFaceCapture(null, token, "无法启动人脸拍照，请重新开始动作");
      }
    }
  }

  private void retryFaceCapture(File output, long token, String message) {
    VisionCaptureLifecycle.discardTemporary(output);
    if (step != Step.FACE || !canUseUi(token) || !captureLifecycle.canCapture(token)) return;
    faceCaptureStarted = false;
    resetFaceTracking(message);
  }

  private void finishFaceSession(File output) {
    if (!canUseUi(captureLifecycle.generation()) || captureLifecycle.isCompleted()) return;
    try {
      VisionExplorationStore.completeSession(sessionDirectory, kind, faceChallenge, output.getName());
      showCompletion(new String[] { output.getName() }, 1);
    } catch (Exception error) {
      showFatal("无法完成本地演示存档：" + error.getMessage());
    }
  }

  private void showCompletion(String[] fileNames, int fileCount) {
    if (!canUseUi(captureLifecycle.generation()) || !captureLifecycle.markCompleted()) return;
    completedFileCount = fileCount;
    unbindCamera();
    String detail;
    if ("id-card".equals(kind)) detail = "人像面与国徽面已自动确认并保存";
    else if ("bank-card".equals(kind)) detail = "银行卡正面已自动确认并保存";
    else detail = "真人动作已识别，正面照片已自动保存";
    titleView.setText("验证完成");
    instructionView.setText("正在安全返回，稍后可在本地记录中复核或导出");
    statusView.setText(detail);
    stepBadge.setText("AUTO · 已完成");
    if (Step.FACE.equals(step)) scanOverlay.showFace(1f, true);
    else scanOverlay.updateDocument(1f, "已自动确认并保存", true);
    root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
    postCaptureDelayed(captureLifecycle.generation(), () -> deliverSuccess(fileCount), 1250L);
  }

  private void deliverSuccess(int fileCount) {
    if (!captureLifecycle.deliver()) return;
    Intent data = new Intent();
    data.putExtra(RESULT_SESSION_ID, sessionDirectory.getName());
    data.putExtra(RESULT_KIND, kind);
    data.putExtra(RESULT_CHALLENGE, faceChallenge);
    data.putExtra(RESULT_FILE_COUNT, fileCount);
    data.putExtra(RESULT_PRESERVED, true);
    data.putExtra(RESULT_DISCARDED, false);
    terminalResult = true;
    setResult(Activity.RESULT_OK, data);
    finish();
  }

  private void confirmExit() {
    if (!canUseUi(captureLifecycle.generation())) return;
    if (captureLifecycle.isCompleted()) {
      deliverSuccess(completedFileCount);
      return;
    }
    if (sessionDirectory == null) {
      finishCanceled();
      return;
    }
    exitConfirmationPending = true;
    suspendCapture(VisionCaptureLifecycle.EXIT_CONFIRMATION);
    dismissCaptureDialog();
    presentPendingDialog();
  }

  private void showFatal(String message) {
    if (!canControlCapture()) return;
    fatalMessage = message;
    suspendCapture(VisionCaptureLifecycle.FATAL_ERROR);
    dismissCaptureDialog();
    updateReviewActions();
    // Error control must remain reachable even though capture callbacks are suspended.
    runOnUiThread(this::presentPendingDialog);
  }

  private void presentPendingDialog() {
    if (!canControlCapture() || captureLifecycle.isSuspended(VisionCaptureLifecycle.BACKGROUND) || captureDialog != null) return;
    if (fatalMessage != null) {
      captureDialog = new AlertDialog.Builder(this)
        .setTitle("无法继续")
        .setMessage(fatalMessage)
        .setPositiveButton("关闭", (dialog, which) -> { if (captureDialog == dialog) finishAfterError(); })
        .setCancelable(false)
        .show();
    } else if (exitConfirmationPending) {
      captureDialog = new AlertDialog.Builder(this)
        .setTitle("退出本次探索？")
        .setMessage("可以保留已确认照片，稍后从本地记录继续；也可以删除本次记录。")
        .setPositiveButton("退出并删除", (dialog, which) -> { if (captureDialog == dialog) finishCanceled(); })
        .setNeutralButton("保留并退出", (dialog, which) -> { if (captureDialog == dialog) finishCapture(false); })
        .setNegativeButton("继续体验", (dialog, which) -> { if (captureDialog == dialog) resumeAfterExitConfirmation(); })
        .setOnCancelListener(dialog -> { if (captureDialog == dialog) resumeAfterExitConfirmation(); })
        .show();
    }
  }

  private void resumeAfterExitConfirmation() {
    if (!canControlCapture() || !exitConfirmationPending) return;
    exitConfirmationPending = false;
    dismissCaptureDialog();
    captureLifecycle.resume(VisionCaptureLifecycle.EXIT_CONFIRMATION);
    resumeForegroundCapture();
  }

  private void finishCanceled() {
    finishCapture(true);
  }

  private void finishAfterError() {
    if (MODE_REVIEW.equals(mode)) finishReview(false);
    else finishCapture(false);
  }

  private void finishCapture(boolean discardFiles) {
    if (terminalResult) return;
    if (captureLifecycle.isCompleted() || completedFileCount > 0) {
      fatalMessage = null;
      exitConfirmationPending = false;
      dismissCaptureDialog();
      captureLifecycle.resume(VisionCaptureLifecycle.FATAL_ERROR);
      captureLifecycle.resume(VisionCaptureLifecycle.EXIT_CONFIRMATION);
      if (!canUseUi(captureLifecycle.generation())) return;
      if (!captureLifecycle.isCompleted()) {
        // A Bundle hint protects completed records from deletion; it is not proof
        // of disk completion and must never restart scanning when closing an error.
        completedFileCount = 0;
        try {
          if (sessionDirectory == null) sessionDirectory = VisionExplorationStore.resolveSessionDirectory(this, pendingSessionId);
          JSONObject completed = VisionExplorationStore.getCompletedSession(this, sessionDirectory.getName());
          kind = completed.optString("kind", "");
          faceChallenge = completed.optString("challenge", "");
          completedFileCount = completed.getJSONArray("files").length();
          captureLifecycle.markCompleted();
        } catch (Exception unverifiedCompletion) {
          finishCapture(false);
          return;
        }
      }
      deliverSuccess(completedFileCount);
      return;
    }
    if (!captureLifecycle.cancel()) return;
    captureHandler.removeCallbacksAndMessages(null);
    dismissCaptureDialog();
    unbindCamera();
    if (sessionDirectory == null && !pendingSessionId.isEmpty()) {
      try { sessionDirectory = VisionExplorationStore.resolveSessionDirectory(this, pendingSessionId); }
      catch (Exception ignored) { /* Missing/unavailable records are not reported as preserved. */ }
    }
    boolean discarded = false;
    if (discardFiles && sessionDirectory != null) {
      try {
        discarded = VisionExplorationStore.deleteSession(this, sessionDirectory.getName()) && !sessionDirectory.exists();
      } catch (Exception ignored) {
        // A failed/partial delete must not be reported as successful deletion.
      }
    }
    Intent data = new Intent();
    if (sessionDirectory != null) data.putExtra(RESULT_SESSION_ID, sessionDirectory.getName());
    else if (!pendingSessionId.isEmpty()) data.putExtra(RESULT_SESSION_ID, pendingSessionId);
    data.putExtra(RESULT_PRESERVED, sessionDirectory != null && sessionDirectory.exists());
    data.putExtra(RESULT_DISCARDED, discarded);
    terminalResult = true;
    setResult(Activity.RESULT_CANCELED, data);
    finish();
  }

  private String fileNameForStep(Step value) {
    if (value == Step.ID_FRONT) return "id-front.jpg";
    if (value == Step.ID_BACK) return "id-back.jpg";
    return "bank-card-front.jpg";
  }

  private Bitmap decodePreview(File file, int maxWidth) {
    return VisionPreviewDecoder.decode(file, maxWidth);
  }

  private String assessImageQuality(Bitmap bitmap) {
    if (bitmap == null) return "无法读取预览。";
    long count = 0L;
    double sum = 0d;
    double square = 0d;
    int stride = Math.max(1, Math.min(bitmap.getWidth(), bitmap.getHeight()) / 120);
    for (int y = 0; y < bitmap.getHeight(); y += stride) {
      for (int x = 0; x < bitmap.getWidth(); x += stride) {
        int color = bitmap.getPixel(x, y);
        double luminance = 0.2126d * Color.red(color) + 0.7152d * Color.green(color) + 0.0722d * Color.blue(color);
        sum += luminance;
        square += luminance * luminance;
        count++;
      }
    }
    double mean = count == 0 ? 0d : sum / count;
    double variance = count == 0 ? 0d : square / count - mean * mean;
    if (mean < 48d) return "光线偏暗，请调整环境光线。";
    if (mean > 218d) return "画面偏亮，注意卡面反光。";
    if (variance < 620d) return "画面对比度偏低，请调整证卡角度。";
    return String.format(Locale.CHINA, "光线与对比度正常（探索评分 %.0f）", Math.min(99d, 62d + variance / 180d));
  }

  private static final class DocumentAssessment {
    final boolean ready;
    final float quality;
    final String message;

    DocumentAssessment(boolean ready, float quality, String message) {
      this.ready = ready;
      this.quality = quality;
      this.message = message;
    }
  }

  private FrameLayout.LayoutParams matchFrame() {
    return new FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.MATCH_PARENT
    );
  }

  private TextView label(float sp, int color, boolean bold) {
    TextView value = new TextView(this);
    value.setTextSize(sp);
    value.setTextColor(color);
    if (bold) value.setTypeface(value.getTypeface(), android.graphics.Typeface.BOLD);
    return value;
  }

  private GradientDrawable rounded(int color, float radiusDp) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(color);
    drawable.setCornerRadius(dp(radiusDp));
    return drawable;
  }

  private int dp(float value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  @Override
  protected void onDestroy() {
    if (captureLifecycle.destroy()) {
      captureHandler.removeCallbacksAndMessages(null);
      dismissCaptureDialog();
      unbindCamera();
      if (faceDetector != null) faceDetector.close();
      if (textRecognizer != null) textRecognizer.close();
      // Drain already queued analyzers: they see the destroyed owner and close their frames.
      if (cameraExecutor != null) cameraExecutor.shutdown();
      // Session files belong to the workflow, not this Activity instance. Only explicit
      // cancellation discards them; configuration/process recreation restores the checkpoint.
    }
    super.onDestroy();
  }
}
