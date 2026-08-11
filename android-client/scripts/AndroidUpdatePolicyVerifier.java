package local.fanhao.library;

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

    System.out.println("android-update-policy: " + checks + " checks passed");
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
}
