package local.fanhao.library;

import java.util.Set;

public final class AndroidUpdatePolicyVerifier {
  private static int checks = 0;

  public static void main(String[] args) {
    String sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expectEqual(sha, AndroidUpdatePolicy.requireSha256(sha.toUpperCase()), "SHA-256 must normalize to lowercase");
    expectAllowed(
      "http://192.168.31.86:29998/api/android/update/apk/debug/fanhao-debug-42.apk",
      "http://192.168.31.86:29998"
    );
    expectAllowed(
      "https://example.com/api/android/update/apk/release/fanhao-release-42.apk",
      "https://example.com:443"
    );

    expectRejected(() -> AndroidUpdatePolicy.requireSha256(null), "missing SHA-256");
    expectRejected(() -> AndroidUpdatePolicy.requireSha256("abcd"), "short SHA-256");
    expectRejected(
      () -> AndroidUpdatePolicy.requireSha256("z123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      "non-hex SHA-256"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "ftp://example.com/api/android/update/apk/debug/fanhao.apk",
        "https://example.com"
      ),
      "non-HTTP scheme"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "https://evil.example/api/android/update/apk/debug/fanhao.apk",
        "https://example.com"
      ),
      "cross-origin host"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "http://example.com/api/android/update/apk/debug/fanhao.apk",
        "https://example.com"
      ),
      "cross-origin scheme"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "https://example.com:444/api/android/update/apk/debug/fanhao.apk",
        "https://example.com"
      ),
      "cross-origin port"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "https://user@example.com/api/android/update/apk/debug/fanhao.apk",
        "https://example.com"
      ),
      "URL credentials"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "https://example.com/api/android/update/apkish/debug/fanhao.apk",
        "https://example.com"
      ),
      "lookalike update path"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "https://example.com/api/android/update/apk/debug/%2e%2e%2fevil.apk",
        "https://example.com"
      ),
      "encoded path traversal"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "https://example.com/api/android/update/apk/debug/fanhao.apk?token=1",
        "https://example.com"
      ),
      "download query"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireTrustedDownloadUrl(
        "https://example.com/api/android/update/apk/debug/fanhao.apk",
        ""
      ),
      "missing service base"
    );

    expectEqual(42L, AndroidUpdatePolicy.requireExpectedVersionCode(42), "versionCode must remain exact");
    expectEqual("0.1.42-debug", AndroidUpdatePolicy.requireExpectedVersionName(" 0.1.42-debug "), "versionName must normalize");
    expectEqual(12_345L, AndroidUpdatePolicy.requireExpectedSize(12_345), "APK size must remain exact");
    expectRejected(() -> AndroidUpdatePolicy.requireExpectedVersionCode(null), "missing versionCode");
    expectRejected(() -> AndroidUpdatePolicy.requireExpectedVersionCode(0), "zero versionCode");
    expectRejected(() -> AndroidUpdatePolicy.requireExpectedVersionName(" "), "missing versionName");
    expectRejected(() -> AndroidUpdatePolicy.requireExpectedSize(0), "empty APK size");
    expectRejected(() -> AndroidUpdatePolicy.requireExpectedSize(600 * 1024 * 1024), "oversized APK");

    AndroidUpdatePolicy.PackageIdentity installed = identity(
      "local.fanhao.library",
      41,
      "0.1.41-debug",
      Set.of("signer-a"),
      Set.of("signer-a"),
      false
    );
    AndroidUpdatePolicy.PackageIdentity update = identity(
      "local.fanhao.library",
      42,
      "0.1.42-debug",
      Set.of("signer-a"),
      Set.of("signer-a"),
      false
    );
    expectInstallable(installed, update, 42, "0.1.42-debug", "same signer update");
    expectInstallable(
      installed,
      identity(
        "local.fanhao.library",
        42,
        "0.1.42-debug",
        Set.of("signer-b"),
        Set.of("signer-a", "signer-b"),
        false
      ),
      42,
      "0.1.42-debug",
      "verified signer rotation"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireInstallableUpdate(
        installed,
        identity("evil.example.app", 42, "0.1.42-debug", Set.of("signer-a"), Set.of("signer-a"), false),
        42,
        "0.1.42-debug"
      ),
      "different package"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireInstallableUpdate(installed, update, 43, "0.1.42-debug"),
      "metadata versionCode mismatch"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireInstallableUpdate(installed, update, 42, "0.1.43-debug"),
      "metadata versionName mismatch"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireInstallableUpdate(
        installed,
        identity("local.fanhao.library", 41, "0.1.41-debug", Set.of("signer-a"), Set.of("signer-a"), false),
        41,
        "0.1.41-debug"
      ),
      "same version"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireInstallableUpdate(
        installed,
        identity("local.fanhao.library", 42, "0.1.42-debug", Set.of("signer-b"), Set.of("signer-b"), false),
        42,
        "0.1.42-debug"
      ),
      "unrelated signer"
    );

    AndroidUpdatePolicy.PackageIdentity multiSignerInstalled = identity(
      "local.fanhao.library",
      41,
      "0.1.41-debug",
      Set.of("signer-a", "signer-b"),
      Set.of("signer-a", "signer-b"),
      true
    );
    expectInstallable(
      multiSignerInstalled,
      identity(
        "local.fanhao.library",
        42,
        "0.1.42-debug",
        Set.of("signer-b", "signer-a"),
        Set.of("signer-b", "signer-a"),
        true
      ),
      42,
      "0.1.42-debug",
      "same multi-signer set"
    );
    expectRejected(
      () -> AndroidUpdatePolicy.requireInstallableUpdate(
        multiSignerInstalled,
        identity("local.fanhao.library", 42, "0.1.42-debug", Set.of("signer-a"), Set.of("signer-a"), true),
        42,
        "0.1.42-debug"
      ),
      "partial multi-signer set"
    );

    System.out.println("android-update-policy: " + checks + " checks passed");
  }

  private static AndroidUpdatePolicy.PackageIdentity identity(
    String packageName,
    long versionCode,
    String versionName,
    Set<String> currentSigners,
    Set<String> signingHistory,
    boolean multipleSigners
  ) {
    return new AndroidUpdatePolicy.PackageIdentity(
      packageName,
      versionCode,
      versionName,
      currentSigners,
      signingHistory,
      multipleSigners
    );
  }

  private static void expectInstallable(
    AndroidUpdatePolicy.PackageIdentity installed,
    AndroidUpdatePolicy.PackageIdentity archive,
    long expectedVersionCode,
    String expectedVersionName,
    String label
  ) {
    AndroidUpdatePolicy.requireInstallableUpdate(installed, archive, expectedVersionCode, expectedVersionName);
    checks += 1;
  }

  private static void expectAllowed(String url, String serviceBase) {
    AndroidUpdatePolicy.requireTrustedDownloadUrl(url, serviceBase);
    checks += 1;
  }

  private static void expectRejected(Runnable action, String label) {
    try {
      action.run();
    } catch (IllegalArgumentException expected) {
      checks += 1;
      return;
    }
    throw new AssertionError("Expected rejection: " + label);
  }

  private static void expectEqual(String expected, String actual, String label) {
    if (!expected.equals(actual)) throw new AssertionError(label + ": " + actual);
    checks += 1;
  }

  private static void expectEqual(long expected, long actual, String label) {
    if (expected != actual) throw new AssertionError(label + ": " + actual);
    checks += 1;
  }
}
