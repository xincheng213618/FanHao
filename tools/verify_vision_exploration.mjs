import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

let checks = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

const mainActivity = read("android-client/android/app/src/main/java/local/fanhao/library/MainActivity.java");
const plugin = read("android-client/android/app/src/main/java/local/fanhao/library/FanHaoVisionExplorationPlugin.java");
const activity = read("android-client/android/app/src/main/java/local/fanhao/library/NativeVisionExplorationActivity.java");
const overlay = read("android-client/android/app/src/main/java/local/fanhao/library/VisionScanOverlayView.java");
const store = read("android-client/android/app/src/main/java/local/fanhao/library/VisionExplorationStore.java");
const manifest = read("android-client/android/app/src/main/AndroidManifest.xml");
const backupRules = read("android-client/android/app/src/main/res/xml/backup_rules.xml");
const filePaths = read("android-client/android/app/src/main/res/xml/file_paths.xml");
const gradle = read("android-client/android/app/build.gradle");
const toolViews = read("android-client/www/modules/tools/tool-views.js");

assert(mainActivity.includes("registerPlugin(FanHaoVisionExplorationPlugin.class)"), "native vision plugin is not registered");
assert(plugin.includes('@CapacitorPlugin(name = "FanHaoVisionExploration")'), "Capacitor plugin name is missing");
for (const method of ["startDocumentScan", "startFaceVerification", "listSessions", "openSession", "deleteSession"]) {
  assert(plugin.includes(`void ${method}(`), `native plugin method is missing: ${method}`);
}

assert(activity.includes('MODE_DOCUMENT = "document"'), "document exploration mode is missing");
assert(activity.includes('MODE_FACE = "face"'), "face exploration mode is missing");
assert(activity.includes('MODE_REVIEW = "review"'), "saved-session review mode is missing");
for (const kind of ["id-card", "bank-card", "face-verification"]) {
  assert(activity.includes(`"${kind}"`), `exploration kind is missing: ${kind}`);
}
assert(activity.includes("setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)"), "face action classification is missing");
assert(activity.includes("faceChallengeTurn = secureRandom.nextBoolean()"), "random face challenge is missing");
assert(activity.includes("activeFaceTrackingId"), "face action sequence is not bound to a tracked face");
assert(activity.includes("smileProbability < 0.45f"), "smile challenge is missing its neutral-expression baseline");
assert(activity.includes("analyzeDocument(ImageProxy"), "automatic document frame analysis is missing");
assert(activity.includes("stableDuration >= 1050L"), "automatic document stability gate is missing");
assert(activity.includes("captureDocumentAutomatically"), "automatic document capture is missing");
assert(activity.includes("setCropAspectRatio(new Rational(856, 540))"), "saved document photos are not cropped to the card aspect ratio");
assert(!activity.includes("确认使用这张照片？"), "document flow still requires manual photo confirmation");
assert(!activity.includes("captureButton"), "document flow still exposes a manual shutter button");
assert(activity.includes("身份证（人像面 → 国徽面）"), "portrait-to-emblem ID sequence is missing");
assert(activity.includes("人像面已识别并自动确认"), "portrait-side automatic confirmation is missing");
assert(activity.includes("国徽面已识别并自动确认"), "emblem-side automatic confirmation is missing");
assert(activity.includes("ChineseTextRecognizerOptions"), "local Chinese ID-side recognition is missing");
assert(activity.includes('countKeywords(recognized, "姓名", "性别", "民族"'), "portrait-side keyword validation is missing");
assert(activity.includes('countKeywords(recognized, "中华人民共和国", "居民身份证"'), "emblem-side keyword validation is missing");
assert(activity.includes("不代表证件、银行卡或真人身份认证通过"), "demo-only completion warning is missing");
assert(activity.includes("本地演示复核"), "saved-photo review screen is missing");
assert(activity.includes("ACTION_SEND_MULTIPLE"), "multi-photo export flow is missing");
assert(activity.includes("FLAG_GRANT_READ_URI_PERMISSION"), "export flow is missing temporary read permission");
for (const guide of ["GUIDE_ID_PORTRAIT", "GUIDE_ID_EMBLEM", "GUIDE_BANK_CARD"]) {
  assert(overlay.includes(guide), `visual document guide is missing: ${guide}`);
}
assert(overlay.includes("Color.argb(192, 0, 0, 0)"), "professional dark scan mask is missing");
assert(overlay.includes("LinearGradient"), "animated scan-light effect is missing");
assert(overlay.includes("drawOrbitParticles"), "face orbit guidance effect is missing");

assert(store.includes('ROOT_NAME = "vision-exploration"'), "private exploration root is missing");
assert(store.includes("getFilesDir()"), "exploration files must remain in app-private storage");
assert(store.includes("getCanonicalFile()"), "session deletion must validate canonical paths");
assert(store.includes("getCompletedSession"), "completed session validation is missing");
assert(manifest.includes('android.permission.CAMERA'), "camera permission is missing");
assert(manifest.includes('android:name=".NativeVisionExplorationActivity"'), "native exploration activity is missing");
assert(manifest.includes('android:fullBackupContent="@xml/backup_rules"'), "sensitive-photo backup policy is missing");
assert(backupRules.includes('domain="file" path="vision-exploration/"'), "sensitive photo directory is not excluded from Android backup");
assert(filePaths.includes('name="vision_exploration_exports" path="vision-exploration/"'), "scoped FileProvider export path is missing");
for (const dependency of [
  "androidx.camera:camera-core",
  "androidx.camera:camera-camera2",
  "androidx.camera:camera-lifecycle",
  "androidx.camera:camera-view",
  "com.google.mlkit:face-detection",
  "com.google.mlkit:text-recognition-chinese"
]) {
  assert(gradle.includes(dependency), `Android dependency is missing: ${dependency}`);
}

for (const label of ["证卡扫描", "人脸与真人验证", "身份证人像面→国徽面", "自动扫描"]) {
  assert(toolViews.includes(label), `Android tool copy is missing: ${label}`);
}
assert(toolViews.includes('runExploration("startDocumentScan")'), "document tool launcher is missing");
assert(toolViews.includes('runExploration("startFaceVerification")'), "face tool launcher is missing");
assert(toolViews.includes("plugin.openSession"), "saved-session review action is missing");
assert(toolViews.includes("不代表真实认证结果"), "tool-page demo warning is missing");

console.log(`vision-exploration-verification: ${checks} structure, separation, storage, review, and disclaimer checks passed`);
