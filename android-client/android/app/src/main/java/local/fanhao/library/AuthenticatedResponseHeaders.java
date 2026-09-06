package local.fanhao.library;

import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Normalizes URLConnection headers before they cross the WebResourceResponse boundary. */
final class AuthenticatedResponseHeaders {
  private static final Pattern BYTE_RANGE = Pattern.compile("^bytes\\s+(\\d+)-(\\d+)/(?:\\d+|\\*)$", Pattern.CASE_INSENSITIVE);
  private static final Pattern MIME_TYPE = Pattern.compile("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$");

  private AuthenticatedResponseHeaders() {}

  static Map<String, String> from(Map<String, List<String>> source) {
    Map<String, String> result = new HashMap<>();
    if (source == null) return result;

    for (Map.Entry<String, List<String>> header : source.entrySet()) {
      String name = header.getKey();
      if (name == null) continue;
      String lower = name.toLowerCase(Locale.ROOT);
      if (excluded(lower) || lower.equals("content-type") || lower.equals("content-length") || lower.equals("content-range")) continue;
      String value = joined(header.getValue());
      if (!value.isEmpty()) result.put(name, value);
    }

    String contentRange = validContentRange(source);
    if (!contentRange.isEmpty()) {
      result.put("Content-Range", contentRange);
    }
    long contentLength = contentLength(source, contentRange);
    if (contentLength >= 0) result.put("Content-Length", Long.toString(contentLength));
    return result;
  }

  static String contentType(Map<String, List<String>> source) {
    if (source == null) return null;
    for (Map.Entry<String, List<String>> header : source.entrySet()) {
      if (header.getKey() == null || !header.getKey().equalsIgnoreCase("Content-Type") || header.getValue() == null) continue;
      for (String value : header.getValue()) {
        if (value == null) continue;
        for (String part : value.split(",")) {
          String candidate = part.trim();
          String mime = candidate.split(";", 2)[0].trim();
          if (MIME_TYPE.matcher(mime).matches()) return candidate;
        }
      }
    }
    return null;
  }

  private static boolean excluded(String lower) {
    return lower.equals("set-cookie") || lower.equals("connection") || lower.equals("keep-alive")
      || lower.equals("proxy-authenticate") || lower.equals("proxy-authorization") || lower.equals("te")
      || lower.equals("trailer") || lower.equals("transfer-encoding") || lower.equals("upgrade")
      || lower.startsWith("x-android-");
  }

  private static String joined(List<String> values) {
    if (values == null) return "";
    StringBuilder output = new StringBuilder();
    for (String value : values) {
      if (value == null || value.trim().isEmpty()) continue;
      if (output.length() > 0) output.append(", ");
      output.append(value.trim());
    }
    return output.toString();
  }

  private static String validContentRange(Map<String, List<String>> source) {
    for (Map.Entry<String, List<String>> header : source.entrySet()) {
      if (header.getKey() == null || !header.getKey().equalsIgnoreCase("Content-Range") || header.getValue() == null) continue;
      for (String value : header.getValue()) {
        String candidate = value == null ? "" : value.trim();
        Matcher matcher = BYTE_RANGE.matcher(candidate);
        if (matcher.matches() && validRange(matcher)) return candidate;
      }
    }
    return "";
  }

  private static long contentLength(Map<String, List<String>> source, String contentRange) {
    Matcher range = BYTE_RANGE.matcher(contentRange);
    if (range.matches() && validRange(range)) {
      try { return Math.addExact(Math.subtractExact(Long.parseLong(range.group(2)), Long.parseLong(range.group(1))), 1); }
      catch (ArithmeticException ignored) { return -1; }
    }

    long selected = -1;
    for (Map.Entry<String, List<String>> header : source.entrySet()) {
      if (header.getKey() == null || !header.getKey().equalsIgnoreCase("Content-Length") || header.getValue() == null) continue;
      for (String value : header.getValue()) {
        for (String part : String.valueOf(value).split(",")) {
          try {
            long candidate = Long.parseLong(part.trim());
            if (candidate >= 0) selected = Math.max(selected, candidate);
          } catch (NumberFormatException ignored) {}
        }
      }
    }
    return selected;
  }

  private static boolean validRange(Matcher matcher) {
    try { return Long.parseLong(matcher.group(2)) >= Long.parseLong(matcher.group(1)); }
    catch (NumberFormatException ignored) { return false; }
  }
}
