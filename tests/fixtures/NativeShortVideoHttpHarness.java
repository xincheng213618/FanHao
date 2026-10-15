package local.fanhao.library;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class NativeShortVideoHttpHarness {
  private interface ThrowingRunnable {
    void run() throws Exception;
  }

  private static final class SizedInputStream extends InputStream {
    private int remaining;

    SizedInputStream(int size) {
      remaining = size;
    }

    @Override
    public int read() {
      if (remaining == 0) return -1;
      remaining--;
      return 0;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) {
      if (remaining == 0) return -1;
      int read = Math.min(length, remaining);
      Arrays.fill(buffer, offset, offset + read, (byte) 0);
      remaining -= read;
      return read;
    }
  }

  private static final class FakeConnection extends HttpURLConnection {
    private final int status;
    private final String contentType;
    private final String contentLength;
    private final InputStream input;
    private final InputStream error;

    FakeConnection(int status, String contentType, String contentLength, InputStream input, InputStream error)
        throws Exception {
      super(new URL("http://127.0.0.1/test"));
      this.status = status;
      this.contentType = contentType;
      this.contentLength = contentLength;
      this.input = input;
      this.error = error;
    }

    @Override public int getResponseCode() { return status; }
    @Override public String getContentType() { return contentType; }
    @Override public String getHeaderField(String name) {
      return "Content-Length".equalsIgnoreCase(name) ? contentLength : null;
    }
    @Override public InputStream getInputStream() { return input; }
    @Override public InputStream getErrorStream() { return error; }
    @Override public void disconnect() {}
    @Override public boolean usingProxy() { return false; }
    @Override public void connect() {}
  }

  public static void main(String[] args) throws Exception {
    verifyUtf8Boundary(8191, true);
    verifyUtf8Boundary(8192, false);
    verifyDeclaredOverflow();
    verifyChunkedOverflow();
    verifyImageTypeAndStatus();
    verifyNormalImage();
    System.out.println("native-short-video-http: ok");
  }

  private static void verifyUtf8Boundary(int asciiPrefixBytes, boolean success) throws Exception {
    String expected = "a".repeat(asciiPrefixBytes) + "中文";
    byte[] body = expected.getBytes(StandardCharsets.UTF_8);
    FakeConnection connection = new FakeConnection(
      success ? 200 : 400,
      "application/json; charset=utf-8",
      String.valueOf(body.length),
      success ? new ByteArrayInputStream(body) : null,
      success ? null : new ByteArrayInputStream(body)
    );
    String actual = NativeShortVideoHttpResponse.readUtf8(connection, success, body.length);
    check(expected.equals(actual), "UTF-8 must survive a three-byte Chinese character at byte " + asciiPrefixBytes);
  }

  private static void verifyDeclaredOverflow() throws Exception {
    int max = NativeShortVideoImageLoader.MAX_IMAGE_BYTES;
    FakeConnection connection = new FakeConnection(
      200,
      "image/jpeg",
      String.valueOf((long) max + 1L),
      new ByteArrayInputStream(new byte[] { 1 }),
      null
    );
    expectThrows(NativeShortVideoHttpResponse.BodyTooLargeException.class,
      () -> NativeShortVideoImageLoader.read(connection),
      "declared image overflow must fail before reading");
  }

  private static void verifyChunkedOverflow() throws Exception {
    int max = NativeShortVideoImageLoader.MAX_IMAGE_BYTES;
    FakeConnection connection = new FakeConnection(200, "image/webp", null, new SizedInputStream(max + 1), null);
    expectThrows(NativeShortVideoHttpResponse.BodyTooLargeException.class,
      () -> NativeShortVideoImageLoader.read(connection),
      "unknown-length image overflow must fail while streaming");
  }

  private static void verifyImageTypeAndStatus() throws Exception {
    FakeConnection nonImage = new FakeConnection(
      200, "text/html", "2", new ByteArrayInputStream(new byte[] { 1, 2 }), null);
    expectThrows(IOException.class, () -> NativeShortVideoImageLoader.read(nonImage),
      "non-image Content-Type must be rejected");

    FakeConnection failed = new FakeConnection(
      404, "image/png", "0", new ByteArrayInputStream(new byte[0]), null);
    expectThrows(IOException.class, () -> NativeShortVideoImageLoader.read(failed),
      "non-success image status must be rejected");
  }

  private static void verifyNormalImage() throws Exception {
    byte[] expected = new byte[] { (byte) 0x89, 0x50, 0x4e, 0x47 };
    FakeConnection connection = new FakeConnection(
      200,
      "image/png; charset=binary",
      String.valueOf(expected.length),
      new ByteArrayInputStream(expected),
      null
    );
    check(Arrays.equals(expected, NativeShortVideoImageLoader.read(connection)), "normal image bytes must pass unchanged");
  }

  private static void expectThrows(Class<? extends Throwable> type, ThrowingRunnable action, String message)
      throws Exception {
    try {
      action.run();
    } catch (Throwable error) {
      if (type.isInstance(error)) return;
      throw new AssertionError(message + ": wrong exception " + error, error);
    }
    throw new AssertionError(message + ": no exception");
  }

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
}
