package local.fanhao.library;

import java.io.*;
import java.net.URLDecoder;
import java.nio.charset.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

// Android/provider/Capacitor boundaries only. Actual read, metadata, Intent
// predicates, picker callbacks and reply methods are inserted unchanged.
// No external content URI, Android registry, permission or device is exercised.
class Uri {
  final String value;
  Uri(String value) { this.value = value; }
  static Uri parse(String value) { return new Uri(value); }
  String getScheme() { return java.net.URI.create(value).getScheme(); }
  String getAuthority() { return java.net.URI.create(value).getAuthority(); }
  String getLastPathSegment() { String path = java.net.URI.create(value).getPath(); return path == null ? null : path.substring(path.lastIndexOf('/') + 1); }
  public boolean equals(Object other) { return other instanceof Uri && value.equals(((Uri) other).value); }
  public int hashCode() { return value.hashCode(); }
  public String toString() { return value; }
}
class Intent {
  static final String ACTION_MAIN = "MAIN", ACTION_SEND = "SEND", ACTION_VIEW = "VIEW", EXTRA_TEXT = "text", EXTRA_STREAM = "stream";
  String action, type = "text/plain"; CharSequence text; Uri uri, stream; ClipData clip;
  Intent(String action) { this.action = action; }
  Intent(Intent original) { action = original.action; text = original.text; uri = original.uri; stream = original.stream; type = original.type; clip = original.clip; }
  String getAction() { return action; }
  String getType() { return type; }
  CharSequence getCharSequenceExtra(String key) { return EXTRA_TEXT.equals(key) ? text : null; }
  Object getParcelableExtra(String key) { return EXTRA_STREAM.equals(key) ? stream : null; }
  Uri getData() { return uri; }
  ClipData getClipData() { return clip; }
  Intent setPackage(String ignored) { return this; }
}
class ClipData {
  final List<Uri> entries;
  ClipData(Uri... uris) { entries = Arrays.asList(uris); }
  int getItemCount() { return entries.size(); }
  Item getItemAt(int index) { return new Item(entries.get(index)); }
  static class Item { final Uri uri; Item(Uri uri) { this.uri = uri; } Uri getUri() { return uri; } }
}
class ActivityResult {
  final int result; final Intent intent;
  ActivityResult(int result, Intent intent) { this.result = result; this.intent = intent; }
  int getResultCode() { return result; }
  Intent getData() { return intent; }
}
class OpenableColumns { static final String SIZE = "size", DISPLAY_NAME = "name"; }
class DocumentsContract { static class Document { static final String COLUMN_FLAGS = "flags"; static final long FLAG_VIRTUAL_DOCUMENT = 512; } }
class Document {
  String name = "book.txt", mime = "text/plain";
  byte[] bytes = new byte[] { 65, 66 };
  long size = 2; boolean known = true, virtual, missingSize, missingFlags, emptyRow, nullCursor;
  Throwable fullFailure, sizeFailure, nameFailure, cursorCloseFailure, openFailure, readFailure, closeFailure;
  Runnable onRead;
  int opens, fullQueries, sizeQueries, nameQueries, mimeReads, cursorCloses;
  NativeTextReadVerifier.Stream last;
}
class Cursor implements AutoCloseable {
  final Document doc; final String[] columns;
  Cursor(Document doc, String[] columns) { this.doc = doc; this.columns = columns; }
  boolean moveToFirst() { return !doc.emptyRow; }
  int getColumnIndex(String column) {
    if ((column.equals(OpenableColumns.SIZE) && doc.missingSize) || (column.equals(DocumentsContract.Document.COLUMN_FLAGS) && doc.missingFlags)) return -1;
    return Arrays.asList(columns).indexOf(column);
  }
  boolean isNull(int index) { return columns[index].equals(OpenableColumns.SIZE) && !doc.known; }
  long getLong(int index) { return columns[index].equals(OpenableColumns.SIZE) ? doc.size : doc.virtual ? 512 : 0; }
  String getString(int index) { return doc.name; }
  public void close() { doc.cursorCloses++; NativeTextReadVerifier.unchecked(doc.cursorCloseFailure); }
}
class ContentResolver {
  final Map<String, Document> documents = new ConcurrentHashMap<>();
  int accesses;
  Document document(Uri uri) { accesses++; Document doc = documents.get(uri.toString()); if (doc == null) throw new IllegalArgumentException("unconfigured URI: " + uri); return doc; }
  InputStream openInputStream(Uri uri) throws IOException {
    Document doc = document(uri); doc.opens++; NativeTextReadVerifier.Stream.fail(doc.openFailure);
    doc.last = new NativeTextReadVerifier.Stream(doc.bytes);
    doc.last.readFailure = doc.readFailure; doc.last.closeFailure = doc.closeFailure; doc.last.onRead = doc.onRead;
    return doc.last;
  }
  String getType(Uri uri) { Document doc = document(uri); doc.mimeReads++; return doc.mime; }
  Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
    Document doc = document(uri);
    if (Arrays.asList(projection).contains(OpenableColumns.DISPLAY_NAME)) { doc.nameQueries++; NativeTextReadVerifier.unchecked(doc.nameFailure); }
    else if (Arrays.asList(projection).contains(DocumentsContract.Document.COLUMN_FLAGS)) { doc.fullQueries++; NativeTextReadVerifier.unchecked(doc.fullFailure); }
    else { doc.sizeQueries++; NativeTextReadVerifier.unchecked(doc.sizeFailure); }
    return doc.nullCursor ? null : new Cursor(doc, projection);
  }
}
class Context {
  final ContentResolver resolver = new ContentResolver();
  ContentResolver getContentResolver() { return resolver; }
  String getPackageName() { return "local.fanhao.library"; }
}
class Activity extends Context {
  static final int RESULT_OK = -1;
  volatile Intent intent = new Intent(Intent.ACTION_MAIN);
  final BlockingQueue<Runnable> tasks = new LinkedBlockingQueue<>();
  Intent getIntent() { return intent; }
  void setIntent(Intent value) { intent = value; }
  void runOnUiThread(Runnable action) { tasks.add(action); }
  void drain() { Runnable action; while ((action = tasks.poll()) != null) action.run(); }
}
class Bridge {
  final Activity activity;
  Bridge(Activity activity) { this.activity = activity; }
  void executeOnMainThread(Runnable action) { activity.runOnUiThread(action); }
}
class JSObject extends LinkedHashMap<String, Object> {}
class JSArray extends ArrayList<Object> { JSArray put(Object value) { add(value); return this; } }
class PluginCall {
  String uri = "content://fixture/book.txt"; Boolean deferred = false; boolean released;
  volatile JSObject result; volatile String error; volatile Exception cause; volatile int settlements;
  boolean isReleased() { return released; }
  String getString(String key, String fallback) { return "uri".equals(key) ? uri : fallback; }
  Boolean getBoolean(String key, boolean fallback) { return "deferredRead".equals(key) ? deferred : Boolean.valueOf(fallback); }
  void resolve(JSObject value) { result = value; settlements++; }
  void reject(String message) { error = message; settlements++; }
  void reject(String message, Exception cause) { this.cause = cause; error = message; settlements++; }
}
class ReadHost {
  // Deliberate 64-byte scaling: production method bodies otherwise unchanged.
  static final long MAX_TEXT_BYTES = 64L;
  static final PendingTextImportQueue<Intent> pendingTextIntents = new PendingTextImportQueue<>();
  final Activity activity = new Activity();
  Activity getActivity() { return activity; }
  Context getContext() { return activity; }
  Bridge getBridge() { return new Bridge(activity); }
  void showToast(String ignored) {}
  static class DocumentMetadata {
    final long sizeBytes; final boolean sizeKnown, virtual;
    DocumentMetadata(long bytes, boolean known, boolean isVirtual) { sizeBytes = bytes; sizeKnown = known; virtual = isVirtual; }
  }
  /* PRODUCTION_METHODS */
}

public class NativeTextReadVerifier {
  static int checks;
  static final BlockingQueue<Throwable> uncaught = new LinkedBlockingQueue<>();
  interface Throwing { void run() throws Exception; }
  static void check(boolean condition, String label) { checks++; if (!condition) throw new AssertionError(label); }
  static void equal(Object actual, Object expected, String label) { check(Objects.equals(actual, expected), label + ": expected=" + expected + " actual=" + actual); }
  static void number(Object actual, long expected, String label) { check(actual instanceof Number && ((Number) actual).longValue() == expected, label + ": expected=" + expected + " actual=" + actual); }
  static Throwable failure(Throwing action) { try { action.run(); return null; } catch (Throwable error) { return error; } }
  static Throwable rejects(Class<? extends Throwable> kind, Throwing action, String label) {
    Throwable error = failure(action); check(kind.isInstance(error), label + ": expected=" + kind.getSimpleName() + " actual=" + error); return error;
  }
  static void unchecked(Throwable error) { if (error instanceof RuntimeException) throw (RuntimeException) error; if (error instanceof Error) throw (Error) error; }
  static class Stream extends InputStream {
    final byte[] bytes; int position, reads, requested, closes, chunk = Integer.MAX_VALUE; Throwable readFailure, closeFailure; Runnable onRead;
    final List<Integer> requests = new ArrayList<>(), positions = new ArrayList<>();
    Stream(byte[] bytes) { this.bytes = bytes; }
    public int read() throws IOException { throw new AssertionError("unexpected single-byte fallback"); }
    public int read(byte[] target, int off, int length) throws IOException {
      reads++; requested = Math.max(requested, length); requests.add(length); positions.add(position);
      if (onRead != null) { Runnable action = onRead; onRead = null; action.run(); }
      fail(readFailure);
      if (position == bytes.length) return -1;
      int count = Math.min(chunk, Math.min(length, bytes.length - position));
      System.arraycopy(bytes, position, target, off, count); position += count; return count;
    }
    public void close() throws IOException { closes++; fail(closeFailure); }
    static void fail(Throwable failure) throws IOException { if (failure instanceof IOException) throw (IOException) failure; unchecked(failure); }
  }
  static Uri uri(String leaf) { return Uri.parse("content://fixture/" + leaf); }
  static Document put(ReadHost host, String leaf) { Document doc = new Document(); host.activity.resolver.documents.put(uri(leaf).toString(), doc); return doc; }
  static Intent uriIntent(String leaf) { Intent intent = new Intent(Intent.ACTION_VIEW); intent.uri = uri(leaf); return intent; }
  static Intent textIntent(CharSequence value) { Intent intent = new Intent(Intent.ACTION_SEND); intent.text = value; return intent; }
  static void offer(ReadHost host, Intent intent) { host.activity.intent = intent; ReadHost.capturePendingTextIntent(host.activity, intent); }
  static void resetQueue() {
    check(!ReadHost.pendingTextIntents.isBusy(), "claim must have been completed");
    PendingTextImportQueue.Claim<Intent> claim;
    while ((claim = ReadHost.pendingTextIntents.claim()) != null) ReadHost.pendingTextIntents.complete(claim);
  }
  static void settle(ReadHost host, PluginCall call, String label) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
    while (call.settlements == 0 && System.nanoTime() < deadline) {
      Throwable crashed = uncaught.poll(); if (crashed != null) throw new AssertionError(label + " worker escaped without settling", crashed);
      Runnable task = host.activity.tasks.poll(10, TimeUnit.MILLISECONDS); if (task != null) task.run();
    }
    host.activity.drain(); equal(call.settlements, 1, label + " settles once");
  }
  static PluginCall read(ReadHost host, String leaf, boolean picked) throws Exception {
    PluginCall call = new PluginCall(); call.uri = uri(leaf).toString();
    if (picked) host.readPickedTextFile(call); else host.readScannedTextFile(call);
    settle(host, call, picked ? "picked read" : "scanned read"); return call;
  }
  static PluginCall pick(ReadHost host, Boolean deferred, Uri... uris) throws Exception {
    PluginCall call = new PluginCall(); call.deferred = deferred;
    Intent data = new Intent(Intent.ACTION_VIEW); data.clip = new ClipData(uris);
    host.textDocumentPickerResult(call, new ActivityResult(Activity.RESULT_OK, data)); settle(host, call, "picker"); return call;
  }
  static JSArray array(JSObject object, String key) { Object result = object.get(key); check(result instanceof JSArray, key + " array"); return (JSArray) result; }
  static void memoryFailure(PluginCall call, String label) {
    check(call.error != null && call.error.contains("内存不足"), label + " Chinese memory rejection");
    equal(call.cause, null, label + " no Error-to-Exception cast"); equal(call.result, null, label + " not a success");
  }

  static void bounded() throws Exception {
    rejects(IllegalArgumentException.class, () -> BoundedTextReader.read(null, 64), "null stream");
    for (long maximum : new long[] { -1, 0, Integer.MAX_VALUE - 7L, Integer.MAX_VALUE, Long.MAX_VALUE }) {
      rejects(IllegalArgumentException.class, () -> BoundedTextReader.read(new Stream(new byte[0]), maximum), "invalid read maximum " + maximum);
      rejects(IllegalArgumentException.class, () -> BoundedTextReader.requireAllowedKnownSize(0, maximum), "invalid known-size maximum " + maximum);
    }
    equal(BoundedTextReader.read(new Stream(new byte[0]), Integer.MAX_VALUE - 8L).length, 0, "largest valid bound without large allocation");
    BoundedTextReader.requireAllowedKnownSize(-1, 64); // Deliberate unknown provider metadata.
    BoundedTextReader.requireAllowedKnownSize(64, 64);
    rejects(IllegalArgumentException.class, () -> BoundedTextReader.requireAllowedKnownSize(65, 64), "known oversize");
    for (int maximum : new int[] { 1, 64, 65536, 65539 }) {
      for (int length : new int[] { 0, maximum, maximum + 1, maximum + 70000 }) {
        Stream stream = new Stream(new byte[length]); stream.chunk = maximum == 64 ? 7 : Integer.MAX_VALUE;
        if (length > maximum) rejects(IllegalArgumentException.class, () -> BoundedTextReader.read(stream, maximum), "overflow at " + maximum);
        else equal(BoundedTextReader.read(stream, maximum).length, length, "exact bytes at " + maximum);
        equal(stream.position, Math.min(length, maximum + 1), "provider reads at most one extra byte");
        equal(stream.closes, 0, "reader does not own stream");
        for (int index = 0; index < stream.requests.size(); index++) {
          int request = stream.requests.get(index);
          check(request > 0 && request <= Math.min(65536, maximum - stream.positions.get(index) + 1), "every request obeys remaining+1 and buffer bound");
        }
      }
    }
    AtomicInteger reads = new AtomicInteger();
    InputStream zeros = new InputStream() {
      public int read() { throw new AssertionError("single-byte fallback"); }
      public int read(byte[] bytes, int offset, int count) { if (reads.incrementAndGet() > 16) throw new AssertionError("zero-read loop exceeded finite probe"); return 0; }
    };
    rejects(IOException.class, () -> BoundedTextReader.read(zeros, 64), "eight zero reads stop"); equal(reads.get(), 8, "exact eight-zero threshold");
    AtomicInteger sequence = new AtomicInteger();
    InputStream progress = new InputStream() {
      public int read() { throw new AssertionError("single-byte fallback"); }
      public int read(byte[] bytes, int offset, int count) {
        int step = sequence.incrementAndGet(); if (step == 8 || step == 16) { bytes[offset] = 65; return 1; } return step >= 17 ? -1 : 0;
      }
    };
    AtomicReference<byte[]> progressed = new AtomicReference<>();
    equal(failure(() -> progressed.set(BoundedTextReader.read(progress, 64))), null, "progress resets zero streak");
    equal(progressed.get().length, 2, "progress stream bytes intact");
    for (int invalid : new int[] { -2, 66 }) {
      InputStream bad = new InputStream() { public int read() { return -1; } public int read(byte[] b, int off, int count) { return invalid; } };
      rejects(IOException.class, () -> BoundedTextReader.read(bad, 64), "invalid provider read count " + invalid);
    }
    for (Throwable thrown : new Throwable[] { new IOException("read"), new IllegalStateException("read"), new OutOfMemoryError("read") }) {
      Stream stream = new Stream(new byte[] { 65 }); stream.readFailure = thrown;
      equal(failure(() -> BoundedTextReader.read(stream, 64)), thrown, "reader propagates exact read failure");
    }
  }

  static void wrappersAndInline() throws Exception {
    for (boolean readAlsoFails : new boolean[] { false, true }) {
      ReadHost host = new ReadHost(); Document doc = put(host, "close.txt"); doc.closeFailure = new IOException("close failed");
      if (readAlsoFails) doc.readFailure = new IOException("read failed");
      Throwable error = rejects(IOException.class, () -> host.readAllBytes(host.activity.resolver, uri("close.txt")), "try-resources failure");
      equal(error.getMessage(), readAlsoFails ? "read failed" : "close failed", "read failure remains primary");
      equal(error.getSuppressed().length, readAlsoFails ? 1 : 0, "close exception suppression"); equal(doc.last.closes, 1, "wrapper closes once");
    }
    ReadHost host = new ReadHost();
    for (String text : new String[] { "A", "中😀", "é".repeat(32), "😀".repeat(16), "x".repeat(64), "中".repeat(21) }) {
      JSObject result = host.readIntentText(textIntent(text)); equal(result.get("text"), text, "inline roundtrip");
      number(result.get("sizeBytes"), text.getBytes(StandardCharsets.UTF_8).length, "inline reports UTF-8 bytes");
    }
    for (String text : new String[] { "x".repeat(65), "中".repeat(22), "😀".repeat(17), "\ud800", "\udc00", "A\ud800B" }) {
      rejects(IllegalArgumentException.class, () -> host.readIntentText(textIntent(text)), "inline limit or surrogate rejected");
    }
    AtomicInteger converted = new AtomicInteger();
    CharSequence oversized = new CharSequence() {
      public int length() { return 65; } public char charAt(int index) { return 'x'; } public CharSequence subSequence(int a, int b) { return this; }
      public String toString() { converted.incrementAndGet(); throw new OutOfMemoryError("must preflight chars before allocation"); }
    };
    rejects(IllegalArgumentException.class, () -> host.readIntentText(textIntent(oversized)), "inline length preflight"); equal(converted.get(), 0, "known character lower bound avoids toString allocation");
    for (String raw : new String[] { "file:///private/book.txt", "https://fixture/book.txt", "content:/book.txt" }) {
      Intent intent = new Intent(Intent.ACTION_VIEW); intent.uri = Uri.parse(raw);
      rejects(IllegalArgumentException.class, () -> host.readIntentText(intent), "intent content-only guard");
      equal(host.activity.resolver.accesses, 0, "invalid Intent rejected before any provider access");
    }
    Document doc = put(host, "stream.txt"); Intent fromExtra = new Intent(Intent.ACTION_SEND); fromExtra.stream = uri("stream.txt");
    number(host.readIntentText(fromExtra).get("sizeBytes"), 2, "EXTRA_STREAM actual byte count"); equal(doc.last.closes, 1, "EXTRA_STREAM stream closed");
  }

  static void metadata() throws Exception {
    for (boolean picked : new boolean[] { false, true }) {
      for (long known : new long[] { 65, 63, 2 }) {
        ReadHost host = new ReadHost(); Document doc = put(host, "book.txt"); doc.size = known;
        if (known == 2) doc.bytes = new byte[65];
        PluginCall call = read(host, "book.txt", picked);
        if (known == 63) { number(call.result.get("sizeBytes"), 2, "stale metadata uses actual byte count"); equal(call.result.get("text"), "AB", "read text"); }
        else check(call.error != null, "known or actual oversize rejects");
        equal(doc.opens, known == 65 ? 0 : 1, "known oversize rejected before open"); equal(doc.sizeQueries, 0, "successful metadata validation not swallowed by fallback");
        if (doc.last != null) { equal(doc.last.closes, 1, "metadata path closes stream"); check(doc.last.position <= 65, "actual cap independent of metadata"); }
      }
      ReadHost virtualHost = new ReadHost(); Document virtual = put(virtualHost, "book.txt"); virtual.virtual = true;
      String virtualError = read(virtualHost, "book.txt", picked).error;
      check(virtualError != null && virtualError.contains("虚拟"), "virtual rejected"); equal(virtual.opens, 0, "virtual never opened"); equal(virtual.sizeQueries, 0, "virtual cannot become fallback plain document");
      for (String raw : new String[] { "file:///book.txt", "https://fixture/book.txt", "content:/book.txt", "" }) {
        ReadHost invalidHost = new ReadHost(); PluginCall call = new PluginCall(); call.uri = raw;
        if (picked) invalidHost.readPickedTextFile(call); else invalidHost.readScannedTextFile(call);
        settle(invalidHost, call, "invalid URI"); check(call.error != null, "read API rejects non-content URI before provider access");
        equal(invalidHost.activity.resolver.accesses, 0, "invalid read API rejected before any provider access");
      }
    }
    for (int variant = 0; variant < 6; variant++) {
      ReadHost host = new ReadHost(); Document doc = put(host, "book.txt");
      if (variant == 0 || variant == 1) doc.fullFailure = new IllegalArgumentException("flags unsupported");
      if (variant == 1) doc.sizeFailure = new SecurityException("metadata unavailable");
      if (variant == 2) doc.nullCursor = true;
      if (variant == 3) doc.emptyRow = true;
      if (variant == 4) doc.missingSize = true;
      if (variant == 5) doc.known = false;
      PluginCall call = read(host, "book.txt", true); equal(call.error, null, "optional metadata variant " + variant); number(call.result.get("sizeBytes"), 2, "unknown metadata still actual bytes");
      equal(doc.fullQueries, 1, "metadata tries full projection once"); equal(doc.sizeQueries, variant <= 3 ? 1 : 0, "fallback only after full metadata failed"); equal(doc.last.closes, 1, "fallback stream closes");
    }
    ReadHost sizeHost = new ReadHost(); Document large = put(sizeHost, "book.txt"); large.fullFailure = new IllegalArgumentException("flags unsupported"); large.size = 65;
    check(read(sizeHost, "book.txt", true).error != null, "SIZE-only fallback preserves known-size rejection"); equal(large.opens, 0, "SIZE-only known oversize never opens"); equal(large.sizeQueries, 1, "SIZE-only queried once");
    ReadHost unknownHost = new ReadHost(); Document unknown = put(unknownHost, "book.txt"); unknown.fullFailure = new IllegalArgumentException("full"); unknown.sizeFailure = new IllegalArgumentException("size"); unknown.bytes = new byte[66];
    check(read(unknownHost, "book.txt", true).error != null, "unknown metadata cannot bypass byte limit"); equal(unknown.last.position, 65, "unknown metadata reads only one extra byte");
    ReadHost scanHost = new ReadHost(); Document strict = put(scanHost, "book.txt"); strict.fullFailure = new IllegalStateException("scan metadata failed");
    check(read(scanHost, "book.txt", false).error != null, "scanned path retains required metadata"); equal(strict.opens, 0, "scanned metadata error never opens"); equal(strict.sizeQueries, 0, "scanned does not silently opt into fallback");
    for (String leaf : new String[] { "opaque", "book.TXT", "book.txt?download=1" }) {
      ReadHost host = new ReadHost(); Document doc = put(host, leaf); doc.name = "not-text.pdf"; doc.mime = "text/plain";
      PluginCall call = read(host, leaf, true);
      equal(call.error == null, !leaf.equals("opaque"), "picked TXT filename OR URI, not MIME alone"); equal(doc.opens, leaf.equals("opaque") ? 0 : 1, "picked filename guard before open");
    }
    ReadHost named = new ReadHost(); Document namedDoc = put(named, "opaque"); namedDoc.name = "Book.TXT"; namedDoc.mime = "application/octet-stream";
    equal(read(named, "opaque", true).error, null, "TXT display name accepts opaque URI");
    ReadHost missingName = new ReadHost(); Document missingNameDoc = put(missingName, "fallback.txt"); missingNameDoc.nameFailure = new IllegalArgumentException("no name");
    equal(read(missingName, "fallback.txt", true).result.get("fileName"), "fallback.txt", "actual displayName URI fallback");
    for (boolean picked : new boolean[] { false, true }) {
      ReadHost host = new ReadHost(); Document doc = put(host, "book.txt"); doc.bytes = new byte[] {(byte)0xef,(byte)0xbb,(byte)0xbf,(byte)0xc3}; doc.size = 4;
      check(read(host, "book.txt", picked).error != null, "strict decoder failure settles actual read API"); equal(doc.last.closes, 1, "bad encoding closes stream");
    }
  }

  static void oomAndClaims() throws Exception {
    for (boolean picked : new boolean[] { false, true }) {
      for (String stage : new String[] { "open", "read", "close", "metadata", "name" }) {
        ReadHost host = new ReadHost(); Document doc = put(host, "book.txt"); OutOfMemoryError oom = new OutOfMemoryError("synthetic " + stage);
        switch (stage) { case "open": doc.openFailure = oom; break; case "read": doc.readFailure = oom; break; case "close": doc.closeFailure = oom; break; case "metadata": doc.fullFailure = oom; break; case "name": doc.nameFailure = oom; break; }
        PluginCall call = read(host, "book.txt", picked); memoryFailure(call, (picked ? "picked " : "scanned ") + stage);
        if (doc.last != null) equal(doc.last.closes, 1, "OOM opened stream closes once"); equal(doc.sizeQueries, 0, "OOM not masked as optional metadata fallback");
      }
    }
    for (String stage : new String[] { "read", "close", "inline", "malformed", "oversize" }) {
      resetQueue(); ReadHost host = new ReadHost(); Document doc = put(host, "A.txt"); Intent a;
      if (stage.equals("inline")) a = textIntent(new CharSequence() {
        public int length() { return 1; } public char charAt(int i) { return 'A'; } public CharSequence subSequence(int a, int b) { return this; }
        public String toString() { throw new OutOfMemoryError("synthetic CharSequence conversion"); }
      });
      else if (stage.equals("malformed")) a = textIntent("\ud800");
      else if (stage.equals("oversize")) a = textIntent("中".repeat(22));
      else { a = uriIntent("A.txt"); if (stage.equals("read")) doc.readFailure = new OutOfMemoryError("read"); else doc.closeFailure = new OutOfMemoryError("close"); }
      Intent b = textIntent("B"); offer(host, a); offer(host, b);
      PluginCall call = new PluginCall(); equal(failure(() -> host.consumePendingTextFile(call)), null, "consume failure never escapes");
      equal(call.settlements, 1, "consume failure settles once"); equal(call.result.get("available"), false, "failed import unavailable"); equal(call.result.get("hasPending"), true, "failed A exposes queued B");
      Object rawMessage = call.result.get("message");
      check(rawMessage instanceof String && !((String) rawMessage).isBlank(), "consume failure message");
      String message = (String) rawMessage;
      if (!stage.equals("malformed") && !stage.equals("oversize")) check(message.contains("内存不足"), "consume OOM Chinese feedback");
      check(!ReadHost.pendingTextIntents.isBusy(), "failure releases claim"); host.activity.drain(); equal(host.activity.intent, b, "A cleanup preserves newer Activity fallback B");
      PluginCall next = new PluginCall(); host.consumePendingTextFile(next); equal(next.result.get("text"), "B", "B not blocked by failed A"); host.activity.drain();
      PluginCall empty = new PluginCall(); host.consumePendingTextFile(empty); equal(empty.result.get("available"), false, "consumed fallback does not duplicate B"); equal(empty.result.get("busy"), false, "empty queue not busy");
      if (doc.last != null) equal(doc.last.closes, 1, "consume failure closes exactly once");
    }
    resetQueue(); ReadHost host = new ReadHost(); Document doc = put(host, "A.txt"); Intent a = uriIntent("A.txt"), b = textIntent("B"); offer(host, a);
    AtomicReference<JSObject> busy = new AtomicReference<>();
    doc.onRead = () -> { offer(host, b); PluginCall overlapping = new PluginCall(); host.consumePendingTextFile(overlapping); busy.set(overlapping.result); };
    PluginCall first = new PluginCall(); host.consumePendingTextFile(first);
    equal(busy.get().get("busy"), true, "nested consume does not overlap provider IO"); equal(busy.get().get("hasPending"), true, "busy response sees B"); equal(doc.opens, 1, "only one stream under claim");
    equal(first.result.get("hasPending"), true, "successful A exposes B"); host.activity.drain(); equal(host.activity.intent, b, "successful A cannot clear B");
    PluginCall second = new PluginCall(); host.consumePendingTextFile(second); equal(second.result.get("text"), "B", "nested arriving B survives"); host.activity.drain(); resetQueue();
    PluginCall released = new PluginCall(); released.released = true; host.consumePendingTextFile(released); equal(released.settlements, 0, "released consume no settlement");
    PluginCall late = new PluginCall(); host.resolvePluginCall(late, new JSObject()); late.released = true; host.activity.drain(); equal(late.settlements, 0, "late released resolve not delivered");
    PluginCall lateError = new PluginCall(); host.rejectPluginCall(lateError, "failure", null); lateError.released = true; host.activity.drain(); equal(lateError.settlements, 0, "late released reject not delivered");
  }

  static void picker() throws Exception {
    ReadHost host = new ReadHost(); Document a = put(host, "A.txt"), b = put(host, "B.txt"); a.name = "A.txt"; b.name = "B.txt";
    a.openFailure = new AssertionError("deferred callback must not open any body"); b.openFailure = a.openFailure;
    PluginCall deferred = pick(host, true, uri("A.txt"), Uri.parse(uri("A.txt").toString()), null, uri("B.txt"));
    equal(array(deferred.result, "items").size(), 0, "deferred items remain empty"); JSArray documents = array(deferred.result, "documents"); equal(documents.size(), 2, "deferred URI dedup and null skip");
    for (int i = 0; i < 2; i++) { JSObject item = (JSObject) documents.get(i); equal(item.keySet(), new LinkedHashSet<>(Arrays.asList("uri", "fileName")), "descriptor URI/name only"); equal(item.get("uri"), uri(i == 0 ? "A.txt" : "B.txt").toString(), "picker insertion order"); }
    for (Document doc : new Document[] { a, b }) { equal(doc.opens, 0, "deferred input unopened"); equal(doc.mimeReads, 0, "deferred no MIME read"); equal(doc.fullQueries + doc.sizeQueries, 0, "deferred no metadata read"); }
    a.openFailure = null; b.openFailure = null; equal(read(host, "B.txt", true).error, null, "deferred selected book read individually"); equal(a.opens, 0, "reading B does not touch A"); equal(b.opens, 1, "one chosen body opened");
    for (Boolean flag : new Boolean[] { false, null }) {
      ReadHost eagerHost = new ReadHost(); Document doc = put(eagerHost, "A.txt"); PluginCall eager = pick(eagerHost, flag, uri("A.txt"), Uri.parse(uri("A.txt").toString()));
      equal(array(eager.result, "items").size(), 1, "legacy eager deduplicates"); check(!eager.result.containsKey("documents"), "legacy no new field requirement"); equal(doc.opens, 1, "legacy eager opens once"); equal(doc.last.closes, 1, "legacy eager closes");
      equal(((JSObject) array(eager.result, "items").get(0)).get("text"), "AB", "legacy full text compatible");
    }
    for (boolean deferredFlag : new boolean[] { false, true }) {
      ReadHost filtered = new ReadHost(); Document txt = put(filtered, "ok.txt"), pdf = put(filtered, "opaque"); pdf.name = "file.pdf";
      PluginCall mixed = pick(filtered, deferredFlag, Uri.parse("file:///private.txt"), uri("opaque"), uri("ok.txt"));
      equal(array(mixed.result, "errors").size(), 2, "invalid URI/type per-file errors"); equal(array(mixed.result, deferredFlag ? "documents" : "items").size(), 1, "valid sibling survives invalid selection"); equal(pdf.opens, 0, "rejected type never opened");
      for (int canceledVariant = 0; canceledVariant < 2; canceledVariant++) {
        PluginCall canceled = new PluginCall(); canceled.deferred = deferredFlag;
        filtered.textDocumentPickerResult(canceled, new ActivityResult(canceledVariant == 0 ? 0 : Activity.RESULT_OK, null));
        equal(canceled.settlements, 1, "picker cancel settles"); equal(canceled.result.get("canceled"), true, "picker cancel flag"); equal(array(canceled.result, "items").size(), 0, "cancel items empty"); equal(canceled.result.containsKey("documents"), deferredFlag, "cancel descriptor compatibility");
      }
    }
    ReadHost one = new ReadHost(); Document only = put(one, "only.txt"); PluginCall single = new PluginCall(); single.deferred = true; Intent data = uriIntent("only.txt");
    one.textDocumentPickerResult(single, new ActivityResult(Activity.RESULT_OK, data)); settle(one, single, "single data picker"); equal(array(single.result, "documents").size(), 1, "data URI without ClipData"); equal(only.opens, 0, "single deferred no body");
    ReadHost failures = new ReadHost(); Document bad = put(failures, "bad.txt"), good = put(failures, "good.txt"); bad.readFailure = new IOException("provider failed");
    PluginCall partial = pick(failures, false, uri("bad.txt"), uri("good.txt")); equal(array(partial.result, "items").size(), 1, "ordinary file failure preserves sibling"); equal(array(partial.result, "errors").size(), 1, "ordinary failure reported"); equal(bad.last.closes, 1, "picker failed stream closed");
    for (String stage : new String[] { "read", "close", "name" }) {
      ReadHost oom = new ReadHost(); Document doc = put(oom, "book.txt"); OutOfMemoryError error = new OutOfMemoryError("picker " + stage);
      if (stage.equals("read")) doc.readFailure = error; else if (stage.equals("close")) doc.closeFailure = error; else doc.nameFailure = error;
      PluginCall call = pick(oom, stage.equals("name"), uri("book.txt")); memoryFailure(call, "picker " + stage); if (doc.last != null) equal(doc.last.closes, 1, "picker OOM closes once");
    }
  }

  public static void main(String[] args) throws Exception {
    Thread.UncaughtExceptionHandler prior = Thread.getDefaultUncaughtExceptionHandler();
    Thread.setDefaultUncaughtExceptionHandler((thread, error) -> uncaught.add(error));
    try {
      String mode = args.length == 0 ? "all" : args[0];
      if (mode.equals("all") || mode.equals("bounded")) bounded();
      if (mode.equals("all") || mode.equals("inline")) wrappersAndInline();
      if (mode.equals("all") || mode.equals("metadata")) metadata();
      if (mode.equals("all") || mode.equals("oom")) oomAndClaims();
      if (mode.equals("all") || mode.equals("picker")) picker();
      check(uncaught.isEmpty(), "no asynchronous uncaught failures");
      System.out.println("native-text-reads: " + checks + " checks passed (" + mode + ")");
    } finally { Thread.setDefaultUncaughtExceptionHandler(prior); }
  }
}
