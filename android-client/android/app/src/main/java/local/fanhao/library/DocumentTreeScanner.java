package local.fanhao.library;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Pure-Java traversal policy for Android document trees.
 *
 * <p>The Android adapter owns {@code DocumentsContract} queries. This class owns all traversal
 * bounds and identity decisions so the safety behavior can be exercised by a real JVM fixture.
 */
final class DocumentTreeScanner {
  static final int DEFAULT_MAX_FILES = 5_000;
  static final int MAX_FILES = 5_000;
  static final int DEFAULT_MAX_DEPTH = 32;
  static final int MAX_DEPTH = 32;
  static final int DEFAULT_MAX_NODES = 20_000;
  static final int MAX_NODES = 20_000;
  static final long MAX_TEXT_BYTES = 80L * 1024L * 1024L;
  static final long MIN_RECOMMENDED_BYTES = 10L * 1024L;
  static final long MAX_RECOMMENDED_BYTES = 50L * 1024L * 1024L;

  interface Source {
    Node readRoot() throws Exception;

    ChildrenPage readChildren(Node directory, int maximumChildren) throws Exception;
  }

  static final class Options {
    final int maxFiles;
    final int maxDepth;
    final int maxNodes;

    Options(Integer maxFiles, Integer maxDepth, Integer maxNodes) {
      this.maxFiles = clamp(maxFiles, DEFAULT_MAX_FILES, 1, MAX_FILES);
      this.maxDepth = clamp(maxDepth, DEFAULT_MAX_DEPTH, 1, MAX_DEPTH);
      this.maxNodes = clamp(maxNodes, DEFAULT_MAX_NODES, 1, MAX_NODES);
    }
  }

  static final class Node {
    final String authority;
    final String documentId;
    final String uri;
    final String displayName;
    final String mimeType;
    final long sizeBytes;
    final boolean sizeKnown;
    final long lastModified;
    final boolean directory;
    final boolean virtual;

    Node(
      String authority,
      String documentId,
      String uri,
      String displayName,
      String mimeType,
      long sizeBytes,
      boolean sizeKnown,
      long lastModified,
      boolean directory,
      boolean virtual
    ) {
      this.authority = clean(authority);
      this.documentId = clean(documentId);
      this.uri = clean(uri);
      this.displayName = clean(displayName);
      this.mimeType = clean(mimeType);
      this.sizeBytes = sizeBytes;
      this.sizeKnown = sizeKnown;
      this.lastModified = Math.max(0L, lastModified);
      this.directory = directory;
      this.virtual = virtual;
    }

    String identity() {
      return authority + "\u0000" + documentId;
    }

    boolean hasIdentity() {
      return !authority.isEmpty() && !documentId.isEmpty();
    }
  }

  static final class ChildrenPage {
    final List<Node> nodes;
    final boolean truncated;

    ChildrenPage(List<Node> nodes, boolean truncated) {
      this.nodes = nodes == null
        ? Collections.emptyList()
        : Collections.unmodifiableList(new ArrayList<>(nodes));
      this.truncated = truncated;
    }
  }

  static final class ScanError {
    final String code;
    final String directoryName;

    ScanError(String code, String directoryName) {
      this.code = clean(code);
      this.directoryName = clean(directoryName);
    }
  }

  static final class Result {
    final List<Node> files = new ArrayList<>();
    final List<ScanError> errors = new ArrayList<>();
    final Set<String> truncationReasons = new LinkedHashSet<>();
    int nodesVisited;
    int duplicateNodes;
    int virtualNodes;
    int invalidNodes;
    int oversizedFiles;
    boolean rootFailed;

    boolean truncated() {
      return !truncationReasons.isEmpty();
    }
  }

  private static final class PendingNode {
    final Node node;
    final int depth;

    PendingNode(Node node, int depth) {
      this.node = node;
      this.depth = depth;
    }
  }

  static Result scan(Source source, Options options) {
    Result result = new Result();
    if (source == null) {
      failRoot(result, "ROOT_UNAVAILABLE");
      return result;
    }

    Node root;
    try {
      root = source.readRoot();
    } catch (SecurityException error) {
      failRoot(result, "ROOT_SECURITY");
      return result;
    } catch (Exception error) {
      failRoot(result, "ROOT_UNREADABLE");
      return result;
    }
    if (root == null || !root.hasIdentity() || !root.directory || root.virtual) {
      failRoot(result, "ROOT_INVALID");
      return result;
    }

    ArrayDeque<PendingNode> queue = new ArrayDeque<>();
    Set<String> seen = new HashSet<>();
    queue.addLast(new PendingNode(root, 0));

    while (!queue.isEmpty()) {
      if (result.nodesVisited >= options.maxNodes) {
        result.truncationReasons.add("nodes");
        break;
      }

      PendingNode pending = queue.removeFirst();
      Node node = pending.node;
      result.nodesVisited += 1;
      if (node == null || !node.hasIdentity()) {
        result.invalidNodes += 1;
        continue;
      }
      if (!seen.add(node.identity())) {
        result.duplicateNodes += 1;
        continue;
      }
      if (node.virtual) {
        result.virtualNodes += 1;
        continue;
      }

      if (!node.directory) {
        if (!isTextFileName(node.displayName)) continue;
        if (node.sizeKnown && (node.sizeBytes <= 0L || node.sizeBytes > MAX_TEXT_BYTES)) {
          if (node.sizeBytes > MAX_TEXT_BYTES) result.oversizedFiles += 1;
          continue;
        }
        if (result.files.size() >= options.maxFiles) {
          result.truncationReasons.add("files");
          break;
        }
        result.files.add(node);
        continue;
      }

      if (pending.depth >= options.maxDepth) {
        result.truncationReasons.add("depth");
        continue;
      }

      int remainingCapacity = options.maxNodes - result.nodesVisited - queue.size();
      if (remainingCapacity <= 0) {
        result.truncationReasons.add("nodes");
        continue;
      }

      ChildrenPage page;
      try {
        page = source.readChildren(node, remainingCapacity);
      } catch (SecurityException error) {
        result.errors.add(new ScanError("CHILD_SECURITY", safeDirectoryName(node)));
        continue;
      } catch (Exception error) {
        result.errors.add(new ScanError("CHILD_UNREADABLE", safeDirectoryName(node)));
        continue;
      }
      if (page == null) {
        result.errors.add(new ScanError("CHILD_UNREADABLE", safeDirectoryName(node)));
        continue;
      }
      if (page.truncated) result.truncationReasons.add("nodes");
      int accepted = 0;
      for (Node child : page.nodes) {
        if (accepted >= remainingCapacity) {
          result.truncationReasons.add("nodes");
          break;
        }
        queue.addLast(new PendingNode(child, pending.depth + 1));
        accepted += 1;
      }
    }

    result.files.sort(Comparator
      .comparingLong((Node node) -> node.lastModified).reversed()
      .thenComparing(Comparator.comparingLong((Node node) -> node.sizeKnown ? node.sizeBytes : -1L).reversed())
      .thenComparing(node -> node.displayName, String.CASE_INSENSITIVE_ORDER)
      .thenComparing(Node::identity));
    return result;
  }

  static boolean isPickerCanceled(boolean resultOk, boolean hasTreeUri) {
    return !resultOk || !hasTreeUri;
  }

  static boolean isRecommended(Node node) {
    if (node == null || !node.sizeKnown) return false;
    if (node.sizeBytes < MIN_RECOMMENDED_BYTES || node.sizeBytes > MAX_RECOMMENDED_BYTES) return false;
    String name = node.displayName.toLowerCase(Locale.ROOT);
    return !name.equals("netstats.txt")
      && !name.equals("fw_version.txt")
      && !name.equals("ip_rule.txt")
      && !name.equals("ip_route.txt")
      && !name.equals("dumpsys.txt")
      && !name.equals("modemdump_cache.txt")
      && !name.startsWith("fanhao-")
      && !name.contains("logcat")
      && !name.contains("bugreport")
      && !name.contains("trace")
      && !name.contains("crash")
      && !name.contains("dump");
  }

  static String hint(Node node) {
    if (node == null) return "可选";
    if (!node.sizeKnown) return "大小未知";
    if (node.sizeBytes < MIN_RECOMMENDED_BYTES) return "文件较小";
    if (node.sizeBytes > MAX_RECOMMENDED_BYTES) return "文件较大";
    if (isRecommended(node)) return "推荐";
    return "可能是日志或系统文件";
  }

  private static void failRoot(Result result, String code) {
    result.rootFailed = true;
    result.errors.add(new ScanError(code, "所选目录"));
  }

  private static String safeDirectoryName(Node node) {
    String name = node == null ? "" : clean(node.displayName);
    return name.isEmpty() ? "目录" : name;
  }

  private static boolean isTextFileName(String value) {
    return clean(value).toLowerCase(Locale.ROOT).endsWith(".txt");
  }

  private static int clamp(Integer value, int fallback, int minimum, int maximum) {
    int number = value == null ? fallback : value;
    return Math.max(minimum, Math.min(maximum, number));
  }

  private static String clean(String value) {
    return value == null ? "" : value.trim();
  }

  private DocumentTreeScanner() {}
}
