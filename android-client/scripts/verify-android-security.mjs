import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAndroidUpdateService } from "../../src/modules/system/server/android-update/service.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(projectDir, "..");
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

const updater = read("android/app/src/main/java/local/fanhao/library/FanHaoUpdaterPlugin.java");
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
  rootPackage.scripts?.verify?.includes("verify:android-security"),
  "the root verification chain must run the Android security gate"
);

const buildDebug = read("build-debug.ps1");
assert(buildDebug.includes("JDK 21 is required"), "the Android build must fail closed when JDK 21 is unavailable");
assert(buildDebug.includes("Remove-Item -LiteralPath $resolvedApkPath -Force"), "the Android build must remove stale APK output before running Gradle");
assert(buildDebug.includes("Assert-NativeSucceeded \"Gradle assembleDebug failed\""), "the Android build must reject a non-zero Gradle exit");
assert(buildDebug.includes("Resolve-FanHaoBuildIdentity"), "the Android build must apply the shared version policy before Gradle");
assert(buildDebug.includes("Assert-FanHaoDebugApkIdentity"), "the Android build must verify actual APK package, version, and signer identity");
assert(buildDebug.includes("$Install -and $LocalOnly"), "local-only high version builds must never enter the install path");

const publishDebug = read("publish-debug-update.ps1");
assert(publishDebug.includes("Get-FanHaoDebugPublishPlan"), "publishing must resolve a validated global high-water mark before building");
assert(publishDebug.includes("Publish-FanHaoDebugArtifact"), "publishing must use the verified atomic artifact commit");
assert(publishDebug.includes("FileShare]::None"), "publishing must serialize competing writers for one publish root");

const publishPolicy = read("scripts/FanHaoAndroidPublish.psm1");
assert(publishPolicy.includes("99999999L"), "the project publish namespace must reserve Android versionCode headroom");
assert(publishPolicy.includes("2100000000L"), "local-only builds must still enforce Android's versionCode ceiling");
assert(publishPolicy.includes('"--verbose", "--print-certs"'), "APK identity checks must parse the complete signer set");
assert(publishPolicy.includes("Number of signers"), "APK identity checks must require an explicit signer count");
assert(publishPolicy.includes("[IO.File]::Replace"), "latest.json replacement must be atomic on an existing publish lane");

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
  } finally {
    removeVerifiedTempDir(tempDir);
  }
}

function verifyPowerShellPublishPolicy() {
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(projectDir, "scripts", "verify-debug-publish-policy.ps1")]
    : ["-NoProfile", "-File", path.join(projectDir, "scripts", "verify-debug-publish-policy.ps1")];
  run(shell, args);
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
  const candidates = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", executable) : "",
    process.platform === "win32" ? path.join("C:\\Program Files\\Android\\openjdk\\jdk-21.0.8", "bin", executable) : "",
    executable
  ].filter(Boolean);
  return candidates.find((candidate) => !path.isAbsolute(candidate) || fs.existsSync(candidate)) || executable;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectDir, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed with exit code ${result.status}`);
}
