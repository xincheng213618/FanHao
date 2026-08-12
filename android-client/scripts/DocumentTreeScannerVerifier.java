package local.fanhao.library;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class DocumentTreeScannerVerifier {
  public static void main(String[] args) throws Exception {
    verifyOptionBounds();
    verifyCycleDuplicateUnknownAndVirtualHandling();
    verifyFileNodeAndDepthBounds();
    verifyRootAndChildFailures();
    verifyPickerCancelContract();
    verifyEightyMegabyteBoundary();
    System.out.println("document-tree-scanner: traversal, failure, cancel, and size checks passed");
  }

  private static void verifyOptionBounds() {
    DocumentTreeScanner.Options defaults = new DocumentTreeScanner.Options(null, null, null);
    equal(defaults.maxFiles, 5_000, "default file limit");
    equal(defaults.maxDepth, 32, "default depth limit");
    equal(defaults.maxNodes, 20_000, "default node limit");

    DocumentTreeScanner.Options clamped = new DocumentTreeScanner.Options(50_000, 128, 200_000);
    equal(clamped.maxFiles, 5_000, "maximum file limit");
    equal(clamped.maxDepth, 32, "maximum depth limit");
    equal(clamped.maxNodes, 20_000, "maximum node limit");
  }

  private static void verifyCycleDuplicateUnknownAndVirtualHandling() {
    DocumentTreeScanner.Node root = directory("docs", "root", "Root");
    DocumentTreeScanner.Node nested = directory("docs", "nested", "Nested");
    DocumentTreeScanner.Node duplicateNested = directory("docs", "nested", "Nested duplicate");
    DocumentTreeScanner.Node unknown = text("docs", "unknown", "unknown.txt", -1L, false);
    DocumentTreeScanner.Node virtual = new DocumentTreeScanner.Node(
      "docs", "virtual", "content://docs/virtual", "virtual.txt", "text/plain",
      20_000L, true, 0L, false, true
    );
    DocumentTreeScanner.Node sameIdOtherAuthority = text("other", "unknown", "other.txt", 20_000L, true);
    FixtureSource source = new FixtureSource(root)
      .children(root, nested, duplicateNested, unknown, virtual, sameIdOtherAuthority)
      .children(nested, root, unknown);

    DocumentTreeScanner.Result result = DocumentTreeScanner.scan(
      source,
      new DocumentTreeScanner.Options(100, 32, 100)
    );
    equal(result.files.size(), 2, "authority plus document ID identity");
    check(result.files.stream().anyMatch(node -> node == unknown), "unknown-size TXT must remain selectable");
    check(!DocumentTreeScanner.isRecommended(unknown), "unknown-size TXT must not be selected by default");
    equal(DocumentTreeScanner.hint(unknown), "大小未知", "unknown-size hint");
    check(result.duplicateNodes >= 3, "cycle and duplicate nodes must be suppressed");
    equal(result.virtualNodes, 1, "virtual document skip");
    check(!result.truncated(), "bounded cycle fixture must finish without truncation");
  }

  private static void verifyFileNodeAndDepthBounds() {
    DocumentTreeScanner.Node root = directory("docs", "root", "Root");
    FixtureSource fileSource = new FixtureSource(root).children(
      root,
      text("docs", "one", "one.txt", 20_000L, true),
      text("docs", "two", "two.txt", 20_000L, true),
      text("docs", "three", "three.txt", 20_000L, true),
      text("docs", "oversized", "huge.txt", DocumentTreeScanner.MAX_TEXT_BYTES + 1L, true),
      text("docs", "not-text", "image.jpg", 20_000L, true)
    );
    DocumentTreeScanner.Result files = DocumentTreeScanner.scan(
      fileSource,
      new DocumentTreeScanner.Options(2, 32, 100)
    );
    equal(files.files.size(), 2, "file limit");
    check(files.truncationReasons.contains("files"), "file cap must report truncation");

    DocumentTreeScanner.Result exactFiles = DocumentTreeScanner.scan(
      new FixtureSource(root).children(
        root,
        text("docs", "exact-one", "exact-one.txt", 20_000L, true),
        text("docs", "exact-two", "exact-two.txt", 20_000L, true)
      ),
      new DocumentTreeScanner.Options(2, 32, 100)
    );
    equal(exactFiles.files.size(), 2, "exact file limit");
    check(!exactFiles.truncationReasons.contains("files"), "an exact file count must not claim omitted files");

    DocumentTreeScanner.Result nodes = DocumentTreeScanner.scan(
      fileSource,
      new DocumentTreeScanner.Options(100, 32, 2)
    );
    check(nodes.nodesVisited <= 2, "node cap must be absolute");
    check(nodes.truncationReasons.contains("nodes"), "node cap must report truncation");

    DocumentTreeScanner.Node levelOne = directory("docs", "level-one", "Level one");
    DocumentTreeScanner.Node levelTwoFile = text("docs", "deep", "deep.txt", 20_000L, true);
    FixtureSource depthSource = new FixtureSource(root)
      .children(root, levelOne)
      .children(levelOne, levelTwoFile);
    DocumentTreeScanner.Result depth = DocumentTreeScanner.scan(
      depthSource,
      new DocumentTreeScanner.Options(100, 1, 100)
    );
    equal(depth.files.size(), 0, "depth cap");
    check(depth.truncationReasons.contains("depth"), "depth cap must report truncation");

    DocumentTreeScanner.Node onlyOversized = text(
      "docs", "huge-only", "huge.txt", DocumentTreeScanner.MAX_TEXT_BYTES + 1L, true
    );
    DocumentTreeScanner.Result oversized = DocumentTreeScanner.scan(
      new FixtureSource(root).children(root, onlyOversized),
      new DocumentTreeScanner.Options(100, 32, 100)
    );
    equal(oversized.files.size(), 0, "known oversize TXT skip");
    equal(oversized.oversizedFiles, 1, "known oversize counter");
  }

  private static void verifyRootAndChildFailures() {
    DocumentTreeScanner.Result rootSecurity = DocumentTreeScanner.scan(
      new FixtureSource(null).failRoot(new SecurityException("denied")),
      new DocumentTreeScanner.Options(null, null, null)
    );
    check(rootSecurity.rootFailed, "root security failure must be explicit");
    equal(rootSecurity.errors.get(0).code, "ROOT_SECURITY", "root security code");

    DocumentTreeScanner.Result rootMissing = DocumentTreeScanner.scan(
      new FixtureSource(null),
      new DocumentTreeScanner.Options(null, null, null)
    );
    check(rootMissing.rootFailed, "missing root must fail closed");

    DocumentTreeScanner.Node root = directory("docs", "root", "Root");
    DocumentTreeScanner.Node denied = directory("docs", "denied", "Denied");
    DocumentTreeScanner.Node good = text("docs", "good", "good.txt", 20_000L, true);
    FixtureSource source = new FixtureSource(root)
      .children(root, denied, good)
      .failChildren(denied, new SecurityException("denied"));
    DocumentTreeScanner.Result partial = DocumentTreeScanner.scan(
      source,
      new DocumentTreeScanner.Options(null, null, null)
    );
    equal(partial.files.size(), 1, "readable sibling survives child failure");
    equal(partial.errors.size(), 1, "child failure count");
    equal(partial.errors.get(0).code, "CHILD_SECURITY", "child security code");
    check(!partial.rootFailed, "child failure must not be mislabeled as root failure");
  }

  private static void verifyPickerCancelContract() {
    check(DocumentTreeScanner.isPickerCanceled(false, false), "canceled result without URI");
    check(DocumentTreeScanner.isPickerCanceled(false, true), "non-OK result with URI");
    check(DocumentTreeScanner.isPickerCanceled(true, false), "OK result without URI");
    check(!DocumentTreeScanner.isPickerCanceled(true, true), "OK result with URI");
  }

  private static void verifyEightyMegabyteBoundary() throws Exception {
    long eightyMegabytes = 80L * 1024L * 1024L;
    BoundedTextReader.requireAllowedKnownSize(-1L, eightyMegabytes);
    BoundedTextReader.requireAllowedKnownSize(eightyMegabytes, eightyMegabytes);
    expectIllegalArgument(
      () -> BoundedTextReader.requireAllowedKnownSize(eightyMegabytes + 1L, eightyMegabytes),
      "80MB + 1 known-size document"
    );

    byte[] exact = BoundedTextReader.read(new ByteArrayInputStream(new byte[] { 1, 2, 3, 4 }), 4L);
    equal(exact.length, 4, "stream exact boundary");
    expectIllegalArgument(
      () -> BoundedTextReader.read(new ByteArrayInputStream(new byte[] { 1, 2, 3, 4, 5 }), 4L),
      "unknown-size stream beyond boundary"
    );
  }

  private static DocumentTreeScanner.Node directory(String authority, String id, String name) {
    return new DocumentTreeScanner.Node(
      authority, id, "content://" + authority + "/" + id, name,
      "vnd.android.document/directory", -1L, false, 0L, true, false
    );
  }

  private static DocumentTreeScanner.Node text(
    String authority,
    String id,
    String name,
    long size,
    boolean sizeKnown
  ) {
    return new DocumentTreeScanner.Node(
      authority, id, "content://" + authority + "/" + id, name,
      "text/plain", size, sizeKnown, 0L, false, false
    );
  }

  private static void check(boolean condition, String label) {
    if (!condition) throw new AssertionError(label);
  }

  private static void equal(Object actual, Object expected, String label) {
    if (actual == null ? expected != null : !actual.equals(expected)) {
      throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
    }
  }

  private static void expectIllegalArgument(ThrowingRunnable action, String label) throws Exception {
    try {
      action.run();
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError(label + " should be rejected");
  }

  private interface ThrowingRunnable {
    void run() throws Exception;
  }

  private static final class FixtureSource implements DocumentTreeScanner.Source {
    private final DocumentTreeScanner.Node root;
    private final Map<String, List<DocumentTreeScanner.Node>> children = new HashMap<>();
    private final Map<String, Exception> childFailures = new HashMap<>();
    private Exception rootFailure;

    FixtureSource(DocumentTreeScanner.Node root) {
      this.root = root;
    }

    FixtureSource children(DocumentTreeScanner.Node directory, DocumentTreeScanner.Node... nodes) {
      children.put(directory.identity(), Arrays.asList(nodes));
      return this;
    }

    FixtureSource failRoot(Exception error) {
      rootFailure = error;
      return this;
    }

    FixtureSource failChildren(DocumentTreeScanner.Node directory, Exception error) {
      childFailures.put(directory.identity(), error);
      return this;
    }

    @Override
    public DocumentTreeScanner.Node readRoot() throws Exception {
      if (rootFailure != null) throw rootFailure;
      return root;
    }

    @Override
    public DocumentTreeScanner.ChildrenPage readChildren(
      DocumentTreeScanner.Node directory,
      int maximumChildren
    ) throws Exception {
      Exception failure = childFailures.get(directory.identity());
      if (failure != null) throw failure;
      List<DocumentTreeScanner.Node> all = children.getOrDefault(directory.identity(), new ArrayList<>());
      int size = Math.min(maximumChildren, all.size());
      return new DocumentTreeScanner.ChildrenPage(all.subList(0, size), all.size() > size);
    }
  }

  private DocumentTreeScannerVerifier() {}
}
