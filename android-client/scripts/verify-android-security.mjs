import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createAndroidUpdateService } from "../../src/modules/system/server/android-update/service.js";

const scriptProjectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = process.env.FANHAO_ANDROID_SECURITY_PROJECT_DIR
  ? path.resolve(process.env.FANHAO_ANDROID_SECURITY_PROJECT_DIR)
  : scriptProjectDir;
const repoDir = path.resolve(projectDir, "..");
const require = createRequire(import.meta.url);
const javaSourceDir = path.join(
  projectDir,
  "android",
  "app",
  "src",
  "main",
  "java",
  "local",
  "fanhao",
  "library"
);

const config = JSON.parse(read("capacitor.config.json"));
assert.equal(
  config.server?.androidScheme,
  "http",
  "the packaged WebView origin must stay on HTTP until Web Storage and IndexedDB data have an explicit origin migration"
);
assert.equal(config.server?.cleartext, true, "LAN API fetches currently require cleartext support");
assert.equal(config.android?.allowMixedContent, true, "trusted LAN API and media access currently requires mixed-content support");
assert(
  !Object.prototype.hasOwnProperty.call(config.server || {}, "allowNavigation"),
  "production WebView navigation must not grant remote pages access to the Capacitor bridge"
);
const generatedConfigPath = path.join(projectDir, "android", "app", "src", "main", "assets", "capacitor.config.json");
if (fs.existsSync(generatedConfigPath)) {
  const generatedConfig = JSON.parse(fs.readFileSync(generatedConfigPath, "utf8"));
  assert.equal(generatedConfig.server?.androidScheme, "http", "run Capacitor sync before packaging: generated scheme is stale");
  assert(
    !Object.prototype.hasOwnProperty.call(generatedConfig.server || {}, "allowNavigation"),
    "run Capacitor sync before packaging: generated navigation rules are stale"
  );
}

const manifest = read("android/app/src/main/AndroidManifest.xml");
const nativeShortVideoActivity = manifest.match(
  /<activity\b(?=[^>]*android:name="\.NativeShortVideoActivity")[^>]*\/>/s
)?.[0];
assert(nativeShortVideoActivity, "NativeShortVideoActivity manifest entry is missing");
assert(
  /android:exported="false"/.test(nativeShortVideoActivity),
  "NativeShortVideoActivity must not be callable by other apps"
);
assert(!manifest.includes("requestLegacyExternalStorage"), "the app must not opt back into legacy external storage");
for (const permission of ["MANAGE_EXTERNAL_STORAGE", "READ_EXTERNAL_STORAGE", "READ_MEDIA_"]) {
  assert(!manifest.includes(permission), `the SAF-only app must not request ${permission}`);
}
assert(!/android:scheme="file"/i.test(manifest), "text intents must not expose the file URI scheme");

const filePaths = read("android/app/src/main/res/xml/file_paths.xml");
assert(filePaths.includes('<cache-path name="updates" path="updates/" />'), "FileProvider must expose only the update cache lane");
assert(filePaths.includes('<external-files-path name="app_pictures" path="Pictures/" />'), "FileProvider may expose app-specific Pictures");
assert(!filePaths.includes("<external-path"), "FileProvider must not expose shared external storage");
assert.equal((filePaths.match(/<(?:cache-path|external-files-path)\b/g) || []).length, 2, "FileProvider must keep exactly two narrow roots");
const capacitorChromeClient = read("node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeWebChromeClient.java");
assert(
  capacitorChromeClient.includes("getExternalFilesDir(Environment.DIRECTORY_PICTURES)"),
  "app_pictures must remain because Capacitor's camera chooser creates its temporary JPEG there"
);
assert(
  capacitorChromeClient.includes("FileProvider.getUriForFile"),
  "Capacitor's camera chooser must continue sharing its temporary JPEG through FileProvider"
);

const androidVariables = read("android/variables.gradle");
assert(/targetSdkVersion\s*=\s*30\b/.test(androidVariables), "this SAF phase must keep targetSdk 30");

const novelPlugin = read("android/app/src/main/java/local/fanhao/library/FanHaoNovelPlugin.java");
assert(novelPlugin.includes("new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)"), "novel directory scan must use ACTION_OPEN_DOCUMENT_TREE");
assert(novelPlugin.includes("DocumentsContract.buildChildDocumentsUriUsingTree"), "novel directory scan must use DocumentsContract children");
assert(novelPlugin.includes("openTextDirectoryPicker"), "the native bridge must expose openTextDirectoryPicker");
assert(novelPlugin.includes("readScannedTextFile"), "the native bridge must retain content-URI text reads");
assert(novelPlugin.includes('call.getString("uri", "")'), "scanned text reads must accept only the URI contract");
assert(!novelPlugin.includes('call.getString("path"'), "scanned text reads must not accept raw filesystem paths");
assert(!novelPlugin.includes('item.put("path"'), "directory scan results must not expose raw filesystem paths");
assert(novelPlugin.includes("new Intent(Intent.ACTION_OPEN_DOCUMENT);"), "multi-select document import must remain available");
assert(novelPlugin.includes("Intent.EXTRA_ALLOW_MULTIPLE"), "multi-select document import must remain multi-select");
assert(!novelPlugin.includes("takePersistableUriPermission"), "new novel picks must not retain URI grants");
assert(!novelPlugin.includes("FLAG_GRANT_PERSISTABLE_URI_PERMISSION"), "directory and file picks must be one-session grants");
assert(!novelPlugin.includes("getPersistedUriPermissions"), "novel startup must not enumerate grants owned by other app features");
assert(!novelPlugin.includes("releasePersistableUriPermission"), "novel startup must not release grants without per-feature ownership metadata");
assert(novelPlugin.includes("getBridge().executeOnMainThread"), "background document work must settle PluginCall on the main thread");
assert(novelPlugin.includes("call == null || call.isReleased()"), "background document work must not settle a released PluginCall");
for (const obsolete of [
  "android.Manifest",
  "Environment.isExternalStorageManager",
  "Environment.getExternalStorageDirectory",
  "MediaStore.Files",
  "ProcessBuilder(\"find\"",
  "ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION",
  "hasTextScanAccess",
  "requestTextScanAccess",
  "scanTextFiles"
]) {
  assert(!novelPlugin.includes(obsolete), `legacy unrestricted scan code must stay removed: ${obsolete}`);
}

const novelViews = read("www/modules/novels/novel-views.js");
assert(novelViews.includes('busyButtonLabel("scan", "目录")'), "novel UI must label directory scanning as 目录");
assert(novelViews.includes('smartImport.title = "选择一个目录扫描 TXT"'), "novel UI must explain the scoped directory choice");
assert(novelViews.includes("plugin.openTextDirectoryPicker"), "novel UI must call the directory picker bridge");
assert(novelViews.includes('plugin.readScannedTextFile({ uri: item.uri || "" })'), "novel UI must read scan results by content URI only");
for (const obsolete of ["hasTextScanAccess", "requestTextScanAccess", "plugin.scanTextFiles", "item.path"]) {
  assert(!novelViews.includes(obsolete), `novel UI must not retain legacy scan state: ${obsolete}`);
}

const updater = read("android/app/src/main/java/local/fanhao/library/FanHaoUpdaterPlugin.java");
assert(updater.includes('new File(getContext().getCacheDir(), "updates")'), "the update cache FileProvider root must match the updater's private cache lane");
assert(updater.includes("AndroidUpdatePolicy.requireTrustedDownloadUrl(rawUrl, rawServiceBase)"), "updater must enforce trusted update URLs");
assert(updater.includes('call.getString("serviceBase")'), "updater must require the explicit active service base");
assert(updater.includes("AndroidUpdatePolicy.requireSha256"), "updater must require a valid SHA-256");
assert(updater.includes("connection.setInstanceFollowRedirects(false)"), "updater must not follow unchecked redirects");
assert(!updater.includes("normalizeSha256"), "updater must not normalize an invalid SHA-256 to an empty optional value");
assert(!updater.includes("!expectedSha256.isEmpty()"), "SHA-256 verification must never be optional");
assert(updater.includes("AndroidUpdatePolicy.requireExpectedVersionCode"), "updater must require the expected APK versionCode");
assert(updater.includes("AndroidUpdatePolicy.requireExpectedVersionName"), "updater must require the expected APK versionName");
assert(updater.includes("AndroidUpdatePolicy.requireExpectedSize"), "updater must require the expected APK size");
assert(updater.includes("downloadedSize > expectedSize"), "updater must stop oversized APK streams");
assert(updater.includes("downloadedSize != expectedSize || apk.length() != expectedSize"), "updater must verify streamed and stored APK sizes");
assert(
  updater.includes("AndroidUpdatePackageVerifier.requireInstallableUpdate"),
  "updater must verify APK identity before opening the installer"
);

const versionContract = JSON.parse(read("version.json"));
assert.equal(versionContract.schemaVersion, 1, "the Android version contract schema must be explicit");
assert.equal(versionContract.packageName, "local.fanhao.library", "the version contract must bind the application package");
assert.equal(versionContract.channel, "debug", "the version contract must bind the supported publish lane");
assert(Number.isSafeInteger(versionContract.currentVersionCode), "the tracked default versionCode must be an integer");
assert(Number.isSafeInteger(versionContract.highWaterVersionCode), "the tracked publish floor must be an integer");
assert(versionContract.highWaterVersionCode >= 26081190, "the tracked publish floor must include the reviewed 26081190 baseline");
assert.equal(typeof versionContract.defaultVersionName, "string", "the tracked default versionName must be a string");
assert.equal(versionContract.defaultVersionName, versionContract.defaultVersionName.trim(), "the tracked default versionName must be canonical");
assert(versionContract.defaultVersionName.length > 0, "the tracked default versionName must not be empty");
assert.equal(
  versionContract.currentVersionCode,
  versionContract.highWaterVersionCode,
  "the tracked default version and publish floor must advance together"
);
verifyVersionContractDoesNotDecrease(versionContract);
const downloadMethodStart = updater.indexOf("private File downloadApk(");
const packageVerificationIndex = updater.indexOf("AndroidUpdatePackageVerifier.requireInstallableUpdate", downloadMethodStart);
const verifiedReturnIndex = updater.indexOf("return apk;", packageVerificationIndex);
assert(
  downloadMethodStart >= 0 && packageVerificationIndex > downloadMethodStart && verifiedReturnIndex > packageVerificationIndex,
  "the downloaded APK must pass package verification before it can reach the installer"
);

const packageVerifier = read("android/app/src/main/java/local/fanhao/library/AndroidUpdatePackageVerifier.java");
assert(packageVerifier.includes("Context context"), "package verifier must receive the installed app identity through an explicit Context");
assert(packageVerifier.includes("getPackageArchiveInfo"), "package verifier must parse the downloaded APK archive");
assert(packageVerifier.includes("PackageManager.GET_SIGNING_CERTIFICATES"), "API 28+ must read rotation-aware signing identity");
assert(packageVerifier.includes("PackageManager.GET_SIGNATURES"), "API 24-27 must retain legacy signer compatibility");
assert(packageVerifier.includes("Build.VERSION_CODES.TIRAMISU"), "API 33+ package-info flags must be guarded");

const mainActivity = read("android/app/src/main/java/local/fanhao/library/MainActivity.java");
assert(mainActivity.includes("if (!isSupportedWebDownloadUri(uri))"), "WebView downloads must be validated before enqueueing");
assert(mainActivity.includes('"http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)'), "WebView downloads must reject non-HTTP schemes");
assert(mainActivity.includes("uri.getUserInfo() == null"), "WebView downloads must reject credential-bearing hosts");

const webApp = read("www/app.js");
assert(webApp.includes("serviceBase: activeUrl"), "the WebView updater call must bind downloads to the active service origin");
assert(webApp.includes("versionCode: Number(androidUpdateInfo.versionCode || 0)"), "the WebView updater call must bind the expected versionCode");
assert(webApp.includes("versionName: String(androidUpdateInfo.versionName || \"\")"), "the WebView updater call must bind the expected versionName");
assert(webApp.includes("size: Number(androidUpdateInfo.size || 0)"), "the WebView updater call must bind the expected APK size");

const rootPackage = JSON.parse(readRepo("package.json"));
assert(rootPackage.scripts?.["verify:android-security"], "the root verifier must expose the Android security gate");
assert(
  rootPackage.scripts?.["preverify:android-security"]?.includes("--include=dev"),
  "the clean Android security gate must install its lock-pinned Capacitor CLI even when npm omits dev dependencies by default"
);
assert(
  rootPackage.scripts?.verify?.includes("verify:android-security"),
  "the root verification chain must run the Android security gate"
);

const buildDebug = read("build-debug.ps1");
assert(buildDebug.includes("JDK 21 is required"), "the Android build must fail closed when JDK 21 is unavailable");
assert(buildDebug.includes("Remove-Item -LiteralPath $resolvedApkPath -Force"), "the Android build must remove stale APK output before running Gradle");
assert(buildDebug.includes("Assert-NativeSucceeded \"Gradle assembleDebug failed\""), "the Android build must reject a non-zero Gradle exit");
assert(buildDebug.includes("Resolve-FanHaoBuildIdentity"), "the Android build must apply the shared version policy before Gradle");
assert(buildDebug.includes("Read-FanHaoVersionContract"), "no-argument Android builds must read the tracked version contract");
assert(buildDebug.includes("$VersionContract.CurrentVersionCode"), "no-argument Android builds must use the tracked current versionCode");
assert(buildDebug.includes("$VersionContract.DefaultVersionName"), "no-argument Android builds must use the tracked default versionName");
assert(buildDebug.includes("Assert-FanHaoInstallIdentity"), "the build entry must apply the shared tracked-identity install gate");
assert(buildDebug.includes("$Install -and $IdentityOnly"), "identity-only probing must never silently replace an install request");
assert(buildDebug.includes("function Test-FanHaoAuthorizedAdbDeviceLine"), "the build entry must use a dedicated authorized-ADB device parser");
assert(buildDebug.includes("'^\\S+\\s+device(?:\\s|$)'"), "the ADB parser must accept only a non-empty serial followed by the exact device state");
assert(buildDebug.includes('"-PfanhaoLocalOnly=true"'), "the validated local-only build path must explicitly authorize Gradle's reserved namespace");
assert(buildDebug.includes("Assert-FanHaoDebugApkIdentity"), "the Android build must verify actual APK package, version, and signer identity");
assert(buildDebug.includes("$Install -and $LocalOnly"), "local-only high version builds must never enter the install path");

const appGradle = read("android/app/build.gradle");
assert(appGradle.includes('file("../../version.json")'), "direct Gradle and Android Studio builds must read the tracked version contract");
assert(appGradle.includes("versionContract.currentVersionCode"), "Gradle must use the contract current version as its default code");
assert(appGradle.includes("versionContract.defaultVersionName"), "Gradle must use the contract default versionName");
assert(!appGradle.includes('?: "1"'), "Gradle must not retain the legacy versionCode 1 fallback");
assert(!appGradle.includes('?: "1.0"'), "Gradle must not retain the legacy versionName 1.0 fallback");
assert(appGradle.includes("fanhaoVersionCode above 99999999 requires the explicit fanhaoLocalOnly=true build path"), "direct Gradle builds must reject unmarked high version codes");
assert(appGradle.includes("fanhao-debug-local-only-pending"), "an explicitly local-only Gradle build must leave a sidecar before it can finish");

const publishDebug = read("publish-debug-update.ps1");
assert(publishDebug.includes("Get-FanHaoDebugPublishPlan"), "publishing must resolve a validated global high-water mark before building");
assert(publishDebug.includes("Publish-FanHaoDebugArtifact"), "publishing must use the verified atomic artifact commit");
assert(publishDebug.includes("FileShare]::None"), "publishing must serialize competing writers for one publish root");
assert(publishDebug.includes("does not install a newly selected identity"), "publishing must not bypass the reviewed install identity contract");
assert(publishDebug.includes("New-FanHaoAuthorizedDeviceCheck"), "a real publish must create a scope-safe authorized ADB device checker");
const planOnlyExitIndex = publishDebug.indexOf('if ($PlanOnly)');
const buildInvocationIndex = publishDebug.indexOf("& $BuildScript @buildArgs");
const publishCommitIndex = publishDebug.indexOf("Publish-FanHaoDebugArtifact");
const deviceCheckInvocationIndexes = [...publishDebug.matchAll(/& \$authorizedDeviceCheck\b/g)].map((match) => match.index);
assert.equal(deviceCheckInvocationIndexes.length, 3, "publishing must invoke the same scope-safe device checker exactly three times");
const [firstAdbPreflightIndex, secondAdbPreflightIndex, commitBoundaryAdbIndex] = deviceCheckInvocationIndexes;
assert(firstAdbPreflightIndex > planOnlyExitIndex && firstAdbPreflightIndex < buildInvocationIndex, "ADB visibility must be checked before the publish build starts");
assert(secondAdbPreflightIndex > buildInvocationIndex && secondAdbPreflightIndex < publishCommitIndex, "the same ADB device set must be rechecked after the build and before atomic publish");
assert(commitBoundaryAdbIndex > secondAdbPreflightIndex && commitBoundaryAdbIndex < publishCommitIndex && publishDebug.includes('if ($CurrentStage -eq "BeforeManifestCommit")'), "the captured ADB checker must run again at the module's exact manifest commit boundary");

const publishPolicy = read("scripts/FanHaoAndroidPublish.psm1");
assert(publishPolicy.includes("99999999L"), "the project publish namespace must reserve Android versionCode headroom");
assert(publishPolicy.includes("2100000000L"), "local-only builds must still enforce Android's versionCode ceiling");
assert(publishPolicy.includes('"--verbose", "--print-certs"'), "APK identity checks must parse the complete signer set");
assert(publishPolicy.includes("Number of signers"), "APK identity checks must require an explicit signer count");
assert(publishPolicy.includes("[IO.File]::Replace"), "latest.json replacement must be atomic on an existing publish lane");
assert(publishPolicy.includes("Read-FanHaoVersionContract"), "publish planning must include the tracked version floor");
assert(publishPolicy.includes("ignored-build-output"), "scratch build output must not define durable publish history");
assert(publishPolicy.includes("-Install requires the tracked Android version contract identity"), "the shared install policy must reject identities above the reviewed contract");

const androidIndex = read("www/index.html");
assert(
  !androidIndex.toLowerCase().includes("xc213618.ddns.me"),
  "the Android server picker must not advertise an unsupported public DDNS endpoint"
);

const androidGuide = readRepo("docs/android-client.md");
assert(
  androidGuide.includes("当前 Android 客户端仅支持本机、局域网或可信私网服务"),
  "the Android guide must state the trusted-network support boundary"
);
assert(
  androidGuide.includes("不要通过手工复制浏览器 / App Cookie"),
  "the Android guide must not present copied cookies as a supported remote login flow"
);
assert(
  androidGuide.includes("HTTPS 与正式的配对 / bearer token 流程"),
  "the Android guide must reserve remote access for an authenticated HTTPS pairing flow"
);

const androidReadme = read("README.md");
assert(
  androidReadme.includes("Android 客户端目前没有可用的远程登录或配对通道"),
  "the Android README must not imply that remote access currently works"
);

const configurationGuide = readRepo("docs/configuration.md");
assert(
  configurationGuide.includes("在可信代理机制实现并验证前，禁止把 29998 放到 loopback / LAN 反向代理后再对公网暴露"),
  "the configuration guide must explicitly forbid unsafe public reverse proxying"
);
assert(
  configurationGuide.includes("公网请求会被误判为 `local` / `lan` 并绕过远程登录"),
  "the reverse-proxy warning must explain the authentication bypass"
);

verifyJavaPolicy();
verifyGradleVersionPolicy();
verifyPowerShellPublishPolicy();
verifyAndroidUpdateServing();
console.log("android-security: origin compatibility, trusted-network boundary, native bridge, and update policy verified");

function read(relativePath) {
  return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
}

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoDir, relativePath), "utf8");
}

function verifyJavaPolicy() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-android-security-"));
  try {
    const javac = javaTool("javac");
    const java = javaTool("java");
    run(javac, [
      "-encoding",
      "UTF-8",
      "-d",
      tempDir,
      path.join(javaSourceDir, "AndroidUpdatePolicy.java"),
      path.join(projectDir, "scripts", "AndroidUpdatePolicyVerifier.java")
    ]);
    run(java, ["-cp", tempDir, "local.fanhao.library.AndroidUpdatePolicyVerifier"]);
    run(javac, [
      "-encoding",
      "UTF-8",
      "-d",
      tempDir,
      path.join(javaSourceDir, "DocumentTreeScanner.java"),
      path.join(javaSourceDir, "BoundedTextReader.java"),
      path.join(projectDir, "scripts", "DocumentTreeScannerVerifier.java")
    ]);
    run(java, ["-cp", tempDir, "local.fanhao.library.DocumentTreeScannerVerifier"]);
  } finally {
    removeVerifiedTempDir(tempDir);
  }
}
function verifyPowerShellPublishPolicy() {
  const script = path.join(projectDir, "scripts", "verify-debug-publish-policy.ps1");
  const shells = process.platform === "win32"
    ? [
        { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] },
        { command: "pwsh.exe", args: ["-NoProfile", "-File", script] }
      ]
    : [{ command: "pwsh", args: ["-NoProfile", "-File", script] }];
  for (const shell of shells) {
    console.log(`android-security: running publish policy fixtures with ${shell.command}`);
    run(shell.command, shell.args);
  }
}

function verifyGradleVersionPolicy() {
  const disposableProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-android-gradle-security-"));
  const javaHome = resolveJava21Home();
  const sdkRoot = process.env.ANDROID_SDK_ROOT
    || process.env.ANDROID_HOME
    || (process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk") : "");
  assert(sdkRoot && fs.existsSync(sdkRoot), "Android SDK is required for the Gradle version policy fixture");
  try {
    prepareDisposableAndroidProject(disposableProjectDir);
    const androidDir = path.join(disposableProjectDir, "android");
    const generatedCordovaVariablesPath = path.join(
      androidDir,
      "capacitor-cordova-android-plugins",
      "cordova.variables.gradle"
    );
    assert(
      fs.statSync(generatedCordovaVariablesPath, { throwIfNoEntry: false })?.isFile(),
      "the disposable Capacitor sync must create the Cordova Gradle bridge before policy checks"
    );
    const javaExecutable = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
    const wrapperJar = path.join(androidDir, "gradle", "wrapper", "gradle-wrapper.jar");
    const result = run(
      javaExecutable,
      ["-classpath", wrapperJar, "org.gradle.wrapper.GradleWrapperMain", ":app:verifyFanHaoVersionPolicy", "--no-daemon"],
      {
        cwd: androidDir,
        env: {
          ...process.env,
          JAVA_HOME: javaHome,
          ANDROID_HOME: sdkRoot,
          ANDROID_SDK_ROOT: sdkRoot,
          PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`
        }
      }
    );
    assert(
      `${result.stdout || ""}\n${result.stderr || ""}`.includes("fanhao-gradle-version-policy: 10 boundary, marker, and contract checks passed"),
      "the Gradle subprocess must execute the version namespace behavior fixture"
    );
  } finally {
    removeVerifiedTempDir(disposableProjectDir);
  }
}

function prepareDisposableAndroidProject(disposableProjectDir) {
  const sourceAndroidDir = path.join(projectDir, "android");
  const disposableAndroidDir = path.join(disposableProjectDir, "android");
  fs.cpSync(sourceAndroidDir, disposableAndroidDir, {
    recursive: true,
    filter(sourcePath) {
      const relativePath = path.relative(sourceAndroidDir, sourcePath);
      if (!relativePath) return true;
      const segments = relativePath.split(path.sep);
      if ([".gradle", "build", "capacitor-cordova-android-plugins"].includes(segments[0])) return false;
      if (segments[0] === "app" && segments[1] === "build") return false;
      return path.basename(sourcePath) !== "local.properties";
    }
  });
  for (const fileName of ["capacitor.config.json", "package.json", "package-lock.json", "version.json"]) {
    fs.copyFileSync(path.join(projectDir, fileName), path.join(disposableProjectDir, fileName));
  }
  const disposableWebDir = path.join(disposableProjectDir, "www");
  fs.mkdirSync(disposableWebDir);
  fs.writeFileSync(path.join(disposableWebDir, "index.html"), "<!doctype html><html><head></head><body></body></html>\n");

  const localNodeModules = fs.realpathSync.native(path.join(projectDir, "node_modules"));
  fs.symlinkSync(localNodeModules, path.join(disposableProjectDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const expectedCliRoot = fs.realpathSync.native(path.join(localNodeModules, "@capacitor", "cli"));
  const capacitorCli = fs.realpathSync.native(require.resolve("@capacitor/cli/bin/capacitor"));
  const cliRelativePath = path.relative(expectedCliRoot, capacitorCli);
  assert(
    cliRelativePath && !cliRelativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(cliRelativePath),
    "the Android security sync must use android-client's lock-pinned Capacitor CLI"
  );
  run(process.execPath, [capacitorCli, "sync", "android"], { cwd: disposableProjectDir });
}

function verifyVersionContractDoesNotDecrease(currentContract) {
  const shallowResult = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repoDir, encoding: "utf8" });
  assert.equal(shallowResult.status, 0, "the Android version verifier requires Git repository metadata");
  const isShallow = shallowResult.stdout.trim() === "true";

  const logResult = spawnSync(
    "git",
    ["log", "--all", "--format=%H", "--", "android-client/version.json"],
    { cwd: repoDir, encoding: "utf8" }
  );
  assert.equal(logResult.status, 0, "the Android version verifier could not read version contract history");
  const commits = logResult.stdout.split(/\r?\n/).filter(Boolean);
  const historicalFloors = commits.map((commit) => {
    const result = spawnSync(
      "git",
      ["show", `${commit}:android-client/version.json`],
      { cwd: repoDir, encoding: "utf8" }
    );
    assert.equal(result.status, 0, `the Android version verifier could not read ${commit}`);
    const historical = JSON.parse(result.stdout);
    assert(Number.isSafeInteger(historical.highWaterVersionCode), `historical Android version floor is invalid in ${commit}`);
    return historical.highWaterVersionCode;
  });

  assertVersionFloorHistory(currentContract.highWaterVersionCode, historicalFloors, isShallow);
  assert.throws(
    () => assertVersionFloorHistory(26081189, [26081190, 26081191], false),
    /must not decrease/,
    "a decrease hidden behind multiple commits must fail closed"
  );
  assert.throws(
    () => assertVersionFloorHistory(26081190, [], true),
    /full Git history/,
    "a shallow checkout with unavailable baseline history must fail closed"
  );
}

function assertVersionFloorHistory(currentFloor, historicalFloors, isShallow) {
  assert.equal(isShallow, false, "the Android version verifier requires full Git history; shallow history cannot prove the floor");
  if (historicalFloors.length === 0) {
    assert.equal(currentFloor, 26081190, "the initial tracked Android version floor must be the reviewed 26081190 baseline");
    return;
  }
  const historicalMaximum = Math.max(...historicalFloors);
  assert(currentFloor >= historicalMaximum, `the tracked Android version floor must not decrease below reachable history (${historicalMaximum})`);
}

function verifyAndroidUpdateServing() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-android-serving-"));
  try {
    const updateDir = path.join(tempDir, "android-update");
    const debugDir = path.join(updateDir, "debug");
    fs.mkdirSync(debugDir, { recursive: true });
    const authorizedName = "fanhao-debug-26081191.apk";
    const orphanName = "fanhao-debug-26081192.apk";
    fs.writeFileSync(path.join(debugDir, authorizedName), "authorized");
    fs.writeFileSync(path.join(debugDir, orphanName), "orphan");
    fs.writeFileSync(
      path.join(debugDir, "latest.json"),
      JSON.stringify({ channel: "debug", apkFile: authorizedName, versionCode: 26081191 })
    );

    const service = createAndroidUpdateService({
      clampInteger(value, fallback, minimum, maximum) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback;
      },
      normalizeExt: (value) => path.extname(value).toLowerCase(),
      notFound(res) {
        res.writeHead(404, {});
        res.end();
      },
      port: 29998,
      readJsonFile(filePath, fallback) {
        try {
          return JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch {
          return fallback;
        }
      },
      safeChildPath(parent, child) {
        const resolvedParent = path.resolve(parent);
        const resolvedChild = path.resolve(parent, child);
        return path.dirname(resolvedChild) === resolvedParent ? resolvedChild : null;
      },
      updateDir
    });
    const request = { method: "HEAD", headers: { host: "127.0.0.1:29998" }, socket: { encrypted: false } };

    const authorized = responseRecorder();
    service.serveApk(request, authorized, "debug", encodeURIComponent(authorizedName));
    assert.equal(authorized.statusCode, 200, "latest.json must authorize its exact APK");

    const orphan = responseRecorder();
    service.serveApk(request, orphan, "debug", encodeURIComponent(orphanName));
    assert.equal(orphan.statusCode, 404, "an orphan APK must not be downloadable before latest.json commits");

    fs.writeFileSync(path.join(debugDir, "latest.json"), "{}");
    const invalidManifest = responseRecorder();
    service.serveApk(request, invalidManifest, "debug", encodeURIComponent(authorizedName));
    assert.equal(invalidManifest.statusCode, 404, "an invalid manifest must authorize no APK downloads");
  } finally {
    removeVerifiedTempDir(tempDir);
  }
}

function responseRecorder() {
  return {
    statusCode: 0,
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end() {}
  };
}

function removeVerifiedTempDir(tempDir) {
  if (!fs.existsSync(tempDir)) return;
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const target = fs.realpathSync.native(tempDir);
  const normalizeForComparison = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedRoot = normalizeForComparison(tempRoot);
  const normalizedTarget = normalizeForComparison(target);
  assert.notEqual(normalizedTarget, normalizedRoot, "refusing to remove the temp root");
  assert(
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`),
    `refusing to remove a directory outside the temp root: ${target}`
  );
  fs.rmSync(target, { recursive: true, force: true });
}

function javaTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  return path.join(resolveJava21Home(), "bin", executable);
}

function resolveJava21Home() {
  const candidates = [
    process.platform === "win32" ? "C:\\Program Files\\Android\\openjdk\\jdk-21.0.8" : "",
    process.env.JAVA_HOME || ""
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const java = path.join(candidate, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (!fs.existsSync(java)) continue;
    const result = spawnSync(java, ["-version"], { encoding: "utf8" });
    const versionOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status === 0 && /version\s+"21(?:\.|\")/.test(versionOutput)) {
      return candidate;
    }
  }
  assert.fail("JDK 21 is required for Android security verification");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd || projectDir, env: options.env || process.env, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed with exit code ${result.status}`);
  return result;
}
