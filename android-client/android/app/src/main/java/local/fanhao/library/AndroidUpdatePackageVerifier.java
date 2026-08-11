package local.fanhao.library;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;

import java.io.File;
import java.security.MessageDigest;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

final class AndroidUpdatePackageVerifier {
  private AndroidUpdatePackageVerifier() {}

  static void requireInstallableUpdate(
    Context context,
    File apk,
    long expectedVersionCode,
    String expectedVersionName
  ) throws Exception {
    PackageManager packageManager = context.getPackageManager();
    PackageInfo installed = installedPackageInfo(packageManager, context.getPackageName());
    PackageInfo archive = archivePackageInfo(packageManager, apk);
    AndroidUpdatePolicy.requireInstallableUpdate(
      packageIdentity(installed),
      packageIdentity(archive),
      expectedVersionCode,
      expectedVersionName
    );
  }

  private static PackageInfo installedPackageInfo(PackageManager packageManager, String packageName) throws Exception {
    int flags = signingFlags();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return packageManager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(flags));
    }
    return legacyInstalledPackageInfo(packageManager, packageName, flags);
  }

  private static PackageInfo archivePackageInfo(PackageManager packageManager, File apk) {
    int flags = signingFlags();
    PackageInfo info;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      info = packageManager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.PackageInfoFlags.of(flags));
    } else {
      info = legacyArchivePackageInfo(packageManager, apk, flags);
    }
    if (info == null) throw new IllegalArgumentException("无法读取安装包身份");
    return info;
  }

  @SuppressWarnings("deprecation")
  private static PackageInfo legacyInstalledPackageInfo(
    PackageManager packageManager,
    String packageName,
    int flags
  ) throws Exception {
    return packageManager.getPackageInfo(packageName, flags);
  }

  @SuppressWarnings("deprecation")
  private static PackageInfo legacyArchivePackageInfo(PackageManager packageManager, File apk, int flags) {
    return packageManager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
  }

  private static int signingFlags() {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
      ? PackageManager.GET_SIGNING_CERTIFICATES
      : legacySigningFlags();
  }

  @SuppressWarnings("deprecation")
  private static int legacySigningFlags() {
    return PackageManager.GET_SIGNATURES;
  }

  private static AndroidUpdatePolicy.PackageIdentity packageIdentity(PackageInfo info) throws Exception {
    SigningIdentity signingIdentity = signingIdentity(info);
    return new AndroidUpdatePolicy.PackageIdentity(
      info.packageName,
      versionCode(info),
      info.versionName,
      signingIdentity.currentSigners,
      signingIdentity.signingHistory,
      signingIdentity.multipleSigners
    );
  }

  @SuppressWarnings("deprecation")
  private static long versionCode(PackageInfo info) {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
  }

  private static SigningIdentity signingIdentity(PackageInfo info) throws Exception {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      SigningInfo signingInfo = info.signingInfo;
      if (signingInfo == null) throw new IllegalArgumentException("安装包缺少签名证书");
      boolean multipleSigners = signingInfo.hasMultipleSigners();
      Signature[] current = signingInfo.getApkContentsSigners();
      Signature[] history = multipleSigners ? current : signingInfo.getSigningCertificateHistory();
      return new SigningIdentity(certificateDigests(current), certificateDigests(history), multipleSigners);
    }
    return legacySigningIdentity(info);
  }

  @SuppressWarnings("deprecation")
  private static SigningIdentity legacySigningIdentity(PackageInfo info) throws Exception {
    Set<String> signers = certificateDigests(info.signatures);
    return new SigningIdentity(signers, signers, signers.size() > 1);
  }

  private static Set<String> certificateDigests(Signature[] signatures) throws Exception {
    Set<String> digests = new LinkedHashSet<>();
    if (signatures == null) return digests;
    for (Signature signature : signatures) {
      if (signature == null) continue;
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      digests.add(hex(digest.digest(signature.toByteArray())));
    }
    return digests;
  }

  private static String hex(byte[] bytes) {
    StringBuilder builder = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) {
      builder.append(String.format(Locale.ROOT, "%02x", value & 0xff));
    }
    return builder.toString();
  }

  private static final class SigningIdentity {
    final Set<String> currentSigners;
    final Set<String> signingHistory;
    final boolean multipleSigners;

    SigningIdentity(Set<String> currentSigners, Set<String> signingHistory, boolean multipleSigners) {
      this.currentSigners = currentSigners;
      this.signingHistory = signingHistory;
      this.multipleSigners = multipleSigners;
    }
  }
}
